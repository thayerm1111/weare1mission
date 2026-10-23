/**
 * ONE MISSION FX SCALPER — THE SEVEN PAIRS (owner 10-23).
 *
 * The owner's list: EURUSD, USDJPY, AUDUSD, "CAD USD", GBPUSD, GBPJPY, EURJPY. The fourth is traded as
 * USDCAD — the market quotes that pair as US dollars priced in Canadian dollars; there is no separate
 * CAD/USD instrument on the broker. The broker's own name for each pair (a suffix such as "EURUSD.r",
 * or none) is discovered on the connected account, never assumed (src/lib/fxscalper/tl/discover.ts).
 *
 * A pip is the standard one: 0.0001, or 0.01 when the pair is priced in yen. The broker's tick size is
 * checked against it at discovery; a contract whose tick is coarser than a pip is refused.
 */

export type Ccy = "EUR" | "USD" | "JPY" | "AUD" | "CAD" | "GBP";
export type PairKey = "EURUSD" | "USDJPY" | "AUDUSD" | "USDCAD" | "GBPUSD" | "GBPJPY" | "EURJPY";

export type PairDef = {
  key: PairKey;
  base: Ccy;
  quote: Ccy;
  /** Price size of one pip. */
  pip: number;
  /** How the dashboard writes it. */
  label: string;
  /** Shown beside the pair where the owner's wording differs from the market's. */
  note?: string;
};

export const PAIRS: Record<PairKey, PairDef> = {
  EURUSD: { key: "EURUSD", base: "EUR", quote: "USD", pip: 0.0001, label: "EUR/USD" },
  USDJPY: { key: "USDJPY", base: "USD", quote: "JPY", pip: 0.01, label: "USD/JPY" },
  AUDUSD: { key: "AUDUSD", base: "AUD", quote: "USD", pip: 0.0001, label: "AUD/USD" },
  USDCAD: {
    key: "USDCAD", base: "USD", quote: "CAD", pip: 0.0001, label: "USD/CAD",
    note: "Requested as \"CAD USD\". The market quotes this pair as USD/CAD, so that is what is traded.",
  },
  GBPUSD: { key: "GBPUSD", base: "GBP", quote: "USD", pip: 0.0001, label: "GBP/USD" },
  GBPJPY: { key: "GBPJPY", base: "GBP", quote: "JPY", pip: 0.01, label: "GBP/JPY" },
  EURJPY: { key: "EURJPY", base: "EUR", quote: "JPY", pip: 0.01, label: "EUR/JPY" },
};

export const PAIR_KEYS: PairKey[] = ["EURUSD", "USDJPY", "AUDUSD", "USDCAD", "GBPUSD", "GBPJPY", "EURJPY"];

export const CURRENCIES: Ccy[] = ["EUR", "USD", "JPY", "AUD", "CAD", "GBP"];

export const isPairKey = (v: unknown): v is PairKey => typeof v === "string" && (PAIR_KEYS as string[]).includes(v);

/** Any spelling — "EURUSD", "eur/usd", "EUR-USD" — or null. "CADUSD" is the owner's name for USDCAD. */
export function pairOf(v: unknown): PairDef | null {
  const k = String(v ?? "").toUpperCase().replace(/[^A-Z]/g, "");
  if (k === "CADUSD") return PAIRS.USDCAD;
  return isPairKey(k) ? PAIRS[k] : null;
}

/** The two currency legs of a position: buying EURUSD is long EUR and short USD. */
export function legs(pair: PairKey, side: "buy" | "sell"): Array<{ ccy: Ccy; dir: "long" | "short" }> {
  const p = PAIRS[pair];
  return side === "buy"
    ? [{ ccy: p.base, dir: "long" }, { ccy: p.quote, dir: "short" }]
    : [{ ccy: p.base, dir: "short" }, { ccy: p.quote, dir: "long" }];
}
