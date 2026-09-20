/**
 * THE BRAIN, TRADING BY ITSELF.
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
 *   • Place on an account where FLOW or THE BRAIN already holds gold (engines/interlock.ts). The two
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
import { requireConsent } from "./consent";

export type AutopilotMode = "off" | "shadow" | "live";

/** Read once per process. Absent means off — an unconfigured deployment never trades by itself. */
export function autopilotMode(): AutopilotMode {
  const m = String(process.env.CC_AUTOPILOT ?? "").trim().toLowerCase();
  return m === "live" ? "live" : m === "shadow" ? "shadow" : "off";
}

/** The most entries this loop may open on one account in one UTC day, whatever the market offers. */
const MAX_ENTRIES_PER_ACCOUNT_PER_DAY = 4;
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

async function entriesToday(accountRowId: string): Promise<number> {
  const c = db();
  if (!c) return Number.MAX_SAFE_INTEGER; // cannot count → treat as at the cap
  const since = new Date(); since.setUTCHours(0, 0, 0, 0);
  const { count, error } = await c
    .from("cc_autopilot_log")
    .select("id", { count: "exact", head: true })
    .eq("account_row_id", accountRowId)
    .eq("acted", true)
    .gte("created_at", since.toISOString());
  if (error) return Number.MAX_SAFE_INTEGER;
  return count ?? 0;
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

    // 3 — ONE BRAIN POSITION PER ACCOUNT. FLOW may be in gold on this same account running its own
    //     strategy; that is allowed and is not our business. What is our business is not stacking
    //     THE BRAIN's own trades on top of each other.
    const owns = await accountAvailableToBrain(a.acc_num);
    if (!owns.available) {
      await record({ user_id: a.user_id, account_row_id: a.id, acc_num: a.acc_num, mode, acted: false,
        outcome: "blocked", reason: owns.reason });
      continue;
    }

    // 4 — what does THE BRAIN actually see, for this member's own profile?
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
    if (!setup || setup.state !== "trade_ready") continue;
    if (setup.side == null || setup.stop == null || setup.style == null) continue;
    const entry = setup.entryHigh ?? setup.entryLow;
    if (entry == null) continue;

    const t = { side: setup.side, stop: setup.stop, entry, target: setup.initialObjective };
    const sig = `${t.side}|${setup.style}|${t.stop}|${t.entry}`;
    const prev = lastActed.get(key);
    if (prev && prev.sig === sig && Date.now() - prev.at < REPEAT_COOLDOWN_MS) continue;

    // 5 — the daily cap, counted from what was actually acted on.
    const used = await entriesToday(a.id);
    if (used >= MAX_ENTRIES_PER_ACCOUNT_PER_DAY) {
      await record({ user_id: a.user_id, account_row_id: a.id, acc_num: a.acc_num, mode, acted: false,
        outcome: "capped", reason: `Already took ${used} entries on this account today.`,
        side: t.side, style: setup.style, entry: t.entry, stop: t.stop, target: t.target ?? null,
        price_at: input.snapshot.price ?? null });
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
    //     what THE BRAIN believes at the instant of sending, not what this loop saw a moment ago.
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
      } else {
        await record({ ...common, acted: false, outcome: "refused", reason: res.message });
        notes.push(`refused: ${res.message.slice(0, 60)}`);
      }
    } catch (e) {
      await record({ ...common, acted: false, outcome: "error", reason: String(e).slice(0, 200) });
    }
  }

  return notes.length ? `autopilot(${mode}) ${notes.join(" · ")}` : null;
}
