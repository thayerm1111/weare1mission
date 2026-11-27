import type { Bar, FrozenTolerances, Regime, RejectionCode, Setup, Side, Timeframe, Zone } from "../rapid/core/types";
import { roundOutward } from "../rapid/core/decimal";
import type { BuildResult, EngineContext } from "../rapid/engine/setups";
import { stopWithinCap } from "../rapid/engine/stops";
import { buildCostModel, costRatio, netRewardRisk, planTarget } from "../rapid/engine/targets";
import { freezeTolerances } from "../rapid/engine/tolerances";
import { makeZone, targetObstacles } from "../rapid/engine/zones";
import { atr, bodyRatio, closePosition, TF_MS } from "../rapid/market/bars";
import { NITROUS_AGGRESSIVE_CONFIG as cfg } from "./config";

type Family = "range_edge_rejection" | "compression_breakout";
type Evidence = NonNullable<Setup["aggressiveEvidence"]>;
type Bounds = { low: number; high: number; lowTime: number; highTime: number };

const MS = TF_MS.M5;
const lookback: Record<Family, number> = { range_edge_rejection: 24, compression_breakout: 6 };
const families: Family[] = ["range_edge_rejection", "compression_breakout"];
const positive = (v: number) => Number.isFinite(v) && v > 0;
const validBar = (b: Bar) => Number.isSafeInteger(b.t) && b.t > 0 && b.t % MS === 0
  && [b.o, b.h, b.l, b.c].every(positive) && b.h >= Math.max(b.o, b.c) && b.l <= Math.min(b.o, b.c);

export function aggressiveRegimeEligible(family: Setup["family"], side: Side, regimes: Record<Timeframe, Regime>): boolean {
  if (family === "range_edge_rejection") return regimes.H1 === "sideways" && regimes.M15 === "sideways";
  if (family !== "compression_breakout") return false;
  const direction = side === "buy" ? "up" : "down";
  return [regimes.H1, regimes.M15].every(regime => regime === direction || regime === "sideways");
}

function bounds(box: Bar[]): Bounds {
  const lo = box.reduce((a, b) => b.l < a.l ? b : a);
  const hi = box.reduce((a, b) => b.h > a.h ? b : a);
  return { low: lo.l, high: hi.h, lowTime: lo.t, highTime: hi.t };
}

// The confirmation candle is the second test. A cluster sitting on an edge cannot
// create another visit: a later completed candle must first close back toward the center.
function departedFromEdge(box: Bar[], edges: Bounds, cushion: number, buy: boolean): boolean {
  const width = edges.high - edges.low;
  let touched = false, departed = false;
  for (const candle of box) {
    const onEdge = buy ? candle.l <= edges.low + cushion : candle.h >= edges.high - cushion;
    if (onEdge) {
      touched = true;
      departed = false;
    } else if (touched && (buy ? candle.c >= edges.low + width * .35 : candle.c <= edges.high - width * .35)) {
      departed = true;
    }
  }
  return departed;
}

function edgeCushion(width: number, tol: FrozenTolerances): number {
  return Math.min(width * .12, Math.max(tol.touchTolerance, tol.atrEntry * .4));
}

function signalCandle(family: Family, side: Side, b: Bar, edges: Pick<Bounds, "low" | "high">, tol: FrozenTolerances): boolean {
  const buy = side === "buy", d = buy ? 1 : -1, width = edges.high - edges.low;
  if (width <= 0 || b.o < edges.low || b.o > edges.high || d * (b.c - b.o) <= 0) return false;
  const closeAt = closePosition(b);
  if (buy ? closeAt < .68 : closeAt > .32) return false;
  if (family === "compression_breakout") {
    const advance = buy ? b.c - edges.high : edges.low - b.c;
    return width <= 2.25 * tol.atrEntry && bodyRatio(b) >= .55 && Math.abs(b.c - b.o) >= .6 * tol.atrEntry
      && advance > tol.breakBuffer && advance <= 1.25 * tol.atrEntry;
  }
  const cushion = edgeCushion(width, tol);
  const toEdge = buy ? b.l - edges.low : edges.high - b.h;
  const inside = buy ? b.c - edges.low : edges.high - b.c;
  const wick = buy ? Math.min(b.o, b.c) - b.l : b.h - Math.max(b.o, b.c);
  return toEdge <= cushion && toEdge >= -tol.breakBuffer && inside >= Math.max(cushion, .2 * tol.atrEntry) && inside <= width * .4
    && wick >= .2 * (b.h - b.l);
}

function pricePattern(family: Family, side: Side, box: Bar[], b: Bar, edges: Bounds, tol: FrozenTolerances): boolean {
  if (!signalCandle(family, side, b, edges, tol)) return false;
  if (family === "compression_breakout") return true;
  const width = edges.high - edges.low, cushion = edgeCushion(width, tol);
  // Both edges are observed highs/lows from this pre-signal box.
  return departedFromEdge(box, edges, cushion, side === "buy");
}

// Freeze volatility from BEFORE the box. A large trigger candle cannot turn its own lead-in
// into a compression or widen its own allowable breakout distance.
function patternWindow(bars: Bar[], family: Family) {
  const count = lookback[family], warm = cfg.structure.atrPeriod + 1;
  const needed = count + warm + 1;
  const recent = bars.slice(-needed);
  if (recent.length !== needed || recent.some((b, i) => !validBar(b) || i > 0 && b.t !== recent[i - 1].t + MS)) return null;
  const baseline = atr(recent.slice(0, warm), cfg.structure.atrPeriod);
  if (!baseline || !positive(baseline)) return null;
  const box = recent.slice(warm, -1);
  return { b: recent[needed - 1], box, edges: bounds(box), baseline };
}

function edgeOf(family: Family, side: Side, edges: Bounds) {
  const low = (family === "range_edge_rejection") === (side === "buy");
  const time = low ? edges.lowTime : edges.highTime;
  return { time, id: `sw:M5:${low ? "low" : "high"}:${time}` };
}

function invalidation(family: Family, side: Side, b: Bar, low: number, high: number): number {
  if (side === "buy") return Math.min(b.l, family === "compression_breakout" ? high : low);
  return Math.max(b.h, family === "compression_breakout" ? low : high);
}

/** The range fade's target must also fit BEFORE the opposite edge of its observed box. */
function oppositeEdge(side: Side, edges: Bounds, at: number): Zone {
  const buy = side === "buy", price = buy ? edges.high : edges.low;
  const id = `nitrous:box-wall:${buy ? "high" : "low"}:${buy ? edges.highTime : edges.lowTime}`;
  return makeZone({ role: buy ? "resistance" : "support", low: price, high: price, origin: "M5", tier: "execution",
    knownAt: at, provenance: { kind: "range_boundary", rangeId: id, which: buy ? "upper" : "lower" } }, id, id, at);
}

export function buildAggressivePatterns(ctx: EngineContext, onPriceWait?: (setup: Setup) => void): BuildResult {
  const out: BuildResult = { setups: [], rejections: [] };
  if (!ctx.executionTimeframes.includes("M5")) return out;
  const bars = (ctx.bars.M5 ?? []).filter(b => b.t + MS <= ctx.asOf);
  for (const family of families) {
    const reject = (code: RejectionCode, detail: string, zoneId?: string) => {
      out.rejections.push({ at: ctx.asOf, stage: `aggressive:${family}`, family, code, detail, zoneId });
    };
    const window = patternWindow(bars, family);
    if (bars.length < cfg.feed.warmupBars || !window) { reject("warmup", "Waiting for consecutive completed M5 candles and a pre-range ATR."); continue; }
    const { box, edges, b, baseline } = window;
    const closedAt = b.t + MS;
    if (ctx.asOf <= closedAt || ctx.asOf >= closedAt + MS) {
      reject(ctx.asOf <= closedAt ? "forming_candle" : "expired", "Entry is available only during the M5 candle after confirmation."); continue;
    }
    if (!positive(ctx.refPrice) || !positive(ctx.tick) || !Number.isFinite(ctx.spread) || ctx.spread < 0) {
      reject("stale_quote", "A valid reference price, tick and spread are required."); continue;
    }
    const tol = freezeTolerances(baseline, ctx.spread, ctx.tick, cfg);
    const side: Side = b.c > b.o ? "buy" : "sell";
    if (!pricePattern(family, side, box, b, edges, tol)) {
      reject("not_fresh_visit", family === "range_edge_rejection" ? "Waiting for price to move away and reject the same range edge on its return." : "Waiting for a directional close out of a tight half-hour range."); continue;
    }
    const edge = edgeOf(family, side, edges);
    const history = ctx.zoneHistory ?? ctx.zones;
    const zone = history.find(z => z.id === edge.id) ?? history.find(z => z.mergedFrom.includes(edge.id));
    const parentId = zone?.parentId ?? edge.id, zoneId = zone?.id ?? edge.id;
    if (zone && (zone.invalidatedAt != null || zone.failedStops >= cfg.range.maxFailedStopsPerZone || zone.knownAt > ctx.asOf)) {
      reject(zone.invalidatedAt != null ? "zone_expired" : "zone_suspended", "The structural edge is no longer eligible.", zoneId); continue;
    }
    const buy = side === "buy", d = buy ? 1 : -1;
    const invalid = invalidation(family, side, b, edges.low, edges.high);
    const stopDistance = Math.max(d * (b.c - invalid) + tol.stopBuffer, ctx.minStopDistance ?? 0);
    const stop = roundOutward(b.c - d * stopDistance, ctx.tick, buy ? -1 : 1);
    const stopUsd = d * (b.c - stop);
    if (!positive(stopUsd) || !stopWithinCap(stopUsd, cfg).ok) { reject("stop_too_wide", "The full structural stop exceeds the allowed distance.", zoneId); continue; }
    const obstacles = targetObstacles(ctx.zones, ctx.asOf);
    if (family === "range_edge_rejection") obstacles.push(oppositeEdge(side, edges, b.t));
    const { plan, reason } = planTarget(side, b.c, obstacles, [parentId], ctx.spread, ctx.tick, cfg);
    if (!plan || plan.distance < cfg.target.minUsd) { reject("target_room_short", reason, zoneId); continue; }
    if (ctx.spread > cfg.risk.maxSpreadUsd || ctx.spread / plan.distance > cfg.risk.maxSpreadToTargetRatio) {
      reject("spread_too_wide", "The spread exceeds the absolute or target-relative limit.", zoneId); continue;
    }
    const costs = buildCostModel(ctx.spread, ctx.tick, ctx.contractSize, cfg);
    if (costRatio(plan.distance, costs) > cfg.risk.maxCostToTargetRatio) { reject("cost_too_high", "The cost allowance is too large for the target.", zoneId); continue; }
    const rr = netRewardRisk(side, b.c, stop, plan.target, costs);
    if (rr < cfg.target.minNetRewardRisk) { reject("reward_risk_short", "Insufficient reward after modeled costs.", zoneId); continue; }
    const entryBandLow = b.c - tol.touchTolerance, entryBandHigh = b.c + tol.touchTolerance;
    if (d * (ctx.refPrice - invalid) <= 0 || d * (plan.target - ctx.refPrice) <= 0 || (buy ? entryBandLow <= invalid || entryBandHigh >= plan.target : entryBandHigh >= invalid || entryBandLow <= plan.target)) {
      reject("outside_band", "The executable area must still be close to confirmation and clear of invalidation and target.", zoneId); continue;
    }
    const aggressiveEvidence: Evidence = { candleOpenedAt: b.t, candleClosedAt: closedAt, rangeLow: edges.low, rangeHigh: edges.high,
      rangeStartedAt: box[0].t, rangeEndedAt: b.t, edgeTime: edge.time, candleOpen: b.o, candleHigh: b.h, candleLow: b.l, candleClose: b.c };
    const setup: Setup = { setupId: `nitrous:${family}:${edge.id}:${closedAt}`, visitId: "", configVersion: cfg.configVersion, strategyVersion: cfg.version,
      family, side, state: "watching", timeframe: "M5", zoneId, zoneVersion: zone?.version ?? 1, parentId, createdAt: ctx.asOf, stateAt: ctx.asOf,
      expiresAt: closedAt + MS, tolerances: tol, entryBandLow, entryBandHigh, invalidation: invalid, stop, stopUsd,
      refEntry: b.c, target: plan.target, targetUsd: plan.distance, opposingLevelId: plan.obstacle?.zoneId ?? null,
      opposingPrice: plan.obstacle?.price ?? null, breakEvidence: null, aggressiveEvidence, transitions: [],
      conditionsMet: [family === "range_edge_rejection" ? "Price left a previously tested edge, returned and closed back inside the two-hour range." : "The M5 impulse closed beyond the preceding six-candle compression.",
        `Observed range ${edges.low.toFixed(2)}–${edges.high.toFixed(2)}; confirmation close ${b.c.toFixed(2)}. Net reward/risk ${rr.toFixed(2)}.`],
      conditionsPending: ["The broker must still quote inside the entry band with sufficient room, margin and risk allowance."] };
    if (ctx.refPrice < entryBandLow || ctx.refPrice > entryBandHigh) {
      reject("outside_band", "Reference price is outside the frozen confirmation-close entry band.", zoneId);
      onPriceWait?.(setup);
      continue;
    }
    out.setups.push(setup);
  }
  return out;
}

/** Validate a frozen public snapshot without inferring missing historical evidence. */
export function aggressiveEvidenceSane(s: Setup): boolean {
  const e = s.aggressiveEvidence;
  if (!e || (s.family !== "compression_breakout" && s.family !== "range_edge_rejection") || s.configVersion !== cfg.configVersion || s.timeframe !== "M5"
    || (s.side !== "buy" && s.side !== "sell") || !s.tolerances || ![e.rangeLow, e.rangeHigh, e.rangeStartedAt, e.rangeEndedAt, e.edgeTime, s.refEntry, s.stop, s.target, s.tolerances.atrEntry, s.tolerances.touchTolerance, s.tolerances.breakBuffer].every(positive)) return false;
  const b = { t: e.candleOpenedAt, o: e.candleOpen, h: e.candleHigh, l: e.candleLow, c: e.candleClose };
  const buy = s.side === "buy", d = buy ? 1 : -1;
  const edges = { low: e.rangeLow, high: e.rangeHigh };
  if (!validBar(b) || !signalCandle(s.family, s.side, b, edges, s.tolerances)
    || e.rangeEndedAt !== b.t || e.rangeStartedAt !== b.t - lookback[s.family] * MS
    || e.edgeTime % MS !== 0 || e.edgeTime < e.rangeStartedAt || e.edgeTime >= b.t
    || e.candleClosedAt !== b.t + MS || s.expiresAt !== e.candleClosedAt + MS
    || !Number.isFinite(s.createdAt) || s.createdAt <= e.candleClosedAt || s.createdAt >= s.expiresAt
    || s.refEntry !== b.c || s.invalidation !== invalidation(s.family, s.side, b, e.rangeLow, e.rangeHigh)
    || s.entryBandLow !== b.c - s.tolerances.touchTolerance || s.entryBandHigh !== b.c + s.tolerances.touchTolerance
    || d * (s.invalidation - s.stop) <= 0 || (buy ? s.entryBandLow <= s.invalidation || s.target <= s.entryBandHigh : s.entryBandHigh >= s.invalidation || s.target >= s.entryBandLow)) return false;
  return s.family === "compression_breakout" || (buy ? s.target < e.rangeHigh : s.target > e.rangeLow);
}

/** Immediately before account entry, reconstruct the box and the trigger from closed candles. */
export function aggressiveTriggerConfirmed(s: Setup, bars: Bar[], now: number): boolean {
  if (!aggressiveEvidenceSane(s) || !Number.isFinite(now) || s.createdAt > now || now >= s.expiresAt) return false;
  const e = s.aggressiveEvidence!;
  const family = s.family as Family;
  const window = patternWindow(bars.filter(b => b.t + MS <= now), family);
  if (!window) return false;
  const { box, edges, b, baseline } = window;
  return b.t === e.candleOpenedAt && b.o === e.candleOpen && b.h === e.candleHigh && b.l === e.candleLow && b.c === e.candleClose
    && e.rangeLow === edges.low && e.rangeHigh === edges.high && e.edgeTime === edgeOf(family, s.side, edges).time
    && baseline === s.tolerances.atrEntry && pricePattern(family, s.side, box, b, edges, s.tolerances);
}
