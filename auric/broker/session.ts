import { admin, telemetry } from "../db";
import { open, seal } from "./crypto";
import { authenticate, refreshTokens, type TLAuth, type TLEnv } from "./tradelocker";

export type ConnRow = { id: string; user_id: string; env: TLEnv; server: string; enc_credentials: string; enc_access_token: string | null; enc_refresh_token: string | null; token_exp: string | null; status: string };

/**
 * AURIC's own broker session per connection. Tokens are AURIC's (obtained with the stored credentials),
 * so refreshing never rotates or invalidates any other product's session. Refresh calls are serialized
 * per connection so two account runners on the same connection cannot race.
 *
 * The cached-token fast path deliberately lives OUTSIDE the in-flight guard: an earlier version ran it inside
 * an async IIFE whose `finally` fired synchronously before the promise was registered, leaving a settled
 * promise (the old token) in the map forever — so the token was never refreshed and every broker call
 * failed with "JWT token expired" an hour after linking.
 */
const inflight = new Map<string, Promise<string | null>>();
const REFRESH_AHEAD_MS = 3 * 60_000;

export function tokenFresh(conn: ConnRow): boolean {
  const exp = conn.token_exp ? Date.parse(conn.token_exp) : 0;
  return !!conn.enc_access_token && Number.isFinite(exp) && exp - Date.now() > REFRESH_AHEAD_MS;
}

export async function accessToken(conn: ConnRow, force = false): Promise<string | null> {
  if (!force && tokenFresh(conn)) return open(conn.enc_access_token!);
  const key = conn.id;
  const cur = inflight.get(key);
  if (cur) return cur;
  const p = renew(conn).finally(() => { if (inflight.get(key) === p) inflight.delete(key); });
  inflight.set(key, p);
  return p;
}

async function renew(conn: ConnRow): Promise<string | null> {
  const t0 = Date.now();
  try {
    // Refresh with OUR refresh token, else re-authenticate with the stored credentials.
    if (conn.enc_refresh_token) {
      const r = await refreshTokens(conn.env, open(conn.enc_refresh_token));
      if (r.ok) { await persist(conn, r.data); telemetry(null, "auth_refresh", { conn: conn.id.slice(0, 8), via: "refresh", ms: Date.now() - t0, exp: conn.token_exp }); return r.data.accessToken; }
      telemetry(null, "auth_refresh", { conn: conn.id.slice(0, 8), via: "refresh", ok: false, status: r.status, error: r.error });
      if (r.status === 429) return null; // rate-limited: try again next tick rather than burning a password login too
    }
    const c = JSON.parse(open(conn.enc_credentials)) as { email: string; password: string; server: string };
    const a = await authenticate(conn.env, c.email, c.password, c.server);
    if (!a.ok) {
      telemetry(null, "auth_refresh", { conn: conn.id.slice(0, 8), via: "password", ok: false, status: a.status, error: a.error });
      if (a.status !== 429) await admin().from("auric_broker_connections").update({ status: "error", last_error: a.error, updated_at: new Date().toISOString() }).eq("id", conn.id);
      return null;
    }
    await persist(conn, a.data);
    telemetry(null, "auth_refresh", { conn: conn.id.slice(0, 8), via: "password", ms: Date.now() - t0, exp: conn.token_exp });
    return a.data.accessToken;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    telemetry(null, "auth_refresh", { conn: conn.id.slice(0, 8), ok: false, error: msg });
    await admin().from("auric_broker_connections").update({ status: "error", last_error: msg, updated_at: new Date().toISOString() }).eq("id", conn.id);
    return null;
  }
}

async function persist(conn: ConnRow, t: { accessToken: string; refreshToken: string; exp: number | null }) {
  const exp = new Date(t.exp ?? Date.now() + 50 * 60_000).toISOString();
  conn.enc_access_token = seal(t.accessToken); conn.enc_refresh_token = seal(t.refreshToken); conn.token_exp = exp; conn.status = "ok";
  const { error } = await admin().from("auric_broker_connections").update({ enc_access_token: conn.enc_access_token, enc_refresh_token: conn.enc_refresh_token, token_exp: exp, status: "ok", last_error: null, updated_at: new Date().toISOString() }).eq("id", conn.id);
  if (error) { console.error("[auric] token persist failed", error.message); telemetry(null, "auth_persist_error", { conn: conn.id.slice(0, 8), error: error.message }); }
}

export async function authFor(conn: ConnRow, accountId: string, accNum: string): Promise<TLAuth | null> {
  const tok = await accessToken(conn); if (!tok) return null;
  return { env: conn.env, accessToken: tok, accountId, accNum };
}
