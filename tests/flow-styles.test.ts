import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {
  styleOfMode, stylePrefsOf, accountTakesStyle, filterAccountsByStyle, normalisePrefs, STYLE_LABELS,
} from "../src/lib/flow/tradeStyles";

/*
 * THE ENGINE'S WORD AND THE MEMBER'S WORD ARE NOT THE SAME WORD.
 *
 * The signal says quick / intraday / swing. The member sees Rapid / Normal / Swing. One map, so the
 * two vocabularies can never drift apart in a way that silently mis-filters a trade.
 */
test("the engine's horizons map onto the member's names", () => {
  assert.equal(styleOfMode("quick"), "quick");
  assert.equal(styleOfMode("intraday"), "hold");   // the engine's name for the middle one
  assert.equal(styleOfMode("hold"), "hold");
  assert.equal(styleOfMode("swing"), "swing");
  assert.equal(STYLE_LABELS.quick.name, "Rapid");
  assert.equal(STYLE_LABELS.hold.name, "Normal");
  assert.equal(STYLE_LABELS.swing.name, "Swing");
});

test("an unknown or missing horizon is the fast one, not an error", () => {
  // Gold's ENTER-NOW calls are quick and some callers predate the field. Refusing to trade because a
  // horizon was not labelled would be a worse failure than assuming the one it has always been.
  assert.equal(styleOfMode(null), "quick");
  assert.equal(styleOfMode(undefined), "quick");
  assert.equal(styleOfMode("something-else"), "quick");
});

/*
 * THE FAILURE MODE THIS MUST NOT HAVE.
 *
 * An account written before these columns existed has undefined for all three. Reading that as "off"
 * would silently stop trading accounts that never asked to be stopped — a migration that quietly
 * disables a live account is far worse than one that quietly enables a feature.
 */
test("an account that predates the feature keeps behaving exactly as it did", () => {
  const legacy = {};
  assert.deepEqual(stylePrefsOf(legacy), { quick: true, hold: true, swing: false });
  assert.equal(accountTakesStyle(legacy, "quick"), true);
  assert.equal(accountTakesStyle(legacy, "intraday"), true);
  // Swing stays opt-in even for legacy rows: it holds risk overnight and over the weekend gap.
  assert.equal(accountTakesStyle(legacy, "swing"), false);
});

test("an explicit choice is honoured in both directions", () => {
  const rapidOnly = { styleQuick: true, styleHold: false, styleSwing: false };
  assert.equal(accountTakesStyle(rapidOnly, "quick"), true);
  assert.equal(accountTakesStyle(rapidOnly, "intraday"), false);
  const swingOn = { styleQuick: false, styleHold: false, styleSwing: true };
  assert.equal(accountTakesStyle(swingOn, "swing"), true);
});

test("the filter drops exactly the accounts that switched the horizon off", () => {
  const accounts = [
    { id: "a", styleQuick: true, styleHold: true, styleSwing: false },
    { id: "b", styleQuick: true, styleHold: false, styleSwing: false },
    { id: "c", styleQuick: true, styleHold: true, styleSwing: true },
  ];
  assert.deepEqual(filterAccountsByStyle(accounts, "quick").map((a) => a.id), ["a", "b", "c"]);
  assert.deepEqual(filterAccountsByStyle(accounts, "intraday").map((a) => a.id), ["a", "c"]);
  assert.deepEqual(filterAccountsByStyle(accounts, "swing").map((a) => a.id), ["c"]);
});

/*
 * AN ACCOUNT THAT IS ON AND TAKES NOTHING LOOKS LIKE A BROKEN SYSTEM.
 *
 * It is exactly the state somebody reaches by accident and then spends an evening debugging.
 */
test("the last style cannot be switched off", () => {
  const current = { quick: true, hold: false, swing: false };
  assert.deepEqual(normalisePrefs({ quick: false }, current), current, "the change is refused, not applied");
  // Turning one off while another is on is fine.
  assert.deepEqual(normalisePrefs({ hold: false }, { quick: true, hold: true, swing: false }),
    { quick: true, hold: false, swing: false });
});

test("the server refuses it too, not just the interface", async () => {
  const route = await fs.readFile("src/app/api/flow/broker/route.ts", "utf8");
  const block = route.slice(route.indexOf('if (action === "styles")'), route.indexOf('if (action === "sendit")'));
  assert.ok(/if \(!quick && !hold && !swing\)/.test(block), "all three off is rejected server-side");
  assert.ok(/needs_one/.test(block), "with a reason the interface can show");
});

/*
 * A TOGGLE THAT DOES NOTHING IS WORSE THAN NO TOGGLE.
 *
 * The point of this feature is the filter in the execution path, not the switch on the screen.
 */
test("the execution path actually honours it", async () => {
  const exec = await fs.readFile("src/lib/flow/autoExec.ts", "utf8");
  assert.ok(/filterAccountsByStyle\(accounts, sig\.mode/.test(exec), "accounts are filtered by the signal's horizon");
  // Applied AFTER Send It on purpose: Send It bypasses the DESK's judgement about whether a trade is
  // good. This is the member's decision about which trades they want at all.
  // Compared against the CALL, not the import line at the top of the file.
  assert.ok(exec.indexOf("sa.sendIt === true && !accounts.some") < exec.indexOf("filterAccountsByStyle(accounts,"),
    "a Send It account does not get exempted from its own owner's choice");
  assert.ok(/horizon switched off on them/.test(exec), "and a skipped account leaves a breadcrumb");
});

test("the account carries the flags out of the database", async () => {
  const conn = await fs.readFile("src/lib/flow/connection.ts", "utf8");
  assert.ok(/style_quick, style_hold, style_swing/.test(conn), "they are selected");
  assert.ok(/styleQuick: a\.style_quick/.test(conn), "and reach the account object the engine uses");
});
