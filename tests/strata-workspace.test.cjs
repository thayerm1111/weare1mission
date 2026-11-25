const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { generatePossibleEntry } = require("../src/lib/strata/generate.ts");

const NOW = Date.parse("2026-11-25T16:04:00Z");
const drain = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const text = (tree) => Array.isArray(tree) ? tree.map(text).join("") : tree == null || typeof tree === "boolean" ? "" : typeof tree === "object" ? text(tree.props?.children) : String(tree);
const nodes = (tree, predicate) => Array.isArray(tree) ? tree.flatMap((child) => nodes(child, predicate)) : !tree || typeof tree !== "object" ? [] : [...(predicate(tree) ? [tree] : []), ...nodes(tree.props?.children, predicate)];

function fixture(extra = {}) {
  const bars = Array.from({ length: 100 }, (_, i) => {
    const c = 3600 + Math.sin(i * .35) * 6 + i * .035;
    return { t: NOW - (101 - i) * 900_000, o: c - .18, h: c + 1.1, l: c - 1.1, c };
  });
  const analysis = { regime: "transition", regimeLabel: "Transition / mixed", structure: "Unconfirmed swings",
    asOf: bars.at(-1).t, atr: 3.2, momentum: "Rising", efficiency: .33,
    swings: { highs: [], lows: [], hh: false, hl: false, lh: false, ll: false },
    range: { high: 3610, low: 3590, topTouches: 2, bottomTouches: 2 },
    quality: 0, status: "NO_SETUP", primary: null, secondary: null, reasons: ["Mixed market."], warnings: [] };
  return { ok: true, analysis, bars: { m5: bars, m15: bars, h1: bars, h4: bars }, candles: bars,
    asOf: new Date(NOW).toISOString(), lastCandleAt: new Date(bars.at(-1).t).toISOString(),
    price: 3603, quoteSource: "stream", quoteReceivedAt: new Date(NOW - 1000).toISOString(), marketClosed: false, dataStale: false, ...extra };
}
function generated(state = fixture()) {
  const idea = generatePossibleEntry({ analysis: state.analysis, bars: state.bars.m15, price: state.price,
    generatedAt: NOW, marketOpen: !state.marketClosed, quoteFresh: state.quoteSource === "stream", dataStale: state.dataStale });
  return { ok: true, idea, state };
}
function readyFixture(extra = {}) {
  const state = fixture(extra);
  const plan = { id: "original:ready", type: "break_retest", side: "buy", stage: "ready", title: "Confirmed break",
    level: 3600, entry: 3602, stop: 3598, targets: [3609.2, 3616], riskReward: 1.8, score: 80,
    zone: { low: 3599.5, high: 3600.5, kind: "retest", label: "Retest" }, reference: false,
    trigger: "Confirmed", invalidation: "Below 3598", startedAt: state.analysis.asOf,
    checks: [{ label: "Retest", done: true, detail: "Confirmed" }] };
  return { ...state, analysis: { ...state.analysis, regime: "uptrend", status: "READY", primary: plan } };
}

// Real workspace callbacks and pure generator; all network, clock and DOM effects are isolated.
function harness(experience = "advanced") {
  const filename = path.resolve(__dirname, "../src/components/om/strata/StrataWorkspace.tsx");
  const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true }, fileName: filename,
  }).outputText;
  const slots = [], requests = [], timers = new Map(), atlas = [], scrolls = [];
  let cursor = 0, effects = [], dirty = false, mounted = true, afterUnmount = 0, timerId = 0, tree;
  const changed = (a, b) => !a || !b || a.length !== b.length || b.some((value, i) => !Object.is(value, a[i]));
  const react = {
    useState(initial) {
      const index = cursor++; if (!slots[index]) slots[index] = { value: typeof initial === "function" ? initial() : initial };
      return [slots[index].value, (next) => { if (!mounted) { afterUnmount++; return; } const value = typeof next === "function" ? next(slots[index].value) : next; if (!Object.is(value, slots[index].value)) { slots[index].value = value; dirty = true; } }];
    },
    useRef(initial) { const index = cursor++; if (!slots[index]) slots[index] = { current: initial }; return slots[index]; },
    useMemo(factory, deps) { const index = cursor++; if (!slots[index] || changed(slots[index].deps, deps)) slots[index] = { deps, value: factory() }; return slots[index].value; },
    useEffect(effect, deps) { const index = cursor++, before = slots[index]; if (!before || changed(before.deps, deps)) effects.push(() => { before?.cleanup?.(); slots[index] = { deps, cleanup: effect() }; }); },
  };
  react.useCallback = (fn, deps) => react.useMemo(() => fn, deps);
  const jsx = (type, props) => ({ type, props: props || {} });
  const interval = (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms, repeat: true }); return id; };
  const timeout = (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms, repeat: false }); return id; };
  class Clock extends Date { constructor(...args) { if (args.length) super(...args); else super(NOW); } static now() { return NOW; } }
  const frame = (fn) => { fn(); return 1; };
  const element = { scrollIntoView: (options) => scrolls.push(options), focus() {} };
  const context = vm.createContext({
    Date: Clock, Math, Error, console, AbortController,
    document: { visibilityState: "visible", addEventListener() {}, removeEventListener() {}, getElementById: () => element },
    window: { requestAnimationFrame: frame, cancelAnimationFrame() {}, matchMedia: () => ({ matches: false }) },
    requestAnimationFrame: frame, cancelAnimationFrame() {}, setInterval: interval, clearInterval: (id) => timers.delete(id), setTimeout: timeout, clearTimeout: (id) => timers.delete(id),
    fetch: (url, init) => new Promise((resolve, reject) => { requests.push({ url, init, resolve, reject }); init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); }),
  });
  const mod = { exports: {} };
  vm.runInContext(`(function(require,module,exports){${compiled}\n})`, context, { filename })((name) => {
    if (name === "react") return react;
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
    if (name === "lucide-react") return new Proxy({}, { get: (_, key) => `icon:${String(key)}` });
    if (name === "next/link") return { __esModule: true, default: "Link" };
    if (name === "@/lib/atlas/open") return { openAtlas: (value) => atlas.push(value) };
    if (name === "@/lib/strata/generate") return { generatePossibleEntry };
    if (name === "./StrataChart") return { StrataChart: "StrataChart" };
    if (name === "@/components/om/vision/VisionDirection") return { VisionDirection: "VisionDirection", VisionLevels: "VisionLevels" };
    if (name === "@/components/om/experience") return { useExperienceMode: () => ({ mode: experience, isSimple: experience === "simple" }) };
    if (name.endsWith(".css")) return {};
    throw new Error(`Unexpected dependency: ${name}`);
  }, mod, mod.exports);
  function render() {
    let turns = 0;
    do { assert.ok(turns++ < 20, "Workspace settles"); cursor = 0; dirty = false; effects = []; tree = mod.exports.StrataWorkspace(); effects.forEach((effect) => effect()); } while (dirty);
  }
  render();
  const find = (predicate) => nodes(tree, predicate);
  return {
    render, requests, timers, atlas, scrolls, find,
    experience(mode) { experience = mode; render(); },
    byClass: (name) => find((node) => String(node.props.className ?? "").split(/\s+/).includes(name)),
    generate: () => find((node) => node.type === "button" && String(node.props.className).includes("strata-generate-button"))[0],
    async reply(request, body, status = 200) { request.resolve({ ok: status >= 200 && status < 300, status, json: async () => body }); await drain(); render(); },
    async fail(request) { request.reject(new Error("Network unavailable")); await drain(); render(); },
    poll(ms) { for (const timer of [...timers.values()]) if (timer.repeat && timer.ms === ms) timer.fn(); render(); },
    expire(ms) { for (const [id, timer] of [...timers]) if (!timer.repeat && timer.ms === ms) { timers.delete(id); timer.fn(); } },
    unmount() { mounted = false; slots.forEach((slot) => slot?.cleanup?.()); },
    get afterUnmount() { return afterUnmount; },
  };
}

test("Generate recovers from an unavailable initial feed, issues one read, and pins the returned scenario to its chart", async () => {
  const h = harness();
  await h.reply(h.requests.find((r) => r.url === "/api/strata"), { error: "feed_unavailable", detail: "Temporary provider delay" }, 503);
  assert.equal(h.generate().props.disabled, false, "A failed background read must not disable the user's explicit retry");
  const click = h.generate().props.onClick; click(); click(); h.render();
  const calls = h.requests.filter((r) => r.url === "/api/strata/generate");
  assert.equal(calls.length, 1, "Rapid clicks cannot duplicate generation");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(h.generate().props["aria-busy"], true);
  const payload = generated(); assert.ok(payload.idea.scenario);
  await h.reply(calls[0], payload);
  const chart = h.find((n) => n.type === "StrataChart")[0];
  assert.equal(chart.props.selected, payload.idea.scenario);
  assert.equal(chart.props.bars, payload.state.bars);
  assert.equal(chart.props.price, payload.idea.quoteAtGeneration);
  assert.equal(chart.props.snapshot, true);
  assert.equal(chart.props.live, false);
  assert.equal(h.generate().props.disabled, false);
  assert.match(text(h.byClass("strata-generated-result")[0]), new RegExp(payload.idea.label));
  assert.ok(h.scrolls.length > 0, "The completed result is brought into view");
  await h.reply(h.requests.find((r) => r.url === "/api/floor/atlas-ticks"), { ticks: [{ symbol: "XAU/USD", price: 3606, receivedAt: new Date(NOW - 500).toISOString(), providerAt: new Date(NOW - 700).toISOString() }] });
  assert.equal(h.find((n) => n.type === "StrataChart")[0].props.price, payload.idea.quoteAtGeneration, "A new tick cannot rewrite the generated chart quote");
  assert.equal(h.find((n) => n.type === "VisionDirection")[0].props.quote, 3606, "The live header can still show the newer observation");
  const posts = h.requests.filter((r) => r.init?.method === "POST");
  assert.deepEqual(posts.map((r) => r.url), ["/api/strata/generate"], "Generation never enables paper mode, charges, or calls a broker route");
  h.unmount();
});

test("generation errors and malformed results are visible beside the retry control without replacing a valid snapshot", async () => {
  const h = harness(), original = generated();
  h.generate().props.onClick(); h.render();
  await h.reply(h.requests.find((r) => r.url === "/api/strata/generate"), original);
  h.generate().props.onClick(); h.render();
  await h.reply(h.requests.filter((r) => r.url === "/api/strata/generate").at(-1), { error: "feed_unavailable", detail: "15-minute candles are refreshing. Please retry." }, 503);
  const feedback = h.byClass("strata-generation-feedback")[0];
  assert.match(text(feedback), /15-minute candles are refreshing.*previous generated snapshot/);
  assert.equal(nodes(feedback, (n) => n.props.role === "alert").length, 1);
  assert.match(text(h.generate()), /RETRY GENERATION/);
  assert.equal(h.generate().props.disabled, false);
  assert.equal(h.find((n) => n.type === "StrataChart")[0].props.selected, original.idea.scenario);
  h.generate().props.onClick(); h.render();
  await h.reply(h.requests.filter((r) => r.url === "/api/strata/generate").at(-1), { ok: true, idea: { tier: "ready" }, state: {} });
  assert.match(text(h.byClass("strata-generation-feedback")[0]), /could not verify this response/);
  assert.equal(h.find((n) => n.type === "StrataChart")[0].props.selected, original.idea.scenario, "Malformed data cannot erase the last valid ticket or crash the page");
  h.unmount();
});

test("a timed-out generation can be retried, and leaving the page aborts pending work", async () => {
  const h = harness();
  h.generate().props.onClick(); h.render();
  const first = h.requests.find((r) => r.url === "/api/strata/generate");
  h.expire(22_000); await drain(); h.render();
  assert.equal(first.init.signal.aborted, true);
  assert.equal(h.generate().props.disabled, false);
  assert.match(text(h.byClass("strata-generation-feedback")[0]), /took too long.*Retry generation/);
  h.generate().props.onClick(); h.render();
  const second = h.requests.filter((r) => r.url === "/api/strata/generate").at(-1);
  assert.notEqual(second, first);
  h.unmount(); await drain();
  assert.equal(second.init.signal.aborted, true);
  assert.equal(h.afterUnmount, 0, "Aborted generation cannot commit state after navigation");
});

test("a completed no-setup read states its reason and next condition without inventing trade levels", async () => {
  const h = harness(), payload = generated(fixture({ dataStale: true }));
  assert.equal(payload.idea.tier, "none");
  h.generate().props.onClick(); h.render();
  await h.reply(h.requests.find((r) => r.url === "/api/strata/generate"), payload);
  assert.match(text(h.byClass("strata-generated-result")[0]), /Read complete · no qualified trade/);
  assert.match(text(h.byClass("strata-generation-summary")[0]), /candles are stale.*Next:/);
  assert.match(text(h.byClass("strata-vision-setup-top")[0]), /No current trade is qualified/);
  assert.equal(h.find((n) => n.type === "StrataChart")[0].props.selected, null);
  const levels = h.find((n) => n.type === "VisionLevels")[0].props;
  assert.equal(levels.entry, undefined);
  assert.equal(levels.stop, undefined);
  assert.equal(levels.targets.length, 0);
  assert.equal(levels.reference, true);
  assert.equal(h.generate().props.disabled, false);
  h.unmount();
});

test("a recently received old provider tick does not label stale price or a live ticket as qualified", async () => {
  const h = harness(), state = readyFixture({ quoteSource: "delayed", quoteProviderAt: new Date(NOW - 43_000).toISOString() });
  await h.reply(h.requests.find((r) => r.url === "/api/strata"), state);
  await h.reply(h.requests.find((r) => r.url === "/api/floor/atlas-ticks"), { ticks: [{ symbol: "XAU/USD", price: 3602,
    receivedAt: new Date(NOW - 1000).toISOString(), providerAt: new Date(NOW - 43_000).toISOString() }] });
  const direction = h.find((n) => n.type === "VisionDirection")[0].props;
  assert.equal(direction.status, "QUOTE DELAYED");
  assert.notEqual(direction.facts.find((fact) => fact.label === "ENTRY TRIGGER").value, "Qualified");
  assert.equal(h.find((n) => n.type === "VisionLevels")[0].props.reference, true);
  assert.equal(h.find((n) => n.type === "StrataChart")[0].props.selected.reference, true);
  assert.doesNotMatch(text(h.byClass("strata-vision-setup-state")[0]), /ENGINE CONFIRMED/);

  h.poll(1500);
  await h.reply(h.requests.filter((r) => r.url === "/api/floor/atlas-ticks").at(-1), { ticks: [{ symbol: "XAU/USD", price: 3602,
    receivedAt: new Date(NOW - 500).toISOString(), providerAt: new Date(NOW - 500).toISOString() }] });
  const fresh = h.find((n) => n.type === "VisionDirection")[0].props;
  assert.equal(fresh.status, "LIVE FEED");
  assert.equal(fresh.facts.find((fact) => fact.label === "ENTRY TRIGGER").value, "Qualified");
  assert.equal(h.find((n) => n.type === "VisionLevels")[0].props.reference, false);
  h.unmount();
});

test("a failed feed refresh suspends current READY claims while retaining explicitly dated generated snapshots", async () => {
  const h = harness(), state = readyFixture();
  await h.reply(h.requests.find((r) => r.url === "/api/strata"), state);
  assert.equal(h.find((n) => n.type === "VisionDirection")[0].props.facts.find((fact) => fact.label === "ENTRY TRIGGER").value, "Qualified");
  assert.equal(h.find((n) => n.type === "VisionLevels")[0].props.reference, false);
  h.poll(25_000);
  await h.reply(h.requests.filter((r) => r.url === "/api/strata").at(-1), { error: "feed_unavailable", detail: "Candles unavailable. Please retry." }, 503);
  assert.notEqual(h.find((n) => n.type === "VisionDirection")[0].props.facts.find((fact) => fact.label === "ENTRY TRIGGER").value, "Qualified");
  assert.equal(h.find((n) => n.type === "VisionLevels")[0].props.reference, true);
  assert.equal(h.find((n) => n.type === "StrataChart")[0].props.selected.reference, true);
  assert.doesNotMatch(text(h.byClass("strata-vision-setup-state")[0]), /ENGINE CONFIRMED/);
  assert.doesNotMatch(text(h.byClass("strata-vision-setup-caption")[0]), /Engine-confirmed setup/);

  h.generate().props.onClick(); h.render();
  const snapshot = generated(state); assert.equal(snapshot.idea.tier, "ready");
  await h.reply(h.requests.find((r) => r.url === "/api/strata/generate"), snapshot);
  h.poll(25_000);
  await h.reply(h.requests.filter((r) => r.url === "/api/strata").at(-1), { error: "feed_unavailable", detail: "Candles unavailable. Please retry." }, 503);
  assert.match(text(h.byClass("strata-generated-result")[0]), /Confirmed by the standard engine when generated.*Captured/);
  assert.equal(h.find((n) => n.type === "StrataChart")[0].props.snapshot, true);
  assert.equal(h.find((n) => n.type === "StrataChart")[0].props.selected, snapshot.idea.scenario, "A failed current feed does not rewrite the previously captured plan");
  h.unmount();
});

test("Simple mode retains the actual generated plan and its cancel condition across mode switches without another request", async () => {
  const h = harness("simple"), payload = generated();
  assert.equal(h.find((n) => n.type === "VisionDirection").length, 0);
  assert.match(text(h.generate()), /Generate a gold plan/);
  h.generate().props.onClick(); h.render();
  await h.reply(h.requests.find((r) => r.url === "/api/strata/generate"), payload);
  const plan = payload.idea.scenario;
  assert.match(text(h.byClass("strata-simple-next")[0]), new RegExp(plan.invalidation));
  const levels = h.find((n) => typeof n.type === "function" && n.type.name === "PlanLevels")[0];
  assert.equal(levels.props.plan, plan);
  assert.match(text(levels.type(levels.props)), /STOP LOSS.*TARGET 01.*TARGET 02/);
  const count = h.requests.length;
  for (const mode of ["advanced", "simple", "advanced"]) {
    h.experience(mode);
    const chart = h.find((n) => n.type === "StrataChart")[0];
    assert.equal(chart.props.selected, plan);
    assert.equal(chart.props.bars, payload.state.bars);
    assert.equal(chart.props.snapshot, true);
  }
  assert.equal(h.requests.length, count, "Presentation changes do not generate, charge, or enable automation");
  assert.equal(h.find((n) => n.type === "VisionDirection").length, 1);
  h.unmount();
});

test("Simple mode keeps stale-data warnings and an active simulation's stop control outside collapsed details", async () => {
  const h = harness("simple");
  await h.reply(h.requests.find((r) => r.url === "/api/strata"), fixture({ dataStale: true }));
  assert.match(text(h.byClass("strata-simple-read")[0]), /Wait for fresh gold data/);
  assert.match(text(h.byClass("strata-warning")), /stale.*disabled/);
  await h.reply(h.requests.find((r) => r.url === "/api/strata/automation"), {
    ok: true,
    accounts: [{ accountId: "a", connectionId: "c", name: "Demo", masked: "1234", environment: "demo", connected: true, selected: true }],
    settings: [{ account_id: "a", connection_id: "c", environment: "demo", mode: "paper", risk_pct: .25, max_entries_per_day: 2 }],
    paper: [{ id: "p", account_id: "a", connection_id: "c", side: "buy", entry: 3600, stop: 3595, target: 3610, status: "open", opened_at: new Date(NOW).toISOString(), closed_at: null, exit_price: null }],
  });
  const strip = h.byClass("strata-simple-paper")[0];
  assert.match(text(strip), /Paper automation is on.*Simulation only.*Stop.*Target/);
  const stop = nodes(strip, (n) => n.type === "button")[0];
  assert.match(text(stop), /Stop paper automation/);
  assert.equal(stop.props.disabled, false);
  assert.equal(h.requests.filter((r) => r.init?.method === "POST").length, 0);
  stop.props.onClick(); h.render();
  const change = h.requests.find((r) => r.url === "/api/strata/automation" && r.init?.method === "POST");
  assert.equal(JSON.parse(change.init.body).mode, "off");
  assert.ok(!h.requests.some((r) => /execute|broker/.test(r.url)));
  h.unmount();
});
