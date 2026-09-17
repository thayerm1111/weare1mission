/**
 * GOLD CHANGE OF CHARACTER (structure flip) — shared by the entry gate (autoExec: don't take a trade
 * against a fresh flip) and the trade manager's Profit Guard (protect an open winner when the market
 * turns). Moved out of autoExec unchanged so both read the SAME definition of a reversal.
 *
 * Bullish flip: price bottomed first, then the latest 5-min close reclaimed the swing high that
 * preceded that low (a higher high against the down-leg). Bearish is the mirror. The leg must clear
 * ~5x the recent 5-min bar range (clamped $2.50-$8) so chop never counts as a reversal.
 */
import { series } from "@/lib/marketData";
import { closedBars } from "@/lib/mtf";

const CHOCH_MIN_USD = 4.0; // FLOOR only — the live threshold is volatility-normalized below

export type Bar = { h: number; l: number; c: number };

/** Pure structure read (unit-tested). null = no flip. */
export function chochOfBars(bars: Bar[]): "bullish" | "bearish" | null {
  if (bars.length < 8) return null;
  const lastClose = bars[bars.length - 1].c;
  let loIdx = 0, hiIdx = 0;
  for (let i = 1; i < bars.length; i++) { if (bars[i].l < bars[loIdx].l) loIdx = i; if (bars[i].h > bars[hiIdx].h) hiIdx = i; }
  const tr14 = bars.slice(-15).map((b) => b.h - b.l).filter((v) => Number.isFinite(v) && v >= 0);
  const atr5 = tr14.length ? tr14.reduce((a, b) => a + b, 0) / tr14.length : 0;
  const legMin = Math.max(2.5, Math.min(8, atr5 > 0 ? atr5 * 5 : CHOCH_MIN_USD));
  if (bars[hiIdx].h - bars[loIdx].l < legMin) return null;
  if (loIdx < hiIdx) {
    const priorHigh = Math.max(...bars.slice(0, loIdx + 1).map((b) => b.h));
    if (lastClose > priorHigh) return "bullish";
  }
  if (hiIdx < loIdx) {
    const priorLow = Math.min(...bars.slice(0, hiIdx + 1).map((b) => b.l));
    if (lastClose < priorLow) return "bearish";
  }
  return null;
}

export async function goldChangeOfCharacter(): Promise<"bullish" | "bearish" | null> {
  const key = process.env.TWELVEDATA_API_KEY;
  if (!key) return null;
  try {
    const raw = await series("XAU/USD", "5min", 60, key);
    if (!raw || raw === "ratelimit" || !Array.isArray(raw)) return null;
    const bars = (closedBars(raw, 30) ?? raw)
      .map((r) => ({ h: +r.high, l: +r.low, c: +r.close }))
      .filter((b) => Number.isFinite(b.h) && Number.isFinite(b.l) && Number.isFinite(b.c));
    return chochOfBars(bars);
  } catch { return null; }
}
