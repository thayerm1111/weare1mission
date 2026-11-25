import { createAdminClient } from "@/lib/supabase/admin";
import { series } from "@/lib/marketData";
import { isOpen } from "@/lib/cashtrap/marketHours";
import { analyzePriceAction, type Bar, type Analysis } from "./engine";
import { createStrataCandleFeed, delayedStrataFrames, StrataFeedError, strataTickQuote } from "./feedData";
export { StrataFeedError } from "./feedData";

export type StrataState = {
  analysis: Analysis; candles: Bar[]; bars: { m5: Bar[]; m15: Bar[]; h1: Bar[]; h4: Bar[] }; lastCandleAt: string; asOf: string;
  price: number; quoteSource: "stream" | "delayed" | "candle"; quoteReceivedAt: string | null; quoteProviderAt: string | null;
  marketClosed: boolean; dataStale: boolean; timeframe: "15m";
};

const feed = createStrataCandleFeed(async (interval, count) => {
  const key = process.env.TWELVEDATA_API_KEY;
  if (!key) throw new StrataFeedError("marketdata_not_configured", "Gold market data is not configured. Please contact support.");
  return series("XAU/USD", interval, count, key, false, "UTC");
}, { providerCacheMs: Number(process.env.MD_CACHE_TTL || 30) * 1_000 });

/** Same authenticated four-frame analysis; generation refreshes local candles,
 * while cache/governor, strategy thresholds and paper execution stay intact. */
export async function getStrataState({ refresh = false }: { refresh?: boolean } = {}): Promise<StrataState | null> {
  const raw = await feed.read(refresh);
  const now = Date.now(), open = isOpen("metal", now);
  const analysis = analyzePriceAction({ ...raw, now, open });
  if (!analysis) return null;
  const last = raw.m15[raw.m15.length - 1];
  const delayed = open ? delayedStrataFrames(raw, now) : [];
  const stale = delayed.length > 0;
  if (stale) {
    analysis.warnings.push("The " + delayed.join(", ") + " closed-candle data is delayed. Refresh before using an entry.");
    if (analysis.primary) analysis.primary = { ...analysis.primary, stage: "watch", reference: true };
    if (analysis.secondary) analysis.secondary = { ...analysis.secondary, stage: "watch", reference: true };
    analysis.status = "NO_SETUP";
  }
  let quote: Pick<StrataState, "price" | "quoteSource" | "quoteReceivedAt" | "quoteProviderAt"> = {
    price: last.c, quoteSource: "candle", quoteReceivedAt: null, quoteProviderAt: null,
  };
  if (open) {
    const admin = createAdminClient();
    if (admin) {
      try {
        const { data } = await admin.from("market_live_ticks")
          .select("price,received_at,tick_at").eq("symbol", "XAU/USD")
          .abortSignal(AbortSignal.timeout(2_000)).maybeSingle();
        quote = strataTickQuote(data, last.c, Date.now()) ?? quote;
      } catch { /* Real closed-candle fallback; never claim a current stream. */ }
    }
  }
  return {
    analysis, candles: raw.m15, bars: { m5: raw.m5, m15: raw.m15, h1: raw.h1, h4: raw.h4 },
    lastCandleAt: new Date(last.t).toISOString(), asOf: new Date(raw.computedAt).toISOString(), ...quote,
    marketClosed: !open, dataStale: stale, timeframe: "15m",
  };
}
