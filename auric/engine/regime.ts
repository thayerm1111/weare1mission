import type { Features, Regime, RegimeState } from "../core/types";
import type { AuricConfig } from "../config/defaults";

/**
 * Regime classification — the exact boolean logic.
 *
 *  directionalUp   = structure == HH_HL && emaSlopeAtr >= +slopeMinAtr && efficiency >= trendEfficiencyMin
 *  directionalDown = structure == LH_LL && emaSlopeAtr <= -slopeMinAtr && efficiency >= trendEfficiencyMin
 *  orderlyRange    = range candidate present && !invalidated && efficiency <= rangeEfficiencyMax
 *                    && overlapMean < overlapChopRatio
 *  expansion       = atrPercentile >= 0.80 && !directional && (range == null || range.invalidated)
 *                    && efficiency >= trendEfficiencyMin   (volatility expanding with direction but structure not yet confirmed)
 *  otherwise       = CHOP_OR_UNCERTAIN  (overlap, conflicting evidence, undefined efficiency, no boundaries)
 *
 * Conflicts (e.g. HH_HL but negative slope) fall through to CHOP_OR_UNCERTAIN on purpose.
 */
export function classify(f: Features, cfg: AuricConfig["regime"]): { regime: Regime; reasons: string[] } {
  const reasons: string[] = [];
  if (!Number.isFinite(f.atrM5) || !Number.isFinite(f.emaSlopeAtr) || f.structure === "INSUFFICIENT") {
    reasons.push("insufficient data: ATR/slope/structure not yet defined");
    return { regime: "CHOP_OR_UNCERTAIN", reasons };
  }
  if (!f.efficiencyDefined) { reasons.push("efficiency undefined (zero net movement)"); return { regime: "CHOP_OR_UNCERTAIN", reasons }; }
  const effTrend = f.efficiency >= cfg.trendEfficiencyMin;
  const up = f.structure === "HH_HL" && f.emaSlopeAtr >= cfg.slopeMinAtr && effTrend;
  const down = f.structure === "LH_LL" && f.emaSlopeAtr <= -cfg.slopeMinAtr && effTrend;
  if (up) { reasons.push(`HH/HL structure, EMA slope +${f.emaSlopeAtr.toFixed(2)} ATR, efficiency ${f.efficiency.toFixed(2)} ≥ ${cfg.trendEfficiencyMin}`); return { regime: "UPTREND", reasons }; }
  if (down) { reasons.push(`LH/LL structure, EMA slope ${f.emaSlopeAtr.toFixed(2)} ATR, efficiency ${f.efficiency.toFixed(2)} ≥ ${cfg.trendEfficiencyMin}`); return { regime: "DOWNTREND", reasons }; }
  if (f.overlapMean >= cfg.overlapChopRatio) { reasons.push(`candle overlap ${f.overlapMean.toFixed(2)} ≥ ${cfg.overlapChopRatio}: churning`); return { regime: "CHOP_OR_UNCERTAIN", reasons }; }
  const rangeOk = !!f.range && !f.range.invalidated;
  if (rangeOk && f.efficiency <= cfg.rangeEfficiencyMax) {
    reasons.push(`frozen range ${f.range!.support.toFixed(2)}–${f.range!.resistance.toFixed(2)} with ${f.range!.touchesLow.length}/${f.range!.touchesHigh.length} separated reactions, efficiency ${f.efficiency.toFixed(2)} ≤ ${cfg.rangeEfficiencyMax}`);
    return { regime: "ORDERLY_RANGE", reasons };
  }
  if (f.atrPercentile >= 0.8 && !rangeOk && effTrend) {
    reasons.push(`ATR percentile ${(f.atrPercentile * 100).toFixed(0)} with efficiency ${f.efficiency.toFixed(2)} but structure ${f.structure}: expansion without confirmed structure`);
    return { regime: "EXPANSION_TRANSITION", reasons };
  }
  if (rangeOk) reasons.push(`range present but efficiency ${f.efficiency.toFixed(2)} > ${cfg.rangeEfficiencyMax}`);
  if (f.structure === "MIXED") reasons.push("mixed swing structure");
  if ((f.structure === "HH_HL" && f.emaSlopeAtr < cfg.slopeMinAtr) || (f.structure === "LH_LL" && f.emaSlopeAtr > -cfg.slopeMinAtr)) reasons.push("structure and slope disagree");
  if (!effTrend) reasons.push(`efficiency ${f.efficiency.toFixed(2)} below trend threshold and no reliable boundaries`);
  return { regime: "CHOP_OR_UNCERTAIN", reasons };
}

/**
 * Hysteresis: a newly classified regime must persist for `hysteresisBars` consecutive closed M5 bars before
 * it replaces the adopted one. One update never flips the regime.
 */
export function stepRegime(state: RegimeState | null, next: { regime: Regime; reasons: string[] }, closedAt: number, cfg: AuricConfig["regime"]): RegimeState {
  if (!state) return { regime: next.regime, since: closedAt, pending: null, pendingBars: 0, reasons: next.reasons };
  if (next.regime === state.regime) return { ...state, pending: null, pendingBars: 0, reasons: next.reasons };
  if (state.pending === next.regime) {
    const n = state.pendingBars + 1;
    if (n >= cfg.hysteresisBars) return { regime: next.regime, since: closedAt, pending: null, pendingBars: 0, reasons: next.reasons };
    return { ...state, pendingBars: n, reasons: [...state.reasons, `pending ${next.regime} (${n}/${cfg.hysteresisBars})`] };
  }
  return { ...state, pending: next.regime, pendingBars: 1, reasons: [...state.reasons, `pending ${next.regime} (1/${cfg.hysteresisBars})`] };
}
