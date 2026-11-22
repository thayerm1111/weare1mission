const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const NOW = Date.parse("2026-11-25T14:00:00Z");
const A = { id: "fixture-account", environment: "live", name: "Main", masked: "•••• 1234", broker: "TradeLocker", connection: "connected" };
const B = { ...A, environment: "demo", name: "Practice", masked: "•••• 5678" };
const quote = { bid: 1.1012, ask: 1.1014, at: new Date(NOW).toISOString(), state: "live" };
const trade = (extra = {}) => ({
  id: "position-1", symbol: "EURUSD", side: "buy", qty: 0.004, entry: 1.1, stop: 1.095, target: 1.11,
  pips: 12, quote, revision: "read-1",
  actions: { close: { allowed: true, reason: null, qty: 0.004 }, partial: [
    { fraction: 0.25, allowed: true, reason: null, qty: 0.001 }, { fraction: 0.5, allowed: true, reason: null, qty: 0.002 },
  ], breakeven: { allowed: true, reason: null, stop: 1.1005 } },
  ...extra,
});
const snapshot = (account = A, positions = [trade()], extra = {}) => ({ ok: true, accountId: account.id, environment: account.environment, observedAt: new Date(NOW).toISOString(), state: "live", note: null, positions, ...extra });

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
const byClass = (name) => (node) => node.props?.className === name;
const drain = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

// Real component callbacks with deferred reads/mutations and an isolated clock. No broker, account,
// credentials, or network is available. A test can only resolve a recorded fixture request.
function harness({ account = A, state = "ready" } = {}) {
  const filename = path.resolve(__dirname, "../src/components/om/floor/ActiveTrades.tsx");
  const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true }, fileName: filename,
  }).outputText;
  const slots = [], requests = [], intervals = new Map(), timeouts = new Map(), listeners = new Map(), events = [];
  let cursor = 0, effects = [], dirty = false, tree, nextTimer = 0, now = NOW, mounted = true, afterUnmount = 0, overviewRefreshes = 0;
  let shared = { ov: { account, accountsKnown: true }, state, switching: false, hide: false, refresh: async () => { overviewRefreshes++; } };
  const changed = (before, after) => !before || !after || before.length !== after.length || after.some((value, index) => !Object.is(value, before[index]));
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { value: typeof initial === "function" ? initial() : initial };
      return [slots[index].value, (next) => {
        if (!mounted) { afterUnmount++; return; }
        const value = typeof next === "function" ? next(slots[index].value) : next;
        if (!Object.is(value, slots[index].value)) { slots[index].value = value; dirty = true; }
      }];
    },
    useRef(initial) { const index = cursor++; if (!slots[index]) slots[index] = { current: initial }; return slots[index]; },
    useMemo(factory, deps) { const index = cursor++; if (!slots[index] || changed(slots[index].deps, deps)) slots[index] = { deps, value: factory() }; return slots[index].value; },
    useEffect(effect, deps) { const index = cursor++, previous = slots[index]; if (!previous || changed(previous.deps, deps)) effects.push(() => { previous?.cleanup?.(); slots[index] = { deps, cleanup: effect() }; }); },
  };
  react.useCallback = (callback, deps) => react.useMemo(() => callback, deps);
  const jsx = (type, props) => ({ type, props: props || {} });
  class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const document = { visibilityState: "visible", addEventListener: (event, handler) => listeners.set(event, handler), removeEventListener: (event, handler) => { if (listeners.get(event) === handler) listeners.delete(event); } };
  const context = vm.createContext({
    Date: FixedDate, AbortController, document,
    CustomEvent: class { constructor(type) { this.type = type; } }, window: { dispatchEvent: (event) => events.push(event) },
    setInterval: (fn, ms) => { const id = ++nextTimer; intervals.set(id, { fn, ms }); return id; }, clearInterval: (id) => intervals.delete(id),
    setTimeout: (fn, ms) => { const id = ++nextTimer; timeouts.set(id, { fn, ms }); return id; }, clearTimeout: (id) => timeouts.delete(id),
    fetch: (url, init) => new Promise((resolve, reject) => requests.push({ url, init, resolve, reject })),
  });
  const mod = { exports: {} };
  const displayModules = new Map();
  const requireHere = (name) => {
    if (name === "react") return react;
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "Fragment" };
    if (name === "lucide-react") return new Proxy({}, { get: (_, key) => `icon:${String(key)}` });
    if (name === "next/dynamic") return { __esModule: true, default: () => "RiskConsent" };
    if (name === "../FlowAccount") return { useFlowAccount: () => shared };
    if (name === "@/lib/floor/activeTradeTypes") return { ACTIVE_TRADE_FRESH_MS: 30_000 };
    if (name === "@/lib/flow/display" || name === "@/lib/flow/instruments") {
      if (displayModules.has(name)) return displayModules.get(name);
      const source = path.resolve(__dirname, "../src", `${name.slice(2)}.ts`);
      const code = ts.transpileModule(fs.readFileSync(source, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS }, fileName: source }).outputText;
      const pure = { exports: {} };
      vm.runInContext(`(function(require,module,exports){${code}\n})`, context, { filename: source })(requireHere, pure, pure.exports);
      displayModules.set(name, pure.exports);
      return pure.exports;
    }
    if (name.endsWith(".css")) return {};
    throw new Error("Unexpected dependency: " + name);
  };
  vm.runInContext(`(function(require,module,exports){${compiled}\n})`, context, { filename })(requireHere, mod, mod.exports);
  function render() {
    let turns = 0;
    do {
      assert.ok(turns++ < 20, "ActiveTrades settles without a render loop");
      cursor = 0; effects = []; dirty = false;
      tree = mod.exports.ActiveTrades();
      const run = effects; effects = []; run.forEach((effect) => effect());
    } while (dirty);
    return tree;
  }
  render();
  return {
    render, requests, intervals, timeouts, events, document,
    get overviewRefreshes() { return overviewRefreshes; }, get afterUnmount() { return afterUnmount; },
    nodes: (predicate) => nodes(tree, predicate), text: () => content(tree), mutations: () => requests.filter((request) => request.init.method === "POST"),
    button(label, within = tree) { const found = nodes(within, (node) => node.type === "button" && (node.props["aria-label"] === label || content(node) === label)); assert.equal(found.length, 1, label); return found[0]; },
    card(symbol) { const found = nodes(tree, byClass("om-active-card")).filter((node) => nodes(node, (child) => child.type === "h3").some((child) => content(child) === symbol)); assert.equal(found.length, 1, symbol); return found[0]; },
    setAccount(next, extra = {}) { shared = { ...shared, ov: { ...shared.ov, account: next }, ...extra }; render(); },
    async reply(index, answer, ok = true, status = ok ? 200 : 409) { requests[index].resolve({ ok, status, json: async () => answer }); await drain(); render(); },
    async fail(index) { requests[index].reject(new Error("Connection lost")); await drain(); render(); },
    async timeout(ms) { const match = [...timeouts].find(([, timer]) => timer.ms === ms); assert.ok(match, `Expected ${ms}ms timeout`); timeouts.delete(match[0]); match[1].fn(); await drain(); render(); },
    tick(ms) { now += ms; [...intervals.values()].filter((timer) => timer.ms === 5000).forEach((timer) => timer.fn()); render(); },
    poll() { [...intervals.values()].filter((timer) => timer.ms === 15000).forEach((timer) => timer.fn()); render(); },
    unmount() { slots.forEach((slot) => slot?.cleanup?.()); mounted = false; },
  };
}

test("mount reads only the selected account and displays signed broker pips with side-correct quotes", async () => {
  const h = harness();
  assert.equal(h.requests.length, 1); assert.equal(h.mutations().length, 0);
  assert.equal(h.requests[0].url, "/api/floor/active-trades");
  assert.equal(h.requests[0].init.headers["x-floor-account"], A.id);
  assert.equal(h.requests[0].init.headers["x-floor-env"], A.environment);
  await h.reply(0, snapshot(A, [trade(), trade({ id: "position-2", symbol: "XAUUSD", side: "sell", entry: 2600, pips: -12, quote: { ...quote, bid: 2601, ask: 2601.2 } })]));
  assert.ok(content(h.card("EUR/USD")).includes("+12pips"));
  assert.ok(content(h.card("XAU/USD")).includes("−12pips"));
  assert.ok(content(h.card("EUR/USD")).includes("Bid1.1012"));
  assert.ok(content(h.card("XAU/USD")).includes("Ask2,601.20"));
  assert.equal(h.mutations().length, 0);
  h.unmount();
  const off = harness({ account: null, state: "off" });
  assert.equal(off.requests.length, 0); off.unmount();
});

test("account/environment switches remove old cards and reviews immediately and reject late answers or held confirms", async () => {
  const h = harness(); await h.reply(0, snapshot());
  h.button("Close trade").props.onClick(); h.render();
  const heldConfirm = h.button("Confirm close").props.onClick;
  h.button("Refresh active trades").props.onClick(); h.render();
  h.setAccount(B, { switching: true });
  assert.equal(h.nodes(byClass("om-active-card")).length, 0);
  assert.equal(h.nodes(byClass("om-active-review")).length, 0);
  heldConfirm(); h.render(); assert.equal(h.mutations().length, 0);
  assert.equal(h.requests[1].init.signal.aborted, true);
  h.setAccount(B, { switching: false });
  assert.equal(h.requests[2].init.headers["x-floor-account"], B.id);
  assert.equal(h.requests[2].init.headers["x-floor-env"], "demo");
  await h.reply(2, snapshot(B, [trade({ symbol: "GBPJPY", id: "demo-position" })]));
  await h.reply(1, snapshot(A, [trade({ symbol: "XAUUSD" })]));
  assert.ok(h.text().includes("GBP/JPY")); assert.ok(!h.text().includes("XAU/USD"));
  h.button("Refresh active trades").props.onClick(); h.render();
  await h.reply(3, snapshot(A, [trade({ symbol: "XAUUSD" })]));
  assert.ok(!h.text().includes("XAU/USD"));
  assert.equal(h.button("Close trade").props.disabled, true, "A mismatched server scope is an error, not a fallback account");
  h.unmount();
});

test("partial review preserves exact quantity, sends once only after confirmation, and refreshes verified state", async () => {
  const h = harness(); await h.reply(0, snapshot());
  h.button("Take partial").props.onClick(); h.render();
  h.button("Take 25%0.001 lots").props.onClick(); h.render();
  assert.equal(h.mutations().length, 0);
  const review = h.nodes(byClass("om-active-review"))[0];
  assert.ok(content(review).includes("Main · Live · •••• 1234"));
  assert.ok(content(review).includes("Close 0.001 lots"));
  assert.ok(content(review).includes("Remaining: 0.003 lots"));
  const confirm = h.button("Confirm 25% partial").props.onClick;
  confirm(); confirm(); h.render();
  assert.equal(h.mutations().length, 1);
  const request = JSON.parse(h.mutations()[0].init.body);
  assert.deepEqual(request, { accountId: A.id, environment: "live", positionId: "position-1", action: "partial", fraction: 0.25, revision: "read-1", confirm: true });
  await h.reply(1, { ...request, ok: true, state: "confirmed", message: "Closed 0.001 lots." });
  assert.equal(h.events.length, 1); assert.equal(h.events[0].type, "om:flow-trades-changed"); assert.equal(h.events[0].detail, undefined);
  assert.equal(h.overviewRefreshes, 1); assert.equal(h.mutations().length, 1);
  assert.equal(h.button("Close trade").props.disabled, true, "Old quantities cannot be acted on while the post-change read is pending");
  await h.reply(2, snapshot(A, [trade({ qty: 0.003, revision: "read-2" })]));
  assert.equal(h.nodes(byClass("om-active-review")).length, 0);
  assert.equal(h.button("Close trade").props.disabled, false);
  h.unmount();
});

test("stale/error snapshots disable mutations, while missing quotes keep pips unknown and permit only server-approved reductions", async () => {
  const h = harness(); await h.reply(0, snapshot());
  h.tick(31_000);
  assert.equal(h.button("Close trade").props.disabled, true);
  assert.equal(h.button("Breakeven").props.disabled, true);
  assert.equal(h.nodes((node) => node.props?.["data-tone"] === "positive").length, 0);
  assert.ok(h.text().includes("Last quote · not live"));
  h.button("Refresh active trades").props.onClick(); h.render(); await h.fail(1);
  assert.equal(h.button("Close trade").props.disabled, true); assert.equal(h.mutations().length, 0);
  h.unmount();

  const noQuote = harness();
  await noQuote.reply(0, snapshot(A, [trade({ pips: null, quote: { state: "unavailable", bid: null, ask: null, at: null } })]));
  assert.ok(noQuote.text().includes("—pips")); assert.ok(noQuote.text().includes("Pips unavailable"));
  assert.equal(noQuote.button("Breakeven").props.disabled, true);
  assert.equal(noQuote.button("Close trade").props.disabled, false);
  assert.equal(noQuote.button("Take partial").props.disabled, true);
  assert.ok(noQuote.text().includes("A fresh broker quote is required."));
  noQuote.unmount();
});

test("a hung read times out visibly, clears its in-flight guard, and can be retried without a mutation", async () => {
  const h = harness(); await h.timeout(25_000);
  assert.ok(h.text().includes("took too long")); assert.equal(h.requests[0].init.signal.aborted, true);
  assert.equal(h.button("Refresh active trades").props.disabled, false);
  h.button("Refresh active trades").props.onClick(); h.render();
  assert.equal(h.requests.length, 2); assert.equal(h.mutations().length, 0);
  await h.reply(1, snapshot()); assert.equal(h.button("Close trade").props.disabled, false);
  h.unmount(); assert.equal(h.timeouts.size, 0); assert.equal(h.intervals.size, 0);
  await h.reply(0, snapshot(B)); assert.equal(h.afterUnmount, 0);
});

test("uncertain changes stay pending without repeat sends, and an old account's completed mutation cannot update the new account", async () => {
  const h = harness(); await h.reply(0, snapshot());
  h.button("Close trade").props.onClick(); h.render(); h.button("Confirm close").props.onClick(); h.render();
  await h.fail(1);
  assert.ok(h.text().includes("Waiting for broker confirmation"));
  assert.equal(h.nodes(byClass("om-active-actions")).length, 0);
  await h.reply(2, snapshot()); h.poll();
  assert.equal(h.mutations().length, 1); assert.equal(h.events.length, 0);
  await h.reply(3, snapshot(A, []));
  assert.ok(h.text().includes("No open trades")); h.unmount();

  const other = harness(); await other.reply(0, snapshot());
  other.button("Breakeven").props.onClick(); other.render();
  assert.ok(other.text().includes("1.1005")); assert.ok(other.text().includes("5-pip protection buffer, before costs"));
  other.button("Confirm breakeven").props.onClick(); other.render();
  const approved = JSON.parse(other.mutations()[0].init.body);
  other.setAccount(B); await other.reply(2, snapshot(B, [trade({ symbol: "GBPJPY", id: "demo-position" })]));
  await other.reply(1, { ...approved, ok: true, state: "confirmed", message: "Old live stop moved." });
  assert.ok(!other.text().includes("Old live stop moved")); assert.ok(other.text().includes("GBP/JPY"));
  assert.equal(other.events.length, 0); assert.equal(other.overviewRefreshes, 0);
  assert.equal(other.button("Close trade").props.disabled, false); other.unmount();
});

test("a timed-out mutation stays pending and an old confirmation cannot resubmit after a fresh broker read", async () => {
  const h = harness(); await h.reply(0, snapshot());
  h.button("Close trade").props.onClick(); h.render();
  const heldConfirm = h.button("Confirm close").props.onClick;
  heldConfirm(); h.render();
  const approved = JSON.parse(h.mutations()[0].init.body);
  await h.timeout(65_000);
  assert.equal(h.mutations()[0].init.signal.aborted, true);
  assert.ok(h.text().includes("Waiting for broker confirmation"));
  assert.ok(h.text().includes("will not be sent again automatically"));
  await h.reply(2, snapshot());
  heldConfirm(); h.render(); h.poll();
  assert.equal(h.mutations().length, 1, "Neither a stale confirmation handler nor polling may repeat an uncertain operation");
  await h.reply(1, { ...approved, ok: true, state: "confirmed", message: "Late answer" });
  assert.equal(h.events.length, 0); assert.equal(h.overviewRefreshes, 0);
  assert.ok(!h.text().includes("Late answer"));
  h.unmount(); assert.equal(h.timeouts.size, 0);
});

test("a disclosure refusal offers the existing in-place disclosure and signing requires a new review, never a mutation retry", async () => {
  const h = harness(); await h.reply(0, snapshot());
  assert.equal(h.nodes((node) => node.type === "RiskConsent").length, 0);
  h.button("Close trade").props.onClick(); h.render();
  const heldConfirm = h.button("Confirm close").props.onClick;
  heldConfirm(); h.render();
  await h.reply(1, { ok: false, state: "refused", message: "Read and sign the current disclosure before trading.", needsConsent: true }, false, 403);
  assert.ok(!h.text().includes("Waiting for broker confirmation"));
  await h.reply(2, snapshot());
  assert.equal(h.button("Close trade").props.disabled, true);
  h.button("Review risk disclosure").props.onClick(); h.render();
  const consent = h.nodes((node) => node.type === "RiskConsent");
  assert.equal(consent.length, 1); assert.equal(consent[0].props.open, true);
  consent[0].props.onSigned({ signed: true, version: "current", acceptedAt: NOW, signedName: "Fixture Member", stale: false, currentVersion: "current" });
  h.render(); await h.reply(3, snapshot());
  heldConfirm(); h.render();
  assert.equal(h.nodes((node) => node.type === "RiskConsent").length, 0);
  assert.equal(h.nodes(byClass("om-active-review")).length, 0);
  assert.ok(h.text().includes("Review the trade again"));
  assert.equal(h.button("Close trade").props.disabled, false);
  assert.equal(h.mutations().length, 1); assert.equal(h.events.length, 0);
  h.unmount();
});

test("broker suffixes retain exact plan prices and small signed pip values in the actual trade review", async () => {
  const h = harness();
  const gold = trade({ symbol: "XAUUSD.r", entry: 3500.03, stop: 3498.07, target: 3508.99, pips: 0.04,
    quote: { ...quote, bid: 3501.003, ask: 3501.007 }, actions: { ...trade().actions, breakeven: { allowed: true, reason: null, stop: 3500.53 } } });
  const yen = trade({ id: "yen-position", symbol: "GBPJPY.pro", side: "sell", entry: 193.487, stop: 193.987, target: 192.337, pips: -0.01,
    quote: { ...quote, bid: 193.123, ask: 193.129 }, actions: { ...trade().actions, breakeven: { allowed: true, reason: null, stop: 193.437 } } });
  await h.reply(0, snapshot(A, [gold, yen]));
  const goldCard = h.card("XAUUSD.R"), yenCard = h.card("GBPJPY.PRO");
  for (const exact of ["Entry3,500.03", "Bid3,501.003", "Stop3,498.07", "Target3,508.99", "+0.04pips"]) assert.ok(content(goldCard).includes(exact), exact);
  for (const exact of ["Entry193.487", "Ask193.129", "Stop193.987", "Target192.337", "−0.01pips"]) assert.ok(content(yenCard).includes(exact), exact);
  h.button("Breakeven", goldCard).props.onClick(); h.render();
  assert.ok(content(h.nodes(byClass("om-active-review"))[0]).includes("3,500.53"));
  h.button("Breakeven", h.card("GBPJPY.PRO")).props.onClick(); h.render();
  assert.ok(content(h.nodes(byClass("om-active-review"))[0]).includes("193.437"));
  assert.equal(h.mutations().length, 0);
  h.unmount();
});
