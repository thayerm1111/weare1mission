const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const assets = require("../src/data/signalAssets.ts");
const lifecycle = require("../src/lib/plays/lifecycle.ts");
const diagnostics = require("../src/lib/plays/diagnostics.ts");
const intent = require("../src/lib/plays/intent.ts");
const scan = require("../src/lib/pulse/scan.ts");
const { atlasPlayChart } = require("../src/lib/atlas/chart.ts");
const { mergeSavedPlays, SIGNALS_UPDATED_EVENT } = require("../src/lib/atlas/signals.ts");

const NOW = Date.parse("2026-11-25T16:00:00Z");
const drain = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const text = (tree) => Array.isArray(tree) ? tree.map(text).join("") : tree == null || typeof tree === "boolean" ? "" : typeof tree === "object" ? text(tree.props?.children) : String(tree);
const nodes = (tree, predicate) => Array.isArray(tree) ? tree.flatMap((child) => nodes(child, predicate)) : !tree || typeof tree !== "object" ? [] : [...(predicate(tree) ? [tree] : []), ...nodes(tree.props?.children, predicate)];
const store = () => { const values = new Map(); return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) }; };
const isType = (name) => (node) => node.type === name || typeof node.type === "function" && node.type.name === name;

function play(id = NOW - 5000, symbol = "XAU/USD") {
  return { id, symbol, td: symbol, name: "Gold", market: "metal", interval: "15min", style: "intraday", method: "best", orderType: "limit",
    price: 3600, asOf: new Date(NOW - 60_000).toISOString(), status: "open",
    candles: [0, 1, 2].map((i) => ({ t: new Date(NOW - (3 - i) * 900_000).toISOString(), o: 3600 + i, h: 3603 + i, l: 3599 + i, c: 3601 + i })),
    signal: { direction: "LONG", status: "setup", entry: 3600, stopLoss: 3595, takeProfits: [3610, 3615], confidence: "Moderate", riskReward: "2:1", timeframe: "Intraday", rationale: "Saved reasoning", invalidation: "A close below 3595.", checklist: [{ label: "Retest", ok: true }] } };
}

// Real component handlers with controlled requests and clock. Nested charts/tickets
// remain inert nodes: a render or mode switch must never trigger their paid actions.
function harness(component, options = {}) {
  const file = component === "SignalGenerator" || component === "LivePrice" ? "src/components/portal/SignalGenerator.tsx"
    : component === "PlayDetail" ? "src/components/om/plays/PlayDetail.tsx" : "src/components/om/pulse/PulseHome.tsx";
  const filename = path.resolve(__dirname, "..", file);
  const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true }, fileName: filename,
  }).outputText;
  const slots = [], requests = [], timers = new Map(), listeners = new Map(), calls = [];
  const local = store(), session = options.session ?? store();
  if (options.recent) local.setItem("om_signals", JSON.stringify(options.recent));
  let experience = options.mode ?? "simple", props = options.props ?? {}, clock = NOW;
  let cursor = 0, effects = [], dirty = false, tree, timerId = 0, mounted = true;
  const changed = (a, b) => !a || !b || a.length !== b.length || b.some((value, i) => !Object.is(value, a[i]));
  const react = {
    useState(initial) { const i = cursor++; if (!slots[i]) slots[i] = { value: typeof initial === "function" ? initial() : initial }; return [slots[i].value, (next) => { if (!mounted) return; const value = typeof next === "function" ? next(slots[i].value) : next; if (!Object.is(value, slots[i].value)) { slots[i].value = value; dirty = true; } }]; },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useMemo(factory, deps) { const i = cursor++; if (!slots[i] || changed(slots[i].deps, deps)) slots[i] = { deps, value: factory() }; return slots[i].value; },
    useEffect(effect, deps) { const i = cursor++, before = slots[i]; if (!before || changed(before.deps, deps)) effects.push(() => { before?.cleanup?.(); slots[i] = { deps, cleanup: effect() }; }); },
  };
  react.useCallback = (fn, deps) => react.useMemo(() => fn, deps);
  const jsx = (type, value) => ({ type, props: value ?? {} });
  const timer = (fn, ms, repeat) => { const id = ++timerId; timers.set(id, { fn, ms, repeat }); return id; };
  class Clock extends Date { constructor(...args) { if (args.length) super(...args); else super(clock); } static now() { return clock; } }
  const context = vm.createContext({ Date: Clock, Math, Error, console, AbortController, URLSearchParams, Event,
    localStorage: local,
    window: { location: { search: options.search ?? "", pathname: "/portal/signals" }, sessionStorage: session,
      history: { replaceState() {} }, matchMedia: () => ({ matches: false }),
      addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: (name) => listeners.delete(name),
      dispatchEvent: (event) => listeners.get(event.type)?.(event) },
    document: { querySelector: () => null }, navigator: { clipboard: { writeText: (value) => calls.push(["copy", value]) } },
    requestAnimationFrame: (fn) => { fn(); return 1; },
    setTimeout: (fn, ms) => timer(fn, ms, false), clearTimeout: (id) => timers.delete(id),
    setInterval: (fn, ms) => timer(fn, ms, true), clearInterval: (id) => timers.delete(id),
    fetch: (url, init) => new Promise((resolve, reject) => { requests.push({ url, init, resolve, reject }); init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); }),
  });
  const mod = { exports: {} };
  const requireHere = (name) => {
    if (name === "react") return react;
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "Fragment" };
    if (name === "../simple/MarketStory") return { ...require("../src/components/om/simple/MarketStory.tsx"), MarketStory: "MarketStory" };
    if (name === "lucide-react") return new Proxy({}, { get: (_, key) => `icon:${String(key)}` });
    if (name === "next/link") return { __esModule: true, default: "Link" };
    if (name.endsWith(".css")) return {};
    if (name === "@/components/om/experience") return { useExperienceMode: () => ({ mode: experience, isSimple: experience === "simple" }) };
    if (name === "@/components/om/shell") return { useNextShell: () => true };
    if (name === "@/data/signalAssets") return assets;
    if (name === "@/lib/plays/lifecycle") return lifecycle;
    if (name === "@/lib/plays/diagnostics") return diagnostics;
    if (name === "@/lib/plays/intent") return { ...intent, takeGenerateIntent: (storage, nonce, td) => intent.takeGenerateIntent(storage, nonce, td, clock) };
    if (name === "@/lib/pulse/scan") return scan;
    if (name === "@/lib/atlas/chart") return { atlasPlayChart };
    if (name === "@/lib/atlas/signals") return { mergeSavedPlays, SIGNALS_UPDATED_EVENT };
    if (name === "@/lib/atlas/open") return { openAtlas: (value) => calls.push(["atlas", value]) };
    if (name === "@/lib/creditConfig") return { CREDIT_COST: { signal: 3, scan: 2, deepdive: 1 } };
    if (name === "@/lib/statsClock") return { statsSince: () => "2026-01-01T00:00:00Z" };
    if (name === "@/lib/earnMission") return { earnMission: async () => {} };
    if (name === "@/lib/floor/overview") return { accountName: () => "Account", maskAccount: String, money: String, ageText: (stamp, at) => `${Math.round((at - Date.parse(stamp)) / 1000)}s ago` };
    if (name === "@/lib/flow/display") return { pairName: String, lotsText: String, priceFor: (_symbol, value) => value == null ? "—" : String(value) };
    if (name === "./copykit") return { CopyAllBtn: "CopyAllBtn", buildTradeText: () => "saved levels" };
    if (name === "./quantUi") return { Levels: "Levels" };
    if (name === "./floor/DeepDive") return { DeepDiveModal: "DeepDiveModal" };
    if (name === "./TradeChat" || name === "@/components/portal/TradeChat") return { TradeChat: "TradeChat" };
    if (name === "@/components/om/plays/PlayDetail") return { PlayDetail: "PlayDetail" };
    if (name === "@/components/om/vision/VisionDirection") return { VisionDirection: "VisionDirection", VisionLevels: "VisionLevels" };
    if (name === "@/components/om/vision/VisionChart") return { VisionChart: "VisionChart" };
    if (name === "./PlayBreakdown") return { PlayBreakdown: "PlayBreakdown" };
    if (name === "@/components/om/ProductIcon") return { ProductIcon: "ProductIcon" };
    if (name === "@/components/om/MobileSection") return { MobileSection: "MobileSection" };
    throw new Error("Unexpected dependency: " + name);
  };
  const extra = component === "LivePrice" ? "exports.LivePrice=LivePrice;" : component === "Detail" ? "exports.Detail=Detail;" : "";
  vm.runInContext(`(function(require,module,exports){${compiled}\n${extra}\n})`, context, { filename })(requireHere, mod, mod.exports);
  function render(nextProps) { if (nextProps) props = { ...props, ...nextProps }; let turns = 0; do { assert.ok(turns++ < 25); cursor = 0; effects = []; dirty = false; tree = mod.exports[component](props); effects.forEach((effect) => effect()); } while (dirty); }
  render();
  return { requests, calls, render, find: (predicate) => nodes(tree, predicate), text: () => text(tree),
    mode(value) { experience = value; render(); },
    event(name, detail) { listeners.get(name)?.({ detail }); render(); },
    async reply(req, body, status = 200) { req.resolve({ ok: status >= 200 && status < 300, status, json: async () => body }); await drain(); render(); },
    async fail(req) { req.reject(new Error("Offline")); await drain(); render(); },
    advance(ms) { clock += ms; for (const value of timers.values()) if (value.repeat) value.fn(); render(); },
    fire(ms) { for (const [id, value] of [...timers]) if (!value.repeat && value.ms === ms) { timers.delete(id); value.fn(); } },
    unmount() { mounted = false; slots.forEach((slot) => slot?.cleanup?.()); },
  };
}

test("a late result check updates only its play and preserves a newer selection and newly received saved plays", async () => {
  const a = play(), b = play(NOW - 4000, "EUR/USD"), c = play(NOW - 1000, "GBP/USD");
  const h = harness("SignalGenerator", { recent: [a, b] });
  h.find(isType("PlayRow")).find((n) => n.props.r.id === a.id).props.onOpen(); h.render();
  const check = h.find(isType("PlayDetail"))[0].props.onCheck;
  check(); check(); h.render();
  const request = h.requests.find((r) => r.url === "/api/om-signal-check");
  assert.equal(h.requests.filter((r) => r.url === request.url).length, 1, "Rapid clicks share one result check");
  h.find(isType("PlayRow")).find((n) => n.props.r.id === b.id).props.onOpen(); h.render();
  h.event(SIGNALS_UPDATED_EVENT, { play: c });
  await h.reply(request, { status: "win", hitTp: 1, at: new Date(NOW).toISOString() });
  assert.equal(h.find(isType("PlayDetail"))[0].props.r.id, b.id);
  const saved = h.find(isType("PlayRow")).map((n) => n.props.r);
  assert.ok(saved.some((r) => r.id === c.id), "A later check cannot discard a play received while it was pending");
  assert.equal(saved.find((r) => r.id === a.id).status, "win");
  assert.equal(saved.find((r) => r.id === b.id).status, "open");
  const count = h.requests.length;
  h.mode("advanced"); h.mode("simple");
  assert.equal(h.find(isType("PlayDetail"))[0].props.r.id, b.id);
  assert.equal(h.requests.length, count, "Changing presentation cannot generate or execute a play");
  h.unmount();
});

test("deleting a play invalidates its in-flight result check so a late response cannot recreate it", async () => {
  const a = play(), h = harness("SignalGenerator", { recent: [a] });
  const row = h.find(isType("PlayRow"))[0];
  row.props.onCheck(); h.render();
  row.props.onDelete(); h.render();
  await h.reply(h.requests.find((r) => r.url === "/api/om-signal-check"), { status: "loss" });
  assert.equal(h.find(isType("PlayRow")).length, 0);
  assert.equal(h.requests.filter((r) => r.url === "/api/signals" && r.init?.method === "POST").length, 0);
  h.unmount();
});

test("authorized scalp and swing links pass their exact holding style to the paid request; ordinary links never generate", () => {
  for (const style of ["scalp", "swing"]) {
    const session = store(), nonce = intent.leaveGenerateIntent(session, "XAU/USD", style, NOW);
    const search = `?td=XAU%2FUSD&style=${style}&generate=${nonce}`;
    const h = harness("SignalGenerator", { session, search });
    const requests = h.requests.filter((r) => r.url === "/api/om-signal");
    assert.equal(requests.length, 1);
    assert.equal(JSON.parse(requests[0].init.body).style, style);
    assert.equal(JSON.parse(requests[0].init.body).td, "XAU/USD");
    h.mode("advanced"); h.mode("simple");
    assert.equal(h.requests.filter((r) => r.url === "/api/om-signal").length, 1);
    h.unmount();
    const repeated = harness("SignalGenerator", { session, search });
    assert.equal(repeated.requests.filter((r) => r.url === "/api/om-signal").length, 0);
    repeated.unmount();
  }
  const plain = harness("SignalGenerator", { search: "?td=XAU%2FUSD&style=swing&open=1" });
  assert.equal(plain.requests.filter((r) => r.url === "/api/om-signal").length, 0);
  plain.unmount();
});

test("manual quote refresh retains a dated fallback on failure and never labels a receipt as a live stream", async () => {
  const h = harness("LivePrice", { props: { td: "XAU/USD", entry: 3600, direction: "LONG", closed: true } });
  await h.reply(h.requests[0], { price: 3602 });
  assert.match(h.text(), /Price snapshot.*Fetched 0s ago.*may be delayed.*not streaming/);
  assert.doesNotMatch(h.text(), /Current price/);
  assert.ok(!h.find((n) => String(n.props.className).includes("animate-ping")).length);
  h.advance(60_000);
  assert.match(h.text(), /Fetched 60s ago/);
  assert.equal(h.requests.length, 1, "The age clock makes no provider request");
  const refresh = h.find((n) => n.props["aria-label"] === "Refresh price snapshot")[0];
  assert.equal(refresh.props.disabled, false, "A saved closed-session flag cannot prevent a new manual price read");
  refresh.props.onClick(); h.render();
  await h.fail(h.requests[1]);
  assert.match(h.text(), /Price refresh failed.*previous quote/);
  assert.match(h.text(), /3,602|3602/);
  assert.match(h.text(), /Fetched 60s ago/);
  h.unmount();
});

test("a late quote response cannot replace another symbol's snapshot", async () => {
  const h = harness("LivePrice", { props: { td: "XAU/USD", entry: 3600, direction: "LONG" } });
  const gold = h.requests[0];
  h.render({ td: "EUR/USD", entry: 1.1 });
  assert.equal(gold.init.signal.aborted, true);
  await h.reply(h.requests[1], { price: 1.12 });
  await h.reply(gold, { price: 3602 });
  assert.match(h.text(), /1\.12/); assert.doesNotMatch(h.text(), /3,602|3602/);
  h.unmount();
});

test("Simple saved plays retain original candles, every target, invalidation and execution review while Advanced restores the evidence grid", () => {
  const r = play(); r.signal.status = "no_trade"; r.signal.no_trade_reason = "Wait for a closed retest.";
  const h = harness("PlayDetail", { props: { r, madeMs: NOW, checking: false, updating: false,
    onCheck() {}, onUpdate() {}, onDive() {}, onAsk() {}, onClose() {}, update: null, live: "Quote receipt", ticket: "Execution review control", copy: "Copy saved levels", chat: null } });
  assert.equal(h.find(isType("VisionDirection")).length, 0);
  const chart = h.find(isType("VisionChart"))[0];
  assert.equal(chart.props.snapshot, true);
  assert.equal(chart.props.priceLive, false);
  assert.equal(chart.props.reference, true);
  const story = h.find(isType("MarketStory"))[0].props;
  assert.equal(story.feed, "recorded");
  assert.equal(story.stage, "forming");
  assert.match(story.next, /Wait for confirmation/);
  assert.ok(h.find(n => n.type === "details" && !n.props.open && text(n).includes("Plan prices and rules")).length);
  assert.match(h.text(), /Reference prices · confirmation required/);
  assert.match(h.text(), /Entry3600Stop loss3595Target 13610Target 23615/);
  assert.match(h.text(), /Cancel this idea if:.*A close below 3595/);
  assert.match(h.text(), /manual override.*Execution review control/);
  h.mode("advanced");
  assert.equal(h.find(isType("VisionDirection")).length, 1);
  assert.deepEqual(h.find(isType("VisionChart"))[0].props.levels, chart.props.levels);
  assert.equal(h.requests.length, 0);
  h.unmount();
});

test("Simple Pulse retains scan age and price levels without inventing a chart or confirming a stale scan", () => {
  const setup = { symbol: "XAU/USD", td: "XAU/USD", name: "Gold", dir: "LONG", price: 3600,
    confirmed: 4, total: 6, checklist: [{ label: "RSI factor", ok: true }], zone: "discount", rsi: 51,
    entry: 3600, stopLoss: 3595, takeProfits: [3610, 3615], riskReward: "2:1" };
  const home = harness("PulseHome", { props: { setups: [setup], loading: false, asOf: new Date(NOW - 20 * 60_000).toISOString(), msg: "Latest scan failed", hydrated: true, scan() {}, onDeepDive() {} } });
  assert.match(home.text(), /An earlier scan.*Scan again for current conditions/);
  assert.match(home.text(), /Leans up/);
  const meter = home.find(n => n.type === "meter")[0];
  assert.equal(meter.props.max, setup.total);
  assert.equal(meter.props.value, setup.confirmed);
  const detail = home.find(isType("Detail"))[0];
  assert.equal(detail.props.stale, true);
  const h = harness("Detail", { props: detail.props });
  const story = h.find(isType("MarketStory"))[0].props;
  assert.equal(story.feed, "delayed");
  assert.match(story.pausedNext, /new scan before making a plan/);
  assert.ok(h.find(n => n.type === "details" && !n.props.open && text(n).includes("Reference prices")).length);
  assert.match(h.text(), /Entry3600Stop3595Target 13610/);
  assert.match(h.text(), /not a confirmed trade|Not a confirmed setup/);
  assert.ok(h.find(n => n.type === "Link" && text(n) === "Open in OM AI Plays" && n.props.href.includes("td=XAU%2FUSD")).length);
  assert.match(h.text(), /Generating a play costs 3 credits/);
  assert.equal(h.find(isType("VisionChart")).length, 0);
  assert.equal(h.requests.length + home.requests.length, 0);
  h.render({ isSimple: false });
  assert.match(h.text(), /RSI51.*RSI factor/);
  assert.equal(h.requests.length, 0);
  h.unmount(); home.unmount();
});
