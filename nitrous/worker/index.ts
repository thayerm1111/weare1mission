import { hostname } from "node:os";
import { admin, beat, health, journal, withNitrousDb } from "../../rapid/db";
import { freshToken, type RapidConnection } from "../../rapid/broker/session";
import { TradeLockerPort, type PortContext } from "../../rapid/exec/tradelockerPort";
import type { BrokerPosition } from "../../rapid/exec/port";
import { checkOwnership, tagFor } from "../../rapid/exec/ownership";
import { preSubmissionGate, executablePrice } from "../../rapid/exec/guards";
import { buildSnapshot } from "../../rapid/engine/snapshot";
import { findPivots, classifyRegime } from "../../rapid/engine/structure";
import { requiredStopBuffer } from "../../rapid/engine/tolerances";
import { roundOutward } from "../../rapid/core/decimal";
import { sizePosition } from "../../rapid/risk/sizing";
import { dropForming, fetchBars } from "../../rapid/market/twelvedata";
import { GOLD_SESSION, isSessionOpen } from "../../rapid/market/session";
import type { Bar, InstrumentSpec, MarketSnapshot, Setup } from "../../rapid/core/types";
import type { Store } from "../../rapid/exec/submit";
import { NITROUS_CONSENT_VERSION, NITROUS_FAST_CONSENT_VERSION, isNitrousMode, validRisk, verifiedOwnedPosition } from "../../src/lib/nitrous/policy";
import type { NitrousMode } from "../../src/lib/nitrous/types";
import { publishNitrousTelegramEvent, processNitrousTelegramTest } from "../../src/lib/nitrous-telegram-store";
import { NITROUS_CONFIG, NITROUS_FAST_CONFIG, isFastSetup, configFor } from "../config";
import { selectWatchLevels, countScanChecks } from "../../src/lib/nitrous/dashboard";
import { aggregateClosed, dailyAllowance, memberActive, referenceFresh, supportedSetups, fastCandidateEligible, fastSetups, mergeNitrousSetups, setupAllowedForAccount, triggerConfirmed } from "../logic";
import { readAccountMetrics, readClosedOutcome, readOpeningFill, marginRequirement } from "../broker";
import { protectionMatches, submitProtected } from "../submit";
import { requestCloseOnce } from "../close";
import { advancePublicSetups, publicSetupTerminal } from "../public-events";
import { hasNitrousAddonAccess, revokeNitrousAutomationWithoutAccess } from "../access";

const HOLDER = `nitrous-${hostname()}-${process.pid}`;
const LEASE_MS = 45_000;
let stopped = false;
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const iso = () => new Date().toISOString();
const problem = (e: unknown) => e instanceof Error ? e.message.slice(0, 400) : "Execution check failed.";
const checked = <T>(r: { data: T; error: { message: string } | null }): T => { if (r.error) throw new Error(r.error.message); return r.data; };

type Account = {
  id: string; user_id: string; connection_id: string; broker_account_id: string; acc_num: string;
  environment: "demo" | "live"; profile: NitrousMode; risk_pct: number;
  automation_enabled: boolean; automation_version: number; management_enabled: boolean;
  allow_shared_account: boolean;
  consent_version: string | null; consented_at: string | null; status: string;
};
type Position = Record<string, unknown> & {
  id: string; account_id: string; intent_id: string; broker_position_id: string; broker_strategy_id: string;
  side: "buy" | "sell"; entry: number; original_qty: number; current_qty: number;
  initial_stop: number; current_stop: number; target: number; opened_at: string; status: string;
  protection_state: string; management_enabled: boolean; breakeven_done: boolean;
  close_requested_at: string | null; close_dispatched_at?: string | null; close_request_state?: string | null;
};
type Intent = Record<string, unknown> & {
  id: string; intent_key: string; state: string; broker_strategy_id: string;
  broker_position_id: string | null; broker_order_id: string | null; created_at: string;
  side: "buy" | "sell"; planned_stop: number; planned_target: number; qty: number;
  planned_entry: number; estimated_risk: number; strategy_version: string; config_version: string;
  management_version: string; risk_pct: number; detail: { managementEnabled?: boolean; preexistingPositionIds?: string[] } | null;
};

const market: { m1: Bar[]; higher: Record<string, Bar[]>; fetchedAt: number; higherAt: number; snapshot: MarketSnapshot | null; persistedAt: number; publicSetups: Setup[] } =
  { m1: [], higher: {}, fetchedAt: 0, higherAt: 0, snapshot: null, persistedAt: 0, publicSetups: [] };
const ports = new Map<string, { token: string; port: TradeLockerPort; ctx: PortContext }>();

async function portFor(acct: Account) {
  const conn = checked(await admin().from("nitrous_broker_connections").select("*").eq("id", acct.connection_id).eq("user_id", acct.user_id).maybeSingle()) as RapidConnection | null;
  if (!conn || conn.status === "revoked") throw new Error("Reconnect TradeLocker to restore broker access.");
  const token = await freshToken(conn);
  if (!token.ok) throw new Error(token.error);
  const cached = ports.get(acct.id);
  if (cached?.token === token.token) return cached;
  const ctx: PortContext = { env: acct.environment, token: token.token, accountId: acct.broker_account_id, accNum: acct.acc_num, preferredSymbol: "XAUUSD" };
  const next = { token: token.token, ctx, port: new TradeLockerPort(ctx) };
  ports.set(acct.id, next);
  return next;
}

async function control() {
  const row = checked(await admin().from("nitrous_control").select("mode,entries_paused").eq("id", 1).single());
  return { live: row?.mode === "live" && row.entries_paused === false };
}

async function analysisLoop() {
  let prunedAt = 0;
  let fastZones: MarketSnapshot["zones"] | undefined;
  while (!stopped) {
    const start = Date.now();
    try {
      if (start - market.fetchedAt >= 30_000) {
        const r = await fetchBars("XAU/USD", 1, 1500);
        if (r.ok) { market.m1 = dropForming(r.bars, 1, Date.now()); market.fetchedAt = Date.now(); }
      }
      if (start - market.higherAt >= 300_000) {
        for (const [tf, mins] of [["H1", 60], ["H4", 240], ["D1", 1440]] as const) {
          const r = await fetchBars("XAU/USD", mins, 300);
          if (r.ok) market.higher[tf] = dropForming(r.bars, mins, Date.now());
        }
        market.higherAt = Date.now();
      }
      if (market.m1.length) {
        const now = Date.now();
        const five = aggregateClosed(market.m1, 5, now); const fifteen = aggregateClosed(market.m1, 15, now);
        const snap = buildSnapshot({ asOf: now, cfg: NITROUS_CONFIG, tick: 0.01, contractSize: null,
          minStopDistance: null, m1: market.m1, higher: { ...market.higher, M5: five, M15: fifteen }, quote: null, priorZones: market.snapshot?.zones });
        const reference = market.m1.at(-1)!.c;
        const fast = buildSnapshot({ asOf: now, cfg: NITROUS_FAST_CONFIG, tick: 0.01, contractSize: null,
          minStopDistance: null, m1: market.m1, higher: { ...market.higher, M5: five, M15: fifteen }, quote: null, priorZones: fastZones,
          candidateFilter: (s, regimes, range) => fastCandidateEligible(s, regimes, range, reference, now)
            && (s.family !== "break_retest" || triggerConfirmed(s, s.timeframe === "M15" ? fifteen : five, now)),
          nearestCandidates: { limit: 2, price: reference } });
        fastZones = fast.zones;
        const baselinePlans = supportedSetups(snap);
        const fastPlans = fastSetups(fast);
        const thirty = aggregateClosed(market.m1, 30, now);
        const pivots = findPivots(thirty, "M15", 2, 2);
        const regime30 = classifyRegime(thirty, pivots, now, { atrPeriod: 14, noiseTicks: 2, noiseAtrMult: 0.1, tickSize: 0.01, minSwingsPerSide: 2 }).regime;
        const reasons: string[] = [];
        if (!referenceFresh(market.m1, now)) reasons.push("The latest completed market candle is stale.");
        if (!isSessionOpen(now, GOLD_SESSION)) reasons.push("The gold session is closed.");
        if (fifteen.length < 60) reasons.push("More completed candles are needed for a market read.");
        const h1 = market.higher.H1?.at(-1);
        if (!h1 || now - h1.t - 3_600_000 > 3_720_000) reasons.push("The 1H trend feed needs to refresh.");
        const lifecycle = advancePublicSetups({ prior: market.publicSetups, current: mergeNitrousSetups(baselinePlans, fastPlans),
          bars: market.m1, referencePrice: market.m1.at(-1)!.c, now, marketReady: reasons.length === 0,
          triggerReady: (s) => triggerConfirmed(s, s.timeframe === "M15" ? fifteen : five, now) });
        snap.scenarios = lifecycle.updatedSetups.filter((s) => !publicSetupTerminal(s));
        snap.health = { ...snap.health, state: reasons.length ? "blocked" : "ok", reasons };
        snap.marketEventTime = market.m1.at(-1)!.t + 60_000;
        snap.deterministicExplanation = snap.scenarios.length
          ? "Slow Drip requires aligned 1H/15M structure. Faster Nitrous also watches nearby break/retests, pullbacks and validated range reactions during 15M consolidation. Entries still require closed confirmation and broker risk checks."
          : "Scanning both profiles. Nitrous can qualify during 15M consolidation; waiting for nearby structural plans with at least $6 of target room.";
        checked(await admin().from("nitrous_snapshots").insert({ snapshot_id: snap.snapshotId,
          strategy_version: snap.strategyVersion, config_version: snap.configVersion, generated_at: new Date(now).toISOString(),
          market_event_time: new Date(snap.marketEventTime).toISOString(), feed_source: "reference", quote_age_ms: null,
          health: snap.health, regimes: { ...snap.regimes, M30: regime30 }, regime_conflict: snap.regimeConflict,
          payload: { scenarios: snap.scenarios, explanation: snap.deterministicExplanation,
            bars: five.slice(-180), price: market.m1.at(-1)!.c, chartTimeframe: "5m",
            rejections: snap.rejections.slice(0, 40), fastRejections: fast.rejections.slice(0, 40), fastConfigVersion: fast.configVersion, baselineCandidates: baselinePlans.length, fastCandidates: fastPlans.length, watchLevels: selectWatchLevels([...snap.zones,...fast.zones], reference, now), baselineChecks: countScanChecks(snap.rejections), fastChecks: countScanChecks(fast.rejections), levels: snap.zones.slice(0, 100) } }));
        checked(await admin().from("nitrous_public_state").upsert({ id: 1, setups: lifecycle.updatedSetups, updated_at: iso() }));
        market.publicSetups = lifecycle.updatedSetups;
        market.snapshot = snap; market.persistedAt = Date.now();
        for (const event of lifecycle.events) await publishNitrousTelegramEvent(admin(), event);
        if (now - prunedAt > 1_800_000) { checked(await admin().rpc("nitrous_prune_context")); prunedAt = now; }
      }
      await beat("nitrous-analysis", { bars: market.m1.length, scenarios: market.snapshot?.scenarios.length ?? 0, passMs: Date.now() - start });
    } catch (e) { await health("nitrous-analysis", "degraded", { error: problem(e) }); }
    await wait(Math.max(1000, 15_000 - (Date.now() - start)));
  }
}

// Unlike the legacy lease helper, a failed renewal cannot keep an expired lease locally alive.
async function leaseFor<T>(accountId: string, task: (fence: number, held: () => boolean) => Promise<T>) {
  const data = checked(await admin().rpc("nitrous_acquire_lease", { p_account: accountId, p_owner: HOLDER, p_ttl_ms: LEASE_MS }));
  const l = Array.isArray(data) ? data[0] : data;
  if (!l?.acquired) return;
  const fence = Number(l.fence); let expires = Date.now() + LEASE_MS; let lost = false;
  const timer = setInterval(() => { void (async () => {
    const r = await admin().rpc("nitrous_extend_lease", { p_account: accountId, p_owner: HOLDER, p_fence: fence, p_ttl_ms: LEASE_MS });
    if (r.error || r.data !== true) lost = true; else expires = Date.now() + LEASE_MS;
  })().catch(() => { lost = true; }); }, 10_000);
  try { return await task(fence, () => !lost && Date.now() < expires && !stopped); }
  finally { clearInterval(timer); await admin().rpc("nitrous_release_lease", { p_account: accountId, p_owner: HOLDER, p_fence: fence }); }
}

function storeFor(acct: Account, setup: Pick<Setup, "side" | "strategyVersion" | "configVersion">, strategyId: string): Store {
  return {
    setState: async (id, state, patch) => { checked(await admin().from("nitrous_intents").update({ state, ...patch, updated_at: iso() }).eq("id", id));
      if (["closed", "cancelled", "rejected"].includes(state)) {
        const intent = checked(await admin().from("nitrous_intents").select("intent_key").eq("id", id).single());
        if (!intent) throw new Error("Reserved intent is unavailable.");
        checked(await admin().from("nitrous_risk_reservations").update({ state: "released", settled_at: iso() }).eq("intent_key", intent.intent_key));
      } },
    recordBrokerEvent: async (intentId, e) => { checked(await admin().from("nitrous_broker_events").insert({ intent_id: intentId, account_id: acct.id,
      kind: e.kind, ok: e.ok, uncertain: e.uncertain ?? false, error: e.error ?? null, order_id: e.orderId ?? null,
      position_id: e.positionId ?? null, qty: e.qty ?? null, price: e.price ?? null, payload: e.payload ?? null })); },
    openPosition: async (intentId, p) => { checked(await admin().from("nitrous_positions").upsert({ account_id: acct.id, user_id: acct.user_id,
      intent_id: intentId, broker_position_id: p.positionId, broker_strategy_id: strategyId, side: setup.side,
      strategy_version: setup.strategyVersion, config_version: setup.configVersion, management_version: NITROUS_CONFIG.managementVersion,
      management_enabled: acct.management_enabled, risk_pct: acct.risk_pct, entry: p.entry, original_qty: p.qty,
      current_qty: p.qty, initial_stop: p.stop, current_stop: p.stop, target: p.target,
      protection_state: p.protectionState, best_price: p.entry, worst_price: p.entry,
    }, { onConflict: "account_id,broker_position_id", ignoreDuplicates: true })); },
  };
}

async function reconcile(acct: Account, port: TradeLockerPort, ctx: PortContext, brokerRows: BrokerPosition[], spec: InstrumentSpec, currency: string | null): Promise<Position[]> {
  const db = admin();
  const pending = checked(await db.from("nitrous_intents").select("*").eq("account_id", acct.id)
    .in("state", ["reserved", "submitting", "acknowledged", "partially_filled", "filled", "submission_unknown", "protection_pending", "cancel_requested"])) as Intent[];
  for (const intent of pending) {
    if (intent.state === "reserved") {
      // Persisting 'submitting' always precedes dispatch; a reserved-only crash cannot have sent it.
      if (Date.now() - Date.parse(intent.created_at) > 30_000) await storeFor(acct, { side: intent.side, strategyVersion: intent.strategy_version, configVersion: intent.config_version }, intent.broker_strategy_id).setState(intent.id, "cancelled", { error: "Unused reservation expired." });
      continue;
    }
    const opening = await readOpeningFill(ctx, { orderId: intent.broker_order_id, positionId: intent.broker_position_id,
      strategyId: intent.broker_strategy_id, side: intent.side, submittedAt: String(intent.submitted_at ?? intent.created_at) }, spec);
    const positionId = opening.ok ? opening.positionId : intent.broker_position_id;
    const preexisting = intent.detail?.preexistingPositionIds;
    if ((positionId && preexisting?.includes(positionId)) || (acct.allow_shared_account && !Array.isArray(preexisting))) {
      checked(await db.from("nitrous_intents").update({ state: "protection_pending",
        error: "Shared position ownership requires reconciliation; existing exposure was not adopted.", updated_at: iso() }).eq("id", intent.id));
      continue;
    }
    const live = positionId ? brokerRows.find((r) => r.positionId === positionId && r.strategyId === intent.broker_strategy_id) : undefined;
    if (live && live.side === intent.side && Number(live.entry) > 0 && Number(live.qty) > 0) {
      const store = storeFor({ ...acct, management_enabled: intent.detail?.managementEnabled === true, risk_pct: Number(intent.risk_pct) }, { side: intent.side, strategyVersion: intent.strategy_version, configVersion: intent.config_version }, intent.broker_strategy_id);
      const protection = protectionMatches(live, { side: intent.side, qty: Number(intent.qty), stop: Number(intent.planned_stop), target: Number(intent.planned_target),
        tick: spec.tickSize!, strategyId: intent.broker_strategy_id, riskBudget: Number(intent.estimated_risk),
        valuePerPricePerLot: spec.contractSize ?? 0, commissionPerLot: NITROUS_CONFIG.risk.commissionPerLotRoundTrip,
        exitAllowance: (spec.tickSize ?? 0.01) * NITROUS_CONFIG.risk.exitSlippageTicks });
      await store.openPosition(intent.id, { positionId: live.positionId, entry: live.entry!, qty: live.qty!, stop: Number(intent.planned_stop), target: Number(intent.planned_target), protectionState: protection ? "protected" : "unconfirmed" });
      if (opening.ok) checked(await db.from("nitrous_positions").update({ entry: opening.entry, original_qty: opening.qty, opened_at: opening.openedAt })
        .eq("account_id", acct.id).eq("broker_position_id", opening.positionId));
      if (protection) {
        await store.setState(intent.id, "protected", { broker_position_id: live.positionId, fill_price: live.entry, filled_qty: live.qty });
        checked(await db.from("nitrous_positions").update({ status: "open", protection_state: "protected", current_stop: live.stopLoss, current_qty: live.qty })
          .eq("account_id", acct.id).eq("broker_position_id", live.positionId).is("close_requested_at", null));
      }
      else await store.setState(intent.id, "protection_pending", { broker_position_id: live.positionId, error: "Protection or fill risk requires review." });
    } else if (!live) {
      // A fast trade can open and close before the first successful positions read. Recover its
      // terminal opening fill by acknowledged identity, then require complete closing evidence.
      if (opening.ok) {
        const store = storeFor({ ...acct, management_enabled: intent.detail?.managementEnabled === true, risk_pct: Number(intent.risk_pct) }, { side: intent.side, strategyVersion: intent.strategy_version, configVersion: intent.config_version }, intent.broker_strategy_id);
        await store.openPosition(intent.id, { positionId: opening.positionId, entry: opening.entry, qty: opening.qty,
          stop: Number(intent.planned_stop), target: Number(intent.planned_target), protectionState: "unconfirmed" });
        checked(await db.from("nitrous_positions").update({ entry: opening.entry, original_qty: opening.qty, opened_at: opening.openedAt })
          .eq("account_id", acct.id).eq("broker_position_id", opening.positionId));
        await store.setState(intent.id, "protection_pending", { broker_position_id: opening.positionId, fill_price: opening.entry, filled_qty: opening.qty });
      }
    }
    // An empty broker response does not prove an unknown entry was rejected. Never auto-retry it.
  }
  const open = checked(await db.from("nitrous_positions").select("*").eq("account_id", acct.id).in("status", ["open", "closing", "orphan_review"])) as Position[];
  const unresolvedClosed = checked(await db.from("nitrous_positions").select("*").eq("account_id", acct.id).eq("status", "closed").is("realised_pnl", null).order("closed_at", { ascending: false }).limit(20)) as Position[];
  for (const p of [...open, ...unresolvedClosed]) {
    if (brokerRows.some((r) => r.positionId === p.broker_position_id)) continue;
    const intent = p.intent_id ? checked(await db.from("nitrous_intents").select("*").eq("id", p.intent_id).single()) as Intent | null : null;
    if (intent) {
      const opening = await readOpeningFill(ctx, { orderId: intent.broker_order_id, positionId: p.broker_position_id,
        strategyId: p.broker_strategy_id, side: p.side, submittedAt: String(intent.submitted_at ?? intent.created_at) }, spec);
      if (opening.ok) {
        p.entry = opening.entry; p.original_qty = opening.qty; p.opened_at = opening.openedAt;
        checked(await db.from("nitrous_positions").update({ entry: p.entry, original_qty: p.original_qty, opened_at: p.opened_at }).eq("id", p.id));
      }
    }
    const outcome = await readClosedOutcome(ctx, { broker_position_id: p.broker_position_id, side: p.side, entry: Number(p.entry), original_qty: Number(p.original_qty), opened_at: p.opened_at }, spec, currency);
    if (!outcome.ok) {
      checked(await db.from("nitrous_positions").update({ status: "orphan_review", close_reason: "Awaiting verified broker closing evidence", updated_at: iso() }).eq("id", p.id));
      if (p.intent_id) checked(await db.from("nitrous_intents").update({ state: "protection_pending", error: "Awaiting verified broker closing evidence", updated_at: iso() }).eq("id", p.intent_id));
      continue;
    }
    checked(await db.from("nitrous_positions").update({ status: "closed", closed_at: outcome.closedAt,
      current_qty: 0, exit_price: outcome.exitPrice, realised_pnl: outcome.realisedPnl,
      realised_pnl_source: outcome.source, fees_verified: outcome.feesVerified,
      close_reason: "Broker closure reconciled", updated_at: iso() }).eq("id", p.id));
    if (p.intent_id) await storeFor(acct, { side: p.side, strategyVersion: String(p.strategy_version), configVersion: String(p.config_version) }, p.broker_strategy_id).setState(p.intent_id, "closed");
  }
  return checked(await db.from("nitrous_positions").select("*").eq("account_id", acct.id).in("status", ["open", "closing", "orphan_review"])) as Position[];
}

async function closeOnce(p: Position, port: TradeLockerPort, reason: string, held: () => boolean) {
  if (!held() || ["dispatching", "acknowledged", "uncertain", "rejected"].includes(String(p.close_request_state))) return;
  const db = admin();
  const result = await requestCloseOnce({ positionId: p.broker_position_id, held, port,
    approved: async () => { const positions = await port.positions(); return positions.ok && verifiedOwnedPosition(p, positions.rows.find((r) => r.positionId === p.broker_position_id)); },
    claim: async () => {
      const claimed = checked(await db.from("nitrous_positions").update({ close_requested_at: p.close_requested_at ?? iso(),
        close_dispatched_at: iso(), close_request_state: "dispatching", close_reason: reason, status: "closing", updated_at: iso() })
        .eq("id", p.id).eq("broker_strategy_id", p.broker_strategy_id).neq("status", "closed").is("close_dispatched_at", null).select("id"));
      return Boolean(claimed?.length);
    },
    finish: async (r) => {
      checked(await db.from("nitrous_positions").update({ close_request_state: r.state === "cancelled" ? "requested" : r.state,
        close_request_error: r.error ? (r.state === "uncertain" ? "Broker close outcome unknown. Awaiting reconciliation." : "Broker close was not accepted. Review this position before retrying.") : null,
        updated_at: iso(), ...(r.state === "cancelled" ? { close_dispatched_at: null } : {}),
        ...(r.state === "rejected" ? { status: "open", close_requested_at: null, close_dispatched_at: null } : {}) }).eq("id", p.id).eq("close_request_state", "dispatching"));
    } });
  await journal({ accountId: p.account_id, stage: "manage", code: "close_requested", decision: result.state, reason });
}

async function manage(acct: Account, rows: Position[], brokerRows: BrokerPosition[], port: TradeLockerPort, spec: InstrumentSpec, held: () => boolean) {
  for (const p of rows) {
    const live = brokerRows.find((r) => r.positionId === p.broker_position_id);
    if (!verifiedOwnedPosition(p, live) || !live || !held()) continue;
    if (p.close_requested_at) { await closeOnce(p, port, "Member requested close", held); continue; }
    const d = p.side === "buy" ? 1 : -1;
    const safe = Number(live.stopLoss) > 0 && d * (Number(live.stopLoss) - Number(p.initial_stop)) >= -(spec.tickSize ?? 0.01) && Number(live.qty) <= Number(p.original_qty) + 1e-8;
    if (!safe || p.protection_state !== "protected") { await closeOnce(p, port, "Native protection or filled risk could not be verified", held); continue; }
    checked(await admin().from("nitrous_positions").update({ current_stop: live.stopLoss, current_qty: live.qty, updated_at: iso() }).eq("id", p.id));
    if (!p.management_enabled || p.breakeven_done || p.status !== "open") continue;
    const q = await port.quote(); if (!q.ok || Date.now() - q.quote.receivedAt > NITROUS_CONFIG.feed.maxQuoteAgeMs) continue;
    const price = executablePrice(q.quote, p.side, "exit"); if (price == null) continue;
    const trigger = Math.max(3, Math.abs(Number(p.entry) - Number(p.initial_stop)));
    if (d * (price - Number(p.entry)) < trigger) continue;
    const feeBuffer = (spec.contractSize ?? 0) > 0 ? NITROUS_CONFIG.risk.commissionPerLotRoundTrip / spec.contractSize! : 0;
    const stop = roundOutward(Number(p.entry) + d * feeBuffer, spec.tickSize!, d === 1 ? -1 : 1);
    if (d * (stop - Number(live.stopLoss)) <= 0 || Math.abs(price - stop) < (spec.minStopDistance ?? 0) || !held()) continue;
    const result = await port.amend(p.broker_position_id, { stopLoss: stop });
    if (!result.ok) continue;
    const after = await port.positions(); const confirmed = after.ok ? after.rows.find((r) => r.positionId === p.broker_position_id) : undefined;
    if (verifiedOwnedPosition(p, confirmed) && confirmed?.stopLoss != null && Math.abs(confirmed.stopLoss - stop) <= spec.tickSize! * 1.1)
      checked(await admin().from("nitrous_positions").update({ current_stop: confirmed.stopLoss, breakeven_done: true, breakeven_at: iso() }).eq("id", p.id));
  }
}

async function riskRemaining(acct: Account, equity: number): Promise<number> {
  const db = admin(); const day = iso().slice(0, 10); const cfg = configFor(acct.profile);
  checked(await db.from("nitrous_risk_days").upsert({ account_id: acct.id, day, start_equity: equity, max_loss_pct: cfg.risk.sessionLossCeilingPct }, { onConflict: "account_id,day", ignoreDuplicates: true }));
  const budget = checked(await db.from("nitrous_risk_days").select("*").eq("account_id", acct.id).eq("day", day).single());
  const pct = Math.min(Number(budget.max_loss_pct), cfg.risk.sessionLossCeilingPct);
  if (pct < Number(budget.max_loss_pct)) checked(await db.from("nitrous_risk_days").update({ max_loss_pct: pct }).eq("account_id", acct.id).eq("day", day));
  const closed = checked(await db.from("nitrous_positions").select("realised_pnl,realised_pnl_source").eq("account_id", acct.id).eq("status", "closed").gte("closed_at", `${day}T00:00:00Z`).limit(1000)) ?? [];
  if (closed.length >= 100 || closed.length >= (acct.profile === "slow_drip" ? 10 : 100)) throw new Error("Today's entry limit has been reached. Existing positions keep their protection.");
  const remaining = dailyAllowance(Number(budget.start_equity), equity, pct, closed);
  if (remaining === null) throw new Error("A closed trade result needs reconciliation before another entry.");
  if (remaining <= 0) throw new Error("Today's loss allowance is exhausted. New entries are paused until the next UTC day.");
  return remaining;
}

async function considerEntry(acct: Account, port: TradeLockerPort, spec: InstrumentSpec, currency: string | null, equity: number, freeMargin: number | null, fence: number, held: () => boolean) {
  const snap = market.snapshot;
  if (!snap || snap.health.state !== "ok" || Date.now() - market.persistedAt > 40_000 || !referenceFresh(market.m1, Date.now())) throw new Error("Waiting for fresh market data.");
  const db = admin(); const cfg = configFor(acct.profile);
  if (!memberActive(checked(await db.from("profiles").select("status,role,access_expires_at").eq("id", acct.user_id).maybeSingle()), Date.now())) throw new Error("Active One Mission access is required for new entries.");
  if (!await hasNitrousAddonAccess(db, acct.user_id)) throw new Error("Nitrous add-on access is required for new entries.");
  if (![NITROUS_CONSENT_VERSION, NITROUS_FAST_CONSENT_VERSION].includes(acct.consent_version ?? "") || !acct.consented_at || !isNitrousMode(acct.profile) || validRisk(acct.profile, Number(acct.risk_pct)) === null) throw new Error("Review your account mode and risk before activating.");
  const recent = checked(await db.from("nitrous_positions").select("closed_at").eq("account_id", acct.id).eq("status", "closed").order("closed_at", { ascending: false }).limit(1)) ?? [];
  if (recent[0]?.closed_at && Date.now() - Date.parse(recent[0].closed_at) < cfg.entry.reentryCooldownSec * 1000) return;
  const remaining = await riskRemaining(acct, equity);
  for (const candidate of snap.scenarios) {
    if (!held()) return;
    if (!setupAllowedForAccount(candidate, acct.profile, acct.consent_version)) continue;
    const cfg = configFor(acct.profile, isFastSetup(candidate));
    if (!triggerConfirmed(candidate, aggregateClosed(market.m1, candidate.timeframe === "M15" ? 15 : 5, Date.now()), Date.now())) continue;
    const baseline = await port.positions();
    if (!baseline.ok || baseline.rows.some((p) => !p.positionId)) throw new Error("Current broker exposure must be readable before a new entry.");
    if (baseline.rows.some((p) => p.strategyId?.startsWith("NITROUS:"))) throw new Error("An existing Nitrous position must settle before another entry.");
    const preexistingPositionIds = baseline.rows.map((p) => p.positionId);
    const q = await port.quote(); if (!q.ok) throw new Error(q.error);
    const price = executablePrice(q.quote, candidate.side, "entry"); if (price === null) continue;
    if (price < candidate.entryBandLow || price > candidate.entryBandHigh) continue;
    if (Math.abs(candidate.target - price) < cfg.target.minUsd) continue;
    const basis = Math.abs((q.quote.ask + q.quote.bid) / 2 - market.m1.at(-1)!.c);
    const buffer = requiredStopBuffer(candidate.tolerances.atrEntry, q.quote.ask - q.quote.bid, spec.tickSize!, cfg);
    const d = candidate.side === "buy" ? 1 : -1;
    const setup: Setup = { ...candidate, stop: roundOutward(candidate.invalidation - d * buffer, spec.tickSize!, d === 1 ? -1 : 1), tolerances: { ...candidate.tolerances, stopBuffer: buffer } };
    const approvedAt = Date.now();
    const gate = preSubmissionGate({ now: approvedAt, setup, quote: q.quote, quoteAgeMs: approvedAt - q.quote.receivedAt, spec,
      executable: price, currentZoneVersion: setup.zoneVersion, automationVersionAtDecision: acct.automation_version,
      automationVersionNow: acct.automation_version, automationEnabled: acct.automation_enabled,
      sessionOpen: isSessionOpen(approvedAt, GOLD_SESSION), newsBlocked: false, basisUnstable: basis > cfg.feed.maxBasisUsd, signalAgeMs: 0, cfg });
    if (!gate.ok) { await journal({ accountId: acct.id, stage: "entry", code: gate.code, decision: "skip", reason: gate.reason }); continue; }
    const size = sizePosition({ side: setup.side, executable: price, stop: setup.stop, equity, riskPct: Number(acct.risk_pct), spec,
      conversionRate: currency && currency === spec.currency ? 1 : null, remainingSessionRisk: remaining, cfg });
    if (!size.ok) { await journal({ accountId: acct.id, stage: "entry", code: "sizing_blocked", decision: "skip", reason: size.reason, evidence: { blockers: size.blockers } }); continue; }
    const margin = marginRequirement(spec, size.qty, price, currency);
    if (margin === null || freeMargin === null || margin > freeMargin - equity * 0.2) throw new Error("This setup does not fit the broker's verified free margin with a 20% equity reserve.");
    const visit = `${acct.id}|${setup.parentId}|${setup.zoneVersion}|${setup.side}|${iso().slice(0, 10)}`;
    const intentKey = `om_nitrous_v1|${visit}`; const strategyId = tagFor(intentKey);
    const reserved = checked(await db.rpc("nitrous_reserve_intent", { p_intent_key: intentKey, p_account: acct.id, p_user: acct.user_id,
      p_session: null, p_visit: visit, p_setup: setup.setupId, p_snapshot: snap.snapshotId, p_strategy: setup.strategyVersion,
      p_config: setup.configVersion, p_management: cfg.managementVersion, p_family: setup.family, p_side: setup.side,
      p_entry: price, p_stop: setup.stop, p_target: setup.target, p_qty: size.qty, p_risk_pct: Number(acct.risk_pct),
      p_estimated_risk: size.estimatedRisk, p_bid: q.quote.bid, p_ask: q.quote.ask, p_quote_age_ms: approvedAt - q.quote.receivedAt,
      p_spread: q.quote.ask - q.quote.bid, p_automation_version: acct.automation_version, p_fence: fence, p_broker_strategy_id: strategyId }));
    const reservation = Array.isArray(reserved) ? reserved[0] : reserved;
    if (!reservation?.created || !reservation.intent_id) continue;
    checked(await db.from("nitrous_intents").update({ detail: { managementEnabled: acct.management_enabled, feeAllowancePerLot: cfg.risk.commissionPerLotRoundTrip, quoteBasis: basis, profile: acct.profile, preexistingPositionIds } }).eq("id", reservation.intent_id));
    const approved = async () => {
      if (!held() || Date.now() - approvedAt > cfg.feed.maxSignalToSubmitMs || !referenceFresh(market.m1, Date.now())) return false;
      const [a, c, lease, member, addonAccess] = await Promise.all([
        db.from("nitrous_accounts").select("automation_enabled,automation_version,status").eq("id", acct.id).single(),
        db.from("nitrous_control").select("mode,entries_paused").eq("id", 1).single(),
        db.from("nitrous_leases").select("owner,fence,expires_at").eq("account_id", acct.id).single(),
        db.from("profiles").select("status,role,access_expires_at").eq("id", acct.user_id).maybeSingle(),
        hasNitrousAddonAccess(db, acct.user_id),
      ]);
      return addonAccess && ![a,c,lease,member].some((r) => r.error) && a.data?.automation_enabled === true && a.data.automation_version === acct.automation_version && a.data.status === "linked" &&
        c.data?.mode === "live" && c.data.entries_paused === false && lease.data?.owner === HOLDER && Number(lease.data.fence) === fence &&
        Date.parse(lease.data.expires_at) > Date.now() && memberActive(member.data, Date.now()) && held() && Date.now() - q.quote.receivedAt <= cfg.feed.maxQuoteAgeMs;
    };
    const outcome = await submitProtected({ intentId: reservation.intent_id, side: setup.side, qty: size.qty, stop: setup.stop,
      preexistingPositionIds,
      target: setup.target, strategyId, tick: spec.tickSize!, riskBudget: Math.min(size.riskBudget, remaining), valuePerPricePerLot: size.valuePerPricePerLot,
      commissionPerLot: cfg.risk.commissionPerLotRoundTrip, exitAllowance: cfg.risk.exitSlippageTicks * spec.tickSize!, protectionDeadlineMs: 8000,
      approved, stillOwned: held, port, store: storeFor(acct, setup, strategyId), requestClose: async (positionId, reason) => {
        const p = checked(await db.from("nitrous_positions").select("*").eq("account_id", acct.id).eq("broker_position_id", positionId).single()) as Position;
        if (p.broker_strategy_id !== strategyId) throw new Error("Close ownership could not be verified.");
        await closeOnce(p, port, reason, held);
      } });
    await journal({ accountId: acct.id, userId: acct.user_id, intentId: reservation.intent_id, stage: "entry", code: outcome.state, decision: outcome.state, reason: outcome.reason });
    return;
  }
}

async function serveAccount(acct: Account, fence: number, held: () => boolean) {
  const { port, ctx } = await portFor(acct);
  const [contract, exposureRead, metrics] = await Promise.all([port.spec(), port.positions().then(result => ({result, observedAt: iso()})), readAccountMetrics(ctx)]);
  const {result: positions, observedAt} = exposureRead;
  if (!contract.ok) throw new Error(contract.error);
  if (!positions.ok) throw new Error(positions.error);
  const ownership = await checkOwnership(acct.broker_account_id, positions.rows, {}, acct.allow_shared_account === true);
  const missing = [...contract.missing];
  if (marginRequirement(contract.spec, 1, 1, metrics.ok ? metrics.currency : null) === null) missing.push("broker leverage / margin currency");
  checked(await admin().from("nitrous_accounts").update({ instrument_spec: contract.spec, instrument_resolved_at: iso(), spec_missing: missing,
    ...(metrics.ok ? { balance: metrics.balance, balance_at: metrics.balance === null ? null : iso(),
      equity: metrics.equity, equity_at: metrics.equity === null ? null : iso(), currency: metrics.currency } : {}), updated_at: iso() }).eq("id", acct.id));
  const rows = await reconcile(acct, port, ctx, positions.rows, contract.spec, metrics.ok ? metrics.currency : null);
  // Always protect already-owned positions, even when new entries or membership are paused.
  await manage(acct, rows, positions.rows, port, contract.spec, held);
  // Display-only telemetry: use exact ledger/broker identity. Failure cannot prevent protection.
  for (const row of rows) {
    if (!held()) break;
    const live = positions.rows.find(p => p.positionId === row.broker_position_id);
    const confirmed = verifiedOwnedPosition(row, live) && live?.side === row.side && Number(live?.qty) > 0 && row.status !== "orphan_review";
    try {
      await admin().from("nitrous_positions").update({
        live_observed_at: confirmed ? observedAt : null,
        live_unrealized_pnl: confirmed && typeof live?.unrealizedPnl === "number" && Number.isFinite(live.unrealizedPnl) ? live.unrealizedPnl : null,
      }).eq("id",row.id).eq("account_id",acct.id).eq("broker_strategy_id",row.broker_strategy_id).in("status",["open","closing","orphan_review"]);
    } catch { /* Best effort UI data; old observations age out. */ }
  }
  if (!await revokeNitrousAutomationWithoutAccess(admin(), acct)) throw new Error("Nitrous add-on access is required for new entries. Existing positions keep their protection.");
  if (rows.some((p) => p.status === "orphan_review" || p.protection_state !== "protected")) throw new Error("A position needs broker reconciliation. New entries remain paused.");
  const known = new Set(rows.map((p) => p.broker_position_id));
  if (positions.rows.some((p) => p.strategyId?.startsWith("NITROUS:") && !known.has(p.positionId))) throw new Error("An untracked Nitrous position needs reconciliation. New entries are paused.");
  if (!ownership.ok) throw new Error(ownership.reason);
  if (!metrics.ok) throw new Error(metrics.error);
  if (!(Number(metrics.equity) > 0) || !metrics.currency || missing.length) throw new Error(`Broker account or contract information is incomplete${missing.length ? `: ${missing.join(", ")}` : "."}`);
  const unresolved = await admin().from("nitrous_intents").select("id", { count: "exact", head: true }).eq("account_id", acct.id)
    .in("state", ["reserved", "submitting", "acknowledged", "partially_filled", "filled", "submission_unknown", "protection_pending", "cancel_requested"]);
  checked(unresolved);
  if ((unresolved.count ?? 1) > 0) throw new Error("An earlier order needs reconciliation before another entry.");
  // A preparation failure on the website is not permanent: reconcile it against the
  // worker's successful broker read, never against a fabricated or missing margin.
  const marginReady = metrics.freeMargin !== null && metrics.freeMargin > 0;
  if (!held()) return;
  checked(await admin().from("nitrous_accounts").update({
    ownership_check: { ...ownership, workerVerified: marginReady, workerConnectionId: acct.connection_id },
    block_reason: marginReady ? null : metrics.freeMargin === null
      ? "The broker's free margin is unavailable." : "The broker reports no positive free margin.",
    updated_at: iso(),
  }).eq("id", acct.id).eq("connection_id", acct.connection_id).eq("automation_version", acct.automation_version).eq("status", "linked"));
  if (marginReady && !rows.length && acct.automation_enabled && (await control()).live) await considerEntry(acct, port, contract.spec, metrics.currency, metrics.equity!, metrics.freeMargin, fence, held);
  checked(await admin().from("nitrous_accounts").update({ execution_block_reason: null }).eq("id", acct.id));
}

let lastAccountPass = 0;
async function accountLoop() {
  while (!stopped) {
    const start = Date.now();
    try {
      const accounts = checked(await admin().from("nitrous_accounts").select("*").in("status", ["linked", "blocked"])) as Account[];
      for (const acct of accounts) {
        if (stopped) break;
        try { await leaseFor(acct.id, (fence, held) => serveAccount(acct, fence, held)); }
        catch (e) { const reason = problem(e); await admin().from("nitrous_accounts").update({ execution_block_reason: reason, updated_at: iso() }).eq("id", acct.id); await health("nitrous-account", "blocked", { error: reason }, acct.id); }
      }
      lastAccountPass = Date.now(); await beat("nitrous-accounts", { served: accounts.length, passMs: Date.now() - start });
    } catch (e) { await health("nitrous-accounts", "degraded", { error: problem(e) }); }
    await wait(Math.max(1000, 10_000 - (Date.now() - start)));
  }
}

async function watchdog() {
  while (!stopped) {
    try {
      const sessionOpen = isSessionOpen(Date.now(), GOLD_SESSION);
      // Members may arm a ready account while the market is closed. Entry permission still
      // requires an open session, fresh candles and a fresh broker quote in considerEntry.
      const state = market.snapshot && Date.now() - market.persistedAt < 45_000 &&
        (!sessionOpen || (market.snapshot.health.state === "ok" && referenceFresh(market.m1, Date.now()))) &&
        Date.now() - lastAccountPass < 60_000 ? "ok" : "blocked";
      await beat("nitrous-watchdog", { state, holder: HOLDER, addonEnforced: true, sharedAccountsSupported: true, referenceEventAt: market.m1.at(-1)?.t ?? null,
        marketState: sessionOpen ? "open" : "closed",
        snapshotAgeMs: market.persistedAt ? Date.now() - market.persistedAt : null,
        accountsAgeMs: lastAccountPass ? Date.now() - lastAccountPass : null });
    } catch { /* A failed heartbeat ages out and blocks activation. */ }
    await wait(5000);
  }
}

async function telegramTestLoop() {
  while (!stopped) {
    try { await processNitrousTelegramTest(admin()); }
    catch { /* Test notifications must never interrupt account execution or protection. */ }
    await wait(5000);
  }
}

export async function main() {
  if (process.env.NITROUS_WORKER !== "1") throw new Error("Set NITROUS_WORKER=1 for this isolated worker.");
  await withNitrousDb(async () => {
    checked(await admin().from("nitrous_config_versions").upsert([NITROUS_CONFIG, NITROUS_FAST_CONFIG].map(cfg => ({
      config_version: cfg.configVersion, strategy_version: cfg.version, management_version: cfg.managementVersion, config: cfg,
    })), { onConflict: "config_version" }));
    const state = checked(await admin().from("nitrous_public_state").select("setups").eq("id", 1).maybeSingle());
    market.publicSetups = Array.isArray(state?.setups) ? state.setups as Setup[] : [];
    console.log(`[nitrous] ${HOLDER} started; account activation is member-controlled.`);
    process.on("SIGTERM", () => { stopped = true; }); process.on("SIGINT", () => { stopped = true; });
    await Promise.all([analysisLoop(), accountLoop(), watchdog(), telegramTestLoop()]);
  });
}

if (process.env.NITROUS_WORKER_AUTOSTART !== "0") void main().catch((e) => { console.error(`[nitrous] ${problem(e)}`); process.exit(1); });
