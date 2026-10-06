import { gateFrom, CLOSED, type SetupLook } from "@/lib/setupAccess";
import { type SetupGate } from "@/lib/setupLock";

/**
 * "SEE THE PLAY" — opening a member's window on the live setups (owner 10-05: "Make them use credits
 * to view"). The route (/api/setups/pass) supplies the member, the ledger and the charge; the order
 * things happen in, and what is answered at each turn, is here, where it can be run without either.
 *
 * FOUR PROMISES:
 *   1. NOTHING IS CHARGED WHILE A WINDOW IS OPEN. A second tap, a Pass holder, an admin, someone FLOW
 *      has just charged for a setup: each is answered with the window they already have.
 *   2. NOTHING IS CHARGED ON A GUESS. "Closed" from a look that could not read the ledgers is not
 *      "has no window" (setupAccess.ts). On such a look nothing is charged and the member is told so:
 *      otherwise every tap during an outage would take credits and still show the lock.
 *   3. A WINDOW IS REPORTED OPEN ONLY AFTER A SPEND. A charge that did not go through opens nothing.
 *      One that may have (the answer was lost) is looked for in the ledger before anything is said.
 *   4. THE ANSWER SAYS WHAT HAPPENED TO THE CREDITS: `charged` is true when this call spent them,
 *      false when it certainly did not, and null in the one case where that could not be found out.
 */
export type GateAnswer = { ok: true } | { ok: false; reason: "unauthorized" } | { ok: false; reason: "insufficient"; balance: number };

export type PassDeps = {
  /** This member's window, asked of the ledgers afresh. */
  look: () => Promise<SetupLook>;
  /** Can they pay for a read? (credits.ts gateCredits — it answers yes when the balance cannot be read.) */
  gate: () => Promise<GateAnswer>;
  /** Spend one read's credits. The balance left, or null when the spend did not go through — or its answer was lost. */
  charge: () => Promise<number | null>;
  /** Drop anything remembered about this member's window. */
  forget: () => void;
  now: () => number;
};

export type PassError = "unauthorized" | "insufficient" | "unavailable" | "charge_failed" | "busy";
export type PassAnswer = { status: number; body: SetupGate & { charged: boolean | null; balance?: number | null; error?: PassError } };

export async function openSetups(d: PassDeps): Promise<PassAnswer> {
  const cur = await d.look();
  if (cur.gate.open) return { status: 200, body: { ...cur.gate, charged: false } };
  // Could not tell whether they already have a window: do not take credits to find out.
  if (!cur.complete) return { status: 503, body: { ...CLOSED, charged: false, error: "unavailable" } };

  const short = (g: GateAnswer): PassAnswer | null =>
    g.ok ? null
      : g.reason === "unauthorized" ? { status: 401, body: { ...CLOSED, charged: false, error: "unauthorized" } }
      : { status: 402, body: { ...CLOSED, charged: false, error: "insufficient", balance: g.balance } };
  const refused = short(await d.gate());
  if (refused) return refused;

  const balance = await d.charge();
  d.forget();
  if (balance == null) {
    // No answer from the spend. Either it was refused (the gate above lets a member through when the
    // balance cannot be read), or it went through and the answer was lost. The ledger knows which.
    const after = await d.look();
    if (after.gate.open) return { status: 200, body: { ...after.gate, charged: true, balance: null } };
    const now = short(await d.gate());
    if (after.complete && now && now.body.error === "insufficient") return now;
    // The ledger was read and shows no spend: nothing was taken. If it could not be read, that is not known.
    return { status: 200, body: { ...CLOSED, charged: after.complete ? false : null, error: "charge_failed" } };
  }

  const after = await d.look();
  // The spend went through. If the look that follows it could not read the ledger, the member is
  // still not told "locked" for what they have just paid for: the window runs from now.
  const open = after.gate.open ? after.gate : gateFrom({ admin: false, pass: false, lastSpendMs: d.now() }, d.now());
  // (A Pass that arrived between the look and the charge is not charged: credits.ts logs the use and spends nothing.)
  return { status: 200, body: { ...open, charged: open.via === "credits", balance } };
}

/*
 * ONE TAP AT A TIME. A second request for the same member that arrives while the first is between
 * its look and its spend would look, see no window, and spend too. While one is in flight on this
 * server the next is turned away unspent, and told so.
 *
 * (This is one server's memory. The button is disabled while its request is out, so a double tap
 * does not get this far; two requests sent at the same instant from two devices could still land on
 * two servers and both spend. That would show in the ledger as two reads seconds apart.)
 */
const IN_FLIGHT = new Set<string>();
export async function oneAtATime<T>(key: string, busy: () => T, work: () => Promise<T>): Promise<T> {
  if (IN_FLIGHT.has(key)) return busy();
  IN_FLIGHT.add(key);
  try { return await work(); } finally { IN_FLIGHT.delete(key); }
}
