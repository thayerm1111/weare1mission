import { isOpen } from "../cashtrap/marketHours";
import { completedBars, type Bar } from "./engine";

export const STRATA_FRAMES = [
  { key: "m5", label: "5m", interval: "5min", ms: 300_000, count: 220, minimum: 30 },
  { key: "m15", label: "15m", interval: "15min", ms: 900_000, count: 220, minimum: 80 },
  { key: "h1", label: "1h", interval: "1h", ms: 3_600_000, count: 130, minimum: 50 },
  { key: "h4", label: "4h", interval: "4h", ms: 14_400_000, count: 90, minimum: 25 },
] as const;
type Frame = typeof STRATA_FRAMES[number];
export type StrataCandles = Record<Frame["key"], Bar[]> & { computedAt: number };
type Row = { datetime: string; open: string; high: string; low: string; close: string };
type Loader = (interval: string, count: number) => Promise<Row[] | "ratelimit" | null>;

export class StrataFeedError extends Error {
  constructor(public code: string, message: string, public timeframe?: string) {
    super(message); this.name = "StrataFeedError";
  }
}

function candle(row: Row): Bar {
  const stamp = String(row.datetime ?? "");
  const t = Date.parse(/[zZ]$|[+-]\d\d:?\d\d$/.test(stamp) ? stamp : stamp.replace(" ", "T") + "Z");
  return { t, o: Number(row.open), h: Number(row.high), l: Number(row.low), c: Number(row.close) };
}

/** Bounded, coalesced native-frame loading. Explicit Generate skips only this
 * local cache; the existing shared provider cache and credit governor still apply. */
export function createStrataCandleFeed(load: Loader, options: {
  clock?: () => number; deadlineMs?: number; providerCacheMs?: number;
} = {}) {
  const clock = options.clock ?? Date.now;
  const deadlineMs = options.deadlineMs ?? 9_000;
  const cacheMs = Number.isFinite(options.providerCacheMs) ? Math.max(0, options.providerCacheMs!) : 30_000;
  let cache: { at: number; value: StrataCandles } | null = null;
  let pending: Promise<StrataCandles> | null = null;

  async function frame(tf: Frame, startedAt: number): Promise<Bar[]> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const rows = await Promise.race([
        load(tf.interval, tf.count),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new StrataFeedError("marketdata_timeout",
            "The " + tf.label + " gold data request timed out. Try Generate again.", tf.label)), deadlineMs);
        }),
      ]);
      if (rows === "ratelimit") throw new StrataFeedError("marketdata_rate_limited",
        "Gold market data is temporarily busy. Try Generate again shortly.", tf.label);
      if (!Array.isArray(rows)) throw new StrataFeedError("marketdata_unavailable",
        "The " + tf.label + " gold candles could not be loaded. Try Generate again.", tf.label);
      // A provider-cache hit can contain partial OHLC. Response latency and a
      // later clock tick must never turn that cached row into a confirmed close.
      const bars = completedBars(rows.map(candle), tf.ms, startedAt - cacheMs - 5_000);
      if (bars.length < tf.minimum) throw new StrataFeedError("insufficient_history",
        "Not enough verified " + tf.label + " gold history is available yet. Try Generate again after the feed refreshes.", tf.label);
      return bars;
    } catch (error) {
      if (error instanceof StrataFeedError) throw error;
      throw new StrataFeedError("marketdata_unavailable",
        "The " + tf.label + " gold candles could not be loaded. Try Generate again.", tf.label);
    } finally { if (timer) clearTimeout(timer); }
  }

  return {
    async read(refresh = false): Promise<StrataCandles> {
      if (pending) return pending;
      if (!refresh && cache && clock() - cache.at < 25_000) return cache.value;
      const startedAt = clock();
      const work = (async () => {
        const results = await Promise.allSettled(STRATA_FRAMES.map(tf => frame(tf, startedAt)));
        const failure = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
        if (failure) throw failure.reason;
        const frames = Object.fromEntries(STRATA_FRAMES.map((tf, i) => [tf.key,
          (results[i] as PromiseFulfilledResult<Bar[]>).value])) as Record<Frame["key"], Bar[]>;
        const value = { ...frames, computedAt: startedAt };
        cache = { at: clock(), value };
        return value;
      })();
      pending = work;
      try { return await work; }
      finally { if (pending === work) pending = null; }
    },
  };
}

/** Count trading minutes, so a normal weekend/session break is not a feed outage. */
export function delayedStrataFrames(raw: StrataCandles, now: number): string[] {
  return STRATA_FRAMES.filter(tf => {
    const last = raw[tf.key].at(-1);
    if (!last || !Number.isFinite(last.t) || last.t > now) return true;
    const closedAt = last.t + tf.ms, allowance = tf.ms * 2 + 120_000;
    if (now - closedAt <= allowance) return false;
    if (now - closedAt > 8 * 86_400_000) return true;
    let elapsed = 0;
    for (let t = closedAt; t < now;) {
      const end = Math.min(now, (Math.floor(t / 60_000) + 1) * 60_000);
      if (isOpen("metal", t + (end - t) / 2)) elapsed += end - t;
      if (elapsed > allowance) return true;
      t = end;
    }
    return false;
  }).map(tf => tf.label);
}

export type StrataTick = { price: unknown; received_at: unknown; tick_at?: unknown };
export function strataTickQuote(tick: StrataTick | null, reference: number, now: number) {
  if (!tick) return null;
  const price = Number(tick.price);
  const received = typeof tick.received_at === "string" ? Date.parse(tick.received_at) : NaN;
  const hasProvider = tick.tick_at != null && tick.tick_at !== "";
  const provider = typeof tick.tick_at === "string" ? Date.parse(tick.tick_at) : NaN;
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(received) || received > now + 3_000 ||
    (hasProvider && (!Number.isFinite(provider) || provider > now + 3_000)) ||
    Math.abs(price - reference) / Math.max(1, reference) >= .025) return null;
  const at = hasProvider ? Math.min(provider, received) : received;
  if (now - at > 60_000 || now - received > 60_000) return null;
  const fresh = now - at <= 6_000 && now - received <= 6_000;
  return { price, quoteSource: fresh ? "stream" as const : "delayed" as const,
    quoteReceivedAt: new Date(received).toISOString(),
    quoteProviderAt: hasProvider ? new Date(provider).toISOString() : null };
}
