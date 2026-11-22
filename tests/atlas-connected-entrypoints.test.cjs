const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

// Exercise the real button handlers with isolated rendering. No browser, microphone, paid engine,
// broker, or authentication session is used by these tests.
function load(relative, extra = "") {
  const filename = path.resolve(__dirname, "..", relative);
  const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8") + extra, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true }, fileName: filename,
  }).outputText;
  const opened = [], requests = [], navigations = [];
  const jsx = (type, props) => ({ type, props: props || {} });
  const module = { exports: {} };
  const deps = {
    react: { useState: (x) => [typeof x === "function" ? x() : x, () => {}], useEffect: () => {}, useMemo: (f) => f(), useCallback: (f) => f, useRef: (x) => ({ current: x }) },
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "next/link": { default: "Link", __esModule: true },
    "lucide-react": new Proxy({}, { get: (_, key) => `icon:${String(key)}` }),
    "@/lib/atlas/open": { openAtlas: (r) => opened.push(r) },
    "@/lib/creditConfig": { CREDIT_COST: { signal: 3, genx: 5, scan: 5, deepdive: 1 } },
    "@/lib/chart/candleTime": { timedBars: () => ({ bars: [], known: true }) },
    "@/lib/floor/setupInstruments": { FLOOR_INSTRUMENTS: [{ dec: 2 }], setupQuery: () => "" },
    "@/lib/cashtrap/marketHours": { isOpen: () => false },
    "@/lib/floor/overview": { ageText: () => "2m ago", money: () => "0", pipsText: () => "0", toneOf: () => "flat", FLOOR_PERIODS: [{ key: "7d", short: "7D" }, { key: "today", short: "Today" }] },
    "@/lib/flow/display": { priceFor: (_, n) => n == null ? "—" : String(n) },
    "@/lib/pulse/scan": { categoryOf: () => "Crypto" },
    "@/lib/plays/intent": { playsHref: (td, style) => `/portal/signals?td=${td}&style=${style}` },
  };
  const context = vm.createContext({
    Date, console, setTimeout,
    window: { location: { assign: (url) => navigations.push(url) } },
    fetch: (...args) => { requests.push(args); throw new Error("Entry points must not generate or execute"); },
  });
  vm.runInContext(`(function(require,module,exports){${compiled}\n})`, context, { filename })(
    (name) => deps[name] ?? {}, module, module.exports,
  );
  return { exports: module.exports, opened, requests, navigations };
}

function nodes(tree, predicate) {
  if (Array.isArray(tree)) return tree.flatMap((x) => nodes(x, predicate));
  if (!tree || typeof tree !== "object") return [];
  return [...(predicate(tree) ? [tree] : []), ...nodes(tree.props?.children, predicate)];
}
function content(tree) {
  if (Array.isArray(tree)) return tree.map(content).join("");
  if (tree == null || typeof tree === "boolean") return "";
  return typeof tree === "object" ? content(tree.props?.children) : String(tree);
}
function button(tree, text) {
  const matches = nodes(tree, (n) => n.type === "button" && content(n) === text);
  assert.equal(matches.length, 1, `One button named ${text}`);
  return matches[0];
}
const floorProps = {
  ov: null, state: "ready", failed: false, switching: false, gp: "7d", fp: "today", pickGenx: () => {}, pickFlow: () => {}, hide: false,
  now: Date.parse("2026-11-21T12:00:00Z"), setup: { asOf: "2026-11-21T11:59:00Z", price: 3537, g: { entry: 9999 } }, setupFailed: false,
  view: { open: false, stage: "watching", levels: [{ kind: "entry", price: 9999 }], zone: null, waitingFor: "Private level", changesIf: "Private condition" }, tf: "intraday", sample: false,
};

test("Floor Talk opens voice in place and carries dated visible context without locked levels", () => {
  const h = load("src/components/om/floor/Floor.tsx", "\nexport { MobileFloor as TestMobileFloor };\n");
  const tree = h.exports.TestMobileFloor(floorProps);
  assert.equal(h.opened.length, 0, "Rendering does not open a conversation");
  button(tree, "Talk to Atlas").props.onClick();
  assert.equal(h.opened.length, 1);
  assert.equal(h.opened[0].voice, true);
  assert.equal(h.opened[0].context.data.asOf, floorProps.setup.asOf);
  assert.equal(h.opened[0].context.data.levelsLocked, true);
  assert.equal(h.opened[0].context.data.levels, undefined);
  assert.ok(!JSON.stringify(h.opened).includes("9999"));
  assert.equal(h.navigations.length, 0);
  assert.equal(h.requests.length, 0);
});

test("sample Floor cannot start voice or open a paid signal tool", () => {
  const h = load("src/components/om/floor/Floor.tsx", "\nexport { MobileFloor as TestMobileFloor };\n");
  const tree = h.exports.TestMobileFloor({ ...floorProps, sample: true });
  for (const text of ["Talk to Atlas", "OM AI PlaysAny market", "GENXAnalyze gold", "PulseScan markets"]) {
    const target = button(tree, text);
    assert.equal(target.props.disabled, true);
    target.props.onClick();
  }
  assert.equal(h.opened.length, 0);
  assert.equal(h.requests.length, 0);
});

test("Pulse carries the selected scan into the inline play builder and its conversation", () => {
  const h = load("src/components/om/pulse/PulseHome.tsx", "\nexport { Detail as TestDetail };\n");
  const scanAt = Date.parse("2026-11-20T16:00:00Z");
  const s = { symbol: "BTC/USD", td: "BTC/USD", name: "Bitcoin", dir: "SHORT", price: 90000, confirmed: 5, total: 8, checklist: [], zone: "premium", rsi: 58, entry: 90000, stopLoss: 90500, takeProfits: [89000] };
  const tree = h.exports.TestDetail({ s, rank: 2, of: 8, scanAt, onDeepDive: () => {} });
  button(tree, "Build the full play with Atlas").props.onClick();
  button(tree, "Ask Atlas").props.onClick();
  assert.equal(h.opened[0].tool, "plays");
  for (const request of h.opened) {
    assert.equal(request.context.data.td, s.td);
    assert.equal(request.context.data.asOf, new Date(scanAt).toISOString());
    assert.equal(request.context.data.entry, s.entry);
    assert.equal(request.context.data.confirmedSetup, false, "A ranked scan is never promoted into a confirmed setup");
  }
  assert.equal(h.navigations.length, 0);
  assert.equal(h.requests.length, 0);
});

test("Tools opens each real engine through Atlas without invoking it on entry", () => {
  const h = load("src/components/om/ToolsHome.tsx");
  const tree = h.exports.ToolsHome();
  assert.equal(h.opened.length, 0);
  for (const [label, tool] of [["Build a play", "plays"], ["Analyze gold", "genx"], ["Scan markets", "pulse"]]) {
    button(tree, label).props.onClick();
    assert.equal(h.opened.at(-1).tool, tool);
  }
  button(tree, "Talk to Atlas").props.onClick();
  assert.equal(h.opened.at(-1).voice, true);
  assert.equal(h.requests.length, 0);
  assert.equal(h.navigations.length, 0);
});
