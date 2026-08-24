/**
 * FLOW instrument metadata + pip/point normalization (spec §25).
 *
 * Different instruments have different decimal structures — never hardcode one
 * global meaning for "30 pips". This module is the single source of truth for
 * pip size, point size, precision and quantity rules. Defaults mirror the
 * `flow_instruments` reference table; when a broker account is connected the
 * per-connection `flow_broker_instruments` row overrides precision/qty from the
 * broker's own spec.
 */

export type InstrumentMeta = {
  canonical: string;
  displayName: string;
  twelveDataSymbol: string;
  assetClass: string;
  pipSize: number;
  pointSize: number;
  pricePrecision: number;
  quantityStep: number;
  minQuantity: number;
};

// In-code defaults (mirror the seeded flow_instruments rows) so hot paths never
// require a DB round-trip. The DB remains the editable source of truth.
export const INSTRUMENTS: Record<string, InstrumentMeta> = {
  XAUUSD: { canonical: "XAUUSD", displayName: "Gold (XAU/USD)", twelveDataSymbol: "XAU/USD", assetClass: "gold", pipSize: 0.1, pointSize: 0.01, pricePrecision: 2, quantityStep: 0.01, minQuantity: 0.01 },
  XAGUSD: { canonical: "XAGUSD", displayName: "Silver (XAG/USD)", twelveDataSymbol: "XAG/USD", assetClass: "metal", pipSize: 0.01, pointSize: 0.001, pricePrecision: 3, quantityStep: 0.01, minQuantity: 0.01 },
  EURUSD: { canonical: "EURUSD", displayName: "Euro / US Dollar", twelveDataSymbol: "EUR/USD", assetClass: "forex", pipSize: 0.0001, pointSize: 0.00001, pricePrecision: 5, quantityStep: 0.01, minQuantity: 0.01 },
  GBPUSD: { canonical: "GBPUSD", displayName: "Pound / US Dollar", twelveDataSymbol: "GBP/USD", assetClass: "forex", pipSize: 0.0001, pointSize: 0.00001, pricePrecision: 5, quantityStep: 0.01, minQuantity: 0.01 },
  USDJPY: { canonical: "USDJPY", displayName: "US Dollar / Yen", twelveDataSymbol: "USD/JPY", assetClass: "forex", pipSize: 0.01, pointSize: 0.001, pricePrecision: 3, quantityStep: 0.01, minQuantity: 0.01 },
  AUDUSD: { canonical: "AUDUSD", displayName: "Aussie / US Dollar", twelveDataSymbol: "AUD/USD", assetClass: "forex", pipSize: 0.0001, pointSize: 0.00001, pricePrecision: 5, quantityStep: 0.01, minQuantity: 0.01 },
  USDCAD: { canonical: "USDCAD", displayName: "US Dollar / Canadian Dollar", twelveDataSymbol: "USD/CAD", assetClass: "forex", pipSize: 0.0001, pointSize: 0.00001, pricePrecision: 5, quantityStep: 0.01, minQuantity: 0.01 },
  NAS100: { canonical: "NAS100", displayName: "Nasdaq 100", twelveDataSymbol: "NAS100", assetClass: "index", pipSize: 1, pointSize: 0.1, pricePrecision: 1, quantityStep: 0.1, minQuantity: 0.1 },
  US30: { canonical: "US30", displayName: "Dow Jones 30", twelveDataSymbol: "DJI", assetClass: "index", pipSize: 1, pointSize: 0.1, pricePrecision: 1, quantityStep: 0.1, minQuantity: 0.1 },
  USOIL: { canonical: "USOIL", displayName: "WTI Crude Oil", twelveDataSymbol: "WTI/USD", assetClass: "commodity", pipSize: 0.01, pointSize: 0.001, pricePrecision: 2, quantityStep: 0.01, minQuantity: 0.01 },
};

export function getInstrument(canonical: string): InstrumentMeta {
  return INSTRUMENTS[canonical] ?? INSTRUMENTS.XAUUSD;
}

/** Price distance → pips (rounded), instrument-aware. */
export function priceToPips(canonical: string, priceDistance: number): number {
  const m = getInstrument(canonical);
  return Math.round(Math.abs(priceDistance) / m.pipSize);
}

/** pips → price distance, instrument-aware. */
export function pipsToPrice(canonical: string, pips: number): number {
  const m = getInstrument(canonical);
  return +(pips * m.pipSize).toFixed(m.pricePrecision);
}

/** Format a price at the instrument's precision. */
export function formatPrice(canonical: string, price: number): string {
  const m = getInstrument(canonical);
  return price.toLocaleString(undefined, { minimumFractionDigits: m.pricePrecision, maximumFractionDigits: m.pricePrecision });
}

/**
 * Clamp a requested lot size to a broker instrument's quantity step + minimum.
 * Uses broker-provided step/min when available, else the instrument default.
 * Returns { qty, ok, reason } so callers can refuse an invalid size.
 */
export function normalizeQuantity(
  canonical: string,
  lots: number,
  broker?: { quantityStep?: number | null; minQuantity?: number | null },
): { qty: number; ok: boolean; reason?: string } {
  const m = getInstrument(canonical);
  const step = broker?.quantityStep && broker.quantityStep > 0 ? broker.quantityStep : m.quantityStep;
  const min = broker?.minQuantity && broker.minQuantity > 0 ? broker.minQuantity : m.minQuantity;
  if (!Number.isFinite(lots) || lots <= 0) return { qty: min, ok: false, reason: "Lot size must be a positive number." };
  // round DOWN to the nearest step so we never exceed the user's intended size
  const stepped = Math.floor(lots / step + 1e-9) * step;
  const decimals = (String(step).split(".")[1] || "").length;
  const qty = +stepped.toFixed(decimals);
  if (qty < min) return { qty: min, ok: false, reason: `Below the ${min} minimum for ${canonical}.` };
  return { qty, ok: true };
}
