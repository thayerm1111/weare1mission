import type { Bar, Health, MarketSnapshot, Pivot, Quote, Regime, Timeframe, ValidatedRange, Zone } from "../core/types";
import { mid, spreadOf } from "../core/types";
import { TF_MS, atr } from "../market/bars";
import { GOLD_SESSION, type SessionConfig, sessionState, splitSessionDays, tradingDay, tradingWeek } from "../market/session";
import { findPivots } from "./structure";
import { classifyRegime } from "./structure";
import { collectReactions, eligibleZones, expireStaleZones, makeZone, mergeZones, seedFromLine, seedFromPivot } from "./zones";
import { validateRange } from "./range";
import { arbitrate } from "./arbitration";
import { buildSetups, type EngineContext } from "./setups";
import type { RapidConfig } from "../config/defaults";

/**
 * ONE decision core.
 *
 * Analyze, replay, signal generation and automation all call this same function with the same typed
 * inputs, so what the user is shown is what the engine would act on. Nothing in here touches the
 * network, a database, a clock it was not given, or an LLM. Given identical inputs it returns an
 * identical snapshot — that property is what makes the replay harness worth anything.
 */

export type SnapshotInput = {
  /** Decision time. Nothing with a later knownAt may be used. */
  asOf: number;
  cfg: RapidConfig;
  tick: number;
  contractSize: number | null;
  minStopDistance: number | null;
  /** 1-minute bars from the execution-authoritative source, oldest first. */
  m1: Bar[];
  /** Higher-timeframe bars, supplied where the caller has them; otherwise aggregated from m1. */
  higher?: Partial<Record<Timeframe, Bar[]>>;
  /** The executable quote. Absent means Analyze-only: context is shown, execution stays blocked. */
  quote: Quote | null;
  /** Zones carried over from the previous snapshot, so lifecycle and reaction history survive. */
  priorZones?: Zone[];
  session?: SessionConfig;
};

const ALL_TFS: Timeframe[] = ["M5", "M15", "H1", "H4", "D1"];
const EXECUTION_TFS: Timeframe[] = ["M5", "M15"];

let snapSeq = 0;

export function buildSnapshot(inp: SnapshotInput): MarketSnapshot {
  const cfg = inp.cfg;
  const session = inp.session ?? GOLD_SESSION;
  const asOf = inp.asOf;

  // ---- Bars per timeframe, closed only. ------------------------------------------------------
  const bars: Partial<Record<Timeframe, Bar[]>> = {};
  for (const tf of ALL_TFS) {
    const supplied = inp.higher?.[tf];
    bars[tf] = supplied ? supplied.filter((b) => b.t + TF_MS[tf] <= asOf) : aggregateClosed(inp.m1, tf, asOf);
  }

  // ---- Pivots and ATR. -----------------------------------------------------------------------
  const pivots: Partial<Record<Timeframe, Pivot[]>> = {};
  const atrs: Partial<Record<Timeframe, number>> = {};
  for (const tf of ALL_TFS) {
    const b = bars[tf] ?? [];
    pivots[tf] = findPivots(b, tf, cfg.structure.pivotLeft, cfg.structure.pivotRight).filter((p) => p.knownAt <= asOf);
    const a = atr(b, cfg.structure.atrPeriod);
    if (a != null) atrs[tf] = a;
  }

  // ---- Zones: build, carry forward, merge, age. -----------------------------------------------
  const zones = buildZones(inp, bars, pivots, atrs, asOf, session);

  // ---- Regimes, and whether the timeframes disagree. -------------------------------------------
  const regimes = {} as Record<Timeframe, Regime>;
  for (const tf of ALL_TFS) {
    regimes[tf] = classifyRegime(bars[tf] ?? [], pivots[tf] ?? [], asOf, {
      atrPeriod: cfg.structure.atrPeriod,
      noiseTicks: cfg.structure.noiseTicks,
      noiseAtrMult: cfg.structure.noiseAtrMult,
      tickSize: inp.tick,
      minSwingsPerSide: cfg.structure.minSwingsPerSide,
    }).regime;
  }
  regimes.W1 = regimes.W1 ?? "unknown";
  const directional = ALL_TFS.map((t) => regimes[t]).filter((r) => r === "up" || r === "down");
  const regimeConflict = new Set(directional).size > 1;

  // ---- Health. ---------------------------------------------------------------------------------
  const quoteAgeMs = inp.quote ? Math.max(0, asOf - (inp.quote.providerTs ?? inp.quote.receivedAt)) : null;
  const health = assessHealth(inp, bars, quoteAgeMs, asOf, session, cfg);

  // ---- Range validation on the execution timeframes. --------------------------------------------
  let range: ValidatedRange | null = null;
  for (const tf of EXECUTION_TFS) {
    const a = atrs[tf];
    if (!a) continue;
    const r = validateRange(bars[tf] ?? [], zones, tf, asOf, a, cfg);
    if (r.range) { range = r.range; break; }
  }

  // ---- Candidates. -------------------------------------------------------------------------------
  const refPrice = inp.quote ? mid(inp.quote) : lastClose(bars) ?? 0;
  const spread = inp.quote ? spreadOf(inp.quote) : 0;

  const ctx: EngineContext = {
    asOf,
    tick: inp.tick,
    bars,
    pivots,
    atr: atrs,
    zones: eligibleZones(zones, asOf, cfg.range.maxFailedStopsPerZone),
    range,
    refPrice,
    spread,
    minStopDistance: inp.minStopDistance,
    contractSize: inp.contractSize,
    executionTimeframes: EXECUTION_TFS,
    cfg,
  };

  const built = buildSetups(ctx);
  const { selected, dropped } = arbitrate(built.setups, regimes.D1);
  for (const d of dropped) {
    built.rejections.push({ at: asOf, stage: "arbitration", code: "arbitration_lost", detail: d.reason, family: d.setup.family, zoneId: d.setup.zoneId });
  }

  // At most the best long and the best short are surfaced, each clearly conditional.
  const bestLong = selected.find((s) => s.side === "buy") ?? null;
  const bestShort = selected.find((s) => s.side === "sell") ?? null;
  const scenarios = [bestLong, bestShort].filter((s): s is NonNullable<typeof s> => s != null);

  return {
    snapshotId: `snap:${asOf}:${(snapSeq = (snapSeq + 1) % 1_000_000).toString(36)}`,
    strategyVersion: cfg.version,
    configVersion: cfg.configVersion,
    generatedAt: asOf,
    marketEventTime: inp.quote ? (inp.quote.providerTs ?? inp.quote.receivedAt) : (lastBarTime(bars) ?? asOf),
    feedSource: inp.quote?.source ?? "reference",
    quoteAgeMs,
    health,
    regimes,
    regimeConflict,
    zones,
    range,
    scenarios,
    rejections: built.rejections,
    deterministicExplanation: explain(regimes, regimeConflict, range, scenarios, health, built.rejections.length),
  };
}

// -------------------------------------------------------------------------------------------------

function aggregateClosed(m1: Bar[], tf: Timeframe, asOf: number): Bar[] {
  const ms = TF_MS[tf];
  const out: Bar[] = [];
  let cur: Bar | null = null;
  for (const b of m1) {
    const bucket = Math.floor(b.t / ms) * ms;
    if (!cur || cur.t !== bucket) {
      if (cur) out.push(cur);
      cur = { t: bucket, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v ?? null };
    } else {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
    }
  }
  if (cur) out.push(cur);
  // A forming bucket is never returned: it has not closed, so nothing may treat it as if it had.
  return out.filter((b) => b.t + ms <= asOf);
}

function lastClose(bars: Partial<Record<Timeframe, Bar[]>>): number | null {
  const m5 = bars.M5;
  return m5 && m5.length ? m5[m5.length - 1].c : null;
}

function lastBarTime(bars: Partial<Record<Timeframe, Bar[]>>): number | null {
  const m5 = bars.M5;
  return m5 && m5.length ? m5[m5.length - 1].t + TF_MS.M5 : null;
}

/**
 * Build the level map.
 *
 * Primary levels: confirmed H1/H4 swings, prior COMPLETED daily high/low lines, prior completed
 * weekly high/low zones. The developing session's extremes are tracked separately and are NOT
 * automatic entry anchors — a level that moves every time price makes a new high is not a level.
 *
 * Execution levels: confirmed M5/M15 swing zones. These are what make the "trends within the trend"
 * entries possible, and they are also what would turn every candle into a level if they were allowed
 * to cap targets, which is why only twice-reacted ones ever do.
 */
function buildZones(
  inp: SnapshotInput,
  bars: Partial<Record<Timeframe, Bar[]>>,
  pivots: Partial<Record<Timeframe, Pivot[]>>,
  atrs: Partial<Record<Timeframe, number>>,
  asOf: number,
  session: SessionConfig,
): Zone[] {
  const cfg = inp.cfg;
  const carried = (inp.priorZones ?? []).map((z) => ({ ...z, reactions: [...z.reactions] }));
  const known = new Set(carried.map((z) => z.id));
  const fresh: Zone[] = [];

  const add = (seed: ReturnType<typeof seedFromPivot> | ReturnType<typeof seedFromLine> | null, id: string) => {
    if (!seed || known.has(id)) return;
    known.add(id);
    fresh.push(makeZone(seed, id, id, asOf));
  };

  for (const tf of ["H1", "H4"] as Timeframe[]) {
    const b = bars[tf] ?? [];
    for (const p of pivots[tf] ?? []) {
      add(seedFromPivot(b, p, inp.tick, cfg.zones.minWidthTicks, "primary"), `sw:${tf}:${p.kind}:${p.t}`);
    }
  }
  for (const tf of ["M5", "M15"] as Timeframe[]) {
    const b = bars[tf] ?? [];
    for (const p of pivots[tf] ?? []) {
      add(seedFromPivot(b, p, inp.tick, cfg.zones.minWidthTicks, "execution"), `sw:${tf}:${p.kind}:${p.t}`);
    }
  }

  // Prior COMPLETED session day and week extremes. The developing day is deliberately excluded.
  const days = splitSessionDays(bars.M5 ?? [], asOf, session);
  const priorDay = days.completed[days.completed.length - 1];
  if (priorDay && priorDay.bars.length) {
    const hi = Math.max(...priorDay.bars.map((b) => b.h));
    const lo = Math.min(...priorDay.bars.map((b) => b.l));
    const knownAt = priorDay.bars[priorDay.bars.length - 1].t + TF_MS.M5;
    add(seedFromLine(hi, "resistance", "D1", { kind: "prior_day", day: priorDay.day, which: "high" }, knownAt, inp.tick, cfg.zones.minWidthTicks), `pd:${priorDay.day}:high`);
    add(seedFromLine(lo, "support", "D1", { kind: "prior_day", day: priorDay.day, which: "low" }, knownAt, inp.tick, cfg.zones.minWidthTicks), `pd:${priorDay.day}:low`);
  }
  const thisWeek = tradingWeek(asOf, session);
  const priorWeekBars = (bars.M5 ?? []).filter((b) => tradingWeek(b.t, session) !== thisWeek);
  if (priorWeekBars.length) {
    const lastWeek = tradingWeek(priorWeekBars[priorWeekBars.length - 1].t, session);
    const wb = priorWeekBars.filter((b) => tradingWeek(b.t, session) === lastWeek);
    const hi = Math.max(...wb.map((b) => b.h));
    const lo = Math.min(...wb.map((b) => b.l));
    const knownAt = wb[wb.length - 1].t + TF_MS.M5;
    add(seedFromLine(hi, "resistance", "W1", { kind: "prior_week", week: lastWeek, which: "high" }, knownAt, inp.tick, cfg.zones.minWidthTicks), `pw:${lastWeek}:high`);
    add(seedFromLine(lo, "support", "W1", { kind: "prior_week", week: lastWeek, which: "low" }, knownAt, inp.tick, cfg.zones.minWidthTicks), `pw:${lastWeek}:low`);
  }
  void tradingDay;

  let all = [...carried, ...fresh];

  // Completed reactions, recomputed against the current geometry.
  for (const z of all) {
    const tf: Timeframe = z.tier === "execution" ? (z.origin === "M15" ? "M15" : "M5") : "M15";
    const a = atrs[tf] ?? 0;
    const separation = Math.max(cfg.range.separationUsd, cfg.range.separationAtrMult * a);
    z.reactions = collectReactions(bars[tf] ?? [], z, separation, tf, asOf);
  }

  all = mergeZones(all, atrs, cfg.zones.mergeAtrMult);
  all = expireStaleZones(all, asOf, cfg.zones.executionExpiryBars, cfg.zones.primaryExpiryBars);
  return all;
}

function assessHealth(
  inp: SnapshotInput,
  bars: Partial<Record<Timeframe, Bar[]>>,
  quoteAgeMs: number | null,
  asOf: number,
  session: SessionConfig,
  cfg: RapidConfig,
): Health {
  const reasons: string[] = [];
  const warmup: Health["warmup"] = {};
  let state: Health["state"] = "ok";

  for (const tf of EXECUTION_TFS) {
    const have = (bars[tf] ?? []).length;
    const need = cfg.feed.warmupBars;
    warmup[tf] = { have, need, ready: have >= need };
    if (have < need) {
      reasons.push(`${tf} warming up: ${have}/${need} closed bars`);
      state = "blocked";
    }
  }
  // Missing DAILY context may display Unknown without blocking a fully initialised local setup.
  const d1 = (bars.D1 ?? []).length;
  if (d1 < 3) reasons.push("daily context unknown (fewer than 3 completed session days)");

  const ss = sessionState(asOf, session);
  if (!ss.open) {
    reasons.push(`market closed: ${ss.reason}`);
    state = "blocked";
  }

  if (!inp.quote) {
    reasons.push("no executable broker quote: Analyze only, execution unavailable");
    if (state === "ok") state = "degraded";
  } else if (quoteAgeMs != null && quoteAgeMs > cfg.feed.maxQuoteAgeMs) {
    reasons.push(`feed age ${quoteAgeMs}ms exceeds the ${cfg.feed.maxQuoteAgeMs}ms execution ceiling`);
    if (state === "ok") state = "degraded";
  }

  return { state, reasons, quoteAgeMs, warmup };
}

function explain(
  regimes: Record<Timeframe, Regime>,
  conflict: boolean,
  range: ValidatedRange | null,
  scenarios: MarketSnapshot["scenarios"],
  health: Health,
  rejected: number,
): string {
  const parts: string[] = [];
  parts.push(`Daily ${regimes.D1}, 4H ${regimes.H4}, 1H ${regimes.H1}, 15m ${regimes.M15}, 5m ${regimes.M5}.`);
  if (conflict) parts.push("Timeframes disagree on direction.");
  parts.push(range ? `Validated range ${range.lower.low.toFixed(2)}-${range.upper.high.toFixed(2)} with ${range.room.toFixed(2)} of room.` : "No validated range.");
  if (!scenarios.length) parts.push(`No qualifying setup right now (${rejected} candidate checks did not pass).`);
  for (const s of scenarios) {
    parts.push(
      `${s.side === "buy" ? "Long" : "Short"} ${s.family.replace(/_/g, " ")}: entry band ${s.entryBandLow.toFixed(2)}-${s.entryBandHigh.toFixed(2)}, stop ${s.stop.toFixed(2)} (${s.stopUsd.toFixed(2)}), target ${s.target.toFixed(2)} (${s.targetUsd.toFixed(2)}). Still needed: ${s.conditionsPending.join("; ") || "nothing"}.`,
    );
  }
  if (health.state !== "ok") parts.push(`Health ${health.state}: ${health.reasons.join("; ")}.`);
  return parts.join(" ");
}
