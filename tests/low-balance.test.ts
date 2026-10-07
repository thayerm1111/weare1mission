import { call, member, idOf, T, iso, T0, fail, type Row } from "./_routes";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { opensOnItsOwn, whatSpendsCredits, LOW_BALANCE_THRESHOLD } from "../src/lib/lowBalance";

/*
 * The low-balance pop-up and a FLOW Pass (owner 10-07: "this person bought the flow pass, but it's
 * saying he needs more credits"). The site opens "You're down to 2 credits … every … GENX call spends
 * credits. Top up now" by itself, once a browser session, for any member under 5 credits. A Pass holder
 * who has used up the month's 50 on the other tools got it too — for GENX, which costs them nothing.
 */
const DAY = 86_400_000;
const flowPass = (token: string, o: Row = {}) => { T("user_subscriptions").push({ user_id: idOf(token), plan: "flow_pass", status: "active", stripe_customer_id: null, stripe_subscription_id: null, current_period_end: iso(T0 + 30 * DAY), cancel_at_period_end: false, canceled_at: null, ...o }); };
const credits = (t: string | null) => call("credits", "GET", "/api/credits", t);

test("the pop-up opens by itself for a member who is low — and never for a FLOW Pass holder", () => {
  assert.equal(LOW_BALANCE_THRESHOLD, 5);
  const on = (total: number | null, pass: boolean, snoozed = false, forced = false) => opensOnItsOwn({ total, pass, snoozed, forced });
  // On the meter: under 5 it opens, once a session.
  for (const total of [0, 1, 2, 4]) { assert.equal(on(total, false), true, `${total}`); assert.equal(on(total, false, true), false, `${total}, dismissed this session`); }
  for (const total of [5, 6, 50, 574]) assert.equal(on(total, false), false, `${total}`);
  assert.equal(on(null, false), false, "a balance that could not be read is not a low one");
  // On the Pass: whatever the balance, it is not something to stop them for.
  for (const total of [0, 1, 2, 4, 5, 50, null]) for (const snoozed of [false, true]) assert.equal(on(total, true, snoozed), false, `Pass, ${total}`);
  // The owner's preview link opens it for anyone.
  for (const pass of [false, true]) for (const total of [null, 0, 100]) assert.equal(on(total, pass, true, true), true);
});

test("what it says spends credits is true of the member reading it", () => {
  const metered = whatSpendsCredits(false), pass = whatSpendsCredits(true);
  assert.equal(metered, "Every play, chart read and GENX call spends credits. Top up now so you don't miss the next setup the desk calls.");
  // A Pass holder is not told that GENX takes credits — and is told what does.
  assert.ok(!/GENX call spends|every play/i.test(pass), pass);
  assert.match(pass, /FLOW Pass covers GENX, GEN FX and FLOW/);
  assert.match(pass, /Plays, chart reads, MFX Ghost and the other tools do/);
});

test("the page is told who holds a Pass: active only, and 'no' when it cannot be confirmed", async () => {
  const none = member("lb-none", { credits: 2 });
  const pass = member("lb-pass", { credits: 2 }); flowPass(pass);
  const ended = member("lb-ended", { credits: 2 }); flowPass(ended, { current_period_end: iso(T0 - 3600_000) });
  const cancelled = member("lb-cancelled", { credits: 2 }); flowPass(cancelled, { status: "canceled" });
  const suite = member("lb-suite", { credits: 2 }); flowPass(suite, { plan: "trading_suite" });
  const got = async (t: string) => { const r = await credits(t); assert.equal(r.status, 200, r.text.slice(0, 200)); return [r.json.pass, r.json.balance.dailyLeft + r.json.balance.purchased]; };
  assert.deepEqual(await got(pass), [true, 2]);
  for (const t of [none, ended, cancelled, suite]) assert.deepEqual(await got(t), [false, 2], t);
  // The Pass cannot be looked up: the page is told "no", and the pop-up behaves as it does for everyone else.
  fail.tables.add("user_subscriptions");
  try { assert.deepEqual(await got(pass), [false, 2]); } finally { fail.tables.delete("user_subscriptions"); }
  // Nobody signed in is told nothing.
  assert.equal((await credits(null)).status, 401);
});

test("the pop-up asks that rule, and the read tools say the Pass covers a read", () => {
  const code = (p: string): string => readFileSync(p, "utf8");
  const flyer = code("src/components/portal/LowBalanceFlyer.tsx");
  assert.match(flyer, /const holds = d\.pass === true;/);
  assert.match(flyer, /if \(opensOnItsOwn\(\{ total: t, pass: holds, snoozed, forced \}\)\) \{\s*setOpen\(true\);/);
  assert.ok(!/t < THRESHOLD && !snoozed/.test(flyer), "the old rule is not left standing beside it");
  assert.match(flyer, /\{whatSpendsCredits\(pass\)\}/);
  assert.ok(!flyer.includes("GENX call spends credits"), "the line is said in one place");
  // Under the read button, on the site and in the phone app.
  assert.match(code("src/components/portal/floor/GenxDesk.tsx"), /\{CREDIT_COST\.genx\} credits per read · free on the FLOW Pass</);
  assert.match(code("public/app/index.html"), />5 credits per read · free on the FLOW Pass</);
});
