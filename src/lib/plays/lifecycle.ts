/**
 * AN OM AI PLAY'S THREE STORIES (owner 11-21 brief §9) — kept apart, because they are three different facts:
 *
 *   the analysis   what the engine concluded when the play was made: a released setup, an idea it had NOT
 *                  confirmed (its institutional gate said "no trade" yet), or no setup at all
 *   the tracking   what price did afterwards, measured against the play's own levels by the result check
 *                  (/api/om-signal-check): a target or the stop was reached — or not yet
 *   an account     whether any order was placed from it. A play records no order: that lives in FLOW.
 *
 * Seen on the owner's saved plays (11-20/21): "Sell idea, not confirmed" beside "Target reached" read as if an
 * unconfirmed idea had been a winning trade. The tracking of an idea is therefore said as price only, in a
 * neutral voice; nothing here turns an idea into a confirmed setup, or a level touched into a fill.
 *
 * Pure and display-only: the play's fields are read as they were saved.
 */
export type PlayDirection = "LONG" | "SHORT" | "NEUTRAL";
export type PlayLevelsSignal = {
  direction: PlayDirection;
  status?: "setup" | "no_trade";
  no_trade_reason?: string;
  entry?: number | null; stopLoss?: number | null; takeProfits?: (number | null)[] | null;
};
export type PlayLike = { status: "open" | "win" | "loss"; hitTp?: number; signal: PlayLevelsSignal };

const fin = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** Pip size by instrument class: FX 0.0001, JPY pairs 0.01, gold 0.1, silver 0.01, crypto and index CFDs in points. */
export function playPip(symbol: string): number {
  const s = (symbol || "").toUpperCase();
  if (s.includes("JPY")) return 0.01;
  if (s.includes("XAU") || s.includes("GOLD")) return 0.1;
  if (s.includes("XAG") || s.includes("SILVER")) return 0.01;
  if (/(BTC|ETH|SOL|XRP|DOGE|US30|NAS|NDX|SPX|US100|US500|GER|UK100|DXY)/.test(s)) return 1;
  return 0.0001;
}

export type PlayAnalysis = { kind: "setup" | "idea" | "none"; side: "Buy" | "Sell" | null; label: string };

/** What the engine concluded. A play saved before the confirmation gate existed has no status: it was released. */
export function analysisOf(s: PlayLevelsSignal): PlayAnalysis {
  if (s.direction === "NEUTRAL") return { kind: "none", side: null, label: "No setup" };
  const side = s.direction === "LONG" ? "Buy" : "Sell";
  if (s.status === "no_trade") return { kind: "idea", side, label: `${side} idea, not confirmed` };
  return { kind: "setup", side, label: `${side} setup` };
}

export type PlayTracking = { label: string; tone: "pos" | "neg" | null; note: string; resolved: boolean };

/** What price did afterwards against the play's levels — price only, never an order. */
export function trackingOf(r: PlayLike): PlayTracking {
  const a = analysisOf(r.signal);
  const n = fin(r.hitTp) ? r.hitTp : 1;
  if (a.kind === "none") return { label: "Nothing to track", tone: null, note: "No setup was given, so there are no levels to follow.", resolved: false };
  if (r.status === "win") {
    return a.kind === "idea"
      ? { label: `Price later reached target ${n}`, tone: null, note: "Measured against the idea's levels. The idea was never confirmed, and no order is implied.", resolved: true }
      : { label: `Price reached target ${n}`, tone: "pos", note: "Measured against the play's levels after it was made — a record of price, not an order on your account.", resolved: true };
  }
  if (r.status === "loss") {
    return a.kind === "idea"
      ? { label: "Price later reached the stop level", tone: null, note: "Measured against the idea's levels. The idea was never confirmed, and no order is implied.", resolved: true }
      : { label: "Price reached the stop", tone: "neg", note: "Measured against the play's levels after it was made — a record of price, not an order on your account.", resolved: true };
  }
  return a.kind === "idea"
    ? { label: "Not confirmed yet", tone: null, note: "The engine was waiting for the market to confirm it. Check result measures its levels against price since.", resolved: false }
    : { label: "Not resolved yet", tone: null, note: "Neither a target nor the stop has been reached by the last check.", resolved: false };
}

/** Reward to risk for each target, measured from the entry and the stop. */
export function targetsWithR(s: PlayLevelsSignal): { n: number; price: number; r: number | null }[] {
  const tps = (s.takeProfits ?? []).filter(fin);
  const risk = fin(s.entry) && fin(s.stopLoss) ? Math.abs(s.entry - s.stopLoss) : 0;
  return tps.map((price, i) => ({ n: i + 1, price, r: risk > 0 && fin(s.entry) ? +(Math.abs(price - s.entry) / risk).toFixed(2) : null }));
}

/** How far a price is from the entry, in pips. */
export const pipsBetween = (symbol: string, a: number, b: number) => Math.round(Math.abs(a - b) / playPip(symbol));
