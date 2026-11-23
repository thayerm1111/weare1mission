import { createAdminClient } from "@/lib/supabase/admin";
import { series, type Row } from "@/lib/marketData";
import { isOpen } from "@/lib/cashtrap/marketHours";
import { analyzePriceAction, completedBars, type Bar, type Analysis } from "./engine";

/**
 * STRATA four-timeframe OHLC feed. All data requested UTC and only completed
 * candles reach the price-action engine. Shared 25s app cache + existing global
 * Twelve Data credit governor prevent each visitor from triggering four pulls.
 */
const TF = [
  { key: "m5", interval: "5min", ms: 300000, count: 220 },
  { key: "m15", interval: "15min", ms: 900000, count: 220 },
  { key: "h1", interval: "1h", ms: 3600000, count: 130 },
  { key: "h4", interval: "4h", ms: 14400000, count: 90 },
] as const;
type Raw = { m5: Bar[]; m15: Bar[]; h1: Bar[]; h4: Bar[]; computedAt: number };
export type StrataState = {
  analysis: Analysis; candles: Bar[]; lastCandleAt: string; asOf: string;
  price: number; quoteSource: "stream" | "candle"; quoteReceivedAt: string | null;
  marketClosed: boolean; dataStale: boolean; timeframe: "15m";
};
const TTL = 25000;
let cache: { at: number; value: Raw } | null = null;
let promise: Promise<Raw | null> | null = null;

function candle(row: Row): Bar | null {
  const stamp = String(row.datetime ?? "");
  const t = Date.parse(/[zZ]$|[+-]\d\d:?\d\d$/.test(stamp) ? stamp : stamp.replace(" ", "T") + "Z");
  const bar = { t, o: Number(row.open), h: Number(row.high), l: Number(row.low), c: Number(row.close) };
  return Number.isFinite(t) && [bar.o,bar.h,bar.l,bar.c].every(Number.isFinite) ? bar : null;
}
async function rawRead(): Promise<Raw | null> {
  if (cache && Date.now() - cache.at < TTL) return cache.value;
  if (promise) return promise;
  const current = (async () => {
    const key = process.env.TWELVEDATA_API_KEY;
    if (!key) return null;
    const now = Date.now();
    const results = await Promise.all(TF.map(async (tf) => {
      const rows = await series("XAU/USD", tf.interval, tf.count, key, false, "UTC");
      if (!Array.isArray(rows)) return null;
      return completedBars(rows.map(candle).filter((x): x is Bar => x !== null), tf.ms, now);
    }));
    if (results.some((r) => r === null)) return null;
    const [m5, m15, h1, h4] = results as Bar[][];
    if (m5.length < 30 || m15.length < 80 || h1.length < 50 || h4.length < 25) return null;
    const value: Raw = { m5, m15, h1, h4, computedAt: now };
    cache = { at: Date.now(), value };
    return value;
  })();
  promise = current;
  try { return await current; }
  finally { if (promise === current) promise = null; }
}

/** Cached deterministic setup + independently dated streaming tick. */
export async function getStrataState(): Promise<StrataState | null> {
  const raw = await rawRead();
  if (!raw) return null;
  const now = Date.now(), open = isOpen("metal", now);
  const analysis = analyzePriceAction({ ...raw, now, open });
  if (!analysis) return null;
  const last = raw.m15[raw.m15.length - 1];
  const stale = open && now - (last.t + 900000) > 32 * 60000;
  if (stale) {
    analysis.warnings.push("Completed 15-minute candles are stale. Entry readiness is suspended.");
    if (analysis.primary) analysis.primary = { ...analysis.primary, stage: "watch", reference: true };
    analysis.status = "NO_SETUP";
  }
  let price = last.c, quoteSource: StrataState["quoteSource"] = "candle";
  let quoteReceivedAt: string | null = null;
  if (open) {
    const admin = createAdminClient();
    if (admin) {
      try {
        const { data } = await admin.from("market_live_ticks")
          .select("price,received_at").eq("symbol", "XAU/USD").maybeSingle();
        const receivedAt = typeof data?.received_at === "string" ? data.received_at : null;
        const tickAge = receivedAt ? now - Date.parse(receivedAt) : Infinity;
        const tickPrice = Number(data?.price);
        if (tickAge >= -3000 && tickAge <= 6000 && Number.isFinite(tickPrice) && tickPrice > 0 &&
          Math.abs(tickPrice - last.c) / Math.max(1, last.c) < 0.025) {
          price = tickPrice; quoteSource = "stream"; quoteReceivedAt = receivedAt;
        }
      } catch { /* fallback is the real last candle close, clearly labelled */ }
    }
  }
  return {
    analysis, candles: raw.m15, lastCandleAt: new Date(last.t).toISOString(),
    asOf: new Date(raw.computedAt).toISOString(), price, quoteSource, quoteReceivedAt,
    marketClosed: !open, dataStale: stale, timeframe: "15m",
  };
}
