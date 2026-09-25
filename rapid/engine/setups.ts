import type { Bar, Pivot, Rejection, RejectionCode, Setup, Side, Timeframe, ValidatedRange, Zone } from "../core/types";
import { dirOf } from "../core/types";
import { TF_MS, bodyRatio, closePosition } from "../market/bars";
import { eligibleZones, farEdge, nearEdge, targetObstacles } from "./zones";
import { classifyRegime } from "./structure";
import { resolveStop, stopWithinCap } from "./stops";
import { buildCostModel, costRatio, netRewardRisk, planTarget } from "./targets";
import { freezeTolerances } from "./tolerances";
import type { RapidConfig } from "../config/defaults";

/**
 * The three entry families, plus the research momentum option.
 *
 * Every candidate that comes out of here is CONDITIONAL. A chart location is not an executable
 * signal: a candidate still has to survive account eligibility, a fresh broker quote, spread and
 * cost checks, and the visit state machine before anything is sent.
 *
 * Every candidate that does NOT come out of here is recorded as a rejection with a code. The
 * rejection funnel is how you find out the engine has quietly filtered itself into doing nothing.
 */

export type EngineContext = {
  asOf: number;
  tick: number;
  /** Closed bars by timeframe, oldest first. */
  bars: Partial<Record<Timeframe, Bar[]>>;
  /** Confirmed pivots by timeframe. */
  pivots: Partial<Record<Timeframe, Pivot[]>>;
  /** ATR(14) by timeframe. */
  atr: Partial<Record<Timeframe, number>>;
  zones: Zone[];
  range: ValidatedRange | null;
  /** Executable mid used for planning. The real fill uses bid/ask at trigger. */
  refPrice: number;
  spread: number;
  minStopDistance: number | null;
  contractSize: number | null;
  /** Execution timeframes, most granular first. */
  executionTimeframes: Timeframe[];
  cfg: RapidConfig;
};

export type BuildResult = { setups: Setup[]; rejections: Rejection[] };

let seq = 0;
const nextId = (prefix: string, asOf: number) => `${prefix}:${asOf}:${(seq = (seq + 1) % 1_000_000).toString(36)}`;

const reject = (
  out: Rejection[],
  stage: string,
  code: RejectionCode,
  detail: string,
  at: number,
  family?: Setup["family"],
  zoneId?: string,
) => {
  out.push({ at, stage, code, detail, family, zoneId });
};

export function buildSetups(ctx: EngineContext): BuildResult {
  const setups: Setup[] = [];
  const rejections: Rejection[] = [];
  for (const tf of ctx.executionTimeframes) {
    const bars = ctx.bars[tf];
    const atrEntry = ctx.atr[tf];
    if (!bars || bars.length < ctx.cfg.feed.warmupBars || !atrEntry) {
      reject(rejections, `warmup:${tf}`, "warmup", `${bars?.length ?? 0} closed ${tf} bars, ATR ${atrEntry ?? "unavailable"}`, ctx.asOf);
      continue;
    }
    rangeReaction(ctx, tf, bars, atrEntry, setups, rejections);
    breakRetest(ctx, tf, bars, atrEntry, setups, rejections);
    trendPullback(ctx, tf, bars, atrEntry, setups, rejections);
    if (ctx.cfg.entry.momentumEnabled) momentum(ctx, tf, bars, atrEntry, setups, rejections);
  }
  return { setups, rejections };
}

// ---------------------------------------------------------------------------------------------
// Shared assembly: everything past "which zone, which direction" is identical across the families.
// ---------------------------------------------------------------------------------------------

type Draft = {
  family: Setup["family"];
  side: Side;
  zone: Zone;
  from: "above" | "below";
  timeframe: Timeframe;
  conditionsMet: string[];
  conditionsPending: string[];
  expiresAt: number;
  breakEvidence: Setup["breakEvidence"];
  /** Optional override of the reference entry (momentum uses the boundary, not the mid). */
  refEntry?: number;
};

function assemble(ctx: EngineContext, d: Draft, bars: Bar[], atrEntry: number, rejections: Rejection[]): Setup | null {
  const cfg = ctx.cfg;
  const tol = freezeTolerances(atrEntry, ctx.spread, ctx.tick, cfg);
  const pivots = ctx.pivots[d.timeframe] ?? [];
  // The planning entry is the price the fill is EXPECTED at — the zone's near edge, where the first
  // touch happens — not wherever price is standing right now. Planning a range fade at support from
  // mid-range would price the trade against a stop and a target it will never actually have.
  // Using the near edge is also the conservative end of the band: a deeper fill only improves it.
  const refEntry = d.refEntry ?? nearEdge(d.zone, d.from);

  const anchor = resolveStop(
    {
      side: d.side,
      zone: d.zone,
      from: d.from,
      pivots,
      bars,
      asOf: ctx.asOf,
      tick: ctx.tick,
      stopBuffer: tol.stopBuffer,
      breakBuffer: tol.breakBuffer,
      minStopDistance: ctx.minStopDistance,
      refEntry,
    },
    cfg,
  );
  if (!anchor) {
    reject(rejections, `stop:${d.family}`, "no_anchor", "no identifiable structural anchor within the lookback", ctx.asOf, d.family, d.zone.id);
    return null;
  }

  const cap = stopWithinCap(anchor.distance, cfg);
  if (!cap.ok) {
    reject(rejections, `stop:${d.family}`, "stop_too_wide", cap.reason ?? "", ctx.asOf, d.family, d.zone.id);
    return null;
  }

  const obstacles = targetObstacles(ctx.zones, ctx.asOf);
  const { plan, reason } = planTarget(d.side, refEntry, obstacles, [d.zone.parentId], ctx.spread, ctx.tick, cfg);
  if (!plan) {
    reject(rejections, `target:${d.family}`, "target_room_short", reason, ctx.asOf, d.family, d.zone.id);
    return null;
  }

  const costs = buildCostModel(ctx.spread, ctx.tick, ctx.contractSize, cfg);
  const cr = costRatio(plan.distance, costs);
  if (cr > cfg.risk.maxCostToTargetRatio) {
    reject(rejections, `cost:${d.family}`, "cost_too_high", `modelled costs are ${(cr * 100).toFixed(1)}% of the ${plan.distance.toFixed(2)} target`, ctx.asOf, d.family, d.zone.id);
    return null;
  }

  const rr = netRewardRisk(d.side, refEntry, anchor.stop, plan.target, costs);
  if (rr < cfg.target.minNetRewardRisk) {
    reject(rejections, `rr:${d.family}`, "reward_risk_short", `net reward/risk ${rr.toFixed(2)} below ${cfg.target.minNetRewardRisk}`, ctx.asOf, d.family, d.zone.id);
    return null;
  }

  const band = approachBand(d.zone, d.from, tol.touchTolerance);

  return {
    setupId: nextId(`${d.family}:${d.timeframe}`, ctx.asOf),
    visitId: "",
    strategyVersion: cfg.version,
    configVersion: cfg.configVersion,
    family: d.family,
    side: d.side,
    state: "watching",
    timeframe: d.timeframe,
    zoneId: d.zone.id,
    zoneVersion: d.zone.version,
    parentId: d.zone.parentId,
    createdAt: ctx.asOf,
    stateAt: ctx.asOf,
    expiresAt: d.expiresAt,
    tolerances: tol,
    entryBandLow: band.low,
    entryBandHigh: band.high,
    invalidation: anchor.invalidation,
    stop: anchor.stop,
    opposingLevelId: plan.obstacle?.zoneId ?? null,
    opposingPrice: plan.obstacle?.price ?? null,
    refEntry,
    target: plan.target,
    targetUsd: plan.distance,
    stopUsd: anchor.distance,
    transitions: [],
    conditionsMet: [...d.conditionsMet, `stop ${anchor.sources.join(" + ")}`, `target ${plan.reason}`, `net R:R ${rr.toFixed(2)}`],
    conditionsPending: d.conditionsPending,
    breakEvidence: d.breakEvidence,
  };
}

/** The bounded band around a zone in which an entry is allowed. Outside it, price is being chased. */
export function approachBand(zone: { low: number; high: number }, from: "above" | "below", tolerance: number): { low: number; high: number } {
  return { low: zone.low - tolerance, high: zone.high + tolerance };
}

/**
 * Has price gapped completely through the zone rather than touching it? A long at support is invalid
 * once price is below the far edge by more than the tolerance — there was no touch, only a hole.
 */
export function gappedThrough(side: Side, price: number, zone: { low: number; high: number }, from: "above" | "below", tolerance: number): boolean {
  const far = farEdge(zone, from);
  return side === "buy" ? price < far - tolerance : price > far + tolerance;
}

// ---------------------------------------------------------------------------------------------
// A. Range reaction
// ---------------------------------------------------------------------------------------------

function rangeReaction(ctx: EngineContext, tf: Timeframe, bars: Bar[], atrEntry: number, out: Setup[], rej: Rejection[]) {
  const r = ctx.range;
  if (!r) {
    reject(rej, `range:${tf}`, "no_zone", "no validated range on this timeframe", ctx.asOf, "range_reaction");
    return;
  }
  if (r.timeframe !== tf) return;
  if (r.brokenAt != null) {
    reject(rej, `range:${tf}`, "opposite_break", `range broken ${r.brokenBy} at ${new Date(r.brokenAt).toISOString()}`, ctx.asOf, "range_reaction");
    return;
  }
  if (r.knownAt > ctx.asOf) {
    reject(rej, `range:${tf}`, "no_zone", "range evidence not complete yet", ctx.asOf, "range_reaction");
    return;
  }

  const expiresAt = ctx.asOf + ctx.cfg.entry.retestExpiryBars * TF_MS[tf];
  // Buy the lower boundary approached from above; sell the upper boundary approached from below.
  const legs: Array<{ side: Side; zone: Zone; from: "above" | "below" }> = [
    { side: "buy", zone: r.lower, from: "above" },
    { side: "sell", zone: r.upper, from: "below" },
  ];
  for (const leg of legs) {
    const s = assemble(
      ctx,
      {
        family: "range_reaction",
        side: leg.side,
        zone: leg.zone,
        from: leg.from,
        timeframe: tf,
        expiresAt,
        breakEvidence: null,
        conditionsMet: [
          `validated range ${r.id} with ${r.lowerTouches} lower and ${r.upperTouches} upper completed reactions`,
          `boundary approached from ${leg.from}; no extra rejection candle required`,
        ],
        conditionsPending: [`executable price inside the approach band on a fresh visit`],
      },
      bars,
      atrEntry,
      rej,
    );
    if (s) out.push(s);
  }
}

// ---------------------------------------------------------------------------------------------
// B. Closed break and immediate retest
// ---------------------------------------------------------------------------------------------

/**
 * Find a completed breakout candle on this timeframe.
 *
 * The breakout and the retest can never come from the same candle: the retest may only be armed once
 * the breakout candle has CLOSED, and the entry event has to arrive after that close. Anything else
 * is reading a bar's high and low as if you knew which came first.
 */
export function findBreak(
  bars: Bar[],
  zone: Zone,
  side: Side,
  breakBuffer: number,
  tf: Timeframe,
  cfg: RapidConfig,
  asOf: number,
): Setup["breakEvidence"] | null {
  const barMs = TF_MS[tf];
  const horizon = cfg.entry.retestExpiryBars + 1;
  const recent = bars.slice(-horizon);
  for (let i = recent.length - 1; i >= 0; i--) {
    const b = recent[i];
    const closeTime = b.t + barMs;
    if (closeTime > asOf) continue;
    const beyond = side === "buy" ? b.c - (zone.high + breakBuffer) : (zone.low - breakBuffer) - b.c;
    if (!(beyond > 0)) continue;
    const br = bodyRatio(b);
    if (br < cfg.entry.minBodyRatio) continue;
    const pos = closePosition(b);
    const outer = side === "buy" ? pos >= 1 - cfg.entry.closeOuterFraction : pos <= cfg.entry.closeOuterFraction;
    if (!outer) continue;
    const directional = side === "buy" ? b.c > b.o : b.c < b.o;
    if (!directional) continue;
    return { closedAt: closeTime, closePrice: b.c, bodyRatio: br, closePositionInRange: pos, beyondBy: beyond };
  }
  return null;
}

function breakRetest(ctx: EngineContext, tf: Timeframe, bars: Bar[], atrEntry: number, out: Setup[], rej: Rejection[]) {
  const cfg = ctx.cfg;
  const tol = freezeTolerances(atrEntry, ctx.spread, ctx.tick, cfg);
  const zones = eligibleZones(ctx.zones, ctx.asOf, cfg.range.maxFailedStopsPerZone);
  const barMs = TF_MS[tf];

  for (const zone of zones) {
    for (const side of ["buy", "sell"] as Side[]) {
      // A long breaks resistance; a short breaks support. After the break the zone's role flips, so
      // the retest is approached from the new side.
      const wantRole = side === "buy" ? "resistance" : "support";
      if (zone.role !== wantRole && zone.previousRole !== wantRole) continue;

      const ev = findBreak(bars, zone, side, tol.breakBuffer, tf, cfg, ctx.asOf);
      if (!ev) continue;

      // Expire the arm after the allowed number of bars.
      const expiresAt = ev.closedAt + cfg.entry.retestExpiryBars * barMs;
      if (ctx.asOf >= expiresAt) {
        reject(rej, `retest:${tf}`, "expired", `no retest within ${cfg.entry.retestExpiryBars} ${tf} bars of the ${new Date(ev.closedAt).toISOString()} break`, ctx.asOf, "break_retest", zone.id);
        continue;
      }

      // An opposite qualifying break since the arm cancels it.
      const opposite = findBreak(bars.filter((b) => b.t + barMs > ev.closedAt), zone, side === "buy" ? "sell" : "buy", tol.breakBuffer, tf, cfg, ctx.asOf);
      if (opposite) {
        reject(rej, `retest:${tf}`, "opposite_break", `an opposite qualifying break closed at ${opposite.closePrice}`, ctx.asOf, "break_retest", zone.id);
        continue;
      }

      const s = assemble(
        ctx,
        {
          family: "break_retest",
          side,
          zone,
          from: side === "buy" ? "above" : "below",
          timeframe: tf,
          expiresAt,
          breakEvidence: ev,
          conditionsMet: [
            `completed ${tf} candle closed ${ev.beyondBy.toFixed(2)} beyond the zone at ${new Date(ev.closedAt).toISOString()}`,
            `body ${(ev.bodyRatio * 100).toFixed(0)}% of range, close at ${(ev.closePositionInRange * 100).toFixed(0)}% of range`,
          ],
          conditionsPending: [`price returns to the zone from the new side before ${new Date(expiresAt).toISOString()}`],
        },
        bars,
        atrEntry,
        rej,
      );
      if (s) out.push(s);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// C. Trend pullback into fresh structure
// ---------------------------------------------------------------------------------------------

function trendPullback(ctx: EngineContext, tf: Timeframe, bars: Bar[], atrEntry: number, out: Setup[], rej: Rejection[]) {
  const cfg = ctx.cfg;
  const pivots = ctx.pivots[tf] ?? [];
  const regime = classifyRegime(bars, pivots, ctx.asOf, {
    atrPeriod: cfg.structure.atrPeriod,
    noiseTicks: cfg.structure.noiseTicks,
    noiseAtrMult: cfg.structure.noiseAtrMult,
    tickSize: ctx.tick,
    minSwingsPerSide: cfg.structure.minSwingsPerSide,
  });
  if (regime.regime !== "up" && regime.regime !== "down") {
    reject(rej, `pullback:${tf}`, "regime_conflict", `local ${tf} regime is ${regime.regime} (${regime.reason})`, ctx.asOf, "trend_pullback");
    return;
  }
  const side: Side = regime.regime === "up" ? "buy" : "sell";
  const d = dirOf(side);
  const tol = freezeTolerances(atrEntry, ctx.spread, ctx.tick, cfg);

  // The newest eligible zone BEHIND price in the direction of the trend: a broken swing zone that has
  // flipped role, or an established local reaction zone. It must have been known before this pullback.
  const wantRole = side === "buy" ? "support" : "resistance";
  const behind = eligibleZones(ctx.zones, ctx.asOf, cfg.range.maxFailedStopsPerZone)
    .filter((z) => z.role === wantRole && z.origin === tf)
    .filter((z) => (d === 1 ? nearEdge(z, "above") <= ctx.refPrice : nearEdge(z, "below") >= ctx.refPrice))
    .filter((z) => z.reactions.some((r) => r.at <= ctx.asOf) || z.previousRole != null)
    .sort((a, b) => b.knownAt - a.knownAt)[0];

  if (!behind) {
    reject(rej, `pullback:${tf}`, "no_zone", `no known ${wantRole} zone behind price on ${tf}`, ctx.asOf, "trend_pullback");
    return;
  }

  const s = assemble(
    ctx,
    {
      family: "trend_pullback",
      side,
      zone: behind,
      from: side === "buy" ? "above" : "below",
      timeframe: tf,
      expiresAt: ctx.asOf + cfg.entry.retestExpiryBars * TF_MS[tf],
      breakEvidence: null,
      conditionsMet: [
        `local ${tf} ${regime.regime}trend: ${regime.reason}`,
        `fresh ${wantRole} at ${behind.low.toFixed(2)}-${behind.high.toFixed(2)} known since ${new Date(behind.knownAt).toISOString()}`,
      ],
      conditionsPending: [
        `pullback into the zone while the protected ${side === "buy" ? "higher low" : "lower high"} structure holds`,
      ],
    },
    bars,
    atrEntry,
    rej,
  );
  void tol;
  if (s) out.push(s);
}

// ---------------------------------------------------------------------------------------------
// D. Closed-break momentum — research option, OFF by default, measured separately
// ---------------------------------------------------------------------------------------------

function momentum(ctx: EngineContext, tf: Timeframe, bars: Bar[], atrEntry: number, out: Setup[], rej: Rejection[]) {
  const cfg = ctx.cfg;
  const tol = freezeTolerances(atrEntry, ctx.spread, ctx.tick, cfg);
  const zones = eligibleZones(ctx.zones, ctx.asOf, cfg.range.maxFailedStopsPerZone);
  const leash = Math.min(cfg.entry.momentumMaxUsd, cfg.entry.momentumAtrMult * atrEntry);

  for (const zone of zones) {
    for (const side of ["buy", "sell"] as Side[]) {
      const ev = findBreak(bars, zone, side, tol.breakBuffer, tf, cfg, ctx.asOf);
      if (!ev) continue;
      const boundary = side === "buy" ? zone.high : zone.low;
      // A breakout candle that closed far beyond the line does NOT get a fictitious fill at the line.
      if (Math.abs(ctx.refPrice - boundary) > leash) {
        reject(rej, `momentum:${tf}`, "outside_band", `price is ${Math.abs(ctx.refPrice - boundary).toFixed(2)} from the boundary; leash is ${leash.toFixed(2)}`, ctx.asOf, "momentum", zone.id);
        continue;
      }
      const s = assemble(
        ctx,
        {
          family: "momentum",
          side,
          zone,
          from: side === "buy" ? "above" : "below",
          timeframe: tf,
          expiresAt: ev.closedAt + cfg.entry.retestExpiryBars * TF_MS[tf],
          breakEvidence: ev,
          refEntry: ctx.refPrice,
          conditionsMet: [`research variant: entry on the first quote after the ${new Date(ev.closedAt).toISOString()} breakout close`],
          conditionsPending: [`executable price stays within ${leash.toFixed(2)} of the boundary`],
        },
        bars,
        atrEntry,
        rej,
      );
      if (s) out.push(s);
    }
  }
}
