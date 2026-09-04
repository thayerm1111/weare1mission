/**
 * MATTY PIPS — GOLD DECISION ENGINE configuration.
 *
 * Every weight and threshold the decision engine uses lives HERE, in one
 * typed object — no magic numbers buried in logic. This is deliberately
 * structured so a later phase can override values from a database row
 * (matty_pips_config) without touching code: load the row, deep-merge onto
 * DEFAULT_CONFIG, pass the result down. Deterministic math only — no ML.
 */

export type ScoringWeights = {
  htfStructure: number;   // D + 4H regime + 1H structure alignment
  srLocation: number;     // where price sits relative to the level map
  m15Setup: number;       // the 15M reaction / setup family
  m5Confirm: number;      // 5M trigger + micro-structure agreement
  momentum: number;       // SAR, fractals, impulse, sweep fuel
  room: number;           // dollars of clean air to the first opposing major
  sessionVol: number;     // session liquidity + volatility state
  execution: number;      // how clean the entry is RIGHT NOW
};

export type MpConfig = {
  weights: ScoringWeights;               // must sum to 100
  move: {
    tp1MinDollars: number;               // smallest move worth calling ($3)
    tp1MaxDollars: number;               // TP1 band ceiling ($7)
    primaryMaxDollars: number;           // "primary expected move" display cap
    maxMoveDollars: number;              // the engine hunts moves up to $10
    stopMinDollars: number;              // never tighter than structure allows
    stopMaxDollars: number;              // hard cap — WAIT FOR PRICE instead of widening
    tpFrontRunDollars: number;           // park TPs this far in front of the level
    opposingMinRank: number;             // levels below this rank don't cap targets
  };
  conviction: {
    base: number;                        // conviction floor before evidence
    winnerCoef: number;                  // winning side total → conviction
    diffCoef: number;                    // BUY/SELL differential → conviction
    min: number;
    max: number;
    extremeVolPenalty: number;
    deadSessionPenalty: number;
    dxyConflictPenalty: number;
  };
  execution: {
    atZoneAtr: number;                   // within this ×ATR15 of a zone = "at" it
    extendedAtr: number;                 // beyond this ×ATR15 from the zone = extended
    breakoutPadAtr: number;              // stop-entry pad beyond the level edge
    limitFallbackPullbackAtr: number;    // no mapped zone → wait for this pullback
    limitFallbackWidthAtr: number;       // width of the fallback wait-zone
    minZoneRank: number;                 // zones below this rank can't host an entry
  };
  volatility: {
    lowRatio: number;                    // ATR14 vs baseline: below → LOW
    elevatedRatio: number;               // above → ELEVATED
    extremeRatio: number;                // above → EXTREME
    baselineBars: number;                // how many m15 bars form the baseline
  };
  micro: {                               // 5M read
    triggerBodyAtr: number;              // displacement body ≥ this ×ATR5
    triggerCloseFrac: number;            // close in the top/bottom fraction of range
    extendedAtr: number;                 // distance from 20-bar mean ≥ this ×ATR5
  };
  stops: {
    levelPadAtr: number;                 // pad behind a protecting level
    sweepPadAtr: number;                 // pad behind a sweep extreme
    swingPadAtr: number;                 // pad behind the last swing
    minRawDollars: number;               // structural candidates tighter than this are noise
    maxRawDollars: number;               // wider than this isn't "the next move" structure
    atrFallbackMult: number;             // no valid candidate → this ×ATR15
  };
};

export const DEFAULT_CONFIG: MpConfig = {
  weights: { htfStructure: 20, srLocation: 20, m15Setup: 15, m5Confirm: 15, momentum: 10, room: 10, sessionVol: 5, execution: 5 },
  move: {
    tp1MinDollars: 3, tp1MaxDollars: 7, primaryMaxDollars: 8, maxMoveDollars: 10,
    stopMinDollars: 3, stopMaxDollars: 10, tpFrontRunDollars: 0.3, opposingMinRank: 30,
  },
  conviction: {
    base: 30, winnerCoef: 0.45, diffCoef: 0.9, min: 35, max: 95,
    extremeVolPenalty: 6, deadSessionPenalty: 4, dxyConflictPenalty: 3,
  },
  execution: {
    atZoneAtr: 0.7, extendedAtr: 1.5, breakoutPadAtr: 0.3,
    limitFallbackPullbackAtr: 0.8, limitFallbackWidthAtr: 0.4, minZoneRank: 30,
  },
  volatility: { lowRatio: 0.7, elevatedRatio: 1.35, extremeRatio: 2.0, baselineBars: 96 },
  micro: { triggerBodyAtr: 0.8, triggerCloseFrac: 0.35, extendedAtr: 2.2 },
  stops: {
    levelPadAtr: 0.5, sweepPadAtr: 0.3, swingPadAtr: 0.4,
    minRawDollars: 0.8, maxRawDollars: 14, atrFallbackMult: 1.6,
  },
};

/** Deep-merge a partial override (e.g. a DB config row) onto the defaults. */
export function mergeConfig(over: Partial<Record<string, unknown>> | null | undefined): MpConfig {
  if (!over) return DEFAULT_CONFIG;
  const out: MpConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  for (const k of Object.keys(out) as (keyof MpConfig)[]) {
    const o = (over as Record<string, unknown>)[k];
    if (o && typeof o === "object") Object.assign(out[k] as Record<string, unknown>, o);
  }
  return out;
}
