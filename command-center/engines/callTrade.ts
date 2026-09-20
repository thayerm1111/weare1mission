/**
 * TAKING THE BRAIN'S TRADE.
 *
 * One member taps TAKE THIS TRADE. Everything between that tap and a live order lives here, and the
 * shape of it is governed by one idea: THE MEMBER APPROVES A SPECIFIC TRADE, NOT A BUTTON.
 *
 * So the numbers that reach the broker are never the numbers the browser sent. The setup is recomputed
 * on the server from the current market read, and then compared against the one the member was actually
 * looking at. If gold has moved, or THE BRAIN has changed its mind, or the stop is no longer where it was,
 * the order is NOT sent — the member is shown what changed and asked again. A browser that has been open
 * for four minutes is a stale opinion, and executing on it would be executing on a screenshot.
 *
 * The second idea: risk comes from the PROFILE, never from the request. The member sets how much of their
 * account THE BRAIN may use once, deliberately, in a place designed for that decision. A per-trade risk
 * value arriving in a POST body is exactly the kind of thing that is one bug away from being 20%.
 */
import { requireConsent } from "./consent";
import { db } from "../adapters/db";
import { prepare, execute, type ExecuteResult } from "./executor";
import { findSetup, stillValid, type BrainSetup, type SetupState } from "./setup";
import { getProfile, asSetupProfile } from "./profile";
import { selectedAccount } from "./broker";
import { STYLE } from "../core/style";
import type { MarketSnapshot, Side } from "../core/types";
import type { Bias } from "../brain/types";

/** What the member was looking at when they tapped. Used to detect drift, never to execute from. */
export type ApprovedSetup = {
  side: Side;
  style: string;
  stop: number;
  invalidationPrice: number | null;
};

export type TakeResult =
  | { ok: false; state: SetupState | "drifted" | "error"; message: string; setup?: BrainSetup }
  | { ok: true; execution: ExecuteResult; setup: BrainSetup };

/** How far the stop may have moved since the member looked, as a fraction of the trade's own risk. */
const STOP_DRIFT_TOLERANCE = 0.25;

export async function takeSetup(
  userId: string,
  approved: ApprovedSetup,
  idempotencyKey: string,
  snapshot: MarketSnapshot | null,
  marketIsOpen: boolean,
  thesis?: { bias: Bias | null; confidence: number | null },
): Promise<TakeResult> {
  /*
   * THE SAME GATE AGAIN, ONE LAYER DOWN.
   *
   * The route already checks this, so in normal operation the check here never fires. It exists
   * because this function is the single place an order is actually sent, and a future caller — a new
   * route, a worker, a voice path that grows an execution branch — would otherwise inherit market
   * access without inheriting the rule. A duplicated check costs one query; a missed one sends an
   * order for somebody who never signed.
   */
  const gate = await requireConsent(userId);
  if (!gate.ok) return { ok: false, state: "error", message: gate.reason };

  const profile = await getProfile(userId);

  // 1 — what does THE BRAIN say RIGHT NOW? Not what the browser remembers.
  const setup = findSetup({
    snapshot,
    profile: asSetupProfile(profile),
    marketOpen: marketIsOpen,
    thesisBias: thesis?.bias ?? null,
    thesisConfidence: thesis?.confidence ?? null,
  });

  const valid = stillValid(setup, snapshot);
  if (!valid.ok) {
    await record(userId, setup, snapshot, "expired", valid.reason);
    return { ok: false, state: valid.state, message: valid.reason, setup };
  }

  // 2 — is it still the same trade the member approved?
  if (setup.side !== approved.side) {
    const msg = `I was showing you a ${approved.side.toUpperCase()} and I now want a ${String(setup.side).toUpperCase()}. I'm not sending that on the old approval — have another look.`;
    await record(userId, setup, snapshot, "expired", "side changed before execution");
    return { ok: false, state: "drifted", message: msg, setup };
  }
  if (setup.style !== approved.style) {
    const msg = `This is ${STYLE[setup.style!].label} now, not ${String(approved.style).toUpperCase()} — which changes how I'd manage it. Take another look before I send it.`;
    await record(userId, setup, snapshot, "expired", "style changed before execution");
    return { ok: false, state: "drifted", message: msg, setup };
  }
  if (setup.stop != null && snapshot) {
    const risk = Math.abs(snapshot.price - setup.stop);
    if (risk > 0 && Math.abs(setup.stop - approved.stop) > risk * STOP_DRIFT_TOLERANCE) {
      const msg = `The stop has moved from ${approved.stop.toFixed(2)} to ${setup.stop.toFixed(2)} since you looked. That is a different trade — confirm it again and I'll send it.`;
      await record(userId, setup, snapshot, "expired", "stop moved before execution");
      return { ok: false, state: "drifted", message: msg, setup };
    }
  }

  // 3 — the account, and the risk THE PROFILE allows. Not the request.
  const account = await selectedAccount(userId);
  if (!account) {
    return { ok: false, state: "error", message: "Connect a TradeLocker account before taking a trade.", setup };
  }
  if (account.is_live && !account.live_authorized_at) {
    return { ok: false, state: "error", message: "This is a LIVE account and live trading has not been authorised on it yet.", setup };
  }

  const prepared = await prepare(userId, {
    accountRowId: account.id,
    side: setup.side!,
    style: setup.style!,
    entry: null,                               // at market: the setup's entry zone is where we are
    stop: setup.stop!,
    takeProfit: setup.initialObjective,
    riskPct: profile.riskPct,
    origin: "brain",
    snapshot,
    thesis: {
      reason: setup.thesis,
      expected: `${setup.expectedMovePips?.[0]}–${setup.expectedMovePips?.[1]} pips toward ${setup.initialObjective}`,
      invalidation: setup.invalidation,
      invalidationPrice: setup.invalidationPrice,
      strategy: setup.strategy,
      styleWhy: setup.styleWhy,
      confidence: setup.confidence,
    },
    evidence: setup.conditions.filter((x) => x.met).map((x) => `${x.text} — ${x.detail}`),
  });

  if (!prepared.ok) {
    await record(userId, setup, snapshot, "passed", prepared.reason);
    return { ok: false, state: "error", message: prepared.reason, setup };
  }

  // 4 — send it. The idempotency key is the one issued when the card was rendered, so a second tap,
  //     a retry and a refresh all mean the same single order.
  const result = await execute(userId, prepared.intentId, idempotencyKey, snapshot);
  await record(userId, setup, snapshot, result.ok ? "taken" : "passed", result.message, prepared.intentId, result.positionId ?? null);
  /*
   * A FAILURE MUST CARRY ITS REASON, AND THE CAST WAS HIDING THAT IT DID NOT.
   *
   * This was one line: `return { ok: result.ok, execution: result, setup } as TakeResult`. On a failed
   * execution that produced `{ ok: false, execution, setup }` — which has no `message`, because the
   * failure arm of TakeResult requires one. The `as` silenced the exact error that would have caught
   * it, and every caller reading `res.message` on a refusal got undefined.
   *
   * Live consequence, seen on the first open: the autopilot found a sell, execution refused it, and
   * `res.message.slice(0, 60)` threw TypeError before anything could record or report WHY. The trade
   * was logged as an error with a stack trace instead of a reason, three times in two minutes.
   *
   * So the two arms are now built separately and the cast is gone.
   */
  if (!result.ok) {
    return {
      ok: false,
      state: result.state === "error" ? "error" : "drifted",
      message: result.message || "The execution path refused this trade without giving a reason.",
      setup,
    };
  }
  return { ok: true, execution: result, setup };
}

/** The member looked at a trade and chose not to take it. Worth as much to the learning system as a fill. */
export async function passSetup(userId: string, snapshot: MarketSnapshot | null, marketIsOpen: boolean, reason?: string): Promise<{ ok: true }> {
  const profile = await getProfile(userId);
  const setup = findSetup({ snapshot, profile: asSetupProfile(profile), marketOpen: marketIsOpen });
  await record(userId, setup, snapshot, "passed", reason ?? "Passed by the member.");
  return { ok: true };
}

async function record(
  userId: string,
  setup: BrainSetup,
  snapshot: MarketSnapshot | null,
  outcome: "offered" | "taken" | "passed" | "expired" | "invalidated",
  reason?: string,
  executionId?: string | null,
  positionId?: string | null,
): Promise<void> {
  const c = db();
  if (!c) return;
  try {
    await c.from("cc_setups").insert({
      user_id: userId,
      snapshot_version: snapshot?.snapshotVersion ?? null,
      snapshot_at: snapshot ? new Date(snapshot.at).toISOString() : null,
      state: setup.state,
      side: setup.side,
      style: setup.style,
      strategy: setup.strategy,
      entry_low: setup.entryLow,
      entry_high: setup.entryHigh,
      stop: setup.stop,
      initial_objective: setup.initialObjective,
      extended_objective: setup.extendedObjective,
      stop_pips: setup.stopPips,
      confidence: setup.confidence,
      thesis: setup.thesis,
      invalidation: setup.invalidation,
      invalidation_price: setup.invalidationPrice,
      conditions: setup.conditions,
      price_at: snapshot?.price ?? null,
      outcome,
      outcome_reason: reason?.slice(0, 400) ?? null,
      execution_id: executionId ?? null,
      position_id: positionId ?? null,
    });
  } catch {
    // The record is for learning. It must never be the reason a trade fails.
  }
}
