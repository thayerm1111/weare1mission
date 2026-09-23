import { admin } from "../db";
import { open, seal } from "./crypto";
import { authenticate, refreshTokens, type TLAuth, type TLEnv } from "./tradelocker";

export type ConnRow = { id: string; user_id: string; env: TLEnv; server: string; enc_credentials: string; enc_access_token: string | null; enc_refresh_token: string | null; token_exp: string | null; status: string };

/**
 * AURIC's own broker session per connection. Tokens are AURIC's (obtained with the stored credentials),
 * so refreshing never rotates or invalidates any other product's session. Refresh calls are serialized
 * per connection so two account runners on the same connection cannot race.
 */
const inflight = new Map<string, Promise<string | null>>();

export async function accessToken(conn: ConnRow, force = false): Promise<string | null> {
  const key = conn.id;
  if (inflight.has(key)) return inflight.get(key)!;
  const p = (async () => {
    try {
      const exp = conn.token_exp ? Date.parse(conn.token_exp) : 0;
      if (!force && conn.enc_access_token && exp - Date.now() > 3 * 60_000) return open(conn.enc_access_token);
      // refresh with OUR refresh token, else re-authenticate with the stored credentials.
      if (conn.enc_refresh_token) {
        const r = await refreshTokens(conn.env, open(conn.enc_refresh_token));
        if (r.ok) { await persist(conn, r.data); return r.data.accessToken; }
      }
      const c = JSON.parse(open(conn.enc_credentials)) as { email: string; password: string; server: string };
      const a = await authenticate(conn.env, c.email, c.password, c.server);
      if (!a.ok) { await admin().from("auric_broker_connections").update({ status: "error", last_error: a.error, updated_at: new Date().toISOString() }).eq("id", conn.id); return null; }
      await persist(conn, a.data); return a.data.accessToken;
    } catch (e) {
      await admin().from("auric_broker_connections").update({ status: "error", last_error: e instanceof Error ? e.message : String(e), updated_at: new Date().toISOString() }).eq("id", conn.id);
      return null;
    } finally { inflight.delete(key); }
  })();
  inflight.set(key, p);
  return p;
}

async function persist(conn: ConnRow, t: { accessToken: string; refreshToken: string; exp: number | null }) {
  const exp = new Date(t.exp ?? Date.now() + 50 * 60_000).toISOString();
  conn.enc_access_token = seal(t.accessToken); conn.enc_refresh_token = seal(t.refreshToken); conn.token_exp = exp; conn.status = "ok";
  await admin().from("auric_broker_connections").update({ enc_access_token: conn.enc_access_token, enc_refresh_token: conn.enc_refresh_token, token_exp: exp, status: "ok", last_error: null, updated_at: new Date().toISOString() }).eq("id", conn.id);
}

export async function authFor(conn: ConnRow, accountId: string, accNum: string): Promise<TLAuth | null> {
  const tok = await accessToken(conn); if (!tok) return null;
  return { env: conn.env, accessToken: tok, accountId, accNum };
}
