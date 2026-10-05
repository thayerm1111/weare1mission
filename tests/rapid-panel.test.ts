import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { armBlockers, shownBlockers, recheckStalled, RECHECKING, RECHECK_FRESH_MS } from "../src/lib/rapidPanel";

/*
 * Rapid's account panel in the minute after "Allow shared account" is switched on (owner 10-04: "I
 * want to be able to turn on automation for this"). The worker re-checks the account about once a
 * minute; until it has, the old refusal is still on record. The panel now says it is re-checking
 * instead of repeating an instruction the owner has just followed — and the lock is untouched.
 */
const SHARED = "This broker account is also traded by FLOW/GENX and AURIC. Equity, margin and — on a netting account — positions are shared, so Rapid cannot guarantee isolation. Use a dedicated account or sub-account, or allow a shared account in Rapid's settings after reading this. Nothing on FLOW/GENX/AURIC has been changed.";
const FOREIGN = "2 open position(s) on this account were not opened by Rapid. New entries stay paused while external exposure exists, unless a shared account is explicitly allowed.";
const UNREAD = "the broker's open positions could not be read, so external exposure on this account is unknown";
const OFF = "automation is off for this account";
// The worker rewrites its verdict on every pass, so a verdict a minute old was written by a worker that is looking.
const NOW = Date.UTC(2026, 9, 5, 1, 43, 0);
const JUST = new Date(NOW - 60_000).toISOString();
const LONG_AGO = new Date(NOW - 20 * 60_000).toISOString();

test("automation being off is the switch, not a reason it is locked", () => {
  assert.deepEqual(armBlockers([OFF]), []);
  assert.deepEqual(armBlockers([SHARED, OFF]), [SHARED]);
});

test("until sharing is allowed, the refusal is printed word for word", () => {
  assert.deepEqual(shownBlockers([SHARED, OFF], false, JUST, NOW), [SHARED]);
  assert.deepEqual(shownBlockers([FOREIGN, OFF], false, JUST, NOW), [FOREIGN]);
  assert.deepEqual(shownBlockers([SHARED, OFF], false), [SHARED]);
});

test("once sharing is allowed, a shared-account refusal still on record reads as re-checking", () => {
  assert.deepEqual(shownBlockers([SHARED, OFF], true, JUST, NOW), [RECHECKING]);
  assert.deepEqual(shownBlockers([FOREIGN, OFF], true, JUST, NOW), [RECHECKING]);
  assert.ok(/re-checking/.test(RECHECKING) && /within a minute/.test(RECHECKING));
  assert.ok(!/allow a shared account/.test(RECHECKING), "it does not tell the owner to do what he has just done");
});

test("'within a minute' is only promised while the worker is actually looking at the account", () => {
  // The verdict on record is old: the broker session could not be renewed, or the worker is down.
  const stalled = shownBlockers([SHARED, OFF], true, LONG_AGO, NOW);
  assert.equal(stalled.length, 1);
  assert.notEqual(stalled[0], RECHECKING);
  assert.ok(/has not been able to re-check/.test(stalled[0]) && /stays locked/.test(stalled[0]) && !/within a minute/.test(stalled[0]));
  assert.equal(stalled[0], recheckStalled(LONG_AGO));
  assert.ok(/ since /.test(stalled[0]), "it says since when");
  // No time on record at all is not "looking" either.
  for (const t of [undefined, null, "", "not a date"]) {
    const out = shownBlockers([SHARED], true, t, NOW);
    assert.ok(/has not been able to re-check/.test(out[0]) && !/ since /.test(out[0]), `checkedAt=${String(t)}`);
  }
  // The line between the two is three minutes.
  assert.equal(RECHECK_FRESH_MS, 180_000);
  assert.deepEqual(shownBlockers([SHARED], true, new Date(NOW - RECHECK_FRESH_MS).toISOString(), NOW), [RECHECKING]);
  assert.notEqual(shownBlockers([SHARED], true, new Date(NOW - RECHECK_FRESH_MS - 1000).toISOString(), NOW)[0], RECHECKING);
});

test("every other reason is printed as it is, allowed or not", () => {
  const others = [UNREAD, "gold has not been resolved on this account yet — checking with the broker", "instrument metadata incomplete: lotSize", "Rapid is not enabled for live execution yet", "new entries are paused"];
  assert.deepEqual(shownBlockers([...others, OFF], true, JUST, NOW), others);
  assert.deepEqual(shownBlockers([...others, OFF], true, LONG_AGO, NOW), others);
  assert.deepEqual(shownBlockers([SHARED, ...others], true, JUST, NOW), [RECHECKING, ...others]);
  assert.deepEqual(shownBlockers([], true, JUST, NOW), []);
});

test("the wording matched is the wording Rapid's ownership check writes", () => {
  const src = readFileSync("rapid/exec/ownership.ts", "utf8");
  assert.ok(src.includes("This broker account is also traded by ${sharedWith.join(\" and \")}"), "the shared-account refusal");
  assert.ok(src.includes("open position(s) on this account were not opened by Rapid"), "the foreign-positions refusal");
  // Both are refusals that allowing a shared account answers, and only those two are.
  assert.equal((src.match(/&& !allowShared\)/g) ?? []).length, 2);
});

test("the lock is the same lock: only what is printed changed", () => {
  const desk = readFileSync("src/components/portal/rapid/RapidDesk.tsx", "utf8");
  assert.ok(/const armBlocked = armBlockers\(a\.blockers\);/.test(desk));
  assert.ok(/disabled=\{!a\.automationEnabled && armBlocked\.length > 0\}/.test(desk), "Automation stays locked while anything blocks it");
  assert.ok(/const blockerLines = shownBlockers\(a\.blockers, a\.allowSharedAccount === true, a\.ownershipCheckedAt\);/.test(desk));
  // …and the time of the worker's verdict reaches the panel from the route it loads.
  const analyze = readFileSync("src/app/api/rapid/analyze/route.ts", "utf8");
  assert.equal((analyze.match(/ownershipCheckedAt: \(\w+(?:\.ownership_check)? as \{ checkedAt\?: string \} \| null\)\?\.checkedAt \?\? null/g) ?? []).length, 2);
  const ownership = readFileSync("rapid/exec/ownership.ts", "utf8");
  assert.ok(/const checkedAt = new Date\(\)\.toISOString\(\);/.test(ownership), "every verdict is stamped when it is written");
  assert.ok(/\{blockerLines\.map\(\(b, i\) => <li key=\{i\}>• \{b\}<\/li>\)\}/.test(desk));
  // The server's own gate is untouched: arming is refused while the ownership check on record says no.
  const settings = readFileSync("src/app/api/rapid/settings/route.ts", "utf8");
  assert.ok(/if \(ownership && ownership\.ok === false\) blockers\.push\(/.test(settings) && /return json\(\{ error: "not_ready", blockers \}, 409\)/.test(settings));
});
