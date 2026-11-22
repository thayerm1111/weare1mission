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
function harness(relative = "src/components/om/atlas/AtlasProvider.tsx", name = "AtlasProvider", props = { children: "screen", configured: true, memberKey: "test-member" }, append = "") {
  const filename = path.resolve(__dirname, "..", relative);
  const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8") + append, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true }, fileName: filename,
  }).outputText;
  const slots = [], requests = [], tools = [], scans = [], starts = [], navigation = [], writes = [], events = new Map(), storage = new Map();
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
  const document = { activeElement: opener, documentElement: { classList: { add() {}, remove() {} } } };
  const window = {
    location: { pathname: "/portal/trading", search: "", assign: (href) => navigation.push(href) },
    addEventListener: (type, handler) => { if (!events.has(type)) events.set(type, new Set()); events.get(type).add(handler); },
    removeEventListener: (type, handler) => events.get(type)?.delete(handler),
    dispatchEvent: (event) => { for (const handler of events.get(event.type) ?? []) handler(event); return true; },
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
  const bus = { ready: () => true, start: (c) => starts.push(c), end: () => { ended++; voice.status = "idle"; }, get: () => voice, sendText: () => false, setMicMuted() {}, setSpeakerMuted() {}, updateContext() {} };
  const deps = {
    react, "react/jsx-runtime": { jsx, jsxs: jsx },
    "next/navigation": { useRouter: () => ({ push: (href) => navigation.push(href) }), usePathname: () => "/portal/trading", useSearchParams: () => new URLSearchParams() },
    "next/link": { __esModule: true, default: "Link" },
    "lucide-react": new Proxy({}, { get: (_, key) => `icon:${String(key)}` }),
    "@/components/command-center/VoiceSession": { VoiceSession: "VoiceSession" },
    "@/components/command-center/voiceBus": { appVoiceBus: bus, voiceBus: { get: () => ({ status: "idle" }), end() {} }, useAppVoiceBus: () => voice, lineOpen: (s) => ["connecting", "awaiting_mic", "listening", "speaking", "muted"].includes(s) },
    "@/components/om/FlowAccount": { useFlowAccount: () => ({ switching: false, ov: { account: { id: "owned-test-account", environment: "demo" } } }) },
    "@/components/om/ProductIcon": { ProductIcon: "ProductIcon" },
    "@/data/signalAssets": { findAsset, MARKETS: [{ id: "crypto", name: "Crypto", assets: [{ td: "BTC/USD", name: "Bitcoin", symbol: "BTC/USD" }] }] },
    "@/lib/atlas/open": { ATLAS_OPEN_EVENT: "om:atlas:open", openAtlas: (detail = {}) => window.dispatchEvent({ type: "om:atlas:open", detail }) },
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
    "@/lib/creditConfig": { CREDIT_COST: { signal: 3, genx: 5, scan: 5 } },
    "@/lib/floor/nav": require("../src/lib/floor/nav.ts"),
    "./InstallApp": { useInstall: () => ({ asApp: false, offer: false, install: async () => null }) },
    "./atlas/AtlasProvider": { useAtlasPanel: () => ({ open: false }) },
  };
  const context = vm.createContext({
    Date, Math, Error, console, Event, URLSearchParams, HTMLElement: Element, document, window,
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
    render, nodes: (pred) => nodes(tree, pred), tools, scans, requests, starts, navigation, voice, storage, writes, dialog, opener,
    ended: () => ended,
    open: (detail = {}) => { window.dispatchEvent({ type: "om:atlas:open", detail }); render(); },
    button: (label) => { const found = nodes(tree, (n) => n.type === "button" && (n.props["aria-label"] === label || content(n) === label)); assert.equal(found.length, 1, label); return found[0]; },
    unmount: () => { slots.forEach((s) => s?.cleanup?.()); },
  };
}

test("Atlas opens in place, starts requested voice with context, and closing stops voice only", () => {
  const h = harness();
  assert.equal(h.dialog.open, false);
  assert.equal(h.tools.length + h.scans.length + h.requests.length, 0);
  h.open({ voice: true, context: { source: "floor", label: "Gold", data: { td: "XAU/USD", asOf: "2026-11-21T16:00:00Z", levelsLocked: true } } });
  assert.equal(h.dialog.open, true);
  assert.equal(h.starts.length, 1);
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

test("the Atlas tab and header Ask Atlas are dialog buttons, not page links", () => {
  const h = harness("src/components/om/AppShell.tsx", "TestBar", { member: { name: "Test", email: null, admin: false }, configured: true, preview: false, look: "graphite", onLook: () => {} }, "\nexport { Bar as TestBar };\n");
  for (const label of ["Atlas", "Ask Atlas"]) {
    const target = h.button(label);
    assert.equal(target.props["aria-haspopup"], "dialog");
    assert.equal(target.props.href, undefined);
    target.props.onClick();
  }
  assert.equal(h.navigation.length, 0);
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
