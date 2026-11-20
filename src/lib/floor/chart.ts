/**
 * THE FLOOR'S CHART — its arithmetic, apart from its drawing (src/components/om/floor/CandleChart.tsx).
 *
 * Pure: candles, a price and the engine's levels in; where every mark goes, out. Nothing here knows about
 * the browser, so the rules that matter are tested without one (tests/floor-chart.test.ts):
 *   • a candle that is not a real candle (a missing or non-finite number, a high under its low) is left
 *     out — never repaired, never guessed;
 *   • the scale is the CANDLES' range. A level far outside it is not drawn, rather than squeezing the
 *     market into a sliver to make room for it;
 *   • the time marks are distances between the candles' own stamps ("3 h" before the latest), because
 *     the feed stamps candles in its exchange's clock, which is not the member's.
 */
export type ChartCandle = { t: string; o: number; h: number; l: number; c: number };
export type ChartLevel = { kind: "support" | "resistance" | "entry" | "stop" | "target"; price: number; label: string };

export type ChartFrame = {
  width: number; height: number; top: number; bottom: number; plotW: number; axisW: number; bodyW: number;
  /** Where the price axis's text starts, right of the plot. Tighter on a narrow chart so the figures are never clipped. */
  axisPad: number;
  bars: { i: number; x: number; yHigh: number; yLow: number; yTop: number; bodyH: number; up: boolean }[];
  yTicks: { value: number; y: number; text: string }[];
  xTicks: { i: number; x: number; text: string; anchor: "start" | "middle" | "end" }[];
  levels: { kind: ChartLevel["kind"]; price: number; y: number; labelY: number; text: string }[];
  zone: { y: number; h: number } | null;
  last: { y: number; text: string } | null;
};

const fin = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** Candles that are candles: four finite prices, the high on top, the low underneath. */
export function realCandles(raw: unknown): ChartCandle[] {
  if (!Array.isArray(raw)) return [];
  const out: ChartCandle[] = [];
  for (const k of raw as Partial<ChartCandle>[]) {
    if (!k || !fin(k.o) || !fin(k.h) || !fin(k.l) || !fin(k.c)) continue;
    if (k.h < k.l || k.h < Math.max(k.o, k.c) || k.l > Math.min(k.o, k.c)) continue;
    out.push({ t: String(k.t ?? ""), o: k.o, h: k.h, l: k.l, c: k.c });
  }
  return out;
}

/** A round step (1, 2, 2.5 or 5 times a power of ten) that splits `span` into about `target` parts. */
export function niceStep(span: number, target = 6): number {
  if (!(span > 0) || !(target > 0)) return 1;
  const raw = span / target, pow = Math.pow(10, Math.floor(Math.log10(raw))), m = raw / pow;
  const step = m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10;
  return step * pow;
}

export const priceText = (p: number, dec: number): string => p.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec });

/** A candle's stamp as a number. Only ever SUBTRACTED from another stamp of the same feed, so its zone does not matter. */
const stamp = (t: string): number => {
  const s = String(t ?? "").trim();
  if (!s) return NaN;
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(" ", "T")}Z`);
};

/** How long before the latest candle, in the shortest honest words. */
export function agoText(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  if (min < 48 * 60) { const h = min / 60; return `${Number.isInteger(h) ? h : h.toFixed(1)} h`; }
  const d = Math.round(min / 1440);
  return `${d} d`;
}

const AGO_STEPS = [5, 10, 15, 30, 60, 120, 180, 240, 360, 720, 1440, 2880, 4320, 10080].map((m) => m * 60_000);

export function chartFrame(input: {
  candles: ChartCandle[]; price: number | null; levels: ChartLevel[]; zone: { low: number; high: number } | null;
  width: number; height: number; dec: number;
}): ChartFrame | null {
  const { width, height, dec } = input;
  const cs = realCandles(input.candles).slice(-60);
  if (cs.length < 2 || !(width > 120) || !(height > 90)) return null;

  const axisW = width < 420 ? 72 : 80;
  const top = 12, bottom = height - 26, plotW = width - axisW;
  const price = fin(input.price) ? input.price : cs[cs.length - 1].c;

  // The scale is the market's: the candles, and the price that came with them.
  const lo = Math.min(price, ...cs.map((k) => k.l)), hi = Math.max(price, ...cs.map((k) => k.h));
  const span = hi - lo > 0 ? hi - lo : Math.abs(hi) * 0.001 || 1;
  // A level joins the scale only when it is close enough not to flatten the candles.
  const near = (p: number) => fin(p) && p >= lo - span * 0.6 && p <= hi + span * 0.6;
  const shown = input.levels.filter((l) => near(l.price));
  const dLo0 = Math.min(lo, ...shown.map((l) => l.price)), dHi0 = Math.max(hi, ...shown.map((l) => l.price));
  const pad = (dHi0 - dLo0) * 0.1 || span * 0.1;
  const dLo = dLo0 - pad, dHi = dHi0 + pad;
  const y = (p: number) => top + (1 - (p - dLo) / (dHi - dLo)) * (bottom - top);

  const n = cs.length, slot = plotW / n;
  const bodyW = Math.max(2, Math.min(11, slot * 0.58));
  const bars = cs.map((k, i) => {
    const yo = y(k.o), yc = y(k.c);
    return { i, x: (i + 0.5) * slot, yHigh: y(k.h), yLow: y(k.l), yTop: Math.min(yo, yc), bodyH: Math.max(1, Math.abs(yc - yo)), up: k.c >= k.o };
  });

  const step = niceStep(dHi - dLo, Math.max(3, Math.min(7, Math.round((bottom - top) / 40))));
  const yTicks: ChartFrame["yTicks"] = [];
  for (let v = Math.ceil(dLo / step) * step; v <= dHi + 1e-9; v += step) {
    const value = Number(v.toFixed(Math.max(dec, 6)));
    const ty = y(value);
    if (ty >= top - 1 && ty <= bottom + 1) yTicks.push({ value, y: ty, text: priceText(value, dec) });
  }

  // Time marks: round distances back from the latest candle, placed on the candle nearest each.
  const xTicks: ChartFrame["xTicks"] = [];
  const ts = cs.map((k) => stamp(k.t));
  const tLast = ts[n - 1];
  if (ts.every(Number.isFinite) && tLast > ts[0]) {
    const total = tLast - ts[0];
    const want = Math.max(2, Math.min(6, Math.floor(plotW / 130)));
    const unit = AGO_STEPS.find((s) => total / s <= want) ?? AGO_STEPS[AGO_STEPS.length - 1];
    for (let k = 1; k * unit <= total; k++) {
      let best = -1, miss = Infinity;
      for (let i = 0; i < n; i++) { const d = Math.abs(tLast - ts[i] - k * unit); if (d < miss) { miss = d; best = i; } }
      if (best < 0 || miss > unit / 2) continue;             // no candle near that mark (the market was shut): no mark
      const x = (best + 0.5) * slot;
      if (x < 40 || x > plotW - 92) continue;                  // would run off the frame or into "Latest"
      xTicks.push({ i: best, x, text: `${agoText(k * unit)} ago`, anchor: "middle" });
    }
    xTicks.push({ i: n - 1, x: plotW - 2, text: "Latest", anchor: "end" });
    xTicks.sort((a, b) => a.x - b.x);
  }

  // Level labels sit above their line; one that would land on another's label drops beneath its own line.
  const used: number[] = [];
  const levels = shown.map((l) => ({ l, ly: y(l.price) })).sort((a, b) => a.ly - b.ly).map(({ l, ly }) => {
    let labelY = ly - 7;
    if (labelY < 11 || used.some((u) => Math.abs(u - labelY) < 15)) labelY = ly + 16;      // no room above (or another label is there)
    used.push(labelY);
    return { kind: l.kind, price: l.price, y: ly, labelY, text: `${l.label} ${priceText(l.price, dec)}` };
  });

  let zone: ChartFrame["zone"] = null;
  if (input.zone && fin(input.zone.low) && fin(input.zone.high) && input.zone.high > input.zone.low) {
    const zt = Math.max(top, y(input.zone.high)), zb = Math.min(bottom, y(input.zone.low));
    if (zb - zt >= 1) zone = { y: zt, h: zb - zt };
  }

  return {
    width, height, top, bottom, plotW, axisW, axisPad: width < 420 ? 12 : 20, bodyW, bars, yTicks, xTicks, levels, zone,
    last: { y: Math.max(top, Math.min(bottom, y(price))), text: priceText(price, dec) },
  };
}
