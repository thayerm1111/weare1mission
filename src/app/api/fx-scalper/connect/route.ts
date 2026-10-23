import { body, json, requireOwner } from "../_shared";
import { Scheduler } from "@/lib/fxscalper/tl/transport";
import { allAccounts, signIn } from "@/lib/fxscalper/tl/api";
import { encryptionReady, maskEmail, seal } from "@/lib/fxscalper/crypto";
import { addEvent, readControl } from "@/lib/fxscalper/store";

export const dynamic = "force-dynamic";

/**
 * CONNECT THE LIVE TRADELOCKER ACCOUNT (secure setup — credentials are typed into the dashboard, never
 * into a conversation).
 *   • The sign-in is made by THIS SERVER against TradeLocker's fixed LIVE host; no host is taken from
 *     the browser.
 *   • The tokens are encrypted (AES-256-GCM, key outside the database). The email and password are kept
 *     — encrypted — only when "stay connected" is ticked, so the worker can sign in again by itself if
 *     the broker ends the session; otherwise they are used once and dropped.
 *   • Nothing secret is returned to the browser or written to a log.
 * Connecting does not select an account and cannot start trading.
 */
export async function POST(req: Request) {
  const a = await requireOwner();
  if ("error" in a) return a.error;
  if (!encryptionReady()) return json({ error: "The encryption key (FX_SCALPER_ENC_KEY or FLOW_ENC_KEY) is not configured on the server." }, 503);
  const b = await body(req);
  const server = String(b.server ?? "").trim();
  const email = String(b.email ?? "").trim();
  const password = String(b.password ?? "");
  const stay = b.stayConnected === true;
  if (!server || !email || !password) return json({ error: "Server, email and password are all required." }, 400);
  if (server.length > 64 || email.length > 200 || password.length > 200) return json({ error: "One of the fields is too long." }, 400);

  const sched = new Scheduler({ maxInFlight: 2 });
  const auth = await signIn(sched, "live", email, password, server);
  if (!auth.ok) return json({ error: auth.error }, auth.status === 401 || auth.status === 403 ? 400 : 502);
  const accounts = await allAccounts(sched, "live", auth.data.accessToken);
  if (!accounts.ok) return json({ error: accounts.error }, 502);
  if (!accounts.data.length) return json({ error: "This login has no trading accounts." }, 400);

  const listed = accounts.data.map((x) => ({ accountId: x.accountId, accNum: x.accNum, name: x.name, currency: x.currency, status: x.status, balance: x.balance }));
  const secrets = {
    enc_email: stay ? seal(email) : null, enc_password: stay ? seal(password) : null,
    enc_refresh: seal(auth.data.refreshToken), enc_access: seal(auth.data.accessToken),
    access_expires_at: auth.data.expiresAt ? new Date(auth.data.expiresAt).toISOString() : null,
    status: "connected", last_error: null, last_auth_at: new Date().toISOString(), accounts: listed,
  };

  // RECONNECT: renew the connection the bot is using, in place — the worker picks the new session up
  // within seconds and carries on managing open trades. Only for the same login's accounts.
  const reconnectId = typeof b.reconnectConnectionId === "string" ? b.reconnectConnectionId : null;
  if (reconnectId) {
    const control = await readControl(a.db);
    if (control.connection_id !== reconnectId) return json({ error: "Only the connection the bot is using can be renewed in place." }, 400);
    if (!listed.some((x) => x.accountId === control.account_id && x.accNum === control.acc_num)) {
      return json({ error: "That login does not have the account the bot trades. Sign in with the same login." }, 400);
    }
    const { error } = await a.db.from("fx_scalper_connections").update({ ...secrets, server, email_masked: maskEmail(email), updated_at: new Date().toISOString() }).eq("id", reconnectId);
    if (error) return json({ error: `The connection could not be saved: ${error.message}` }, 500);
    await addEvent(a.db, { kind: "reconnected", message: `Owner renewed the broker session (${server}, ${maskEmail(email)}).${stay ? " Stay connected: on." : ""}` });
    return json({ connectionId: reconnectId, accounts: listed, renewed: true });
  }

  const { data, error } = await a.db.from("fx_scalper_connections").insert({
    created_by: a.user.id, environment: "live", server, email_masked: maskEmail(email), ...secrets,
  }).select("id").single();
  if (error || !data) return json({ error: `The connection could not be saved: ${error?.message ?? "unknown"}` }, 500);
  const newId = (data as { id: string }).id;
  // Older sign-ins the bot is not using are retired, their stored secrets erased: one live credential set.
  const control = await readControl(a.db);
  await a.db.from("fx_scalper_connections")
    .update({ status: "revoked", enc_email: null, enc_password: null, enc_access: null, enc_refresh: "revoked", updated_at: new Date().toISOString() })
    .neq("id", newId).neq("id", control.connection_id ?? "00000000-0000-0000-0000-000000000000").neq("status", "revoked");
  await addEvent(a.db, { kind: "connected", message: `Connected TradeLocker LIVE (${server}, ${maskEmail(email)}); ${accounts.data.length} account(s) found.${stay ? " Stay connected: on." : ""}` });
  return json({ connectionId: newId, accounts: listed });
}
