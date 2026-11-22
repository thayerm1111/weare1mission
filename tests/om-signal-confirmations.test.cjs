const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const observations = require("../src/lib/plays/timeframeObservations.ts");
const confirmation = require("../src/lib/confirmation.ts");
const mtf = require("../src/lib/mtf.ts");
const assets = require("../src/data/signalAssets.ts");

// Exercise the actual route with isolated auth, credit ledger, market feed and model. No real account,
// provider, credentials or order endpoint is available to this harness.
const filename = path.resolve(__dirname, "../src/app/api/om-signal/route.ts");
const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  fileName: filename,
}).outputText;
const NOW = Date.parse("2026-11-25T14:00:00Z");
const rowsFor = (count = 80, direction = "up") => Array.from({ length: count }, (_, index) => {
  const close = direction === "up" ? 100 + index : 220 - index;
  return { datetime: "bar-" + String(index).padStart(3, "0"), open: String(close - 0.3), high: String(close + 0.8), low: String(close - 0.8), close: String(close) };
});
const copy = (value) => JSON.parse(JSON.stringify(value));

function routeHarness({ diagnostics = "success", forceRelease = false, diagnosticTrend = "up" } = {}) {
  const calls = { series: [], model: [], creditGate: [], charge: [], gate: [], logged: [], phase: [] };
  let observing = false;
  class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [NOW])); } static now() { return NOW; } }
  const requireHere = (name) => {
    if (name === "@/lib/supabase/bearer") return { authedContext: async () => ({ supabase: {}, user: { id: "fixture-member", email: "fixture@example.invalid" }, configured: true }) };
    if (name === "@/lib/credits") return {
      gateCredits: async (...args) => { calls.creditGate.push(copy(args)); return { ok: true, balance: { dailyLeft: 20, purchased: 0, dailyAllowance: 5 } }; },
      chargeCredit: async (...args) => { calls.phase.push("charge"); calls.charge.push(copy(args)); return { dailyLeft: 17, purchased: 0, dailyAllowance: 5 }; },
    };
    if (name === "@/lib/marketData") return {
      isPriorityEmail: () => false,
      series: async (td, interval, size, key, fresh) => {
        calls.series.push({ td, interval, size, fresh, diagnostic: observing });
        if (observing && diagnostics === "limited") return "ratelimit";
        if (observing && diagnostics === "failed") throw new Error("optional feed unavailable");
        return rowsFor(size, observing ? diagnosticTrend : "up");
      },
      livePrice: async () => 179,
      livePriceSane: () => ({ ok: true, reference: 179 }),
    };
    if (name === "@/data/signalAssets") return assets;
    if (name === "@/lib/signalLog") return { logSignal: async (value) => { calls.phase.push("log"); calls.logged.push(copy(value)); } };
    if (name === "@/lib/confirmation") return {
      confirmationSignals: confirmation.confirmationSignals,
      evaluateSetup: (input, profile) => {
        calls.phase.push("gate"); calls.gate.push({ input: copy(input), profile });
        // The real confirmation gate is used for no-trade fixtures. A fixed released result also exercises
        // the route's separate, real 1H/30m/15m alignment gate and the post-decision log/charge path.
        return forceRelease ? { decision: "TRADE", direction: "long", grade: "A", score: 88, rr: 2.5, reasons: ["Fixture released"], profile, momentumRating: "Strong", trendRating: "Strong" } : confirmation.evaluateSetup(input, profile);
      },
    };
    if (name === "@/lib/learningStore") return { getAdjustmentPenalty: async () => ({ penalty: 0, reasons: [] }) };
    if (name === "@/lib/mtf") return mtf;
    if (name === "@/lib/plays/timeframeObservations") return {
      collectTimeframeConfirmations: async (input) => {
        calls.phase.push("diagnostics"); observing = true;
        if (diagnostics === "omitted") return [];
        return observations.collectTimeframeConfirmations({ ...input, now: () => NOW });
      },
    };
    throw new Error("Unexpected dependency: " + name);
  };
  const context = vm.createContext({
    Date: FixedDate, Response, setTimeout, clearTimeout,
    process: { env: { ANTHROPIC_API_KEY: "fixture-ai", TWELVEDATA_API_KEY: "fixture-market-data" } },
    fetch: async (url, init) => {
      assert.equal(url, "https://api.anthropic.com/v1/messages", "the only fetch in this harness is the existing model call");
      calls.phase.push("model"); calls.model.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify({
        direction: "LONG", setup: "Pullback", bias: "Bullish", entry: 178, stopLoss: 174,
        takeProfits: [188, 192, 198], confidence: "High", timeframe: "Intraday",
        rationale: "A test read of the supplied candles.", invalidation: "Below the stop.",
      }) }] }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const mod = { exports: {} };
  vm.runInContext("(function(require,module,exports){" + compiled + "\n})", context, { filename })(requireHere, mod, mod.exports);
  return {
    calls,
    async run(style = "intraday") {
      const response = await mod.exports.POST({ json: async () => ({ td: "BTC/USD", style, orderType: "limit", method: "best", mode: "institutional", confirmations: ["trend", "structure", "fvg", "liquidity", "sr", "fib", "breakRetest", "rsi"] }) });
      assert.equal(response.status, 200);
      return response.json();
    },
  };
}
const withoutDiagnostics = (result) => { const stable = copy(result); delete stable.signal.timeframeConfirmations; return stable; };

test("all five closed-candle observations are additive to the existing scalp read and reuse its feeds", async () => {
  const baseline = routeHarness({ diagnostics: "omitted", forceRelease: true });
  const current = routeHarness({ forceRelease: true });
  const before = await baseline.run("scalp"), after = await current.run("scalp");
  assert.deepEqual(withoutDiagnostics(after), withoutDiagnostics(before));
  assert.deepEqual(current.calls.gate, baseline.calls.gate);
  assert.deepEqual(current.calls.model, baseline.calls.model);
  assert.deepEqual(current.calls.charge, baseline.calls.charge);
  assert.deepEqual(current.calls.logged, baseline.calls.logged);
  assert.equal(current.calls.model.length, 1);
  assert.equal(current.calls.charge.length, 1);
  assert.equal(current.calls.series.filter((call) => call.diagnostic).length, 0);
  assert.deepEqual(after.signal.timeframeConfirmations.map((frame) => frame.tf), ["4H", "1H", "30M", "15M", "5M"]);
  for (const frame of after.signal.timeframeConfirmations) {
    assert.equal(frame.unavailable, false);
    assert.equal(frame.closed, true);
    assert.equal(frame.total, frame.checklist.length);
    assert.equal(frame.confirmed, frame.checklist.filter((factor) => factor.ok).length);
    assert.equal(frame.asOf, frame.tf === "4H" || frame.tf === "1H" ? "bar-058" : "bar-078");
  }
});

test("a conflicting optional 5M observation cannot revoke an intraday setup or modify its gate/model", async () => {
  const baseline = routeHarness({ diagnostics: "omitted", forceRelease: true });
  const current = routeHarness({ forceRelease: true, diagnosticTrend: "down" });
  const before = await baseline.run(), after = await current.run();
  assert.equal(before.signal.status, "setup");
  assert.deepEqual(withoutDiagnostics(after), withoutDiagnostics(before));
  assert.deepEqual(current.calls.gate, baseline.calls.gate);
  assert.deepEqual(current.calls.model, baseline.calls.model);
  assert.deepEqual(current.calls.logged, baseline.calls.logged);
  assert.deepEqual(current.calls.series.filter((call) => call.diagnostic).map((call) => call.interval), ["5min"]);
  const five = after.signal.timeframeConfirmations.find((frame) => frame.tf === "5M");
  assert.equal(five.trend, "bearish");
  assert.equal(five.aligned, false);
  assert.equal(after.signal.status, "setup");
  assert.ok(current.calls.phase.indexOf("diagnostics") > current.calls.phase.indexOf("gate"));
});

test("diagnostic failure preserves real no-trade decisions, levels, credit charge and absent trade logging", async () => {
  for (const style of ["intraday", "swing"]) {
    const baseline = routeHarness({ diagnostics: "omitted" });
    const before = await baseline.run(style);
    assert.equal(before.signal.status, "no_trade");
    for (const diagnostics of ["limited", "failed"]) {
      const current = routeHarness({ diagnostics });
      const after = await current.run(style);
      assert.deepEqual(withoutDiagnostics(after), withoutDiagnostics(before));
      assert.deepEqual(current.calls.gate, baseline.calls.gate);
      assert.deepEqual(current.calls.model, baseline.calls.model);
      assert.deepEqual(current.calls.creditGate, baseline.calls.creditGate);
      assert.deepEqual(current.calls.charge, baseline.calls.charge);
      assert.equal(current.calls.logged.length, 0);
      assert.equal(current.calls.model.length, 1);
      assert.equal(current.calls.charge.length, 1);
      const missing = after.signal.timeframeConfirmations.filter((frame) => frame.unavailable);
      assert.equal(missing.length, style === "swing" ? 5 : 3);
      for (const frame of missing) {
        assert.equal(frame.trend, null);
        assert.equal(frame.aligned, null);
        assert.equal(frame.confirmed, null);
        assert.equal(frame.total, null);
        assert.deepEqual(frame.checklist, []);
        assert.equal(frame.reason, diagnostics === "limited" ? "rate_limited" : "unavailable");
      }
    }
  }
});

test("short, malformed and expired-budget feeds remain unavailable instead of false confirmations", async () => {
  let loads = 0, evaluations = 0;
  const existing = new Map([
    ["4h", rowsFor(50)], // only 49 definitely closed bars
    ["1h", rowsFor(60).map((row, index) => index < 11 ? { ...row, close: "invalid" } : row)],
    ["30min", "ratelimit"],
  ]);
  const result = await observations.collectTimeframeConfirmations({
    existing, direction: "LONG", deadlineMs: NOW, now: () => NOW,
    load: async () => { loads++; return rowsFor(); },
    evaluate: () => { evaluations++; return { tfTrend: "bullish", checklist: [{ label: "Should not run", ok: true }] }; },
  });
  assert.equal(loads, 0);
  assert.equal(evaluations, 0);
  assert.deepEqual(result.map((frame) => frame.reason), ["insufficient_data", "insufficient_data", "rate_limited", "unavailable", "unavailable"]);
  assert.ok(result.every((frame) => frame.unavailable && frame.confirmed === null && frame.total === null));
});

test("optional feeds start concurrently and share a short deadline without blocking on a hung provider", async () => {
  let started = 0;
  const begin = Date.now();
  const result = await observations.collectTimeframeConfirmations({
    existing: new Map(), direction: "SHORT", deadlineMs: begin + 25,
    load: () => { started++; return new Promise(() => {}); },
    evaluate: () => { throw new Error("Unavailable data must not be evaluated"); },
  });
  assert.equal(started, 5);
  assert.ok(Date.now() - begin < 500, "one shared short deadline, not five serial waits");
  assert.ok(result.every((frame) => frame.unavailable && frame.reason === "unavailable"));
});
