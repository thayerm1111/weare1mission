/**
 * MATTY PIPS — candle fetch adapter. READ-ONLY consumer of the platform's
 * shared market-data layer (community cache + per-minute governor), so ten
 * members reading gold cost the same as one, and Matty Pips can never starve
 * GENX/FLOW: an on-demand read costs at most 5 credits, all cache-eligible.
 */
import { series, livePrice, livePriceSane, type Row } from "@/lib/marketData";
import { getInstrument } from "./pips";
import type { Candle } from "./types";

export type MarketRead = {
  ok: true;
  d: Candle[]; h4: Candle[]; h1: Candle[]; m15: Candle[];
  price: number;
};
export type MarketReadError = { ok: false; error: "ratelimit" | "no_data"; detail: string };

function toCandles(rows: Row[]): Candle[] {
  return rows
    .map((r) => ({ t: Date.parse(r.datetime), o: +r.open, h: +r.high, l: +r.low, c: +r.close }))
    .filter((c) => [c.o, c.h, c.l, c.c].every((n) => Number.isFinite(n)));
}

/** Full top-down pull: Daily, 4H, 1H, 15M + live price (sanity-checked). */
export async function fetchMarket(canonical: string, mdKey: string, fresh: boolean): Promise<MarketRead | MarketReadError> {
  const td = getInstrument(canonical).twelveDataSymbol;
  const [dR, h4R, h1R, m15R] = await Promise.all([
    series(td, "1day", 90, mdKey, fresh),
    series(td, "4h", 120, mdKey, fresh),
    series(td, "1h", 160, mdKey, fresh),
    series(td, "15min", 160, mdKey, fresh),
  ]);
  if ([dR, h4R, h1R, m15R].some((r) => r === "ratelimit")) {
    return { ok: false, error: "ratelimit", detail: "Market-data budget is busy — try again in a minute." };
  }
  const d = Array.isArray(dR) ? toCandles(dR) : [];
  const h4 = Array.isArray(h4R) ? toCandles(h4R) : [];
  const h1 = Array.isArray(h1R) ? toCandles(h1R) : [];
  const m15 = Array.isArray(m15R) ? toCandles(m15R) : [];
  if (d.length < 20 || h4.length < 30 || h1.length < 40 || m15.length < 40) {
    return { ok: false, error: "no_data", detail: "Not enough candle history for a reliable read right now." };
  }
  const live = await livePrice(td, mdKey, fresh);
  const sane = livePriceSane(live, m15.map((c) => ({ datetime: "", open: String(c.o), high: String(c.h), low: String(c.l), close: String(c.c) })));
  const price = sane.ok && live != null ? live : (sane.reference ?? m15[m15.length - 1].c);
  return { ok: true, d, h4, h1, m15, price };
}
