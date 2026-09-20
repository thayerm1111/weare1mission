/**
 * VOICE METERING.
 *
 * The owner saw 158 of his 1,000 minutes gone after barely using the microphone. His sessions had been
 * billed 162 minutes for 94 minutes of actual life. Every customer buying the $190 plan would have lost
 * the same share. These tests are built from his real session rows.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { billableMinutes } from "../command-center/engines/voice";

const at = (hms: string) => `2026-09-19T${hms}Z`;
const ms = (hms: string) => Date.parse(at(hms));

test("an abandoned line is billed to when it went quiet, not to when it was found", () => {
  /*
   * Real row: started 23:51:02, last seen 23:51:03, reaped at 23:58:50, billed 8 minutes. It was alive
   * for one second. The reaper selected last_seen_at and then ignored it.
   */
  const billed = billableMinutes(at("23:51:02"), at("23:51:03"), ms("23:58:50"));
  assert.ok(billed <= 0.6, `billed ${billed} — one second of life plus the heartbeat grace, not eight minutes`);
});

test("a session is metered to the tenth, not rounded up to a whole minute", () => {
  // Eighteen seconds used to cost a full minute. Nineteen reopenings tonight meant nineteen such minutes.
  assert.equal(billableMinutes(at("22:32:02"), at("22:32:20"), ms("22:32:20")), 0.3);
});

test("a genuine conversation is billed in full", () => {
  // The fix must not undercharge real use: 5.3 minutes of live heartbeats is 5.3 minutes.
  const billed = billableMinutes(at("23:14:05"), at("23:19:21"), ms("23:19:46"));
  assert.ok(billed >= 5.2 && billed <= 5.7, `billed ${billed}`);
});

test("billing never runs past when the line actually closed", () => {
  // A last heartbeat stamped after close (clock skew, late write) must not extend the charge.
  assert.equal(billableMinutes(at("20:00:00"), at("20:10:00"), ms("20:05:00")), 5);
});

test("a line that never sent a heartbeat bills to its close, and a missing start bills nothing", () => {
  assert.equal(billableMinutes(at("20:00:00"), null, ms("20:02:00")), 2);
  assert.equal(billableMinutes("not a date", at("20:00:00"), ms("20:02:00")), 0);
});

test("tonight's real sessions, re-metered", () => {
  // The owner's nine abandoned sessions were billed 117 minutes. Re-metered from their own timestamps:
  const abandoned: [string, string, string][] = [
    ["23:51:02", "23:51:03", "23:58:50"],
    ["23:26:21", "23:26:27", "23:34:06"],
    ["22:48:42", "22:48:46", "22:55:42"],
    ["22:32:20", "22:32:30", "22:39:54"],
    ["20:26:11", "20:26:11", "20:30:03"],
  ];
  const old = [8, 8, 7, 8, 4].reduce((a, b) => a + b, 0);
  const now = abandoned.reduce((a, [s, l, e]) => a + billableMinutes(at(s), at(l), ms(e)), 0);
  assert.equal(old, 35);
  assert.ok(now < 3, `these five went from ${old} minutes to ${now.toFixed(1)}`);
});
