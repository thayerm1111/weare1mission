import { withNitrousDb } from "../../../../../rapid/db";
import { encryptSecret, encryptionReady, maskEmail } from "../../../../../rapid/broker/crypto";
import { authenticate, listAccounts, type TLAccount } from "../../../../../rapid/broker/tradelocker";
import { freshToken, type RapidConnection } from "../../../../../rapid/broker/session";
import type { PreparableAccount } from "../../../../../rapid/exec/prepare";
import { prepareNitrousAccount } from "@/lib/nitrous/prepare";
import { bodyOf, json, requireAccount, requireUser, audit, unavailable } from "../_shared";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const stringField = (v: unknown, max = 200) => typeof v === "string" && v.length <= max ? v.trim() : "";
// Discovery verifies identity. Verified money is read from this account's mapped broker state after selection.
const brokerView = (a: TLAccount) => ({ accountId: a.accountId, accNum: a.accNum, name: a.name, currency: a.currency, balance: null });

export async function POST(req: Request) {
  try {
    const auth = await requireUser(req);
    if ("error" in auth) return auth.error;
    const { admin, user } = auth;
    const body = await bodyOf(req);
    if (!body) return json({ error: "bad_request" }, 400);
    const action = body.action;
    if ((action === "connect" || action === "select") && !auth.active) return json({ error: "access_inactive" }, 403);

    if (action === "connect") {
      if (!encryptionReady()) return json({ error: "connection_unavailable", detail: "Secure broker connection storage is unavailable. Please try again later." }, 503);
      const environment = body.environment;
      if (environment !== "live" && environment !== "demo") return json({ error: "Choose a real or demo TradeLocker account." }, 400);
      const server = stringField(body.server, 150);
      const email = stringField(body.email, 254);
      const password = typeof body.password === "string" && body.password.length <= 1024 ? body.password : "";
      if (!server || !email.includes("@") || !password) return json({ error: "Server, email and password are required." }, 400);
      if (body.savePassword === true) return json({ error: "Password storage is not offered. The broker refresh token renews this connection." }, 400);
      const attempts = await admin.from("nitrous_journal").select("id", { count: "exact", head: true })
        .eq("user_id", user.id).eq("code", "broker_signin_attempt").gte("at", new Date(Date.now() - 600_000).toISOString());
      if (attempts.error) return unavailable();
      if ((attempts.count ?? 0) >= 8) return json({ error: "too_many_attempts", detail: "Please wait a few minutes before reconnecting." }, 429);
      const logged = await audit(admin, user.id, null, "broker_signin_attempt", { environment });
      if (logged.error) return unavailable();

      const tokens = await authenticate(environment, email, password, server);
      if (!tokens.ok) return json({ error: "sign_in_failed", detail: "TradeLocker could not sign in. Check the selected environment, server name and broker credentials.", brokerStatus: tokens.status }, 400);
      const accounts = await listAccounts(environment, tokens.data.accessToken);
      if (!accounts.ok) return json({ error: "account_discovery_failed", detail: "TradeLocker signed in but could not return your accounts. Please try again.", brokerStatus: accounts.status }, 502);
      const usable = accounts.data.filter((a) => a.accountId && a.accNum);
      if (!usable.length) return json({ error: "no_accounts", detail: "TradeLocker did not return an account that can be connected in this environment." }, 400);
      const now = new Date().toISOString();
      const saved = await admin.from("nitrous_broker_connections").insert({ user_id: user.id, environment, server,
        email_masked: maskEmail(email), enc_refresh: encryptSecret(tokens.data.refreshToken), enc_password: null,
        access_token: tokens.data.accessToken, token_expires_at: tokens.data.expiresAt ? new Date(tokens.data.expiresAt).toISOString() : null,
        last_auth_at: now, status: "connected", updated_at: now }).select("id").single();
      if (saved.error || !saved.data) return unavailable();
      return json({ ok: true, connectionId: saved.data.id, environment, server, emailMasked: maskEmail(email), accounts: usable.map(brokerView) });
    }

    if (action === "select") {
      const connectionId = stringField(body.connectionId, 36);
      const brokerAccountId = stringField(body.brokerAccountId, 100);
      if (!/^[a-f0-9-]{36}$/i.test(connectionId) || !brokerAccountId) return json({ error: "Choose a returned TradeLocker account." }, 400);
      const connection = await admin.from("nitrous_broker_connections").select("*").eq("id", connectionId).eq("user_id", user.id).maybeSingle();
      if (connection.error) return unavailable();
      if (!connection.data || connection.data.status !== "connected") return json({ error: "not_found" }, 404);
      const conn = connection.data as RapidConnection;
      const tok = await withNitrousDb(() => freshToken(conn));
      if (!tok.ok) return json({ error: "reconnect_required", detail: "Sign in to TradeLocker again to verify account access." }, 409);
      const remote = await listAccounts(conn.environment, tok.token);
      if (!remote.ok) return json({ error: "account_verification_failed", detail: "TradeLocker could not verify your account selection." }, 502);
      // Never trust identifiers, currency, name or money supplied by the browser.
      const selected = remote.data.find((a) => a.accountId === brokerAccountId && a.accNum);
      if (!selected || (body.accNum !== undefined && String(body.accNum) !== selected.accNum)) return json({ error: "account_not_authorized" }, 403);
      const otherProduct = await admin.from("rapid_accounts").select("id", { count: "exact", head: true })
        .eq("environment", conn.environment).eq("server", conn.server).eq("broker_account_id", selected.accountId).neq("status", "disabled");
      if (otherProduct.error) return unavailable();
      if ((otherProduct.count ?? 0) > 0) return json({ error: "account_in_use", detail: "This account is already connected to Rapid. Use a separate TradeLocker account for Nitrous." }, 409);
      const previous = await admin.from("nitrous_accounts").select("id,user_id,automation_version")
        .eq("environment", conn.environment).eq("server", conn.server).eq("broker_account_id", selected.accountId).maybeSingle();
      if (previous.error) return unavailable();
      if (previous.data && previous.data.user_id !== user.id) return json({ error: "account_already_connected", detail: "That broker account is already connected to a different One Mission login." }, 409);
      const now = new Date().toISOString();
      const payload = { user_id: user.id, connection_id: connectionId, broker_account_id: selected.accountId,
        acc_num: selected.accNum, environment: conn.environment, server: conn.server, name: selected.name,
        currency: selected.currency, balance: null, balance_at: null,
        equity: null, equity_at: null,
        automation_enabled: false, management_enabled: true, allow_shared_account: false,
        status: "linked", block_reason: null, updated_at: now };
      const saved = previous.data
        ? await admin.from("nitrous_accounts").update({ ...payload, automation_version: Number(previous.data.automation_version) + 1 })
          .eq("id", previous.data.id).eq("user_id", user.id).eq("automation_version", previous.data.automation_version).select("id").maybeSingle()
        : await admin.from("nitrous_accounts").insert({ ...payload, profile: "slow_drip", risk_pct: 0.5 }).select("id").single();
      if (saved.error || !saved.data) return json({ error: "account_connection_changed", detail: "Refresh before selecting this account again." }, 409);
      const owned = await requireAccount(admin, user.id, String(saved.data.id));
      if ("error" in owned) return owned.error;
      await prepareNitrousAccount(owned.account as PreparableAccount);
      await audit(admin, user.id, String(saved.data.id), previous.data ? "account_reconnected_paused" : "account_connected_paused", { environment: conn.environment });
      return json({ ok: true, accountId: saved.data.id, automationEnabled: false });
    }

    if (action === "refresh") {
      const owned = await requireAccount(admin, user.id, String(body.accountId ?? ""));
      if ("error" in owned) return owned.error;
      const connection = await admin.from("nitrous_broker_connections").select("*").eq("id", owned.account.connection_id).eq("user_id", user.id).maybeSingle();
      if (connection.error || !connection.data) return unavailable();
      const conn = connection.data as RapidConnection;
      if (conn.status === "revoked") return json({ error: "reconnect_required" }, 409);
      const tok = await withNitrousDb(() => freshToken(conn));
      if (!tok.ok) return json({ error: "reconnect_required" }, 409);
      const listed = await listAccounts(conn.environment, tok.token);
      if (!listed.ok) return json({ error: "broker_unavailable" }, 502);
      const selected = listed.data.find((a) => a.accountId === owned.account.broker_account_id && a.accNum === owned.account.acc_num);
      if (!selected) return json({ error: "account_access_changed" }, 409);
      const prepared = await prepareNitrousAccount(owned.account as PreparableAccount);
      return json({ ok: prepared.ok, accountId: owned.account.id, detail: prepared.ok ? null : "TradeLocker account readiness is still being checked." });
    }

    if (action === "disconnect") {
      const connectionId = stringField(body.connectionId, 36);
      if (!/^[a-f0-9-]{36}$/i.test(connectionId)) return json({ error: "not_found" }, 404);
      // The transaction refuses open/unsettled exposure. It revokes credentials only once every
      // linked account is flat; disconnecting never abandons a position or sends a trading order.
      const result = await admin.rpc("nitrous_disconnect", { p_user: user.id, p_connection: connectionId });
      if (result.error) return unavailable();
      const out = Array.isArray(result.data) ? result.data[0] : result.data;
      if (!out?.disconnected) return json({ error: "disconnect_blocked", detail: out?.reason ?? "Pause auto trading and wait for open positions and orders to settle before disconnecting." }, 409);
      return json({ ok: true });
    }
    return json({ error: "Choose connect, select, refresh or disconnect." }, 400);
  } catch { return unavailable(); }
}
