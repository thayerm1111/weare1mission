/**
 * THE PRICE RIGHT NOW (owner 10-01: "when I talk to ATLAS it's behind on actual live price… it doesn't
 * say real price right then and there. It's always a little behind").
 *
 * It was. Everything ATLAS says and everything the screen shows is assembled from the last market
 * snapshot the worker PERSISTED, and that is written about once a minute — measured 67 seconds between
 * snapshots, 88 at worst, with gold moving $0.69 at the median and up to $5.40 between two of them. So
 * a price spoken from the snapshot is, on average, half a minute old.
 *
 * The analysis can be a minute old; the price ATLAS says cannot. So at the moment of an answer the
 * freshest quote there is gets ATTACHED to the snapshot:
 *
 *   1. the newest tick from the streaming feed, which the price stream publishes to market_live_ticks
 *      at most once a second (a second or two old), else
 *   2. for a conversation only, one direct quote from the market-data provider (a fraction of a
 *      second old, one API credit), else
 *   3. nothing — the snapshot's own price stands, and the context says how old it is.
 *
 * ATTACHED, NOT WRITTEN OVER. `snapshot.price` stays what the worker measured, because the setup, the
 * open position's read, protection and every button the member can press are computed from it, and the
 * server recomputes from the same number. A tick-driven price in there would move stops and expire
 * setups on a quote nobody validated. Only what is SAID and SHOWN as "the price" reads the fresher
 * quote (core/priceNow.ts).
 *
 * THE SAME FEED AS THE READ. Both sources are the provider the worker builds its snapshots from, so the
 * fresher price and the bars beside it are the same market. A quote that disagrees wildly with the
 * snapshot is not "fresher", it is wrong (a bad tick, a different symbol), and is refused.
 */
import type { MarketSnapshot } from "../core/types";
import { latestTick } from "../adapters/db";
import { price as tdPrice, GOLD } from "../adapters/twelvedata";

export type LivePrice = { price: number; at: number; source: "stream" | "quote" };

/** A streamed tick older than this is not "now". The screen falls back to the snapshot's price. */
export const TICK_FRESH_MS = 20_000;
/**
 * For a SPOKEN answer the bar is higher: gold ticks every second or two while it trades (measured
 * 0.46 ticks a second in a quiet Asian session), so a newest tick older than this means the stream is
 * quiet or behind, and one direct quote settles which.
 */
export const SPOKEN_TICK_MS = 6_000;
/** A fresher quote more than this far from the snapshot is treated as a bad quote, not as news. */
export const MAX_LIVE_DEVIATION = 0.01;
/** How long a conversation turn will wait for the direct quote before using what it already has. */
export const QUOTE_TIMEOUT_MS = 2_500;

/** Pure: is this published tick fresh enough to say? */
export function freshTick(row: { price: number; receivedAt: number } | null, nowMs: number, maxAgeMs = TICK_FRESH_MS): LivePrice | null {
  if (!row || !(row.price > 0) || !Number.isFinite(row.receivedAt)) return null;
  const age = nowMs - row.receivedAt;
  // A tick "from the future" by more than a few seconds is a clock problem, not a fresh price.
  if (age > maxAgeMs || age < -5_000) return null;
  return { price: row.price, at: Math.min(row.receivedAt, nowMs), source: "stream" };
}

/**
 * Pure: the snapshot with the fresher quote ATTACHED — or the snapshot untouched when there is none,
 * when it is not actually newer, or when it is implausibly far from the read.
 *
 * `price`, bid/ask and every measurement stay exactly as the worker wrote them.
 */
export function withLivePrice(s: MarketSnapshot, live: LivePrice | null): MarketSnapshot {
  if (!live || !(live.price > 0) || live.at <= s.at) return s;
  if (!(s.price > 0) || Math.abs(live.price - s.price) / s.price > MAX_LIVE_DEVIATION) return s;
  return { ...s, live: { price: live.price, at: live.at, source: live.source } };
}

/** Where the two quotes come from. Swappable so the choice between them can be tested without a network. */
export type LivePriceSources = {
  tick: () => Promise<{ price: number; receivedAt: number } | null>;
  quote: () => Promise<number | null>;
};

const SOURCES: LivePriceSources = {
  tick: () => latestTick(GOLD),
  quote: async () => {
    const key = process.env.TWELVEDATA_API_KEY;
    if (!key) return null;
    const q = await tdPrice(key, GOLD, QUOTE_TIMEOUT_MS);
    return q.ok ? q.data : null;
  },
};

/**
 * The freshest gold price available right now, or null.
 *
 * `allowQuote` is for conversation turns: one direct provider call when the stream's newest tick is
 * more than a few seconds old. The screen polls every five seconds per viewer and must not spend an
 * API credit each time, so it reads the stream only and otherwise shows the snapshot's price as it
 * always has. A tick that is older than the spoken bar but still fresh is kept as the answer if the
 * direct quote does not come back — it still beats the snapshot.
 */
export async function liveGoldPrice(
  opts: { allowQuote?: boolean; nowMs?: number } = {},
  sources: LivePriceSources = SOURCES,
): Promise<LivePrice | null> {
  const now = opts.nowMs ?? Date.now();
  const tick = freshTick(await sources.tick(), now);
  if (!opts.allowQuote) return tick;
  if (tick && now - tick.at <= SPOKEN_TICK_MS) return tick;
  const q = await sources.quote();
  if (q != null && q > 0) return { price: q, at: opts.nowMs ?? Date.now(), source: "quote" };
  return tick;
}
