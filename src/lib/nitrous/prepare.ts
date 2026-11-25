import { admin, withNitrousDb } from "../../../rapid/db";
import { freshToken, type RapidConnection } from "../../../rapid/broker/session";
import { brokerReadProblem } from "../../../rapid/broker/refusal";
import { TradeLockerPort } from "../../../rapid/exec/tradelockerPort";
import { checkOwnership } from "../../../rapid/exec/ownership";
import type { PreparableAccount, PrepareResult } from "../../../rapid/exec/prepare";
import { marginRequirement, readAccountMetrics } from "../../../nitrous/broker";

/** Fresh read-only preparation. Money uses broker-provided field maps, never legacy array offsets. */
export async function prepareNitrousAccount(account: PreparableAccount): Promise<PrepareResult> {
  return withNitrousDb(async () => {
    const db = admin();
    const empty: PrepareResult = { ok: false, resolvedSymbol: null, missing: [], ownershipOk: null, equity: null, reason: null };
    const fail = async (reason: string): Promise<PrepareResult> => {
      const result = await db.from("nitrous_accounts").update({ block_reason: reason,
        equity_at: null, balance_at: null, updated_at: new Date().toISOString() }).eq("id", account.id).eq("user_id", account.user_id);
      if (result.error) throw new Error("account_preparation_unavailable");
      return { ...empty, reason };
    };
    const connection = await db.from("nitrous_broker_connections").select("*").eq("id", account.connection_id).eq("user_id", account.user_id).maybeSingle();
    if (connection.error) throw new Error("connection_unavailable");
    if (!connection.data || connection.data.status === "revoked") return fail("Reconnect TradeLocker to restore broker access.");
    const token = await freshToken(connection.data as RapidConnection);
    if (!token.ok) return fail("Reconnect TradeLocker to restore broker access.");
    const ctx = { env: account.environment, token: token.token, accNum: account.acc_num, accountId: account.broker_account_id, preferredSymbol: "XAUUSD" };
    const port = new TradeLockerPort(ctx);
    const [contract, positions, metrics] = await Promise.all([port.spec(), port.positions(), readAccountMetrics(ctx)]);
    const ownership = await checkOwnership(account.broker_account_id, positions.ok ? positions.rows : null, {}, account.allow_shared_account === true);
    const missing = contract.ok ? [...contract.missing] : ["Gold contract"];
    if (contract.ok && marginRequirement(contract.spec, 1, 1, metrics.ok ? metrics.currency : null) === null) missing.push("broker leverage / margin currency");
    const reason = !contract.ok ? brokerReadProblem(contract.error)
      : !positions.ok ? "TradeLocker could not confirm account exposure."
      : !ownership.ok ? ownership.reason ?? "Account exposure needs reconciliation."
      : !metrics.ok ? metrics.error
      : !(Number(metrics.equity) > 0) ? "A fresh positive account equity is required."
      : metrics.freeMargin === null ? "The broker's free margin is unavailable."
      : metrics.freeMargin <= 0 ? "The broker reports no positive free margin."
      : missing.length ? "Some broker contract details needed for sizing are unavailable."
      : null;
    const now = new Date().toISOString();
    const saved = await db.from("nitrous_accounts").update({
      instrument_spec: contract.ok ? contract.spec : null, instrument_resolved_at: contract.ok ? now : null,
      spec_missing: missing, ownership_check: ownership, block_reason: reason,
      balance: metrics.ok ? metrics.balance : null, balance_at: metrics.ok && metrics.balance !== null ? now : null,
      equity: metrics.ok ? metrics.equity : null, equity_at: metrics.ok && metrics.equity !== null ? now : null,
      currency: metrics.ok ? metrics.currency : null, updated_at: now,
    }).eq("id", account.id).eq("user_id", account.user_id);
    if (saved.error) throw new Error("account_preparation_unavailable");
    return { ok: reason === null, resolvedSymbol: contract.ok ? contract.spec.brokerSymbol : null,
      missing, ownershipOk: ownership.ok, equity: metrics.ok ? metrics.equity : null, reason };
  });
}
