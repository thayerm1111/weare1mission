/**
 * GENX TRADING STYLES (owner 09-18: "I want the brain to have 3 styles — one that calls more trades and one
 * that is more picky. The user can enable all 3 or 1 or however they want.")
 *
 *   rapid     — 40–50 pip target, 30–40 pip stop. The busiest style: momentum pushes off a session level.
 *   structure — break and retest. Picky: a level must break, price must come back to it, and the retest must
 *               hold before anything is taken.
 *   swing     — the patient one. Daily/4h levels, wide stop, targets measured in hundreds of pips.
 *
 * Every style produces the SAME Setup shape, so the scanner, the fan-out, billing, the trade manager and the
 * live card treat them identically — only the numbers and how often they fire differ. A member enables any
 * combination per account; a style nobody has enabled is still evaluated in shadow so its record is on file.
 */
export type StyleId = "rapid" | "structure" | "swing";
export const STYLES: StyleId[] = ["rapid", "structure", "swing"];

export const STYLE_LABEL: Record<StyleId, string> = {
  rapid: "Rapid",
  structure: "Structure",
  swing: "Swing",
};

export const STYLE_BLURB: Record<StyleId, string> = {
  rapid: "Quick strikes off session levels — 40–50 pip targets, 30–40 pip stops. The most trades; expect several a day.",
  structure: "Break and retest only. A level has to break, price has to come back to it, and the retest has to hold. Fewer trades, cleaner ones.",
  swing: "Daily and 4-hour levels with room to run. A handful of trades a week, targets in the hundreds of pips.",
};

export type Bar = { t?: string | number; o: number; h: number; l: number; c: number };

/** Everything a style needs to make its call. Built once per scan and shared by all three. */
export type StyleCtx = {
  price: number;
  atr: number | null;        // 15m ATR in dollars
  pip: number;               // 0.1 for gold
  nowMs: number;
  m5: Bar[];
  m15: Bar[];
  h1: Bar[];
  h4: Bar[];
  d1: Bar[];
  session: "asia" | "london" | "ny" | "off";
  pdh: number | null;        // previous day high / low
  pdl: number | null;
};

export type Setup = {
  style: StyleId;
  side: "buy" | "sell";
  entryLow: number;
  entryHigh: number;
  stop: number;
  tp1: number;
  tp2: number | null;
  tp3: number | null;
  confidence: number;        // 0–100
  reason: string;            // plain English, shown to members
  level: number | null;      // the level the trade is built on
};

export const round2 = (n: number) => +n.toFixed(2);
export const pipsBetween = (a: number, b: number, pip: number) => Math.round(Math.abs(a - b) / pip);

/** NY session buckets (gold's real character: Asia ranges, London expands, NY reverses). */
export function sessionOf(nowMs: number): StyleCtx["session"] {
  const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).format(new Date(nowMs)));
  if (h >= 3 && h < 8) return "london";
  if (h >= 8 && h < 12) return "ny";
  if (h >= 19 || h < 3) return "asia";
  return "off";
}
