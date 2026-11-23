const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const nodes = (tree, predicate) => Array.isArray(tree) ? tree.flatMap((item) => nodes(item, predicate))
  : !tree || typeof tree !== 'object' ? [] : [...(predicate(tree) ? [tree] : []), ...nodes(tree.props?.children, predicate)];
const content = (tree) => Array.isArray(tree) ? tree.map(content).join('') : tree == null || typeof tree === 'boolean' ? ''
  : typeof tree === 'object' ? content(tree.props?.children) : String(tree);
const plain = (value) => JSON.parse(JSON.stringify(value));

function harness(initial, options = {}) {
  const slots = [], cache = new Map(), requests = [], actions = { taken: 0, manual: [], shown: [], asked: [] };
  let cursor = 0, tree, effects = [], dirty = false, generated = initial;
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const react = {
    useState(initialValue) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initialValue === 'function' ? initialValue() : initialValue;
      return [slots[i], (next) => { const value = typeof next === 'function' ? next(slots[i]) : next; if (!Object.is(slots[i], value)) { slots[i] = value; dirty = true; } }]; },
    useRef(value) { const i = cursor++; return slots[i] ??= { current: value }; },
    useMemo(factory, deps) { const i = cursor++; if (!slots[i] || !same(slots[i].deps, deps)) slots[i] = { value: factory(), deps }; return slots[i].value; },
    useCallback(callback, deps) { return react.useMemo(() => callback, deps); },
    useEffect(effect, deps) { const i = cursor++; const old = slots[i]; if (old && same(old.deps, deps)) return;
      slots[i] = { deps, cleanup: old?.cleanup }; effects.push(() => { old?.cleanup?.(); slots[i].cleanup = effect(); }); },
  };
  const jsx = (type, props) => typeof type === 'function' ? type(props || {}) : { type, props: props || {} };
  const context = vm.createContext({
    fetch: async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : null;
      requests.push({ url, method: init.method || 'GET', body });
      assert.equal(url, '/test/idea', 'the display never requests a live feed or another service');
      const response = !body ? { ideas: [], kept: true }
        : body.action === 'generate' ? { ok: true, idea: generated, saved: true, copy: 'Saved call' }
          : body.action === 'watch' ? { ok: true, message: 'Watching this saved level.' }
            : body.action === 'follow' ? { ok: true, idea: generated, update: { follow: { state: 'waiting', at: generated.at, canExecute: false }, now: { price: 9999 }, verdict: 'Still waiting.' } }
              : assert.fail('unexpected mutation: ' + body.action);
      return { ok: true, status: 200, json: async () => response };
    },
    window: { matchMedia: () => ({ matches: true }), setInterval: () => 1, clearInterval: () => {}, setTimeout: (fn) => { queueMicrotask(fn); return 1; } },
    navigator: { clipboard: { writeText: async () => {} } },
    performance: { now: () => 0 }, requestAnimationFrame: () => 1, cancelAnimationFrame: () => {},
  });
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename).exports;
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true }, fileName: filename,
    }).outputText;
    const mod = { exports: {} }; cache.set(filename, mod);
    const requireHere = (name) => {
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'Fragment' };
      if (name === 'lucide-react') return new Proxy({}, { get: (_, key) => `icon:${String(key)}` });
      if (name.endsWith('.css')) return {};
      if (name === '@/components/om/chart/SignalFocusChart') return { SignalFocusChart: 'SignalFocusChart' };
      const base = name.startsWith('@/') ? path.join(ROOT, 'src', name.slice(2)) : name.startsWith('.') ? path.resolve(path.dirname(filename), name) : null;
      if (base) {
        const resolved = [base, `${base}.ts`, `${base}.tsx`].find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
        if (resolved) return load(resolved);
      }
      throw new Error('Unexpected idea dependency: ' + name);
    };
    vm.runInContext(`(function(require,module,exports){${code}\n})`, context, { filename })(requireHere, mod, mod.exports);
    return mod.exports;
  }
  const { IdeaPanel } = load(path.join(ROOT, 'src/components/command-center/hud/IdeaPanel.tsx'));
  const props = { endpoint: '/test/idea', replay: false, runSignal: 0, shown: null, canTrade: true, riskPct: 1, account: null,
    onShow: (...args) => actions.shown.push(args), onTake: () => actions.taken++, onManual: (value) => actions.manual.push(value), onAsk: (value) => actions.asked.push(value), ...options };
  const render = () => { cursor = 0; dirty = false; tree = IdeaPanel(props); const pending = effects; effects = []; pending.forEach((effect) => effect()); return tree; };
  const flush = async () => { for (let n = 0; n < 10; n++) { await new Promise(setImmediate); if (dirty) render(); } };
  render();
  return { requests, actions, render, flush, text: () => content(tree), find: (predicate) => nodes(tree, predicate),
    async generate(next = generated) { generated = next; nodes(tree, (node) => node.props['data-generate'] !== undefined)[0].props.onClick(); await flush(); },
  };
}

function fixture(kind = 'enter_now', via = 'take_setup') {
  const at = Date.UTC(2026, 10, 22, 12, 0);
  return { version: '1', id: 'idea-a', at, snapshotAt: at, snapshotId: 1, options: { style: 'auto' }, kind,
    source: kind === 'enter_now' ? 'setup_engine' : 'read_plan', side: 'buy', style: 'quick', strategy: 'Saved structure',
    headline: 'Gold at a saved support', badge: kind === 'enter_now' ? 'Confirmed setup' : 'Wait for confirmation', price: 3502,
    chart: { tf: '5m', candles: Array.from({ length: 8 }, (_, i) => ({ t: at - (8 - i) * 300_000, o: 3498 + i, h: 3501 + i, l: 3496 + i, c: 3500 + i })) },
    entry: { type: kind === 'enter_now' ? 'market' : 'limit', price: 3501, low: 3500, high: 3501, level: null, trigger: 'Hold support', confirm: 'none', text: 'Review this saved entry.', distancePips: 10 },
    stop: { price: 3490, pips: 110, what: 'Below saved support.' },
    targets: [3515, 3525, 3540].map((price, i) => ({ label: `TP${i + 1}`, price, pips: 140 + 100 * i, r: 1.3 + i, basis: 'level', what: 'Recorded target.' })),
    rr: { first: 1.3, best: 3.5 }, confidence: { score: 72, label: 'Medium', basis: 'Recorded evidence.' },
    reasoning: 'I am using the recorded support.\n\nThis explanation belongs after the saved chart.',
    bias: 'bullish', poi: null, targeting: 'Recorded resistance.', invalidation: { text: 'Below support.', price: 3490 },
    confirmations: [{ label: 'Support held', ok: true, detail: null }], waitingFor: [], engine: { state: 'ready', headline: 'Setup', say: 'Ready' },
    alternative: null, paths: [], warnings: [], expiresAt: null,
    execute: { via, now: kind === 'enter_now', note: 'Review on the next screen.', approved: null,
      manual: via === 'manual' ? { side: 'buy', style: 'quick', stop: 3490, takeProfit: 3515 } : null },
    watch: { price: 3501, direction: 'above', say: 'Watch saved entry.' }, say: 'Saved call.',
  };
}

test('native Atlas keeps price and levels above saved candles, then its full typed reasoning', async () => {
  const idea = fixture(), h = harness(idea);
  await h.flush();
  assert.equal(h.requests.filter((request) => request.method === 'POST').length, 0, 'mounting does not generate or watch');
  await h.generate();
  const chart = h.find((node) => node.type === 'SignalFocusChart')[0];
  assert.ok(chart);
  assert.deepEqual(plain(chart.props.bars), idea.chart.candles);
  assert.equal(chart.props.tfLabel, '5M');
  assert.equal(chart.props.tfMs, 300_000);
  assert.equal(chart.props.timeKnown, true);
  assert.equal(chart.props.price, 3502);
  assert.equal(chart.props.priceLive, false);
  assert.equal(chart.props.snapshot, true);
  assert.equal(chart.props.reference, false);
  assert.equal(chart.props.direction, 'buy');
  assert.deepEqual(plain(chart.props.levels.map((level) => level.price)), [3501, 3490, 3515, 3525, 3540]);
  const ordered = h.find((node) => node.props['data-idea-levels'] !== undefined || node.type === 'SignalFocusChart' || node.props['data-idea-reasoning'] !== undefined);
  assert.match(content(ordered[0]), /Price at signal3,502.00/);
  assert.match(content(ordered[0]), /TP33540|TP33,540/);
  assert.equal(ordered[1], chart);
  assert.equal(ordered[2].props['data-typing'], '0', 'reduced motion keeps the complete original explanation');
  assert.match(content(ordered[2]), /This explanation belongs after the saved chart/);
  assert.ok(h.find((node) => node.props['data-om-chart-host'] !== undefined).length === 1, 'fullscreen has a local theme host');
  assert.equal(h.actions.taken, 0);
  h.find((node) => node.props['data-idea-take'] !== undefined)[0].props.onClick();
  assert.equal(h.actions.taken, 1, 'execution still hands off to the existing confirmation surface');
  assert.deepEqual(h.requests.filter((request) => request.method === 'POST').map((request) => request.body.action), ['generate']);
});

test('native Atlas fullscreen host sits outside the transformed card and sibling-spacing wrapper', async () => {
  const h = harness(fixture());
  await h.generate();
  const tree = h.render();
  const hosts = h.find((node) => node.props['data-om-chart-host'] !== undefined);
  assert.equal(hosts.length, 1);
  assert.equal(hosts[0], tree, 'fullscreen is appended at the component root, not within the animated card');
  assert.equal(tree.props.className, 'cc-idea-chart-host');
  const spacedContent = tree.props.children;
  assert.equal(spacedContent.props.className, 'space-y-3', 'the spacing selector applies only to content siblings');
  const animatedCard = nodes(spacedContent, (node) => node.props['data-idea-kind'] !== undefined)[0];
  assert.match(animatedCard.props.className, /hud-in.*overflow-hidden/);
  assert.equal(nodes(animatedCard, (node) => node.props['data-om-chart-host'] !== undefined).length, 0,
    'a retained animation transform cannot capture the fixed fullscreen sheet');
  assert.equal(nodes(animatedCard, (node) => node.props['data-idea-chart'] !== undefined).length, 1,
    'the inline chart stays in its original card');
  assert.deepEqual(h.requests.filter((request) => request.method === 'POST').map((request) => request.body.action), ['generate']);
});

test('pending native Atlas reads retain their reference zone and watch action without becoming executable', async () => {
  const idea = fixture('at_level'), h = harness(idea);
  await h.generate();
  const chart = h.find((node) => node.type === 'SignalFocusChart')[0];
  assert.equal(chart.props.reference, true);
  assert.deepEqual(plain(chart.props.zone), { low: 3500, high: 3501 });
  assert.ok(chart.props.levels.every((level) => level.label.startsWith('Reference ')));
  assert.match(h.text(), /Not executable yet/);
  assert.equal(h.find((node) => node.props['data-idea-take'] !== undefined || node.props['data-idea-ticket'] !== undefined).length, 0);
  assert.deepEqual(h.requests.filter((request) => request.method === 'POST').map((request) => request.body.action), ['generate']);
  h.find((node) => node.props['data-idea-watch'] !== undefined)[0].props.onClick();
  await h.flush();
  assert.deepEqual(plain(h.requests.at(-1).body), { action: 'watch', id: idea.id });
  assert.match(h.text(), /Watching this saved level/);
});

test('a native Atlas manual ticket keeps its exact original handoff and requires a user tap', async () => {
  const idea = fixture('enter_now', 'manual'), h = harness(idea);
  await h.generate();
  assert.deepEqual(h.actions.manual, []);
  h.find((node) => node.props['data-idea-ticket'] !== undefined)[0].props.onClick();
  assert.deepEqual(plain(h.actions.manual[0]), { side: 'buy', style: 'quick', stop: 3490, takeProfit: 3515,
    headline: idea.headline, reason: idea.reasoning.replace(/\s*\n+\s*/g, ' '), invalidation: idea.invalidation.text,
    evidence: ['Support held'], ideaId: idea.id });
  assert.equal(h.requests.filter((request) => request.method === 'POST').length, 1, 'opening the ticket sends no order');
});

test('native Atlas legacy and stand-aside reads do not invent candles, prices or directional levels', async () => {
  const legacy = fixture(); delete legacy.chart;
  const h = harness(legacy);
  await h.generate();
  assert.equal(h.find((node) => node.type === 'SignalFocusChart').length, 0);
  assert.match(h.text(), /Candle chart unavailable for this saved read/);
  const neutral = { ...fixture('stand_aside'), id: 'idea-neutral', price: null, side: null };
  await h.generate(neutral);
  const chart = h.find((node) => node.type === 'SignalFocusChart')[0];
  assert.equal(chart.props.direction, 'neutral');
  assert.equal(chart.props.price, null, 'missing saved quote is never replaced by a current quote');
  assert.equal(chart.props.levels.length, 0, 'dormant plan numbers do not create an actionable projection');
  assert.equal(chart.props.zone, null);
  assert.equal(h.find((node) => node.props['data-idea-execute'] !== undefined).length, 0);
});

test('a single actual native Atlas candle is kept and a replacement idea gets only its own snapshot', async () => {
  const initial = fixture(), h = harness(initial);
  await h.generate();
  const oldKey = h.find((node) => node.type === 'SignalFocusChart')[0].props.viewKey;
  const next = { ...fixture('on_confirmation'), id: 'idea-b', at: initial.at + 300_000, side: 'sell' };
  next.chart.candles = [next.chart.candles[3], { ...next.chart.candles[4], t: null }, { ...next.chart.candles[5], t: next.at + 1 }];
  await h.generate(next);
  const chart = h.find((node) => node.type === 'SignalFocusChart')[0];
  assert.notEqual(chart.props.viewKey, oldKey);
  assert.equal(chart.props.bars.length, 1, 'malformed and future rows are dropped without invented padding');
  assert.equal(chart.props.bars[0].t, next.chart.candles[0].t);
  assert.equal(chart.props.direction, 'sell');
  assert.equal(chart.props.reference, true);
  assert.equal(h.find((node) => node.type === 'SignalFocusChart').length, 1);
  assert.ok(h.requests.every((request) => request.url === '/test/idea'));
});
