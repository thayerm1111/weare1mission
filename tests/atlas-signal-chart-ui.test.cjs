const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const ROOT = path.resolve(__dirname, "..");
const nodes = (tree, predicate) => Array.isArray(tree) ? tree.flatMap((item) => nodes(item, predicate))
  : !tree || typeof tree !== "object" ? [] : [...(predicate(tree) ? [tree] : []), ...nodes(tree.props?.children, predicate)];
const content = (tree) => Array.isArray(tree) ? tree.map(content).join("") : tree == null || typeof tree === "boolean" ? ""
  : typeof tree === "object" ? content(tree.props?.children) : String(tree);

function harness(signal) {
  const slots = [], requests = [], cache = new Map();
  let cursor = 0, tree;
  const react = {
    useState(value) { const i = cursor++; if (!(i in slots)) slots[i] = value; return [slots[i], (next) => { slots[i] = typeof next === "function" ? next(slots[i]) : next; }]; },
    useMemo(factory) { cursor++; return factory(); },
    useId() { const i = cursor++; return slots[i] ??= `atlas-chart-${i}`; },
  };
  const jsx = (type, props) => typeof type === "function" ? type(props || {}) : { type, props: props || {} };
  const context = vm.createContext({
    fetch: (url) => { requests.push(url); throw new Error("Rendering a retained signal chart must not fetch: " + url); },
  });
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename).exports;
    const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true }, fileName: filename,
    }).outputText;
    const mod = { exports: {} }; cache.set(filename, mod);
    const requireHere = (name) => {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "Fragment" };
      if (name === "next/dynamic") return { __esModule: true, default: () => "ExecuteSignal" };
      if (name === "lucide-react") return new Proxy({}, { get: (_, key) => `icon:${String(key)}` });
      if (name.endsWith(".css")) return {};
      if (name === "@/components/om/ProductIcon") return { ProductIcon: "ProductIcon" };
      if (name === "@/components/om/chart/SignalFocusChart") return { SignalFocusChart: "SignalFocusChart" };
      const base = name.startsWith("@/") ? path.join(ROOT, "src", name.slice(2)) : name.startsWith(".") ? path.resolve(path.dirname(filename), name) : null;
      if (base) {
        const resolved = [base, `${base}.ts`, `${base}.tsx`].find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
        if (resolved) return load(resolved);
      }
      throw new Error("Unexpected chart dependency: " + name);
    };
    vm.runInContext(`(function(require,module,exports){${code}\n})`, context, { filename })(requireHere, mod, mod.exports);
    return mod.exports;
  }
  const { AtlasSignalCard } = load(path.join(ROOT, "src/components/om/atlas/AtlasSignalCard.tsx"));
  const render = (next) => { if (next) signal = next; cursor = 0; tree = AtlasSignalCard({ signal }); return tree; };
  render();
  return { render, requests, text: () => content(tree), find: (predicate) => nodes(tree, predicate) };
}

const fixture = (status = "setup", candles = [
  { t: "2026-11-20 10:00:00", o: 3500, h: 3504, l: 3498, c: 3502 },
  { t: "2026-11-20 11:00:00", o: 3502, h: 3508, l: 3501, c: 3506 },
]) => ({ kind: "plays", saved: "synced", result: {
  id: 1_800_000_000_000, symbol: "XAU/USD", name: "Gold", market: "Metals", td: "XAU/USD", interval: "1h",
  orderType: "limit", price: 3506, asOf: "2026-11-20 11:00:00", as_of: "2026-11-20T11:15:00Z", status: "open", candles,
  signal: { direction: "LONG", status, entry: 3503, stopLoss: 3480, takeProfits: [3520, 3530, 3540],
    confidence: "High", riskReward: "1:2", timeframe: "Intraday", rationale: "Saved setup", invalidation: "Below the stop" },
} });

const genxFixture = (action = "WAIT_FOR_SELL_TRIGGER", extra = {}) => ({ kind: "genx", saved: "synced", result: {
  ok: true, signal_id: "saved-genx-1", symbol: "XAU/USD", mode: "quick", price: 3506,
  asOf: "2026-11-20T11:15:00Z", data_status: "reference",
  candles: [
    { t: "2026-11-20 11:05:00", o: 3500, h: 3504, l: 3498, c: 3502 },
    { t: "2026-11-20 11:10:00", o: 3502, h: 3508, l: 3501, c: 3506 },
  ],
  genx: {
    action, mode: "quick", directional_bias: "bearish", confidence_score: 68,
    entry: 3506, entry_low: 3505, entry_high: 3507, stop_loss: 3512, tp1: 3498, tp2: 3493, tp3: 3485,
    market_story: ["Gold is testing resistance."], trigger_condition: "Wait for a closed rejection candle.",
    invalidation_reason: "A close above resistance.", trade_reasoning: ["A lower high is forming."], risk_factors: [],
  },
  ...extra,
} });

test("Atlas automatically renders its real snapshot chart while keeping the five-frame breakdown and manual ticket", () => {
  const signal = fixture(), h = harness(signal);
  const charts = h.find((node) => node.type === "SignalFocusChart");
  assert.equal(charts.length, 1);
  assert.equal(charts[0].props.bars.length, 2);
  assert.equal(charts[0].props.priceLive, false);
  assert.equal(charts[0].props.snapshot, true);
  assert.equal(charts[0].props.fitLevels, true);
  assert.equal(charts[0].props.direction, "buy");
  assert.equal(charts[0].props.reference, false);
  assert.equal(charts[0].props.tfLabel, "1H");
  assert.equal(charts[0].props.timeKnown, false);
  assert.equal(charts[0].props.levels.length, 5);
  assert.match(h.text(), /Chart at generation/);
  assert.match(h.text(), /Saved snapshot/);
  assert.equal(h.find((node) => node.props.className === "om-play-frame").length, 5);
  assert.equal(h.find((node) => node.type === "ExecuteSignal").length, 0, "chart display never opens the trading ticket");
  h.find((node) => node.type === "details" && node.props.className === "om-atlas-signal-order")[0].props.onToggle({ currentTarget: { open: true } });
  h.render();
  const ticket = h.find((node) => node.type === "ExecuteSignal")[0];
  assert.equal(ticket.props.entry, signal.result.signal.entry);
  assert.equal(ticket.props.stop, signal.result.signal.stopLoss);
  assert.equal(ticket.props.tp, signal.result.signal.takeProfits[0]);
  assert.equal(ticket.props.unconfirmed, false);
  assert.equal(h.requests.length, 0);
});

test("an unconfirmed retained play stays an idea with reference chart labels and its original override ticket", () => {
  const h = harness(JSON.parse(JSON.stringify(fixture("no_trade"))));
  assert.match(h.text(), /Buy idea, not confirmed/);
  assert.match(h.text(), /Reference levels · confirmation is still needed\./);
  assert.match(h.text(), /Execute BUY · manual override/);
  assert.ok(h.find((node) => node.type === "SignalFocusChart")[0].props.levels.every((level) => level.label.startsWith("Reference ")));
  h.find((node) => node.type === "details" && node.props.className === "om-atlas-signal-order")[0].props.onToggle({ currentTarget: { open: true } });
  h.render();
  assert.equal(h.find((node) => node.type === "ExecuteSignal")[0].props.unconfirmed, true);
  assert.equal(h.requests.length, 0);
});

test("a legacy play without candles explains the missing snapshot without fetching or inventing a chart", () => {
  const h = harness(fixture("setup", []));
  assert.equal(h.find((node) => node.type === "SignalFocusChart").length, 0);
  assert.match(h.text(), /Candle chart unavailable for this saved read\./);
  assert.match(h.text(), /Execute BUY/);
  assert.equal(h.requests.length, 0);
});

test("one genuine saved candle remains visible for both Atlas signal engines without a false history invitation", () => {
  for (const signal of [fixture(), genxFixture()]) {
    signal.result.candles = signal.result.candles.slice(0, 1);
    const h = harness(signal);
    const chart = h.find((node) => node.type === "SignalFocusChart")[0];
    assert.ok(chart);
    assert.equal(chart.props.bars.length, 1);
    assert.equal(chart.props.bars[0].c, signal.result.candles[0].c);
    assert.doesNotMatch(h.text(), /Full chart to inspect all saved candles/);
    assert.equal(h.requests.length, 0);
  }
});

test("a waiting GENX sell trigger automatically shows saved candles and its exact reference zone before the manual ticket", () => {
  const signal = genxFixture(), h = harness(JSON.parse(JSON.stringify(signal)));
  const chart = h.find((node) => node.type === "SignalFocusChart")[0];
  assert.ok(chart, "a waiting signal still has its chart without an extra click");
  assert.equal(chart.props.bars.length, 2);
  assert.equal(chart.props.bars[1].c, signal.result.candles[1].c);
  assert.equal(chart.props.tfLabel, "5M");
  assert.equal(chart.props.timeKnown, false);
  assert.equal(chart.props.priceLive, false);
  assert.equal(chart.props.snapshot, true);
  assert.equal(chart.props.direction, "sell");
  assert.equal(chart.props.reference, true);
  assert.equal(chart.props.zone.low, signal.result.genx.entry_low);
  assert.equal(chart.props.zone.high, signal.result.genx.entry_high);
  assert.deepEqual(Array.from(chart.props.levels, (level) => level.price), [3506, 3512, 3498, 3493, 3485]);
  assert.ok(chart.props.levels.every((level) => level.label.startsWith("Reference ")));
  assert.match(chart.props.label, /unconfirmed reference levels/);
  assert.match(h.text(), /Waiting for a sell trigger/);
  assert.match(h.text(), /Reference levels · confirmation is still needed\./);
  const order = h.find((node) => node.type === "SignalFocusChart" || node.props["aria-label"] === "Signal price and levels" || node.props.className === "om-atlas-signal-order");
  assert.equal(order[0].props["aria-label"], "Signal price and levels", "saved price and trade levels precede the chart");
  assert.equal(order[1].type, "SignalFocusChart");
  assert.equal(h.find((node) => node.type === "ExecuteSignal").length, 0);
  h.find((node) => node.props.className === "om-atlas-signal-order")[0].props.onToggle({ currentTarget: { open: true } });
  h.render();
  const ticket = h.find((node) => node.type === "ExecuteSignal")[0];
  assert.equal(ticket.props.direction, "SHORT");
  assert.equal(ticket.props.entry, signal.result.genx.entry);
  assert.equal(ticket.props.stop, signal.result.genx.stop_loss);
  assert.equal(ticket.props.tp, signal.result.genx.tp1);
  assert.equal(ticket.props.unconfirmed, true, "showing a chart cannot confirm the waiting setup");
  assert.match(h.text(), /current price after your confirmation/);
  assert.equal(h.requests.length, 0);
});

test("a long saved GENX story stays complete below the chart with no explanation ahead of its prices", () => {
  const signal = genxFixture();
  const story = [
    "Gold is testing resistance while the preceding candles show a pullback, a lower high, and another approach to the same watched zone. The engine is waiting for the next confirmed reaction before treating the idea as ready.",
    "The original saved second paragraph remains available to explain the broader context and its conditions.",
    "The final saved paragraph describes what could invalidate this view.",
  ];
  signal.result.genx.market_story = story;
  const h = harness(signal);
  const decision = h.find((node) => node.props.className === "om-atlas-signal-decision")[0];
  assert.equal(nodes(decision, (node) => node.type === "p").length, 0, "only title/status stays above the prices");
  const explanation = h.find((node) => node.props.className === "om-atlas-signal-reason")[0];
  const opening = nodes(explanation, (node) => node.type === "p").at(-1);
  assert.ok(content(opening).length <= 181);
  assert.match(content(opening), /…$/);
  assert.ok(!content(decision).includes(story[1]), "long context does not precede the chart");
  const full = h.find((node) => node.type === "details" && node.props.className?.includes("om-atlas-signal-story"))[0];
  assert.ok(full);
  assert.notEqual(full.props.open, true, "native details starts collapsed");
  assert.deepEqual(nodes(full, (node) => node.type === "p").map(content), story);
  const order = h.find((node) => node.type === "SignalFocusChart" || node === explanation || node === full);
  assert.equal(order[0].type, "SignalFocusChart");
  assert.match(h.text(), /Wait for a closed rejection candle\./);
  assert.match(h.text(), /A close above resistance\./);
  assert.equal(h.requests.length, 0);
});

test("ready GENX results keep their chart, saved timeframe and normal ticket eligibility", () => {
  const signal = genxFixture("SELL_NOW", { mode: "intraday" }), h = harness(signal);
  const chart = h.find((node) => node.type === "SignalFocusChart")[0];
  assert.equal(chart.props.tfLabel, "15M");
  assert.ok(chart.props.levels.every((level) => !level.label.startsWith("Reference ")));
  assert.match(h.text(), /Entry zone, stop and targets from this read\./);
  assert.match(h.text(), /Sell now/);
  assert.doesNotMatch(h.text(), /manual override/);
  h.find((node) => node.props.className === "om-atlas-signal-order")[0].props.onToggle({ currentTarget: { open: true } });
  h.render();
  assert.equal(h.find((node) => node.type === "ExecuteSignal")[0].props.unconfirmed, false);
  assert.equal(h.requests.length, 0);
});

test("GENX no-trade candles stay visible and older missing snapshots show an honest unavailable state", () => {
  const signal = genxFixture("HOLD");
  Object.assign(signal.result.genx, { closest_support: 3490, closest_resistance: 3520 });
  const h = harness(signal);
  const chart = h.find((node) => node.type === "SignalFocusChart")[0];
  assert.equal(chart.props.bars.length, 2);
  assert.deepEqual(Array.from(chart.props.levels, (level) => level.kind), ["support", "resistance"]);
  assert.equal(chart.props.zone, null);
  assert.equal(chart.props.direction, "neutral");
  assert.match(h.text(), /Support and resistance from this read\./);
  assert.match(h.text(), /No trade — waiting/);
  assert.deepEqual(h.find((node) => node.props["data-level"]).map((node) => node.props["data-level"]), ["price", "support", "resistance"], "dormant entry/stop/target values never become a plan on a HOLD read");
  assert.equal(h.find((node) => node.props.className === "om-atlas-signal-order").length, 0);
  for (const candles of [undefined, [], [{ t: "bad date", o: 1, h: 2, l: 0, c: 1 }]]) {
    const missing = harness(genxFixture("WAIT_FOR_SELL_TRIGGER", { candles }));
    assert.equal(missing.find((node) => node.type === "SignalFocusChart").length, 0);
    assert.match(missing.text(), /Candle chart unavailable for this saved read\./);
    assert.match(missing.text(), /Waiting for a sell trigger/);
    assert.match(missing.text(), /Execute SELL · manual override/);
    assert.equal(missing.requests.length, 0);
  }
  assert.equal(h.requests.length, 0);
});

test("both signal types place the saved price and levels above the focused chart, and all reasoning below it", () => {
  for (const signal of [fixture(), genxFixture()]) {
    signal.result.live_price = 9999;
    const h = harness(signal);
    const price = h.find((node) => node.props["data-level"] === "price")[0];
    assert.equal(content(price), "Price at signal3,506.00");
    const chart = h.find((node) => node.type === "SignalFocusChart")[0];
    assert.equal(chart.props.price, signal.result.price, "a saved signal price never becomes a later quote");
    const ordered = h.find((node) => node.props["aria-label"] === "Signal price and levels"
      || node.type === "SignalFocusChart" || node.props.className === "om-atlas-signal-reason");
    assert.equal(ordered[0].props["aria-label"], "Signal price and levels");
    assert.equal(ordered[1].type, "SignalFocusChart");
    assert.equal(ordered[2].props.className, "om-atlas-signal-reason");
    assert.match(h.text(), /Full chart to inspect all saved candles/);
    assert.equal(h.find((node) => node.type === "ExecuteSignal").length, 0);
    assert.equal(h.requests.length, 0);
  }
});

test("replacing a displayed play with a retained GENX result cannot reuse the previous chart's candles or view identity", () => {
  const h = harness(fixture()), old = h.find((node) => node.type === "SignalFocusChart")[0].props;
  const signal = genxFixture("BUY_LIMIT", { signal_id: "other-genx", mode: "swing", price: 3601, candles: [
    { t: "2026-11-21 10:00:00", o: 3598, h: 3602, l: 3595, c: 3600 },
    { t: "2026-11-21 11:00:00", o: 3600, h: 3604, l: 3598, c: 3601 },
  ] });
  h.render(JSON.parse(JSON.stringify(signal)));
  const chart = h.find((node) => node.type === "SignalFocusChart")[0];
  assert.equal(h.find((node) => node.type === "SignalFocusChart").length, 1);
  assert.notEqual(chart.props.viewKey, old.viewKey);
  assert.equal(chart.props.tfLabel, "1H");
  assert.equal(chart.props.bars.at(-1).c, 3601);
  assert.equal(chart.props.price, 3601);
  assert.match(h.text(), /Buy at the entry zone/);
  assert.equal(h.find((node) => node.type === "ExecuteSignal").length, 0);
  assert.equal(h.requests.length, 0);
});
