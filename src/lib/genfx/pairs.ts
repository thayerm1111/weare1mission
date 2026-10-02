/**
 * GEN FX — THE PAIRS (owner 10-02: "an exact system, just like Gen X, but instead of gold build it for
 * Euro USD and GBP JPY … call it Gen FX").
 *
 * GEN FX is the GENX engine pointed at two currency pairs. The engine itself is already
 * instrument-neutral — every distance inside it is a multiple of the market's own ATR — so the read is
 * the same code, unchanged. What is NOT neutral is the plumbing around the engine: GENX's scanner,
 * confirmation, zone setups and placement guards carry about a dozen numbers written in gold dollars
 * ("within 30 cents counts as a touch", "the same setup if the zones are within $6").
 *
 * Those numbers cannot be copied as digits. 30 cents is nothing on gold and 3,000 pips on EUR/USD.
 * Each pair therefore carries ONE conversion — `unit`, the price move that is to this pair what $1 is
 * to gold — and every gold-dollar constant is expressed in units. It comes from how far each market
 * actually travels: gold's average hourly range is about $11 (and about $58 a day), EUR/USD's is about
 * 11 pips (60 a day), GBP/JPY's about 27 pips (150 a day). So:
 *
 *     gold      $1.00  = 1 unit
 *     EUR/USD   1 pip  = 1 unit   (0.0001)
 *     GBP/JPY   2.5 pips = 1 unit (0.025)
 *
 * The replay (src/lib/genfx/replay.ts) measures both pairs' real ranges on every run, so the ratio is
 * checked against history rather than taken on trust.
 */

export type PairKey = "EURUSD" | "GBPJPY";

export type FxPair = {
  /** The broker's symbol, and the symbol written to the trade ledger. */
  key: PairKey;
  /** The market-data symbol. */
  td: string;
  /** How a member reads it. */
  name: string;
  /** What the engine calls it in a sentence. */
  label: string;
  /** Price size of one pip, and the decimals a price is shown at. */
  pip: number;
  dec: number;
  /** The price move that is to this pair what $1.00 is to gold. See the note above. */
  unit: number;
  /**
   * The tightest stop auto-trade will take, in pips. Not a GENX rule — GEN FX's own, and the reason
   * is in the ledger: in August this desk's forex auto-run placed EUR/USD, AUD/USD and USD/CAD with
   * 3–5 pip stops, and sizing a fixed % of an account over 4 pips produced positions of 8 to 30 lots,
   * up to 100. On a stop that tight the spread alone is a quarter of the risk. Setups with a stop
   * under this are still SHOWN on the page; auto-trade does not take them.
   */
  minStopPips: number;
  /** A typical spread plus commission, in pips — shown beside a tight stop, and charged in the replay. */
  costPips: number;
  /** The switch on a broker account that turns this pair on for it. */
  column: "genfx_eurusd" | "genfx_gbpjpy";
  /** Currency the pair is priced in. A pair not priced in dollars needs a rate to size. */
  quote: "USD" | "JPY";
};

export const PAIRS: Record<PairKey, FxPair> = {
  EURUSD: {
    key: "EURUSD", td: "EUR/USD", name: "EUR/USD", label: "Euro (EUR/USD)",
    pip: 0.0001, dec: 5, unit: 0.0001, minStopPips: 10, costPips: 1.0,
    column: "genfx_eurusd", quote: "USD",
  },
  GBPJPY: {
    key: "GBPJPY", td: "GBP/JPY", name: "GBP/JPY", label: "Pound-Yen (GBP/JPY)",
    pip: 0.01, dec: 3, unit: 0.025, minStopPips: 20, costPips: 2.5,
    column: "genfx_gbpjpy", quote: "JPY",
  },
};

export const PAIR_KEYS: PairKey[] = ["EURUSD", "GBPJPY"];

/** Any spelling a caller might send — "EURUSD", "eur/usd", "EUR-USD" — or null. Never a default. */
export function pairOf(v: unknown): FxPair | null {
  const k = String(v ?? "").toUpperCase().replace(/[^A-Z]/g, "");
  return k === "EURUSD" || k === "GBPJPY" ? PAIRS[k] : null;
}

/** Round a price to the pair's own precision. */
export const px = (p: FxPair, n: number): number => +n.toFixed(p.dec);

/** A price as a member reads it: 1.08432, 201.457. Null and junk read as an em dash. */
export const fmtPx = (p: FxPair, n: number | null | undefined): string =>
  typeof n === "number" && Number.isFinite(n) ? n.toFixed(p.dec) : "—";

/** Distance between two prices in pips, to one decimal. */
export const pipsBetween = (p: FxPair, a: number, b: number): number =>
  Math.round((Math.abs(a - b) / p.pip) * 10) / 10;

/** A count of units as a price distance. `units(p, 0.3)` is this pair's "30 cents of gold". */
export const units = (p: FxPair, n: number): number => n * p.unit;

/*
 * GENX'S GOLD-DOLLAR CONSTANTS, IN UNITS. One table, so the conversion is visible in one place and a
 * test can assert that plugging in gold's own numbers (unit = 1) gives back exactly GENX's values.
 */
export const U = {
  /** zoneSetups.ZONE_TOUCH_USD — within this of the entry counts as a touch. */
  zoneTouch: 0.3,
  /** genxConfirm / decideGoldEntry — the smallest buffer around a zone. */
  confirmBuf: 0.2,
  /** watchTick.SAME_SETUP_USD — two zones this close on the same side are one setup. */
  sameSetup: 6,
  /** choch.ts — the swing a change of character must clear, clamped between these. */
  chochMin: 2.5,
  chochMax: 8,
  chochDefault: 4,
  /** sizing.MAX_STOP gold ($10) — the "normal allowance" the corrupt-stop bound multiplies. */
  stopAllowance: 10,
  /** executor.goldMaxEntry — 10 gold pips: the worst fill the quality gate measures reward from. */
  chase: 1,
  /** qualityGate.minSlopeUsd — the 20-hour average must have moved this far the trade's way in 3h. */
  slope: 1,
  /** autoExec.GOLD_STRUCT_MIN_ROOM / GOLD_NOISE_FALLBACK — room a stop needs from the fill. */
  noiseFloor: 4,
  noiseFallback: 6,
  /** autoExec.GOLD_REAL_LOSS_MIN_PIPS (5 gold pips) — smaller than this is a scratch, not a loss. */
  realLoss: 0.5,
  /** The scanner's dedupe key rounds a zone to the dollar. */
  dedupe: 1,
  /** The zone key rounds an entry to ten cents. */
  zoneKey: 0.1,
} as const;
