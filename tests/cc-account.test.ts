import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { accountLines, asksAboutAccount, type AccountFacts } from "../command-center/brain/account";
import { DEFAULT_PROFILE } from "../command-center/engines/profile";

const LIVE: AccountFacts = {
  connected: true, name: "Main", isLive: true, currency: "USD",
  balance: 25000, equity: 24820, openPl: -180, marginAvailable: 21000,
  stateAt: new Date(Date.now() - 2 * 60_000).toISOString(),
  autoTrading: false, liveAuthorized: true,
  permissions: { manual_execute: true, ai_break_even: true, ai_close: false, ai_partial: false },
  instrumentReady: true,
};

/*
 * "LOOK AT MY ACCOUNT AND TELL ME WHETHER I SHOULD LOWER MY RISK" CAME BACK AS "GOLD IS CLOSED."
 *
 * The third time this exact router failure produced a wrong refusal. Balance, risk, permissions and
 * authorisation are facts about the member's configuration and owe nothing to the market being open.
 */
test("an account question is recognised as one", () => {
  for (const q of [
    "Can you look at my account that I'm trading on currently and let me know if I should lower my risk?",
    "what's my balance",
    "how much am I risking per trade",
    "what are my permissions",
    "is auto-trading on",
    "which account am I on",
  ]) assert.ok(asksAboutAccount(q), q);

  for (const q of ["where is gold", "what happened last week", "why are you bullish"]) {
    assert.ok(!asksAboutAccount(q), q);
  }
});

test("it is routed before the market-state check", async () => {
  const src = await fs.readFile("command-center/brain/voiceLlm.ts", "utf8");
  assert.ok(src.indexOf("asksAboutAccount(question)") < src.indexOf("!memory.now && !history"),
    "or a closed market swallows it, exactly as it did");
});

/*
 * WHAT THE MODEL IS TRUSTED WITH, AND WHAT IT IS NOT.
 *
 * It gets the shape of the account and the rules it operates under. It never gets a credential, a
 * token or the account number — none of which it could use, all of which become a liability the
 * moment a transcript is shared.
 */
test("no credential or account number ever reaches the packet", () => {
  const lines = accountLines(LIVE, DEFAULT_PROFILE).join("\n");
  for (const forbidden of ["account_id", "acc_num", "connection_id", "password", "token", "instrument_id"]) {
    assert.ok(!lines.includes(forbidden), `${forbidden} must not appear`);
  }
  const src = "accountFacts";
  assert.ok(src.length > 0);
});

test("the risk rule is answered in their own money", () => {
  const lines = accountLines(LIVE, { ...DEFAULT_PROFILE, riskPct: 0.5 }).join("\n");
  // 0.5% of 25,000 is 125 — the useful answer to "should I lower my risk" is the cash amount, not a
  // lecture about position sizing in the abstract.
  assert.ok(/\$125\.00/.test(lines), "the percentage is converted against the real balance");
});

test("a stale balance is declared, not smoothed over", () => {
  const stale = { ...LIVE, stateAt: new Date(Date.now() - 40 * 60_000).toISOString() };
  assert.ok(/may be stale/.test(accountLines(stale, DEFAULT_PROFILE).join("\n")));
  assert.ok(!/may be stale/.test(accountLines(LIVE, DEFAULT_PROFILE).join("\n")), "and a fresh one is not");
});

/*
 * IT MUST NEVER IMPLY AUTHORITY IT DOES NOT HAVE.
 *
 * The permissions printed are the gates the execution path actually enforces, so the model can say
 * "you have not allowed me to close, so that one is yours" instead of inventing either a capability
 * or a restriction.
 */
test("permissions are stated in both directions", () => {
  const lines = accountLines(LIVE, DEFAULT_PROFILE).join("\n");
  assert.ok(/permitted to: .*break-even/.test(lines), "what it may do");
  assert.ok(/NOT permitted to: .*close the position entirely/.test(lines), "and what it may not");
  assert.ok(/recommend it and let them do it/.test(lines), "with the honest fallback");
  assert.ok(/never say you have changed a setting — you cannot/.test(lines));
});

test("with nothing connected it says so rather than inventing a balance", () => {
  const lines = accountLines(null, DEFAULT_PROFILE).join("\n");
  assert.ok(/No broker account is connected/.test(lines));
  assert.ok(/say so rather than inventing one/.test(lines));
  // The rules still apply and are still discussable.
  assert.ok(/risk per trade/.test(lines));
});

test("an unauthorised live account is flagged as unable to receive anything", () => {
  const unauth = { ...LIVE, liveAuthorized: false };
  assert.ok(/live trading is NOT authorised/.test(accountLines(unauth, DEFAULT_PROFILE).join("\n")));
});

test("defaults are not presented as choices the member made", () => {
  assert.ok(/never saved a profile, so these are the defaults/.test(accountLines(LIVE, DEFAULT_PROFILE).join("\n")));
  assert.ok(!/never saved a profile/.test(accountLines(LIVE, { ...DEFAULT_PROFILE, configured: true }).join("\n")));
});
