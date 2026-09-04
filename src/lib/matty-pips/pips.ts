/**
 * MATTY PIPS — the single import point for pip/price conversion.
 *
 * Wraps the platform's centralized instrument spec (src/lib/flow/instruments.ts,
 * READ-ONLY import of pure functions) so no Matty Pips module ever hard-codes
 * what "a pip" means. Gold pip = 0.1, EURUSD pip = 0.0001, USDJPY = 0.01,
 * indices = 1.0 — all from the one source of truth.
 */
import { getInstrument, priceToPips, pipsToPrice, formatPrice, type InstrumentMeta } from "@/lib/flow/instruments";

export { getInstrument, priceToPips, pipsToPrice, formatPrice };
export type { InstrumentMeta };

/** Markets Matty Pips reads (all present in the platform instrument table). */
export const MP_MARKETS: { canonical: string; label: string }[] = [
  { canonical: "XAUUSD", label: "GOLD" },
  { canonical: "EURUSD", label: "EUR/USD" },
  { canonical: "GBPUSD", label: "GBP/USD" },
  { canonical: "USDJPY", label: "USD/JPY" },
  { canonical: "NAS100", label: "NAS100" },
  { canonical: "US30", label: "US30" },
  { canonical: "USOIL", label: "OIL" },
];

export function isMpMarket(canonical: string): boolean {
  return MP_MARKETS.some((m) => m.canonical === canonical);
}

/** Minimum stop distance (pips) per asset class — a volatility floor so a
 *  structure stop can never be placed absurdly tight on a fast instrument. */
export function minStopPips(canonical: string): number {
  const meta = getInstrument(canonical);
  switch (meta.assetClass) {
    case "gold": return 30;
    case "index": return 20;
    case "commodity": return 15;
    default: return 8; // forex majors / metals
  }
}

/** Round a price to the instrument's precision. */
export function roundPx(canonical: string, price: number): number {
  const meta = getInstrument(canonical);
  return +price.toFixed(meta.pricePrecision);
}
