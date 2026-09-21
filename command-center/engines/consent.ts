/**
 * THE RISK DISCLOSURE, AND THE GATE THAT ENFORCES IT.
 *
 * A member can connect a brokerage account to this system and let it place orders. Before any of that
 * is possible they have to be told, in plain words, that they can lose money — and there has to be a
 * durable record that they were told, what they were told, and when.
 *
 * THE GATE IS SERVER-SIDE, AND THAT IS THE ENTIRE POINT. A checkbox in an interface is a decoration:
 * it stops an honest member and nobody else, and it is worth nothing in a dispute because there is no
 * record that anything was shown. Every door that can reach the market is closed here instead, in the
 * routes, where a modified client, a stale tab and a direct API call all meet the same refusal.
 *
 * IT IS VERSIONED, because a consent to an older text is not consent to a newer one. When the
 * disclosure changes materially the version changes with it and every member is asked again. And the
 * TEXT AS SHOWN is hashed into the record, so what somebody actually agreed to can be proved later
 * even if this file is edited afterwards — a record that just says "accepted v1" is worth very little
 * once v1 no longer exists anywhere.
 *
 * ⚠️ THE WORDS BELOW ARE NOT LEGAL ADVICE AND HAVE NOT BEEN REVIEWED BY A LAWYER. They cover the
 * disclosures that are standard for a system of this kind, but what is REQUIRED depends on where the
 * operator and the member are, what licences the operator holds, and whether any of this constitutes
 * regulated advice in that jurisdiction. The structure here exists so that replacing this text with a
 * lawyer's is one edit and a version bump, and every existing consent correctly becomes stale.
 */
import { createHash } from "node:crypto";
import { db } from "../adapters/db";

/**
 * Bump this whenever the disclosure changes in a way that matters.
 *
 * Fixing a typo does not; adding a risk, changing who bears responsibility, or altering what the
 * member is agreeing to does. When in doubt, bump — the cost is one interruption, and the cost of not
 * bumping is a record that says somebody agreed to something they never read.
 */
export const DISCLOSURE_VERSION = "2026-09-20.2";

export const RISK_DISCLOSURE = `
COMMAND CENTER XAUUSD AND FLOW — RISK DISCLOSURE

Read this in full. It describes how you can lose money using this system.

IN ONE SENTENCE: trading involves risk, and using this software can lose you money. It is a tool, not
a promise. Nobody here is telling you that you will profit, and you are choosing to accept that risk.

1. YOU CAN LOSE MONEY, INCLUDING ALL OF IT.
Trading gold carries a high level of risk. Prices move quickly and can move against you without
warning. You may lose some, all, or — depending on your broker's terms and your account type — more
than the money you deposit. Only trade with money you can afford to lose entirely without affecting
your standard of living or your obligations to anyone else.

2. LEVERAGE MAGNIFIES LOSSES AS WELL AS GAINS.
Leveraged trading means a small move in the market produces a much larger move in your account. The
same leverage that produces a good day produces a bad one faster than most people expect.

3. NOTHING HERE IS A PREDICTION, AND NOTHING IS GUARANTEED.
ATLAS produces opinions from measured data. Opinions are frequently wrong. No setup, signal,
analysis, confidence figure or statement made by this system is a promise, a guarantee, or a
representation that a trade will be profitable. Losing trades are a normal part of the strategy and
will happen.

4. PAST RESULTS DO NOT PREDICT FUTURE RESULTS.
Any performance information, record of past calls, backtest or example shown anywhere in this product
describes what has already happened. It does not indicate what will happen next. Hypothetical and
simulated results in particular have inherent limitations, because they are prepared with the benefit
of hindsight and do not involve real money or real execution.

5. THIS IS NOT FINANCIAL, INVESTMENT, LEGAL OR TAX ADVICE.
The operator of this system is not acting as your broker, investment adviser, or fiduciary, and
nothing in this product is personalised advice or a recommendation that any trade is suitable for you
or your circumstances. You are solely responsible for your own trading decisions and for deciding
whether any trade is appropriate for you. If you need advice, consult a properly licensed professional
in your jurisdiction.

6. AUTOMATED AND ASSISTED TRADING CAN FAIL.
This system depends on software, market data feeds, internet connectivity, third-party services and
your broker's platform. Any of them can be delayed, incorrect, or unavailable. Software contains
defects. Orders can be delayed, rejected, duplicated, filled at a different price than expected, or
not placed at all. You must monitor your own account and your own positions, and you must be able to
intervene through your broker directly if this system is unavailable.

7. STOP LOSSES ARE NOT A GUARANTEE.
A stop is an instruction to your broker, not a floor under your losses. In fast markets, on weekend
gaps, and around news releases, price can jump past your stop and your position can close at a
materially worse level than the one you set. Gold gaps at the weekly open.

8. EXECUTION COSTS AND CONDITIONS ARE REAL.
Spreads, commissions, swap and financing charges, slippage and widening around news all reduce
returns. Conditions at the moment you trade may differ significantly from those shown.

9. YOUR BROKER RELATIONSHIP IS YOURS.
Your account, your funds and your legal relationship with your broker are between you and them. The
operator of this system does not hold, control or have custody of your money. Your broker's terms,
margin policy, and liquidation rules apply to you regardless of anything this system does or says.

10. YOU CONTROL THE PERMISSIONS, AND YOU ARE RESPONSIBLE FOR THEM.
You decide your risk per trade, which actions this system may take by itself, and whether automatic
trading is on. Anything you permit, this system may do. Review those settings and understand that
granting a permission means trades or changes can occur without a further prompt to you.

11. YOU CAN WITHDRAW AT ANY TIME.
You can disable automatic trading, remove permissions, disconnect your account, or withdraw this
consent at any time. Withdrawing consent stops new activity; it does not close positions that are
already open — closing those remains your responsibility, through this system or directly with your
broker.

12. ELIGIBILITY.
You confirm that you are of legal age in your jurisdiction, that you are permitted to trade these
instruments where you live, and that you are not relying on the operator to determine that for you.

BY SIGNING BELOW YOU CONFIRM THAT YOU HAVE READ AND UNDERSTOOD ALL OF THE ABOVE, THAT YOU ACCEPT THE
RISK OF LOSS INCLUDING TOTAL LOSS OF YOUR DEPOSITED FUNDS, AND THAT YOU ARE MAKING YOUR OWN TRADING
DECISIONS.
`.trim();

/** The text as shown, hashed, so a later edit cannot quietly change what somebody agreed to. */
export const disclosureHash = (): string => createHash("sha256").update(RISK_DISCLOSURE).digest("hex");

export type ConsentState = {
  signed: boolean;
  version: string | null;
  acceptedAt: number | null;
  signedName: string | null;
  /** True when they signed an older version and must be asked again. */
  stale: boolean;
  currentVersion: string;
};

export async function consentState(userId: string): Promise<ConsentState> {
  const c = db();
  const currentVersion = DISCLOSURE_VERSION;
  if (!c) return { signed: false, version: null, acceptedAt: null, signedName: null, stale: false, currentVersion };

  const { data } = await c.from("cc_risk_consents")
    .select("version, accepted_at, signed_name, acknowledged, revoked_at")
    .eq("user_id", userId).is("revoked_at", null)
    .order("accepted_at", { ascending: false }).limit(1).maybeSingle();

  const r = data as { version: string; accepted_at: string; signed_name: string; acknowledged: boolean } | null;
  // An unacknowledged row is not a consent. Both the signature and the box are required, and the
  // server decides that rather than trusting the client to have enforced its own form.
  if (!r || !r.acknowledged) {
    return { signed: false, version: null, acceptedAt: null, signedName: null, stale: false, currentVersion };
  }
  return {
    signed: r.version === currentVersion,
    version: r.version,
    acceptedAt: Date.parse(r.accepted_at),
    signedName: r.signed_name,
    stale: r.version !== currentVersion,
    currentVersion,
  };
}

export type SignResult = { ok: true } | { ok: false; reason: string };

export async function sign(userId: string, input: {
  signedName: string; acknowledged: boolean; ip?: string | null; userAgent?: string | null;
}): Promise<SignResult> {
  const name = String(input.signedName ?? "").trim();
  /*
   * BOTH ARE REQUIRED, and neither is inferred from the other.
   *
   * The box says they read it; the name says it was them. A form that accepts one without the other
   * produces a record that proves less than it appears to.
   */
  if (!input.acknowledged) return { ok: false, reason: "Tick the box to confirm you have read and understood the disclosure." };
  if (name.length < 3 || !/[a-z]/i.test(name)) return { ok: false, reason: "Type your full name to sign." };

  const c = db();
  if (!c) return { ok: false, reason: "Not available right now." };

  const { error } = await c.from("cc_risk_consents").insert({
    user_id: userId,
    version: DISCLOSURE_VERSION,
    text_sha256: disclosureHash(),
    signed_name: name.slice(0, 120),
    acknowledged: true,
    ip: input.ip?.slice(0, 64) ?? null,
    user_agent: input.userAgent?.slice(0, 300) ?? null,
  });
  if (error) return { ok: false, reason: "That could not be recorded, so it has not been accepted." };
  return { ok: true };
}

export async function revoke(userId: string, reason: string): Promise<void> {
  const c = db();
  if (!c) return;
  await c.from("cc_risk_consents")
    .update({ revoked_at: new Date().toISOString(), revoke_reason: reason.slice(0, 200) })
    .eq("user_id", userId).is("revoked_at", null);
}

/**
 * THE GATE.
 *
 * Called by every route action that can connect an account, place an order, change a position, or
 * turn automation on. It returns the refusal rather than throwing, so each caller answers in its own
 * shape — but no caller is permitted to skip it, and a test walks the routes to make sure none does.
 */
export async function requireConsent(userId: string): Promise<{ ok: true } | { ok: false; reason: string; needsConsent: true }> {
  const s = await consentState(userId);
  if (s.signed) return { ok: true };
  return {
    ok: false,
    needsConsent: true,
    reason: s.stale
      ? "The risk disclosure has been updated. Read and sign the new version before trading."
      : "You need to read and sign the risk disclosure before you can connect an account or trade.",
  };
}
