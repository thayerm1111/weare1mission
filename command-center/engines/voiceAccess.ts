/**
 * MAY THIS MEMBER TALK TO THE COMMAND CENTER, AND FOR HOW LONG?
 *
 * Voice used to be admin-only — `role === 'admin'` or a 401 — because speech is billed by the minute
 * and opening it to a membership without a budget attached is how a feature becomes a liability. The
 * gate and the meter were built first for exactly this moment. This replaces the gate; the meter is the
 * same one, now measured against a billing period instead of a calendar month.
 *
 * THE ALLOWANCE IS THE PRODUCT, NOT THE PRICE. Cost here scales with minutes spoken, so the allowance
 * is what bounds it. It is therefore enforced BEFORE a line opens, never reconciled afterwards against
 * an invoice that has already been incurred.
 *
 * WHY THE BILLING PERIOD AND NOT THE MONTH. The old meter reset on the 1st. A member subscribing on the
 * 20th would have got a full allowance for eleven days and then a fresh one — paying once for two. The
 * window now comes from the subscription itself, so an allowance means one allowance.
 *
 * FAILS CLOSED ON MONEY, OPEN ON NOTHING. If the entitlement cannot be read, the answer is no. An
 * unreadable subscription is not a free one.
 */

import { db } from "../adapters/db";

export type VoiceAccess =
  | {
      allowed: true;
      /** Where the member's current allowance window starts and ends. */
      periodStart: Date;
      periodEnd: Date | null;
      includedMinutes: number;
      /** Minutes bought on top, valid for this period only. */
      topupMinutes: number;
      /** Admins get in without a subscription; the meter still applies to them. */
      viaAdmin: boolean;
    }
  | { allowed: false; reason: string; needsSubscription: boolean };

type SubRow = {
  status: string;
  current_period_start: string | null;
  current_period_end: string | null;
  included_minutes: number | null;
};

/** active and trialing both talk. A cancelled subscription keeps its minutes until the period ends. */
const ENTITLED = new Set(["active", "trialing"]);

/**
 * Resolve what this member is entitled to right now.
 *
 * `isAdmin` is passed in rather than looked up here, because the route already knows it and a second
 * round trip to the profiles table on every voice call buys nothing.
 */
export async function voiceAccess(userId: string, isAdmin = false): Promise<VoiceAccess> {
  const c = db();
  if (!c) {
    return { allowed: false, reason: "Cannot check the voice subscription right now.", needsSubscription: false };
  }

  const { data, error } = await c
    .from("cc_voice_subscriptions")
    .select("status, current_period_start, current_period_end, included_minutes")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    // Unreadable is not free. Say so plainly rather than letting a database blip open the line.
    return { allowed: false, reason: "Could not read your voice subscription. Try again in a moment.", needsSubscription: false };
  }

  const sub = (data ?? null) as SubRow | null;
  const live = !!sub && ENTITLED.has(sub.status) &&
    (!sub.current_period_end || Date.parse(sub.current_period_end) > Date.now() - 60_000);

  if (!live && !isAdmin) {
    return {
      allowed: false,
      needsSubscription: true,
      reason: sub && sub.status !== "inactive"
        ? "Your Command Center Voice subscription is not active."
        : "Talking to the Command Center needs the Voice subscription.",
    };
  }

  /*
   * An admin with no subscription still needs a window to meter against, and a member whose row somehow
   * lacks a period start gets one anchored to the last 30 days. Neither case may result in an unmetered
   * line — "we could not work out the window" must never mean "so charge nothing and allow everything".
   */
  const fallbackStart = new Date(Date.now() - 30 * 24 * 3600_000);
  const periodStart = sub?.current_period_start ? new Date(sub.current_period_start) : fallbackStart;
  const periodEnd = sub?.current_period_end ? new Date(sub.current_period_end) : null;

  const topupMinutes = await topupsInPeriod(userId, periodStart);

  return {
    allowed: true,
    periodStart,
    periodEnd,
    includedMinutes: Number(sub?.included_minutes ?? 0) || (isAdmin && !live ? 1000 : 0),
    topupMinutes,
    viaAdmin: !live && isAdmin,
  };
}

/** Minutes bought during the current period. Top-ups are period-scoped; the UI says so. */
async function topupsInPeriod(userId: string, periodStart: Date): Promise<number> {
  const c = db();
  if (!c) return 0;
  const { data, error } = await c
    .from("cc_voice_topups")
    .select("minutes")
    .eq("user_id", userId)
    .gte("created_at", periodStart.toISOString())
    .limit(200);
  if (error) return 0;   // a missing top-up under-grants, which is the safe direction
  return ((data ?? []) as { minutes: number | null }[])
    .reduce((a, r) => a + (Number(r.minutes) || 0), 0);
}
