const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const { MODES } = require("../src/lib/genxCompute.ts");
const { pairOf } = require("../src/lib/genfx/pairs.ts");

const NOW = Date.parse("2026-11-25T16:00:00Z");
const copy = (value) => JSON.parse(JSON.stringify(value));
const candles = () => Array.from({ length: 520 }, (_, i) => ({
  t: new Date(NOW - (520 - i) * 300000).toISOString(),
  o: 1.1 + i / 100000, h: 1.102 + i / 100000, l: 1.099 + i / 100000, c: 1.101 + i / 100000,
}));

function routeModule(file, deps) {
  const compiled = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true }, fileName: file,
  }).outputText;
  const module = { exports: {} };
  const context = vm.createContext({ Response, Request, URL, JSON, Date, console,
    process: { env: { TWELVEDATA_API_KEY: "test-fixture-only" } },
    fetch: () => { throw new Error("A saved chart test cannot contact a market-data or AI provider"); },
  });
  vm.runInContext(`(function(require,module,exports){${compiled}\n})`, context, { filename: file })((name) => {
    if (!(name in deps)) throw new Error("Unexpected route dependency: " + name);
    return deps[name];
  }, module, module.exports);
  return module.exports;
}

function harness(options = {}) {
  const user = options.anonymous ? null : { id: "member-a", email: "member@example.test" };
  const rows = copy(options.rows ?? []), queries = [], calls = [];
  const originalCandles = candles();
  const engine = { ok: true, read: { state: "WAIT", reason: "Wait for a retest", headline: "Buy watch" },
    price: 1.105, session: "London", dataStatus: "live", nowIso: new Date(NOW).toISOString(),
    candles: originalCandles, volatility: "Normal", atr: .001 };
  const plan = { action: "WAIT", directional_bias: "bullish", entry: 1.104, stop_loss: 1.102, tp1: 1.108, lifecycle: "watch", market_story: ["Saved engine read"] };
  const admin = { from(table) {
    assert.equal(table, "genfx_signals");
    const query = { filters: [], inserted: null, limit: Infinity }; queries.push(query);
    const matches = () => rows.filter((row) => query.filters.every(([key, value]) => row[key] === value));
    const chain = {
      select() { return chain; }, eq(key, value) { query.filters.push([key, value]); return chain; },
      order() { return chain; }, limit(value) { query.limit = value; return chain; },
      insert(value) { query.inserted = copy(value); return chain; },
      async single() { assert.ok(query.inserted); const saved = { ...query.inserted, id: "saved-" + rows.length, created_at: new Date(NOW).toISOString() }; rows.push(saved); calls.push("insert"); return { data: { id: saved.id }, error: null }; },
      async maybeSingle() { return { data: copy(matches()[0] ?? null) }; },
      then(resolve) { return Promise.resolve({ data: copy(matches().slice(0, query.limit)) }).then(resolve); },
    };
    return chain;
  } };
  const deps = {
    "@/lib/supabase/server": { createClient: () => ({ auth: { getUser: async () => ({ data: { user } }) } }) },
    "@/lib/supabase/admin": { createAdminClient: () => admin },
    "@/lib/credits": {
      gateCredits: async () => { calls.push("gate"); return options.insufficient ? { ok: false, reason: "insufficient", balance: 0 } : { ok: true }; },
      chargeCredit: async () => { calls.push("charge"); },
    },
    "@/lib/readCharge": { chargedRead: () => true },
    "@/lib/creditConfig": { CREDIT_COST: { genx: 5 } },
    "@/lib/marketData": { isPriorityEmail: () => false },
    "@/lib/genxCompute": { MODES },
    "@/lib/genfx/pairs": { pairOf },
    "@/lib/genfx/compute": {
      computeGenfxRead: async (input) => { calls.push("compute:" + input.mode); return engine; },
      genfxOf: () => plan, stopRoom: () => ({ min: 5, pips: 20, ok: true }),
    },
    "@/lib/genfx/control": { readControl: async () => ({ billing: !!options.billing, config: { freeStoriesPerDay: 10 } }), minStopPips: () => 5 },
  };
  const generation = routeModule("src/app/api/genfx/route.ts", deps);
  const history = routeModule("src/app/api/genfx/history/route.ts", deps);
  return { rows, queries, calls, engine, originalCandles,
    generate: (mode = "quick") => generation.POST(new Request("https://local.test/api/genfx", { method: "POST", body: JSON.stringify({ pair: "EURUSD", mode }) })),
    history: (id) => history.GET(new Request("https://local.test/api/genfx/history" + (id ? "?id=" + encodeURIComponent(id) : ""))),
  };
}

test("new FX reads reopen with the exact bounded generation candles and native timeframe for every holding mode", async () => {
  for (const mode of ["quick", "intraday", "swing"]) {
    const h = harness(), expected = copy(h.originalCandles.slice(-500));
    const response = await h.generate(mode), generated = await response.json();
    assert.equal(response.status, 200); assert.equal(generated.ok, true);
    assert.deepEqual(generated.candles, expected);
    assert.equal(generated.candles_tf, MODES[mode].tf.m15);
    assert.deepEqual(h.rows[0].market_snapshot.candles, generated.candles);
    assert.equal(h.rows[0].market_snapshot.candles_tf, generated.candles_tf);
    assert.equal(h.rows[0].user_id, "member-a");
    assert.equal(h.originalCandles.length, 520, "Bounding the display must not mutate the engine input");
    h.engine.price = 9; h.engine.candles = [];
    const saved = await (await h.history(generated.signal_id)).json();
    assert.deepEqual(saved.play.candles, generated.candles);
    assert.equal(saved.play.candles_tf, generated.candles_tf);
    assert.equal(saved.play.price, generated.price); assert.equal(saved.play.asOf, generated.asOf);
    assert.deepEqual(saved.play.genfx, generated.genfx);
    assert.equal(h.calls.filter((call) => call.startsWith("compute:")).length, 1, "Opening history cannot fetch or regenerate current candles");
    assert.deepEqual(h.queries.at(-1).filters, [["user_id", "member-a"], ["id", generated.signal_id]]);
  }
});

test("older FX rows without original candles return an empty chart without borrowing another read", async () => {
  for (const snapshot of [undefined, { price: 1.1, candles_tf: "5min" }, { candles: "invalid", candles_tf: 15 }]) {
    const h = harness({ rows: [{ id: "legacy", user_id: "member-a", created_at: "2026-10-01T12:00:00Z", pair: "EURUSD", mode: "quick", reasoning: { entry: 1.1 }, market_snapshot: snapshot }] });
    const response = await h.history("legacy"), body = await response.json();
    assert.equal(response.status, 200); assert.deepEqual(body.play.candles, []);
    assert.equal(body.play.candles_tf, typeof snapshot?.candles_tf === "string" ? snapshot.candles_tf : null);
    assert.equal(body.play.asOf, "2026-10-01T12:00:00Z");
    assert.deepEqual(h.calls, []);
  }
});

test("saved chart detail and list enforce member ownership and unauthenticated requests stop before database or engine work", async () => {
  const h = harness({ rows: [
    { id: "mine", user_id: "member-a", created_at: new Date(NOW).toISOString(), market_snapshot: { candles: [] } },
    { id: "foreign", user_id: "member-b", created_at: new Date(NOW).toISOString(), market_snapshot: { candles: [{ c: 999 }] } },
  ] });
  const forbidden = await h.history("foreign");
  assert.equal(forbidden.status, 404); assert.deepEqual(await forbidden.json(), { error: "not_found" });
  const list = await (await h.history()).json(); assert.deepEqual(list.plays.map((row) => row.id), ["mine"]);
  assert.ok(h.queries.every((query) => query.filters.some(([key, value]) => key === "user_id" && value === "member-a")));
  const anonymous = harness({ anonymous: true, billing: true });
  assert.equal((await anonymous.history("foreign")).status, 401);
  assert.equal((await anonymous.generate()).status, 401);
  assert.deepEqual(anonymous.queries, []); assert.deepEqual(anonymous.calls, []);
});

test("saving chart evidence preserves the existing billing gate and one successful-read charge", async () => {
  const blocked = harness({ billing: true, insufficient: true });
  assert.equal((await blocked.generate()).status, 402);
  assert.deepEqual(blocked.calls, ["gate"]); assert.equal(blocked.rows.length, 0);
  const billed = harness({ billing: true });
  assert.equal((await billed.generate()).status, 200);
  assert.deepEqual(billed.calls, ["gate", "compute:quick", "charge", "insert"]);
  const before = [...billed.calls];
  await billed.history(billed.rows[0].id);
  assert.deepEqual(billed.calls, before, "History is not another billable generation");
});
