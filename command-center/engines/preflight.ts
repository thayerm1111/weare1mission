/**
 * THE PRE-FLIGHT CHECK.
 *
 * `CC_AUTOPILOT=live` is a switch, not a guarantee. Between that switch and a filled order sit four
 * things that can each be silently wrong while every screen says AUTHORISED:
 *
 *   1. the encryption key            — without it the stored broker token cannot be opened at all
 *   2. the broker session            — the token opens, but the broker refuses to renew it
 *   3. the gold instrument           — the account cannot price or size XAUUSD
 *   4. the disclosure and live flag  — the trade would be refused on policy
 *
 * Every one of those fails AT THE MOMENT OF THE FIRST TRADE, which is the worst possible moment to
 * find out: gold has just done the thing the system was waiting for, and the log fills with a
 * decryption error instead of a fill. This runs the whole chain ONCE at boot, against the real
 * broker, while nothing is at stake, and says plainly which link is broken.
 *
 * IT PLACES NOTHING. Every call here reads: renew a session, list an instrument, read a flag. There
 * is no order path in this file and no import that could reach one.
 *
 * IT LOGS NO SECRET. Not the key, not the token, not a prefix of either — only whether each step
 * worked. `keySource()` returns which variable name is in use and never its value.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { keySource, encryptionAvailable } from "../core/crypto";
import { session, goldInstrument } from "./broker";
import { consentState } from "./consent";
import { sizePosition, DEFAULT_LIMITS } from "../core/risk";

type Row = {
  id: string; user_id: string; acc_num: string | null;
  is_live: boolean; auto_trading: boolean; live_authorized_at: string | null;
};

function db(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

export type PreflightLine = { ok: boolean; text: string };

/**
 * Walk the execution chain for every armed account. Returns one line per account plus a leading line
 * about encryption, in the order a person would want to read them.
 */
export async function preflight(): Promise<PreflightLine[]> {
  const out: PreflightLine[] = [];

  /*
   * 1 — THE KEY.
   *
   * This is the check that mattered. The command-center service ran for weeks with no encryption key
   * in its environment at all: `open()` would have returned null on every broker token, `session()`
   * would have reported an expired connection, and the autopilot would have logged "refused" against
   * every single setup while the dashboard showed it live and armed. The variable list is short
   * enough that nobody looks at it twice.
   */
  const src = keySource();
  if (!encryptionAvailable()) {
    out.push({ ok: false, text: "NO ENCRYPTION KEY — broker tokens cannot be opened. Nothing can trade. Set CC_ENC_KEY or FLOW_ENC_KEY." });
    return out;   // nothing below this can pass; do not spam the log with derivative failures
  }
  out.push({ ok: true, text: `encryption key present (${src === "cc" ? "CC_ENC_KEY" : "FLOW_ENC_KEY"})` });

  const c = db();
  if (!c) {
    out.push({ ok: false, text: "no database credentials — cannot read the armed accounts" });
    return out;
  }

  const { data, error } = await c
    .from("cc_broker_accounts")
    .select("id, user_id, acc_num, is_live, auto_trading, live_authorized_at")
    .eq("auto_trading", true)
    .limit(50);

  if (error) {
    out.push({ ok: false, text: `cannot read armed accounts (${error.message.slice(0, 100)})` });
    return out;
  }
  const rows = (data ?? []) as Row[];
  if (!rows.length) {
    out.push({ ok: true, text: "no accounts have automatic entry switched on — nothing will trade" });
    return out;
  }

  for (const a of rows) {
    const label = `account ${a.acc_num ?? a.id.slice(0, 8)}`;

    // 2 — policy, before touching the broker. A refusal here is a setting, not a fault.
    if (a.is_live && !a.live_authorized_at) {
      out.push({ ok: false, text: `${label}: live, but live trading is not authorised — every entry will be refused` });
      continue;
    }
    const consent = await consentState(a.user_id);
    if (!consent.signed || consent.stale) {
      out.push({ ok: false, text: `${label}: the risk disclosure is ${consent.stale ? "out of date" : "not signed"} — every entry will be refused` });
      continue;
    }

    // 3 — the broker. This opens the stored token and renews the session for real.
    const s = await session(a.user_id, a.id);
    if (!s.ok) {
      out.push({ ok: false, text: `${label}: broker session FAILED — ${s.reason}` });
      continue;
    }

    // 4 — gold on this account. No specification means no sizing, which means no order.
    const inst = await goldInstrument(s.session);
    if (!inst.ok) {
      out.push({ ok: false, text: `${label}: XAUUSD not tradeable — ${inst.reason}` });
      continue;
    }

    /*
     * 5 — WHAT SIZE WOULD IT ACTUALLY SEND?
     *
     * "The specification resolved" and "the position will be the right size" are different claims, and
     * only the second one matters at 6pm. So this does the real arithmetic on the real equity with the
     * member's own risk percentage, against a representative stop, and prints the lot size and the
     * dollars at risk. It is pure computation — no broker call, no order, nothing recorded.
     *
     * A person reading the log can now sanity-check the number against what they expect to see in the
     * platform, which is the one check no amount of code can do for them. If the lots look wrong by a
     * factor of anything, the answer is CC_AUTOPILOT=off, not a debugging session at the open.
     */
    const equity = s.session.account.equity ?? s.session.account.balance;
    const riskPct = Number(s.session.account.risk_limits?.riskPct ?? DEFAULT_LIMITS.riskPct);
    let sizing = "";
    if (equity && equity > 0 && inst.ok) {
      // A 200-pip stop on gold: $20 of price. Representative, not a prediction of any actual setup.
      const entry = 4000;
      const size = sizePosition({
        equity, entry, stop: entry - 20, side: "buy", riskPct, inst: inst.resolved.instrument,
      });
      sizing = size.ok
        ? ` · at ${riskPct}% on ${Math.round(equity).toLocaleString()} a 200-pip stop sizes to ${size.lots} lots, ${size.riskAmount} at risk`
        : ` · SIZING WOULD REFUSE: ${size.reason}`;
    }

    out.push({ ok: true, text: `${label}: token opens, broker session live, XAUUSD resolved (pip ${inst.resolved.pipSize}, ${inst.resolved.source})${sizing}` });
  }

  return out;
}
