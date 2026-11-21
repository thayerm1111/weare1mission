/**
 * GENX ON SCREEN — the engine's states in the platform's words (owner 11-20 brief §8: "readable status
 * names and timestamps instead of raw enums such as WAIT_FOR_SELL_TRIGGER").
 *
 * Display only: the engine's own action string is kept everywhere it is used, and nothing here decides,
 * sizes or places anything.
 */

export type GenxSide = "buy" | "sell" | null;

/** The engine's action, said plainly, with the side it leans to (null: no side). */
export function actionWords(action: string | null | undefined): { label: string; side: GenxSide; waiting: boolean } {
  switch (String(action ?? "").toUpperCase()) {
    case "BUY_NOW": return { label: "Buy now", side: "buy", waiting: false };
    case "SELL_NOW": return { label: "Sell now", side: "sell", waiting: false };
    case "BUY_LIMIT": return { label: "Buy at the entry zone", side: "buy", waiting: true };
    case "SELL_LIMIT": return { label: "Sell at the entry zone", side: "sell", waiting: true };
    case "BUY_STOP": return { label: "Buy on a break higher", side: "buy", waiting: true };
    case "SELL_STOP": return { label: "Sell on a break lower", side: "sell", waiting: true };
    case "WAIT_FOR_BUY_TRIGGER": return { label: "Waiting for a buy trigger", side: "buy", waiting: true };
    case "WAIT_FOR_SELL_TRIGGER": return { label: "Waiting for a sell trigger", side: "sell", waiting: true };
    default: return { label: "No trade — waiting", side: null, waiting: true };
  }
}

/**
 * The engine's conviction score, with the band the classic screen used. It is a score out of 100, not a
 * chance of winning — it is never written as a percentage (brief: "A conviction score must not be presented
 * as a win probability unless it has actually been calibrated").
 */
export function convictionWords(score: number | null | undefined): string | null {
  if (typeof score !== "number" || !Number.isFinite(score)) return null;
  const band = score >= 74 ? "strong" : score >= 62 ? "building" : score >= 50 ? "forming" : "weak";
  return `Conviction ${Math.round(score)}/100 · ${band}`;
}

/** A step of GENX's expected path in sentence case ("CONFIRM BUYERS" → "Confirm buyers", "TP1" → "Target 1"). */
export function stepWords(t: string): string {
  const s = String(t ?? "").trim();
  const tp = /^TP(\d)$/i.exec(s);
  if (tp) return `Target ${tp[1]}`;
  if (!s) return "";
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/** How long GENX expects the trade to take: [30, 240] → "30m–4h". */
export function holdWords(m: [number, number] | null | undefined): string | null {
  if (!Array.isArray(m) || m.length !== 2 || !m.every((x) => typeof x === "number" && Number.isFinite(x))) return null;
  const f = (x: number) => (x >= 60 ? `${Math.round(x / 60)}h` : `${Math.round(x)}m`);
  return `${f(m[0])}–${f(m[1])}`;
}

/** The current run of results, newest first: 3 wins in a row, 1 loss … A flat trade ends a run. */
export function streakOf(newestFirst: { pips: number }[]): { n: number; win: boolean } | null {
  let n = 0; let win: boolean | null = null;
  for (const r of newestFirst) {
    if (!Number.isFinite(r.pips) || r.pips === 0) break;
    const w = r.pips > 0;
    if (win === null) win = w;
    if (w !== win) break;
    n += 1;
  }
  return win === null ? null : { n, win };
}
