/**
 * ATLAS, TRADING BY ITSELF.
 *
 * Until now "Enter trades without asking" stored a boolean that nothing read. The toggle was there,
 * the badge said AUTHORISED, and no code path could ever send an order — Command Center was a
 * read-and-narrate system wearing an automation UI. This is the loop that makes the switch mean what
 * it says.
 *
 * IT DEFAULTS TO SHADOW, AND THAT IS NOT TIMIDITY.
 *
 * This code path has never once placed an order. GENX/FLOW has been trading these same accounts for
 * months and has the scar tissue to prove it — the loss-streak pause, the chase guard, the chop
 * detector, the 90-second claim, the broker-verified open check. None of that history exists here.
 * Switching a brand-new autonomous trader straight to live on six funded accounts is how people lose
 * money in ways nobody can explain afterwards.
 *
 * So the same decision runs either way, and the mode decides only whether it reaches the broker:
 *
 *   off     — nothing runs. The default, and what an unconfigured deployment gets.
 *   shadow  — every decision is made and written down with the price at that second, and scored later
 *             against what gold actually did. After a week this is EVIDENCE rather than an opinion.
 *   live    — the same decision, sent.
 *
 * Going live is one environment variable once shadow says it deserves it. Nothing about this file has
 * to change.
 *
 * WHAT IT WILL NOT DO, EVER:
 *   • Place on an account where FLOW or ATLAS already holds gold (engines/interlock.ts). The two
 *     engines cannot see each other's tables, so this is checked before anything else.
 *   • Place without a signed risk disclosure, or on an unauthorised live account. Both are enforced
 *     again inside takeSetup; the checks here exist so the refusal is logged with a reason.
 *   • Widen risk, move a stop further away, or re-enter a setup it already acted on.
 *   • Run while the market is shut, or on a snapshot it does not trust.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { MarketSnapshot } from "../core/types";
import type { Bias } from "../brain/types";
import { findSetup } from "./setup";
import { takeSetup } from "./callTrade";
import { getProfile, asSetupProfile } from "./profile";
import { accountAvailableToBrain } from "./interlock";
import { reconcileOpenPositions } from "./tradeLive";
import { requireConsent } from "./consent";
import { brainEnabled } from "./killSwitch";
import { formingSetup, tookTrade, stoodDown } from "./notify";

export type AutopilotMode = "off" | "shadow" | "live";

/** Read once per process. Absent means off — an unconfigured deployment never trades by itself. */
export function autopilotMode(): AutopilotMode {
  const m = String(process.env.CC_AUTOPILOT ?? "").trim().toLowerCase();
  return m === "live" ? "live" : m === "shadow" ? "shadow" : "off";
}

/*
 * THERE IS NO FIXED CAP ON ENTRIES PER DAY, AND THAT IS DELIBERATE.
 *
 * A count is the wrong brake. It stops a good session at an arbitrary number and does nothing at all
 * about a bad one — four losers and four winners hit it identically. What restrains this loop now is
 * what the account is actually doing, evaluated in engines/validator.ts on every single entry:
 *
 *   • the daily loss limit, from real closed-trade P&L since midnight
 *   • the drawdown limit, against the day's reconstructed high-water equity
 *   • the weekly loss limit
 *   • a stop after consecutive losses
 *   • the cooldown since this account last opened a trade
 *   • one BRAIN position on an account at a time (engines/interlock.ts)
 *
 * Those were all comparing against hardcoded zeros until engines/accountHistory.ts was written, which
 * is why the count cap existed at all: it was standing in for six guards that were not connected. They
 * are connected now, so the stand-in is gone and the market decides how many trades there are.
 */
/** After acting on a setup, ignore anything with the same shape for this long. */
const REPEAT_COOLDOWN_MS = 20 * 60_000;

let admin: SupabaseClient | null = null;
function db(): SupabaseClient | null {
  if (admin) return admin;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  admin = createClient(url, key, { auth: { persistSession: false } });
  return admin;
}

/** What this process has already acted on, so a one-second loop cannot fire twice on one setup. */
const lastActed = new Map<string, { sig: string; at: number }>();

type AutoAccount = {
  id: string; user_id: string; acc_num: string | null;
  is_live: boolean; auto_trading: boolean; live_authorized_at: string | null;
};

/** Every account whose owner has switched automatic entry on. */
async function armedAccounts(): Promise<AutoAccount[]> {
  const c = db();
  if (!c) return [];
  const { data, error } = await c
    .from("cc_broker_accounts")
    .select("id, user_id, acc_num, is_live, auto_trading, live_authorized_at")
    .eq("auto_trading", true)
    .limit(200);
  if (error) return [];
  return (data ?? []) as AutoAccount[];
}

async function record(row: {
  user_id: string; account_row_id: string; acc_num: string | null;
  mode: AutopilotMode; acted: boolean; outcome: string; reason: string;
  side?: string | null; style?: string | null; entry?: number | null;
  stop?: number | null; target?: number | null; price_at?: number | null;
}) {
  const c = db();
  if (!c) return;
  try { await c.from("cc_autopilot_log").insert({ ...row, created_at: new Date().toISOString() }); }
  catch { /* the log is evidence, not a gate — never let it stop or start a trade */ }
}


/**
 * HOW LONG SINCE THIS ACCOUNT ACTUALLY OPENED SOMETHING — read from the ACTION LOG.
 *
 * THE INDEPENDENT GUARD, AND WHY IT HAD TO EXIST.
 *
 * Tonight four separate guards failed at once — the one-position interlock, the style cooldown, the
 * hourly budget and the maxOpenPositions limit. Not one of them was wrong. They were all computed from
 * cc_positions, and a dropped line in the position parser meant that table was never written, so every
 * one of them read "nothing is open" and let the next entry through. Eighteen orders in twenty-nine
 * minutes.
 *
 * The broker-truth check added in engines/executor.ts fixes the direct cause, but it is NOT an
 * independent second opinion: it parses positions with the same function. If that parser breaks again,
 * both fail together, exactly as before.
 *
 * cc_autopilot_log is different in the one way that matters. It is written at the MOMENT OF ACTION,
 * before any reconciliation, and it does not depend on reading a position back. "Did I open something
 * recently?" is answerable from it even when everything downstream is broken.
 *
 * This is not a daily cap — the owner removed those deliberately, and rightly. It is the spacing rule
 * the desk already runs (FLOW's 90 minutes for a quick trade), sourced from a table that cannot be
 * silently empty. One trade, then manage it.
 *
 * IT FAILS CLOSED. If the log cannot be read, the answer is "yes, recently" and nothing is opened.
 */
/*
 * A SETTLE WINDOW, NOT A TRADING CADENCE.
 *
 * This started as the desk's style cooldown — 90 minutes for a quick trade — and that was the wrong
 * instrument for what the owner actually asked for. He wants ONE OPEN POSITION AT A TIME, not one
 * trade every ninety minutes: when a trade closes, the engine should be free to take the next setup.
 * A 90-minute gap would have changed how it trades, and the trading is not what is broken.
 *
 * So this is short on purpose. It covers only the gap between sending an order and being able to see
 * the resulting position at the broker — the window in which "am I already in?" is genuinely
 * unanswerable, which is precisely where eighteen orders went out tonight. After it, the broker's own
 * position list governs, and that is the right authority.
 */
const SETTLE_AFTER_ENTRY_MS = Number(process.env.CC_SETTLE_MS ?? 5 * 60_000);

async function actedRecently(accountRowId: string): Promise<{ blocked: boolean; detail: string }> {
  const c = db();
  if (!c) return { blocked: true, detail: "Cannot read the action log, so ATLAS cannot tell whether it just entered." };

  const window = SETTLE_AFTER_ENTRY_MS;
  const since = new Date(Date.now() - window).toISOString();
  try {
    const { data, error } = await c
      .from("cc_autopilot_log")
      .select("created_at, side, style")
      .eq("account_row_id", accountRowId)
      .eq("acted", true)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) throw new Error(error.message);

    const last = (data ?? [])[0] as { created_at: string; side: string | null; style: string | null } | undefined;
    if (!last) return { blocked: false, detail: "" };

    const secsAgo = Math.round((Date.now() - Date.parse(last.created_at)) / 1000);
    return {
      blocked: true,
      detail: `An order went out ${secsAgo}s ago and has not settled yet — waiting to confirm it before considering another.`,
    };
  } catch (e) {
    return { blocked: true, detail: `Cannot read the action log (${String(e).slice(0, 60)}) — refusing rather than risking a second entry.` };
  }
}

/**
 * One pass. Called from the Command Center worker on the same tick as perception.
 *
 * Returns a short line for the worker log, or null when there was nothing to say.
 */
export async function autopilotTick(input: {
  snapshot: MarketSnapshot | null;
  marketOpen: boolean;
  tradeable: boolean;
  thesis?: { bias: Bias | null; confidence: number | null };
}): Promise<string | null> {
  const mode = autopilotMode();
  if (mode === "off") return null;

  /*
   * THE OWNER'S OFF SWITCH, CHECKED FIRST AND ON EVERY PASS.
   *
   * Before the market, before the accounts, before anything that costs a broker call — because the
   * whole value of a kill switch is how quickly it takes effect, and a check buried behind four other
   * conditions is a check that runs late. Off stops NEW entries only; autoManage still runs on the tick
   * above this one, so anything already open keeps its stop moved and its targets taken.
   */
  const sw = await brainEnabled();
  if (!sw.on) return null;

  if (!input.marketOpen || !input.snapshot) return null;
  // A snapshot the engine itself does not trust is not a snapshot to trade from.
  if (!input.tradeable) return null;

  const accounts = await armedAccounts();
  if (!accounts.length) return null;

  const notes: string[] = [];

  for (const a of accounts) {
    const key = a.id;

    // 1 — live accounts need the separate authorisation, always.
    if (a.is_live && !a.live_authorized_at) {
      await record({ user_id: a.user_id, account_row_id: a.id, acc_num: a.acc_num, mode, acted: false,
        outcome: "refused", reason: "Live trading is not authorised on this account." });
      continue;
    }

    // 2 — the disclosure. takeSetup checks it too; checking here means the refusal is recorded.
    const consent = await requireConsent(a.user_id);
    if (!consent.ok) {
      await record({ user_id: a.user_id, account_row_id: a.id, acc_num: a.acc_num, mode, acted: false,
        outcome: "refused", reason: consent.reason ?? "The risk disclosure is not signed." });
      continue;
    }

    // 3 — what does ATLAS actually see, for this member's own profile?
    //
    //     09-22: this now runs BEFORE the one-position check, because that check became side-aware
    //     (one buy and one sell may be open at once) and therefore needs to know which way this entry
    //     would go. Nothing here reaches the broker or the market — it reads the snapshot ATLAS has
    //     already taken — so asking first costs nothing.
    const profile = await getProfile(a.user_id);
    const setup = findSetup({
      snapshot: input.snapshot,
      profile: asSetupProfile(profile),
      marketOpen: input.marketOpen,
      thesisBias: input.thesis?.bias ?? null,
      thesisConfidence: input.thesis?.confidence ?? null,
    });

    /*
     * ONLY A COMPLETE, EXECUTABLE TRADE.
     *
     * `trade_ready` is the single state that means every condition is met. "waiting_for_trigger" is
     * one condition short and is exactly the kind of near-miss a person talks themselves into; an
     * autonomous loop must not have that conversation with itself.
     */
    /*
     * "ABOUT TO CALL A TRADE" — the owner asked to see this, and it is the one state worth announcing
     * that is NOT an order. A setup one condition short is exactly the near-miss an autonomous loop
     * must not act on, and exactly the thing that proves it is awake and reading the market.
     * notify throttles it; this only decides that it happened.
     */
    if (setup && setup.state === "waiting_for_trigger" && setup.side && setup.style) {
      formingSetup({
        side: setup.side,
        style: setup.style,
        entry: setup.entryHigh ?? setup.entryLow ?? null,
        stop: setup.stop ?? null,
        price: input.snapshot.price ?? null,
        missing: setup.waitingFor?.length ? setup.waitingFor.join(", ") : null,
      });
    }

    if (!setup || setup.state !== "trade_ready") continue;
    if (setup.side == null || setup.stop == null || setup.style == null) continue;
    const entry = setup.entryHigh ?? setup.entryLow;
    if (entry == null) continue;

    /*
     * 3a — ASK THE BROKER BEFORE TRUSTING THE LEDGER (09-22).
     *
     * The interlock below is only as good as cc_positions, and nothing server-side used to refresh
     * that table: the broker sync ran on the Command Center screen, and autoManage only visits
     * positions with AI management on. One row left "open" after its trade was gone at the broker
     * blocked ATLAS for a full day — 2,367 refusals, no trades, and nothing wrong with the market
     * read. Reconciling here costs one broker call per armed account, and only when that account has
     * an open row nothing has looked at for a minute.
     */
    try { await reconcileOpenPositions(a.user_id, a.id, input.snapshot?.price ?? null); }
    catch { /* the interlock still decides; a failed reconcile just means it decides on what it has */ }

    // 3b — ONE BRAIN POSITION PER SIDE ON AN ACCOUNT (09-22: "they each can have a sell or a buy open
    //      each"). An open SELL no longer refuses a BUY; a second trade the SAME way is still refused.
    //      FLOW may be in gold on this same account running its own strategy; that is allowed and is
    //      not our business. What is our business is not stacking ATLAS's own trades on top of itself.
    const owns = await accountAvailableToBrain(a.id, a.acc_num, setup.side);
    if (!owns.available) {
      await record({ user_id: a.user_id, account_row_id: a.id, acc_num: a.acc_num, mode, acted: false,
        outcome: "blocked", reason: owns.reason, side: setup.side, style: setup.style });
      continue;
    }

    const t = { side: setup.side, stop: setup.stop, entry, target: setup.initialObjective };
    const sig = `${t.side}|${setup.style}|${t.stop}|${t.entry}`;
    const prev = lastActed.get(key);
    if (prev && prev.sig === sig && Date.now() - prev.at < REPEAT_COOLDOWN_MS) continue;

    /*
     * 5 — no count check. takeSetup runs the full validator, which enforces the loss, drawdown,
     *     streak and cooldown limits against this account's real day and refuses with a reason that
     *     is recorded below. That refusal is the brake; a counter here would only mask it.
     */

    /*
     * ONE TRADE, THEN MANAGE IT — checked against the action log, not against our position records.
     * This is the guard that does not share a failure mode with the other three.
     */
    const spacing = await actedRecently(a.id);
    if (spacing.blocked) {
      await record({ user_id: a.user_id, account_row_id: a.id, acc_num: a.acc_num, mode, acted: false,
        outcome: "spaced", reason: spacing.detail,
        side: t.side, style: setup.style, entry: t.entry, stop: t.stop,
        target: t.target ?? null, price_at: input.snapshot.price ?? null });
      stoodDown(spacing.detail, { side: t.side, style: setup.style });
      continue;
    }

    const common = {
      user_id: a.user_id, account_row_id: a.id, acc_num: a.acc_num, mode,
      side: t.side, style: setup.style, entry: t.entry, stop: t.stop,
      target: t.target ?? null, price_at: input.snapshot.price ?? null,
    };

    if (mode === "shadow") {
      lastActed.set(key, { sig, at: Date.now() });
      await record({ ...common, acted: false, outcome: "shadow",
        reason: `Would have taken ${t.side} at ${t.entry}, stop ${t.stop}.` });
      notes.push(`shadow ${t.side} ${setup.style} @${t.entry}`);
      continue;
    }

    // 6 — live. takeSetup re-derives the setup server-side and refuses on drift, so what is sent is
    //     what ATLAS believes at the instant of sending, not what this loop saw a moment ago.
    lastActed.set(key, { sig, at: Date.now() });
    const idem = `auto:${a.id}:${sig}:${Math.floor(Date.now() / REPEAT_COOLDOWN_MS)}`;
    try {
      const res = await takeSetup(
        a.user_id,
        { side: t.side, style: setup.style, stop: t.stop, invalidationPrice: setup.invalidationPrice },
        idem,
        input.snapshot,
        input.marketOpen,
        input.thesis,
      );
      if (res.ok) {
        await record({ ...common, acted: true, outcome: "placed",
          reason: `Sent ${t.side} ${setup.style}, stop ${t.stop}.` });
        notes.push(`LIVE ${t.side} ${setup.style} @${t.entry}`);
        tookTrade({
          side: t.side, style: setup.style, entry: t.entry, stop: t.stop,
          target: t.target ?? null, accNum: a.acc_num,
        });
      } else {
        /*
         * Defensive even now that callTrade builds its failure arm properly. A refusal reaching this
         * point with no message is a bug somewhere upstream, and the right response to that is a
         * logged refusal a person can chase — not a TypeError that loses the trade AND the reason.
         */
        const why = (res.message && String(res.message)) || "Refused without a reason (upstream bug).";
        /*
         * A FAILURE THAT MAY HAVE SENT AN ORDER IS STILL AN ENTRY.
         *
         * Tonight every one of the eighteen orders returned not-ok — the fill could not be confirmed —
         * and every one was logged acted:false. So the action log, the very table the spacing guard
         * reads, recorded eighteen orders as zero entries. A guard counting SUCCESSES rather than
         * ORDERS would have let it happen all over again.
         */
        const mayHaveSent = res.sent === true;
        await record({
          ...common,
          acted: mayHaveSent,
          outcome: mayHaveSent ? "sent_unconfirmed" : "refused",
          reason: why,
        });
        notes.push(`refused: ${why.slice(0, 60)}`);
        // The answer to "why is it not trading". Throttled per reason inside notify.
        stoodDown(why, { side: t.side, style: setup.style });
      }
    } catch (e) {
      await record({ ...common, acted: false, outcome: "error", reason: String(e).slice(0, 200) });
    }
  }

  return notes.length ? `autopilot(${mode}) ${notes.join(" · ")}` : null;
}
