import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import type { BrokerPosition } from "../rapid/exec/port";
import { createLiveActivationNotifier } from "../nitrous/live-activation";

const NOW = Date.parse("2026-11-26T20:01:00Z");
const setupId = "nitrous:0123456789abcdef0123456789abcdef";
const row: BrokerPosition = {
  positionId: "broker-1", strategyId: "NITROUS:owned", side: "buy",
  qty: 0.05, entry: 4200, stopLoss: 4195, takeProfit: 4210,
};
const live = {
  environment: "live" as const, setupId, side: "buy" as const,
  positionId: "broker-1", strategyId: "NITROUS:owned", observedAt: NOW, row,
};

test("concurrent account fills and repeated polls yield one public activation for a setup", async () => {
  const sent: unknown[] = [];
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const observe = createLiveActivationNotifier(async event => {
    sent.push(event);
    await pending;
    return { ok: true, state: "sent" };
  }, () => NOW);
  const other = { ...live, positionId: "second-account-position", strategyId: "NITROUS:second" };
  const secondFill = { ...other, row: { ...row, positionId: other.positionId, strategyId: other.strategyId } };
  const first = observe(live);
  const repeated = observe(live);
  const concurrent = observe(secondFill);
  await setImmediate();
  assert.equal(sent.length, 1);
  release();
  await Promise.all([first, repeated, concurrent]);
  await setImmediate();
  await observe(secondFill);
  await setImmediate();
  assert.deepEqual(sent, [{ kind: "activated", setupId, side: "buy", occurredAt: new Date(NOW).toISOString() }]);
});

test("activation requires a fresh, positively identified live fill", async () => {
  const sent: unknown[] = [];
  const observe = createLiveActivationNotifier(async event => { sent.push(event); return { ok: true, state: "sent" }; }, () => NOW);
  await observe({ ...live, environment: "demo" });
  await observe({ ...live, row: undefined });
  await observe({ ...live, observedAt: NOW - 30001 });
  await observe({ ...live, observedAt: NaN });
  await observe({ ...live, setupId: "account-private-identifier" });
  for (const patch of [
    { positionId: "other-position" }, { strategyId: "NITROUS:foreign" }, { strategyId: null },
    { side: "sell" as const }, { qty: 0 }, { qty: NaN }, { qty: null },
    { entry: 0 }, { entry: Infinity }, { entry: null },
  ]) await observe({ ...live, row: { ...row, ...patch } });
  await setImmediate();
  assert.deepEqual(sent, []);
});

test("delivery failures do not escape into the trade worker", async () => {
  let attempts = 0;
  const observe = createLiveActivationNotifier(async () => {
    attempts++;
    throw new Error("delivery store unavailable");
  }, () => NOW);
  await observe(live);
  await setImmediate();
  assert.equal(attempts, 1);
});
