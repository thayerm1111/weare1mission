import { admin, journal } from "../db";
import { DEFAULT_CONFIG } from "../config/defaults";
import { freshToken, type RapidConnection } from "../broker/session";
import { checkOwnership } from "./ownership";
import { TradeLockerPort } from "./tradelockerPort";

/**
 * Account preparation.
 *
 * Selecting a broker account gives Rapid an identity, not readiness. Readiness is established here,
 * against the broker, and written to the account row where the desk and the settings route read it:
 *
 *   - `instrument_spec` / `spec_missing`: gold resolved ON THIS ACCOUNT, with the contract metadata
 *     that sizing needs. Without it the Automation switch is refused, by design.
 *   - `ownership_check`: whether another One Mission product (FLOW/GENX, Command Center, AURIC) is
 *     already trading the same broker account, and whether foreign positions are open on it.
 *   - `equity` / `balance` / `currency`: what the account actually has, so risk is a real number.
 *
 * It never places, amends or closes anything. It is safe to run for every linked account on a
 * cadence, whether or not automation is on.
 */

export type PreparableAccount = {
  id: string;
  user_id: string;
  connection_id: string;
  broker_account_id: string;
  acc_num: string;
  environment: "demo" | "live";
  allow_shared_account: boolean;
  instrument_spec: unknown;
  instrument_resolved_at: string | null;
};

export type PrepareResult = {
  ok: boolean;
  resolvedSymbol: string | null;
  missing: string[];
  ownershipOk: boolean | null;
  equity: number | null;
  reason: string | null;
};

const SPEC_TTL_MS = Number(process.env.RAPID_SPEC_TTL_MS || 6 * 60 * 60 * 1000);

export async function portForAccount(acct: { connection_id: string; environment: "demo" | "live"; acc_num: string; broker_account_id: string }):
  Promise<{ ok: true; port: TradeLockerPort } | { ok: false; error: string; reconnect: boolean }> {
  const db = admin();
  const { data } = await db.from("rapid_broker_connections").select("*").eq("id", acct.connection_id).maybeSingle();
  if (!data) return { ok: false, error: "connection row is missing", reconnect: false };
  const conn = data as RapidConnection;
  if (conn.status === "revoked") return { ok: false, error: "this connection was disconnected", reconnect: false };
  const tok = await freshToken(conn);
  if (!tok.ok) return { ok: false, error: tok.error, reconnect: tok.reconnect };
  return {
    ok: true,
    port: new TradeLockerPort({
      env: acct.environment, token: tok.token, accNum: acct.acc_num, accountId: acct.broker_account_id,
      preferredSymbol: DEFAULT_CONFIG.symbol,
    }),
  };
}

export async function prepareAccount(acct: PreparableAccount): Promise<PrepareResult> {
  const db = admin();
  const now = new Date().toISOString();
  const result: PrepareResult = { ok: false, resolvedSymbol: null, missing: [], ownershipOk: null, equity: null, reason: null };

  const p = await portForAccount(acct);
  if (!p.ok) {
    result.reason = p.error;
    await db.from("rapid_accounts").update({ block_reason: p.error, updated_at: now }).eq("id", acct.id);
    await journal({ accountId: acct.id, userId: acct.user_id, stage: "prepare", code: "broker_unreachable", decision: "skip", reason: p.error });
    return result;
  }
  const port = p.port;
  const patch: Record<string, unknown> = { updated_at: now };

  // 1. The instrument. Re-resolved when missing or stale; the contract does not change on a tick.
  const specAge = acct.instrument_resolved_at ? Date.now() - new Date(acct.instrument_resolved_at).getTime() : Infinity;
  if (!acct.instrument_spec || specAge > SPEC_TTL_MS) {
    const s = await port.spec();
    if (s.ok) {
      patch.instrument_spec = s.spec;
      patch.spec_missing = s.missing;
      patch.instrument_resolved_at = now;
      result.resolvedSymbol = s.spec.brokerSymbol;
      result.missing = s.missing;
      await journal({ accountId: acct.id, userId: acct.user_id, stage: "prepare", code: "instrument_resolved", decision: "applied",
        reason: `gold resolved as ${s.spec.brokerSymbol}${s.missing.length ? `; metadata missing: ${s.missing.join(", ")}` : ""}`,
        evidence: { symbol: s.spec.brokerSymbol, missing: s.missing } });
    } else {
      // Left unresolved on purpose. The reason is surfaced, and Automation stays refusable.
      patch.instrument_spec = null;
      patch.block_reason = s.error;
      result.reason = s.error;
      await journal({ accountId: acct.id, userId: acct.user_id, stage: "prepare", code: "instrument_unresolved", decision: "skip", reason: s.error });
    }
  } else {
    result.resolvedSymbol = (acct.instrument_spec as { brokerSymbol?: string }).brokerSymbol ?? null;
  }

  // 2. Ownership. Positions are read fresh every time: another product can arm the account later.
  const positions = await port.positions();
  const ownership = await checkOwnership(
    acct.broker_account_id,
    positions.ok ? positions.rows : null,
    {},
    acct.allow_shared_account === true,
  );
  patch.ownership_check = ownership;
  result.ownershipOk = ownership.ok;

  // 3. Money. What the broker says, when it says it.
  const state = await port.accountState();
  if (state.ok) {
    if (state.equity != null) { patch.equity = state.equity; patch.equity_at = now; }
    if (state.currency) patch.currency = state.currency;
    result.equity = state.equity;
  }

  const resolved = patch.instrument_spec !== undefined ? patch.instrument_spec != null : Boolean(acct.instrument_spec);
  if (resolved && ownership.ok) patch.block_reason = null;
  else if (!ownership.ok && resolved) patch.block_reason = ownership.reason;

  const { error } = await db.from("rapid_accounts").update(patch).eq("id", acct.id);
  if (error) {
    result.reason = error.message;
    return result;
  }
  result.ok = resolved && ownership.ok;
  if (!result.reason && !ownership.ok) result.reason = ownership.reason;
  return result;
}

/** Every linked account, prepared in turn. Never throws: one bad account must not stall the rest. */
export async function prepareAllLinked(): Promise<{ prepared: number; ready: number }> {
  const db = admin();
  const { data } = await db
    .from("rapid_accounts")
    .select("id, user_id, connection_id, broker_account_id, acc_num, environment, allow_shared_account, instrument_spec, instrument_resolved_at")
    .eq("status", "linked");
  const rows = (data ?? []) as PreparableAccount[];
  let ready = 0;
  for (const acct of rows) {
    try {
      const r = await prepareAccount(acct);
      if (r.ok) ready++;
    } catch (e) {
      await journal({ accountId: acct.id, userId: acct.user_id, stage: "prepare", code: "error", decision: "skip", reason: String((e as Error)?.message ?? e) });
    }
  }
  return { prepared: rows.length, ready };
}
