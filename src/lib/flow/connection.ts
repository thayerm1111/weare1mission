import { createAdminClient } from "@/lib/supabase/admin";
import { decryptSecret } from "@/lib/flow/crypto";
import { authenticate, refresh as tlRefresh, type TLEnv } from "@/lib/flow/tradelocker";

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

/**
 * Return a usable access token for this user's connection, refreshing/re-auth
 * as needed and persisting the rotated refresh token. Never throws.
 */
export async function freshAccessToken(userId: string): Promise<
  { ok: true; token: string; env: TLEnv; conn: FlowConnRow } | { ok: false; error: string }
> {
  const admin = createAdminClient();
  if (!admin) return { ok: false, error: "Server not configured." };
  const conn = await getConnection(userId);
  if (!conn) return { ok: false, error: "No TradeLocker account connected." };
  const env: TLEnv = conn.environment === "live" ? "live" : "demo";

  // 1) Try the refresh token.
  if (conn.enc_refresh) {
    try {
      const rt = decryptSecret(conn.enc_refresh);
      const r = await tlRefresh(env, rt);
      if (r.ok) {
        await persistTokens(admin, conn.id, r.data.refreshToken, r.data.accessToken);
        return { ok: true, token: r.data.accessToken, env, conn };
      }
    } catch { /* fall through to re-auth */ }
  }
  // 2) Fall back to a full re-auth with the stored password.
  if (conn.enc_password) {
    try {
      const pw = decryptSecret(conn.enc_password);
      const a = await authenticate(env, conn.email, pw, conn.server);
      if (a.ok) {
        await persistTokens(admin, conn.id, a.data.refreshToken, a.data.accessToken);
        return { ok: true, token: a.data.accessToken, env, conn };
      }
      return { ok: false, error: a.error };
    } catch { /* fall through */ }
  }
  await admin.from("flow_broker_connections").update({ status: "error", last_error: "Session expired — reconnect your account.", updated_at: new Date().toISOString() }).eq("id", conn.id);
  return { ok: false, error: "Session expired — reconnect your TradeLocker account." };
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
