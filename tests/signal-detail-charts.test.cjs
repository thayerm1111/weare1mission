const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const ROOT = path.resolve(__dirname, "..");
const nodes = (tree, predicate) => Array.isArray(tree) ? tree.flatMap((item) => nodes(item, predicate))
  : !tree || typeof tree !== "object" ? [] : [...(predicate(tree) ? [tree] : []), ...nodes(tree.props?.children, predicate)];
const text = (tree) => Array.isArray(tree) ? tree.map(text).join("") : tree == null || typeof tree === "boolean" ? ""
  : typeof tree === "object" ? text(tree.props?.children) : String(tree);

// Render the real detail components and their data helpers. No effects, provider, account session,
// broker, browser, or network is needed to decide which saved candles and labels accompany a read.
function render(relative, component, props) {
  const cache = new Map(), requests = [];
  let nextId = 0;
  const react = {
    useState: (value) => [typeof value === "function" ? value() : value, () => {}],
    useMemo: (fn) => fn(), useCallback: (fn) => fn, useRef: (value) => ({ current: value }),
    useEffect: () => {}, useId: () => `signal-detail-${nextId++}`,
  };
  const jsx = (type, props) => typeof type === "function" ? type(props || {}) : { type, props: props || {} };
  const context = vm.createContext({ Date, Intl, process: { env: {} }, fetch: (url) => { requests.push(url); throw new Error("Unexpected detail request"); } });
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename).exports;
    const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true }, fileName: filename,
    }).outputText;
    const mod = { exports: {} }; cache.set(filename, mod);
    const requireHere = (name) => {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "Fragment" };
      if (name === "next/link") return { __esModule: true, default: "Link" };
      if (name === "lucide-react") return new Proxy({}, { get: (_, key) => `icon:${String(key)}` });
      if (name.endsWith(".css")) return {};
      if (name === "@/components/om/ProductIcon") return { ProductIcon: "ProductIcon" };
      if (name === "@/components/om/chart/OmChart") return { OmChart: "OmChart" };
      if (name === "@/components/om/experience") return { useExperienceMode: () => ({ isSimple: false }) };
      if (name === "@/components/om/vision/VisionChart") {
        const { VisionChart } = load(path.join(ROOT, "src/components/om/vision/VisionChart.tsx"));
        return { VisionChart: (props) => ({ type: "VisionChart", props: { ...props, children: VisionChart(props) } }) };
      }
      if (name === "@/components/om/floor/Floor") return { GenxCard: "GenxCard" };
      if (name === "@/components/om/MobileSection") return { MobileSection: ({ children }) => children };
      if (name === "@/components/portal/floor/GenxFlow") return { buildSteps: () => [] };
      const base = name.startsWith("@/") ? path.join(ROOT, "src", name.slice(2)) : name.startsWith(".") ? path.resolve(path.dirname(filename), name) : null;
      const resolved = base && [base, `${base}.ts`, `${base}.tsx`].find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
      if (resolved) return load(resolved);
      throw new Error("Unexpected detail dependency: " + name);
    };
    vm.runInContext(`(function(require,module,exports){${code}\n})`, context, { filename })(requireHere, mod, mod.exports);
    return mod.exports;
  }
  const tree = load(path.join(ROOT, relative))[component](props);
  return { requests, text: text(tree), find: (predicate) => nodes(tree, predicate) };
}

const candles = [
  { t: "2026-11-20 09:00:00", o: 2600, h: 2608, l: 2598, c: 2605 },
  { t: "2026-11-20 10:00:00", o: 2605, h: 2610, l: 2602, c: 2607 },
];
const read = {
  mode: "swing", action: "BUY_NOW", directional_bias: "bullish", confidence_score: 80,
  entry: 2606, entry_low: 2605, entry_high: 2607, stop_loss: 2590, tp1: 2620, tp2: 2630, tp3: 2640,
  stop_pips: 160, tp1_pips: 140, tp2_pips: 240, tp3_pips: 340,
  closest_support: 2598, closest_resistance: 2610, invalidation_price: 2590,
  market_structure: "Up", momentum: "Building", volatility: "Normal", market_regime: "Trend", session: "London",
  buyer_control: 65, seller_control: 35, expected_hold_minutes: [240, 2880],
  market_story: [], trade_reasoning: [], risk_factors: [], invalidation_reason: "Below the stop",
  trigger_condition: "Confirmed", trigger_tf: "1-hour", context_tf: "4-hour / daily", projected_path: [],
};
const genxProps = (overrides = {}) => ({
  mode: "quick", setMode() {}, analyze() { throw new Error("No generation while opening a saved read"); }, loading: false, err: "",
  read, readCandles: candles, readPrice: 2606, readLive: true, readAt: "2026-11-20T10:05:00Z", readInterval: "1h",
  saved: { at: "2026-11-20T10:05:02Z", mode: "swing" }, backToCurrent() {}, plays: [], openPlay() {},
  tracked: [], isTracked: false, hasPlan: true, track() {}, untrack() {}, Confirm: () => "Live confirmation", setupOf: () => ({}),
  ...overrides,
});

test("opened GENX history renders its original chart with generation wording and all levels", () => {
  const h = render("src/components/om/genx/GenxHome.tsx", "GenxHome", genxProps());
  const charts = h.find((node) => node.type === "VisionChart");
  assert.equal(charts.length, 1);
  const p = charts[0].props;
  assert.equal(p.bars.length, 2);
  assert.equal(p.tfMs, 3_600_000);
  assert.equal(p.price, 2606);
  assert.equal(p.priceLive, false);
  assert.equal(p.snapshot, true);
  assert.equal(h.find((node) => node.type === "OmChart")[0].props.bars.length, p.bars.length, "the opening chart receives the full recorded history");
  assert.equal(p.timeKnown, false);
  assert.equal(p.levels.length, 7);
  assert.equal(p.direction, "buy");
  assert.equal(p.reference, false);
  assert.deepEqual(h.find((node) => node.props?.["aria-label"] === "Trade levels" || node.type === "VisionChart" || node.props?.["aria-label"] === "What GENX is doing")
    .map((node) => node.type === "VisionChart" ? "chart" : node.props["aria-label"]), ["chart", "Trade levels", "What GENX is doing"]);
  assert.match(h.text, /At generation/);
  assert.match(h.text, /saved snapshot at generation/);
  assert.doesNotMatch(h.text, /candles and the quote are gold now|Live confirmation/);
  assert.equal(h.requests.length, 0);
});

test("an old saved GENX read visibly explains its absent original chart and keeps its original levels", () => {
  const h = render("src/components/om/genx/GenxHome.tsx", "GenxHome", genxProps({ readCandles: [] }));
  assert.equal(h.find((node) => node.type === "OmChart" || node.type === "VisionChart").length, 0);
  assert.match(h.text, /Original chart unavailable/);
  assert.match(h.text, /original candles were not stored with this read/i);
  assert.match(h.text, /Back to current analysis/);
  assert.match(h.text, /TP3/);
  assert.equal(h.requests.length, 0);
});

test("a pending GENX read keeps its reference levels and confirmation review around its snapshot", () => {
  const h = render("src/components/om/genx/GenxHome.tsx", "GenxHome", genxProps({ saved: null,
    read: { ...read, action: "WAIT_FOR_BUY_TRIGGER" } }));
  const p = h.find((node) => node.type === "VisionChart")[0].props;
  assert.equal(p.priceLive, false);
  assert.equal(p.reference, true);
  assert.equal(p.direction, "buy");
  assert.equal(p.levels.filter((level) => ["entry", "stop", "target"].includes(level.kind)).every((level) => level.label.startsWith("Reference ")), true);
  assert.match(h.text, /conditional reference · confirmation required/i);
  assert.match(h.text, /Live confirmation/);
  assert.match(h.text, /Track this setup/);
  assert.equal(h.requests.length, 0);
});

test("a GENX HOLD keeps market context without presenting dormant trade prices as a plan", () => {
  const h = render("src/components/om/genx/GenxHome.tsx", "GenxHome", genxProps({ read: { ...read, action: "WAIT" } }));
  const p = h.find((node) => node.type === "VisionChart")[0].props;
  assert.equal(p.direction, "buy", "the saved directional lean is still visible");
  assert.equal(h.find((node) => node.props?.["aria-label"] === "Chart view").length, 0, "a hold has no setup map");
  assert.equal(p.zone, null);
  assert.deepEqual(Array.from(p.levels, (level) => level.kind).sort(), ["resistance", "support"]);
  assert.equal(h.find((node) => node.props?.["aria-label"] === "Trade levels").length, 0);
  assert.equal(h.find((node) => node.props?.["aria-label"] === "Key levels").length, 1);
  assert.equal(h.requests.length, 0);
});

test("an entry exactly on resistance retains its trade role for the projected plan", () => {
  const h = render("src/components/om/genx/GenxHome.tsx", "GenxHome", genxProps({ read: { ...read, closest_resistance: read.entry, closest_support: read.stop_loss } }));
  const p = h.find((node) => node.type === "VisionChart")[0].props;
  assert.equal(p.levels.find((level) => level.kind === "entry").price, read.entry);
  assert.equal(p.levels.find((level) => level.kind === "stop").price, read.stop_loss);
  assert.equal(p.levels.filter((level) => level.kind === "target").length, 3);
});

const playProps = (overrides = {}) => ({
  r: { id: 1_800_000_000_000, symbol: "XAU/USD", name: "Gold", market: "Metals", td: "XAU/USD", interval: "unrecorded",
    orderType: "limit", price: 2606, live_price: 9999, asOf: "2026-11-20T10:05:00Z", status: "win", candles,
    signal: { direction: "LONG", status: "setup", entry: 2606, stopLoss: 2590, takeProfits: [2620, 2630, 2640, 2650],
      confidence: "High", riskReward: "1:2", timeframe: "Swing", rationale: "Saved read", invalidation: "Below the stop" }, ...overrides },
  madeMs: Date.parse("2026-11-20T10:05:00Z"), checking: false, onCheck() {}, updating: false, onUpdate() {},
  update: null, onDive() {}, onAsk() {}, onClose() {}, live: null,
  ticket: { type: "OrderTicket", props: { entry: 2606, stop: 2590 } }, copy: null, chat: null,
});

test("OM play detail marks its chart as a snapshot, preserves every target and never invents an interval", () => {
  const h = render("src/components/om/plays/PlayDetail.tsx", "PlayDetail", playProps());
  const p = h.find((node) => node.type === "VisionChart")[0].props;
  assert.equal(p.tfMs, 0);
  assert.equal(p.timeframe, "Saved candles");
  assert.equal(p.snapshot, true);
  assert.equal(p.priceLive, false);
  assert.equal(h.find((node) => node.type === "OmChart")[0].props.bars.length, p.bars.length, "the opening chart receives the full recorded history");
  assert.equal(p.price, 2606, "current price is never substituted for the generation quote");
  assert.equal(p.direction, "buy");
  assert.equal(p.levels.length, 6, "all four saved targets remain on the standalone chart");
  assert.match(h.text, /price at signal/i);
  const order = h.find((node) => ["om-vision-levels", "om-play-decision", "om-play-next", "om-vision-play-breakdown"].includes(node.props?.className) || node.type === "VisionChart")
    .map((node) => node.type === "VisionChart" ? "chart" : node.props.className);
  assert.deepEqual(order, ["chart", "om-vision-levels", "om-play-decision", "om-play-next", "om-vision-play-breakdown"]);
  assert.equal(h.find((node) => node.type === "OrderTicket").length, 1);
  assert.match(h.text, /Execute BUY/);
  assert.match(h.text, /Placing it now is a new trade/);
  assert.equal(h.requests.length, 0);
});

test("OM play detail renders a missing-snapshot explanation without dropping the execution review", () => {
  const h = render("src/components/om/plays/PlayDetail.tsx", "PlayDetail", playProps({ candles: [] }));
  assert.equal(h.find((node) => node.type === "OmChart" || node.type === "VisionChart").length, 0);
  assert.match(h.text, /Verified original candles unavailable/);
  assert.equal(h.find((node) => node.type === "OrderTicket").length, 1);
  assert.match(h.text, /Execute BUY/);
  assert.equal(h.requests.length, 0);
});

test("an unconfirmed OM play keeps explicit reference labels and manual review", () => {
  const props = playProps();
  props.r.signal = { ...props.r.signal, direction: "SHORT", status: "no_trade", takeProfits: [2590, 2580], stopLoss: 2620 };
  const h = render("src/components/om/plays/PlayDetail.tsx", "PlayDetail", props);
  const p = h.find((node) => node.type === "VisionChart")[0].props;
  assert.equal(p.direction, "sell");
  assert.equal(p.reference, true);
  assert.equal(p.levels.every((level) => level.label.startsWith("Reference ")), true);
  assert.match(h.text, /Execute SELL · manual override/);
  assert.match(h.text, /Waiting for confirmation/);
  assert.equal(h.find((node) => node.type === "OrderTicket").length, 1);
  assert.equal(h.requests.length, 0);
});

test("a missing generation quote is labelled as the actual saved candle close, never a later live quote", () => {
  const h = render("src/components/om/plays/PlayDetail.tsx", "PlayDetail", playProps({ price: null }));
  const p = h.find((node) => node.type === "VisionChart")[0].props;
  assert.equal(p.price, 2607);
  assert.match(h.text, /last saved candle/i);
  assert.doesNotMatch(h.text, /price at signal/i);
  const g = render("src/components/om/genx/GenxHome.tsx", "GenxHome", genxProps({ readPrice: null }));
  assert.match(g.text, /last saved candle/i);
  assert.equal(g.find((node) => node.type === "VisionChart")[0].props.price, 2607);
});

test("a read with one usable saved candle still shows that evidence without inventing the other four", () => {
  const h = render("src/components/om/plays/PlayDetail.tsx", "PlayDetail", playProps({ candles: [candles[0]] }));
  const g = render("src/components/om/genx/GenxHome.tsx", "GenxHome", genxProps({ readCandles: [candles[0]] }));
  for (const result of [h, g]) {
    const p = result.find((node) => node.type === "VisionChart")[0].props;
    assert.equal(p.bars.length, 1);
    assert.equal(p.bars[0].o, candles[0].o);
    assert.equal(p.bars[0].c, candles[0].c);
    assert.equal(result.find((node) => node.props?.className === "om-vision-candle").length, 1);
    assert.equal(result.find((node) => node.type === "OmChart").length, 0);
    assert.doesNotMatch(result.text, /Original candle chart unavailable|candles were not stored/);
    assert.equal(result.requests.length, 0);
  }
});
