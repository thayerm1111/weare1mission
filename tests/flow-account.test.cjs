const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");
const overview = require("../src/lib/floor/overview.ts");

// Run the actual provider with isolated hooks and deferred network answers. No broker connection,
// credentials, execution endpoints, browser, or financial account data is involved.
const filename = path.resolve(__dirname, "../src/components/om/FlowAccount.tsx");
const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  fileName: filename,
}).outputText;
const NOW = Date.parse("2026-11-22T12:00:00Z");
const A = { id: "sample:A", name: "Test main", masked: "•••• A", broker: "Test broker", environment: "live", currency: "USD", connection: "connected", isDefault: true };
const B = { ...A, id: "sample:B", name: "Test practice", masked: "•••• B", environment: "demo", isDefault: false };
const answer = (account = A, extra = {}) => ({
  asOf: new Date(NOW).toISOString(), accountsKnown: true, accounts: [A, B], account,
  figures: { balance: 1200, equity: 1250, openPnl: 50, positions: 1, at: new Date(NOW).toISOString(), state: "live", note: null },
  genx: { period: "7d", since: "2026-11-15", results: {} }, flow: { period: "today", since: "2026-11-22", results: {} }, atlas: null,
  ...extra,
});

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
const drain = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function harness(options = {}) {
  const slots = [], requests = [], intervals = new Map(), timeouts = new Map(), listeners = new Map();
  const storage = options.storage || new Map();
  let cursor = 0, effects = [], dirty = false, mounted = true, afterUnmount = 0, nextTimer = 0, value = null;
  let props = { configured: options.configured !== false, children: null };
  const changed = (before, after) => !before || !after || before.length !== after.length || after.some((item, i) => !Object.is(item, before[i]));
  const react = {
    createContext: () => ({ Provider: "Provider" }), useContext: () => value,
    useState(initial) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { value: typeof initial === "function" ? initial() : initial };
      return [slots[index].value, (next) => {
        if (!mounted) { afterUnmount += 1; return; }
        const result = typeof next === "function" ? next(slots[index].value) : next;
        if (!Object.is(result, slots[index].value)) { slots[index].value = result; dirty = true; }
      }];
    },
    useRef(initial) { const index = cursor++; if (!slots[index]) slots[index] = { current: initial }; return slots[index]; },
    useMemo(factory, deps) {
      const index = cursor++;
      if (!slots[index] || changed(slots[index].deps, deps)) slots[index] = { deps, value: factory() };
      return slots[index].value;
    },
    useEffect(effect, deps) {
      const index = cursor++, previous = slots[index];
      if (!previous || changed(previous.deps, deps)) effects.push(() => { previous?.cleanup?.(); slots[index] = { deps, cleanup: effect() }; });
    },
  };
  react.useCallback = (callback, deps) => react.useMemo(() => callback, deps);
  const jsx = (type, elementProps) => ({ type, props: elementProps || {} });
  class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [NOW])); } static now() { return NOW; } }
  const context = vm.createContext({
    Date: FixedDate, AbortController, console,
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, item) => storage.set(key, item) },
    setInterval: (fn, ms) => { const id = ++nextTimer; intervals.set(id, { fn, ms }); return id; }, clearInterval: (id) => intervals.delete(id),
    setTimeout: (fn, ms) => { const id = ++nextTimer; timeouts.set(id, { fn, ms }); return id; }, clearTimeout: (id) => timeouts.delete(id),
    document: { visibilityState: "visible", addEventListener: (event, fn) => listeners.set(event, fn), removeEventListener: (event, fn) => { if (listeners.get(event) === fn) listeners.delete(event); } },
    fetch: (url, init) => new Promise((resolve, reject) => requests.push({ url, init, resolve, reject })),
  });
  const mod = { exports: {} };
  const requireHere = (name) => {
    if (name === "react") return react;
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
    if (name === "lucide-react") return new Proxy({}, { get: (_, key) => `icon:${String(key)}` });
    if (name === "@/lib/floor/overview") return overview;
    throw new Error(`Unexpected dependency: ${name}`);
  };
  vm.runInContext(`(function(require,module,exports){${compiled}\n})`, context, { filename })(requireHere, mod, mod.exports);
  function render(nextProps) {
    if (nextProps) props = { ...props, ...nextProps };
    let turns = 0;
    do {
      assert.ok(turns++ < 15, "Provider should settle without a render loop");
      dirty = false; cursor = 0; effects = [];
      value = mod.exports.FlowAccountProvider(props).props.value;
      const pending = effects; effects = []; pending.forEach((effect) => effect());
    } while (dirty);
    return value;
  }
  return {
    requests, intervals, timeouts, storage, listeners, render,
    get value() { return value; }, get afterUnmount() { return afterUnmount; },
    bar: () => mod.exports.FlowAccountBar(),
    async reply(index, data, ok = true) { requests[index].resolve({ ok, json: async () => data }); await drain(); render(); },
    async fail(index) { requests[index].reject(new Error("Offline")); await drain(); render(); },
    timeout(ms) { const entry = [...timeouts].find(([, timer]) => timer.ms === ms); assert.ok(entry, `Expected a ${ms}ms timeout`); timeouts.delete(entry[0]); entry[1].fn(); render(); },
    unmount() { slots.forEach((slot) => slot?.cleanup?.()); mounted = false; },
  };
}

test("saved account, environment, periods and privacy hydrate before the first read", () => {
  const h = harness({ storage: new Map([["om:floor:account", "demo:sample:B"], ["om:floor:genx", "30d"], ["om:floor:flow", "all"], ["om:floor:hide", "1"]]) });
  h.render();
  assert.equal(h.requests.length, 1);
  assert.match(h.requests[0].url, /^\/api\/floor\/overview\?gp=30d&fp=all&tz=/);
  assert.equal(h.requests[0].init.headers["x-floor-account"], B.id);
  assert.equal(h.requests[0].init.headers["x-floor-env"], "demo");
  assert.ok(!h.requests[0].url.includes(B.id));
  assert.equal(h.requests[0].init.method, undefined, "Only the read endpoint is used");
  assert.equal(h.value.hide, true);
  h.render(); h.render();
  assert.equal(h.requests.length, 1, "Consumer re-renders/soft navigation do not create another fetch");
  assert.equal([...h.intervals.values()].filter((timer) => timer.ms === 60000).length, 1);
  h.unmount();
});

test("an unconfigured review shell does not request account data", async () => {
  const h = harness({ configured: false }); h.render();
  await h.value.refresh(); h.render();
  assert.equal(h.requests.length, 0); assert.equal(h.value.state, "off"); assert.equal(h.value.ov, null);
  h.unmount();
});

test("rapid account switching clears amounts immediately and ignores a late old-account answer", async () => {
  const h = harness(); h.render(); await h.reply(0, answer());
  const oldRefresh = h.value.refresh();
  h.value.chooseAccount(B); h.render();
  assert.equal(h.value.ov.account.id, B.id); assert.equal(h.value.ov.figures, null); assert.equal(h.value.ov.flow, null);
  assert.equal(h.value.switching, true); assert.equal(h.requests[1].init.signal.aborted, true);
  await h.reply(2, answer(B, { figures: { ...answer().figures, balance: 950 } }));
  await h.reply(1, answer(A, { figures: { ...answer().figures, balance: 999999 } })); await oldRefresh;
  assert.equal(h.value.ov.account.id, B.id); assert.equal(h.value.ov.figures.balance, 950); assert.equal(h.value.switching, false);
  assert.equal(h.storage.get("om:floor:account"), "demo:sample:B");
  assert.equal(A.isDefault, true); assert.equal(B.isDefault, false, "Viewing does not change the trading default");
  h.unmount();
});

test("period changes preserve the account and independent source/result periods", async () => {
  const h = harness({ storage: new Map([["om:floor:account", "live:sample:A"]]) }); h.render(); await h.reply(0, answer());
  h.value.setGenxPeriod("all"); h.render();
  assert.match(h.requests[1].url, /gp=all&fp=today/);
  h.value.setFlowPeriod("30d"); h.render();
  assert.match(h.requests[2].url, /gp=all&fp=30d/);
  assert.equal(h.requests[2].init.headers["x-floor-account"], A.id);
  assert.equal(h.requests[1].init.signal.aborted, true);
  h.unmount();
});

test("deferred broker reads retry only three times and stop on unmount", async () => {
  const h = harness(); h.render();
  const reading = answer(A, { figures: { ...answer().figures, reading: true } });
  for (let i = 0; i < 4; i++) { await h.reply(i, reading); if (i < 3) h.timeout(5000); }
  assert.equal(h.requests.length, 4); assert.equal(h.timeouts.size, 0);
  const pending = h.value.refresh(); const last = h.requests.at(-1);
  h.unmount();
  assert.equal(last.init.signal.aborted, true); assert.equal(h.intervals.size, 0); assert.equal(h.listeners.size, 0);
  last.resolve({ ok: true, json: async () => answer() }); await pending;
  assert.equal(h.afterUnmount, 0);
});

test("a failed refresh retains the dated answer and does not present it as current", async () => {
  const h = harness(); h.render(); await h.reply(0, answer());
  const pending = h.value.refresh(); await h.fail(1); await pending;
  assert.equal(h.value.state, "ready"); assert.equal(h.value.failed, true); assert.equal(h.value.ov.figures.balance, 1200);
  assert.match(content(h.bar()), /Last reading .*refresh unavailable/);
  assert.equal(nodes(h.bar(), (node) => node.props?.["data-tone"] === "connected").length, 0);
  h.unmount();
});

test("missing figures stay unavailable; privacy and the whole-account P&L scope are explicit", async () => {
  const h = harness(); h.render();
  await h.reply(0, answer(A, { figures: { ...answer().figures, balance: null, equity: null, openPnl: null, state: "unavailable", at: null } }));
  assert.ok(!content(h.bar()).includes("$0.00"));
  assert.equal(nodes(h.bar(), (node) => node.props?.className === "om-flow-account-number").map(content).join(""), "———");
  const pending = h.value.refresh(); await h.reply(1, answer()); await pending;
  h.value.toggleHide(); h.render();
  assert.ok(!content(h.bar()).includes("1,200")); assert.match(content(h.bar()), /••••••/);
  assert.equal(h.storage.get("om:floor:hide"), "1");
  assert.equal(nodes(h.bar(), (node) => node.props?.title === "Open profit and loss across the whole selected account").length, 1);
  assert.ok(!/Auto-run|Trading on|Paused|Armed/.test(content(h.bar())), "The overview cannot infer automation permissions");
  h.unmount();
});

test("hard navigation reconstructs the same view from saved preferences without changing controls", async () => {
  const storage = new Map(); const before = harness({ storage }); before.render(); await before.reply(0, answer());
  before.value.chooseAccount(B); before.value.setFlowPeriod("7d"); before.value.toggleHide(); before.render(); before.unmount();
  const after = harness({ storage }); after.render();
  assert.equal(after.requests.length, 1); assert.equal(after.requests[0].init.headers["x-floor-account"], B.id);
  assert.equal(after.requests[0].init.headers["x-floor-env"], B.environment); assert.match(after.requests[0].url, /fp=7d/);
  assert.equal(after.value.hide, true); assert.equal(after.value.ov, null, "The prior screen's money is not used as a loading placeholder");
  after.unmount();
});
