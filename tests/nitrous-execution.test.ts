import assert from "node:assert/strict";
import test from "node:test";
import type { BrokerPort, BrokerPosition } from "../rapid/exec/port";
import type { Store } from "../rapid/exec/submit";
import { protectionMatches, submitProtected, type ProtectedOrder } from "../nitrous/submit";
import { requestCloseOnce, type CloseDispatchResult, type CloseRequest } from "../nitrous/close";
import { aggregateClosed, dailyAllowance, referenceFresh } from "../nitrous/logic";

const livePosition = (patch: Partial<BrokerPosition> = {}): BrokerPosition => ({
  positionId: "owned-position", strategyId: "NITROUS:owned-strategy", side: "buy", qty: 0.05,
  entry: 4200, stopLoss: 4195, takeProfit: 4210, ...patch,
});
function fixture() {
  let now = Date.parse("2026-11-25T15:00:00Z");
  const actions: string[] = [];
  const states: string[] = [];
  const opened: Array<Parameters<Store["openPosition"]>[1]> = [];
  const requested: string[] = [];
  const port: BrokerPort = {
    quote: async () => { throw new Error("unexpected quote read"); },
    spec: async () => { throw new Error("unexpected contract read"); },
    accountState: async () => { throw new Error("unexpected account read"); },
    submit: async () => { actions.push("submit"); return { ok: true, orderId: "order-1", positionId: "owned-position" }; },
    resolvePosition: async () => null,
    positions: async () => { actions.push("positions"); return { ok: true, rows: [livePosition()] }; },
    amend: async () => { actions.push("amend"); return { ok: true }; },
    close: async () => { actions.push("direct-close"); return { ok: true }; },
    cancelOrder: async () => { actions.push("cancel-order"); return { ok: true }; },
  };
  const store: Store = {
    setState: async (_id, state) => { states.push(state); actions.push(`state:${state}`); },
    recordBrokerEvent: async () => { actions.push("broker-event"); },
    openPosition: async (_id, row) => { opened.push(row); actions.push("persist-position"); },
  };
  const input: ProtectedOrder = {
    intentId: "intent-1", side: "buy", qty: 0.05, stop: 4195, target: 4210,
    preexistingPositionIds: [],
    strategyId: "NITROUS:owned-strategy", tick: 0.01, riskBudget: 26,
    valuePerPricePerLot: 100, commissionPerLot: 10, exitAllowance: 0.1,
    protectionDeadlineMs: 500, approved: async () => true, stillOwned: () => true,
    port, store, now: () => now, wait: async (ms) => { now += ms; },
    requestClose: async (positionId: string) => { requested.push(positionId); actions.push("queue-close"); },
  };
  return { input, port, store, actions, states, opened, requested };
}

test("protected submission persists submitting before one dispatch and records only broker-confirmed fill", async () => {
  const f = fixture();
  const result = await submitProtected(f.input);
  assert.equal(result.state, "protected");
  assert.ok(f.actions.indexOf("state:submitting") < f.actions.indexOf("submit"));
  assert.equal(f.actions.filter((a) => a === "submit").length, 1);
  assert.equal(f.opened.length, 1); assert.equal(f.opened[0].entry, 4200); assert.equal(f.opened[0].protectionState, "protected");
  assert.deepEqual(f.requested, []);
});

test("timeout and uncertain submission responses never resubmit or imply a position", async () => {
  for (const thrown of [false, true]) {
    const f = fixture(); let count = 0;
    f.port.submit = async () => { count++; if (thrown) throw new Error("transport timeout"); return { ok: false, uncertain: true, error: "unknown" }; };
    assert.equal((await submitProtected(f.input)).state, "submission_unknown");
    assert.equal(count, 1); assert.deepEqual(f.opened, []); assert.deepEqual(f.requested, []);
    assert.ok(f.states.includes("submission_unknown")); assert.ok(!f.states.includes("rejected"));
  }
});

test("an acknowledgement without a position ID remains unknown; order ID is never used as position ID", async () => {
  const f = fixture();
  f.port.submit = async () => ({ ok: true, orderId: "only-an-order", positionId: null });
  assert.equal((await submitProtected(f.input)).state, "submission_unknown");
  assert.deepEqual(f.opened, []); assert.deepEqual(f.requested, []);
});

test("shared-account fills cannot adopt a pre-existing position even if its broker tag changes", async () => {
  for (const resolveFromHistory of [false, true]) {
    const f = fixture();
    f.input.preexistingPositionIds = ["owned-position"];
    if (resolveFromHistory) {
      f.port.submit = async () => { f.actions.push("submit"); return { ok: true, orderId: "order-1", positionId: null }; };
      f.port.resolvePosition = async () => ({ positionId: "owned-position", fillPrice: 4200, filledQty: 0.05 });
    }
    assert.equal((await submitProtected(f.input)).state, "protection_pending");
    assert.deepEqual(f.opened, []); assert.deepEqual(f.requested, []);
    assert.ok(!f.actions.includes("amend")); assert.ok(!f.actions.includes("direct-close"));
    assert.equal(f.actions.filter((a) => a === "submit").length, 1);
  }
});

test("foreign shared-account exposure does not block a distinct new Nitrous position", async () => {
  const f = fixture(); f.input.preexistingPositionIds = ["flow-position", "atlas-position", "manual-position"];
  assert.equal((await submitProtected(f.input)).state, "protected");
  assert.equal(f.opened[0].positionId, "owned-position");
  assert.deepEqual(f.requested, []);
});

test("lost approval before or after submitting persistence cancels before any broker dispatch", async () => {
  for (const afterPersistence of [false, true]) {
    const f = fixture(); let checks = 0;
    f.input.approved = async () => afterPersistence ? ++checks === 1 : false;
    assert.equal((await submitProtected(f.input)).state, "cancelled");
    assert.ok(!f.actions.includes("submit")); assert.ok(f.states.includes("cancelled"));
  }
});

test("lost lease and failed submitting persistence never dispatch", async () => {
  const f = fixture(); f.input.stillOwned = () => false;
  assert.equal((await submitProtected(f.input)).state, "cancelled"); assert.ok(!f.actions.includes("submit"));
  const g = fixture(); g.store.setState = async () => { throw new Error("store unavailable"); };
  await assert.rejects(submitProtected(g.input)); assert.ok(!g.actions.includes("submit"));
});

test("protection verification requires exact identity, finite native legs and filled risk within the cap", () => {
  const f = fixture(); assert.equal(protectionMatches(livePosition(), f.input), true);
  for (const patch of [
    { strategyId: "NITROUS:someone-else" }, { side: "sell" as const }, { qty: 0.06 }, { qty: 0.02 },
    { stopLoss: 4194 }, { takeProfit: 4209 }, { takeProfit: NaN }, { takeProfit: Infinity },
    { qty: NaN }, { entry: NaN }, { stopLoss: null },
  ]) assert.equal(protectionMatches(livePosition(patch), f.input), false, JSON.stringify(patch));
  // The same stop at an adverse confirmed fill exceeds a $26 allowance.
  assert.equal(protectionMatches(livePosition({ entry: 4200.1 }), f.input), false);
  assert.equal(protectionMatches(livePosition(), { ...f.input, valuePerPricePerLot: 0 }), false);
  assert.equal(protectionMatches(livePosition(), { ...f.input, tick: NaN }), false);
});

test("unprotected own exposure persists before delegating one durable close, never directly closing", async () => {
  const f = fixture();
  f.port.positions = async () => ({ ok: true, rows: [livePosition({ stopLoss: null })] });
  assert.equal((await submitProtected(f.input)).state, "protection_pending");
  assert.equal(f.opened.length, 1); assert.equal(f.opened[0].protectionState, "unconfirmed");
  assert.deepEqual(f.requested, ["owned-position"]);
  assert.ok(f.actions.indexOf("persist-position") < f.actions.indexOf("queue-close"));
  assert.ok(!f.actions.includes("direct-close"));
});

test("a protective exit records the specific failed broker check", async () => {
  for (const [row, reason] of [
    [livePosition({ entry: 4200.10 }), "Filled risk 26.50 exceeds the reserved 26.00."],
    [livePosition({ stopLoss: null }), "TradeLocker did not confirm the stop price."],
    [livePosition({ takeProfit: null }), "TradeLocker did not confirm the target price."],
  ] as const) {
    const f = fixture();
    f.port.positions = async () => ({ ok: true, rows: [row] });
    const reasons: string[] = [];
    f.input.requestClose = async (_id, message) => { reasons.push(message); };
    const result = await submitProtected(f.input);
    assert.equal(result.reason, reason);
    assert.deepEqual(reasons, [reason]);
  }
});

test("a position ID with someone else's strategy never authorizes amend or emergency close", async () => {
  const f = fixture();
  f.port.positions = async () => ({ ok: true, rows: [livePosition({ strategyId: "other", stopLoss: null })] });
  assert.equal((await submitProtected(f.input)).state, "protection_pending");
  assert.deepEqual(f.opened, []); assert.deepEqual(f.requested, []);
  assert.ok(!f.actions.includes("amend")); assert.ok(!f.actions.includes("direct-close"));
});

test("lease loss during a broker positions read prevents subsequent broker mutations", async () => {
  const f = fixture(); let held = true;
  f.input.stillOwned = () => held;
  f.port.positions = async () => { held = false; return { ok: true, rows: [livePosition({ stopLoss: null })] }; };
  await submitProtected(f.input);
  assert.ok(!f.actions.includes("amend")); assert.ok(!f.actions.includes("direct-close")); assert.deepEqual(f.requested, []);
});

function closeFixture() {
  let claimed = false; let closes = 0;
  const results: CloseDispatchResult[] = [];
  const input: CloseRequest = {
    positionId: "owned-position", held: () => true, approved: async () => true,
    claim: async () => { if (claimed) return false; claimed = true; return true; },
    finish: async (result) => { results.push(result); },
    port: { close: async (id) => { assert.equal(id, "owned-position"); assert.equal(claimed, true); closes++; return { ok: true }; } },
  };
  return { input, results, count: () => closes, claimed: () => claimed };
}

test("concurrent close requests share a durable claim and dispatch only once", async () => {
  const f = closeFixture(); const results = await Promise.all([requestCloseOnce(f.input), requestCloseOnce(f.input)]);
  assert.equal(f.count(), 1); assert.deepEqual(results.map((r) => r.state).sort(), ["acknowledged", "skipped"]);
  assert.equal(f.results[0].state, "acknowledged");
});

test("uncertain close and failed result persistence retain the claim and prohibit blind retry", async () => {
  for (const failure of ["throw", "uncertain", "finish"] as const) {
    const f = closeFixture(); let calls = 0;
    f.input.port.close = async () => { calls++; if (failure === "throw") throw new Error("sensitive-token-in-url"); return failure === "uncertain" ? { ok: false, uncertain: true, error: "unknown" } : { ok: true }; };
    if (failure === "finish") f.input.finish = async () => { throw new Error("database down"); };
    const result = await requestCloseOnce(f.input);
    assert.equal(result.state, failure === "finish" ? "acknowledged" : "uncertain");
    assert.equal((await requestCloseOnce(f.input)).state, "skipped");
    assert.equal(calls, 1); assert.equal(f.claimed(), true);
    assert.doesNotMatch(JSON.stringify(result), /sensitive-token/);
    if (failure === "finish") assert.equal("persisted" in result ? result.persisted : null, false);
  }
});

test("ownership changes or claim errors prevent dispatch, including after durable claiming", async () => {
  const f = closeFixture(); f.input.held = () => false;
  assert.equal((await requestCloseOnce(f.input)).state, "skipped"); assert.equal(f.count(), 0); assert.equal(f.claimed(), false);
  const g = closeFixture(); g.input.claim = async () => { throw new Error("db down"); };
  assert.equal((await requestCloseOnce(g.input)).state, "skipped"); assert.equal(g.count(), 0);
  const h = closeFixture(); let count = 0; h.input.approved = async () => ++count === 1;
  assert.equal((await requestCloseOnce(h.input)).state, "cancelled"); assert.equal(h.count(), 0); assert.equal(h.results[0].state, "cancelled");
});

test("known broker rejection is distinct from an acknowledged or unknown close", async () => {
  const f = closeFixture(); f.input.port.close = async () => ({ ok: false, uncertain: false, error: "Market closed" });
  const result = await requestCloseOnce(f.input); assert.equal(result.state, "rejected");
  assert.equal(f.results[0].error, "Market closed");
});

test("daily losses cannot be replenished by winners and unknown P&L stops entries", () => {
  assert.equal(dailyAllowance(500, 520, 3, [{ realised_pnl: 30, realised_pnl_source: "broker_net" }, { realised_pnl: -10, realised_pnl_source: "broker_net" }]), 5);
  assert.equal(dailyAllowance(500, 480, 3, []), 0);
  assert.equal(dailyAllowance(500, 500, 3, [{ realised_pnl: null, realised_pnl_source: "unknown" }]), null);
});

test("forming or stale reference candles and incomplete aggregation do not trigger a fresh read", () => {
  const start = Date.parse("2026-11-25T15:00:00Z");
  const bars = Array.from({ length: 5 }, (_, i) => ({ t: start + i * 60_000, o: 4200, h: 4202, l: 4199, c: 4201 }));
  assert.equal(referenceFresh(bars, start + 4 * 60_000), false);
  assert.equal(referenceFresh(bars, start + 8 * 60_000), false);
  assert.equal(aggregateClosed(bars.slice(1), 5, start + 5 * 60_000).length, 0);
  assert.equal(aggregateClosed(bars, 5, start + 5 * 60_000).length, 1);
  assert.equal(aggregateClosed([bars[0], bars[0], ...bars.slice(2)], 5, start + 5 * 60_000).length, 0);
  assert.equal(aggregateClosed([...bars].reverse(), 5, start + 5 * 60_000)[0].c, bars[4].c);
  assert.equal(aggregateClosed(bars.map((b, i) => i === 2 ? { ...b, c: b.h + 1 } : b), 5, start + 5 * 60_000).length, 0);
});


test("submission observes a live Nitrous fill once and continues if its notification throws", async () => {
  const f = fixture();
  const observed: string[] = [];
  f.input.onLivePosition = row => {
    observed.push(row.positionId);
    throw new Error("telegram delivery unavailable");
  };
  const result = await submitProtected(f.input);
  assert.equal(result.state, "protected");
  assert.deepEqual(observed, ["owned-position"]);
  assert.deepEqual(f.states.slice(-1), ["protected"]);
  assert.deepEqual(f.requested, []);
});

test("an order acknowledgement or historical fill alone cannot activate Telegram", async () => {
  const f = fixture();
  f.port.submit = async () => ({ ok: true, orderId: "open-1", positionId: null });
  f.port.resolvePosition = async () => ({ positionId: "owned-position", fillPrice: 4200, filledQty: 0.05 });
  f.port.positions = async () => ({ ok: true, rows: [] });
  let observations = 0;
  f.input.onLivePosition = () => { observations++; };
  const result = await submitProtected(f.input);
  assert.equal(result.state, "protection_pending");
  assert.equal(observations, 0);
});

test("live observations exclude merged positions and mismatched broker ownership", async () => {
  for (const kind of ["merged", "side", "tag", "size"] as const) {
    const f = fixture();
    if (kind === "merged") f.input.preexistingPositionIds = ["owned-position"];
    if (kind === "side") f.port.positions = async () => ({ ok: true, rows: [livePosition({ side: "sell" })] });
    if (kind === "tag") f.port.positions = async () => ({ ok: true, rows: [livePosition({ strategyId: "NITROUS:another" })] });
    if (kind === "size") f.port.positions = async () => ({ ok: true, rows: [livePosition({ qty: 0 })] });
    let observations = 0;
    f.input.onLivePosition = () => { observations++; };
    await submitProtected(f.input);
    assert.equal(observations, 0, kind);
  }
});

test("a broker-confirmed fill can activate while protection is being checked", async () => {
  const f = fixture();
  let reads = 0;
  f.port.positions = async () => ({
    ok: true,
    rows: [++reads === 1 ? livePosition({ stopReadUnknown: true, stopLoss: null }) : livePosition()],
  });
  const observedOn: number[] = [];
  f.input.onLivePosition = () => { observedOn.push(reads); };
  assert.equal((await submitProtected(f.input)).state, "protected");
  assert.deepEqual(observedOn, [1]);
  assert.deepEqual(f.requested, []);
});
