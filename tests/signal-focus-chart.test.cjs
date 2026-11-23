const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const ROOT = path.resolve(__dirname, "..");
const plain = (value) => JSON.parse(JSON.stringify(value));
const nodes = (tree, match) => Array.isArray(tree) ? tree.flatMap((item) => nodes(item, match))
  : !tree || typeof tree !== "object" ? [] : [...(match(tree) ? [tree] : []), ...nodes(tree.props?.children, match)];
const text = (tree) => Array.isArray(tree) ? tree.map(text).join("") : tree == null || typeof tree === "boolean" ? ""
  : typeof tree === "object" ? text(tree.props?.children) : String(tree);

function harness(initial) {
  const slots = [], requests = [], cache = new Map();
  let cursor = 0, props = initial, tree;
  const react = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial; return [slots[i], (next) => { slots[i] = typeof next === "function" ? next(slots[i]) : next; }]; },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useMemo(fn) { cursor++; return fn(); }, useEffect() { cursor++; },
    useId() { const i = cursor++; return slots[i] ??= `signal-focus-${i}`; },
  };
  const jsx = (type, props) => typeof type === "function" ? type(props || {}) : { type, props: props || {} };
  const context = vm.createContext({ Date, Intl, fetch: (url) => { requests.push(url); throw new Error("Signal chart views must not request data"); } });
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename).exports;
    const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true }, fileName: filename,
    }).outputText;
    const mod = { exports: {} }; cache.set(filename, mod);
    const requireHere = (name) => {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "Fragment" };
      if (name.endsWith(".css")) return {};
      if (name === "@/components/om/chart/OmChart") return { OmChart: "OmChart" };
      const base = name.startsWith("@/") ? path.join(ROOT, "src", name.slice(2)) : name.startsWith(".") ? path.resolve(path.dirname(filename), name) : null;
      const file = base && [base, `${base}.ts`, `${base}.tsx`].find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
      if (file) return load(file);
      throw new Error("Unexpected focus chart dependency: " + name);
    };
    vm.runInContext(`(function(require,module,exports){${code}\n})`, context, { filename })(requireHere, mod, mod.exports);
    return mod.exports;
  }
  const { SignalFocusChart } = load(path.join(ROOT, "src/components/om/chart/SignalFocusChart.tsx"));
  const { signalFocusModel } = load(path.join(ROOT, "src/lib/chart/signalFocus.ts"));
  const render = (next) => { if (next) props = next; cursor = 0; tree = SignalFocusChart(props); return tree; };
  render();
  return { render, model: signalFocusModel, requests, text: () => text(tree), find: (match) => nodes(tree, match) };
}

const bars = Array.from({ length: 18 }, (_, i) => {
  const o = 3500 + i * .2, c = o + (i % 2 ? .45 : -.15);
  return { t: 1_800_000_000_000 + i * 300_000, o, c, h: Math.max(o, c) + .5, l: Math.min(o, c) - .5 };
});
const levels = [
  { kind: "entry", price: 3502, label: "Entry" }, { kind: "stop", price: 3498, label: "Stop" },
  { kind: "target", price: 3512, label: "Target 1" }, { kind: "target", price: 3520, label: "Target 2" },
  { kind: "target", price: 3530, label: "Target 3" },
];
const fixture = (extra = {}) => ({ bars, levels, price: 3503.85, direction: "buy", reference: false, timeKnown: false,
  tfMs: 300_000, tfLabel: "5M", dec: 2, snapshot: true, priceLive: false, fitLevels: true,
  zone: { low: 3501, high: 3503 }, viewKey: "saved-read-one", label: "Gold, saved candles at generation", ...extra });

test("a signal defaults to its last five actual enlarged candles and an explicitly projected scenario, without mounting a history chart", () => {
  const input = fixture(), before = JSON.stringify(input), h = harness(input);
  const candles = h.find((node) => node.props["data-signal-candle"] !== undefined);
  assert.equal(candles.length, 5);
  assert.deepEqual(candles.map((node) => node.props["data-signal-candle"]), bars.slice(-5).map((bar) => bar.t));
  assert.equal(h.find((node) => node.type === "OmChart").length, 0);
  assert.equal(h.find((node) => node.props["data-projected-scenario"]).length, 1);
  assert.match(h.text(), /5 latest candles5M/);
  assert.match(h.text(), /Buy setup/);
  assert.match(h.text(), /Projected scenario/);
  assert.match(h.text(), /Separate price scale; no timing is implied/);
  assert.equal(JSON.stringify(input), before);
  assert.equal(h.requests.length, 0);
});

test("Full chart opens all supplied candle history with the exact source flags and native fullscreen-capable renderer, and collapses on another read", () => {
  const input = fixture(), h = harness(input);
  const full = h.find((node) => node.type === "button")[0];
  assert.equal(full.props["aria-expanded"], false);
  assert.ok(full.props["aria-controls"]);
  full.props.onClick(); h.render();
  const chart = h.find((node) => node.type === "OmChart")[0];
  assert.deepEqual(plain(chart.props.bars), bars);
  for (const key of ["price", "timeKnown", "tfMs", "tfLabel", "snapshot", "priceLive", "viewKey", "label"]) assert.equal(chart.props[key], input[key]);
  assert.deepEqual(chart.props.levels, levels);
  assert.deepEqual(chart.props.zone, input.zone);
  assert.equal(h.find((node) => node.type === "dialog").length, 0, "only OmChart owns its fullscreen dialog");
  assert.match(h.text(), /All 18 recorded candles/);
  assert.equal(h.find((node) => node.type === "button")[0].props["aria-expanded"], true);
  h.render(fixture({ viewKey: "different-saved-read" }));
  assert.equal(h.find((node) => node.type === "OmChart").length, 0);
  assert.equal(h.requests.length, 0);
});

test("waiting sell diagrams retain reference labels and project only through their recorded entry and targets", () => {
  const sellLevels = [
    { kind: "entry", price: 3504, label: "Reference entry" }, { kind: "stop", price: 3510, label: "Reference stop" },
    { kind: "target", price: 3495, label: "Reference target 1" }, { kind: "target", price: 3485, label: "Reference target 2" },
  ];
  const input = fixture({ levels: sellLevels, direction: "sell", reference: true }), h = harness(input);
  assert.match(h.text(), /Sell reference/);
  assert.match(h.text(), /Ref Entry/);
  assert.match(h.text(), /Ref Stop/);
  assert.match(h.text(), /Ref T1/);
  assert.match(h.text(), /confirmation is still needed/);
  const model = h.model({ ...input, width: 260 });
  assert.deepEqual(plain(model.scenario.map((point) => point.price)), [input.price, 3504, 3495, 3485]);
  assert.ok(model.scenario.at(-1).y > model.scenario[1].y);
  assert.ok(model.scenario.every((point) => !Object.hasOwn(point, "t")), "no projected timestamp is manufactured");
});

test("distant stops and targets do not shrink the actual candle geometry", () => {
  const input = fixture(), h = harness(input);
  const before = h.model({ ...input, width: 280 });
  const distant = h.model({ ...input, width: 280, levels: [
    levels[0], { ...levels[1], price: 1000 }, { ...levels[2], price: 5000 }, { ...levels[3], price: 8000 }, { ...levels[4], price: 12000 },
  ] });
  assert.deepEqual(plain(before.candles), plain(distant.candles));
  assert.equal(distant.marks.find((mark) => mark.kind === "stop").price, 1000);
  assert.equal(distant.marks.find((mark) => mark.price === 12000).price, 12000);
  assert.ok(before.candles.every((bar) => bar.bodyWidth >= 9));
  assert.ok(before.candles.some((bar) => bar.bodyHeight > 20));
});

test("narrow focused charts keep actual price ordering, separated level labels and bounded five-candle geometry", () => {
  const input = fixture({ direction: "sell", levels: [
    { kind: "stop", price: 3534.2, label: "Stop" }, { kind: "entry", price: 3533.5, label: "Entry" },
    { kind: "target", price: 3532.5, label: "Target 1" }, { kind: "target", price: 3531.5, label: "Target 2" },
    { kind: "target", price: 3530, label: "Target 3" },
  ] }), h = harness(input);
  for (const width of [240, 256, 320, 420, 680]) {
    const model = h.model({ ...input, width });
    assert.equal(model.candles.length, 5);
    assert.deepEqual(plain(model.marks.map((mark) => mark.price)), [3534.2, 3533.5, 3532.5, 3531.5, 3530]);
    model.marks.forEach((mark, i) => {
      assert.ok(mark.labelY >= model.top + 17 && mark.labelY <= model.bottom);
      if (i) assert.ok(mark.labelY - model.marks[i - 1].labelY >= 35 - 1e-9);
    });
    assert.ok(model.candles.every((bar) => bar.x - bar.bodyWidth / 2 >= 0 && bar.x + bar.bodyWidth / 2 < model.divider));
    assert.ok(model.scenario.every((point) => point.x > model.divider && point.x <= model.laneRight));
  }
});

test("HOLD, missing entry or contradictory target/stop levels never acquire a projected trade path", () => {
  const input = fixture(), h = harness(input);
  const invalid = [
    { direction: "neutral" }, { levels: levels.filter((level) => level.kind !== "entry") },
    { levels: levels.map((level) => level.kind === "target" ? { ...level, price: 3490 } : level) },
    ...[3502, 3510, NaN, Infinity].map((price) => ({ levels: levels.map((level) => level.kind === "stop" ? { ...level, price } : level) })),
  ];
  for (const extra of invalid) assert.equal(h.model({ ...input, ...extra, width: 280 }).scenario, null);
  const noStop = h.model({ ...input, levels: levels.filter((level) => level.kind !== "stop"), width: 280 });
  assert.ok(noStop.scenario, "a missing stop is not invented merely to draw recorded entry/targets");
  assert.equal(noStop.marks.some((mark) => mark.kind === "stop"), false);
  h.render(fixture({ direction: "neutral" }));
  assert.match(h.text(), /Market context/);
  assert.equal(h.find((node) => node.type === "polyline").length, 0);
  assert.equal(h.find((node) => node.props["data-level-price"] !== undefined).length, 0);
});

test("malformed or missing bars are never repaired, duplicated or padded to five", () => {
  const h = harness(fixture());
  const damaged = [null, {}, { ...bars[0], t: NaN }, { ...bars[0], o: "3500" }, { ...bars[0], h: 3400 }, bars[1], bars[0], { ...bars[1], c: bars[1].c + .1 }];
  const model = h.model({ ...fixture(), bars: damaged, width: 260 });
  assert.equal(model.history.length, 2);
  assert.equal(model.candles.length, 2);
  assert.equal(model.history[1].c, bars[1].c + .1);
  assert.ok(model.history[0].t < model.history[1].t);
  h.render(fixture({ bars: [bars[0]], tfMs: 0, tfLabel: "Saved candles" }));
  assert.equal(h.find((node) => node.props["data-signal-candle"] !== undefined).length, 1);
  assert.equal(h.find((node) => node.type === "button").length, 0);
  assert.match(h.text(), /1 latest candleSaved candles/);
  h.render(fixture({ bars: [] }));
  assert.match(h.text(), /Candle chart unavailable/);
  assert.equal(h.find((node) => node.type === "svg").length, 0);
});

test("a lone unnumbered target stays Target and missing quote starts only from the actual latest candle close", () => {
  for (const price of [null, NaN, Infinity]) {
    const input = fixture({ price, levels: [levels[0], levels[1], { ...levels[2], label: "Scalp target" }] });
    const h = harness(input), model = h.model({ ...input, width: 280 });
    assert.equal(model.scenario[0].price, bars.at(-1).c);
    assert.match(h.text(), /Target/);
    assert.doesNotMatch(h.text(), /T3/);
    assert.match(h.text(), /Latest candle close/);
    assert.doesNotMatch(h.text(), /Price from this read/);
    assert.equal(h.requests.length, 0);
  }
});
