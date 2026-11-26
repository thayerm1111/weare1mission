import type { Bar, Pivot, RejectionCode, Setup, Side, SweepEvidence, Timeframe, Zone } from "../rapid/core/types";
import { roundOutward } from "../rapid/core/decimal";
import { TF_MS, closePosition } from "../rapid/market/bars";
import type { BuildResult, EngineContext } from "../rapid/engine/setups";
import { stopWithinCap } from "../rapid/engine/stops";
import { freezeTolerances } from "../rapid/engine/tolerances";
import { buildCostModel, costRatio, netRewardRisk, planTarget } from "../rapid/engine/targets";
import { targetObstacles } from "../rapid/engine/zones";
import { NITROUS_SWEEP_CONFIG } from "./config";

const ENTRY_TIMEFRAMES = ["M5", "M15"] as const;
const positive = (value: number): boolean => Number.isFinite(value) && value > 0;
const validBar = (bar: Bar): boolean => [bar.t, bar.o, bar.h, bar.l, bar.c].every(positive)
  && bar.h >= Math.max(bar.o, bar.c) && bar.l <= Math.min(bar.o, bar.c);
const pivotId = (pivot: Pivot): string => `sw:${pivot.timeframe}:${pivot.kind}:${pivot.t}`;

function parentZone(zones: readonly Zone[], pivot: Pivot): Zone | undefined {
  const id = pivotId(pivot);
  // Preserve existing economic-level identity, including a pivot absorbed into a merged zone.
  return zones.find(z => z.id === id) ?? zones.find(z => z.mergedFrom.includes(id))
    ?? zones.find(z => z.provenance.kind === "swing" && z.provenance.timeframe === pivot.timeframe && z.provenance.pivotT === pivot.t);
}

/**
 * Nitrous-only, proposed initial sweep/reclaim rules. These parameters are not optimized or a claim
 * of profitability. No network, account state, orders, hidden clock, or future candles are read.
 *
 * A known swing is briefly exceeded, then the latest completed directional candle closes back
 * inside it. Entry is near THAT reclaim close; this is not another break/retest of the old zone.
 * The swept wick remains the structural invalidation, with all existing fast risk limits intact.
 */
export function buildSweepReclaim(ctx: EngineContext): BuildResult {
  const cfg = NITROUS_SWEEP_CONFIG;
  const result: BuildResult = { setups: [], rejections: [] };
  const reject = (tf: Timeframe, code: RejectionCode, detail: string, zoneId?: string) => {
    result.rejections.push({ at: ctx.asOf, stage: `sweep:${tf}`, code, detail, family: "sweep_reclaim", zoneId });
  };

  for (const tf of ENTRY_TIMEFRAMES) {
    if (!ctx.executionTimeframes.includes(tf)) continue;
    const ms = TF_MS[tf];
    const bars = (ctx.bars[tf] ?? []).filter(b => b.t + ms <= ctx.asOf);
    const atrEntry = ctx.atr[tf];
    if (bars.length < cfg.feed.warmupBars || !atrEntry || !positive(atrEntry)) {
      reject(tf, "warmup", `${bars.length} closed ${tf} bars; need ${cfg.feed.warmupBars} and a completed ATR`);
      continue;
    }
    const candle = bars.at(-1)!;
    const previous = bars.at(-2)!;
    if (!validBar(candle) || !validBar(previous) || previous.t + ms !== candle.t) {
      reject(tf, "warmup", "The latest closed candle and its preceding candle must be valid and consecutive.");
      continue;
    }
    const closedAt = candle.t + ms;
    const expiresAt = closedAt + ms;
    if (ctx.asOf <= closedAt) {
      reject(tf, "forming_candle", "A sweep entry can be considered only after the reclaim candle has closed.");
      continue;
    }
    if (ctx.asOf >= expiresAt) {
      reject(tf, "expired", `The ${tf} reclaim entry window ended at ${new Date(expiresAt).toISOString()}.`);
      continue;
    }
    if (!positive(ctx.tick) || !positive(ctx.refPrice) || !Number.isFinite(ctx.spread) || ctx.spread < 0) {
      reject(tf, "stale_quote", "A positive current reference price, valid tick and nonnegative spread are required.");
      continue;
    }

    const tol = freezeTolerances(atrEntry, ctx.spread, ctx.tick, cfg);
    const known = (ctx.pivots[tf] ?? []).filter(p => p.timeframe === tf && positive(p.price)
      && positive(p.t) && positive(p.knownAt) && p.t < p.knownAt && p.knownAt <= candle.t)
      .sort((a, b) => b.knownAt - a.knownAt || b.t - a.t || a.kind.localeCompare(b.kind));
    if (!known.length) {
      reject(tf, "no_anchor", "No confirmed swing high or low was knowable before the reclaim candle opened.");
      continue;
    }

    let swept = false;
    const usedParents = new Set<string>();
    for (const pivot of known) {
      const side: Side = pivot.kind === "low" ? "buy" : "sell";
      const direction = side === "buy" ? 1 : -1;
      const priorInside = side === "buy" ? previous.c > pivot.price : previous.c < pivot.price;
      const extreme = side === "buy" ? candle.l : candle.h;
      const penetrated = side === "buy" ? extreme < pivot.price - tol.breakBuffer : extreme > pivot.price + tol.breakBuffer;
      const hasWick = side === "buy" ? candle.l < Math.min(candle.o, candle.c) : candle.h > Math.max(candle.o, candle.c);
      if (!priorInside || !penetrated || !hasWick) continue;
      swept = true;
      const zone = parentZone(ctx.zoneHistory ?? ctx.zones, pivot);
      const sourceId = pivotId(pivot);
      const zoneId = zone?.id ?? sourceId;
      const parentId = zone?.parentId ?? sourceId;
      if (zone && (zone.invalidatedAt != null || zone.failedStops >= cfg.range.maxFailedStopsPerZone || zone.knownAt > ctx.asOf)) {
        reject(tf, zone.invalidatedAt != null ? "zone_expired" : "zone_suspended", "The existing parent level is not eligible for a new entry.", zoneId);
        continue;
      }
      const reclaimed = side === "buy" ? candle.c > pivot.price : candle.c < pivot.price;
      const directional = side === "buy" ? candle.c > candle.o : candle.c < candle.o;
      const position = closePosition(candle);
      const strongClose = side === "buy" ? position >= .65 : position <= .35;
      if (!reclaimed || !directional || !strongClose) {
        reject(tf, "no_reclaim", `The wick swept ${pivot.price.toFixed(2)}, but the completed candle did not reclaim it with a directional close in the required outer 35%.`, zoneId);
        continue;
      }
      const identity = `${parentId}|${side}`;
      if (usedParents.has(identity)) continue;

      const refEntry = candle.c;
      const band = { low: refEntry - tol.touchTolerance, high: refEntry + tol.touchTolerance };
      let stop = roundOutward(extreme - direction * tol.stopBuffer, ctx.tick, direction === 1 ? -1 : 1);
      if (ctx.minStopDistance != null && ctx.minStopDistance > 0 && Math.abs(refEntry - stop) < ctx.minStopDistance) {
        stop = roundOutward(refEntry - direction * ctx.minStopDistance, ctx.tick, direction === 1 ? -1 : 1);
      }
      const stopUsd = direction * (refEntry - stop);
      const cap = stopWithinCap(stopUsd, cfg);
      if (!(stopUsd > 0) || !cap.ok) {
        reject(tf, "stop_too_wide", cap.reason ?? "The full swept wick does not leave a valid structural stop.", zoneId);
        continue;
      }
      const { plan, reason } = planTarget(side, refEntry, targetObstacles(ctx.zones, ctx.asOf), [parentId], ctx.spread, ctx.tick, cfg);
      if (!plan || plan.distance < cfg.target.minUsd) {
        reject(tf, "target_room_short", plan ? `Tick rounding leaves less than ${cfg.target.minUsd} of target room.` : reason, zoneId);
        continue;
      }
      if (ctx.spread > cfg.risk.maxSpreadUsd || ctx.spread / plan.distance > cfg.risk.maxSpreadToTargetRatio) {
        reject(tf, "spread_too_wide", `Spread ${ctx.spread.toFixed(2)} exceeds the existing absolute or target-relative limit.`, zoneId);
        continue;
      }
      const costs = buildCostModel(ctx.spread, ctx.tick, ctx.contractSize, cfg);
      const costShare = costRatio(plan.distance, costs);
      if (costShare > cfg.risk.maxCostToTargetRatio) {
        reject(tf, "cost_too_high", `Modelled costs consume ${(costShare * 100).toFixed(1)}% of the target.`, zoneId);
        continue;
      }
      const rr = netRewardRisk(side, refEntry, stop, plan.target, costs);
      if (rr < cfg.target.minNetRewardRisk) {
        reject(tf, "reward_risk_short", `Net reward/risk ${rr.toFixed(2)} is below ${cfg.target.minNetRewardRisk}.`, zoneId);
        continue;
      }
      const bracketClear = side === "buy" ? stop < band.low && plan.target > band.high : stop > band.high && plan.target < band.low;
      const currentInside = ctx.refPrice >= band.low && ctx.refPrice <= band.high;
      const currentValid = side === "buy" ? ctx.refPrice > extreme && ctx.refPrice < plan.target : ctx.refPrice < extreme && ctx.refPrice > plan.target;
      if (!bracketClear || !currentInside || !currentValid) {
        reject(tf, "outside_band", `Current price must remain inside the reclaim-close entry band ${band.low.toFixed(2)}–${band.high.toFixed(2)}, beyond the sweep invalidation and before the target.`, zoneId);
        continue;
      }

      const sweepEvidence: SweepEvidence = {
        pivotId: sourceId, pivotKind: pivot.kind, pivotPrice: pivot.price, pivotTime: pivot.t, pivotKnownAt: pivot.knownAt,
        candleOpenedAt: candle.t, candleClosedAt: closedAt, candleOpen: candle.o, candleHigh: candle.h,
        candleLow: candle.l, candleClose: candle.c, sweepExtreme: extreme, confirmationThreshold: pivot.price,
      };
      const setup: Setup = {
        setupId: `nitrous:sweep:${tf}:${pivot.kind}:${pivot.t}:${closedAt}`, visitId: "",
        strategyVersion: cfg.version, configVersion: cfg.configVersion, family: "sweep_reclaim", side, state: "watching", timeframe: tf,
        zoneId, zoneVersion: zone?.version ?? 1, parentId, createdAt: ctx.asOf, stateAt: ctx.asOf, expiresAt,
        tolerances: tol, entryBandLow: band.low, entryBandHigh: band.high, invalidation: extreme, stop,
        opposingLevelId: plan.obstacle?.zoneId ?? null, opposingPrice: plan.obstacle?.price ?? null,
        refEntry, target: plan.target, targetUsd: plan.distance, stopUsd, transitions: [], breakEvidence: null, sweepEvidence,
        conditionsMet: [
          `A confirmed ${tf} swing ${pivot.kind} at ${pivot.price.toFixed(2)} was known before the signal candle opened.`,
          `The completed candle swept ${Math.abs(extreme - pivot.price).toFixed(2)} beyond that swing and reclaimed ${pivot.price.toFixed(2)}.`,
          `A ${side === "buy" ? "bullish" : "bearish"} close at ${(position * 100).toFixed(0)}% of the candle range confirms the reclaim.`,
          `Entry is centered on the reclaim close ${refEntry.toFixed(2)}; the stop preserves the full sweep extreme ${extreme.toFixed(2)} plus its buffer.`,
          `Target ${plan.reason}; net reward/risk ${rr.toFixed(2)}.`,
        ],
        conditionsPending: [
          `A fresh broker price inside ${band.low.toFixed(2)}–${band.high.toFixed(2)} before ${new Date(expiresAt).toISOString()}.`,
          "The existing structural stop, net reward/risk, spread, margin and account risk checks must still qualify.",
        ],
      };
      result.setups.push(setup);
      usedParents.add(identity);
    }
    if (!swept) reject(tf, "no_sweep", "The latest closed candle did not wick beyond an already-known swing by the required buffer from the inside side.");
  }
  return result;
}
