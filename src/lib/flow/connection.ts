import { createAdminClient } from "@/lib/supabase/admin";
import { decryptSecret } from "@/lib/flow/crypto";
import { authenticate, refresh as tlRefresh, listAccounts, type TLEnv } from "@/lib/flow/tradelocker";

/**
 * FLOW broker connection helpers (server-only).
 *
 * Token lifecycle: we persist only the ENCRYPTED refresh token (+ encrypted
 * password as a re-auth fallback, per the account owner's choice). Before any
 * broker call we mint a fresh access token from the refresh token; if that
 * fails we fall back to a full re-auth with the stored password. The browser
 * never receives a token.
 */

export type FlowConnRow = {
  id: string; user_id: string; broker: string; environment: string; server: string;
  email: string; enc_refresh: string | null; enc_password: string | null;
  access_token: string | null; selected_account_id: string | null; status: string;
};

export async function getConnection(userId: string): Promise<FlowConnRow | null> {
  const admin = createAdminClient();
  if (!admin) return null;
  const { data } = await admin.from("flow_broker_connections").select("*").eq("user_id", userId).order("updated_at", { ascending: false }).limit(1).maybeSingle();
  return (data as FlowConnRow) ?? null;
}

/** Every broker connection (login) the member has, newest first. A member can
 *  link several TradeLocker logins; each holds one or more accounts. */
export async function getAllConnections(userId: string): Promise<FlowConnRow[]> {
  const admin = createAdminClient();
  if (!admin) return [];
  const { data } = await admin.from("flow_broker_connections").select("*").eq("user_id", userId).order("updated_at", { ascending: false });
  return (data as FlowConnRow[]) ?? [];
}

/** Mint a fresh access token for a SPECIFIC connection (refresh → re-auth). */
async function mintTokenForConn(conn: FlowConnRow): Promise<{ ok: true; token: string; env: TLEnv } | { ok: false; error: string }> {
  const admin = createAdminClient();
  if (!admin) return { ok: false, error: "Server not configured." };
  const env: TLEnv = conn.environment === "live" ? "live" : "demo";
  if (conn.enc_refresh) {
    try {
      const rt = decryptSecret(conn.enc_refresh);
      const r = await tlRefresh(env, rt);
      if (r.ok) { await persistTokens(admin, conn.id, r.data.refreshToken, r.data.accessToken); return { ok: true, token: r.data.accessToken, env }; }
    } catch { /* fall through to re-auth */ }
  }
  if (conn.enc_password) {
    try {
      const pw = decryptSecret(conn.enc_password);
      const a = await authenticate(env, conn.email, pw, conn.server);
      if (a.ok) { await persistTokens(admin, conn.id, a.data.refreshToken, a.data.accessToken); return { ok: true, token: a.data.accessToken, env }; }
      return { ok: false, error: a.error };
    } catch { /* fall through */ }
  }
  await admin.from("flow_broker_connections").update({ status: "error", last_error: "Session expired — reconnect your account.", updated_at: new Date().toISOString() }).eq("id", conn.id);
  return { ok: false, error: "Session expired — reconnect your TradeLocker account." };
}

/**
 * Return a usable access token for this user's PRIMARY (most recent) connection.
 * Kept for single-account callers; multi-account placement uses activeAccounts().
 */
export async function freshAccessToken(userId: string): Promise<
  { ok: true; token: string; env: TLEnv; conn: FlowConnRow } | { ok: false; error: string }
> {
  const conn = await getConnection(userId);
  if (!conn) return { ok: false, error: "No TradeLocker account connected." };
  const t = await mintTokenForConn(conn);
  return t.ok ? { ok: true, token: t.token, env: t.env, conn } : t;
}

/** Mint a token for a SPECIFIC connection id (used by the trade-manager to reach
 *  the account that holds a managed position, regardless of auto-run toggles). */
export async function connectionToken(connectionId: string): Promise<{ ok: true; token: string; env: TLEnv } | { ok: false; error: string }> {
  const admin = createAdminClient();
  if (!admin) return { ok: false, error: "Server not configured." };
  const { data } = await admin.from("flow_broker_connections").select("*").eq("id", connectionId).maybeSingle();
  if (!data) return { ok: false, error: "Connection not found." };
  return mintTokenForConn(data as FlowConnRow);
}

export type ActiveAccount = {
  connId: string; env: TLEnv; token: string;
  accountId: string; accNum: string;
  equity: number | null; balance: number | null; currency: string | null; name: string | null;
  riskPct?: number | null; // per-account risk override (null → caller's default)
};

/**
 * Every account the member has toggled ON for trading (autotrade_enabled), across
 * ALL of their connections, each carrying a fresh token + LIVE equity so the
 * caller can risk-size per account. This is what auto-run and one-tap Execute fan
 * out over. A connection that can't mint a token is skipped (its accounts are
 * simply not traded this cycle).
 */
export async function activeAccounts(userId: string): Promise<ActiveAccount[]> {
  const admin = createAdminClient();
  if (!admin) return [];
  const conns = await getAllConnections(userId);
  const out: ActiveAccount[] = [];
  for (const conn of conns) {
    // Include the per-account risk override when the column exists; if it hasn't
    // been added yet, fall back to a select without it so trading never breaks.
    type AcctRow = { account_id: string; acc_num: string | null; name: string | null; currency: string | null; risk_pct?: number | null };
    let enabled: AcctRow[] = [];
    const withRisk = await admin.from("flow_broker_accounts")
      .select("account_id, acc_num, name, currency, autotrade_enabled, risk_pct")
      .eq("connection_id", conn.id).eq("autotrade_enabled", true);
    if (!withRisk.error) enabled = (withRisk.data ?? []) as AcctRow[];
    else {
      const fb = await admin.from("flow_broker_accounts")
        .select("account_id, acc_num, name, currency, autotrade_enabled")
        .eq("connection_id", conn.id).eq("autotrade_enabled", true);
      enabled = (fb.data ?? []) as AcctRow[];
    }
    if (!enabled.length) continue;
    const t = await mintTokenForConn(conn);
    if (!t.ok) continue;
    // Live equity per account (best-effort; falls back to null → caller may skip sizing).
    const accRes = await listAccounts(t.env, t.token);
    const live = accRes.ok ? accRes.data : [];
    for (const a of enabled) {
      if (!a.acc_num) continue;
      const l = live.find((x) => String(x.accountId) === String(a.account_id));
      out.push({
        connId: conn.id, env: t.env, token: t.token,
        accountId: String(a.account_id), accNum: String(a.acc_num),
        equity: l?.equity ?? l?.balance ?? null, balance: l?.balance ?? null,
        currency: l?.currency ?? a.currency ?? null, name: a.name ?? null,
        riskPct: typeof a.risk_pct === "number" && a.risk_pct > 0 ? a.risk_pct : null,
      });
    }
  }
  return out;
}

async function persistTokens(admin: NonNullable<ReturnType<typeof createAdminClient>>, connId: string, refreshToken: string, accessToken: string) {
  const { encryptSecret } = await import("@/lib/flow/crypto");
  await admin.from("flow_broker_connections").update({
    enc_refresh: encryptSecret(refreshToken),
    access_token: accessToken,
    status: "connected",
    last_error: null,
    last_auth_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", connId);
}

/** Masked, browser-safe view of a connection (never exposes tokens). */
export function safeConnView(conn: FlowConnRow | null) {
  if (!conn) return null;
  const maskEmail = (e: string) => { const [u, d] = e.split("@"); return d ? `${u.slice(0, 2)}${"•".repeat(Math.max(1, u.length - 2))}@${d}` : e; };
  return {
    connected: conn.status === "connected",
    status: conn.status,
    environment: conn.environment,
    server: conn.server,
    email: maskEmail(conn.email),
    selectedAccountId: conn.selected_account_id,
  };
}
