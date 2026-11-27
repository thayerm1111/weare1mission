import assert from "node:assert/strict";
import test from "node:test";
import type { BrokerPosition } from "../rapid/exec/port";
import { withNitrousDb } from "../rapid/db";
import { ongoingHazard } from "../nitrous/ongoing-protection";

const position = { broker_position_id: "position-18", broker_strategy_id: "NITROUS:breakout", side: "buy" as const,
  original_qty: 18.28, initial_stop: 3637.49 };
const fill: BrokerPosition = { positionId: position.broker_position_id, strategyId: position.broker_strategy_id,
  side: position.side, qty: 18.28, entry: 3640.01, stopLoss: 3637.49, takeProfit: 3655.67 };

test("ongoing protection distinguishes a confirmed breach from a changed, foreign or unreadable position", () => {
  const check = (patch: Partial<BrokerPosition>) => ongoingHazard(position, { ...fill, ...patch }, 0.01);
  assert.equal(check({}), null);
  assert.equal(check({ stopLoss: 3640.11, takeProfit: null }), null);
  assert.equal(check({ qty: 9.14 }), null);
  assert.equal(check({ stopLoss: null, stopReadUnknown: true }), null);
  assert.equal(check({ stopLoss: null, side: "sell" }), null);
  assert.equal(check({ stopLoss: null, positionId: "foreign" }), null);
  assert.equal(check({ stopLoss: null, strategyId: "FLOW:breakout" }), null);
  assert.equal(check({ stopLoss: null, qty: null }), null);
  assert.equal(check({ stopLoss: null }), "missing_stop");
  assert.equal(check({ stopLoss: 3637.48 }), null);
  assert.equal(check({ stopLoss: 3637.46 }), "weaker_stop");
  assert.equal(check({ qty: 20, stopReadUnknown: true }), "oversize");
  assert.equal(ongoingHazard({ ...position, side: "sell" }, { ...fill, side: "sell", stopLoss: 3637.52 }, 0.01), "weaker_stop");
});

test("a protected 18.28-lot buy requires consistent reads before the worker can claim and dispatch a close", async (t) => {
  process.env.NITROUS_WORKER_AUTOSTART = "0";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://ledger.invalid";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only";
  const { manage } = await import("../nitrous/worker/index");
  const missing = { ...fill, stopLoss: null };
  const oversize = { ...fill, qty: 19 };
  const weak = { ...fill, stopLoss: 3637.45 };
  const steps: string[] = [];
  let memberQueued = false;
  const journals: Record<string, unknown>[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://ledger.invalid");
    const body = JSON.parse(String(init?.body));
    if (url.pathname.endsWith("/nitrous_journal")) {
      journals.push(body);
      return new Response(null, { status: 201 });
    }
    assert.equal(url.pathname, "/rest/v1/nitrous_positions");
    if (body.close_request_state === "dispatching") {
      assert.equal(url.searchParams.get("close_requested_at"), "is.null");
      steps.push("claim");
      return Response.json(memberQueued ? [] : [{ id: "test-position" }]);
    }
    assert.equal(body.close_request_state, "acknowledged");
    steps.push("acknowledged");
    return new Response(null, { status: 204 });
  });

  for (const [first, beforeClaim, last, race, expected] of [
    [missing, fill, fill, false, ["read"]],
    [oversize, oversize, fill, false, ["read", "read"]],
    [weak, weak, { ...missing, stopReadUnknown: true }, false, ["read", "read"]],
    [missing, missing, weak, false, ["read", "read"]],
    [missing, missing, missing, true, ["read", "read", "claim"]],
    [weak, weak, weak, false, ["read", "read", "claim", "close", "acknowledged"]],
    [oversize, oversize, oversize, false, ["read", "read", "claim", "close", "acknowledged"]],
    [missing, missing, missing, false, ["read", "read", "claim", "close", "acknowledged"]],
  ] as const) {
    steps.length = 0;
    journals.length = 0;
    memberQueued = race;
    const reads: BrokerPosition[] = [beforeClaim, last];
    const port = {
      positions: async () => { steps.push("read"); return { ok: true, rows: [reads.shift()] }; },
      close: async (id: string) => { assert.equal(id, fill.positionId); steps.push("close"); return { ok: true }; },
    };
    const ledger = { ...position, id: "test-position", intent_id: "test-intent", account_id: "account",
      protection_state: "protected", close_requested_at: null, status: "open", current_stop: 3637.49,
      current_qty: 18.28, target: 3655.67, entry: 3640.01 };
    await withNitrousDb(() => manage({} as Parameters<typeof manage>[0], [ledger as Parameters<typeof manage>[1][number]],
      [first], port as unknown as Parameters<typeof manage>[3], { tickSize: 0.01 } as Parameters<typeof manage>[4], () => true));
    assert.deepEqual(steps, expected);
    assert.equal(journals.length, 1);
    assert.equal(journals[0].intent_id, "test-intent");
    const evidence = journals[0].evidence as { hazard: string; observations: unknown[] };
    assert.equal(evidence.hazard, ongoingHazard(position, first, 0.01));
    assert.equal(evidence.observations.length, 1 + steps.filter(step => step === "read").length);
  }
});
