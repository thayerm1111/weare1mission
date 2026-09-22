/**
 * ONE POSITION PER SIDE (owner 09-22: "Atlas shouldn't be blocked by a trade open. They each can have
 * a sell or a buy open each").
 *
 * ATLAS's rule was one open trade per account, full stop: while it held a sell, the buy it called an
 * hour later was refused — the trade that would have covered the sell. The rule becomes side-aware,
 * exactly as the older desk's did on the same day (the two engines share no code by design, so this is
 * the same rule written once on each side of the wall):
 *
 *   an open SELL blocks another SELL, never a BUY — and the mirror.
 *
 * Stacking two trades the SAME way is still refused. That is what the one-position limit was for.
 *
 * This needs a broker account that holds both directions at once (a hedging account); on a netting
 * account the opposite order reduces the open trade instead of opening a second one.
 *
 * Kill switch: CC_HEDGE=off (or GENX_HEDGE=off, which switches the whole desk) → one trade per account.
 */
export function hedgeEnabled(): boolean {
  const v = String(process.env.CC_HEDGE ?? process.env.GENX_HEDGE ?? "on").trim().toLowerCase();
  return v !== "off";
}

const dirOf = (s: string | null | undefined): "BUY" | "SELL" | null => {
  const d = String(s ?? "").trim().toLowerCase();
  return d === "buy" ? "BUY" : d === "sell" ? "SELL" : null;
};

/** Does this open position stand in the way of a new entry on `entrySide`? */
export function blocksEntry(openSide: string | null | undefined, entrySide?: string | null): boolean {
  if (!hedgeEnabled()) return true;
  const a = dirOf(openSide), b = dirOf(entrySide);
  if (!a || !b) return true;          // unknown side → treat as blocking, never stack blind
  return a === b;
}

/** The open positions that block an entry on `entrySide` (all of them when hedging is off). */
export function blockingPositions<T extends { side?: string | null }>(open: T[], entrySide?: string | null): T[] {
  return open.filter((p) => blocksEntry(p.side, entrySide));
}
