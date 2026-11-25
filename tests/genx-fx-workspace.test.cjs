const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { activeKey, activeTabKey } = require('../src/lib/floor/nav.ts');
const { PAIRS } = require('../src/lib/genfx/pairs.ts');
const NOW = Date.parse('2026-11-25T16:30:00Z');
const drain = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const nodes = (tree, predicate) => Array.isArray(tree) ? tree.flatMap((child) => nodes(child, predicate)) : !tree || typeof tree !== 'object' ? [] : [...(predicate(tree) ? [tree] : []), ...nodes(tree.props?.children, predicate)];
const text = (tree) => Array.isArray(tree) ? tree.map(text).join('') : tree == null || typeof tree === 'boolean' ? '' : typeof tree === 'object' ? text(tree.props?.children) : String(tree);

// Mount the actual controllers/presentations with isolated hooks and deferred requests.
// Charts and sibling desks are stand-ins; all actual prices, candle adapters and click handlers run.
function harness(file, exported, initial = {}, opts = {}) {
  const filename = path.resolve(__dirname, '..', file);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8') + (opts.append ?? ''), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true }, fileName: filename }).outputText;
  const slots = [], requests = [], events = [], listeners = new Map(), storage = new Map(Object.entries(opts.storage ?? {}));
  const timers = new Map(); let nextTimer = 0;
  let props = initial, cursor = 0, dirty = false, effects = [], tree, experience = opts.experience ?? 'simple';
  const changed = (before, after) => !before || !after || before.length !== after.length || after.some((value, i) => !Object.is(value, before[i]));
  const react = {
    useState(initialValue) { const index = cursor++; if (!slots[index]) slots[index] = { value: typeof initialValue === 'function' ? initialValue() : initialValue }; return [slots[index].value, (next) => { const value = typeof next === 'function' ? next(slots[index].value) : next; if (!Object.is(value, slots[index].value)) { slots[index].value = value; dirty = true; } }]; },
    useRef(initialValue) { const index = cursor++; if (!slots[index]) slots[index] = { current: initialValue }; return slots[index]; },
    useMemo(factory, deps) { const index = cursor++; if (!slots[index] || changed(slots[index].deps, deps)) slots[index] = { deps, value: factory() }; return slots[index].value; },
    useEffect(effect, deps) { const index = cursor++, before = slots[index]; if (!before || changed(before.deps, deps)) effects.push(() => { before?.cleanup?.(); slots[index] = { deps, cleanup: effect() }; }); },
  };
  react.useCallback = (fn, deps) => react.useMemo(() => fn, deps);
  const jsx = (type, value, key) => ({ type, key, props: value || {} });
  class Clock extends Date { constructor(...args) { if (args.length) super(...args); else super(NOW); } static now() { return NOW; } }
  const cache = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) };
  const dependencies = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' }, 'next/link': { __esModule: true, default: 'Link' },
    'lucide-react': new Proxy({}, { get: (_, name) => `icon:${String(name)}` }),
    '@/components/om/shell': { useNextShell: () => true },
    '@/components/om/experience': { useExperienceMode: () => ({ mode: experience, isSimple: experience === 'simple', setMode: (value) => { experience = value; dirty = true; } }) },
    '@/components/portal/floor/GenxDesk': { GenxDesk: 'GenxDesk' },
    '@/components/portal/floor/GenFxDesk': { GenFxDesk: 'GenFxDesk' },
    '@/components/om/genx/GenFxHome': { GenFxHome: 'GenFxHome' },
    '@/components/om/genx/GenxHome': { GenxHome: 'GenxHome' },
    '@/components/om/vision/VisionDirection': { VisionDirection: 'VisionDirection', VisionLevels: 'VisionLevels' },
    '@/components/om/vision/VisionChart': { VisionChart: 'VisionChart' },
    '@/components/om/chart/OmChart': { OmChart: 'OmChart' },
    '@/components/om/ProductIcon': { ProductIcon: 'ProductIcon' },
    '@/components/om/floor/Floor': { GenxCard: 'GenxCard' },
    '@/components/om/MobileSection': { MobileSection: 'MobileSection' },
    '@/components/portal/SetupLock': { SetupLock: 'SetupLock', SetupTimer: 'SetupTimer' },
    './SimpleGenxRead': { SimpleGenxRead: 'SimpleGenxRead', SimpleGenxLevels: 'SimpleGenxLevels' },
    './GenxFlow': { GenxFlow: 'GenxFlow', ConfirmHelp: 'ConfirmHelp' }, './GenFxFlow': { GenFxFlow: 'GenFxFlow' },
    '@/components/portal/floor/GenxFlow': { buildSteps: () => [] },
    '@/lib/atlas/open': { openAtlas: (request) => events.push(request) },
    '@/lib/atlas/signals': { atlasGenxResult: (value) => value, GENX_UPDATED_EVENT: 'genx-updated' },
    '@/lib/inView': { clearlyInView: () => true },
  };
  for (const name of ['genx/chartView', 'genx/words', 'genfx/pairs', 'floor/setupInstruments', 'floor/overview', 'floor/chart', 'cashtrap/marketHours', 'creditConfig', 'flow/display']) dependencies['@/lib/' + name] = require('../src/lib/' + name + '.ts');
  const context = vm.createContext({ Date: Clock, Math, Error, console, Event, URLSearchParams, AbortController, localStorage: cache,
    document: { visibilityState: 'visible' },
    window: { sessionStorage: cache, location: { search: '', pathname: '/portal/genx' }, history: { replaceState() {} }, scrollTo() {}, dispatchEvent: (event) => events.push(event.type),
      addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: (name) => listeners.delete(name) },
    setInterval: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms, repeat: true }); return id; }, clearInterval: (id) => timers.delete(id),
    setTimeout: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms, repeat: false }); return id; }, clearTimeout: (id) => timers.delete(id),
    fetch: (url, init) => new Promise((resolve, reject) => { requests.push({ url, init, resolve, reject }); if (!opts.ignoreAbort) init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); }),
  });
  const mod = { exports: {} };
  vm.runInContext(`(function(require,module,exports){${code}\n})`, context, { filename })((name) => { if (name.endsWith('.css')) return {}; if (name in dependencies) return dependencies[name]; throw new Error('Unexpected dependency ' + name); }, mod, mod.exports);
  function render(next) { if (next) props = { ...props, ...next }; let count = 0; do { assert.ok(count++ < 20, 'Component settles'); cursor = 0; dirty = false; effects = []; tree = mod.exports[exported](props); effects.forEach((effect) => effect()); } while (dirty); return tree; }
  async function fire(ms, repeat) { for (const [id, timer] of [...timers]) if (timer.ms === ms && timer.repeat === repeat && timers.has(id)) { if (!repeat) timers.delete(id); timer.fn(); } await drain(); render(); }
  render();
  return { render, requests, events, storage, value: () => tree, find: (predicate) => nodes(tree, predicate),
    expire: (ms) => fire(ms, false), poll: (ms) => fire(ms, true),
    experience(value) { experience = value; render(); },
    async reply(request, body, status = 200) { request.resolve({ ok: status >= 200 && status < 300, status, json: async () => body }); await drain(); render(); },
    unmount() { slots.forEach((slot) => slot?.cleanup?.()); },
  };
}

function fxRead(pair = 'EURUSD', mode = 'quick') {
  const entry = pair === 'EURUSD' ? 1.08432 : 201.457, unit = pair === 'EURUSD' ? .0001 : .01;
  const g = { symbol: pair, mode, action: 'WAIT_FOR_BUY_TRIGGER', directional_bias: 'bullish', market_regime: 'uptrend', lifecycle: 'developing', confidence_score: 68,
    entry, entry_low: entry - unit, entry_high: entry + unit, stop_loss: entry - 15 * unit, tp1: entry + 25 * unit, tp2: entry + 40 * unit, tp3: null,
    closest_support: entry - 3 * unit, closest_resistance: entry + 28 * unit, room_to_target_pips: 25,
    market_structure: 'Higher lows', momentum: 'Rising', volatility: 'Normal', buyer_control: 60, seller_control: 40,
    expected_hold_minutes: [20, 90], session: 'London', data_status: 'live', trigger_tf: '5-minute', context_tf: '15-minute / 1-hour',
    market_story: [PAIRS[pair].name + ' is testing its own support.'], trade_reasoning: ['Wait for the actual pair to close above support.'], risk_factors: ['Check upcoming currency news.'],
    invalidation_reason: 'A close below the recorded stop.', trigger_condition: 'Wait for a completed bullish rejection.', invalidation_price: entry - 15 * unit,
    projected_path: [], stop_pips: 15, tp1_pips: 25, tp2_pips: 40, tp3_pips: null, setup_type: 'retest', engine_state: 'DEVELOPING' };
  const candles = [0, 1, 2].map((i) => ({ t: new Date(NOW - (3 - i) * 300_000).toISOString(), o: entry - unit, h: entry + 2 * unit, l: entry - 2 * unit, c: entry }));
  return { ok: true, pair, mode, genfx: g, candles, price: entry + unit, asOf: new Date(NOW).toISOString(), data_status: 'live' };
}
function homeProps(pair = 'EURUSD') {
  const response = fxRead(pair), g = response.genfx;
  return { pair, setPair() {}, mode: 'quick', setMode() {}, analyze() {}, loading: false, error: '', response, saved: null, backToCurrent() {},
    plays: [], openPlay() {}, tracked: [], isTracked: false, track() {}, untrack() {}, Confirm: 'Confirm', billing: false, advancedTools: null,
    setup: { pair, side: 'buy', action: g.action, mode: g.mode, entry: g.entry, entryLow: g.entry_low, entryHigh: g.entry_high, stop: g.stop_loss, tp1: g.tp1, watch: g.closest_support, invalidation: g.stop_loss } };
}

test('Gold and FX share one destination, preserve visited desks, and open deterministic FX deep links', () => {
  const h = harness('src/components/om/genx/GenxWorkspace.tsx', 'GenxWorkspace');
  assert.equal(h.find((n) => n.type === 'GenxDesk').length, 1);
  assert.equal(h.find((n) => n.type === 'GenFxDesk').length, 0);
  h.find((n) => n.type === 'button' && text(n).includes('GenX FX'))[0].props.onClick(); h.render();
  assert.equal(h.find((n) => n.type === 'GenxDesk').length, 1, 'The already generated Gold desk remains mounted');
  assert.equal(h.find((n) => n.props.id === 'genx-gold-workspace')[0].props.hidden, true);
  h.render({ initialMarket: 'fx', initialPair: 'GBPJPY' });
  assert.equal(h.find((n) => n.type === 'GenFxDesk')[0].props.initialPair, 'GBPJPY');
  assert.equal(h.requests.length, 0, 'Selecting Gold or FX never generates an analysis');
  for (const [url, view] of [['/portal/genfx', null], ['/portal/genx', null], ['/portal/trading', 'genfx']]) {
    assert.equal(activeKey(url, view), 'genx'); assert.equal(activeTabKey(url, view), 'tools');
  }
  h.unmount();
});

test('FX generation uses its real pair-specific endpoint once, and late answers cannot cross pair or horizon changes', async () => {
  const h = harness('src/components/portal/floor/GenFxDesk.tsx', 'GenFxDesk', { initialPair: 'EURUSD' });
  assert.ok(h.requests.every((r) => !r.init?.method), 'Opening the FX workspace only loads existing reads and account status');
  h.value().props.analyze(); h.value().props.analyze(); h.render();
  const first = h.requests.find((r) => r.url === '/api/genfx');
  assert.equal(h.requests.filter((r) => r.url === '/api/genfx').length, 1);
  assert.deepEqual(JSON.parse(first.init.body), { pair: 'EURUSD', mode: 'quick' });
  h.value().props.setPair('GBPJPY'); h.render();
  assert.equal(h.value().props.response, null);
  h.value().props.setMode('intraday'); h.render(); h.value().props.analyze(); h.render();
  const second = h.requests.filter((r) => r.url === '/api/genfx').at(-1);
  assert.deepEqual(JSON.parse(second.init.body), { pair: 'GBPJPY', mode: 'intraday' });
  await h.reply(first, fxRead('EURUSD'));
  assert.equal(h.value().props.response, null);
  assert.equal(h.value().props.loading, true, 'An old result cannot finish the new request');
  const newest = fxRead('GBPJPY', 'intraday'); await h.reply(second, newest);
  assert.equal(h.value().props.response, newest);
  assert.equal(h.value().props.setup.pair, 'GBPJPY');
  assert.ok(h.requests.filter((r) => r.init?.method === 'POST').every((r) => r.url === '/api/genfx'), 'No arming, broker or Gold endpoint is substituted');
  h.unmount();
});

test('existing pair-open notes and changed deep-link props select FX without automatically generating', () => {
  const h = harness('src/components/portal/floor/GenFxDesk.tsx', 'GenFxDesk', {}, { storage: { 'genfx:open-pair': 'GBPJPY' } });
  assert.equal(h.value().props.pair, 'GBPJPY'); assert.equal(h.storage.has('genfx:open-pair'), false);
  h.render({ initialPair: 'EURUSD' }); assert.equal(h.value().props.pair, 'EURUSD');
  assert.equal(h.requests.filter((r) => r.init?.method === 'POST').length, 0);
  h.unmount();
});

test('saved FX reads retain their pair and horizon, are never live, and supersede an older in-flight analysis', async () => {
  const h = harness('src/components/portal/floor/GenFxDesk.tsx', 'GenFxDesk', { initialPair: 'EURUSD' });
  h.value().props.analyze(); h.render(); const pending = h.requests.find((r) => r.url === '/api/genfx');
  h.value().props.openPlay('saved-gbpjpy'); h.render();
  const saved = fxRead('GBPJPY', 'swing');
  await h.reply(h.requests.find((r) => r.url.includes('/api/genfx/history?id=')), { play: { id: 'saved-gbpjpy', pair: 'GBPJPY', mode: 'swing', genfx: saved.genfx, price: saved.price, data_status: 'live', at: saved.asOf, asOf: saved.asOf } });
  assert.equal(h.value().props.pair, 'GBPJPY'); assert.equal(h.value().props.mode, 'swing');
  assert.equal(h.value().props.response.data_status, 'reference'); assert.equal(h.value().props.response.candles.length, 0);
  assert.equal(h.value().props.saved.mode, 'swing');
  await h.reply(pending, fxRead('EURUSD'));
  assert.equal(h.value().props.response.pair, 'GBPJPY'); assert.equal(h.value().props.saved.mode, 'swing');
  h.unmount();
});

test('a wrong-pair result and an insufficient-credit response stay explicit and never purchase or retry automatically', async () => {
  const h = harness('src/components/portal/floor/GenFxDesk.tsx', 'GenFxDesk', { initialPair: 'EURUSD' });
  h.value().props.analyze(); h.render(); await h.reply(h.requests.find((r) => r.url === '/api/genfx'), fxRead('GBPJPY'));
  assert.equal(h.value().props.response, null); assert.match(h.value().props.error, /verify a EUR\/USD read/);
  h.value().props.analyze(); h.render(); await h.reply(h.requests.filter((r) => r.url === '/api/genfx').at(-1), { error: 'insufficient_credits', balance: 0 }, 402);
  assert.match(h.value().props.error, /Not enough credits/); assert.equal(h.events.filter((e) => e === 'open-credits-flyer').length, 1);
  assert.deepEqual(h.requests.filter((r) => r.init?.method === 'POST').map((r) => r.url), ['/api/genfx', '/api/genfx']);
  h.unmount();
});

test('an FX analysis deadline releases the busy guard, warns about a possible completed charge, and rejects a late result', async () => {
  for (const ignoreAbort of [false, true]) {
    const h = harness('src/components/portal/floor/GenFxDesk.tsx', 'GenFxDesk', { initialPair: 'EURUSD' }, { ignoreAbort });
    h.value().props.analyze(); h.render();
    const first = h.requests.find((r) => r.url === '/api/genfx');
    assert.equal(h.value().props.loading, true);
    await h.expire(75_000);
    assert.equal(first.init.signal.aborted, true);
    assert.equal(h.value().props.loading, false);
    assert.match(h.value().props.error, /Check your saved FX reads before retrying/);
    assert.match(h.value().props.error, /server may still finish.*credit charge/);
    assert.equal(h.requests.filter((r) => r.init?.method === 'POST').length, 1, 'A timeout never retries or purchases automatically');
    await h.reply(first, fxRead());
    assert.equal(h.value().props.response, null, 'Even a transport that ignores abort cannot install the expired result');
    assert.match(h.value().props.error, /saved FX reads/);
    h.value().props.analyze(); h.render();
    const retry = h.requests.filter((r) => r.url === '/api/genfx').at(-1);
    assert.notEqual(retry, first, 'A new explicit click is allowed after the deadline');
    assert.equal(h.value().props.loading, true);
    await h.reply(retry, fxRead());
    assert.equal(h.value().props.response.pair, 'EURUSD');
    assert.equal(h.value().props.loading, false);
    h.unmount();
  }
});

test('free FX context polls time out without overlap, preserve dated data, and never claim a streamed quote', async () => {
  const props = { ...homeProps(), response: null, setup: null };
  const h = harness('src/components/om/genx/GenFxHome.tsx', 'GenFxHome', props, { ignoreAbort: true, experience: 'advanced' });
  const fresh = fxRead(), context = { symbol: 'EURUSD', g: fresh.genfx, candles: fresh.candles, candlesTz: 'UTC', price: fresh.price, asOf: fresh.asOf };
  await h.reply(h.requests[0], context);
  let chart = h.find((n) => n.type === 'OmChart')[0];
  assert.equal(chart.props.priceLive, false, 'A recent setup retrieval is recorded context even when the read says live');
  assert.match(text(h.value()), /Last market read/);
  await h.poll(20_000); const expired = h.requests.at(-1);
  assert.equal(h.requests.length, 2);
  await h.poll(20_000);
  assert.equal(h.requests.length, 2, 'An outstanding context request cannot overlap the next poll');
  await h.expire(25_000);
  assert.equal(expired.init.signal.aborted, true);
  assert.match(text(h.value()), /Refresh unavailable · last market read/);
  assert.equal(h.find((n) => n.type === 'VisionDirection')[0].props.status, 'REFRESH NEEDED');
  assert.equal(h.find((n) => n.type === 'OmChart')[0].props.price, fresh.price, 'The last recorded chart remains visible');
  await h.poll(20_000); const recovered = h.requests.at(-1);
  assert.equal(h.requests.length, 3, 'A timed-out free read releases the polling guard');
  await h.reply(expired, { ...context, price: 9 });
  assert.equal(h.find((n) => n.type === 'OmChart')[0].props.price, fresh.price, 'A late aborted context cannot replace the recorded quote');
  assert.match(text(h.value()), /Refresh unavailable/);
  await h.poll(20_000); assert.equal(h.requests.length, 3, 'An old finally block cannot release the newer polling guard');
  await h.reply(recovered, { ...context, g: { ...fresh.genfx, data_status: 'reference' }, price: undefined });
  chart = h.find((n) => n.type === 'OmChart')[0];
  assert.equal(chart.props.price, fresh.candles.at(-1).c);
  assert.equal(chart.props.priceLive, false, 'Candle-price fallback remains recorded context');
  assert.equal(h.find((n) => n.type === 'VisionDirection')[0].props.status, 'MARKET CONTEXT');
  assert.doesNotMatch(text(h.value()), /Refresh unavailable/);
  assert.equal(h.requests.filter((r) => r.init?.method === 'POST').length, 0);
  h.unmount();
});

test('FX Simple and Advanced share real precision, candles and the same confirmation identity without another request', () => {
  for (const pair of ['EURUSD', 'GBPJPY']) {
    const props = homeProps(pair), h = harness('src/components/om/genx/GenFxHome.tsx', 'GenFxHome', props);
    const simple = h.find((n) => n.type === 'SimpleGenxLevels')[0];
    assert.equal(simple.props.dec, PAIRS[pair].dec); assert.equal(simple.props.entry, props.response.genfx.entry);
    const chart = h.find((n) => n.type === 'OmChart')[0];
    assert.equal(chart.props.dec, PAIRS[pair].dec); assert.equal(chart.props.bars.length, 3); assert.equal(chart.props.snapshot, true); assert.equal(chart.props.priceLive, false);
    assert.equal(chart.props.price, props.response.price); assert.match(chart.props.label, new RegExp(PAIRS[pair].name));
    const confirmation = h.find((n) => n.type === 'Confirm')[0], requests = h.requests.length;
    h.experience('advanced');
    assert.equal(h.find((n) => n.type === 'VisionLevels')[0].props.entry, simple.props.entry);
    assert.equal(h.find((n) => n.type === 'OmChart')[0].props.price, chart.props.price);
    assert.equal(h.find((n) => n.type === 'Confirm')[0].key, confirmation.key);
    assert.equal(h.find((n) => n.type === 'Confirm')[0].props.setup, confirmation.props.setup);
    assert.equal(h.requests.length, requests); assert.equal(h.requests.filter((r) => r.init?.method === 'POST').length, 0);
    h.unmount();
  }
});

test('a saved FX read without candles never borrows the current pair feed as its historical chart', async () => {
  const props = homeProps('GBPJPY'); props.saved = { at: props.response.asOf, mode: 'swing' }; props.response = { ...props.response, candles: [], genfx: { ...props.response.genfx, mode: 'swing' } };
  const h = harness('src/components/om/genx/GenFxHome.tsx', 'GenFxHome', props);
  const fresh = fxRead('GBPJPY'); await h.reply(h.requests[0], { symbol: 'GBPJPY', g: fresh.genfx, candles: fresh.candles, candlesTz: 'UTC', price: 215, asOf: fresh.asOf });
  assert.equal(h.find((n) => n.type === 'OmChart').length, 0);
  assert.match(text(h.value()), /original candles were not stored/);
  assert.equal(h.find((n) => n.type === 'SimpleGenxRead')[0].props.quote, props.response.price);
  assert.equal(h.find((n) => n.type === 'SimpleGenxLevels')[0].props.entry, props.response.genfx.entry);
  assert.equal(h.find((n) => n.type === 'Confirm').length, 0, 'Saved analyses do not start a current-entry confirmation');
  h.unmount();
});

test('elementary FX price labels use each currency pair precision without Gold rounding', () => {
  const eur = harness('src/components/om/genx/SimpleGenxRead.tsx', 'SimpleGenxLevels', { entry: 1.08432, stop: 1.08282, target: 1.08682, dec: 5, reference: true });
  assert.match(text(eur.value()), /Entry price1\.08432Protection stop1\.08282First target1\.08682/);
  const jpy = harness('src/components/om/genx/SimpleGenxRead.tsx', 'SimpleGenxLevels', { entry: 201.457, stop: 201.307, target: 201.707, dec: 3, reference: true });
  assert.match(text(jpy.value()), /Entry price201\.457Protection stop201\.307First target201\.707/);
});

test('Gold still sends its original priced request and no pair field is injected', () => {
  const h = harness('src/components/portal/floor/GenxDesk.tsx', 'GenxDesk');
  assert.equal(h.requests.filter((r) => r.init?.method === 'POST').length, 0);
  h.value().props.analyze(); h.render();
  const request = h.requests.find((r) => r.init?.method === 'POST');
  assert.equal(request.url, '/api/genx'); assert.deepEqual(JSON.parse(request.init.body), { mode: 'quick' });
  h.unmount();
});

test('Gold confirmation setup identity survives presentation renders without restarting its entry check', () => {
  const g = fxRead().genfx;
  let mappings = 0;
  const p = { saved: null, readAt: new Date(NOW).toISOString(), Confirm: 'Confirm', setupOf: (read) => { mappings++; return { entry: read.entry, stop: read.stop_loss }; }, isTracked: false, track() {} };
  const h = harness('src/components/om/genx/GenxHome.tsx', 'TestDecision', { p, g, subject: 'main' }, { append: '\nexport { Decision as TestDecision };' });
  const before = h.find((n) => n.type === 'Confirm')[0];
  h.experience('advanced');
  assert.equal(h.find((n) => n.type === 'Confirm')[0].props.setup, before.props.setup);
  assert.equal(h.find((n) => n.type === 'Confirm')[0].key, before.key);
  assert.equal(mappings, 1, 'Presentation changes do not construct a new confirmation request');
  h.render({ g: { ...g, entry: g.entry + .001 } });
  assert.equal(mappings, 2, 'An actual new setup still receives its own confirmation');
  h.unmount();
});
