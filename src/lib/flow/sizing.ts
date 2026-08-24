import { normalizeQuantity } from "@/lib/flow/instruments";

/**
 * Risk-based position sizing (server + client shared math).
 *
 * Given an account equity, a % of it to risk, and the entry→stop distance,
 * solve for the lot size whose loss-at-stop ≈ the risk amount. Quote-currency
 * aware so a JPY pair sizes correctly, not just USD-quoted ones.
 *
 * CONTRACT[canonical].size = units of the base per 1.0 lot:
 *   Gold  1 lot = 100 oz   → $100 per $1 move   (USD-quoted)
 *   EURUSD 1 lot = 100,000 → $100 per 0.0100 move (USD-quoted)
 *   USDJPY 1 lot = 100,000 USD notional, JPY-quoted → divide value by USD/JPY.
 * Index/oil contract sizes vary by broker; these are sane defaults and the UI
 * always previews the resulting lots before anything is placed.
 */
// `size` = USD value of a 1.0 PRICE-unit move, per 1.0 lot. Index point-values
// are BROKER-SPECIFIC — NAS100 was calibrated from a live Crucial fill ($10 per
// index point per lot: a 3.3-pt move on 0.10 lot paid $3.30). Getting this wrong
// scales risk directly, so indices are set on the conservative (over-estimate →
// smaller lot) side until confirmed against a fill.
const CONTRACT: Record<string, { size: number; quote: "USD" | "JPY" | "CAD" }> = {
  XAUUSD: { size: 100, quote: "USD" },
  XAGUSD: { size: 5000, quote: "USD" },
  EURUSD: { size: 100000, quote: "USD" },
  GBPUSD: { size: 100000, quote: "USD" },
  USDJPY: { size: 100000, quote: "JPY" },
  AUDUSD: { size: 100000, quote: "USD" }, // USD-quoted (AUD base) → $100 per 0.0100 move
  USDCAD: { size: 100000, quote: "CAD" }, // CAD-quoted (USD base) → pip value in CAD, convert by /price
  NAS100: { size: 10, quote: "USD" }, // $10 / point / lot (verified vs live fill)
  US30: { size: 10, quote: "USD" },   // estimated; broker-specific — verify vs a fill
  USOIL: { size: 1000, quote: "USD" },
};

// Common symbol aliases → canonical CONTRACT key. Callers pass all sorts of
// formats ("XAU/USD", "GOLD", "US100", "NASDAQ"); we normalise so the contract
// size can never silently fall back to 1 (which would over-size ~100x on Gold).
const ALIAS: Record<string, string> = {
  GOLD: "XAUUSD", XAU: "XAUUSD",
  SILVER: "XAGUSD", XAG: "XAGUSD",
  US100: "NAS100", NASDAQ: "NAS100", NASDAQ100: "NAS100", USTEC: "NAS100", NDX: "NAS100", NAS: "NAS100",
  DOW: "US30", DJI: "US30", WALLSTREET: "US30", US30USD: "US30",
  OIL: "USOIL", WTI: "USOIL", CRUDE: "USOIL", USOUSD: "USOIL",
};

/** Normalise any symbol form to a CONTRACT key: strip non-alphanumerics + upper,
 *  then apply the alias table (so "XAU/USD" → "XAUUSD", "US100" → "NAS100"). */
export function contractKey(symbol: string): string {
  const raw = String(symbol || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (CONTRACT[raw]) return raw;
  if (ALIAS[raw]) return ALIAS[raw];
  return raw;
}

/** USD value of a 1.0 PRICE-unit move, per 1.0 lot. For a USD-quoted pair this is
 *  just `size`; for a pair quoted in another currency where the BASE is USD (USD/JPY,
 *  USD/CAD) the value lands in the quote currency, so divide by the price to convert
 *  it back to USD. */
export function valuePerPricePerLot(canonical: string, price: number): number {
  const c = CONTRACT[contractKey(canonical)] ?? { size: 1, quote: "USD" as const };
  if (c.quote !== "USD") return price > 0 ? c.size / price : c.size;
  return c.size;
}

// MINIMUM SANE STOP DISTANCE per instrument (in price units). A stop tighter than this both
// balloons the lot size (risk% / a tiny distance = a huge, over-leveraged position) AND gets
// whipsawed by normal noise. Placement widens the stop to this floor before sizing — the risk
// % is unchanged, but the position is professionally sized with room to breathe.
const MIN_STOP: Record<string, number> = {
  XAUUSD: 8.0,      // $8 on gold (~80 pips)
  XAGUSD: 0.15,
  EURUSD: 0.0012,   // ~12 pips
  GBPUSD: 0.0012,
  USDJPY: 0.12,
  AUDUSD: 0.0012,
  USDCAD: 0.0012,
  NAS100: 20,       // 20 index points
  US30: 25,
  USOIL: 0.15,
};

/** Minimum sane stop distance (price units) for an instrument; 0 if none configured. */
export function minStopDistance(canonical: string): number {
  return MIN_STOP[contractKey(canonical)] ?? 0;
}

/** Widen a stop to the instrument's minimum distance when the signal's stop is tighter.
 *  Returns the (possibly widened) stop price, on the correct side of entry. */
export function floorStop(canonical: string, side: "buy" | "sell", entry: number, stop: number): number {
  const min = minStopDistance(canonical);
  if (!(min > 0) || !(entry > 0) || !(stop > 0)) return stop;
  if (Math.abs(entry - stop) >= min) return stop;
  return side === "buy" ? +(entry - min) : +(entry + min);
}

// LEVERAGE BACKSTOP: no single position's notional (contract size × price × lots) may exceed
// this multiple of account equity — a professional ceiling so one trade can't run extreme
// leverage even at a "correct" risk % on a tight stop.
const MAX_NOTIONAL_MULT = 20;

/** Notional (USD face value) of 1.0 lot at the given price. */
export function notionalPerLot(canonical: string, price: number): number {
  const c = CONTRACT[contractKey(canonical)] ?? { size: 1, quote: "USD" as const };
  return c.size * (price > 0 ? price : 0);
}

export type SizeResult = {
  ok: boolean; lots: number; riskAmount: number; stopDistance: number;
  valuePerLot: number; estLossAtStop: number; reason?: string;
};

/**
 * Lot size such that (entry→stop) risks ~riskPct of equity.
 * `price` is used only for JPY conversion; defaults to entry.
 */
export function sizeFromRisk(opts: {
  canonical: string; entry: number; stop: number; equity: number; riskPct: number;
  price?: number; broker?: { quantityStep?: number | null; minQuantity?: number | null };
  // When the risk-based size rounds BELOW the broker minimum lot, normally we
  // report ok:false (too small — caller skips rather than over-risk). Set
  // floorToMinLot:true to instead accept the minimum lot (ok:true) — used for the
  // "small account trading Gold" case where the member wants the 0.01 minimum
  // even though it risks a touch more than their %.
  floorToMinLot?: boolean;
}): SizeResult {
  const canonical = contractKey(opts.canonical);
  const stopDistance = Math.abs(Number(opts.entry) - Number(opts.stop));
  const riskAmount = Number(opts.equity) * (Number(opts.riskPct) / 100);
  const px = opts.price && opts.price > 0 ? opts.price : Number(opts.entry);
  const valuePerLot = valuePerPricePerLot(canonical, px);
  if (!(stopDistance > 0) || !(riskAmount > 0) || !(valuePerLot > 0)) {
    return { ok: false, lots: 0, riskAmount, stopDistance, valuePerLot, estLossAtStop: 0, reason: "Missing account size, risk %, or a valid stop distance." };
  }
  const raw = riskAmount / (stopDistance * valuePerLot);
  // LEVERAGE CAP: never let a single position's notional exceed MAX_NOTIONAL_MULT× equity,
  // even when a tight stop would imply more. Caps the lots regardless of the risk %.
  const npl = notionalPerLot(canonical, px);
  const maxLotsByLeverage = npl > 0 ? (Number(opts.equity) * MAX_NOTIONAL_MULT) / npl : raw;
  const capped = Math.min(raw, maxLotsByLeverage);
  const norm = normalizeQuantity(canonical, capped, opts.broker);
  // Below-minimum: accept the minimum lot when the caller asked us to floor.
  const ok = norm.ok || (!!opts.floorToMinLot && norm.qty > 0);
  const estLossAtStop = +(norm.qty * stopDistance * valuePerLot).toFixed(2);
  return { ok, lots: norm.qty, riskAmount: +riskAmount.toFixed(2), stopDistance, valuePerLot, estLossAtStop, reason: ok ? undefined : norm.reason };
}
