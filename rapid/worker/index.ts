import { hostname } from "node:os";
import { DEFAULT_CONFIG, type RapidConfig } from "../config/defaults";
import type { Bar, Quote, Setup } from "../core/types";
import { admin, adminOrNull, beat, health, journal } from "../db";
import { buildSnapshot } from "../engine/snapshot";
import { findPivots } from "../engine/structure";
import { consume, startVisit, step, visitKey, type VisitRecord } from "../engine/visits";
import { GOLD_SESSION, isSessionOpen } from "../market/session";
import { atr } from "../market/bars";
import { dropForming, fetchBars } from "../market/twelvedata";
import { QuoteStream } from "../market/quotes";
import { withLease } from "../exec/leases";
import { reconcileAccount } from "../exec/reconcile";
import { executablePrice, preSubmissionGate } from "../exec/guards";
import { TradeLockerPort, type PortContext } from "../exec/tradelockerPort";
import { tagFor } from "../exec/ownership";
import { submitProtected } from "../exec/submit";
import { managePosition, type PositionRow } from "../manage/runner";
import { sizePosition } from "../risk/sizing";
import { freshToken, type RapidConnection } from "../broker/session";
import type { TLEnv } from "../broker/http";

/**
 * The Rapid worker.
 *
 * Structure, and why:
 *
 *   - ANALYSIS runs once for everybody. The market does not care whose account is connected, so the
 *     snapshot is account-independent and is built on a single cadence.
 *   - ACCOUNT WORK runs per account, under a fenced lease, in this order: reconcile, then manage,
 *     then consider an entry. Protection before profit before opportunity — if the pass runs out of
 *     time, the thing that got done was the thing that mattered.
 *   - The WATCHDOG is a separate one-second timer over feed age, lease health and worker liveness.
 *     A one-second heartbeat does not create a fresh quote and does not make the provider faster;
 *     it only notices when something has gone quiet.
 *
 * Restarting reconciles before it resumes. A process that comes back and starts sending orders
 * before it has asked the broker what it already has is how duplicate exposure happens.
 */

const HOLDER = `rapid-${hostname()}-${process.pid}`;
const LEASE_TTL_MS = Number(process.env.RAPID_LEASE_TTL_MS || 30_000);
const ANALYSIS_MS = Number(process.env.RAPID_ANALYSIS_MS || 5_000);
const ACCOUNT_MS = Number(process.env.RAPID_ACCOUNT_MS || 1_000);
const WATCHDOG_MS = Number(process.env.RAPID_WATCHDOG_MS || 1_000);
const BAR_REFRESH_MS = Number(process.env.RAPID_BAR_REFRESH_MS || 30_000);
const PROTECTION_DEADLINE_MS = Number(process.env.RAPID_PROTECTION_DEADLINE_MS || 8_000);

let shuttingDown = false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- Shared market state -----------------------------------------------------------------------
type MarketState = {
  m1: Bar[];
  barsAt: number;
  snapshot: ReturnType<typeof buildSnapshot> | null;
  snapshotAt: number;
};
const market: MarketState = { m1: [], barsAt: 0, snapshot: null, snapshotAt: 0 };
const visits = new Map<string, VisitRecord>();
const quoteStreams = new Map<string, QuoteStream>();

async function loadConfig(): Promise<RapidConfig> {
  const db = adminOrNull();
  if (!db) return DEFAULT_CONFIG;
  const { data } = await db.from("rapid_control").select("config_version").eq("id", 1).maybeSingle();
  const version = (data as { config_version?: string } | null)?.config_version;
  if (!version || version === DEFAULT_CONFIG.configVersion) return DEFAULT_CONFIG;
  const { data: row } = await db.from("rapid_config_versions").select("config").eq("config_version", version).maybeSingle();
  const cfg = (row as { config?: RapidConfig } | null)?.config;
  return cfg ?? DEFAULT_CONFIG;
}

type Control = { mode: "off" | "analyze_only" | "live"; entriesPaused: boolean; reason: string | null };
async function readControl(): Promise<Control> {
  const db = adminOrNull();
  if (!db) return { mode: "off", entriesPaused: true, reason: "no database" };
  const { data } = await db.from("rapid_control").select("mode, entries_paused, pause_reason").eq("id", 1).maybeSingle();
  const r = data as { mode?: string; entries_paused?: boolean; pause_reason?: string } | null;
  return {
    mode: (r?.mode as Control["mode"]) ?? "off",
    entriesPaused: r?.entries_paused !== false,
    reason: r?.pause_reason ?? null,
  };
}

// ---- Analysis ------------------------------------------------------------------------------------
async function analysisLoop(cfg: RapidConfig): Promise<void> {
  while (!shuttingDown) {
    const started = Date.now();
    try {
      if (Date.now() - market.barsAt > BAR_REFRESH_MS) {
        const r = await fetchBars("XAU/USD", 1, 5000);
        if (r.ok) {
          market.m1 = dropForming(r.bars, 1, Date.now());
          market.barsAt = Date.now();
        } else {
          await health("rapid-analysis", "degraded", { bars: r.error });
        }
      }
      if (market.m1.length) {
        const snap = buildSnapshot({
          asOf: Date.now(),
          cfg,
          tick: 0.01,
          contractSize: 100,
          minStopDistance: null,
          m1: market.m1,
          // The analysis snapshot is context. It carries NO executable quote, so it can never on its
          // own authorise an entry: account eligibility is evaluated separately, per account, on
          // that account's own feed.
          quote: null,
          priorZones: market.snapshot?.zones,
        });
        market.snapshot = snap;
        market.snapshotAt = Date.now();
        await persistSnapshot(snap);
      }
      await beat("rapid-analysis", { bars: market.m1.length, scenarios: market.snapshot?.scenarios.length ?? 0, passMs: Date.now() - started });
    } catch (e) {
      await health("rapid-analysis", "degraded", { error: String((e as Error)?.message ?? e) });
    }
    await sleep(Math.max(500, ANALYSIS_MS - (Date.now() - started)));
  }
}

async function persistSnapshot(snap: ReturnType<typeof buildSnapshot>): Promise<void> {
  const db = adminOrNull();
  if (!db) return;
  try {
    await db.from("rapid_snapshots").insert({
      snapshot_id: snap.snapshotId,
      strategy_version: snap.strategyVersion,
      config_version: snap.configVersion,
      generated_at: new Date(snap.generatedAt).toISOString(),
      market_event_time: new Date(snap.marketEventTime).toISOString(),
      feed_source: snap.feedSource,
      quote_age_ms: snap.quoteAgeMs,
      health: snap.health,
      regimes: snap.regimes,
      regime_conflict: snap.regimeConflict,
      payload: { scenarios: snap.scenarios, range: snap.range, rejections: snap.rejections.slice(0, 200), explanation: snap.deterministicExplanation },
    });
    const rows = snap.zones.map((z) => ({
      zone_id: z.id, version: z.version, parent_id: z.parentId, role: z.role, low: z.low, high: z.high,
      origin: z.origin, tier: z.tier, provenance: z.provenance, known_at: new Date(z.knownAt).toISOString(),
      role_since: new Date(z.roleSince).toISOString(), previous_role: z.previousRole,
      reactions: z.reactions, failed_stops: z.failedStops,
      invalidated_at: z.invalidatedAt ? new Date(z.invalidatedAt).toISOString() : null,
      invalid_reason: z.invalidReason, merged_from: z.mergedFrom,
    }));
    if (rows.length) await db.from("rapid_zone_versions").upsert(rows, { onConflict: "zone_id,version" });
  } catch {
    /* analysis persistence is best effort; the live decision does not depend on it */
  }
}

// ---- Account work ----------------------------------------------------------------------------------
type ArmedAccount = {
  id: string;
  user_id: string;
  connection_id: string;
  broker_account_id: string;
  acc_num: string;
  environment: TLEnv;
  automation_enabled: boolean;
  automation_version: number;
  management_enabled: boolean;
  risk_pct: number;
  allow_shared_account: boolean;
  status: string;
};

async function accountsToServe(): Promise<ArmedAccount[]> {
  const db = adminOrNull();
  if (!db) return [];
  // Accounts with an OPEN POSITION are served even when automation is off: turning automation off
  // stops new entries, it does not abandon a position that is already live.
  const { data } = await db
    .from("rapid_accounts")
    .select("id, user_id, connection_id, broker_account_id, acc_num, environment, automation_enabled, automation_version, management_enabled, risk_pct, allow_shared_account, status")
    .eq("status", "linked");
  const all = (data ?? []) as ArmedAccount[];
  if (!all.length) return [];
  const { data: open } = await db.from("rapid_positions").select("account_id").in("status", ["open", "closing"]);
  const withPositions = new Set((open ?? []).map((r) => (r as { account_id: string }).account_id));
  return all.filter((a) => a.automation_enabled || withPositions.has(a.id));
}

async function portFor(acct: ArmedAccount): Promise<{ ok: true; port: TradeLockerPort } | { ok: false; error: string }> {
  const db = admin();
  const { data } = await db.from("rapid_broker_connections").select("*").eq("id", acct.connection_id).maybeSingle();
  if (!data) return { ok: false, error: "connection row is missing" };
  const tok = await freshToken(data as RapidConnection);
  if (!tok.ok) return { ok: false, error: tok.error };
  const ctx: PortContext = { env: acct.environment, token: tok.token, accNum: acct.acc_num, accountId: acct.broker_account_id };
  return { ok: true, port: new TradeLockerPort(ctx) };
}

async function accountLoop(cfg: RapidConfig): Promise<void> {
  // Reconcile every served account BEFORE the first entry pass of this process's life.
  const bootstrapped = new Set<string>();

  while (!shuttingDown) {
    const started = Date.now();
    try {
      const control = await readControl();
      const accounts = control.mode === "off" ? [] : await accountsToServe();

      for (const acct of accounts) {
        if (shuttingDown) break;
        await withLease(acct.id, HOLDER, LEASE_TTL_MS, async (lease, stillOwned) => {
          const p = await portFor(acct);
          if (!p.ok) {
            await health("rapid-account", "degraded", { error: p.error }, acct.id);
            return;
          }
          if (!bootstrapped.has(acct.id)) {
            const rep = await reconcileAccount(acct.id, p.port);
            bootstrapped.add(acct.id);
            if (rep.blockers.length) await health("rapid-account", "blocked", { blockers: rep.blockers }, acct.id);
          }
          await manageAll(acct, p.port, cfg, stillOwned);
          if (control.mode === "live" && !control.entriesPaused && acct.automation_enabled && stillOwned()) {
            await considerEntry(acct, p.port, cfg, lease.fence, stillOwned);
          }
        });
      }
      await beat("rapid-accounts", { served: accounts.length, passMs: Date.now() - started });
    } catch (e) {
      await health("rapid-accounts", "degraded", { error: String((e as Error)?.message ?? e) });
    }
    await sleep(Math.max(200, ACCOUNT_MS - (Date.now() - started)));
  }
}

async function manageAll(acct: ArmedAccount, port: TradeLockerPort, cfg: RapidConfig, stillOwned: () => boolean): Promise<void> {
  const db = admin();
  const { data } = await db.from("rapid_positions").select("*").eq("account_id", acct.id).in("status", ["open", "closing"]);
  const rows = (data ?? []) as PositionRow[];
  if (!rows.length) return;

  const q = await port.quote();
  if (!q.ok) { await health("rapid-manage", "degraded", { quote: q.error }, acct.id); return; }
  const spec = await port.spec();
  if (!spec.ok) { await health("rapid-manage", "degraded", { spec: spec.error }, acct.id); return; }

  const m5 = market.snapshot ? (market.m1.length ? aggregateM5(market.m1) : []) : [];
  const pivots = findPivots(m5, "M5", cfg.structure.pivotLeft, cfg.structure.pivotRight);

  for (const row of rows) {
    if (!stillOwned()) return;
    const r = await managePosition(row, {
      port, bars: m5, pivots, asOf: Date.now(), tick: spec.spec.tickSize ?? 0.01,
      minStopDistance: spec.spec.minStopDistance ?? 0.1, bid: q.quote.bid, ask: q.quote.ask, cfg, stillOwned,
    });
    if (r.action !== "none") {
      await journal({ accountId: acct.id, userId: acct.user_id, stage: "manage", code: r.action, decision: r.ok ? "applied" : "failed", reason: r.detail });
    }
  }
}

function aggregateM5(m1: Bar[]): Bar[] {
  const ms = 300_000;
  const out: Bar[] = [];
  let cur: Bar | null = null;
  for (const b of m1) {
    const bucket = Math.floor(b.t / ms) * ms;
    if (!cur || cur.t !== bucket) { if (cur) out.push(cur); cur = { t: bucket, o: b.o, h: b.h, l: b.l, c: b.c }; }
    else { cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; }
  }
  if (cur && cur.t + ms <= Date.now()) out.push(cur);
  return out;
}

async function considerEntry(acct: ArmedAccount, port: TradeLockerPort, cfg: RapidConfig, fence: number, stillOwned: () => boolean): Promise<void> {
  const snap = market.snapshot;
  if (!snap || !snap.scenarios.length) return;
  if (!isSessionOpen(Date.now(), GOLD_SESSION)) return;

  const q = await port.quote();
  if (!q.ok) return;
  const stream = quoteStreams.get(acct.id) ?? new QuoteStream("broker", cfg.feed.reorderWindowMs);
  quoteStreams.set(acct.id, stream);
  stream.accept(q.quote);
  const quote: Quote = stream.current() ?? q.quote;
  const ageMs = stream.ageMs(Date.now()) ?? 0;

  const spec = await port.spec();
  if (!spec.ok) return;
  if (spec.missing.length) {
    await journal({ accountId: acct.id, stage: "entry", code: "spec_incomplete", decision: "skip", reason: `missing ${spec.missing.join(", ")}` });
    return;
  }

  const state = await port.accountState();
  const equity = state.ok ? state.equity : null;
  if (!equity) return;

  for (const setup of snap.scenarios) {
    if (!stillOwned()) return;
    const key = visitKey(`${acct.id}`, setup.parentId, setup.side);
    let visit = visits.get(key) ?? startVisit(key, Date.now(), setup.zoneVersion, setup.tolerances.rearmDistance);

    const executable = executablePrice(quote, setup.side, "entry");
    if (executable == null) continue;
    const distance = executable < setup.entryBandLow ? setup.entryBandLow - executable : executable > setup.entryBandHigh ? executable - setup.entryBandHigh : 0;
    const inBand = distance === 0;

    const flat = await accountFlat(acct.id);
    const advanced = step(visit, {
      now: Date.now(), price: executable, distanceToZone: distance, inBand, armable: inBand,
      expired: Date.now() >= setup.expiresAt, invalidReason: null, zoneVersion: setup.zoneVersion, flatAndReconciled: flat,
    });
    visit = advanced.visit;
    visits.set(key, visit);
    if (!advanced.triggered) continue;

    const gate = preSubmissionGate({
      now: Date.now(), setup, quote, quoteAgeMs: ageMs, spec: spec.spec, executable,
      currentZoneVersion: setup.zoneVersion, automationVersionAtDecision: acct.automation_version,
      automationVersionNow: acct.automation_version, automationEnabled: acct.automation_enabled,
      sessionOpen: true, newsBlocked: false, basisUnstable: false, signalAgeMs: 0, cfg,
    });
    if (!gate.ok) {
      await journal({ accountId: acct.id, userId: acct.user_id, visitId: visit.visitId, stage: "entry", code: gate.code, decision: "skip", reason: gate.reason });
      continue;
    }

    const size = sizePosition({
      side: setup.side, executable, stop: setup.stop, equity, riskPct: acct.risk_pct, spec: spec.spec,
      conversionRate: spec.spec.currency === (state.ok ? state.currency : null) ? 1 : null,
      remainingSessionRisk: await remainingSessionRisk(acct.id, equity, cfg), cfg,
    });
    if (!size.ok) {
      await journal({ accountId: acct.id, userId: acct.user_id, visitId: visit.visitId, stage: "entry", code: "sizing_blocked", decision: "skip", reason: size.reason, evidence: { blockers: size.blockers } });
      continue;
    }

    const intentKey = `${acct.id}|${setup.strategyVersion}|${setup.parentId}|${visit.visitId}`;
    const { data: reserved } = await admin().rpc("rapid_reserve_intent", {
      p_intent_key: intentKey, p_account: acct.id, p_user: acct.user_id, p_session: null,
      p_visit: visit.visitId, p_setup: setup.setupId, p_snapshot: snap.snapshotId,
      p_strategy: setup.strategyVersion, p_config: setup.configVersion, p_management: cfg.managementVersion,
      p_family: setup.family, p_side: setup.side, p_entry: executable, p_stop: setup.stop,
      p_target: setup.target, p_qty: size.qty, p_risk_pct: acct.risk_pct, p_estimated_risk: size.estimatedRisk,
      p_bid: quote.bid, p_ask: quote.ask, p_quote_age_ms: ageMs, p_spread: quote.ask - quote.bid,
      p_automation_version: acct.automation_version, p_fence: fence, p_broker_strategy_id: tagFor(intentKey),
    });
    const row = (Array.isArray(reserved) ? reserved[0] : reserved) as { intent_id: string | null; created: boolean; reason: string } | null;
    if (!row?.created || !row.intent_id) {
      await journal({ accountId: acct.id, visitId: visit.visitId, stage: "entry", code: "not_reserved", decision: "skip", reason: row?.reason ?? "reservation refused" });
      continue;
    }

    visit = consume(visit, Date.now(), intentKey);
    visits.set(key, visit);

    const approvedAt = Date.now();
    const outcome = await submitProtected({
      intentId: row.intent_id, intentKey, side: setup.side, qty: size.qty, stop: setup.stop, target: setup.target,
      strategyId: tagFor(intentKey), protectionDeadlineMs: PROTECTION_DEADLINE_MS,
      // Checked at the last possible instant: the lease must still be ours and the approval fresh.
      stillApproved: () => stillOwned() && Date.now() - approvedAt <= cfg.feed.maxSignalToSubmitMs,
      port,
      store: dbStore(acct, setup),
    });
    await journal({ accountId: acct.id, userId: acct.user_id, visitId: visit.visitId, intentId: row.intent_id, stage: "entry", code: outcome.state, decision: outcome.state, reason: "reason" in outcome ? outcome.reason : "filled and protected" });
    return; // One Rapid position per account: nothing else is considered this pass.
  }
}

function dbStore(acct: ArmedAccount, setup: Setup) {
  const db = admin();
  return {
    setState: async (intentId: string, state: string, patch?: Record<string, unknown>) => {
      await db.from("rapid_intents").update({ state, ...(patch ?? {}), updated_at: new Date().toISOString() }).eq("id", intentId);
    },
    recordBrokerEvent: async (intentId: string, e: Record<string, unknown>) => {
      await db.from("rapid_broker_events").insert({ intent_id: intentId, account_id: acct.id, ...e });
    },
    openPosition: async (intentId: string, p: { positionId: string; entry: number; qty: number; stop: number; target: number | null; protectionState: string }) => {
      await db.from("rapid_positions").insert({
        account_id: acct.id, user_id: acct.user_id, intent_id: intentId, broker_position_id: p.positionId,
        broker_strategy_id: setup.setupId, side: setup.side, strategy_version: setup.strategyVersion,
        config_version: setup.configVersion, management_version: DEFAULT_CONFIG.managementVersion,
        management_enabled: acct.management_enabled, risk_pct: acct.risk_pct, entry: p.entry,
        original_qty: p.qty, current_qty: p.qty, initial_stop: p.stop, current_stop: p.stop, target: p.target,
        atr_at_fill: setup.tolerances.atrEntry, cost_price: 0, protected_swing: setup.invalidation,
        protection_state: p.protectionState, best_price: p.entry, worst_price: p.entry,
      });
    },
  } as Parameters<typeof submitProtected>[0]["store"];
}

async function accountFlat(accountId: string): Promise<boolean> {
  const db = admin();
  const { count } = await db.from("rapid_positions").select("id", { count: "exact", head: true }).eq("account_id", accountId).in("status", ["open", "closing"]);
  return (count ?? 0) === 0;
}

async function remainingSessionRisk(accountId: string, equity: number, cfg: RapidConfig): Promise<number | null> {
  const db = admin();
  const { data } = await db.from("rapid_automation_sessions").select("session_start_equity, realised_pnl").eq("account_id", accountId).is("ended_at", null).maybeSingle();
  const s = data as { session_start_equity: number | null; realised_pnl: number | null } | null;
  const base = s?.session_start_equity ?? equity;
  const ceiling = base * (cfg.risk.sessionLossCeilingPct / 100);
  const lost = Math.max(0, -(s?.realised_pnl ?? 0));
  return Math.max(0, ceiling - lost);
}

// ---- Watchdog -----------------------------------------------------------------------------------------
async function watchdog(cfg: RapidConfig): Promise<void> {
  while (!shuttingDown) {
    const started = Date.now();
    try {
      const barsAge = market.barsAt ? Date.now() - market.barsAt : null;
      const snapAge = market.snapshotAt ? Date.now() - market.snapshotAt : null;
      const state: "ok" | "degraded" | "blocked" =
        !isSessionOpen(Date.now(), GOLD_SESSION) ? "blocked"
        : snapAge != null && snapAge > 5 * ANALYSIS_MS ? "degraded"
        : "ok";
      await beat("rapid-watchdog", { barsAge, snapAge, state, holder: HOLDER });
      if (state === "degraded") await health("rapid-watchdog", "degraded", { snapAge, barsAge });
    } catch {
      /* the watchdog never throws: it is the thing that notices, not the thing that fails */
    }
    void cfg;
    await sleep(Math.max(500, WATCHDOG_MS - (Date.now() - started)));
  }
}

// ---- Boot ------------------------------------------------------------------------------------------------
async function main(): Promise<void> {
  const cfg = await loadConfig();
  const control = await readControl();
  console.log(`[rapid] ${HOLDER} starting — strategy ${cfg.version}, config ${cfg.configVersion}, mode ${control.mode}, entries ${control.entriesPaused ? "PAUSED" : "enabled"}`);
  if (!cfg.liveEnabled) console.log("[rapid] the strategy feature flag is OFF: analysis runs, nothing executes.");

  process.on("SIGTERM", () => { shuttingDown = true; });
  process.on("SIGINT", () => { shuttingDown = true; });
  process.on("unhandledRejection", (e) => console.error("[rapid] unhandled rejection", e));
  process.on("uncaughtException", (e) => { console.error("[rapid] uncaught", e); process.exit(1); });

  await Promise.all([analysisLoop(cfg), accountLoop(cfg), watchdog(cfg)]);
  console.log("[rapid] stopped cleanly");
  process.exit(0);
}

void atr;
if (process.env.RAPID_WORKER_AUTOSTART !== "0") {
  void main().catch((e) => { console.error("[rapid] fatal", e); process.exit(1); });
}
