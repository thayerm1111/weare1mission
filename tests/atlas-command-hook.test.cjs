const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const NOW = Date.parse("2026-11-25T16:00:00Z");
const drain = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const signal = (id = "recorded-gold-call") => ({ ok: true, saved: true, idea: {
  id, at: NOW, snapshotAt: NOW - 20_000, kind: "stand_aside", side: null, source: null,
  headline: "Wait for a confirmed gold setup", reasoning: "The closed candles do not confirm an entry.", badge: "No trade", price: 3550,
  entry: null, stop: null, targets: [], confirmations: [], waitingFor: ["A closed retest"], warnings: [],
  execute: { now: false, note: "No order available" }, invalidation: null, confidence: null, rr: null,
} });
const access = (active = false) => ({ active, admin: false, expiresAt: active ? new Date(NOW + 3600_000).toISOString() : null,
  cost: 10, minutes: 60, balance: 50 });

// Both the production hook and its request helpers execute in this sandbox.
// Only React, the clock, browser events and HTTP are controlled by the test.
function harness(initial = {}) {
  const slots = [], requests = [], timers = new Map(), events = [];
  let props = { symbol: "XAUUSD", disabled: false, ...initial }, cursor = 0, effects = [], dirty = false;
  let mounted = true, afterUnmount = 0, timerId = 0, view;
  const changed = (a, b) => !a || !b || a.length !== b.length || b.some((value, i) => !Object.is(value, a[i]));
  const react = {
    useState(initialValue) { const index = cursor++; if (!slots[index]) slots[index] = { value: typeof initialValue === "function" ? initialValue() : initialValue };
      return [slots[index].value, (next) => { if (!mounted) { afterUnmount++; return; } const value = typeof next === "function" ? next(slots[index].value) : next;
        if (!Object.is(value, slots[index].value)) { slots[index].value = value; dirty = true; } }]; },
    useRef(initialValue) { const index = cursor++; return slots[index] ??= { current: initialValue }; },
    useMemo(factory, deps) { const index = cursor++; if (!slots[index] || changed(slots[index].deps, deps)) slots[index] = { value: factory(), deps }; return slots[index].value; },
    useEffect(effect, deps) { const index = cursor++, before = slots[index]; if (!before || changed(before.deps, deps)) effects.push(() => { before?.cleanup?.(); slots[index] = { deps, cleanup: effect() }; }); },
  };
  react.useCallback = (callback, deps) => react.useMemo(() => callback, deps);
  const context = vm.createContext({ Date, Math, Error, AbortController, Event,
    window: { dispatchEvent: (event) => events.push(event.type) },
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => timers.delete(id),
    fetch: (url, init) => new Promise((resolve, reject) => {
      const request = { url, init, resolve, reject, ignoreAbort: false, bodyReject: null };
      requests.push(request);
      init?.signal?.addEventListener("abort", () => { if (!request.ignoreAbort) { request.bodyReject?.(new Error("body aborted")); reject(new Error("request aborted")); } }, { once: true });
    }),
  });
  function load(relative, requireHere) {
    const filename = path.resolve(__dirname, "..", relative), mod = { exports: {} };
    const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true }, fileName: filename,
    }).outputText;
    vm.runInContext(`(function(require,module,exports){${compiled}\n})`, context, { filename })(requireHere, mod, mod.exports);
    return mod.exports;
  }
  const helpers = load("src/lib/atlas/commandSignal.ts", (name) => { throw new Error("Unexpected helper dependency: " + name); });
  const component = load("src/components/om/atlas/AtlasCommandSignal.tsx", (name) => {
    if (name === "react") return react;
    if (name === "react/jsx-runtime") return {};
    if (name === "lucide-react") return {};
    if (name === "@/lib/atlas/commandSignal") return helpers;
    if (name === "@/components/om/chart/SignalFocusChart") return {};
    if (name === "@/lib/atlas/ideaChart") return {};
    if (name === "@/lib/atlas/open") return {};
    if (name === "@/components/om/experience") return {};
    if (name.endsWith(".css")) return {};
    throw new Error("Unexpected hook dependency: " + name);
  });
  function render(next) { if (next) props = { ...props, ...next }; let turns = 0;
    do { assert.ok(turns++ < 20, "hook settles"); cursor = 0; effects = []; dirty = false;
      view = component.useAtlasCommandSignal(props); effects.forEach((effect) => effect()); } while (dirty);
  }
  render();
  return {
    requests, events, timers, render,
    get view() { return view; }, get afterUnmount() { return afterUnmount; },
    run(method = "generate") { const pending = view[method](); render(); return pending; },
    async reply(request, body, status = 200) { request.resolve({ ok: status >= 200 && status < 300, status, json: async () => body }); await drain(); if (mounted) render(); },
    async beginBody(request) {
      const body = new Promise((resolve, reject) => { request.bodyResolve = resolve; request.bodyReject = reject; });
      request.resolve({ ok: true, status: 200, json: () => body }); await drain(); render();
    },
    async timeout() { for (const [id, timer] of [...timers]) if (timer.ms === 45_000) { timers.delete(id); timer.fn(); } await drain(); if (mounted) render(); },
    unmount() { mounted = false; slots.forEach((slot) => slot?.cleanup?.()); },
  };
}

test("a stalled Atlas generation times out, releases busy and can be retried without buying a window", async () => {
  const h = harness();
  assert.equal(h.requests.length, 0, "mount never generates or purchases access");
  h.run(); h.run();
  assert.equal(h.view.busy, true);
  assert.equal(h.requests.length, 1, "rapid Generate clicks are coalesced");
  const first = h.requests[0];
  assert.equal(first.url, "/api/command-center/idea");
  assert.equal(first.init.signal.aborted, false);
  await h.timeout();
  assert.equal(first.init.signal.aborted, true);
  assert.equal(h.view.busy, false);
  assert.match(h.view.error, /took too long.*Generate again/);
  assert.equal(h.view.result, null);
  h.run();
  assert.equal(h.requests.length, 2);
  assert.notEqual(h.requests[1].init.signal, first.init.signal);
  await h.reply(h.requests[1], signal());
  assert.equal(h.view.result.idea.id, "recorded-gold-call");
  assert.equal(h.view.busy, false);
  assert.equal(h.view.error, null);
  assert.equal(h.requests.filter((request) => request.url.endsWith("/pass")).length, 0);
  assert.equal(h.timers.size, 0);
  h.unmount();
});

test("a late result from a switched market cannot replace or unlock the new market request", async () => {
  const h = harness(); h.run();
  const old = h.requests[0]; old.ignoreAbort = true;
  h.render({ symbol: "EURUSD" });
  assert.equal(old.init.signal.aborted, true);
  assert.equal(h.view.supported, false);
  assert.equal(h.view.busy, false);
  assert.equal(h.view.result, null);
  h.render({ symbol: "XAUUSD" }); h.run();
  await h.reply(old, signal("old-call"));
  assert.equal(h.view.busy, true, "the old finally block cannot unlock the new request");
  assert.equal(h.view.result, null);
  await h.reply(h.requests[1], signal("new-call"));
  assert.equal(h.view.result.idea.id, "new-call");
  assert.equal(h.view.busy, false);
  h.unmount();
});

test("dismissing or unmounting ignores a transport's successful late completion", async () => {
  const h = harness(); h.run();
  const old = h.requests[0]; old.ignoreAbort = true;
  h.view.clear(); h.render();
  await h.reply(old, signal("dismissed"));
  assert.equal(h.view.result, null);
  assert.equal(h.view.error, null);
  h.run();
  const departing = h.requests[1]; departing.ignoreAbort = true;
  h.unmount();
  await h.reply(departing, signal("departed"));
  assert.equal(departing.init.signal.aborted, true);
  assert.equal(h.afterUnmount, 0);
});

test("pass pricing is read-only until explicit purchase, and the purchase receives the same abortable deadline", async () => {
  const h = harness(); h.run();
  await h.reply(h.requests[0], {}, 402);
  const lookup = h.requests[1];
  assert.equal(lookup.url, "/api/command-center/pass");
  assert.notEqual(lookup.init.method, "POST");
  assert.equal(lookup.init.signal, h.requests[0].init.signal);
  await h.reply(lookup, access());
  assert.equal(h.view.access.active, false);
  assert.equal(h.view.busy, false);
  h.run("openWindowAndGenerate");
  const purchase = h.requests[2];
  assert.equal(purchase.url, "/api/command-center/pass");
  assert.equal(purchase.init.method, "POST");
  assert.ok(purchase.init.signal instanceof AbortSignal, "the production helper forwards AbortSignal to the pass POST");
  await h.timeout();
  assert.equal(purchase.init.signal.aborted, true);
  assert.equal(h.view.busy, false);
  assert.match(h.view.error, /timed out.*credit balance/);
  assert.equal(h.requests.length, 3, "a timed-out purchase never generates or retries a charge automatically");
  assert.equal(h.events.length, 0);
  h.unmount();
});

test("a successful explicitly approved pass purchase and its following generation share one request signal", async () => {
  const h = harness(); h.run();
  await h.reply(h.requests[0], {}, 402);
  await h.reply(h.requests[1], access());
  h.run("openWindowAndGenerate");
  const purchase = h.requests[2];
  await h.reply(purchase, access(true));
  const generated = h.requests[3];
  assert.equal(generated.url, "/api/command-center/idea");
  assert.equal(generated.init.signal, purchase.init.signal);
  assert.deepEqual(h.events, ["credits-updated"]);
  await h.reply(generated, signal());
  assert.equal(h.view.result.idea.id, "recorded-gold-call");
  assert.equal(h.view.busy, false);
  assert.equal(h.requests.filter((request) => request.url.endsWith("/pass") && request.init.method === "POST").length, 1);
  h.unmount();
});

test("the access lookup is covered by the generation deadline and leaves an actionable timeout", async () => {
  const h = harness(); h.run();
  await h.reply(h.requests[0], {}, 402);
  await h.timeout();
  assert.equal(h.requests[1].init.signal.aborted, true);
  assert.equal(h.view.busy, false);
  assert.equal(h.view.access, null);
  assert.match(h.view.error, /access check took too long.*Generate again/);
  h.run();
  assert.equal(h.requests[2].url, "/api/command-center/idea");
  h.unmount();
});

test("a deadline while reading the response body still reports a timeout instead of silently returning no signal", async () => {
  const h = harness(); h.run();
  await h.beginBody(h.requests[0]);
  await h.timeout();
  assert.equal(h.view.busy, false);
  assert.equal(h.view.result, null);
  assert.match(h.view.error, /took too long.*Generate again/);
  h.unmount();
});
