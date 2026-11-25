import { stampMs, type TimedBar } from "../chart/candleTime";
import {
  ATLAS_FRAMES, buildAtlasMarketSnapshot, type AtlasFrameId, type AtlasFrameInput,
  type AtlasMarketSnapshot, type AtlasMarketSymbol,
} from "./marketIntelligence";

type ProviderRow = { datetime: string; open: string; high: string; low: string; close: string };
export type AtlasSeriesLoader = (symbol: string, interval: string, count: number, timezone: "UTC") =>
  Promise<ProviderRow[] | "ratelimit" | null>;
const SYMBOLS: Record<AtlasMarketSymbol, string> = {
  XAUUSD: "XAU/USD", EURUSD: "EUR/USD", GBPJPY: "GBP/JPY", USDJPY: "USD/JPY",
};
const TTL: Record<AtlasFrameId, number> = {
  "1d": 300_000, "4h": 120_000, "1h": 60_000, "30m": 60_000, "15m": 30_000, "5m": 20_000,
};
const COUNT = 140;
function candle(row: ProviderRow): TimedBar | null {
  // Daily labels retain the provider's session date. The domain builder treats
  // these as date-only and proves closure using a later actual daily row; it
  // never claims that date+24h is the exchange's exact close instant.
  const t=stampMs(row.datetime);
  const b={t,o:Number(row.open),h:Number(row.high),l:Number(row.low),c:Number(row.close)};
  return Number.isFinite(t) && t>0 && [b.o,b.h,b.l,b.c].every(v => Number.isFinite(v) && v>0) &&
    b.h>=Math.max(b.o,b.c,b.l) && b.l<=Math.min(b.o,b.c,b.h) ? b : null;
}

/** Per-symbol/frame cache and in-flight coalescing sit above the existing
 * shared provider cache/governor. No member identity or gated signal is cached.
 * Failure preserves the original fetchedAt and explicitly marks old data stale. */
export function createAtlasSnapshotFeed(load: AtlasSeriesLoader, clock: () => number = Date.now, providerCacheMs=30_000) {
  const cache=new Map<string,{expiresAt:number;value:AtlasFrameInput}>();
  const pending=new Map<string,Promise<AtlasFrameInput>>();
  // series() intentionally shares cached OHLC without exposing its retrieval
  // timestamp. Allow its entire cache window plus a small settlement margin
  // before treating an intraday row as closed; never bypass the governor.
  const closeGrace=(Number.isFinite(providerCacheMs)?Math.max(0,providerCacheMs):30_000)+5_000;

  async function frame(symbol: AtlasMarketSymbol, config: typeof ATLAS_FRAMES[number]): Promise<AtlasFrameInput> {
    const key=symbol+":"+config.id;
    const now=clock(), old=cache.get(key);
    if (old && now<old.expiresAt) return old.value;
    const underway=pending.get(key);
    if (underway) return underway;
    const work=(async () => {
      let timer: ReturnType<typeof setTimeout>|undefined;
      let rows: ProviderRow[]|"ratelimit"|null=null;
      let error: string|null=null;
      try {
        rows=await Promise.race([
          load(SYMBOLS[symbol],config.interval,COUNT,"UTC"),
          new Promise<null>(resolve => { timer=setTimeout(() => resolve(null),8_000); }),
        ]);
        if (rows === "ratelimit") error="Market-data provider is temporarily rate limited.";
        else if (!Array.isArray(rows) || rows.length===0) error="Market-data provider did not return this timeframe.";
      } catch {
        error="Market-data provider did not return this timeframe.";
      } finally {
        if (timer) clearTimeout(timer);
      }
      const bars=Array.isArray(rows) ? rows.map(candle).filter((b): b is TimedBar => b!==null) : [];
      if (!bars.length && !error) error="Market-data provider returned no valid candles.";
      const at=clock();
      const dateOnly=config.id === "1d";
      // Request-start cutoff also covers time spent waiting for the response.
      const value: AtlasFrameInput=error
        ? {...(old?.value ?? {bars:[],fetchedAt:at,timeKnown:!dateOnly,dateOnly}),error}
        : {bars,fetchedAt:at,timeKnown:!dateOnly,dateOnly,closedBefore:now-closeGrace,error:null};
      // Daily/hourly pulls are reused longer, but a candle boundary causes a
      // timely refresh. The underlying community cache still governs credits.
      const boundary=(Math.floor(at/config.ms)+1)*config.ms+1_000;
      cache.set(key,{value,expiresAt:error ? at+20_000 : Math.min(at+TTL[config.id],boundary)});
      return value;
    })();
    pending.set(key,work);
    try { return await work; }
    finally { if (pending.get(key)===work) pending.delete(key); }
  }

  return {
    async get(symbol: AtlasMarketSymbol, marketOpen: boolean): Promise<AtlasMarketSnapshot> {
      const values=await Promise.all(ATLAS_FRAMES.map(config => frame(symbol,config)));
      const frames=Object.fromEntries(ATLAS_FRAMES.map((config,i) => [config.id,values[i]])) as Record<AtlasFrameId,AtlasFrameInput>;
      return buildAtlasMarketSnapshot({symbol,frames,now:clock(),marketOpen});
    },
  };
}
