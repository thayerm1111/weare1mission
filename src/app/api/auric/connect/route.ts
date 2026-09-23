import { ctx, json } from "../_lib";
import { seal, openLegacy, encryptionReady } from "../../../../../auric/broker/crypto";
import { authenticate, listAccounts, type TLEnv } from "../../../../../auric/broker/tradelocker";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const mask = (e: string) => { const [u, d] = e.split("@"); return `${u.slice(0, 2)}***@${d ?? ""}`; };

/**
 * POST /api/auric/connect
 *  { mode: "credentials", env, server, email, password }         — a fresh TradeLocker login owned by AURIC
 *  { mode: "import", flowConnectionId }                         — copy the credentials of one of the caller's
 *                                                                 existing FLOW connections (read-only on FLOW's
 *                                                                 side; AURIC logs in on its own and stores its
 *                                                                 own token pair). Requires an explicit request.
 * Either way AURIC lists the accounts behind the login and records them as `auric_accounts` (status linked,
 * NO consent, NO session, NO live authorization) — nothing trades until each account is explicitly activated.
 */
export async function POST(req: Request) {
  const r = await ctx(req); if (!r.ok) return r.res; const c = r.c;
  if (!encryptionReady()) return json({ error: "encryption_not_configured" }, 503);
  let body: { mode?: string; env?: string; server?: string; email?: string; password?: string; flowConnectionId?: string };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  let env: TLEnv, server: string, email: string, password: string, importedFrom: string | null = null;
  if (body.mode === "import") {
    const { data: fc } = await c.admin.from("flow_broker_connections").select("id, environment, server, email, enc_password").eq("id", String(body.flowConnectionId ?? "")).eq("user_id", c.user.id).maybeSingle();
    if (!fc) return json({ error: "flow_connection_not_found" }, 404);
    if (!fc.enc_password) return json({ error: "flow_connection_has_no_stored_password" }, 400);
    try { password = openLegacy(fc.enc_password, process.env.FLOW_ENC_KEY || ""); } catch { return json({ error: "could_not_read_stored_credentials" }, 500); }
    env = fc.environment === "live" ? "live" : "demo"; server = fc.server; email = fc.email; importedFrom = `flow_broker_connections:${fc.id}`;
  } else {
    env = body.env === "live" ? "live" : "demo"; server = String(body.server ?? "").trim(); email = String(body.email ?? "").trim(); password = String(body.password ?? "");
    if (!server || !email || !password) return json({ error: "missing_fields" }, 400);
  }
  const auth = await authenticate(env, email, password, server);
  if (!auth.ok) return json({ error: "broker_auth_failed", detail: auth.error }, 400);
  const accounts = await listAccounts(env, auth.data.accessToken);
  if (!accounts.ok) return json({ error: "broker_accounts_failed", detail: accounts.error }, 400);
  const now = new Date().toISOString();
  const { data: conn, error } = await c.admin.from("auric_broker_connections").insert({
    user_id: c.user.id, env, server, email_masked: mask(email), enc_credentials: seal(JSON.stringify({ email, password, server })),
    enc_access_token: seal(auth.data.accessToken), enc_refresh_token: seal(auth.data.refreshToken), token_exp: new Date(auth.data.exp ?? Date.now() + 50 * 60_000).toISOString(),
    status: "ok", imported_from: importedFrom, updated_at: now,
  }).select("id").single();
  if (error || !conn) return json({ error: "db", detail: error?.message }, 500);
  const rows = accounts.data.map((a) => ({ user_id: c.user.id, connection_id: conn.id, broker_account_id: a.id, acc_num: a.accNum, name: a.name, currency: a.currency, balance: a.balance, updated_at: now }));
  const { data: accts, error: e2 } = await c.admin.from("auric_accounts").upsert(rows, { onConflict: "connection_id,broker_account_id" }).select("id, broker_account_id, acc_num, name, currency, balance");
  if (e2) return json({ error: "db", detail: e2.message }, 500);
  for (const a of accts ?? []) await c.admin.from("auric_events").insert({ account_id: a.id, kind: "link", message: `Broker account ${a.name ?? a.broker_account_id} linked to AURIC (${env}${importedFrom ? ", credentials imported from your FLOW connection" : ""}). No trading until you activate it.`, state: "PAUSED" });
  return json({ ok: true, connectionId: conn.id, env, accounts: accts ?? [] });
}

/** GET /api/auric/connect — the caller's FLOW connections available for import (masked), read-only. */
export async function GET(req: Request) {
  const r = await ctx(req); if (!r.ok) return r.res; const c = r.c;
  const { data } = await c.admin.from("flow_broker_connections").select("id, environment, server, email, status, enc_password").eq("user_id", c.user.id);
  return json({ ok: true, flowConnections: (data ?? []).map((f) => ({ id: f.id, env: f.environment, server: f.server, email: mask(f.email ?? ""), status: f.status, importable: !!f.enc_password })) });
}
