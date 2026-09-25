import { admin } from "../db";
import { decryptSecret, encryptSecret } from "./crypto";
import { authenticate, refresh } from "./tradelocker";
import type { TLEnv } from "./http";

/**
 * Token lifecycle.
 *
 * Only the encrypted refresh token is persisted (plus, optionally and only with explicit consent, an
 * encrypted password for unattended reconnection). The password itself is never retained from a
 * sign-in. Refreshes are serialised per connection so two workers cannot race and invalidate each
 * other's token pair.
 *
 * A refresh failure PAUSES entries and asks for a reconnect. It never triggers a blind retry of a
 * trading write: authentication being fixed says nothing about whether the original order executed.
 */

export type RapidConnection = {
  id: string;
  user_id: string;
  environment: TLEnv;
  server: string;
  email_masked: string;
  enc_refresh: string | null;
  enc_password: string | null;
  access_token: string | null;
  last_auth_at: string | null;
  status: string;
};

const TOKEN_REUSE_MS = Number(process.env.RAPID_TOKEN_REUSE_MS || 180_000);

const inflight = new Map<string, Promise<{ ok: true; token: string } | { ok: false; error: string; reconnect: boolean }>>();

export async function freshToken(conn: RapidConnection): Promise<{ ok: true; token: string } | { ok: false; error: string; reconnect: boolean }> {
  const existing = inflight.get(conn.id);
  if (existing) return existing;
  const p = mint(conn).finally(() => inflight.delete(conn.id));
  inflight.set(conn.id, p);
  return p;
}

async function mint(conn: RapidConnection): Promise<{ ok: true; token: string } | { ok: false; error: string; reconnect: boolean }> {
  const age = conn.last_auth_at ? Date.now() - new Date(conn.last_auth_at).getTime() : Infinity;
  if (conn.access_token && age < TOKEN_REUSE_MS) return { ok: true, token: conn.access_token };

  if (conn.enc_refresh) {
    try {
      const r = await refresh(conn.environment, decryptSecret(conn.enc_refresh));
      if (r.ok) {
        await persist(conn.id, r.data.accessToken, r.data.refreshToken);
        return { ok: true, token: r.data.accessToken };
      }
    } catch {
      /* fall through to a full sign-in when the stored blob cannot be read */
    }
  }

  if (conn.enc_password) {
    try {
      const email = await emailFor(conn.id);
      if (email) {
        const a = await authenticate(conn.environment, email, decryptSecret(conn.enc_password), conn.server);
        if (a.ok) {
          await persist(conn.id, a.data.accessToken, a.data.refreshToken);
          return { ok: true, token: a.data.accessToken };
        }
      }
    } catch {
      /* fall through */
    }
  }

  await admin().from("rapid_broker_connections").update({
    status: "reconnect_required",
    last_error: "could not obtain a broker token",
    updated_at: new Date().toISOString(),
  }).eq("id", conn.id);
  return { ok: false, error: "Reconnect required: the broker session could not be renewed.", reconnect: true };
}

async function persist(connectionId: string, accessToken: string, refreshToken: string): Promise<void> {
  await admin().from("rapid_broker_connections").update({
    access_token: accessToken,
    enc_refresh: encryptSecret(refreshToken),
    last_auth_at: new Date().toISOString(),
    status: "connected",
    last_error: null,
    updated_at: new Date().toISOString(),
  }).eq("id", connectionId);
}

/**
 * The full email is not stored in the connection row — only a mask. Unattended reconnection needs
 * the real one, so it is read from the member's auth record rather than duplicated in plaintext.
 */
async function emailFor(connectionId: string): Promise<string | null> {
  const { data } = await admin().from("rapid_broker_connections").select("user_id").eq("id", connectionId).maybeSingle();
  const userId = (data as { user_id?: string } | null)?.user_id;
  if (!userId) return null;
  const { data: u } = await admin().auth.admin.getUserById(userId);
  return u?.user?.email ?? null;
}
