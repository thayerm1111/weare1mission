/**
 * MATTY PIPS — volatility state engine. Current ATR14 (closed 15M bars)
 * measured against the instrument's own recent baseline, so "elevated" means
 * elevated FOR GOLD THIS WEEK, not against a hardcoded number. Also flags
 * candle-range expansion (the last few bars blowing out) separately, because
 * a quiet ATR with sudden expansion is exactly when stops get run.
 */
import type { Candle } from "./types";
import { atr } from "./structure";
import type { MpConfig } from "./config";

export type VolatilityState = "LOW" | "NORMAL" | "ELEVATED" | "EXTREME";

export type VolatilityRead = {
  state: VolatilityState;
  atr15: number;                 // current ATR14 on closed 15M bars
  baselineAtr: number;           // trailing baseline ATR
  ratio: number;                 // atr15 / baselineAtr
  expanding: boolean;            // last 3 closed ranges avg ≥ 1.5× ATR
  note: string;
};

export function readVolatility(m15: Candle[], cfg: MpConfig): VolatilityRead {
  const closed = m15.slice(0, -1);
  const cur = atr(closed);
  const base = atr(closed.slice(0, -14), Math.min(cfg.volatility.baselineBars, Math.max(14, closed.length - 14)));
  const ratio = base > 0 ? cur / base : 1;

  const last3 = closed.slice(-3);
  const expanding = last3.length === 3 && cur > 0 && last3.reduce((s, k) => s + (k.h - k.l), 0) / 3 >= 1.5 * cur;

  const state: VolatilityState =
    ratio >= cfg.volatility.extremeRatio ? "EXTREME" :
    ratio >= cfg.volatility.elevatedRatio ? "ELEVATED" :
    ratio <= cfg.volatility.lowRatio ? "LOW" : "NORMAL";

  const note =
    state === "EXTREME" ? `ATR ${cur.toFixed(2)} is ${ratio.toFixed(1)}× the recent norm — moves overshoot BOTH ways. Structure stops only, no tight stops.` :
    state === "ELEVATED" ? `ATR ${cur.toFixed(2)} running hot (${ratio.toFixed(2)}× norm) — targets get hit faster, so do stops.` :
    state === "LOW" ? `ATR ${cur.toFixed(2)} compressed (${ratio.toFixed(2)}× norm) — expect grind; a $3 move takes patience until range expands.` :
    `ATR ${cur.toFixed(2)} in its normal band — standard behavior at levels.`;

  return { state, atr15: cur, baselineAtr: base, ratio: Math.round(ratio * 100) / 100, expanding, note };
}
