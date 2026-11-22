import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { actionWords, convictionWords, stepWords, holdWords, streakOf } from '../src/lib/genx/words';
import { genxPeriod, GENX_HISTORY_MAX } from '../src/lib/floor/overview';

/**
 * GENX IN THE TRADING PLATFORM'S SHELL (owner 11-20 brief §8).
 *
 * GenxDesk is shared with the classic portal. Inside the new shell it is drawn as a gold workstation on the same
 * state and the same handlers; everywhere else exactly as before. The paid read stays the member's own tap.
 */
const read = (p: string) => readFileSync(p, 'utf8');
const desk = read('src/components/portal/floor/GenxDesk.tsx');
const home = read('src/components/om/genx/GenxHome.tsx');

test('the workstation is an early return of the same component, on the same handlers', () => {
  assert.match(desk, /const next = useNextShell\(\);\n  const \[mode, setMode\]/, 'decided before any state');
  const branch = desk.slice(desk.indexOf('  if (next) {\n    return (\n      <GenxHome'), desk.indexOf('  return (\n    <div className="rounded-2xl border border-amber-400/20'));
  assert.ok(branch.length > 300);
  assert.match(branch, /analyze=\{\(\) => void analyze\(\)\}/);
  assert.match(branch, /openPlay=\{\(id\) => void openPlay\(id\)\}/);
  assert.match(branch, /track=\{trackCurrent\} untrack=\{untrack\}/);
  assert.match(branch, /backToCurrent=\{\(\) => \{ setRes\(null\); setReplay\(null\); setErr\(""\); \}\}/, 'going back buys nothing');
});

test('opening GENX buys nothing: the page itself reads only the free shared state and the desk record', () => {
  const asks = [...home.matchAll(/fetch\(`([^`]+)`/g)].map((m) => m[1]);
  assert.deepEqual(asks.map((a) => a.split('?')[0]).sort(), ['/api/floor/overview', '/api/floor/setup']);
  assert.ok(!/method: "POST"/.test(home), 'nothing is posted from the page');
  assert.match(home, /onClick=\{p\.analyze\}/, 'the paid read is the Analyze button and nothing else');
  assert.match(home, /\/api\/floor\/overview\?only=genx/, 'the record only — no account is read for it');
  const route = read('src/app/api/floor/overview/route.ts');
  const only = route.slice(route.indexOf('if (url.searchParams.get("only") === "genx")'), route.indexOf('// ── the member\'s accounts'));
  assert.ok(only.length > 100 && !/accountFigures|flow_broker/.test(only), 'the desk-only answer asks no broker anything');
});

test('a saved read says so, keeps its own time, and the price beside it is labelled as now', () => {
  assert.match(home, /<b>Saved read · \{whenText\(saved\.at\)\}<\/b>/);
  assert.match(home, /Its levels start at the candle it was made on; the candles and the quote are gold now\./);
  // An earlier read is drawn from its own candle, labelled, and its steps start at the price it was made at (11-21).
  assert.match(home, /analysis=\{analysis\}/);
  assert.match(home, /t: "At the read"/);
  assert.match(home, />Back to current analysis</);
  assert.match(home, /\{!p\.saved && <p\.Confirm/, 'a saved read is not checked as if it were live');
  assert.ok(!/>LIVE</.test(home), 'no LIVE badge');
});

test('the main setup and the scalp are never mixed on the chart', async () => {
  const { readLevels } = await import('../src/components/om/genx/GenxHome');
  const g = { entry: 10, entry_low: 9, entry_high: 11, stop_loss: 5, tp1: 20, tp2: 25, tp3: null, closest_support: 8, closest_resistance: 12,
    scalp: { side: 'buy', entry: 7, stop: 6, target: 8.5, target_pips: 15, risk_pips: 10, rr: 1.5, reason: '' } } as never;
  const main = readLevels(g, 'main'), scalp = readLevels(g, 'scalp');
  assert.deepEqual(main.levels.map((l) => l.label), ['Resistance', 'Support', 'Entry', 'Stop', 'Target 1', 'Target 2']);
  assert.deepEqual(main.zone, { low: 9, high: 11 });
  assert.deepEqual(scalp.levels.map((l) => [l.label, l.price]), [['Scalp entry', 7], ['Scalp stop', 6], ['Scalp target', 8.5]]);
  assert.equal(scalp.zone, null, 'the scalp has no zone of the main setup');
});

test('the engine\'s states are said in words, and conviction is a score — never a chance of winning', () => {
  for (const a of ['BUY_NOW', 'SELL_NOW', 'BUY_LIMIT', 'SELL_LIMIT', 'BUY_STOP', 'SELL_STOP', 'WAIT_FOR_BUY_TRIGGER', 'WAIT_FOR_SELL_TRIGGER', 'WAIT', '']) {
    assert.ok(!/_/.test(actionWords(a).label) && actionWords(a).label === actionWords(a).label.replace(/^./, (c) => c.toUpperCase()), a);
  }
  assert.equal(actionWords('WAIT_FOR_SELL_TRIGGER').label, 'Waiting for a sell trigger');
  assert.equal(actionWords('WAIT_FOR_SELL_TRIGGER').side, 'sell');
  assert.equal(actionWords('NONSENSE').side, null);
  assert.equal(convictionWords(68), 'Conviction 68/100 · building');
  assert.ok(!/%/.test(convictionWords(91)!));
  assert.equal(convictionWords(null), null);
  assert.equal(stepWords('CONFIRM SELLERS'), 'Confirm sellers');
  assert.equal(stepWords('TP2'), 'Target 2');
  assert.equal(holdWords([45, 180]), '45m–3h');
  const live = desk.slice(desk.indexOf('  if (next) {\n    const T: Record<string, string>'), desk.indexOf('  const S: Record<string, { bg: string'));
  assert.ok(live.length > 200 && !/animate-pulse|✅|❌|👀|⏳/.test(live), 'the entry check: no pulsing, no emoji');
});

test('the history is the period\'s, newest first, and a run of results ends at a flat trade', () => {
  const fires = Array.from({ length: GENX_HISTORY_MAX + 3 }, (_, i) => ({ at: new Date(Date.UTC(2026, 10, 1) + i * 3600_000).toISOString(), side: 'buy', open: 0, avgPips: i % 2 ? 10 : -5 }));
  const r = genxPeriod(fires, { from: 0, to: Date.UTC(2027, 0, 1) });
  assert.equal(r.trades, GENX_HISTORY_MAX + 3);
  assert.equal(r.history!.length, GENX_HISTORY_MAX);
  assert.equal(r.historyMore, 3);
  assert.ok(Date.parse(r.history![0].at) > Date.parse(r.history![1].at), 'newest first');
  assert.deepEqual(streakOf([{ pips: 5 }, { pips: 3 }, { pips: -2 }]), { n: 2, win: true });
  assert.deepEqual(streakOf([{ pips: -1 }, { pips: 0 }, { pips: -4 }]), { n: 1, win: false });
  assert.equal(streakOf([{ pips: 0 }]), null);
});

test('engine results and an account\'s results are labelled apart, and following is FLOW\'s', () => {
  assert.match(home, /not any one account\. Your own account is in <Link href="\/portal\/trading\?view=flow"/);
  assert.match(home, /Which of your accounts take GENX trades is set in FLOW\./);
  assert.match(read('src/app/portal/genx/page.tsx'), /if \(wantsNextShell\(cookies\(\)\.get\(SHELL_COOKIE\)\?\.value, profile\?\.role === "admin", headers\(\)\)\) return <GenxDesk \/>;/, 'the tool uses the same shell decision as its layout');
});
