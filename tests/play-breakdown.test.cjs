const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const ROOT = path.resolve(__dirname, "..");
const FRAME_ORDER = ["4H", "1H", "30M", "15M", "5M"];

function nodes(tree, predicate) {
  if (Array.isArray(tree)) return tree.flatMap((child) => nodes(child, predicate));
  if (!tree || typeof tree !== "object") return [];
  return [...(predicate(tree) ? [tree] : []), ...nodes(tree.props?.children, predicate)];
}
function content(tree) {
  if (Array.isArray(tree)) return tree.map(content).join("");
  if (tree == null || typeof tree === "boolean") return "";
  return typeof tree === "object" ? content(tree.props?.children) : String(tree);
}
const classIs = (name) => (node) => node.props?.className === name;

// Render the actual component, presentation helpers, and evidence normalizer with isolated hooks.
// An unexpected request fails immediately; this component must only read the saved signal supplied to it.
function harness(props, component = "PlayBreakdown") {
  const slots = [], requests = [], cache = new Map();
  let cursor = 0, tree;
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [slots[index], (next) => { slots[index] = typeof next === "function" ? next(slots[index]) : next; }];
    },
    useId() { const index = cursor++; return slots[index] ??= `breakdown-${index}`; },
    useMemo(factory) { cursor++; return factory(); },
  };
  // PlayDetail always mounts one PlayBreakdown child; executing it here keeps its real output and callbacks.
  const jsx = (type, nodeProps) => typeof type === "function" ? type(nodeProps || {}) : { type, props: nodeProps || {} };
  const context = vm.createContext({
    fetch: (url) => { requests.push(url); throw new Error("A saved breakdown must not fetch: " + url); },
  });
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename).exports;
    const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true }, fileName: filename,
    }).outputText;
    const module = { exports: {} }; cache.set(filename, module);
    const requireHere = (name) => {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "Fragment" };
      if (name === "lucide-react") return new Proxy({}, { get: (_, key) => `icon:${String(key)}` });
      if (name.endsWith(".css")) return {};
      if (name === "@/lib/plays/breakdown") return load(path.join(ROOT, "src/lib/plays/breakdown.ts"));
      if (name === "./diagnostics" || name === "@/lib/plays/diagnostics") return load(path.join(ROOT, "src/lib/plays/diagnostics.ts"));
      if (name === "@/lib/plays/lifecycle") return load(path.join(ROOT, "src/lib/plays/lifecycle.ts"));
      if (name === "./PlayBreakdown") return load(path.join(ROOT, "src/components/om/plays/PlayBreakdown.tsx"));
      if (name === "@/components/om/chart/OmChart") return { OmChart: "OmChart" };
      if (name === "@/components/om/vision/VisionChart") return { VisionChart: "VisionChart" };
      if (name === "@/components/om/vision/VisionDirection") return { VisionDirection: "VisionDirection", VisionLevels: "VisionLevels" };
      if (name === "@/components/om/experience") return { useExperienceMode: () => ({ mode: "advanced", isSimple: false }) };
      if (name === "@/lib/atlas/chart") return { atlasPlayChart: () => ({ bars: [], known: false, dec: 2, tfMs: 900000, tfLabel: "15m", viewKey: "saved-play" }) };
      if (name === "@/lib/chart/candleTime") return { timedBars: () => ({ bars: [], known: false }) };
      if (name === "@/lib/flow/display") return { priceFor: (_symbol, value) => value == null ? "—" : String(value) };
      throw new Error("Unexpected breakdown dependency: " + name);
    };
    vm.runInContext(`(function(require,module,exports){${compiled}\n})`, context, { filename })(requireHere, module, module.exports);
    return module.exports;
  }
  const Component = load(path.join(ROOT, `src/components/om/plays/${component}.tsx`))[component];
  function render(nextProps) {
    if (nextProps) props = { ...props, ...nextProps };
    cursor = 0; tree = Component(props); return tree;
  }
  const find = (predicate) => nodes(tree, predicate);
  const frames = () => find(classIs("om-play-frame"));
  render();
  return {
    render, nodes: find, frames, requests, content: () => content(tree),
    detail: () => find(classIs("om-play-frame-detail"))[0],
    clickFrame(tf) {
      const match = frames().filter((node) => content(node.props.children[0]) === tf);
      assert.equal(match.length, 1, `One ${tf} timeframe control`);
      match[0].props.onClick(); render();
    },
  };
}

function observation(tf, index, allMet = false) {
  const checklist = [
    { label: `${tf} saved structure factor`, ok: true },
    { label: `${tf} saved liquidity factor`, ok: allMet || index % 2 === 0 },
  ];
  return {
    tf, trend: allMet || index % 2 === 0 ? "bullish" : "bearish", aligned: allMet || index % 2 === 0,
    confirmed: checklist.filter((check) => check.ok).length, total: checklist.length,
    checklist, asOf: `2026-11-22 0${index}:00:00`, closed: true, unavailable: false,
  };
}

test("the five real timeframe controls show only the selected frame's saved checks and toggle closed", () => {
  const rows = FRAME_ORDER.map((tf, index) => observation(tf, index));
  const h = harness({ signal: { direction: "LONG", status: "setup", timeframeConfirmations: rows } });
  assert.deepEqual(h.frames().map((node) => content(node.props.children[0])), FRAME_ORDER);
  assert.equal(h.detail().props.hidden, true);
  assert.equal(h.nodes((node) => node.type === "li").length, 0, "No frame's checklist is open on entry");

  for (const row of rows) {
    h.clickFrame(row.tf);
    const detail = h.detail();
    assert.equal(detail.props.hidden, false);
    assert.equal(detail.props["aria-label"], `${row.tf} confirmation details`);
    const expanded = h.frames().filter((node) => node.props["aria-expanded"] === true);
    assert.equal(expanded.length, 1);
    assert.equal(expanded[0].props["aria-controls"], detail.props.id);
    assert.equal(content(expanded[0].props.children[0]), row.tf);
    const checks = nodes(detail, (node) => node.type === "li");
    assert.deepEqual(checks.map((node) => content(node.props.children[1])), row.checklist.map((check) => check.label));
    assert.deepEqual(checks.map((node) => content(node.props.children[2])), row.checklist.map((check) => check.ok ? "Met" : "Not met"));
    assert.ok(content(detail).includes(`${row.confirmed} of ${row.total} met`));
    assert.ok(content(detail).includes(row.asOf));
    for (const other of rows.filter((other) => other.tf !== row.tf)) assert.ok(!checks.some((check) => content(check.props.children[1]) === other.checklist[0].label));
  }
  h.clickFrame("5M");
  assert.equal(h.detail().props.hidden, true);
  assert.ok(h.frames().every((node) => node.props["aria-expanded"] === false));
  assert.equal(h.requests.length, 0);
});

test("all met observations cannot promote a no-trade idea or a neutral read into a setup", () => {
  const signal = { direction: "LONG", status: "no_trade", timeframeConfirmations: FRAME_ORDER.map((tf, index) => observation(tf, index, true)) };
  const h = harness({ signal });
  const state = () => h.nodes(classIs("om-play-breakdown-state"))[0];
  assert.equal(content(state()), "Not confirmed");
  assert.equal(state().props["data-waiting"], true);
  assert.equal(h.nodes(classIs("om-play-frame-score")).filter((node) => content(node) === "2/2").length, 5);
  for (const tf of FRAME_ORDER) {
    h.clickFrame(tf);
    assert.equal(content(state()), "Not confirmed");
    assert.ok(h.nodes((node) => node.type === "li").every((node) => content(node.props.children[2]) === "Met"));
  }
  h.render({ signal: { ...signal, direction: "NEUTRAL" } });
  assert.equal(content(state()), "No setup");
  assert.equal(state().props["data-waiting"], true);
  assert.equal(h.nodes((node) => node.type === "button").length, 5, "Only review controls exist; no trade action is inferred from factors");
  assert.equal(h.requests.length, 0);
});

test("unavailable, legacy trend-only, and missing frames never invent scores or copy another frame's checklist", () => {
  const h = harness({ interval: "15min", signal: {
    direction: "SHORT", status: "no_trade",
    flow: { h4: "bullish", h1: "bearish", dir: "SHORT", aligned: false },
    mtf: [{ tf: "15M", trend: "bearish" }],
    checklist: [{ label: "Execution-frame break", ok: true }, { label: "Execution-frame retest", ok: false }],
    timeframes: [{ tf: "30min", trend: "ranging", confirmed: 0, total: 0, checklist: [] }],
    timeframeConfirmations: [{
      tf: "1H", closed: true, unavailable: true, reason: "rate_limited",
      trend: "bullish", confirmed: 2, total: 2, asOf: "stale", aligned: true,
      checklist: [{ label: "Damaged unavailable evidence", ok: true }],
    }],
  } });
  assert.deepEqual(h.nodes(classIs("om-play-frame-score")).map(content), ["Trend only", "Unavailable", "Trend only", "1/2", "Not saved"]);
  for (const tf of FRAME_ORDER) {
    h.clickFrame(tf);
    const detail = h.detail(), checks = nodes(detail, (node) => node.type === "li");
    assert.equal(checks.length, tf === "15M" ? 2 : 0, "The legacy checklist belongs only to the execution timeframe");
    assert.ok(!h.content().includes("0/0") && !h.content().includes("0 of 0"));
    assert.ok(!h.content().includes("Damaged unavailable evidence"));
    if (tf === "1H") assert.ok(content(detail).includes("request limit"));
    if (tf === "4H" || tf === "30M") assert.ok(content(detail).includes("without a factor checklist"));
    if (tf === "5M") assert.ok(content(detail).includes("did not include this timeframe"));
  }
  h.render({ interval: undefined, signal: {
    direction: "LONG", status: "no_trade",
    mtf: [{ tf: "4H", trend: "bullish" }, { tf: "1H", trend: "bearish" }],
  } });
  assert.deepEqual(h.frames().map((node) => node.props["data-trend"]), ["bullish", "bearish", "unknown", "unknown", "unknown"]);
  assert.deepEqual(h.nodes(classIs("om-play-frame-score")).map(content), ["Trend only", "Trend only", "Not saved", "Not saved", "Not saved"]);
  for (const tf of ["4H", "1H"]) {
    h.clickFrame(tf);
    assert.equal(nodes(h.detail(), (node) => node.type === "li").length, 0);
    assert.ok(content(h.detail()).includes("without a factor checklist"));
  }
  assert.equal(h.requests.length, 0);
});

test("the optional full breakdown retains the actual saved rationale and notes without another read", () => {
  const rationale = "This is the exact first sentence from the saved engine read.\n" +
    "The saved second paragraph explains its observed structure and the unresolved pullback. ".repeat(5) +
    "The final saved condition is a close back through the recorded invalidation level.";
  const signal = {
    direction: "SHORT", status: "no_trade", rationale,
    invalidation: "Close above the saved supply area.", bias: "Saved bearish higher-timeframe bias.",
    poi: "The saved supply retrace.", liquidityTarget: "The recorded prior-session low.", confidence: "Moderate", grade: "B",
  };
  const before = JSON.stringify(signal);
  const h = harness({ signal, fullReasoning: false });
  assert.equal(h.nodes((node) => node.type === "details").length, 0);
  h.render({ fullReasoning: true });
  const full = h.nodes(classIs("om-play-breakdown-full"))[0];
  assert.ok(full, "The full saved explanation is available behind its own native disclosure");
  assert.equal(content(nodes(full, (node) => node.type === "summary")[0]).trim(), "Full breakdown");
  assert.equal(nodes(full, (node) => node.type === "p" && content(node) === rationale).length, 1);
  assert.deepEqual(nodes(full, (node) => node.type === "dd").map(content), [signal.bias, signal.poi, signal.liquidityTarget]);
  assert.ok(h.nodes((node) => node.type === "dd").some((node) => content(node) === signal.invalidation));
  assert.ok(content(full).includes("Confidence: Moderate · Grade: B"));
  assert.ok(content(full).includes("not the chance of winning"));
  assert.equal(JSON.stringify(signal), before, "Opening the explanation does not rewrite the saved signal");
  assert.equal(h.requests.length, 0);
});

test("PlayDetail uses canonical closed-candle evidence once while retaining engine reasoning and older evidence", () => {
  const signal = {
    direction: "LONG", status: "no_trade", entry: 100, stopLoss: 95, takeProfits: [110],
    rationale: "The exact saved engine rationale remains in Why this trade.", verdict: "The engine is still waiting for its entry trigger.",
    invalidation: "A close below the recorded low.", confidence: "Moderate", timeframe: "Intraday", riskReward: "2:1",
    setup: "Saved break and retest", bias: "Saved higher-timeframe bias", poi: "Saved entry area", liquidityTarget: "Saved target area",
    flow: { h4: "bullish", h1: "bullish", dir: "LONG", aligned: true },
    checklist: [{ label: "Legacy primary forming-bar check", ok: true }], confirmed: 1, total: 1,
    timeframes: [{ tf: "4H", trend: "bullish", confirmed: 2, total: 2, checklist: [
      { label: "Legacy forming-bar structure", ok: true }, { label: "Legacy forming-bar liquidity", ok: true },
    ] }],
    timeframeConfirmations: FRAME_ORDER.map((tf) => observation(tf, 1)),
  };
  const r = { id: 1, symbol: "XAU/USD", td: "XAU/USD", name: "Gold", market: "metals", interval: "15min", orderType: "limit", style: "intraday", method: "best", price: 101, asOf: "2026-11-22T15:00:00Z", status: "open", signal };
  const action = () => { throw new Error("Review must not run a trading or analysis action"); };
  const h = harness({ r, madeMs: Date.parse(r.asOf), checking: false, updating: false,
    onCheck: action, onUpdate: action, onDive: action, onAsk: action, onClose: action,
    update: null, live: null, ticket: null, copy: null, chat: null,
  }, "PlayDetail");
  assert.equal(h.nodes(classIs("om-play-breakdown")).length, 1);
  assert.equal(h.frames().length, 5, "The real nested breakdown is rendered in PlayDetail");
  h.nodes(classIs("om-disclose"))[0].props.onClick(); h.render();
  const why = () => h.nodes(classIs("om-play-why-body"))[0];
  const retainsReasoning = () => {
    assert.equal(nodes(why(), (node) => node.type === "p" && content(node) === signal.rationale).length, 1);
    for (const value of [signal.verdict, signal.invalidation, signal.bias, signal.setup, signal.poi, signal.liquidityTarget]) assert.ok(content(why()).includes(value));
  };
  retainsReasoning();
  assert.equal(nodes(why(), classIs("om-play-tfs")).length, 0);
  assert.equal(nodes(why(), classIs("om-checks")).length, 0);
  assert.ok(!content(why()).includes("Flow · 4H, 1H"));
  h.clickFrame("4H");
  assert.ok(content(h.detail()).includes("1 of 2 met"));
  assert.ok(content(h.detail()).includes("4H saved structure factor"));
  assert.ok(!h.content().includes("Legacy forming-bar"), "Older forming-bar counts do not contradict the closed-candle read");

  for (const canonical of [undefined, [], [{ ...observation("4H", 1), closed: false }]]) {
    h.render({ r: { ...r, signal: { ...signal, timeframeConfirmations: canonical } } });
    retainsReasoning();
    assert.equal(nodes(why(), classIs("om-play-tfs")).length, 1, "Only valid nonempty canonical evidence hides legacy timeframe rows");
    assert.ok(content(why()).includes("Legacy forming-bar structure"));
    assert.ok(content(why()).includes("Flow · 4H, 1H"));
  }
  h.render({ r: { ...r, signal: { ...signal, timeframeConfirmations: undefined, timeframes: undefined } } });
  retainsReasoning();
  assert.equal(nodes(why(), classIs("om-checks")).length, 1);
  assert.ok(content(why()).includes("Legacy primary forming-bar check"), "Older primary-only checklists remain available");
  assert.equal(h.requests.length, 0);
});
