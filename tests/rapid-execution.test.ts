import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_CONFIG } from "../rapid/config/defaults";
import type { Quote, Setup } from "../rapid/core/types";
import { MemoryStore, SimulatedBroker, goldSpec } from "../rapid/exec/simulator";
import { submitProtected } from "../rapid/exec/submit";
import { executablePrice, preSubmissionGate } from "../rapid/exec/guards";
import { RAPID_TAG_PREFIX, isRapidTag, tagFor } from "../rapid/exec/ownership";

const NOW = Date.UTC(2026, 8, 21, 14, 0, 0);

const quote = (bid: number, ask: number, at = NOW): Quote => ({
  source: "broker", bid, ask, providerTs: null, providerTsPrecision: "none", receivedAt: at, seq: null,
});

const setup = (over: Partial<Setup> = {}): Setup => ({
  setupId: "s1", visitId: "v1", strategyVersion: "matty_rapid_v1", configVersion: "matty_rapid_v1.cfg.1",
  family: "range_reaction", side: "buy", state: "armed", timeframe: "M5", zoneId: "z1", zoneVersion: 1,
  parentId: "z1", createdAt: NOW - 60_000, stateAt: NOW, expiresAt: NOW + 600_000,
  tolerances: { atrEntry: 2, touchTolerance: 0.3, breakBuffer: 0.2, stopBuffer: 0.3, rearmDistance: 2, spreadAtFreeze: 0.2 },
  entryBandLow: 4315.5, entryBandHigh: 4317.0, invalidation: 4313, stop: 4312.5,
  opposingLevelId: null, opposingPrice: null, refEntry: 4316, target: 4326, targetUsd: 10, stopUsd: 3.5,
  transitions: [], conditionsMet: [], conditionsPending: [], breakEvidence: null, ...over,
});

const gate = (over: Partial<Parameters<typeof preSubmissionGate>[0]> = {}) =>
  preSubmissionGate({
    now: NOW, setup: setup(), quote: quote(4315.9, 4316.1), quoteAgeMs: 200, spec: goldSpec,
    executable: 4316.1, currentZoneVersion: 1, automationVersionAtDecision: 5, automationVersionNow: 5,
    automationEnabled: true, sessionOpen: true, newsBlocked: false, basisUnstable: false,
    signalAgeMs: 300, cfg: DEFAULT_CONFIG, ...over,
  });

const sim = (script = {}, price = { bid: 4315.9, ask: 4316.1 }) =>
  new SimulatedBroker({ ...price, equity: 10_000, freeMargin: 9000, currency: "USD", spec: goldSpec }, script);

const run = (port: SimulatedBroker, store: MemoryStore, over: Record<string, unknown> = {}) =>
  submitProtected({
    intentId: "i1", intentKey: "acct1|matty_rapid_v1|s1|v1", side: "buy", qty: 0.1, stop: 4312.5,
    target: 4326, strategyId: tagFor("acct1|matty_rapid_v1|s1|v1"), protectionDeadlineMs: 500,
    stillApproved: () => true, port, store, ...over,
  } as Parameters<typeof submitProtected>[0]);

// =================================================================================================
// The gate
// =================================================================================================
test("gate: a healthy setup passes and says what it checked", () => {
  const r = gate();
  assert.equal(r.ok, true);
  if (r.ok) assert.ok(r.notes.some((n) => /live check/.test(n)));
});

test("gate: automation turned off between the decision and the send is caught at the last moment", () => {
  assert.equal(gate({ automationEnabled: false }).ok, false);
  const changed = gate({ automationVersionNow: 6 });
  assert.equal(changed.ok, false);
  if (!changed.ok) assert.equal(changed.code, "automation_changed");
});

test("gate: an expired setup, a moved level and a closed session all block", () => {
  assert.equal((gate({ now: NOW + 700_000 }) as { code?: string }).code, "expired");
  assert.equal((gate({ currentZoneVersion: 2 }) as { code?: string }).code, "zone_moved");
  assert.equal((gate({ sessionOpen: false }) as { code?: string }).code, "session_closed");
});

test("gate: a stale quote or a stale approval blocks rather than being relabelled as live", () => {
  assert.equal((gate({ quoteAgeMs: 5000 }) as { code?: string }).code, "stale_quote");
  assert.equal((gate({ signalAgeMs: 9000 }) as { code?: string }).code, "signal_stale");
});

test("gate: an unstable feed basis and a news window both block", () => {
  assert.equal((gate({ basisUnstable: true }) as { code?: string }).code, "basis_unstable");
  assert.equal((gate({ newsBlocked: true }) as { code?: string }).code, "news_window");
});

test("gate: a blown-out spread blocks, on the absolute AND the relative test", () => {
  assert.equal((gate({ quote: quote(4315.0, 4316.1), executable: 4316.1 }) as { code?: string }).code, "spread_too_wide");
  // 1.4 target with a 0.3 spread: under the absolute ceiling, over 15% of the target.
  const s = setup({ target: 4317.5, targetUsd: 1.4 });
  const r = preSubmissionGate({
    now: NOW, setup: s, quote: quote(4315.85, 4316.15), quoteAgeMs: 100, spec: goldSpec, executable: 4316.15,
    currentZoneVersion: 1, automationVersionAtDecision: 5, automationVersionNow: 5, automationEnabled: true,
    sessionOpen: true, newsBlocked: false, basisUnstable: false, signalAgeMs: 100, cfg: DEFAULT_CONFIG,
  });
  assert.equal(r.ok, false);
});

test("gate: price outside the frozen band is chasing, not entering", () => {
  assert.equal((gate({ executable: 4320 }) as { code?: string }).code, "outside_band");
  assert.equal((gate({ executable: 4310 }) as { code?: string }).code, "outside_band");
});

test("gate: a wider live spread demands a WIDER stop buffer and says so, instead of shrinking the stop", () => {
  const r = gate({ quote: quote(4315.75, 4316.1), executable: 4316.1 });
  assert.equal(r.ok, true);
  if (r.ok) assert.ok(r.notes.some((n) => /protective buffer .* -> /.test(n)), r.notes.join(" | "));
});

test("gate: a bracket price has already passed is refused", () => {
  assert.equal((gate({ setup: setup({ stop: 4317 }), executable: 4316.1 }) as { code?: string }).code, "bracket_invalid");
  assert.equal((gate({ setup: setup({ target: 4316, entryBandHigh: 4320 }), executable: 4316.1 }) as { code?: string }).code, "bracket_invalid");
});

test("gate: executablePrice picks the right side and refuses a crossed book", () => {
  const q = quote(4315.9, 4316.1);
  assert.equal(executablePrice(q, "buy", "entry"), 4316.1);
  assert.equal(executablePrice(q, "buy", "exit"), 4315.9);
  assert.equal(executablePrice(q, "sell", "entry"), 4315.9);
  assert.equal(executablePrice(quote(4316.3, 4316.1), "buy", "entry"), null);
});

// =================================================================================================
// Submission
// =================================================================================================
test("submission: the happy path ends protected, with the position recorded once", async () => {
  const port = sim();
  const store = new MemoryStore();
  const out = await run(port, store);
  assert.equal(out.state, "protected");
  assert.deepEqual(store.sequence, ["submitting", "acknowledged", "protection_pending", "protected"]);
  assert.equal(store.opened.length, 1);
  assert.equal(store.opened[0].protectionState, "protected");
});

test("submission: the approval being withdrawn at the last instant stops the order going out", async () => {
  const port = sim();
  const store = new MemoryStore();
  const out = await run(port, store, { stillApproved: () => false });
  assert.equal(out.state, "cancelled");
  assert.equal(port.calls.includes("submit"), false, "nothing may reach the broker");
});

test("submission: a timeout that actually filled becomes submission_unknown, NEVER a resubmit", async () => {
  const port = sim({ submitTimesOutButFills: true });
  const store = new MemoryStore();
  const out = await run(port, store);
  assert.equal(out.state, "submission_unknown");
  assert.equal(port.calls.filter((c) => c === "submit").length, 1, "exactly one order was sent");
  // The position really is open at the broker; reconciliation, not retry, is what finds it.
  assert.equal(port.openRows().length, 1);
});

test("submission: a plain rejection is a rejection, not an unknown", async () => {
  const port = sim({ submitRejects: "insufficient margin" });
  const store = new MemoryStore();
  const out = await run(port, store);
  assert.equal(out.state, "rejected");
  assert.equal(store.opened.length, 0);
});

test("submission: a closed session defers without opening anything", async () => {
  const port = sim({ submitSessionClosed: true });
  const store = new MemoryStore();
  const out = await run(port, store);
  assert.equal(out.state, "deferred");
  assert.equal(port.openRows().length, 0);
});

test("submission: an order id is never substituted for a position id", async () => {
  const port = sim({ ackWithoutPositionId: true });
  const store = new MemoryStore();
  const out = await run(port, store);
  assert.equal(out.state, "protected");
  assert.ok(port.calls.includes("resolvePosition"), "the position was resolved rather than assumed");
  assert.match(String(store.opened[0].positionId), /^P\d+$/);
});

test("submission: protection that did not attach is retried, then verified against the broker", async () => {
  const port = sim({ dropProtectionOnEntry: true });
  const store = new MemoryStore();
  const out = await run(port, store);
  assert.equal(out.state, "protected");
  assert.ok(port.calls.some((c) => c.startsWith("amend:")), "an attach was attempted");
  assert.equal(port.openRows()[0].stopLoss, 4312.5, "the broker really holds the stop now");
});

test("submission: a position that cannot be protected is CLOSED, not left naked", async () => {
  const port = sim({ dropProtectionOnEntry: true, amendAlwaysRejects: "protection not permitted" });
  const store = new MemoryStore();
  const out = await run(port, store);
  assert.equal(out.state, "unprotected_closed");
  assert.equal(port.openRows().length, 0, "the filled portion was closed");
  assert.ok(port.calls.some((c) => c.startsWith("cancelOrder:")), "any working entry quantity was cancelled first");
  assert.equal(store.opened.length, 0, "an unprotected position is never recorded as a live Rapid position");
});

test("submission: an emergency close that did not confirm is reported as UNRESOLVED, not as success", async () => {
  const port = sim({ dropProtectionOnEntry: true, amendAlwaysRejects: "no", closeFails: "broker unavailable" });
  const store = new MemoryStore();
  const out = await run(port, store);
  assert.equal(out.state, "unprotected_closed");
  assert.match((out as { reason: string }).reason, /did not confirm/);
  assert.match((out as { reason: string }).reason, /Exposure is unresolved/);
  assert.equal(port.openRows().length, 1, "the position is still there, and the report says so");
});

test("submission: a position that vanishes after acknowledgement is reconciled, not re-sent", async () => {
  const port = sim({ positionVanishes: true });
  const store = new MemoryStore();
  const out = await run(port, store);
  assert.equal(out.state, "submission_unknown");
  assert.match(out.reason, /reconcile/);
});

// =================================================================================================
// Ownership
// =================================================================================================
test("ownership: the broker tag is bounded to 31 characters and is recognisable", () => {
  const tag = tagFor("a-very-long-intent-key-that-exceeds-the-documented-limit");
  assert.ok(tag.length <= 31);
  assert.ok(tag.startsWith(RAPID_TAG_PREFIX));
  assert.equal(isRapidTag(tag), true);
  assert.equal(isRapidTag("SOMEONE-ELSE:1"), false);
  assert.equal(isRapidTag(null), false);
});
