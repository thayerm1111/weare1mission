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
const CONTRACT: Record<string, { size: number; quote: "USD" | "JPY" }> = {
  XAUUSD: { size: 100, quote: "USD" },
  XAGUSD: { size: 5000, quote: "USD" },
  EURUSD: { size: 100000, quote: "USD" },
  GBPUSD: { size: 100000, quote: "USD" },
  USDJPY: { size: 100000, quote: "JPY" },
  NAS100: { size: 1, quote: "USD" },
  US30: { size: 1, quote: "USD" },
  USOIL: { size: 1000, quote: "USD" },
};

/** USD value of a 1.0 PRICE-unit move, per 1.0 lot. */
export function valuePerPricePerLot(canonical: string, price: number): number {
  const c = CONTRACT[String(canonical).toUpperCase()] ?? { size: 1, quote: "USD" as const };
  if (c.quote === "JPY") return price > 0 ? c.size / price : c.size;
  return c.size;
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
}): SizeResult {
  const canonical = String(opts.canonical).toUpperCase();
  const stopDistance = Math.abs(Number(opts.entry) - Number(opts.stop));
  const riskAmount = Number(opts.equity) * (Number(opts.riskPct) / 100);
  const px = opts.price && opts.price > 0 ? opts.price : Number(opts.entry);
  const valuePerLot = valuePerPricePerLot(canonical, px);
  if (!(stopDistance > 0) || !(riskAmount > 0) || !(valuePerLot > 0)) {
    return { ok: false, lots: 0, riskAmount, stopDistance, valuePerLot, estLossAtStop: 0, reason: "Missing account size, risk %, or a valid stop distance." };
  }
  const raw = riskAmount / (stopDistance * valuePerLot);
  const norm = normalizeQuantity(canonical, raw, opts.broker);
  const estLossAtStop = +(norm.qty * stopDistance * valuePerLot).toFixed(2);
  return { ok: norm.ok, lots: norm.qty, riskAmount: +riskAmount.toFixed(2), stopDistance, valuePerLot, estLossAtStop, reason: norm.reason };
}
