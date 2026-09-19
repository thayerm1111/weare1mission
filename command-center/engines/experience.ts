/**
 * THE EXPERIENCE STATE MACHINE.
 *
 * One value that says what COMMAND CENTER XAUUSD is currently doing, so the screen never has to work it
 * out from four separate booleans and get it wrong at the edges. The UI reads this and changes emphasis;
 * it does NOT navigate, and it does NOT become a different product. That is the whole design constraint:
 * the trade becomes a new object of attention for the intelligence that already exists.
 *
 * THE ONE RULE THAT MATTERS MOST IS IN `positionConfirmed`.
 *
 * An order being accepted is not a position being open. A broker can accept an order and fill nothing, or
 * fill it somewhere other than where we asked, or fill it and hand us the confirmation four seconds late.
 * A screen that flips into TRADE ACTIVE on acceptance is telling a member they are in a trade that may not
 * exist — and the member will then manage a position that isn't there. So POSITION_ACTIVE is reachable
 * ONLY from a reconciled position row that the broker itself has confirmed. Everything between the click
 * and that confirmation is ORDER_PENDING, and it says so.
 */
import type { BrainSetup } from "./setup";

export type ExperienceState =
  | "market_observing"
  | "setup_watching"
  | "trade_preparing"
  | "order_submitting"
  | "order_pending"
  | "position_active"
  | "position_protected"
  | "position_weakening"
  | "position_exiting"
  | "trade_complete"
  | "returning_to_market";

export const EXPERIENCE_LABEL: Record<ExperienceState, string> = {
  market_observing: "OBSERVING",
  setup_watching: "SETUP DEVELOPING",
  trade_preparing: "TRADE READY",
  order_submitting: "EXECUTING",
  order_pending: "WAITING FOR FILL",
  position_active: "TRADE ACTIVE",
  position_protected: "POSITION PROTECTED",
  position_weakening: "WATCHING CLOSELY",
  position_exiting: "CLOSING",
  trade_complete: "TRADE COMPLETE",
  returning_to_market: "OBSERVING",
};

/** How focused the orb is. The existing presence animation reads this — it is not a new animation. */
export const EXPERIENCE_FOCUS: Record<ExperienceState, "broad" | "narrowing" | "locked" | "alert" | "calm"> = {
  market_observing: "broad",
  setup_watching: "narrowing",
  trade_preparing: "narrowing",
  order_submitting: "locked",
  order_pending: "locked",
  position_active: "locked",
  position_protected: "calm",
  position_weakening: "alert",
  position_exiting: "alert",
  trade_complete: "calm",
  returning_to_market: "broad",
};

/** How long a finished trade stays on screen before the Command Center goes back to watching gold. */
export const COMPLETE_WINDOW_MS = 6 * 60_000;

export type PendingExecution = {
  executionId: string;
  state: string;          // submitting | order_accepted | reconciliation_required | error | …
  at: number;
  uncertain: boolean;
};

export type CompletedTrade = {
  at: number;
  side: "buy" | "sell";
  style: string;
  pips: number;
  r: number | null;
  money: number | null;
  mfePips: number;
  maePips: number;
  heldMs: number;
  entry: number;
  exit: number;
  exitReason: string | null;
  /** THE BRAIN's account of what happened. Built from the numbers, never from a template. */
  say: string;
  /**
   * How it was TRADED, as opposed to how it turned out.
   *
   * Optional rather than nullable on purpose: `completionRead` builds its sentence from the raw numbers
   * alone and must stay callable without a grade, because the grade is written a moment after the report
   * and the screen has to be able to say something true in between.
   */
  grade?: {
    score: number;
    verdict: string;
    lines: { what: string; mark: string | null; note: string }[];
    lesson: string | null;
    capture: number | null;
  } | null;
};

export type ExperienceInput = {
  setup: BrainSetup | null;
  tradeActive: boolean;
  characterState: string | null;      // from brain/trade.ts
  protectionAction: string | null;
  beyondBreakEven: boolean;
  exiting: boolean;
  pending: PendingExecution | null;
  completed: CompletedTrade | null;
  now?: number;
};

export type Experience = {
  state: ExperienceState;
  label: string;
  focus: "broad" | "narrowing" | "locked" | "alert" | "calm";
  /** True only while a real, broker-confirmed position exists. */
  tradeLens: boolean;
  /** Present while a finished trade is still being shown. */
  completed: CompletedTrade | null;
  /** One line for the strip at the top of the screen. */
  note: string | null;
};

export function experienceOf(i: ExperienceInput): Experience {
  const now = i.now ?? Date.now();
  const make = (state: ExperienceState, note: string | null = null, completed: CompletedTrade | null = null): Experience => ({
    state,
    label: EXPERIENCE_LABEL[state],
    focus: EXPERIENCE_FOCUS[state],
    tradeLens: state === "position_active" || state === "position_protected" || state === "position_weakening" || state === "position_exiting",
    completed,
    note,
  });

  /* 1 — a confirmed position outranks everything. This branch is the only one that can produce a
         trade-lens state, and it is reachable only from `tradeActive`, which is set from a position row
         the broker confirmed. */
  if (i.tradeActive) {
    if (i.exiting) return make("position_exiting", "Close request sent — waiting for the broker to confirm.");
    if (i.characterState === "invalidated" || i.characterState === "character_change") {
      return make("position_weakening", "The reason for this trade has changed.");
    }
    if (i.characterState === "thesis_weakening") return make("position_weakening", "The case for this trade is thinner than it was.");
    if (i.beyondBreakEven || i.protectionAction === "protect_stop") {
      return make("position_protected", "Your stop is protected — this costs nothing to hold.");
    }
    return make("position_active");
  }

  /* 2 — an order is out and nothing has come back yet. NOT a trade. Never a trade until the broker
         says so, however long that takes. */
  if (i.pending) {
    if (i.pending.state === "submitting") return make("order_submitting", "Sending the order.");
    if (i.pending.state === "order_accepted") {
      return make("order_pending", "The broker accepted the order. I'm confirming the fill before I call this a position.");
    }
    if (i.pending.state === "reconciliation_required" || i.pending.uncertain) {
      return make("order_pending", "I don't have a clear answer from the broker yet, so I'm checking rather than sending anything else.");
    }
  }

  /* 3 — a trade that has just finished stays on screen for a moment, then lets go. */
  if (i.completed && now - i.completed.at < COMPLETE_WINDOW_MS) {
    const fresh = now - i.completed.at < COMPLETE_WINDOW_MS * 0.6;
    return fresh
      ? make("trade_complete", null, i.completed)
      : make("returning_to_market", "Back to watching the whole market.", i.completed);
  }

  /* 4 — no position, no order: what does THE BRAIN see? */
  const st = i.setup?.state;
  if (st === "trade_ready") return make("trade_preparing", i.setup?.headline ?? null);
  if (st === "waiting_for_trigger" || st === "setup_developing" || st === "watching") {
    return make("setup_watching", i.setup?.headline ?? null);
  }
  return make("market_observing");
}

/**
 * THE BRAIN's account of a finished trade.
 *
 * Written from what actually happened — the excursions, the exit, the reason — and honest about a loss.
 * A system that only narrates its winners teaches a member nothing and is not worth listening to.
 */
export function completionRead(t: Omit<CompletedTrade, "say">): string {
  const won = t.pips > 0;
  const dir = t.side === "buy" ? "long" : "short";
  const mins = Math.max(1, Math.round(t.heldMs / 60_000));
  const bits: string[] = [];

  bits.push(
    won
      ? `The ${dir} worked. We took ${Math.round(t.pips)} pips${t.r != null ? `, ${t.r}R` : ""} out of it over ${mins} minutes.`
      : `The ${dir} didn't work. It cost ${Math.abs(Math.round(t.pips))} pips${t.r != null ? `, ${Math.abs(t.r)}R` : ""} over ${mins} minutes.`,
  );

  // The most useful sentence in the whole report: how much of the available move we actually kept.
  if (t.mfePips > 0) {
    const kept = t.mfePips > 0 ? Math.round((Math.max(0, t.pips) / t.mfePips) * 100) : 0;
    if (won && kept >= 75) bits.push(`The best it saw was ${Math.round(t.mfePips)} pips, so we kept most of the move.`);
    else if (won) bits.push(`The best it saw was ${Math.round(t.mfePips)} pips — we gave back ${Math.round(t.mfePips - t.pips)} of them before getting out.`);
    else bits.push(`It was ${Math.round(t.mfePips)} pips onside at its best, and that profit was never protected.`);
  }
  if (t.maePips < -1) {
    bits.push(`The worst it got was ${Math.round(t.maePips)} pips${won ? ", so the entry was late but the idea was right" : ""}.`);
  }
  if (t.exitReason) bits.push(t.exitReason);

  return bits.join(" ");
}
