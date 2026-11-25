import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { normalizePos, pickOrphanMatch, type PosCols } from "../src/lib/flow/recover";
import { parsePositions, positionColumns, DEFAULT_POSITION_COLUMNS } from "../command-center/adapters/tradelocker";

const NITROUS_TAG = "NITROUS:synthetic-owned-position";
const EXECUTION = "11111111-2222-4333-8444-555555555555";
const ATLAS_TAG = `cc-${EXECUTION.replace(/-/g, "").slice(0, 26)}`;
const flowCols: PosCols = { instrIdx: 1, sideIdx: 3, qtyIdx: 4, avgIdx: 5, slIdx: -1, tpIdx: -1, strategyIdx: 6 };
const objectPosition = (id: string, strategyId: string | null) => ({
  id, tradableInstrumentId: "gold", side: "buy", qty: 0.05,
  avgPrice: 4200, stopLoss: 4195, takeProfit: 4210, strategyId,
});
const want = { instrId: "gold", side: "buy" as const, qty: 0.05, stop: 4195 };

test("FLOW orphan recovery excludes a matching Nitrous position in both broker row formats", () => {
  for (const raw of [objectPosition("nitro", NITROUS_TAG), ["nitro", "gold", "route", "buy", 0.05, 4200, NITROUS_TAG]]) {
    const nitro = normalizePos(raw, flowCols);
    assert.equal(nitro.strategyId, NITROUS_TAG);
    assert.equal(pickOrphanMatch([nitro], want, new Set()), null);
    const flow = normalizePos(objectPosition("flow", null), flowCols);
    assert.equal(pickOrphanMatch([nitro, flow], want, new Set())?.positionId, "flow");
  }
});

test("a missing column config cannot strip a visible Nitrous label into FLOW's untagged fallback", () => {
  const row = ["nitro", "gold", "route", "buy", 0.05, 4200, "unrelated", NITROUS_TAG];
  const nitro = normalizePos(row, { ...flowCols, strategyIdx: -1 });
  assert.equal(nitro.strategyId, NITROUS_TAG);
  assert.equal(pickOrphanMatch([nitro], want, new Set()), null);
});

test("Atlas preserves row-level strategy labels from configured columns and object rows", () => {
  const columns = ["id", "side", "strategyId", "tradableInstrumentId", "qty", "avgPrice"];
  const config = { d: { positionsConfig: { columns: columns.map((id) => ({ id })) } } };
  const parsed = parsePositions({ d: { positions: [
    ["nitro", "buy", NITROUS_TAG, "gold", 0.05, 4200],
    ["atlas", "buy", ATLAS_TAG, "gold", 0.05, 4200],
  ] } }, positionColumns(config));
  assert.deepEqual(parsed.map((p) => [p.id, p.strategyId]), [["nitro", NITROUS_TAG], ["atlas", ATLAS_TAG]]);
  assert.equal(parsePositions({ d: { positions: [objectPosition("nitro", NITROUS_TAG)] } })[0].strategyId, NITROUS_TAG);
});

function atlasFixture(positions: unknown[], configAvailable = true) {
  const savedPositions: Array<Record<string, unknown>> = [];
  const executionUpdates: Array<Record<string, unknown>> = [];
  const execution = { id: EXECUTION, intent_id: "intent", account_row_id: "account-row", qty: 0.05,
    broker_order_id: null, reconcile_count: 0, state: "reconciliation_required" };
  const db = {
    from(table: string) {
      let mutation = false;
      const result = () => ({ data: table === "cc_positions" && !mutation ? [] : null, error: null });
      return {
        select() { return this; }, eq() { return this; }, is() { return this; },
        update(value: Record<string, unknown>) { mutation = true; if (table === "cc_trade_executions") executionUpdates.push(value); return this; },
        upsert(value: Record<string, unknown>) {
          assert.equal(table, "cc_positions"); mutation = true; savedPositions.push(value); return this;
        },
        insert() { mutation = true; return this; },
        async maybeSingle() {
          if (table === "cc_trade_executions") return { data: execution, error: null };
          assert.equal(table, "cc_trade_intents");
          return { data: { side: "buy", style: "hold", stop: 4195, targets: [4210], thesis: null, risk_pct: 1 }, error: null };
        },
        async single() { return { data: { id: "owned-ledger-row" }, error: null }; },
        then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
          return Promise.resolve(result()).then(resolve, reject);
        },
      };
    },
  };
  const noTrade = () => { throw new Error("A reconciliation test must never submit, modify or close a broker position"); };
  const dependencies: Record<string, unknown> = {
    "node:crypto": {},
    "../adapters/db": { db: () => db, audit: async () => undefined },
    "../adapters/tradelocker": {
      parsePositions, positionColumns, DEFAULT_POSITION_COLUMNS,
      listPositions: async () => ({ ok: true, data: { d: { positions } } }),
      getConfig: async () => configAvailable ? { ok: true, data: { d: { positionsConfig: { columns:
        ["id", "tradableInstrumentId", "routeId", "side", "qty", "avgPrice", "strategyId"].map((id) => ({ id })),
      } } } } : { ok: false },
      createOrder: noTrade, closePosition: noTrade, modifyPosition: noTrade, ordersHistory: noTrade,
    },
    "../core/risk": {}, "../core/hedge": {}, "./profile": {}, "../core/instrument": {},
    "../core/style": { STYLE_MODE: { hold: "position" } },
    "./accountHistory": {}, "./validator": {},
    "./broker": {
      session: async () => ({ ok: true, session: { auth: {}, account: {
        id: "account-row", account_id: "broker-account", connection_id: "connection", route_id: "route",
      } } }),
      goldInstrument: async () => ({ ok: true, spec: { tradableInstrumentId: "gold" },
        resolved: { pipSize: 0.1, instrument: { pipValuePerLot: 10 } } }),
    },
  };
  const source = ts.transpileModule(readFileSync("command-center/engines/executor.ts", "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} as { reconcile: (user: string, id: string, tag?: string) => Promise<{ state: string }> } };
  vm.runInNewContext(`(function(require,module,exports){${source}\n})`, {
    setTimeout: (callback: () => void) => { callback(); return 0; },
  })((name: string) => {
    if (!(name in dependencies)) throw new Error(`Unexpected dependency ${name}`);
    return dependencies[name];
  }, module, module.exports);
  return { run: (tag?: string) => module.exports.reconcile("user", EXECUTION, tag), savedPositions, executionUpdates };
}

test("actual Atlas reconciliation selects its tagged row, not the first gold row in the payload", async () => {
  const f = atlasFixture([objectPosition("flow", "FLOW:another-trade"), objectPosition("nitro", NITROUS_TAG), objectPosition("atlas", ATLAS_TAG)]);
  assert.equal((await f.run(ATLAS_TAG)).state, "position_open");
  assert.deepEqual(f.savedPositions.map((p) => p.broker_position_id), ["atlas"]);
});

test("the Atlas background sweep reconstructs its own tag before considering an untagged shape match", async () => {
  const f = atlasFixture([objectPosition("manual", null), objectPosition("atlas", ATLAS_TAG)]);
  assert.equal((await f.run()).state, "position_open");
  assert.deepEqual(f.savedPositions.map((p) => p.broker_position_id), ["atlas"]);
});

test("actual Atlas reconciliation never adopts a same-size Nitrous fill, including without column config", async () => {
  for (const positions of [[objectPosition("nitro", NITROUS_TAG)], [["nitro", "gold", "route", "buy", 0.05, 4200, "unknown-column", NITROUS_TAG]]]) {
    const f = atlasFixture(positions, false);
    assert.equal((await f.run()).state, "reconciliation_required");
    assert.deepEqual(f.savedPositions, []);
    assert.equal(f.executionUpdates.at(-1)?.state, "reconciliation_required");
  }
});

test("Atlas retains the existing untagged legacy fill fallback", async () => {
  const f = atlasFixture([objectPosition("legacy", null)]);
  assert.equal((await f.run()).state, "position_open");
  assert.deepEqual(f.savedPositions.map((p) => p.broker_position_id), ["legacy"]);
});
