import { json, requireUser } from "../_shared";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptSecret, encryptionReady, maskEmail } from "../../../../../rapid/broker/crypto";
import { authenticate, listAccounts } from "../../../../../rapid/broker/tradelocker";
import type { TLEnv } from "../../../../../rapid/broker/http";
import { prepareAccount, type PreparableAccount } from "../../../../../rapid/exec/prepare";
import { journal } from "../../../../../rapid/db";

export const dynamic = "force-dynamic";

/**
 * Connect TradeLocker.
 *
 * The credential rules, all of them load-bearing:
 *   - The sign-in request is made by THIS SERVER, never by the browser, so the password never
 *     travels anywhere except into the broker.
 *   - The password is exchanged for tokens and then discarded, unless the member explicitly asks for
 *     unattended reconnection, in which case it is encrypted with a key held outside the database.
 *   - The refresh token is encrypted at rest. Nothing here ever returns a token to the browser, puts
 *     one in a Realtime payload, or writes one to a log.
 *   - The base URL is fixed per environment. A client-supplied host is never accepted.
 */

const ENVS: TLEnv[] = ["demo", "live"];

export async function POST(req: Request) {
  const auth = await requireUser();
  if ("error" in auth) return auth.error;
  const admin = createAdminClient();
  if (!admin) return json({ error: "not_configured" }, 503);
  if (!encryptionReady()) return json({ error: "credential_storage_unavailable", detail: "RAPID_ENC_KEY is not configured on the server" }, 503);

  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; } catch { return json({ error: "bad_request" }, 400); }
  const action = String(body.action ?? "");

  if (action === "connect") {
    const environment = String(body.environment ?? "demo") as TLEnv;
    if (!ENVS.includes(environment)) return json({ error: "environment must be demo or live" }, 400);
    const server = String(body.server ?? "").trim();
    const email = String(body.email ?? "").trim();
    const password = String(body.password ?? "");
    if (!server || !email || !password) return json({ error: "server, email and password are required" }, 400);

    const tokens = await authenticate(environment, email, password, server);
    if (!tokens.ok) {
      // The broker's reason is kept, so a refused sign-in can be diagnosed later. Never the password.
      await journal({ userId: auth.user.id, stage: "connect", code: "sign_in_failed", decision: "refused", reason: tokens.error,
        evidence: { environment, server, emailMasked: maskEmail(email), brokerStatus: tokens.status, latencyMs: tokens.latencyMs } });
      return json({ error: "sign_in_failed", detail: tokens.error, brokerStatus: tokens.status }, 400);
    }

    const accounts = await listAccounts(environment, tokens.data.accessToken);
    if (!accounts.ok) {
      await journal({ userId: auth.user.id, stage: "connect", code: "account_discovery_failed", decision: "refused", reason: accounts.error,
        evidence: { environment, server, emailMasked: maskEmail(email), brokerStatus: accounts.status } });
      return json({ error: "account_discovery_failed", detail: accounts.error }, 502);
    }

    const row = {
      user_id: auth.user.id,
      environment,
      server,
      email_masked: maskEmail(email),
      enc_refresh: encryptSecret(tokens.data.refreshToken),
      // Only stored when the member opts in, and never returned.
      enc_password: body.savePassword === true ? encryptSecret(password) : null,
      access_token: tokens.data.accessToken,
      last_auth_at: new Date().toISOString(),
      status: "connected",
    };
    const { data, error } = await admin.from("rapid_broker_connections").insert(row).select("id").maybeSingle();
    if (error) return json({ error: error.message }, 500);

    return json({
      ok: true,
      connectionId: (data as { id: string }).id,
      environment,
      server,
      emailMasked: row.email_masked,
      // Identifiers only. No tokens, no balances the member has not already been shown.
      accounts: accounts.data.map((a) => ({ accountId: a.accountId, accNum: a.accNum, name: a.name, currency: a.currency, balance: a.balance })),
    });
  }

  if (action === "select") {
    const connectionId = String(body.connectionId ?? "");
    const brokerAccountId = String(body.brokerAccountId ?? "");
    const accNum = String(body.accNum ?? "");
    if (!connectionId || !brokerAccountId || !accNum) return json({ error: "connectionId, brokerAccountId and accNum are required" }, 400);

    const { data: conn } = await admin.from("rapid_broker_connections").select("*").eq("id", connectionId).maybeSingle();
    const c = conn as Record<string, unknown> | null;
    if (!c || c.user_id !== auth.user.id) return json({ error: "not_found" }, 404);

    const { data, error } = await admin.from("rapid_accounts").insert({
      user_id: auth.user.id,
      connection_id: connectionId,
      broker_account_id: brokerAccountId,
      acc_num: accNum,
      environment: c.environment,
      server: c.server,
      name: body.name ? String(body.name) : null,
      currency: body.currency ? String(body.currency) : null,
      // A newly selected account always starts with automation OFF. Selecting an account is not
      // consent to trade it, and consent never transfers from another account.
      automation_enabled: false,
      management_enabled: true,
    }).select("id").maybeSingle();

    if (error) {
      if (/duplicate|unique/i.test(error.message)) {
        return json({ error: "account_already_owned", detail: "this broker account is already registered with Rapid, on this or another login" }, 409);
      }
      return json({ error: error.message }, 500);
    }
    const accountId = (data as { id: string }).id;

    // Readiness, established now rather than on the worker's next pass, so the desk can show at once
    // whether gold resolved, whether the account is shared, and what it holds. Best effort: a broker
    // hiccup here leaves the account linked and the worker re-prepares it on its cadence.
    let readiness: Awaited<ReturnType<typeof prepareAccount>> | null = null;
    try {
      readiness = await prepareAccount({
        id: accountId, user_id: auth.user.id, connection_id: connectionId, broker_account_id: brokerAccountId,
        acc_num: accNum, environment: c.environment as PreparableAccount["environment"], allow_shared_account: false,
        instrument_spec: null, instrument_resolved_at: null,
      });
    } catch (e) {
      readiness = { ok: false, resolvedSymbol: null, missing: [], ownershipOk: null, equity: null, reason: String((e as Error)?.message ?? e) };
    }
    return json({ ok: true, accountId, automationEnabled: false, readiness });
  }

  if (action === "disconnect") {
    const connectionId = String(body.connectionId ?? "");
    const { data: conn } = await admin.from("rapid_broker_connections").select("id, user_id").eq("id", connectionId).maybeSingle();
    const c = conn as { user_id?: string } | null;
    if (!c || c.user_id !== auth.user.id) return json({ error: "not_found" }, 404);

    // Disconnect is a revocation, and it is honest about what it can and cannot reach. New intents
    // stop, local tokens go, and any open exposure is REPORTED rather than quietly forgotten.
    const { data: accounts } = await admin.from("rapid_accounts").select("id").eq("connection_id", connectionId);
    const ids = ((accounts ?? []) as Array<{ id: string }>).map((a) => a.id);
    if (ids.length) {
      await admin.from("rapid_accounts").update({ automation_enabled: false, status: "disabled", block_reason: "connection revoked by the member" }).in("id", ids);
    }
    const { data: open } = ids.length
      ? await admin.from("rapid_positions").select("broker_position_id, side, current_qty, current_stop").in("account_id", ids).in("status", ["open", "closing"])
      : { data: [] as unknown[] };

    await admin.from("rapid_broker_connections").update({
      status: "revoked", access_token: null, enc_refresh: null, enc_password: null, updated_at: new Date().toISOString(),
    }).eq("id", connectionId);

    return json({
      ok: true,
      revoked: true,
      localManagementStopped: true,
      openExposure: open ?? [],
      note: (open ?? []).length
        ? "Rapid has stopped managing this connection. The positions listed are still open at your broker with whatever protection the broker holds; Rapid can no longer touch them."
        : "Rapid has stopped managing this connection and no open Rapid exposure remains.",
    });
  }

  return json({ error: "unknown action" }, 400);
}
