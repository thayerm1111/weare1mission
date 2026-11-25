import assert from "node:assert/strict";
import test from "node:test";
import { hasNitrousAddonAccess, revokeNitrousAutomationWithoutAccess } from "../nitrous/access";
import { submitProtected, type ProtectedOrder } from "../nitrous/submit";

type AccessDb = Parameters<typeof hasNitrousAddonAccess>[0];
type RpcCall = { name: string; args: Record<string, unknown> };
type Reply = { data: unknown; error: unknown };
const account = {
  id: "22446688-1111-4444-8888-222222222222",
  user_id: "22446688-1111-4444-8888-111111111111",
  automation_enabled: true,
  automation_version: 17,
};

function database(reply: (call: RpcCall) => Reply | Promise<Reply>) {
  const calls: RpcCall[] = [];
  const db = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      const call = { name, args };
      calls.push(call);
      return reply(call);
    },
  } as unknown as AccessDb;
  return { db, calls };
}

test("worker access is granted only by an affirmative server entitlement result", async () => {
  const allowed = database(async () => ({ data: true, error: null }));
  assert.equal(await hasNitrousAddonAccess(allowed.db, account.user_id), true);
  assert.deepEqual(allowed.calls, [{ name: "nitrous_has_addon_access", args: { p_user: account.user_id } }]);

  for (const data of [false, null, undefined, 1, "true", [], [true], { entitled: true }]) {
    const denied = database(async () => ({ data, error: null }));
    assert.equal(await hasNitrousAddonAccess(denied.db, account.user_id), false, `Must not authorize from ${JSON.stringify(data)}`);
  }
});

test("an entitlement read error or rejected transport never grants trading access", async () => {
  const failed = database(async () => ({ data: true, error: { message: "database unavailable" } }));
  assert.equal(await hasNitrousAddonAccess(failed.db, account.user_id), false);
  const thrown = database(async () => { throw new Error("transport unavailable"); });
  assert.equal(await hasNitrousAddonAccess(thrown.db, account.user_id), false);
});

test("checking an entitled account does not change its explicit automation choice", async () => {
  const fixture = database(async () => ({ data: true, error: null }));
  assert.equal(await revokeNitrousAutomationWithoutAccess(fixture.db, account), true);
  assert.equal(fixture.calls.filter(c => c.name === "nitrous_pause_without_addon").length, 0);
});

test("lost access pauses only the owned account at the observed settings version", async () => {
  const fixture = database(async call => ({ data: call.name === "nitrous_has_addon_access" ? false : true, error: null }));
  assert.equal(await revokeNitrousAutomationWithoutAccess(fixture.db, account), false);
  assert.deepEqual(fixture.calls.filter(c => c.name === "nitrous_pause_without_addon"), [{
    name: "nitrous_pause_without_addon",
    args: { p_user: account.user_id, p_account: account.id, p_expected_version: account.automation_version },
  }]);
});

test("a conflicting pause version never permits dispatch or retries against newer member settings", async () => {
  const fixture = database(async () => ({ data: false, error: null }));
  assert.equal(await revokeNitrousAutomationWithoutAccess(fixture.db, account), false);
  assert.equal(fixture.calls.filter(c => c.name === "nitrous_pause_without_addon").length, 1);
});

test("a failed pause write still denies new trading without throwing past existing-position management", async () => {
  for (const throws of [false, true]) {
    const fixture = database(async call => {
      if (call.name === "nitrous_has_addon_access") return { data: false, error: null };
      if (throws) throw new Error("pause transport unavailable");
      return { data: null, error: { message: "pause unavailable" } };
    });
    assert.equal(await revokeNitrousAutomationWithoutAccess(fixture.db, account), false);
    assert.equal(fixture.calls.filter(c => c.name === "nitrous_pause_without_addon").length, 1);
  }
});

function submissionFixture(db: AccessDb, onState?: (state: string) => void) {
  const states: string[] = [];
  const actions: string[] = [];
  const unexpected = async (action: string): Promise<never> => {
    actions.push(action);
    throw new Error(`Unexpected broker action: ${action}`);
  };
  const order: ProtectedOrder = {
    preexistingPositionIds: [],
    intentId: "reserved-before-access-changed", side: "buy", qty: 0.01,
    stop: 4195, target: 4210, strategyId: "NITROUS:addon-test",
    tick: 0.01, riskBudget: 6, valuePerPricePerLot: 100,
    commissionPerLot: 10, exitAllowance: 0.1, protectionDeadlineMs: 100,
    approved: () => hasNitrousAddonAccess(db, account.user_id), stillOwned: () => true,
    port: {
      quote: () => unexpected("quote"), spec: () => unexpected("spec"),
      accountState: () => unexpected("accountState"), submit: () => unexpected("submit"),
      resolvePosition: () => unexpected("resolvePosition"), positions: () => unexpected("positions"),
      amend: () => unexpected("amend"), close: () => unexpected("close"), cancelOrder: () => unexpected("cancelOrder"),
    },
    store: {
      setState: async (_id, state) => { states.push(state); onState?.(state); },
      recordBrokerEvent: () => unexpected("recordBrokerEvent"),
      openPosition: () => unexpected("openPosition"),
    },
    requestClose: () => unexpected("requestClose"),
  };
  return { order, states, actions };
}

test("an already-reserved intent cannot dispatch after its add-on has expired", async () => {
  const fixture = database(async () => ({ data: false, error: null }));
  const submission = submissionFixture(fixture.db);
  assert.equal((await submitProtected(submission.order)).state, "cancelled");
  assert.deepEqual(submission.states, ["cancelled"]);
  assert.deepEqual(submission.actions, []);
});

test("revocation between approval and submitting persistence cancels before the broker call", async () => {
  let entitled = true;
  const fixture = database(async () => ({ data: entitled, error: null }));
  const submission = submissionFixture(fixture.db, state => { if (state === "submitting") entitled = false; });
  assert.equal((await submitProtected(submission.order)).state, "cancelled");
  assert.deepEqual(submission.states, ["submitting", "cancelled"]);
  assert.equal(fixture.calls.filter(c => c.name === "nitrous_has_addon_access").length, 2);
  assert.deepEqual(submission.actions, []);
});

test("an entitlement outage at the final dispatch check cancels without an uncertain order", async () => {
  let checks = 0;
  const fixture = database(async () => {
    if (++checks === 1) return { data: true, error: null };
    throw new Error("database became unavailable");
  });
  const submission = submissionFixture(fixture.db);
  assert.equal((await submitProtected(submission.order)).state, "cancelled");
  assert.deepEqual(submission.states, ["submitting", "cancelled"]);
  assert.deepEqual(submission.actions, []);
});
