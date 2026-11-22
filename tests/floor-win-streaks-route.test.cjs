const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const streaks = require("../src/lib/floor/winStreaks.ts");
const pagination = require("../src/lib/floor/rows.ts");
const accounts = require("../src/lib/floor/overview.ts");
const { effectiveSince } = require("../src/lib/genx/statsSince.ts");

const filename = path.resolve(__dirname, "../src/app/api/floor/win-streaks/route.ts");
const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true }, fileName: filename,
}).outputText;
const SINCE = "2026-10-20T17:15:00Z";
const NOW = Date.parse("2026-11-22T15:00:00Z");
const at = (minute) => new Date(Date.parse("2026-11-01T00:00:00Z") + minute * 60_000).toISOString();
const position = (i, pips = 1, extra = {}) => ({
  id: `row-${i}`, user_id: "member", account_id: "mine", environment: "live", position_id: `position-${i}`,
  status: "closed", outcome: pips < 0 ? "stop" : "target", result_pips: pips, created_at: at(i), resolved_at: at(i + 1), ...extra,
});
const call = (i, pips = 1, extra = {}) => ({
  id: `call-${i}`, dedupe_key: `pd:${i}`, mode: "quick", side: "buy", state: "entered", outcome: pips < 0 ? "loss" : "win",
  result_pips: pips, created_at: at(i), enter_sent_at: at(i), resolved_at: at(i + 1), ...extra,
});

// The actual route runs with a deterministic read-only database mock. Every mutation method and every
// external/broker request is absent, so these tests cannot create a callout, charge, or send an order.
function harness(options = {}) {
  let member = options.member === undefined ? "member" : options.member, clock = NOW, adminCalls = 0;
  const calls = [];
  const tables = {
    flow_broker_connections: [{ id: "connection", user_id: "member", broker: "tradelocker", environment: "live", status: "connected" }],
    flow_broker_accounts: [{ account_id: "mine", user_id: "member", name: "Main", environment: "live", currency: "USD", is_selected: true, connection_id: "connection", created_at: at(-100) }],
    flow_trade_prefs: [{ user_id: "member", stats_since: null }],
    flow_managed_positions: [], genx_alerts: [], ...options.tables,
  };
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [clock])); } static now() { return clock; } }
  const compare = (a, b, column) => {
    if (column.endsWith("_at")) return Date.parse(a) - Date.parse(b);
    return String(a ?? "").localeCompare(String(b ?? ""));
  };
  const admin = { from(table) {
    assert.ok(Object.hasOwn(tables, table), "only the documented read tables are available");
    const record = { table, fields: null, filters: [], orders: [], range: null };
    let signal;
    const run = async (single = false) => {
      calls.push(JSON.parse(JSON.stringify(record)));
      if (options.hangTable === table) return new Promise(() => {});
      if (options.fail?.table === table && (options.fail.from === undefined || record.range?.[0] === options.fail.from)) return { data: null, error: { message: "fixture read failure" } };
      if (signal?.aborted) return { data: null, error: { message: "aborted" } };
      let rows = tables[table].filter((row) => record.filters.every(([op, column, value]) => {
        if (op === "eq") return row[column] === value;
        const result = compare(row[column], value, column);
        return op === "gte" ? result >= 0 : result <= 0;
      }));
      rows = [...rows].sort((a, b) => {
        for (const [column, ascending] of record.orders) { const n = compare(a[column], b[column], column); if (n) return ascending ? n : -n; }
        return 0;
      });
      if (single) return { data: rows[0] ?? null, error: null };
      if (record.range) rows = rows.slice(record.range[0], record.range[1] + 1);
      return { data: rows, error: null };
    };
    const query = {
      select(fields) { record.fields = fields; return query; },
      eq(column, value) { record.filters.push(["eq", column, value]); return query; },
      gte(column, value) { record.filters.push(["gte", column, value]); return query; },
      lte(column, value) { record.filters.push(["lte", column, value]); return query; },
      order(column, { ascending }) { record.orders.push([column, ascending]); return query; },
      abortSignal(value) { signal = value; return query; },
      range(from, to) { record.range = [from, to]; return run(); },
      maybeSingle() { return run(true); },
    };
    return query;
  } };
  const requireHere = (name) => {
    if (name === "@/lib/supabase/server") return { createClient: () => options.configured === false ? null : ({ auth: { getUser: async () => ({ data: { user: member ? { id: member } : null }, error: null }) } }) };
    if (name === "@/lib/supabase/admin") return { createAdminClient: () => { adminCalls++; return admin; } };
    if (name === "@/lib/statsClock") return { statsSince: () => SINCE };
    if (name === "@/lib/genx/statsSince") return { effectiveSince };
    if (name === "@/lib/floor/rows") return pagination;
    if (name === "@/lib/floor/overview") return accounts;
    if (name === "@/lib/floor/winStreaks") return streaks;
    throw new Error("Unexpected dependency: " + name);
  };
  const context = vm.createContext({
    Date: Clock, Response, AbortController, clearTimeout,
    setTimeout: (fn, ms) => setTimeout(fn, options.fastDeadline && ms === 20_000 ? 15 : ms),
  });
  const mod = { exports: {} };
  vm.runInContext("(function(require,module,exports){" + compiled + "\n})", context, { filename })(requireHere, mod, mod.exports);
  return {
    calls, tables, adminCalls: () => adminCalls,
    setMember: (id) => { member = id; }, setClock: (n) => { clock = n; },
    async run(id = "mine", environment = "live") {
      const response = await mod.exports.GET({ headers: new Headers({ "x-floor-account": id, "x-floor-env": environment }) });
      return { status: response.status, headers: response.headers, body: await response.json() };
    },
  };
}

test("streak reads require a verified member before opening any private or community ledger", async () => {
  const h = harness({ member: null });
  assert.equal((await h.run()).status, 401);
  assert.equal(h.adminCalls(), 0);
  assert.equal(h.calls.length, 0);
  const unconfigured = harness({ configured: false });
  assert.equal((await unconfigured.run()).status, 503);
  assert.equal(unconfigured.calls.length, 0);
});

test("FLOW is selected-account execution history and GENX is actual callouts, never the community's repeated fills", async () => {
  const h = harness({ tables: {
    flow_managed_positions: [
      position(1, 10), position(2, -5), position(3, 13, { outcome: "breakeven" }),
      position(4, 1000, { user_id: "someone-else" }), position(5, 2000, { account_id: "another-account" }),
      position(6, 3000, { environment: "demo" }), position(7, 99, { status: "open", resolved_at: null }),
    ],
    genx_alerts: [call(1, 40), call(2, -20), call(3, 15), call(3, 15, { id: "duplicate-call" })],
  } });
  const { status, headers, body } = await h.run();
  assert.equal(status, 200);
  assert.match(headers.get("cache-control"), /private.*no-store/);
  assert.deepEqual(body.account, { id: "mine", environment: "live", name: "Main" });
  assert.equal(body.flow.scope, "account");
  assert.equal(body.flow.currentWins, 1);
  assert.equal(body.flow.currentPips, 13);
  assert.equal(body.genx.scope, "genx_calls");
  assert.equal(body.genx.currentWins, 1);
  assert.equal(body.genx.currentPips, 15);
  assert.doesNotMatch(JSON.stringify(body), /loss|negative|stop/);
  for (const request of h.calls.filter((q) => q.table !== "genx_alerts")) assert.ok(request.filters.some(([op, column, value]) => op === "eq" && column === "user_id" && value === "member"));
  assert.ok(h.calls.find((q) => q.table === "flow_managed_positions").filters.some(([op, column, value]) => op === "eq" && column === "account_id" && value === "mine"));
});

test("a personal reset narrows only FLOW; an arbitrary account header cannot access another member's ledger", async () => {
  const h = harness({ tables: {
    flow_trade_prefs: [{ user_id: "member", stats_since: at(2) }],
    flow_managed_positions: [position(1, 100), position(3, 7)], genx_alerts: [call(1, 20), call(3, 30)],
  } });
  const { body } = await h.run("not-owned", "demo");
  assert.equal(body.account.id, "mine");
  assert.equal(body.flow.since, at(2));
  assert.equal(body.flow.currentWins, 1);
  assert.equal(body.flow.currentPips, 7);
  assert.equal(body.genx.since, SINCE);
  assert.equal(body.genx.currentWins, 2);
  assert.ok(!h.calls.some((q) => q.filters.some(([, column, value]) => column === "account_id" && value === "not-owned")));
});

test("both ledgers are read beyond the database's 1,000-row page before calculating the current run", async () => {
  const h = harness({ tables: {
    flow_managed_positions: Array.from({ length: 1005 }, (_, i) => position(i, i === 1002 ? -1 : 2)),
    genx_alerts: Array.from({ length: 1005 }, (_, i) => call(i, i === 1003 ? -1 : 3)),
  } });
  const { body } = await h.run();
  assert.equal(body.flow.state, "ready");
  assert.equal(body.flow.currentWins, 2);
  assert.equal(body.flow.currentPips, 4);
  assert.equal(body.genx.currentWins, 1);
  assert.equal(body.genx.currentPips, 3);
  for (const table of ["flow_managed_positions", "genx_alerts"]) assert.deepEqual(h.calls.filter((q) => q.table === table).map((q) => q.range), [[0, 999], [1000, 1999]]);
});

test("a failed later page never publishes a partial ledger as an exact count or zero", async () => {
  for (const [table, field] of [["flow_managed_positions", "flow"], ["genx_alerts", "genx"]]) {
    const rows = Array.from({ length: 1005 }, (_, i) => table === "genx_alerts" ? call(i, 5) : position(i, 5));
    const h = harness({ fail: { table, from: 1000 }, tables: { [table]: rows } });
    const { body } = await h.run();
    assert.equal(body[field].state, "unavailable");
    assert.equal(body[field].currentWins, null);
    assert.equal(body[field].currentPips, null);
    assert.equal(body[field].winningPips, null);
  }
});

test("the bounded page cap is incomplete, never a successful 30,000-trade record", async () => {
  const h = harness({ tables: { flow_managed_positions: Array.from({ length: 30_001 }, (_, i) => position(i, 1)) } });
  const { body } = await h.run();
  assert.equal(h.calls.filter((q) => q.table === "flow_managed_positions").length, 30);
  assert.equal(body.flow.state, "unavailable");
  assert.equal(body.flow.currentWins, null);
});

test("failed account or personal-clock reads and absent accounts have distinct unknown states", async () => {
  for (const table of ["flow_broker_accounts", "flow_broker_connections", "flow_trade_prefs"]) {
    const h = harness({ fail: { table } });
    const { body } = await h.run();
    assert.equal(body.flow.state, "unavailable");
    assert.equal(body.flow.currentWins, null);
    assert.equal(body.flow.since, null);
    assert.equal(body.genx.state, "ready", "an independent readable GENX ledger remains usable");
  }
  const noAccounts = harness({ tables: { flow_broker_accounts: [] } });
  const { body } = await noAccounts.run();
  assert.equal(body.account, null);
  assert.equal(body.flow.state, "no_account");
  assert.equal(body.flow.currentPips, null);
});

test("the community cache has its own read time and never caches a member's account results", async () => {
  const h = harness({ tables: {
    flow_broker_connections: [
      { id: "connection", user_id: "member", environment: "live", status: "connected" },
      { id: "other-connection", user_id: "other-member", environment: "live", status: "connected" },
    ],
    flow_broker_accounts: [
      { account_id: "mine", user_id: "member", name: "Mine", environment: "live", connection_id: "connection" },
      { account_id: "theirs", user_id: "other-member", name: "Theirs", environment: "live", connection_id: "other-connection" },
    ],
    flow_managed_positions: [position(1, 5), position(2, 9, { user_id: "other-member", account_id: "theirs" })],
    genx_alerts: [call(1, 22)],
  } });
  const first = (await h.run()).body;
  h.setMember("other-member"); h.setClock(NOW + 5_000);
  const second = (await h.run("theirs")).body;
  assert.equal(first.flow.currentPips, 5);
  assert.equal(second.flow.currentPips, 9);
  assert.equal(second.account.id, "theirs");
  assert.equal(second.genx.asOf, first.genx.asOf);
  assert.notEqual(second.asOf, first.asOf);
  assert.equal(h.calls.filter((q) => q.table === "genx_alerts").length, 1);
  assert.equal(h.calls.filter((q) => q.table === "flow_managed_positions").length, 2);
});

test("a stalled display read reaches its budget and returns unknown without calling a broker or writing data", async () => {
  const h = harness({ hangTable: "flow_managed_positions", fastDeadline: true });
  const begin = Date.now();
  const { body } = await h.run();
  assert.ok(Date.now() - begin < 1000);
  assert.equal(body.flow.state, "unavailable");
  assert.equal(body.flow.currentWins, null);
  assert.equal(body.genx.state, "ready");
});
