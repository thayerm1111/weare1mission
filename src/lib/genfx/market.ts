import { series, livePrice } from "@/lib/marketData";
import { liveTickDetail } from "@/lib/flow/liveTicks";
import { closedBars } from "@/lib/mtf";
import { type FxPair } from "@/lib/genfx/pairs";
import { usdJpyOk } from "@/lib/genfx/sizing";

/**
 * GEN FX MARKET READS — the handful of live numbers placement and the watch need, each with a short
 * in-process cache so a fan-out to many accounts makes one request, not one per account.
 *
 * On the worker a streamed tick answers first (worker/priceStream.ts subscribes EUR/USD, GBP/JPY and
 * USD/JPY); everywhere else, and whenever the stream is quiet, it is a REST quote.
 */
const mdKey = () => process.env.TWELVEDATA_API_KEY ?? "";

/**
 * A streamed tick is the newest price there is for as long as the stream keeps delivering. Its age is
 * measured from when THIS process received it, not from the provider's own timestamp: the provider
 * stamps every tick with the start of its minute (found on gold, 09-16), so by that clock a tick looks
 * up to a minute old the instant it arrives and a "2.5 seconds fresh" test passes for only the first
 * 2.5 seconds of each minute. Four seconds without a tick on a major pair means the stream has
 * stalled or the market is shut, and the quote is asked for instead.
 */
const STREAM_FRESH_MS = 4_000;

const priceCache = new Map<string, { at: number; px: number }>();
/** Latest price for a market-data symbol. `maxAgeMs` bounds how old a streamed tick or a cached quote may be. Null when unavailable. */
export async function fxPrice(td: string, maxAgeMs = 3_000): Promise<number | null> {
  const tk = liveTickDetail(td);
  if (tk && tk.price > 0 && Date.now() - tk.receivedAt <= Math.max(STREAM_FRESH_MS, maxAgeMs)) return tk.price;
  const hit = priceCache.get(td);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.px;
  const key = mdKey();
  if (!key) return null;
  try {
    const p = await livePrice(td, key, true);
    if (typeof p === "number" && Number.isFinite(p) && p > 0) { priceCache.set(td, { at: Date.now(), px: p }); return p; }
  } catch { /* feed down → null */ }
  return null;
}
export const pairPrice = (pair: FxPair, maxAgeMs?: number) => fxPrice(pair.td, maxAgeMs);

/**
 * USD/JPY, for turning yen into dollars when sizing GBP/JPY. A rate up to five minutes old is fine for
 * that — it moves a fraction of a percent in five minutes, and the size is rounded to 0.01 lots — but
 * an unbelievable or missing one is null, and sizing refuses without it.
 */
export async function usdJpyRate(): Promise<number | null> {
  const r = await fxPrice("USD/JPY", 5 * 60_000);
  return usdJpyOk(r) ? r : null;
}

type Bars = { h: number; l: number; c: number }[];
const barCache = new Map<string, { at: number; bars: Bars }>();
/** CLOSED bars, oldest → newest (the feed's last row is the bar still forming and is dropped). Null on any failure. */
export async function closedSeries(pair: FxPair, interval: string, size: number, ttlMs = 60_000): Promise<Bars | null> {
  const ck = `${pair.td}:${interval}:${size}`;
  const hit = barCache.get(ck);
  if (hit && Date.now() - hit.at < ttlMs) return hit.bars;
  const key = mdKey();
  if (!key) return null;
  try {
    const rows = await series(pair.td, interval, size, key);
    if (!rows || rows === "ratelimit" || !Array.isArray(rows)) return null;
    const bars = (closedBars(rows, Math.min(20, size - 1)) ?? rows)
      .map((r) => ({ h: +r.high, l: +r.low, c: +r.close }))
      .filter((b) => Number.isFinite(b.h) && Number.isFinite(b.l) && Number.isFinite(b.c));
    barCache.set(ck, { at: Date.now(), bars });
    return bars;
  } catch { return null; }
}
