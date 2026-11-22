const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

// Exercise the actual component with deferred reads. No database or broker requests are sent.
const filename = path.resolve(__dirname, "../src/components/om/floor/WinStreaks.tsx");
const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true }, fileName: filename,
}).outputText;
const NOW = "2026-11-22T12:00:00.000Z";
const A = { id: "test:A", environment: "live", name: "Test main" };
const B = { id: "test:B", environment: "demo", name: "Test practice" };
const metric = (extra = {}) => ({ state: "ready", scope: "account", period: "since_reset", since: NOW, asOf: NOW, currentWins: 3, currentPips: 45.5, wins: 18, winningPips: 450, lastWinAt: NOW, ...extra });
const answer = (account = A, extra = {}) => ({ asOf: NOW, account, flow: metric(), genx: metric({ scope: "genx_calls", currentWins: 5, currentPips: 80 }), ...extra });
const drain = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const expand = (tree) => Array.isArray(tree) ? tree.map(expand) : tree && typeof tree === "object"
  ? typeof tree.type === "function" ? expand(tree.type(tree.props)) : { ...tree, props: { ...tree.props, children: expand(tree.props?.children) } } : tree;
const content = (tree) => Array.isArray(tree) ? tree.map(content).join("") : tree == null || typeof tree === "boolean" ? "" : typeof tree === "object" ? content(tree.props?.children) : String(tree);
function nodes(tree, predicate) {
  if (Array.isArray(tree)) return tree.flatMap((child) => nodes(child, predicate));
  if (!tree || typeof tree !== "object") return [];
  return [...(predicate(tree) ? [tree] : []), ...nodes(tree.props?.children, predicate)];
}

function harness(initial = {}) {
  const slots = [], requests = [], intervals = new Map(), timeouts = new Map(), documentListeners = new Map(), windowListeners = new Map();
  let props = { account: A, accountsKnown: true, switching: false, hideAccountPips: false, ...initial };
  let cursor = 0, effects = [], dirty = false, mounted = true, afterUnmount = 0, nextTimer = 0, tree;
  const changed = (before, after) => !before || !after || before.length !== after.length || after.some((item, i) => !Object.is(item, before[i]));
  const react = {
    useState(initialState) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { value: typeof initialState === "function" ? initialState() : initialState };
      return [slots[index].value, (next) => {
        if (!mounted) { afterUnmount++; return; }
        const result = typeof next === "function" ? next(slots[index].value) : next;
        if (!Object.is(result, slots[index].value)) { slots[index].value = result; dirty = true; }
      }];
    },
    useRef(initialRef) { const index = cursor++; if (!slots[index]) slots[index] = { current: initialRef }; return slots[index]; },
    useEffect(effect, deps) {
      const index = cursor++, previous = slots[index];
      if (!previous || changed(previous.deps, deps)) effects.push(() => { previous?.cleanup?.(); slots[index] = { deps, cleanup: effect() }; });
    },
  };
  const jsx = (type, elementProps) => ({ type, props: elementProps || {} });
  const document = { visibilityState: "visible", addEventListener: (name, fn) => documentListeners.set(name, fn), removeEventListener: (name, fn) => { if (documentListeners.get(name) === fn) documentListeners.delete(name); } };
  const context = vm.createContext({
    AbortController, console, Date, document,
    window: { addEventListener: (name, fn) => windowListeners.set(name, fn), removeEventListener: (name, fn) => { if (windowListeners.get(name) === fn) windowListeners.delete(name); } },
    setInterval: (fn, ms) => { const id = ++nextTimer; intervals.set(id, { fn, ms }); return id; }, clearInterval: (id) => intervals.delete(id),
    setTimeout: (fn, ms) => { const id = ++nextTimer; timeouts.set(id, { fn, ms }); return id; }, clearTimeout: (id) => timeouts.delete(id),
    fetch: (url, init) => new Promise((resolve, reject) => requests.push({ url, init, resolve, reject })),
  });
  const mod = { exports: {} };
  const requireHere = (name) => {
    if (name === "react") return react;
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
    if (name === "lucide-react") return new Proxy({}, { get: (_, key) => `icon:${String(key)}` });
    if (name === "@/components/om/ProductIcon") return { ProductIcon: (p) => jsx("product-icon", p) };
    if (name.endsWith(".css")) return {};
    throw new Error(`Unexpected dependency: ${name}`);
  };
  vm.runInContext(`(function(require,module,exports){${compiled}\n})`, context, { filename })(requireHere, mod, mod.exports);
  const render = (next) => {
    if (next) props = { ...props, ...next };
    let turns = 0;
    do {
      assert.ok(turns++ < 15, "component settles"); dirty = false; cursor = 0; effects = [];
      tree = mod.exports.WinStreaks(props);
      for (const effect of effects) effect();
    } while (dirty);
    tree = expand(tree); return tree;
  };
  return {
    render, requests, intervals, timeouts, document, documentListeners, windowListeners,
    get text() { return content(tree); },
    card(kind) { return nodes(tree, (node) => node.type === "article" && node.props.className.includes(`om-streak-${kind}`))[0]; },
    refresh() { nodes(tree, (node) => node.props["aria-label"] === "Refresh winning streaks")[0].props.onClick(); render(); },
    async reply(index, data, ok = true) { requests[index].resolve({ ok, json: async () => data }); await drain(); render(); },
    async fail(index) { requests[index].reject(new Error("offline")); await drain(); render(); },
    unmount() { mounted = false; for (const slot of slots) slot?.cleanup?.(); },
    get afterUnmount() { return afterUnmount; },
  };
}

test("current runs are read-only, scoped by account headers, and exclude lifetime totals", async () => {
  const h = harness(); h.render();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].url, "/api/floor/win-streaks");
  assert.equal(h.requests[0].init.method, undefined);
  assert.equal(h.requests[0].init.headers["x-floor-account"], A.id);
  assert.equal(h.requests[0].init.headers["x-floor-env"], "live");
  await h.reply(0, answer());
  assert.match(content(h.card("flow")), /3Wins in a row\+45\.5 pipsPips this streak/);
  assert.match(content(h.card("genx")), /5Wins in a row\+80 pips/);
  assert.doesNotMatch(h.text, /450|loss|win rate/i);
  h.render({ account: { ...A } }); assert.equal(h.requests.length, 1);
  h.unmount();
});

test("switching immediately hides previous figures and discards late reads and fallback accounts", async () => {
  const h = harness(); h.render(); await h.reply(0, answer());
  h.refresh(); h.render({ account: B, switching: true });
  assert.doesNotMatch(h.text, /45\.5/); assert.equal(h.requests[1].init.signal.aborted, true);
  h.render({ switching: false }); assert.equal(h.requests[2].init.headers["x-floor-env"], "demo");
  await h.reply(1, answer(A, { flow: metric({ currentPips: 999 }) })); assert.doesNotMatch(h.text, /999/);
  await h.reply(2, answer(A)); assert.match(h.text, /Refresh unavailable/); assert.doesNotMatch(h.text, /45\.5/);
  h.refresh(); await h.reply(3, answer(B, { flow: metric({ currentWins: 2, currentPips: 12 }) }));
  assert.match(content(h.card("flow")), /2Wins in a row\+12 pips/);
  h.unmount();
});

test("a failed refresh keeps an explicitly dated last reading; unknown never becomes zero", async () => {
  const h = harness(); h.render(); await h.reply(0, answer());
  h.refresh(); await h.fail(1);
  assert.match(content(h.card("flow")), /45\.5.*Last readingAs of/);
  assert.equal(h.card("flow").props["data-winning"], "false");
  h.refresh(); await h.reply(2, answer(A, { flow: metric({ state: "unavailable", currentWins: null, currentPips: null }) }));
  assert.match(content(h.card("flow")), /—Wins in a row—Pips this streakStreak unavailable/);
  h.refresh(); await h.reply(3, answer(A, { flow: metric({ currentWins: 0, currentPips: 0 }) }));
  assert.match(content(h.card("flow")), /0Wins in a row0 pipsPips this streakNext streak starts here/);
  assert.doesNotMatch(h.text, /loss/i); h.unmount();
});

test("hidden personal pips do not hide community figures, and samples perform no reads", async () => {
  const h = harness({ hideAccountPips: true }); h.render(); await h.reply(0, answer());
  assert.doesNotMatch(content(h.card("flow")), /45\.5/);
  assert.match(content(h.card("flow")), /3Wins in a row••••/);
  assert.match(content(h.card("genx")), /\+80 pips/); h.unmount();
  const sample = harness({ sample: true }); sample.render(); sample.refresh();
  assert.equal(sample.requests.length, 0); assert.match(sample.text, /Sample view/); sample.unmount();
});

test("community streaks remain available without an account, and polling stops while hidden", async () => {
  const h = harness({ account: null }); h.render();
  await h.reply(0, answer(null, { flow: metric({ state: "no_account", currentWins: null, currentPips: null }) }));
  assert.match(content(h.card("flow")), /No account selected/);
  assert.match(content(h.card("genx")), /\+80 pips/);
  const poll = [...h.intervals.values()][0]; assert.equal(poll.ms, 30000);
  h.document.visibilityState = "hidden"; poll.fn(); h.windowListeners.get("om:flow-trades-changed")();
  assert.equal(h.requests.length, 1);
  h.document.visibilityState = "visible"; h.documentListeners.get("visibilitychange")();
  assert.equal(h.requests.length, 2);
  h.unmount(); assert.equal(h.intervals.size, 0); assert.equal(h.windowListeners.size, 0);
  h.requests[1].resolve({ ok: true, json: async () => answer(null) }); await drain();
  assert.equal(h.afterUnmount, 0);
});

test("ungraded GENX calls have a plain explanation while wins and pips remain blank", async () => {
  const h = harness(); h.render();
  await h.reply(0, answer(A, { genx: metric({ scope: "genx_calls", state: "unavailable", reason: "ungraded_callout", currentWins: null, currentPips: null }) }));
  const card = content(h.card("genx"));
  assert.match(card, /—Wins in a row—Pips this streakStreak not verifiedSome entered calls have no recorded outcome\./);
  assert.doesNotMatch(card, /0Wins|0 pips|Awaiting|loss|win rate/i);
  assert.equal(h.card("genx").props["data-winning"], "false");
  h.refresh(); await h.fail(1);
  assert.match(content(h.card("genx")), /Streak unavailable/);
  assert.doesNotMatch(content(h.card("genx")), /no recorded outcome/);
  h.unmount();
});

test("GENX completion-order ambiguity is explained without showing historical outcomes", async () => {
  const h = harness(); h.render();
  await h.reply(0, answer(A, { genx: metric({ scope: "genx_calls", state: "unavailable", reason: "ambiguous_order", currentWins: null, currentPips: null }) }));
  assert.match(content(h.card("genx")), /Streak not verifiedSome completed calls share a timestamp, so their order cannot be verified\./);
  assert.doesNotMatch(content(h.card("genx")), /no recorded outcome|loss|0Wins/i);
  h.refresh(); await h.reply(1, answer(A, { genx: metric({ scope: "genx_calls", currentWins: 1, currentPips: 7 }) }));
  assert.match(content(h.card("genx")), /1Wins in a row\+7 pipsPips this streakCompleted wins/);
  assert.doesNotMatch(content(h.card("genx")), /not verified|share a timestamp/);
  h.unmount();
});

test("generic and legacy unavailable GENX responses do not invent an ungraded-callout reason", async () => {
  const h = harness(); h.render();
  for (const [i, reason] of [undefined, "read_unavailable", "future_unknown_reason"].entries()) {
    if (i > 0) h.refresh();
    await h.reply(i, answer(A, { genx: metric({ scope: "genx_calls", state: "unavailable", reason, currentWins: null, currentPips: null }) }));
    assert.match(content(h.card("genx")), /—Wins in a row—Pips this streakStreak unavailable/);
    assert.doesNotMatch(content(h.card("genx")), /not verified|no recorded outcome|share a timestamp|loss/i);
  }
  h.unmount();
});
