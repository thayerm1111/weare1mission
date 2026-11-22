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
      if (name === "@/components/om/chart/OmChart") return { OmChart: "OmChart" };
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

test("Atlas automatically renders its real snapshot chart while keeping the five-frame breakdown and manual ticket", () => {
  const signal = fixture(), h = harness(signal);
  const charts = h.find((node) => node.type === "OmChart");
  assert.equal(charts.length, 1);
  assert.equal(charts[0].props.bars.length, 2);
  assert.equal(charts[0].props.priceLive, false);
  assert.equal(charts[0].props.snapshot, true);
  assert.equal(charts[0].props.fitLevels, true);
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
  assert.ok(h.find((node) => node.type === "OmChart")[0].props.levels.every((level) => level.label.startsWith("Reference ")));
  h.find((node) => node.type === "details" && node.props.className === "om-atlas-signal-order")[0].props.onToggle({ currentTarget: { open: true } });
  h.render();
  assert.equal(h.find((node) => node.type === "ExecuteSignal")[0].props.unconfirmed, true);
  assert.equal(h.requests.length, 0);
});

test("a legacy play without candles explains the missing snapshot without fetching or inventing a chart", () => {
  const h = harness(fixture("setup", []));
  assert.equal(h.find((node) => node.type === "OmChart").length, 0);
  assert.match(h.text(), /Candle chart unavailable for this saved read\./);
  assert.match(h.text(), /Execute BUY/);
  assert.equal(h.requests.length, 0);
});
