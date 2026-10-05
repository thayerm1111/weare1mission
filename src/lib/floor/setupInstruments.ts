import { PAIRS, type PairKey } from "@/lib/genfx/pairs";

/**
 * THE FLOOR — what the setup card can show (owner 10-04: "make it so you can page through here to
 * GBPJPY, and EURUSD as well, kinda like a toggle to see the other GEN FX setups just like the GENX").
 *
 * The card was built for gold and said so in three places: the title, the dollar sign and two decimals
 * on every price, and the engine's name on two labels. Those three things live here, once per
 * instrument, so the card itself has no gold in it — and so the server and the browser agree on what
 * "EURUSD" means without either guessing.
 *
 * Gold is the default everywhere and is asked for exactly as it was before this file existed: no
 * `symbol` in the request, the same cache, the same history rows. Nothing about the gold card changes.
 *
 * Pure: no server imports, safe in a client bundle.
 */
export type FloorSymbol = "XAUUSD" | PairKey;
export type FloorMode = "quick" | "intraday" | "swing";

export type FloorInstrument = {
  key: FloorSymbol;
  /** The word on the toggle. */
  chip: string;
  /** The card's heading. */
  title: string;
  /** How a sentence refers to it: "Loading the live gold read…". */
  name: string;
  /** Whose read this is, for "GENX projected path" / "GEN FX wants". */
  engine: "GENX" | "GEN FX";
  /** Decimals a price is shown at. */
  dec: number;
  /** Printed in front of a price where gold prints a dollar sign. A currency pair's price is a rate, not dollars. */
  money: string;
  /** The Floor tab the card's expand button opens. */
  view: string;
};

export const FLOOR_INSTRUMENTS: FloorInstrument[] = [
  { key: "XAUUSD", chip: "Gold", title: "Gold Setup · XAUUSD", name: "gold", engine: "GENX", dec: 2, money: "$", view: "plays" },
  { key: "EURUSD", chip: "EUR/USD", title: "EUR/USD Setup · GEN FX", name: PAIRS.EURUSD.name, engine: "GEN FX", dec: PAIRS.EURUSD.dec, money: "", view: "genfx" },
  { key: "GBPJPY", chip: "GBP/JPY", title: "GBP/JPY Setup · GEN FX", name: PAIRS.GBPJPY.name, engine: "GEN FX", dec: PAIRS.GBPJPY.dec, money: "", view: "genfx" },
];

const GOLD = FLOOR_INSTRUMENTS[0];

/** Any spelling — "EURUSD", "eur/usd", "gbp-jpy" — to its instrument. Anything else, or nothing, is gold. */
export function floorInstrument(v: unknown): FloorInstrument {
  const k = String(v ?? "").toUpperCase().replace(/[^A-Z]/g, "");
  return FLOOR_INSTRUMENTS.find((i) => i.key === k) ?? GOLD;
}

/** The currency pair behind a symbol, or null for gold. */
export const fxPairKey = (s: FloorSymbol): PairKey | null => (s === "XAUUSD" ? null : s);

/** The card's own reading of a number (FloorHome's `gnum`), kept identical so gold prints as it did. */
const fin = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : v != null && Number.isFinite(Number(v)) ? Number(v) : null;

/**
 * Prices as the card prints them. Gold is unchanged from the card's own formatter: two decimals with
 * thousands separators, a dollar sign where it had one. A pair prints at its own precision
 * (1.12394, 208.739) with no sign.
 */
export function floorFmt(inst: FloorInstrument): { px: (n: unknown) => string; money: (n: unknown) => string } {
  const px = (n: unknown): string => {
    const v = fin(n);
    if (v == null) return "—";
    return inst.key === "XAUUSD"
      ? v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : v.toFixed(inst.dec);
  };
  return { px, money: (n: unknown) => (fin(n) == null ? "—" : inst.money + px(n)) };
}

/** The query the card sends. Gold sends exactly what it always has. */
export function setupQuery(mode: FloorMode, symbol: FloorSymbol, extra = ""): string {
  return `mode=${mode}${symbol === "XAUUSD" ? "" : `&symbol=${symbol}`}${extra}`;
}

/**
 * Where the card leaves a note for the GEN FX tool when its expand button is pressed on a pair, so the
 * tool opens on that pair instead of its default. Session storage; read once and removed.
 */
export const GENFX_OPEN_PAIR = "genfx:open-pair";

/** One cached payload per instrument per horizon. */
export const setupCacheKey = (symbol: FloorSymbol, mode: FloorMode): string => `${symbol}:${mode}`;
