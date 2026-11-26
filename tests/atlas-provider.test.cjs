const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

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
const drain = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

// Real provider and card callbacks, isolated React hooks, deferred tool/network answers, and a native
// dialog stand-in. Nothing in this harness can contact a provider, microphone, or financial account.
function harness(relative = "src/components/om/atlas/AtlasProvider.tsx", name = "AtlasProvider", props = { children: "screen", configured: true, memberKey: "test-member" }, append = "", options = {}) {
  const filename = path.resolve(__dirname, "..", relative);
  const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8") + append, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true }, fileName: filename,
  }).outputText;
  const slots = [], requests = [], tools = [], scans = [], starts = [], voiceUpdates = [], inputModes = [], windowPurchases = [], atlasRequests = [], marketUpdates = [], mainGenerations = [], navigation = [], writes = [], events = new Map(), storage = new Map();
  const timers = new Map(); let timerId = 0;
  const interval = (callback, ms) => { const id = ++timerId; timers.set(id, { callback, ms, repeat: true }); return id; };
  const timeout = (callback, ms) => { const id = ++timerId; timers.set(id, { callback, ms, repeat: false }); return id; };
  const vmDate = options.now == null ? Date : class extends Date {
    constructor(...args) { if (args.length) super(...args); else super(options.now); }
    static now() { return options.now; }
  };
  let cursor = 0, pendingEffects = [], dirty = false, tree, ended = 0;
  const voice = { status: "idle", activity: "off", micMuted: false, speakerMuted: false, needsSubscription: false, error: null, partial: null };
  class Element {
    constructor() { this.open = false; this.focused = 0; this.showCount = 0; }
    focus() { this.focused++; document.activeElement = this; }
    showModal() { this.open = true; this.showCount++; }
    close() { this.open = false; }
    scrollTo() {}
    getBoundingClientRect() { return { left: 0, right: 400, top: 0, bottom: 800 }; }
  }
  const dialog = new Element(), opener = new Element();
  const document = { activeElement: opener, visibilityState: "visible", documentElement: { classList: { add() {}, remove() {} } }, addEventListener() {}, removeEventListener() {} };
  const window = {
    location: { pathname: "/portal/trading", search: "", assign: (href) => navigation.push(href) },
    addEventListener: (type, handler) => { if (!events.has(type)) events.set(type, new Set()); events.get(type).add(handler); },
    removeEventListener: (type, handler) => events.get(type)?.delete(handler),
    dispatchEvent: (event) => { for (const handler of events.get(event.type) ?? []) handler(event); return true; },
    setTimeout: timeout, clearTimeout: (id) => timers.delete(id), setInterval: interval, clearInterval: (id) => timers.delete(id),
  };
  const changed = (before, after) => !before || !after || before.length !== after.length || after.some((x, i) => !Object.is(x, before[i]));
  const react = {
    createContext: () => ({ Provider: "PanelContext" }), useContext: () => ({ open: false }),
    useState(initial) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { value: typeof initial === "function" ? initial() : initial };
      return [slots[index].value, (next) => { const value = typeof next === "function" ? next(slots[index].value) : next; if (!Object.is(value, slots[index].value)) { slots[index].value = value; dirty = true; } }];
    },
    useRef(initial) { const index = cursor++; if (!slots[index]) slots[index] = { current: initial }; return slots[index]; },
    useMemo(factory, deps) { const index = cursor++; if (!slots[index] || changed(slots[index].deps, deps)) slots[index] = { deps, value: factory() }; return slots[index].value; },
    useEffect(effect, deps) { const index = cursor++, before = slots[index]; if (!before || changed(before.deps, deps)) pendingEffects.push(() => { before?.cleanup?.(); slots[index] = { deps, cleanup: effect() }; }); },
  };
  react.useCallback = (callback, deps) => react.useMemo(() => callback, deps);
  const jsx = (type, nodeProps) => ({ type, props: nodeProps || {} });
  const findAsset = (td) => ["BTC/USD", "XAU/USD", "EUR/USD"].includes(td) ? { asset: { td } } : null;
  const links = Object.fromEntries(["floor", "plays", "genx", "pulse", "flow", "credits", "tools", "command-center"].map((key) => [key, { href: `/${key}`, label: key }]));
  const bus = { ready: () => true, start: (c) => starts.push(c), end: () => { ended++; voice.status = "idle"; }, get: () => voice, sendText: () => false, setMicMuted() {}, setSpeakerMuted() {}, setInputMode: (mode) => inputModes.push(mode), updateContext: (context) => voiceUpdates.push(context) };
  const deps = {
    "../simple/MarketStory": { ...require("../src/components/om/simple/MarketStory.tsx"), MarketStory: "MarketStory" },
    react, "react/jsx-runtime": { jsx, jsxs: jsx },
    "next/navigation": { useRouter: () => ({ push: (href) => navigation.push(href) }), usePathname: () => "/portal/trading", useSearchParams: () => new URLSearchParams() },
    "next/link": { __esModule: true, default: "Link" },
    "lucide-react": new Proxy({}, { get: (_, key) => `icon:${String(key)}` }),
    "@/components/command-center/VoiceSession": { VoiceSession: "VoiceSession" },
    "@/components/command-center/voiceBus": { appVoiceBus: bus, voiceBus: { get: () => ({ status: "idle" }), end() {} }, useAppVoiceBus: () => voice, lineOpen: (s) => ["connecting", "awaiting_mic", "listening", "speaking", "muted"].includes(s) },
    "@/components/om/FlowAccount": { useFlowAccount: () => ({ switching: false, ov: { account: { id: "owned-test-account", environment: "demo" } } }) },
    "@/components/om/ProductIcon": { ProductIcon: "ProductIcon" },
    "@/components/om/experience": { useExperienceMode: () => ({ mode: options.mode ?? "advanced", isSimple: options.mode === "simple", setMode: (mode) => { options.mode = mode; dirty = true; } }) },
    "@/data/signalAssets": { findAsset, MARKETS: [{ id: "crypto", name: "Crypto", assets: [{ td: "BTC/USD", name: "Bitcoin", symbol: "BTC/USD" }] }] },
    "@/lib/atlas/open": { ATLAS_OPEN_EVENT: "om:atlas:open", ATLAS_CONTEXT_EVENT: "om:atlas:context", openAtlas: (detail = {}) => { atlasRequests.push(detail); window.dispatchEvent({ type: "om:atlas:open", detail }); }, updateAtlasContext: (key, context) => marketUpdates.push({ key, context }) },
    "@/lib/atlas/actions": { atlasMessages: (m) => m.map(({ role, content }) => ({ role, content })), normalizeAtlasActions: (a) => Array.isArray(a) ? a : [], planAtlasActions: () => [] },
    "@/lib/atlas/signals": {
      atlasPlayResult: (r) => r?.signal ? r : null, atlasGenxResult: (r) => r?.genx ? r : null,
      restoreAtlasSignalResult: require("../src/lib/atlas/signals.ts").restoreAtlasSignalResult,
      atlasSignalContext: (s) => ({ source: "OM AI Plays", label: "BTC/USD", data: s.result }),
      generateAtlasSignal: (request, signal, isCurrent) => new Promise((resolve, reject) => tools.push({ request, signal, isCurrent, resolve, reject })),
    },
    "@/lib/atlas/pulse": { scanWithAtlas: (isCurrent) => new Promise((resolve, reject) => scans.push({ isCurrent, resolve, reject })), parseAtlasPulseResult: (p) => p && Array.isArray(p.setups) && typeof p.asOf === "string" ? p : null },
    "./AtlasActionCard": { AtlasActionCard: "AtlasActionCard", AtlasPulseCard: "AtlasPulseCard", ATLAS_LINKS: links },
    "./AtlasSignalCard": { AtlasSignalCard: "AtlasSignalCard" },
    "./AtlasVoiceConversation": { AtlasVoiceConversation: "AtlasVoiceConversation" },
    "@/lib/atlas/commandSignal": {
      AtlasCommandSignalError: require("../src/lib/atlas/commandSignal.ts").AtlasCommandSignalError,
      atlasCommandSignalSupported: (symbol) => symbol === "XAUUSD",
      requestAtlasCommandSignal: (symbol, options) => new Promise((resolve, reject) => tools.push({ symbol, options, resolve, reject })),
      loadAtlasCommandAccess: async () => ({ active: false, admin: false, expiresAt: null, cost: 5, minutes: 30, balance: 10 }),
      openAtlasCommandWindow: async () => { windowPurchases.push("explicit-open"); return { active: true }; },
    },
    "@/components/om/chart/OmChart": { OmChart: "OmChart" },
    "@/components/om/atlas/AtlasCommandSignal": { AtlasCommandSignalPanel: "AtlasCommandSignalPanel", useAtlasCommandSignal: ({ symbol, disabled }) => ({
      supported: require("../src/lib/atlas/commandSignal.ts").atlasCommandSignalSupported(symbol), busy: false,
      generate: () => { if (!disabled) mainGenerations.push(symbol); },
    }) },
    "@/lib/floor/marketIntelligence": require("../src/lib/floor/marketIntelligence.ts"),
    "@/lib/floor/atlasChartFocus": require("../src/lib/floor/atlasChartFocus.ts"),
    "@/lib/floor/atlasQuote": require("../src/lib/floor/atlasQuote.ts"),
    "@/lib/chart/candleTime": require("../src/lib/chart/candleTime.ts"),
    "@/lib/cashtrap/marketHours": require("../src/lib/cashtrap/marketHours.ts"),
    "@/lib/floor/chart": require("../src/lib/floor/chart.ts"),
    "@/lib/creditConfig": { CREDIT_COST: { signal: 3, genx: 5, scan: 5 } },
    "@/lib/floor/nav": require("../src/lib/floor/nav.ts"),
    "./InstallApp": { useInstall: () => ({ asApp: false, offer: false, install: async () => null }) },
    "./atlas/AtlasProvider": { useAtlasPanel: () => ({ open: false }) },
    "./dock-gesture": require("../src/components/om/dock-gesture.ts"),
  };
  const context = vm.createContext({
    Date: vmDate, Math, Error, console, Event, URLSearchParams, AbortController, HTMLElement: Element, document, window,
    setInterval: interval, clearInterval: (id) => timers.delete(id), setTimeout: timeout, clearTimeout: (id) => timers.delete(id),
    requestAnimationFrame: (callback) => { callback(); return 1; }, cancelAnimationFrame() {},
    sessionStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => { writes.push({ key, value }); storage.set(key, value); } },
    fetch: (url, init) => { if (url === "/api/credits") return Promise.resolve({ ok: true, json: async () => ({ pass: false }) }); return new Promise((resolve, reject) => requests.push({ url, init, resolve, reject })); },
  });
  const module = { exports: {} };
  vm.runInContext(`(function(require,module,exports){${compiled}\n})`, context, { filename })((key) => deps[key] ?? {}, module, module.exports);
  function render(nextProps) {
    if (nextProps) props = { ...props, ...nextProps };
    let turns = 0;
    do {
      assert.ok(turns++ < 20, "Provider settles without a render loop");
      cursor = 0; dirty = false; pendingEffects = [];
      tree = module.exports[name](props);
      for (const node of nodes(tree, (n) => n.props?.ref && typeof n.props.ref === "object")) node.props.ref.current = node.type === "dialog" ? dialog : new Element();
      const effects = pendingEffects; pendingEffects = []; effects.forEach((effect) => effect());
    } while (dirty);
    return tree;
  }
  render();
  return {
    render, value: () => tree, nodes: (pred) => nodes(tree, pred), tools, scans, requests, starts, voiceUpdates, inputModes, windowPurchases, atlasRequests, marketUpdates, mainGenerations, navigation, voice, storage, writes, dialog, opener,
    ended: () => ended,
    open: (detail = {}) => { window.dispatchEvent({ type: "om:atlas:open", detail }); render(); },
    updateContext: (key, context) => { window.dispatchEvent({ type: "om:atlas:context", detail: { key, context } }); render(); },
    poll: (ms) => { for (const timer of [...timers.values()]) if (timer.repeat && timer.ms === ms) timer.callback(); },
    button: (label) => { const found = nodes(tree, (n) => n.type === "button" && (n.props["aria-label"] === label || content(n) === label)); assert.equal(found.length, 1, label); return found[0]; },
    unmount: () => { slots.forEach((s) => s?.cleanup?.()); },
  };
}

const SNAPSHOT_NOW = Date.parse("2026-11-24T20:04:00Z");
const byClass = (h, name) => h.nodes((node) => String(node.props.className ?? "").split(/\s+/).includes(name));
function mainSnapshot(symbol = "XAUUSD") {
  const { buildAtlasMarketSnapshot } = require("../src/lib/floor/marketIntelligence.ts");
  const base = symbol === "XAUUSD" ? 4000 : 1.1, scale = symbol === "XAUUSD" ? 1 : .0001;
  const bars = Array.from({ length: 65 }, (_, i) => {
    const c = base + Math.sin(i * Math.PI / 4) * 2 * scale;
    return { t: SNAPSHOT_NOW - 120_000 - (65 - i) * 900_000, o: c - .1 * scale, h: c + .5 * scale, l: c - .5 * scale, c };
  });
  return buildAtlasMarketSnapshot({ symbol, now: SNAPSHOT_NOW, marketOpen: true, frames: { "15m": { bars, fetchedAt: SNAPSHOT_NOW, timeKnown: true } } });
}
function mainDesk(mode = "advanced") {
  return harness("src/components/om/floor/AtlasLiveDesk.tsx", "AtlasLiveDesk", {
    goldSetup: null, goldFailed: false, atlasRead: null, sample: false, tf: "intraday", onTf() {},
  }, "", { now: SNAPSHOT_NOW, mode });
}
function mainTick(symbol, price, age = 1000) {
  const at = new Date(SNAPSHOT_NOW - age).toISOString();
  return { symbol, price, receivedAt: at, providerAt: at };
}
const answer = (request, body) => request.resolve({ ok: true, json: async () => body });

test("the main Atlas desk retains dated structure but withholds live opportunities and Explain context until a fresh quote arrives", async () => {
  const { atlasMarketView } = require("../src/lib/floor/marketIntelligence.ts");
  const snapshot = mainSnapshot(), view = atlasMarketView(snapshot, "15m", 4003, SNAPSHOT_NOW);
  assert.equal(view.frame.status, "ready", "The candle analysis is ready; only the quote is stale");
  assert.ok(view.trigger && view.crossedLevel && view.readiness.steps.length > 0, "The real structure fixture has actionable-looking observations to gate");
  const h = mainDesk();
  answer(h.requests.find((r) => r.url.includes("market-intelligence")), snapshot);
  answer(h.requests.find((r) => r.url === "/api/floor/atlas-ticks"), { ticks: [mainTick("XAU/USD", 4003, 90_000)] });
  await drain(); h.render();

  assert.match(content(byClass(h, "om-snapshot-stage")[0]), /Waiting for a fresh quote/);
  assert.equal(byClass(h, "om-snapshot-opportunity")[0].props["data-state"], "unavailable");
  for (const name of ["om-snapshot-trigger", "om-snapshot-steps", "om-snapshot-invalidation", "om-snapshot-crossed", "om-snapshot-alternative"]) {
    assert.equal(byClass(h, name).length, 0, `${name} cannot describe an old quote as a current watch`);
  }
  const chart = h.nodes((n) => n.type === "OmChart")[0];
  assert.equal(chart.props.priceLive, false);
  assert.equal(chart.props.bars.length, 65, "Real timestamped candles remain available for inspection");
  assert.match(content(byClass(h, "om-snapshot-brief")[0]), /Last recorded.*Waiting for a fresh quote/);

  byClass(h, "om-terminal-explain")[0].props.onClick();
  const read = h.atlasRequests.at(-1).context.data.marketRead;
  assert.equal(read.stale, true);
  assert.equal(read.readiness.label, "Waiting for a fresh quote");
  assert.equal(read.readiness.steps.length, 0);
  for (const key of ["trigger", "alternative", "invalidation", "activeZone", "crossedLevel"]) assert.equal(read[key], null, key);
  assert.equal(read.flow.length, 6);
  assert.ok(read.support || read.resistance, "Dated support/resistance observations are still explained honestly");
  assert.equal(h.marketUpdates.at(-1).context.data.marketRead.readiness.steps.length, 0, "An open voice conversation gets the same freshness gate");

  h.poll(1500);
  answer(h.requests.filter((r) => r.url === "/api/floor/atlas-ticks").at(-1), { ticks: [mainTick("XAU/USD", 4003)] });
  await drain(); h.render();
  assert.doesNotMatch(content(byClass(h, "om-snapshot-stage")[0]), /Waiting for a fresh quote/);
  assert.equal(byClass(h, "om-snapshot-trigger").length, 1);
  assert.equal(byClass(h, "om-snapshot-steps").length, 1);
  assert.equal(h.nodes((n) => n.type === "OmChart")[0].props.priceLive, true);
  assert.equal(h.marketUpdates.at(-1).context.data.marketRead.stale, false);
  assert.equal(h.mainGenerations.length + h.tools.length + h.windowPurchases.length, 0);
  assert.ok(h.requests.every((r) => !r.init?.method || r.init.method === "GET"), "Reading, refreshing and Explain do not request paid generation or execution");
  h.unmount();
});

test("switching the main desk to FX updates Explain and voice context while keeping the real Gold-only Atlas generator disabled", async () => {
  const h = mainDesk();
  answer(h.requests.find((r) => r.url.includes("market-intelligence")), mainSnapshot());
  answer(h.requests.find((r) => r.url === "/api/floor/atlas-ticks"), { ticks: [mainTick("XAU/USD", 4003), mainTick("EUR/USD", 1.1003)] });
  await drain(); h.render();
  assert.equal(h.button("Generate Atlas Command Center signal").props.disabled, false);
  const marketButton = h.nodes((n) => n.type === "button" && n.props["aria-pressed"] !== undefined && content(n).includes("EUR/USD"))[0];
  marketButton.props.onClick(); h.render();
  assert.equal(h.button("Generate Atlas Command Center signal").props.disabled, true, "Changing the market immediately disables a Gold-only action");
  const euroRequest = h.requests.find((r) => r.url === "/api/floor/market-intelligence?symbol=EURUSD");
  assert.ok(euroRequest);
  answer(euroRequest, mainSnapshot("EURUSD"));
  await drain(); h.render();

  assert.equal(byClass(h, "om-market-snapshot")[0].props["data-market"], "EURUSD");
  assert.equal(h.button("Generate Atlas Command Center signal").props.disabled, true);
  assert.match(content(byClass(h, "om-snapshot-gold-note")[0]), /signal engine trades Gold/);
  assert.equal(h.nodes((n) => n.type === "AtlasCommandSignalPanel")[0].props.controller.supported, false);
  assert.equal(h.marketUpdates.at(-1).context.data.symbol, "EURUSD");
  byClass(h, "om-terminal-explain")[0].props.onClick();
  assert.equal(h.atlasRequests.at(-1).context.data.symbol, "EURUSD");
  assert.equal(h.atlasRequests.at(-1).context.data.price, 1.1003);
  byClass(h, "om-live-talk")[0].props.onClick();
  const voiceRequest = h.atlasRequests.at(-1);
  assert.equal(voiceRequest.voice, true);
  assert.equal(voiceRequest.context.data.symbol, "EURUSD");
  assert.equal(voiceRequest.followContext, "atlas-market-snapshot");
  assert.equal(h.mainGenerations.length + h.tools.length + h.windowPurchases.length, 0);
  assert.ok(h.requests.every((r) => r.url.startsWith("/api/floor/") && (!r.init?.method || r.init.method === "GET")), "Market selection and conversation intent have no generation, purchase or trade side effects");
  h.unmount();
});

test("a failed Atlas refresh stays suspended through retry and market switches until that market receives a verified success", async () => {
  for (const mode of ["simple", "advanced"]) {
    const h = mainDesk(mode), snapshot = mainSnapshot();
    const latest = (symbol) => h.requests.filter((r) => r.url === "/api/floor/market-intelligence?symbol=" + symbol).at(-1);
    const read = () => h.marketUpdates.at(-1).context.data.marketRead;
    const select = (symbol) => {
      const label = symbol === "XAUUSD" ? mode === "simple" ? "Gold" : "XAU/USD" : "EUR/USD";
      const button = h.nodes((n) => n.type === "button" && n.props["aria-pressed"] !== undefined && content(n).includes(label))[0];
      assert.ok(button); button.props.onClick(); h.render();
    };
    const suspended = () => {
      assert.equal(read().stale, true, mode);
      assert.equal(read().readiness.label, "Refresh needed");
      for (const key of ["trigger", "activeZone", "crossedLevel", "alternative", "invalidation"]) assert.equal(read()[key], null, key);
      assert.equal(read().readiness.steps.length, 0);
      assert.equal(byClass(h, mode === "simple" ? "om-simple-watch-price" : "om-snapshot-trigger").length, 0);
      assert.equal(h.nodes((n) => n.type === "OmChart")[0].props.bars.length, 65, "Keep the genuine recorded chart available");
    };
    answer(latest("XAUUSD"), snapshot);
    answer(h.requests.find((r) => r.url === "/api/floor/atlas-ticks"), { ticks: [mainTick("XAU/USD", 4003), mainTick("EUR/USD", 1.1003)] });
    await drain(); h.render();
    assert.equal(read().stale, false);
    assert.ok(read().trigger, "The starting fixture really has a current watch");

    h.poll(30_000);
    latest("XAUUSD").reject(new Error("Refresh unavailable"));
    await drain(); h.render(); suspended();
    h.button("Refresh market snapshot").props.onClick(); h.render();
    const abandonedRetry = latest("XAUUSD");
    suspended();

    select("EURUSD");
    answer(abandonedRetry, snapshot);
    answer(latest("EURUSD"), mainSnapshot("EURUSD"));
    await drain(); h.render();
    assert.equal(h.marketUpdates.at(-1).context.data.symbol, "EURUSD");
    assert.equal(read().stale, false, "The other market can recover independently");
    select("XAUUSD"); suspended();
    answer(latest("XAUUSD"), snapshot);
    await drain(); h.render();
    assert.equal(read().stale, false, "Only the active market's verified response clears its failure");
    assert.ok(read().trigger);
    assert.equal(h.mainGenerations.length + h.tools.length + h.windowPurchases.length, 0);
    assert.ok(h.requests.every((r) => !r.init?.method || r.init.method === "GET"));
    h.unmount();
  }
});

test("Atlas opens in place, starts requested voice with context, and closing stops voice only", () => {
  const h = harness();
  assert.equal(h.dialog.open, false);
  assert.equal(h.tools.length + h.scans.length + h.requests.length, 0);
  h.open({ voice: true, context: { source: "floor", label: "Gold", data: { td: "XAU/USD", asOf: "2026-11-21T16:00:00Z", levelsLocked: true } } });
  assert.equal(h.dialog.open, true);
  assert.equal(h.starts.length, 1);
  assert.deepEqual(h.inputModes, ["hands_free"], "The original Talk gesture starts a conversation without a push-to-talk setting");
  assert.equal(h.nodes((n) => n.type === "AtlasVoiceConversation").length, 1, "Voice has a visible listening/reply surface");
  assert.equal(h.starts[0].result.kind, "floor", "Floor gold context reaches voice with its own source");
  assert.equal(h.starts[0].result.data.levelsLocked, true);
  const beforeEnd = h.ended();
  h.button("Close Atlas").props.onClick(); h.render();
  assert.equal(h.dialog.open, false);
  assert.equal(h.ended(), beforeEnd + 1);
  assert.equal(h.opener.focused > 0, true, "Focus returns to the original app control");
  assert.equal(h.navigation.length, 0);
  assert.equal(h.tools.length + h.scans.length + h.requests.length, 0, "Closing does not request trades or change account settings");
});

test("live market updates follow only explicitly tracked conversations and never start or bill a turn", () => {
  const h = harness();
  const gold = { source: "floor", label: "XAU/USD · Snapshot", data: { symbol: "XAUUSD", marketRead: { trend: "bullish", stale: false } } };
  const euro = { source: "floor", label: "EUR/USD · Snapshot", data: { symbol: "EURUSD", marketRead: { trend: "bearish", stale: false } } };
  h.updateContext("market-snapshot", gold);
  assert.equal(h.dialog.open, false);
  assert.equal(h.starts.length + h.voiceUpdates.length, 0);
  h.open({ voice: true, context: gold, followContext: "market-snapshot" });
  h.voice.status = "listening";
  h.updateContext("unrelated-screen", euro);
  assert.equal(h.voiceUpdates.at(-1).result.data.symbol, "XAUUSD");
  h.updateContext("market-snapshot", euro);
  assert.equal(h.voiceUpdates.at(-1).result.data.symbol, "EURUSD");
  assert.equal(h.nodes((n) => n.type === "AtlasVoiceConversation")[0].props.contextLabel, euro.label);
  assert.equal(h.starts.length, 1, "A context update does not reconnect the microphone");
  assert.equal(h.requests.length + h.tools.length + h.scans.length, 0, "No chat, generation, purchase or execution request accompanies a market update");
  h.open({ context: { source: "floor", label: "Saved Atlas signal", data: { symbol: "XAUUSD" } } });
  const before = h.voiceUpdates.length;
  h.updateContext("market-snapshot", euro);
  assert.equal(h.voiceUpdates.length, before, "An explicitly selected saved result stops following the market snapshot");
  h.button("Close Atlas").props.onClick(); h.render();
  h.updateContext("market-snapshot", gold);
  assert.equal(h.dialog.open, false);
});

test("Explain honors explicit context tracking after its initial dated question without sending another turn", async () => {
  const h = harness();
  const gold = { source: "floor", label: "XAU/USD · Atlas Live", data: { symbol: "XAUUSD", marketRead: { stale: false } } };
  const euro = { source: "floor", label: "EUR/USD · Atlas Live", data: { symbol: "EURUSD", marketRead: { stale: true, trigger: null } } };
  h.open({ question: "Explain this market snapshot.", context: gold, followContext: "atlas-market-snapshot" });
  assert.equal(h.requests.length, 1);
  assert.equal(JSON.parse(h.requests[0].init.body).context.result.data.symbol, "XAUUSD", "The requested explanation uses its captured market");
  h.updateContext("atlas-market-snapshot", euro);
  assert.match(content(byClass(h, "om-atlas-context")[0]), /EUR\/USD/);
  assert.equal(h.requests.length, 1, "Following a changed market does not submit another question or credit charge");
  assert.equal(h.starts.length + h.tools.length + h.windowPurchases.length, 0);
  answer(h.requests[0], { reply: "This answer describes the selected Gold snapshot at the time you asked.", actions: [] });
  await drain(); h.render();
  assert.match(content(byClass(h, "om-atlas-context")[0]), /EUR\/USD/, "The pending dated answer cannot revert the newer selected context");
  h.unmount();
});

test("the command signal hook drops old gold results even after switching away and back", async () => {
  const h = harness("src/components/om/atlas/AtlasCommandSignal.tsx", "useAtlasCommandSignal", { symbol: "XAUUSD", disabled: false });
  assert.equal(h.tools.length + h.windowPurchases.length, 0, "Mounting performs no generation or purchase");
  h.value().generate(); h.value().generate(); h.render();
  assert.equal(h.tools.length, 1, "Concurrent clicks have one request");
  h.render({ symbol: "EURUSD" });
  assert.equal(h.value().supported, false);
  assert.equal(h.value().busy, false);
  h.render({ symbol: "XAUUSD" });
  h.value().generate(); h.render();
  assert.equal(h.tools.length, 2);
  h.tools[0].resolve({ idea: { id: "old" } }); await drain(); h.render();
  assert.equal(h.value().result, null);
  assert.equal(h.value().busy, true, "The obsolete response cannot end the current request");
  const newest = { idea: { id: "new" } };
  h.tools[1].resolve(newest); await drain(); h.render();
  assert.equal(h.value().result, newest);
  h.render({ disabled: true }); h.value().generate();
  assert.equal(h.tools.length, 2, "Illustrative/disabled views cannot generate");
});

test("the command signal hook purchases a window only after showing access and an explicit second action", async () => {
  const { AtlasCommandSignalError } = require("../src/lib/atlas/commandSignal.ts");
  const h = harness("src/components/om/atlas/AtlasCommandSignal.tsx", "useAtlasCommandSignal", { symbol: "XAUUSD" });
  await h.value().openWindowAndGenerate();
  assert.equal(h.windowPurchases.length, 0, "There is no purchase before server pricing is available");
  h.value().generate(); h.render();
  h.tools[0].reject(new AtlasCommandSignalError("pass_required", "A window is needed")); await drain(); h.render();
  assert.equal(h.value().access.cost, 5);
  assert.equal(h.value().access.minutes, 30);
  assert.equal(h.windowPurchases.length, 0, "The 402 is not accepted automatically");
  h.value().openWindowAndGenerate(); await drain(); h.render();
  assert.equal(h.windowPurchases.length, 1);
  assert.equal(h.tools.length, 2, "Only the explicit Open & generate action continues to the Atlas engine");
  h.tools[1].resolve({ idea: { id: "paid-window-call" } }); await drain(); h.render();
});

test("a prepared signal does no work until tapped; result survives closing and disables its completed action", async () => {
  const h = harness();
  h.open({ tool: "plays", context: { source: "Pulse", label: "Bitcoin", data: { td: "BTC/USD", style: "swing" } } });
  let card = h.nodes((n) => n.type === "AtlasActionCard")[0];
  assert.equal(card.props.action.td, "BTC/USD");
  assert.equal(card.props.action.style, "swing");
  assert.equal(h.tools.length, 0);
  card.props.onRun(card.props.action); card.props.onRun(card.props.action); h.render();
  assert.equal(h.tools.length, 1, "Concurrent taps cannot generate twice");
  h.button("Close Atlas").props.onClick(); h.render();
  const signal = { kind: "plays", saved: "synced", result: { id: 1, td: "BTC/USD", symbol: "BTC/USD", asOf: "2026-11-21T16:00:00Z", signal: { direction: "SHORT" } } };
  h.tools[0].resolve(signal); await drain(); h.render();
  assert.equal(h.dialog.open, false, "A completed read does not reopen the closed dialog");
  h.open();
  card = h.nodes((n) => n.type === "AtlasActionCard")[0];
  assert.equal(card.props.completed, true);
  assert.equal(h.nodes((n) => n.type === "AtlasSignalCard")[0].props.signal, signal);
  assert.equal(h.navigation.length, 0);
});

test("contextual questions include the exact result and selected account, then keep the answer in the dialog", async () => {
  const h = harness();
  const data = { td: "BTC/USD", entry: 90000, stopLoss: 90500, asOf: "2026-11-21T16:00:00Z", status: "no_trade" };
  h.open({ question: "Explain this idea.", context: { source: "OM AI Plays", label: "BTC/USD", data } });
  assert.equal(h.requests.length, 1);
  const request = h.requests[0], body = JSON.parse(request.init.body);
  assert.equal(request.url, "/api/atlas/chat");
  assert.deepEqual(body.context.result, { kind: "plays", data });
  assert.deepEqual(body.context.account, { id: "owned-test-account", environment: "demo" });
  request.resolve({ ok: true, json: async () => ({ reply: "This is still an unconfirmed idea.", actions: [] }) });
  await drain(); h.render();
  assert.ok(h.nodes((n) => n.type === "p").some((n) => content(n) === "This is still an unconfirmed idea."));
  assert.equal(h.dialog.open, true);
  assert.equal(h.tools.length + h.scans.length, 0);
});

test("text and tool users only see the voice plan after asking to start voice", () => {
  const h = harness();
  h.voice.status = "locked"; h.voice.needsSubscription = true; h.render();
  h.open({ tool: "genx" });
  const settings = () => h.nodes((n) => n.props?.className === "om-atlas-voice-settings")[0];
  assert.equal(settings().props.hidden, true, "Opening a tool does not show a voice upsell");
  h.button("Talk to Atlas").props.onClick(); h.render();
  assert.equal(settings().props.hidden, false, "The voice attempt explains its plan in place");
  h.button("Close Atlas").props.onClick(); h.render(); h.open();
  assert.equal(settings().props.hidden, true);
  assert.equal(h.tools.length + h.scans.length + h.requests.length, 0);
});

test("a failed read preserves the prepared action and offers no automatic retry or credit detour", async () => {
  const h = harness();
  h.open({ tool: "genx" });
  const card = h.nodes((n) => n.type === "AtlasActionCard")[0];
  card.props.onRun(card.props.action); h.render();
  h.tools[0].reject(new Error("The market data service is unavailable. Your previous read is still saved."));
  await drain(); h.render();
  const updated = h.nodes((n) => n.type === "AtlasActionCard")[0];
  assert.equal(updated.props.completed, false);
  assert.equal(updated.props.disabled, false);
  assert.equal(h.tools.length, 1);
  assert.equal(h.nodes((n) => n.type === "button" && content(n).includes("Check credits")).length, 0);
  assert.ok(h.nodes((n) => n.props?.role === "alert").some((n) => content(n).includes("market data service")));
  assert.equal(h.navigation.length, 0);
});

test("the action card requires a market and preserves chosen style at its priced tap", () => {
  const ran = [];
  const h = harness("src/components/om/atlas/AtlasActionCard.tsx", "AtlasActionCard", { action: { type: "plays" }, busy: false, disabled: false, completed: false, pass: false, onRun: (a) => ran.push(a), onNavigate: () => {} });
  assert.equal(h.button("Generate play · 3 credits").props.disabled, true);
  h.nodes((n) => n.type === "select" && n.props["aria-label"] === "Market for Atlas play")[0].props.onChange({ target: { value: "BTC/USD" } });
  h.nodes((n) => n.type === "select" && n.props["aria-label"] === "Style for Atlas play")[0].props.onChange({ target: { value: "swing" } });
  h.render();
  assert.equal(ran.length, 0);
  assert.equal(h.button("Generate play · 3 credits").props.disabled, false);
  h.button("Generate play · 3 credits").props.onClick();
  assert.equal(JSON.stringify(ran), JSON.stringify([{ type: "plays", td: "BTC/USD", style: "swing" }]));
  h.render({ completed: true });
  assert.equal(h.button("Result added below").props.disabled, true);
});

test("header Ask Atlas opens the conversation, while dock Atlas keeps its Command Center destination", () => {
  const h = harness("src/components/om/AppShell.tsx", "TestBar", { member: { name: "Test", email: null, admin: false }, configured: true, preview: false, look: "graphite", onLook: () => {} }, "\nexport { Bar as TestBar };\n");
  const target = h.button("Ask Atlas");
  assert.equal(target.props["aria-haspopup"], "dialog");
  assert.equal(target.props.href, undefined);
  target.props.onClick();
  assert.equal(h.atlasRequests.length, 1, "The header requests the in-place conversation");
  assert.equal(h.navigation.length, 0);
  assert.equal(h.requests.length + h.tools.length + h.scans.length, 0, "Opening the conversation does not generate or execute");

  const dock = harness("src/components/om/AppShell.tsx", "TestDock", {}, "\nexport { AppDock as TestDock };\n");
  const atlas = dock.nodes((node) => node.props?.["data-app"] === "atlas");
  assert.equal(atlas.length, 1, "The dock has one Atlas destination");
  assert.equal(atlas[0].type, "a", "Command Center retains a native navigation link");
  assert.equal(atlas[0].props["aria-label"], "Atlas Command Center");
  assert.equal(atlas[0].props.href, "/command-center");
  assert.equal(atlas[0].props["aria-haspopup"], undefined);
  let prevented = false;
  atlas[0].props.onClick({ preventDefault: () => { prevented = true; }, ctrlKey: true });
  assert.equal(prevented, false, "Modified clicks remain normal browser navigation");
  assert.equal(dock.atlasRequests.length, 0, "The specialist dock destination does not open generic chat");
});

test("switching members restores that member's history and drops another member's delayed chat", async () => {
  const h = harness();
  const firstKey = "om:atlas:conversation:v1:test-member", secondKey = "om:atlas:conversation:v1:second-member";
  const secondHistory = [{ id: "second-history", role: "assistant", content: "Second member's saved conversation", at: 1 }];
  h.storage.set(secondKey, JSON.stringify(secondHistory));
  h.open({ question: "First member private question", context: { source: "OM AI Plays", label: "Private first result", data: { td: "BTC/USD" } } });
  const firstRequest = h.requests[0], firstSaved = h.storage.get(firstKey);
  assert.ok(firstSaved.includes("First member private question"));
  h.render({ memberKey: "second-member" });
  assert.ok(h.nodes((n) => n.type === "p").some((n) => content(n) === secondHistory[0].content));
  assert.ok(h.writes.filter((w) => w.key === secondKey).every((w) => !w.value.includes("First member")), "The first hydration commit cannot write previous-member messages under the new key");
  assert.equal(h.nodes((n) => n.props?.className === "om-atlas-context").length, 0, "The previous result context is cleared");

  h.open({ question: "Second member current question" });
  assert.equal(h.requests.length, 2);
  const secondRequest = h.requests[1];
  assert.ok(JSON.parse(secondRequest.init.body).history.some((m) => m.content === secondHistory[0].content));
  assert.ok(!secondRequest.init.body.includes("First member"));
  firstRequest.resolve({ ok: true, json: async () => ({ reply: "First member private late answer", actions: [] }) });
  await drain(); h.render();
  assert.equal(h.button("New Atlas conversation").props.disabled, true, "The old response cannot clear the new member's pending state");
  h.open({ question: "A duplicate while the new reply is pending" });
  assert.equal(h.requests.length, 2, "The new member's in-flight guard remains held");
  secondRequest.resolve({ ok: true, json: async () => ({ reply: "Second member's answer", actions: [] }) });
  await drain(); h.render();
  assert.ok(h.storage.get(secondKey).includes("Second member's answer"));
  assert.ok(h.writes.filter((w) => w.key === secondKey).every((w) => !w.value.includes("First member")));
  assert.equal(h.storage.get(firstKey), firstSaved, "The earlier member's history is not modified by the new conversation");
});

test("restored signal cards receive normalized evidence while retaining their saved trade state", () => {
  const h = harness();
  const key = "om:atlas:conversation:v1:saved-play-member";
  const result = {
    id: 1_800_000_000_000, status: "win", hitTp: 1, symbol: "BTC/USD", td: "BTC/USD", orderType: "Limit", asOf: "2026-11-21T12:00:00Z",
    signal: {
      direction: "LONG", status: "no_trade", entry: 70_000, stopLoss: 69_500, takeProfits: [71_000], rationale: "Waiting for a retest.",
      timeframes: [
        { tf: "15m", trend: "bullish", confirmed: 1, total: 1, checklist: [{ label: "Trend", ok: true }] },
        { tf: "5m", trend: "ranging", confirmed: 0, total: 1, checklist: [null] },
      ],
    },
  };
  h.storage.set(key, JSON.stringify([{ id: "saved-play", role: "assistant", content: "Your saved play.", at: 1, signal: { kind: "plays", result, saved: "device" } }]));
  h.render({ memberKey: "saved-play-member" }); h.open();
  const cards = h.nodes((n) => n.type === "AtlasSignalCard");
  assert.equal(cards.length, 1, "A damaged optional row cannot discard a valid historical play");
  const restored = cards[0].props.signal;
  assert.equal(restored.result.signal.timeframes.length, 1, "The card receives the normalized copy, not the original stored payload");
  assert.equal(restored.result.id, result.id);
  assert.equal(restored.result.status, "win");
  assert.equal(restored.result.signal.status, "no_trade");
  assert.equal(restored.saved, "device");
  assert.equal(h.requests.length + h.tools.length + h.scans.length, 0, "History restoration performs no generation or order request");
});

test("switching members invalidates pending tool persistence and ignores its delayed result", async () => {
  const h = harness();
  h.open({ tool: "plays", context: { source: "OM AI Plays", label: "First member's play", data: { td: "BTC/USD" } } });
  let card = h.nodes((n) => n.type === "AtlasActionCard")[0];
  card.props.onRun(card.props.action); h.render();
  const oldTool = h.tools[0];
  assert.equal(oldTool.isCurrent(), true);
  h.render({ memberKey: "second-member" });
  assert.equal(oldTool.isCurrent(), false, "The generator's persistence callback rejects writes after identity changes");
  assert.equal(h.nodes((n) => n.type === "AtlasActionCard").length, 0);

  h.open({ tool: "plays", context: { source: "OM AI Plays", label: "Second member's play", data: { td: "EUR/USD" } } });
  card = h.nodes((n) => n.type === "AtlasActionCard")[0];
  card.props.onRun(card.props.action); h.render();
  assert.equal(h.tools.length, 2);
  assert.equal(h.tools[1].isCurrent(), true);
  const makeSignal = (td) => ({ kind: "plays", saved: "synced", result: { id: td === "BTC/USD" ? 1 : 2, td, symbol: td, asOf: "2026-11-21T16:00:00Z", signal: { direction: "SHORT" } } });
  oldTool.resolve(makeSignal("BTC/USD")); await drain(); h.render();
  assert.equal(h.nodes((n) => n.type === "AtlasSignalCard").length, 0);
  assert.equal(h.nodes((n) => n.type === "AtlasActionCard")[0].props.busy, true, "The new member's generation remains in progress");
  h.tools[1].resolve(makeSignal("EUR/USD")); await drain(); h.render();
  assert.equal(h.nodes((n) => n.type === "AtlasSignalCard")[0].props.signal.result.td, "EUR/USD");
  const newWrites = h.writes.filter((w) => w.key === "om:atlas:conversation:v1:second-member");
  assert.ok(newWrites.length > 0 && newWrites.every((w) => !w.value.includes("BTC/USD")), "An old result never enters the new member's stored conversation");
});
