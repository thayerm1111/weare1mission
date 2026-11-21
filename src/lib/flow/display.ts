/**
 * FLOW ON SCREEN — how a market, a price, a size and a setup's state are written for a member (owner 11-20
 * brief §9: "Format financial display values using the instrument/broker metadata. Remove raw decimal tails
 * from visible quotes while preserving calculation precision").
 *
 * Display only. Nothing here is used to size, place or manage a trade: every value is rounded for reading,
 * and the number the engine works with is never the one that comes back from here.
 */
import { INSTRUMENTS } from "@/lib/flow/instruments";

const SIX = /^[A-Z]{6}$/;

/** "XAUUSD" → "XAU/USD", "EURUSD" → "EUR/USD"; an index or a name keeps its own spelling. */
export function pairName(symbol: string): string {
  const s = String(symbol ?? "").replace("/", "").trim().toUpperCase();
  return SIX.test(s) ? `${s.slice(0, 3)}/${s.slice(3)}` : s || "—";
}

/** The decimals a market is quoted to: the instrument's own precision, or — for one this site has no
 *  record of — a sensible reading from the size of the price itself. */
export function decimalsFor(symbol: string, price: number): number {
  const key = String(symbol ?? "").replace("/", "").trim().toUpperCase();
  const known = INSTRUMENTS[key]?.pricePrecision;
  if (typeof known === "number" && known >= 0) return known;
  const a = Math.abs(price);
  return a >= 1000 ? 1 : a >= 100 ? 2 : a >= 10 ? 3 : 5;
}

/** 2034.5600000001 on gold → "2,034.56"; 1.084215 on EUR/USD → "1.08422". A missing price is a dash. */
export function priceFor(symbol: string, v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const d = decimalsFor(symbol, v);
  return v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

/** 0.1 → "0.1 lots", 1 → "1 lot". */
export function lotsText(q: number | null | undefined): string {
  if (q == null || !Number.isFinite(q) || q <= 0) return "—";
  const n = Math.round(q * 100) / 100;
  return `${n.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${n === 1 ? "lot" : "lots"}`;
}

/**
 * A setup's state in the platform's words (brief §10: Watching, Waiting for confirmation, Ready, Invalidated,
 * Expired, Closed). The engine's own state is kept as it is; this is only what is written on the screen.
 * `ready` is true only for a confirmed entry — the one state FLOW itself would act on.
 */
export function entryWords(state: string | null | undefined): { label: string; line: string; ready: boolean } {
  switch (String(state ?? "").toUpperCase()) {
    case "ENTER_NOW": return { label: "Ready", line: "The entry is confirmed.", ready: true };
    case "ARMED": return { label: "Waiting for confirmation", line: "Price is in the entry zone. FLOW has not confirmed the entry.", ready: false };
    case "ENTER_ON_PULLBACK": return { label: "Waiting for a pullback", line: "The setup is valid. FLOW wants price to come back into the entry zone first.", ready: false };
    case "APPROACHING": return { label: "Watching", line: "Price is approaching the entry zone.", ready: false };
    case "STAND_ASIDE": return { label: "Standing aside", line: "Price is moving against this setup. FLOW is not taking it yet.", ready: false };
    case "MISSED": return { label: "Missed", line: "The entry has passed. Taking it now would be chasing.", ready: false };
    case "INVALIDATED": return { label: "Invalidated", line: "Price broke the level that made this setup.", ready: false };
    case "EXPIRED": return { label: "Expired", line: "The setup ran out of time without an entry.", ready: false };
    case "NO_TRADE": return { label: "No trade", line: "There is no setup on this market right now.", ready: false };
    default: return { label: "Watching", line: "There is no confirmed entry.", ready: false };
  }
}
