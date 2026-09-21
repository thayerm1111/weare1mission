/**
 * THE OFF SWITCH.
 *
 * The owner's requirement is simple and absolute: when he switches ATLAS off, it stops. Everything
 * here is about the one way that promise can quietly break — a database blip immediately after the
 * switch is thrown, answering "I don't know" and being read as "carry on".
 */
import test from "node:test";
import assert from "node:assert/strict";
import { nextSwitchState } from "../command-center/engines/killSwitch";

const fresh = { latchedOff: false, lastKnownOn: null as boolean | null };

test("a clean read of ON lets it trade", () => {
  const s = nextSwitchState(fresh, true);
  assert.equal(s.on, true);
  assert.equal(s.latchedOff, false);
});

test("a clean read of OFF stops it and latches", () => {
  const s = nextSwitchState(fresh, false);
  assert.equal(s.on, false);
  assert.equal(s.latchedOff, true, "the latch is what survives the next failure");
  assert.match(s.reason, /admin panel/i);
});

test("ONCE OFF, A FAILED READ KEEPS IT OFF", () => {
  /*
   * The test this file exists for. The owner hits the switch, the row is written, the worker reads it
   * and stops. Then the database hiccups. A reader that fails open would resume trading seconds after
   * being told to stop, on a live funded account, with nobody expecting it to be running.
   */
  const afterOff = nextSwitchState(fresh, false);
  const afterBlip = nextSwitchState({ latchedOff: afterOff.latchedOff, lastKnownOn: false }, null);
  assert.equal(afterBlip.on, false);
  assert.equal(afterBlip.latchedOff, true, "and it stays latched through repeated failures");

  const stillOff = nextSwitchState({ latchedOff: afterBlip.latchedOff, lastKnownOn: false }, null);
  assert.equal(stillOff.on, false);
});

test("only an explicit successful ON clears the latch", () => {
  const off = nextSwitchState(fresh, false);
  const backOn = nextSwitchState({ latchedOff: off.latchedOff, lastKnownOn: false }, true);
  assert.equal(backOn.on, true);
  assert.equal(backOn.latchedOff, false, "switching it back on in the panel really does switch it on");

  // And after clearing, a later failure no longer forces off — the latch is not permanent.
  const laterBlip = nextSwitchState({ latchedOff: backOn.latchedOff, lastKnownOn: true }, null);
  assert.equal(laterBlip.on, true);
});

test("a failure before anything was ever read defers rather than inventing an answer", () => {
  // Never seen the switch: keep the last known state, and with none, allow — CC_AUTOPILOT already
  // decides whether the loop runs at all, and the entry path below has its own fail-closed gates.
  assert.equal(nextSwitchState(fresh, null).on, true);
  assert.equal(nextSwitchState({ latchedOff: false, lastKnownOn: true }, null).on, true);
  assert.equal(nextSwitchState({ latchedOff: false, lastKnownOn: false }, null).on, false,
    "a remembered off is still an off, even without the latch");
});

test("the reason is always something a person can act on", () => {
  assert.equal(nextSwitchState(fresh, true).reason, "");
  assert.match(nextSwitchState(fresh, false).reason, /admin panel/i);
  assert.match(nextSwitchState({ latchedOff: true, lastKnownOn: false }, null).reason, /cannot be re-read/i);
});
