/**
 * Versioned XAUUSD instrument specification + unit conversions. Prices are handled as
 * integer TICKS internally (tick = 0.01 USD) so every distance is decimal-safe.
 * "Pips" only ever appear as a DISPLAY value derived from a named convention.
 */
export type InstrumentSpec = {
  specVersion: string;
  canonical: "XAUUSD";
  providerSymbol: string;          // Twelve Data
  brokerSymbol: string;            // TradeLocker (matched by name at execution)
  priceDigits: number;
  tickSize: number;                // USD per tick
  pointSize: number;               // USD per broker point
  pipSizeDisplay: number;          // USD per display pip (desk convention)
  contractSizeOz: number;          // oz per 1.0 lot
  minStopUsd: number;              // broker minimum stop distance (USD)
  minVolume: number; volumeStep: number; maxVolume: number;
  session: string;                 // human description; enforcement lives in Flow windows
  spreadConvention: "ask_minus_bid_usd";
};

export const XAUUSD: InstrumentSpec = {
  specVersion: "xauusd-1",
  canonical: "XAUUSD",
  providerSymbol: "XAU/USD",
  brokerSymbol: "XAUUSD",
  priceDigits: 2,
  tickSize: 0.01,
  pointSize: 0.01,
  pipSizeDisplay: 0.1,
  contractSizeOz: 100,
  minStopUsd: 0.5,
  minVolume: 0.01, volumeStep: 0.01, maxVolume: 100,
  session: "Sun 22:00 UTC – Fri 21:00 UTC, daily break 21:00–22:00 UTC",
  spreadConvention: "ask_minus_bid_usd",
};

export const toTicks = (usd: number, s: InstrumentSpec = XAUUSD) => Math.round(usd / s.tickSize);
export const fromTicks = (ticks: number, s: InstrumentSpec = XAUUSD) => +(ticks * s.tickSize).toFixed(s.priceDigits);
/** Round a price onto the tick grid (toward the given side when provided). */
export function roundPrice(px: number, mode: "nearest" | "down" | "up" = "nearest", s: InstrumentSpec = XAUUSD): number {
  const t = px / s.tickSize;
  const r = mode === "down" ? Math.floor(t + 1e-9) : mode === "up" ? Math.ceil(t - 1e-9) : Math.round(t);
  return fromTicks(r, s);
}

export type Distance = { priceUsd: number; ticks: number; points: number; displayPips: number; specVersion: string };
export function distance(a: number, b: number, s: InstrumentSpec = XAUUSD): Distance {
  const ticks = Math.abs(toTicks(a, s) - toTicks(b, s));
  const priceUsd = fromTicks(ticks, s);
  return {
    priceUsd,
    ticks,
    points: Math.round(priceUsd / s.pointSize),
    displayPips: +(priceUsd / s.pipSizeDisplay).toFixed(1),
    specVersion: s.specVersion,
  };
}
