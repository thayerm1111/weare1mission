import type { Bar } from "../core/types";

/**
 * Twelve Data, used for ANALYTICAL CONTEXT only.
 *
 * Its documented price stream gives a single price, not an executable bid/ask, so nothing here is
 * ever used to decide an entry price, a spread, or whether a stop is legal. Fabricating a bid/ask by
 * subtracting a constant spread from this feed would produce numbers that look executable and are
 * not. Execution authority is the connected account's own quote, always.
 *
 * Rapid keeps its own key budget rather than sharing another product's, so a burst here cannot
 * starve an existing tool.
 */

const BASE = "https://api.twelvedata.com";
const KEY = () => process.env.TWELVEDATA_API_KEY || "";

export type BarFetch = { ok: true; bars: Bar[]; source: "twelvedata" } | { ok: false; error: string };

const INTERVALS: Record<number, string> = { 1: "1min", 5: "5min", 15: "15min", 60: "1h", 240: "4h", 1440: "1day" };

export async function fetchBars(symbol: string, minutes: number, outputsize = 1000): Promise<BarFetch> {
  const key = KEY();
  if (!key) return { ok: false, error: "TWELVEDATA_API_KEY is not configured" };
  const interval = INTERVALS[minutes];
  if (!interval) return { ok: false, error: `unsupported interval: ${minutes}m` };

  const url = `${BASE}/time_series?symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=${Math.min(5000, outputsize)}&order=ASC&timezone=UTC&apikey=${encodeURIComponent(key)}`;
  try {
    const res = await fetch(url, { cache: "no-store" });
    const body = (await res.json()) as { status?: string; message?: string; values?: Array<Record<string, string>> };
    if (body.status === "error") return { ok: false, error: body.message ?? "twelvedata error" };
    if (!Array.isArray(body.values)) return { ok: false, error: "twelvedata returned no series" };

    const bars: Bar[] = [];
    for (const v of body.values) {
      // The provider labels a bar by its OPEN time in the requested timezone.
      const t = Date.parse(`${v.datetime.replace(" ", "T")}Z`);
      const o = Number(v.open), h = Number(v.high), l = Number(v.low), c = Number(v.close);
      if (!Number.isFinite(t) || !(h >= l) || !(o > 0) || !(c > 0)) continue;
      bars.push({ t, o, h, l, c, v: v.volume ? Number(v.volume) : null });
    }
    bars.sort((a, b) => a.t - b.t);
    return { ok: true, bars, source: "twelvedata" };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
}

/**
 * The provider's most recent bar is usually still FORMING. Returning it as closed would mean
 * back-filling a developing candle with values it does not yet have.
 */
export function dropForming(bars: Bar[], minutes: number, now: number): Bar[] {
  const ms = minutes * 60_000;
  let n = bars.length;
  while (n > 0 && bars[n - 1].t + ms > now) n--;
  return n === bars.length ? bars : bars.slice(0, n);
}
