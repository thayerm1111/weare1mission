/*
 * Cashtrap test helpers: hand-built 5-minute candle series with a support swing and a sell-off into
 * it, so each rule can be exercised on a candle whose indicator values are known to qualify.
 */
import { M5, type Candle } from "../src/lib/cashtrap/candles";
import { effectiveConfig, DEFAULT_ASSUMPTIONS, resolveAssumptions, type Assumptions } from "../src/lib/cashtrap/config";
import { atr } from "../src/lib/cashtrap/indicators";
import { autoZonesAt, type Zone } from "../src/lib/cashtrap/zones";

/** Tuesday 6 October 2026, 00:00 UTC — the fx and gold markets are open all through the series. */
export const T_START = Date.UTC(2026, 9, 6, 0, 0, 0);

export const cfgWith = (over: Partial<Assumptions> = {}) => {
  const r = resolveAssumptions({ ...DEFAULT_ASSUMPTIONS, ...over });
  if (!r.ok) throw new Error(r.errors.join("; "));
  return effectiveConfig(r.value);
};

const k = (t: number, o: number, h: number, l: number, c: number): Candle => ({ t, o, h, l, c });

/** Calm oscillation around `mid`, `n` candles from `t0`. */
export function calm(n: number, t0 = T_START, mid = 100, amp = 0.06): Candle[] {
  const out: Candle[] = [];
  let prev = mid;
  for (let i = 0; i < n; i++) {
    const c = +(mid + amp * Math.sin(i / 5)).toFixed(5);
    const o = prev;
    out.push(k(t0 + i * M5, o, +(Math.max(o, c) + 0.02).toFixed(5), +(Math.min(o, c) - 0.02).toFixed(5), c));
    prev = c;
  }
  return out;
}

/** Append candles given as [open, high, low, close]. */
export function then(series: Candle[], bars: Array<[number, number, number, number]>): Candle[] {
  const out = [...series];
  let t = out.length ? out[out.length - 1].t + M5 : T_START;
  for (const [o, h, l, c] of bars) { out.push(k(t, o, h, l, c)); t += M5; }
  return out;
}

/**
 * The BUY scenario: 400 calm candles; a swing low at 99.60 (support); a flat stretch at 100; a
 * four-candle sell-off; and — returned separately — the support zone, so the exhaustion candle can be
 * built to touch it: low inside the zone, close just above the zone's upper edge.
 */
export function buyScenario(cfgA: Assumptions = DEFAULT_ASSUMPTIONS): { before: Candle[]; zone: Zone; exhaustion: [number, number, number, number] } {
  let s = calm(400);
  s = then(s, [
    [100.0, 100.02, 99.9, 99.92], [99.92, 99.94, 99.8, 99.82], [99.82, 99.84, 99.7, 99.72],
    [99.72, 99.74, 99.6, 99.66],                                  // the swing low: 99.60
    [99.66, 99.8, 99.64, 99.78], [99.78, 99.92, 99.76, 99.9],     // two higher lows confirm it
    [99.9, 100.02, 99.88, 100.0],
  ]);
  for (let i = 0; i < 22; i++) s = then(s, [[100.0, 100.01, 99.99, 100.0]]);
  s = then(s, [[100.0, 100.0, 99.88, 99.9], [99.9, 99.9, 99.78, 99.8], [99.8, 99.8, 99.7, 99.72], [99.72, 99.72, 99.64, 99.66]]);
  const a = atr(s.map((x) => x.h), s.map((x) => x.l), s.map((x) => x.c), cfgA.zones.atrLength);
  const zones = autoZonesAt("EURUSD", [...s, { t: s[s.length - 1].t + M5, o: 0, h: 0, l: 0, c: 0 }], [...a, null], s.length, cfgA.zones);
  const zone = zones.find((z) => z.kind === "support" && Math.abs(z.center - 99.6) < 1e-9);
  if (!zone) throw new Error("scenario: support zone at 99.60 not found");
  const o = 99.66;
  return { before: s, zone, exhaustion: [o, o + 0.005, zone.center - 0.001, +(zone.upper + 0.002).toFixed(5)] };
}

export const nextT = (s: Candle[]) => s[s.length - 1].t + M5;
