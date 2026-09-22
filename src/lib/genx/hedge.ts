/**
 * OPPOSITE-SIDE ENTRIES (owner 09-22: "turn it off and also turn off the stop hold if there's a sell
 * active. Take everything that GenX says to take. Missed a buy that could of saved some money").
 *
 * Until now an account holding ANY open GENX gold trade was skipped for the next GENX call, whichever
 * way that call went. So on a day when GENX sold at 12:36 and bought at 12:51, the buy — the trade that
 * would have paid for the open sell — reached nobody. The cap exists for a real reason (09-15: two
 * signals 97 seconds apart both filled one account), so it is not removed: it becomes SIDE-AWARE.
 *
 *   same side as the open trade  → still refused. That is the stacking the cap was built to stop.
 *   opposite side                → allowed. Two positions, each with its own stop and target.
 *
 * Both the reservation (a Postgres lock, keyed per account+symbol) and the broker-verified ledger check
 * follow the same rule, which is what this file is: one definition of the rule, used by both.
 *
 * Note this needs a broker account that allows both directions at once (a hedging account). On a
 * netting account the opposite order reduces or closes the open trade instead of opening a second one.
 *
 * Kill switch: GENX_HEDGE=off returns the desk to one gold trade per account, either way.
 */
export function hedgeEnabled(): boolean {
  return String(process.env.GENX_HEDGE ?? "on").trim().toLowerCase() !== "off";
}

const dirOf = (s: string | null | undefined): "BUY" | "SELL" | null => {
  const d = String(s ?? "").trim().toLowerCase();
  return d === "buy" ? "BUY" : d === "sell" ? "SELL" : null;
};

/**
 * The key an account's gold exposure is reserved under. Side-keyed while hedging is on, so a BUY and a
 * SELL hold separate reservations; the plain symbol otherwise (exactly the old behaviour).
 */
export function goldResvKey(symbol: string, side?: string | null): string {
  const base = String(symbol ?? "").trim().toUpperCase();
  const d = dirOf(side);
  return hedgeEnabled() && base && d ? `${base}:${d}` : base;
}

/** Does this open position block a new entry? Same side always; opposite side only when hedging is off. */
export function blocksEntry(openSide: string | null | undefined, entrySide: string): boolean {
  if (!hedgeEnabled()) return true;
  const a = dirOf(openSide), b = dirOf(entrySide);
  if (!a || !b) return true;               // unknown side → treat as blocking, never stack blind
  return a === b;
}

/** The open rows that stand in the way of an entry on `side`. */
export function blockingRows<T extends { side?: string | null }>(rows: T[], side: string): T[] {
  return rows.filter((r) => blocksEntry(r.side, side));
}
