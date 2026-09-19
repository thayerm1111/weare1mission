import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const SRC = () => fs.readFile("src/components/command-center/TradeAlert.tsx", "utf8");

/*
 * A ONE-CLICK BUTTON ON A POPUP IS EXACTLY WHERE A SHORTCUT WOULD BE TEMPTING AND EXACTLY WHERE ONE
 * WOULD BE UNFORGIVABLE.
 *
 * The alert is allowed to interrupt. It is not allowed to become a second way into the market.
 */
test("taking a trade goes through the one door every other entry uses", async () => {
  const s = await SRC();
  const calls = [...s.matchAll(/fetch\(\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(calls, ["/api/command-center/trade"], "one endpoint, the existing one");
  assert.ok(/action: "take_setup"/.test(s), "and the existing action");
  assert.ok(/action: "pass_setup"/.test(s), "passing is recorded, because a pass teaches as much as a fill");
  // Risk must never originate here.
  assert.ok(!/riskPct:\s*\d/.test(s.replace(/riskPct\}%/g, "")), "it never sends a risk value of its own");
  assert.ok(!/qty|lots|size:/i.test(s), "and never a position size");
});

test("a refusal is shown, not swallowed", async () => {
  const s = await SRC();
  assert.ok(/setMsg\(j\?\.message/.test(s), "the server's own reason reaches the member");
  assert.ok(/Nothing was sent/.test(s), "and a network failure says so plainly");
});

/*
 * AN ALERT THAT CRIES WOLF IS AN ALERT PEOPLE DISMISS WITHOUT READING, AND THE ONE TIME IT MATTERED
 * THEY WILL DISMISS THAT ONE TOO.
 */
test("it interrupts once per opportunity, never twice", async () => {
  const s = await SRC();
  assert.ok(/function signatureOf/.test(s), "an opportunity has an identity");
  assert.ok(/seen\.current\.has\(sig\)/.test(s), "and one already seen does not fire again");
  assert.ok(/side, s\.style, s\.stop/.test(s), "the identity is the trade itself, not a timestamp");
});

test("it never appears over an open position", async () => {
  const s = await SRC();
  assert.ok(/if \(!setup \|\| hasPosition\) return;/.test(s), "not raised while a trade is running");
  assert.ok(/if \(hasPosition\) setShown\(null\)/.test(s), "and dismissed if one opens while it is up");
});

test("only a genuinely takeable setup interrupts", async () => {
  const s = await SRC();
  assert.ok(/READY = new Set\(\["ready", "armed"\]\)/.test(s), "developing is not ready");
  assert.ok(/!setup\.side \|\| setup\.stop == null/.test(s), "and a setup with no stop is not a trade");
});

/*
 * THE NUMBER THAT MATTERS IN THE SECOND BEFORE SOMEONE COMMITS.
 */
test("risk is shown in money, not only as a percentage", async () => {
  const s = await SRC();
  assert.ok(/balance \* riskPct\) \/ 100/.test(s), "converted against the real balance");
  assert.ok(/if the stop is hit/.test(s), "and named as what it is");
});

test("permission is asked for at the moment there is something to say", async () => {
  const s = await SRC();
  // A prompt on page load, for a notification that may never come, is how people learn to click Block.
  const effect = s.slice(s.indexOf("decide whether to interrupt"), s.indexOf("A position opening while"));
  assert.ok(/requestPermission/.test(effect), "requested inside the alert, not on mount");
  assert.ok(/never break the alert itself/.test(s), "and a failed notification does not break the box");
});
