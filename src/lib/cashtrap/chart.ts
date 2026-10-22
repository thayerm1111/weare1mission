import { M5, type Candle } from "./candles";
import type { EffectiveConfig } from "./config";
import type { DmiEvent, DmiMode } from "./dmi";
import { evaluateLast } from "./engine";
import { atr as atrSeries } from "./indicators";
import type { CashtrapSymbol } from "./symbols";
import { autoZonesAt, manualZonesAt, type ManualZoneInput, type Zone } from "./zones";

/**
 * CHART DATA — each candle's values computed exactly as the engine computes them for a decision (the
 * same trailing window), so what the chart shows is what the engine saw.
 */
export type ChartPoint = {
  t: number; o: number; h: number; l: number; c: number;
  bbBasis: number | null; bbUpper: number | null; bbLower: number | null;
  rsi: number | null; rsiMa: number | null; stochK: number | null;
  dmiStoch: number | null; dmiEvent: "B" | "S" | null;
};

export function chartPoints(symbol: CashtrapSymbol, history: Candle[], n: number, cfg: EffectiveConfig, manual: ManualZoneInput[], dmi: { mode: DmiMode; available: boolean; events?: DmiEvent[] }): ChartPoint[] {
  const W = cfg.assumptions.data.windowCandles;
  const out: ChartPoint[] = [];
  for (let i = Math.max(0, history.length - n); i < history.length; i++) {
    const k = history[i];
    const win = history.slice(Math.max(0, i + 1 - W), i + 1);
    if (win.length < 30) { out.push({ ...k, bbBasis: null, bbUpper: null, bbLower: null, rsi: null, rsiMa: null, stochK: null, dmiStoch: null, dmiEvent: null }); continue; }
    const ev = evaluateLast(symbol, win, cfg, manual, { mode: dmi.mode, available: dmi.available, external: dmi.events, knownBy: Number.MAX_SAFE_INTEGER });
    const v = ev.values;
    out.push({ ...k, bbBasis: v.bbBasis, bbUpper: v.bbUpper, bbLower: v.bbLower, rsi: v.rsi, rsiMa: v.rsiMa, stochK: v.stochK, dmiStoch: v.dmiStoch, dmiEvent: ev.dmiEvent });
  }
  return out;
}

/** Zones known at the next candle's open (automatic, from the trailing window) plus the manual zones in force. */
export function currentZones(symbol: CashtrapSymbol, history: Candle[], cfg: EffectiveConfig, manual: ManualZoneInput[]): Zone[] {
  const W = cfg.assumptions.data.windowCandles;
  const win = history.slice(Math.max(0, history.length - W));
  if (win.length < 30) return [];
  const a = atrSeries(win.map((x) => x.h), win.map((x) => x.l), win.map((x) => x.c), cfg.assumptions.zones.atrLength);
  const ghost = { t: win[win.length - 1].t + M5, o: 0, h: 0, l: 0, c: 0 };
  const all = [...win, ghost];
  return [...autoZonesAt(symbol, all, [...a, null], win.length, cfg.assumptions.zones), ...manualZonesAt(manual, all, win.length, cfg.assumptions.zones)];
}
