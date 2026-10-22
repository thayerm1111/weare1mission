import { livePrice, series } from "@/lib/marketData";
import { normalizeRows, type Candle, type FeedRow } from "./candles";
import type { Quote } from "./signals";
import { FEED_NAME, SYMBOL_SPECS, type CashtrapSymbol } from "./symbols";

/**
 * CASHTRAP MARKET-DATA ADAPTER — the one place Cashtrap talks to a feed.
 *
 * Feed: TwelveData, through the platform's shared integration (src/lib/marketData.ts — its per-minute
 * credit governor and community cache). Cashtrap always asks for FRESH data (no cached copy).
 * TIMING (measured live 10-22): the 5-minute candles are built from 1-minute bars that arrive about a
 * minute late, so the newest candles trail the market by ~60–75 s and a closed candle is final only
 * ~60–80 s after its close (data.feedSettleMs). The `price` quote is current (it is not built from bars).
 *   • Candles: `time_series`, interval 5min, timezone UTC. Each row's datetime is the candle's OPEN
 *     time in UTC; candles are checked (5-minute boundary, possible prices, no conflicting duplicates)
 *     and sorted, so duplicate or out-of-order rows cannot slip through. The newest row is the candle
 *     still forming — the caller decides which candles are complete (candles.splitCompleted).
 *   • Quotes: `price` — the latest traded price. The feed gives no timestamp for it, so a quote is
 *     timestamped when it is RECEIVED here (that is the time used for entry windows and settlement).
 * Symbol mapping and precision: symbols.ts. This is a reference feed, not a broker's price stream.
 */
export type CandleFetch = { ok: true; candles: Candle[]; issues: string[]; fetchedAt: number } | { ok: false; reason: string; fetchedAt: number };

export interface MarketData {
  readonly name: string;
  candles(symbol: CashtrapSymbol, count: number): Promise<CandleFetch>;
  quote(symbol: CashtrapSymbol): Promise<Quote | null>;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((r) => { timer = setTimeout(() => r(null), ms); });
  return Promise.race([p, late]).finally(() => { if (timer) clearTimeout(timer); });
}

export class TwelveDataMarketData implements MarketData {
  readonly name = FEED_NAME;
  constructor(private key: string, private now: () => number = Date.now) {}

  async candles(symbol: CashtrapSymbol, count: number): Promise<CandleFetch> {
    const td = SYMBOL_SPECS[symbol].feedSymbol;
    const rows = await withTimeout(series(td, "5min", Math.min(Math.max(count, 5), 5000), this.key, true, "UTC"), 15_000);
    const fetchedAt = this.now();
    if (rows === null) return { ok: false, reason: "the feed did not answer", fetchedAt };
    if (rows === "ratelimit") return { ok: false, reason: "market-data rate limit", fetchedAt };
    if (!Array.isArray(rows) || rows.length === 0) return { ok: false, reason: `no ${td} candles from the feed`, fetchedAt };
    const n = normalizeRows(rows as FeedRow[]);
    return { ok: true, candles: n.candles, issues: n.issues, fetchedAt };
  }

  async quote(symbol: CashtrapSymbol): Promise<Quote | null> {
    const td = SYMBOL_SPECS[symbol].feedSymbol;
    const px = await withTimeout(livePrice(td, this.key, true), 8_000);
    const at = this.now();
    return typeof px === "number" && Number.isFinite(px) && px > 0 ? { px, at, source: `${FEED_NAME} price (received ${new Date(at).toISOString().slice(11, 19)} UTC)` } : null;
  }
}

/**
 * HISTORY for replay: closed 5-minute candles for the last `weeks`, oldest → newest, UTC. Pages of
 * 5,000 going back with end_date; each page reserves one credit from the shared governor. The forming
 * candle is dropped (reading it as closed would be reading the future).
 */
export async function fetchHistory(symbol: CashtrapSymbol, weeks: number, key: string, nowMs = Date.now()): Promise<{ ok: true; candles: Candle[]; issues: string[] } | { ok: false; reason: string }> {
  const { reserveMarketData } = await import("@/lib/marketData");
  const td = SYMBOL_SPECS[symbol].feedSymbol;
  const want = Math.ceil(weeks * 7 * 288);
  const from = nowMs - weeks * 7 * 86_400_000;
  const rows: FeedRow[] = [];
  let end: string | null = null;
  for (let page = 0; page < 40; page++) {
    await reserveMarketData(1);
    let j: { status?: string; values?: FeedRow[]; message?: string; code?: number } = {};
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30_000);
      try {
        const r = await fetch(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(td)}&interval=5min&outputsize=5000&timezone=UTC&order=DESC${end ? `&end_date=${encodeURIComponent(end)}` : ""}&apikey=${key}`, { cache: "no-store", signal: ctrl.signal });
        j = await r.json();
      } finally { clearTimeout(timer); }
    } catch (e) { return { ok: false, reason: `history fetch failed: ${e instanceof Error ? e.message : String(e)}` }; }
    if (j.status === "error" || !Array.isArray(j.values)) return rows.length ? { ...finish(rows, from, nowMs) } : { ok: false, reason: j.message || "the feed refused the history request" };
    rows.push(...j.values);
    const oldest = Math.min(...j.values.map((v) => Date.parse(String(v.datetime ?? "").replace(" ", "T") + "Z")).filter(Number.isFinite));
    if (!Number.isFinite(oldest) || j.values.length < 5000 || oldest <= from || rows.length >= want * 1.2) break;
    end = new Date(oldest - 1000).toISOString().slice(0, 19).replace("T", " ");
  }
  return finish(rows, from, nowMs);
}
function finish(rows: FeedRow[], from: number, nowMs: number): { ok: true; candles: Candle[]; issues: string[] } {
  const n = normalizeRows(rows);
  // Only candles closed at least two minutes ago: the feed finishes a 5-minute candle ~60–80 s after it closes.
  return { ok: true, candles: n.candles.filter((k) => k.t >= from && k.t + 5 * 60_000 + 120_000 <= nowMs), issues: n.issues };
}
