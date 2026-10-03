import { series, livePrice } from "@/lib/marketData";
import { liveTickDetail } from "@/lib/flow/liveTicks";
import { closedBars } from "@/lib/mtf";
import { type Row } from "@/lib/genxCompute";
import { type FxPair } from "@/lib/genfx/pairs";
import { usdJpyOk } from "@/lib/genfx/sizing";

/**
 * GEN FX MARKET READS — the live numbers the scanner, the watch and placement need, each asked for
 * once and shared: a fan-out to many accounts makes one request, not one per account, and a scan of
 * three horizons that all read hourly candles reads them once.
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

/**
 * A price, and WHEN IT WAS OBSERVED — the moment this process received the tick or the quote. Two
 * answers with the same `at` are one observation asked for twice: a streamed tick is handed back for
 * as long as it is the newest, and a REST quote is reused for a few seconds. Anything that wants to
 * see a price "twice" (the watch's touch rule) has to compare `at`, not count the asks.
 */
export type Quote = { px: number; at: number };

const priceCache = new Map<string, Quote>();
/** Latest price for a market-data symbol, with its observation time. `maxAgeMs` bounds how old a streamed tick or a cached quote may be. Null when unavailable. */
export async function fxQuote(td: string, maxAgeMs = 3_000): Promise<Quote | null> {
  const tk = liveTickDetail(td);
  if (tk && tk.price > 0 && Date.now() - tk.receivedAt <= Math.max(STREAM_FRESH_MS, maxAgeMs)) return { px: tk.price, at: tk.receivedAt };
  const hit = priceCache.get(td);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit;
  const key = mdKey();
  if (!key) return null;
  try {
    const p = await withTimeout(livePrice(td, key, true), 8_000);
    if (typeof p === "number" && Number.isFinite(p) && p > 0) { const q = { px: p, at: Date.now() }; priceCache.set(td, q); return q; }
  } catch { /* feed down → null */ }
  return null;
}
export async function fxPrice(td: string, maxAgeMs = 3_000): Promise<number | null> { return (await fxQuote(td, maxAgeMs))?.px ?? null; }
export const pairPrice = (pair: FxPair, maxAgeMs?: number) => fxPrice(pair.td, maxAgeMs);
export const pairQuote = (pair: FxPair, maxAgeMs?: number) => fxQuote(pair.td, maxAgeMs);

/**
 * USD/JPY, for turning yen into dollars when sizing GBP/JPY. A rate up to five minutes old is fine for
 * that — it moves a fraction of a percent in five minutes, and the size is rounded to 0.01 lots — but
 * an unbelievable or missing one is null, and sizing refuses without it.
 */
export async function usdJpyRate(): Promise<number | null> {
  const r = await fxPrice("USD/JPY", 5 * 60_000);
  return usdJpyOk(r) ? r : null;
}

/** `p`, or null if it has not answered in `ms`. The timer never outlives the answer. */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  return Promise.race([p, late]).finally(() => { if (timer) clearTimeout(timer); });
}

/**
 * Candles on hand must have been fetched after THIS, or they are fetched again. Every timeframe's
 * candles close on a five-minute boundary, and the feed takes a few seconds to show a candle as
 * closed; a set fetched before then still has the old candle as "forming", and the engine — which
 * drops the forming one — would read the candle before. So: the last five-minute boundary plus eight
 * seconds (the scan's own offset), as seen eight seconds ago.
 */
const FEED_SETTLE_MS = 8_000;
export const candleFloorMs = (nowMs = Date.now()): number => Math.floor((nowMs - FEED_SETTLE_MS) / 300_000) * 300_000 + FEED_SETTLE_MS;
/** The latest five-minute close the feed can be trusted to have in full: the boundary behind that floor. A candle that closed after it may still be missing its last seconds. */
export const settledCloseMs = (nowMs = Date.now()): number => candleFloorMs(nowMs) - FEED_SETTLE_MS;

export type SeriesOut = Row[] | "ratelimit" | null;
const SIZES = [150, 500, 1500, 5000];
const seriesMemo = new Map<string, { at: number; p: Promise<SeriesOut> }>();

/**
 * Candles for the scanner and the watch, oldest → newest, the last one still forming.
 *
 *   • SHARED. The same timeframe is asked for once and handed to everyone who wants it within
 *     `maxAgeMs` — three horizons reading hourly candles, five pending setups confirming on the same
 *     5-minute frame, a scan and a watch pass overlapping. Sizes are rounded up to a few standard
 *     lengths and cut to what was asked for, so 90, 120 and 150 hourly bars are one request.
 *   • BOUNDED. The market-data client has no timeout of its own; a request that hangs would hold the
 *     pass that made it, and the pass holds the GEN FX lock. Twelve seconds, then null — "no data this
 *     time", which every caller already handles.
 *   • FRESH. Always read straight from the feed (never the community cache the page reads go through):
 *     a decision is being made on it.
 *
 * `utc` asks the feed for UTC timestamps — needed wherever a candle is matched to a moment in time
 * (grading). Without it the feed's own clock is used, which is what the engine has always read.
 *
 * `notBeforeMs` refuses a shared copy fetched before that moment, however recent `maxAgeMs` would call
 * it: a decision made just after a candle closes must not be made on candles fetched just before.
 */
export function fxSeries(td: string, interval: string, size: number, o: { utc?: boolean; maxAgeMs?: number; timeoutMs?: number; notBeforeMs?: number } = {}): Promise<SeriesOut> {
  const key = mdKey();
  if (!key) return Promise.resolve(null);
  const want = SIZES.find((n) => n >= size) ?? size;
  const ck = `${td}|${interval}|${want}|${o.utc ? "utc" : ""}`;
  const cut = (rows: SeriesOut): SeriesOut => (Array.isArray(rows) ? rows.slice(-size) : rows);
  const hit = seriesMemo.get(ck);
  if (hit && Date.now() - hit.at < (o.maxAgeMs ?? 4_000) && (o.notBeforeMs == null || hit.at >= o.notBeforeMs)) return hit.p.then(cut);
  const p: Promise<SeriesOut> = withTimeout(series(td, interval, want, key, true, o.utc ? "UTC" : undefined), o.timeoutMs ?? 12_000)
    .catch(() => null)
    .then((rows) => {
      // A miss is not remembered: the next caller asks again rather than inheriting "no data".
      if (!Array.isArray(rows) && seriesMemo.get(ck)?.p === p) seriesMemo.delete(ck);
      return rows;
    });
  seriesMemo.set(ck, { at: Date.now(), p });
  if (seriesMemo.size > 120) { const cutoff = Date.now() - 120_000; for (const [k, v] of seriesMemo) if (v.at < cutoff) seriesMemo.delete(k); }
  return p.then(cut);
}

type Bars = { h: number; l: number; c: number }[];
/** CLOSED bars, oldest → newest (the feed's last row is the bar still forming and is dropped). Null on any failure. */
export async function closedSeries(pair: FxPair, interval: string, size: number, ttlMs = 60_000): Promise<Bars | null> {
  const rows = await fxSeries(pair.td, interval, size, { maxAgeMs: ttlMs, notBeforeMs: candleFloorMs() });
  if (!rows || rows === "ratelimit") return null;
  return (closedBars(rows, Math.min(20, size - 1)) ?? rows)
    .map((r) => ({ h: +r.high, l: +r.low, c: +r.close }))
    .filter((b) => Number.isFinite(b.h) && Number.isFinite(b.l) && Number.isFinite(b.c));
}

/** A feed timestamp ("2026-10-02 14:35:00", asked for in UTC) as milliseconds. NaN when unreadable. */
export const utcMs = (datetime: string): number => {
  const s = String(datetime ?? "").trim().replace(" ", "T");
  if (!s) return NaN;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return Date.parse(`${s}T00:00:00Z`);
  return Date.parse(/(z|[+-]\d{2}:?\d{2})$/i.test(s) ? s : `${s}Z`);
};
