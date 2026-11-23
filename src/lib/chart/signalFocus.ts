import type { TimedBar } from "@/lib/chart/candleTime";
import type { ChartLevel } from "@/lib/floor/chart";
import { orderedLevelLabels } from "@/lib/chart/levelLabels";

export type SignalDirection = "buy" | "sell" | "neutral";
type Zone = { low: number; high: number } | null;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Only recorded bars survive. The overview uses five; its expanded chart keeps the full history. */
function historyOf(raw: readonly TimedBar[]): TimedBar[] {
  const byTime = new Map<number, TimedBar>();
  if (!Array.isArray(raw)) return [];
  for (const bar of raw) {
    if (!bar || ![bar.t, bar.o, bar.h, bar.l, bar.c].every(finite)) continue;
    if (bar.h < Math.max(bar.o, bar.c, bar.l) || bar.l > Math.min(bar.o, bar.c, bar.h)) continue;
    byTime.set(bar.t, { t: bar.t, o: bar.o, h: bar.h, l: bar.l, c: bar.c });
  }
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}

/**
 * Two explicitly separate diagrams: real candles fitted to their own OHLC range, and a conditional
 * path fitted to the recorded trade levels. Neither coordinates nor spacing on the right imply time.
 * Distant targets therefore never flatten the five actual candles. No price or candle is invented.
 */
export function signalFocusModel(input: {
  bars: readonly TimedBar[]; levels: readonly ChartLevel[]; price: number | null;
  zone?: Zone; direction: SignalDirection; width: number; height?: number;
}) {
  const history = historyOf(input.bars), recent = history.slice(-5);
  const width = Math.max(240, finite(input.width) ? input.width : 640);
  const height = Math.max(220, finite(input.height) ? input.height : 260);
  const top = 32, bottom = height - 28;
  const valid = Array.isArray(input.levels) ? input.levels.filter((level) => level && finite(level.price)
    && typeof level.label === "string" && ["entry", "stop", "target", "support", "resistance"].includes(level.kind)) : [];
  const entry = valid.find((level) => level.kind === "entry"), stop = valid.find((level) => level.kind === "stop");
  const targets = valid.filter((level) => level.kind === "target").slice(0, 3);
  const directional = input.direction === "buy" || input.direction === "sell";
  const plan = directional ? [...(entry ? [entry] : []), ...(stop ? [stop] : []), ...targets] : [];
  const levels = plan.length ? plan : valid.filter((level) => level.kind === "support" || level.kind === "resistance").slice(0, 2);
  const zone = directional && input.zone && finite(input.zone.low) && finite(input.zone.high) && input.zone.high > input.zone.low
    ? { low: input.zone.low, high: input.zone.high } : null;
  const split = levels.length > 0 || zone !== null;
  const labelWidth = width < 480 ? 84 : 112;
  const laneRight = width - labelWidth - 9;
  const divider = split ? Math.min(width * (width < 480 ? 0.44 : 0.48), laneRight - 46) : width;
  const laneLeft = divider + 12;
  const candleLeft = 12, candleRight = divider - (split ? 14 : 12);
  const candleLow = recent.length ? Math.min(...recent.map((bar) => bar.l)) : null;
  const candleHigh = recent.length ? Math.max(...recent.map((bar) => bar.h)) : null;
  const candleRange = candleLow !== null && candleHigh !== null ? Math.max(candleHigh - candleLow, Math.abs(candleHigh) * 0.00002, 0.000001) : 1;
  const candleMin = (candleLow ?? 0) - candleRange * 0.12;
  const candleMax = (candleHigh ?? 1) + candleRange * 0.12;
  const candleY = (price: number) => bottom - (price - candleMin) / (candleMax - candleMin) * (bottom - top);
  const slot = (candleRight - candleLeft) / Math.max(1, recent.length);
  const bodyWidth = Math.max(5, Math.min(34, slot * 0.58));
  const candles = recent.map((bar, i) => ({
    ...bar, x: candleLeft + (i + 0.5) * slot, bodyWidth,
    highY: candleY(bar.h), lowY: candleY(bar.l), openY: candleY(bar.o), closeY: candleY(bar.c),
    bodyY: Math.min(candleY(bar.o), candleY(bar.c)), bodyHeight: Math.max(1.5, Math.abs(candleY(bar.o) - candleY(bar.c))),
    up: bar.c >= bar.o,
  }));
  const startPrice = finite(input.price) ? input.price : recent.at(-1)?.c ?? null;
  const values = [...levels.map((level) => level.price), ...(zone ? [zone.low, zone.high] : []), ...(startPrice === null ? [] : [startPrice])];
  const low = values.length ? Math.min(...values) : 0, high = values.length ? Math.max(...values) : 1;
  const range = Math.max(high - low, Math.abs(high) * 0.00002, 0.000001);
  const levelMin = low - range * 0.12, levelMax = high + range * 0.12;
  const levelY = (price: number) => bottom - (price - levelMin) / (levelMax - levelMin) * (bottom - top);
  const marks = orderedLevelLabels(levels.map((level) => ({ ...level, ly: levelY(level.price) })), top + 17, bottom, 35);
  const zoneBox = zone ? { ...zone, y: levelY(zone.high), height: Math.max(1, levelY(zone.low) - levelY(zone.high)) } : null;
  // This is a diagram of the supplied plan, not another trading decision. Contradictory/missing levels
  // stay labelled but gain no directional path, and HOLD cannot infer a setup from a bearish/bullish bias.
  const suppliedStops = Array.isArray(input.levels) ? input.levels.filter((level) => level?.kind === "stop") : [];
  const stopFits = entry && suppliedStops.every((level) => finite(level.price)
    && (input.direction === "buy" ? level.price < entry.price : input.direction === "sell" && level.price > entry.price));
  const correctDirection = directional && entry && stopFits && targets.length > 0 && targets.every((target, i) => input.direction === "buy"
    ? target.price > entry.price && (i === 0 || target.price > targets[i - 1].price)
    : target.price < entry.price && (i === 0 || target.price < targets[i - 1].price));
  const entryX = laneLeft + Math.max(8, (laneRight - laneLeft) * 0.22);
  const scenario = correctDirection && entry && startPrice !== null ? [
    { kind: "start", price: startPrice, x: laneLeft, y: levelY(startPrice) },
    { kind: "entry", price: entry.price, x: entryX, y: levelY(entry.price) },
    ...targets.map((target, i) => ({ kind: "target", price: target.price, x: entryX + (i + 1) / targets.length * (laneRight - entryX), y: levelY(target.price) })),
  ] : null;
  return { history, recent, width, height, top, bottom, split, divider, laneLeft, laneRight,
    candleLow, candleHigh, candles, marks, zone: zoneBox, scenario, startPrice };
}
