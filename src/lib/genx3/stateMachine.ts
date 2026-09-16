/** Deterministic setup lifecycle. Terminal states never transition again. */
export type SetupState = "WAIT" | "WATCHING" | "APPROACHING" | "ARMED" | "TRIGGERED" | "PUBLISHED" | "EXPIRED" | "INVALIDATED" | "REJECTED_BY_FLOW";
export const TERMINAL: ReadonlySet<SetupState> = new Set(["PUBLISHED", "EXPIRED", "INVALIDATED", "REJECTED_BY_FLOW"]);
const ORDER: Record<SetupState, number> = { WAIT: 0, WATCHING: 1, APPROACHING: 2, ARMED: 3, TRIGGERED: 4, PUBLISHED: 5, EXPIRED: 9, INVALIDATED: 9, REJECTED_BY_FLOW: 9 };

export function canTransition(from: SetupState, to: SetupState): boolean {
  if (from === to) return false;
  if (from === "PUBLISHED" && to === "REJECTED_BY_FLOW") return true; // Flow held every account
  if (TERMINAL.has(from)) return false;
  if (to === "EXPIRED" || to === "INVALIDATED") return true;
  if (to === "PUBLISHED") return from === "TRIGGERED";
  if (to === "REJECTED_BY_FLOW") return from === "TRIGGERED" || from === "PUBLISHED";
  return ORDER[to] > ORDER[from]; // forward only (a setup never goes back to WATCHING)
}
