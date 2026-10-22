/**
 * CASHTRAP MARKETS — the four instruments Cashtrap scans, each on its own.
 *
 * The mapping is explicit so that nothing is ever silently substituted: a symbol the feed cannot
 * serve is reported as unavailable, never replaced by a neighbouring product.
 *
 *   symbol   feed symbol (TwelveData)   price precision   pip
 *   USDJPY   USD/JPY                    3 decimals        0.01
 *   EURUSD   EUR/USD                    5 decimals        0.0001
 *   XAUUSD   XAU/USD                    2 decimals        0.1   (spot gold, quoted in USD)
 *   GBPJPY   GBP/JPY                    3 decimals        0.01
 *
 * THE FEED IS A REFERENCE FEED. These are TwelveData's spot prices, not the prices of any binary
 * options broker. A broker's own quotes — and its synthetic or "OTC" instruments in particular — can
 * differ from them. Outcomes measured against this feed are labelled reference-feed (live) or
 * simulated (replay), never broker-verified.
 */
export const CASHTRAP_SYMBOLS = ["USDJPY", "EURUSD", "XAUUSD", "GBPJPY"] as const;
export type CashtrapSymbol = (typeof CASHTRAP_SYMBOLS)[number];

export type SymbolSpec = {
  symbol: CashtrapSymbol;
  /** The symbol as the market-data feed names it. */
  feedSymbol: string;
  /** Decimal places the feed quotes and the dashboard shows. */
  precision: number;
  /** One pip, for display only — binary outcomes are never measured in pips. */
  pip: number;
  /** Which trading-hours schedule applies (market-hours.ts). */
  hours: "fx" | "metal";
  label: string;
};

export const SYMBOL_SPECS: Record<CashtrapSymbol, SymbolSpec> = {
  USDJPY: { symbol: "USDJPY", feedSymbol: "USD/JPY", precision: 3, pip: 0.01, hours: "fx", label: "USD/JPY" },
  EURUSD: { symbol: "EURUSD", feedSymbol: "EUR/USD", precision: 5, pip: 0.0001, hours: "fx", label: "EUR/USD" },
  XAUUSD: { symbol: "XAUUSD", feedSymbol: "XAU/USD", precision: 2, pip: 0.1, hours: "metal", label: "XAU/USD (Gold)" },
  GBPJPY: { symbol: "GBPJPY", feedSymbol: "GBP/JPY", precision: 3, pip: 0.01, hours: "fx", label: "GBP/JPY" },
};

export const FEED_NAME = "TwelveData";

export function isCashtrapSymbol(s: unknown): s is CashtrapSymbol {
  return typeof s === "string" && (CASHTRAP_SYMBOLS as readonly string[]).includes(s);
}

/** A price at the instrument's quoted precision, as text (for explanations and the dashboard). */
export function fmtPrice(symbol: CashtrapSymbol, px: number | null | undefined): string {
  if (px == null || !Number.isFinite(px)) return "—";
  return px.toFixed(SYMBOL_SPECS[symbol].precision);
}

/** Round to the instrument's precision (used when a price is recorded). */
export function roundPrice(symbol: CashtrapSymbol, px: number): number {
  const p = SYMBOL_SPECS[symbol].precision;
  return Math.round(px * 10 ** p) / 10 ** p;
}
