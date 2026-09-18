/**
 * THE EXECUTION STATE MACHINE.
 *
 * Every trade has exactly one state and every change is a persisted transition with a reason. The single
 * most important rule: a timeout goes to `unknown`, and `unknown` is only ever left by RECONCILIATION —
 * never by retrying. A missed action is recoverable; a duplicated one is not.
 */
import type { ExecState } from "./types";

export const TRANSITIONS: Record<ExecState, ExecState[]> = {
  analyzing: ["setup_forming", "invalidated"],
  setup_forming: ["armed", "invalidated"],
  armed: ["entry_requested", "invalidated"],
  entry_requested: ["order_submitted", "invalidated", "error"],
  order_submitted: ["order_acknowledged", "error", "unknown"],
  order_acknowledged: ["filled", "canceled", "unknown"],
  filled: ["open", "unknown"],
  open: ["protected", "partial_taken", "exit_requested", "closed", "unknown"],
  protected: ["partial_taken", "runner", "exit_requested", "closed", "unknown"],
  partial_taken: ["runner", "protected", "exit_requested", "closed", "unknown"],
  runner: ["exit_requested", "protected", "closed", "unknown"],
  exit_requested: ["closed", "unknown", "error"],
  closed: [],
  canceled: [],
  invalidated: [],
  error: ["unknown", "closed"],
  unknown: ["open", "closed", "canceled", "error"],   // reconciliation outcomes only
};

export const TERMINAL: ExecState[] = ["closed", "canceled", "invalidated"];
export const isTerminal = (s: ExecState) => TERMINAL.includes(s);
/** States where money is at the broker — protection must keep working no matter what else is broken. */
export const LIVE_STATES: ExecState[] = ["filled", "open", "protected", "partial_taken", "runner", "exit_requested"];
export const isLive = (s: ExecState) => LIVE_STATES.includes(s);

export type Transition = { from: ExecState; to: ExecState; at: number; reason: string; ok: boolean };

export function canTransition(from: ExecState, to: ExecState): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

/** Attempt a transition. An illegal move is refused and recorded — never silently applied. */
export function transition(from: ExecState, to: ExecState, reason: string, at = Date.now()): Transition {
  return { from, to, at, reason, ok: canTransition(from, to) };
}

/**
 * What to do when the broker does not answer. Never "send it again": we do not know whether the first
 * request reached the exchange, and finding out is cheap while a duplicate position is not.
 */
export function onTimeout(from: ExecState): { to: ExecState; action: "reconcile" | "none" } {
  if (from === "order_submitted" || from === "order_acknowledged" || from === "exit_requested" || isLive(from)) {
    return { to: "unknown", action: "reconcile" };
  }
  return { to: from, action: "none" };
}

/** Resolve `unknown` from what the broker actually reports — the only legal way out of that state. */
export function reconcile(observed: { hasPosition: boolean; hasWorkingOrder: boolean; wasFilledInHistory: boolean }): { to: ExecState; reason: string } {
  if (observed.hasPosition) return { to: "open", reason: "Broker reports an open position — adopting it" };
  if (observed.hasWorkingOrder) return { to: "canceled", reason: "Order still working with no position — cancelled to avoid a stale fill" };
  if (observed.wasFilledInHistory) return { to: "closed", reason: "History shows a fill that is now flat — booking the outcome" };
  return { to: "canceled", reason: "Broker shows no order, no position and no fill — nothing happened" };
}
