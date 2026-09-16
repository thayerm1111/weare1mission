import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSeries, goldMarketOpen, lastClosed } from '../src/lib/genx3/v31/series';
import { step32, newState32, type Step32 } from '../src/lib/genx3/v32/engine';
import { CONFIG32, STRATEGY_VERSION_32 } from '../src/lib/genx3/v32/config';
import { buildSignal32, validateSignal32, pdRow } from '../src/lib/genx3/v32/runtime';
import { PD_SETUP, tradingDayKey, anchorOf } from '../src/lib/genx3/v32/pdhpdl';
import type { Bar } from '../src/lib/genx3/candles';

const M = 60000;
function prefix(days: number, seed = 7): Bar[] {
  let s = seed, px = 4300; const out: Bar[] = []; const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const t0 = Date.UTC(2026, 5, 7, 22, 0);          // Sun 18:00 NY
  for (let m = 0; m < days * 1440; m++) { const t = t0 + m * M; if (!goldMarketOpen(t)) continue; const o = px, c = +(o + (rnd() - 0.5) * 0.9 + Math.sin(m / 600) * 0.02).toFixed(2); out.push({ t, o, h: +(Math.max(o, c) + rnd() * 0.3).toFixed(2), l: +(Math.min(o, c) - rnd() * 0.3).toFixed(2), c }); px = c; }
  return out;
}
/** Append a scripted trading day: path = [minuteOffset, price] knots (price relative to PDH, in ATR15 units). */
function scripted(base: Bar[], knots: [number, number][], seed = 3) {
  let s = seed; const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  // day start: first open minute after the last prefix bar's trading day
  let t = base[base.length - 1].t + M; const k0 = tradingDayKey(base[base.length - 1].t);
  while (!goldMarketOpen(t) || tradingDayKey(t) === k0) t += M;
  const key = tradingDayKey(base[base.length - 1].t); let H = -Infinity; for (const b of base) if (tradingDayKey(b.t) === key && b.h > H) H = b.h;
  const ser = buildSeries(base); const A = ser.m15.atr[ser.m15.atr.length - 1];
  const bars = base.slice(); let px = bars[bars.length - 1].c; const start = t;
  const end = knots[knots.length - 1][0];
  for (let m = 0; m <= end; m++) {
    let j = 0; while (j < knots.length - 2 && knots[j + 1][0] < m) j++;
    const [m0, p0] = knots[j], [m1, p1] = knots[j + 1]; const target = H + A * (p0 + (p1 - p0) * Math.min(1, Math.max(0, (m - m0) / Math.max(1, m1 - m0))));
    const o = px, c = +(target + (rnd() - 0.5) * 0.1 * A).toFixed(2);
    bars.push({ t: start + m * M, o, h: +(Math.max(o, c) + rnd() * 0.08 * A).toFixed(2), l: +(Math.min(o, c) - rnd() * 0.08 * A).toFixed(2), c }); px = c;
  }
  return { bars, H, A, start, end: start + end * M };
}
const mirror = (bars: Bar[], P = 4300): Bar[] => bars.map((b) => ({ t: b.t, o: +(2 * P - b.o).toFixed(2), c: +(2 * P - b.c).toFixed(2), h: +(2 * P - b.l).toFixed(2), l: +(2 * P - b.h).toFixed(2) }));
function run(bars: Bar[], from: number, to: number) {
  const s = buildSeries(bars); const st = newState32(); const steps: Step32[] = [];
  for (let a = Math.ceil(from / M) * M; a <= to; a += M) steps.push(step32(s, a, st));
  return { s, st, steps };
}
const pdRecs = (steps: Step32[]) => steps.flatMap((r) => r.records.filter((x) => x.setup === PD_SETUP && x.status !== 'WAITED').map((x) => ({ asOf: r.asOf, r, x })));

const BASE = prefix(9);
// approach with tests → displacement break → acceptance → pullback into zone → defended → continuation
const BULL: [number, number][] = [[0, -3], [150, -1.2], [180, -0.3], [200, -0.8], [230, -0.2], [250, -0.6], [275, -0.15], [283, 1.3], [300, 1.5], [330, 1.8], [345, 1.6], [375, 0.6], [390, 0.15], [394, 0.05], [397, 0.45], [405, 0.7], [410, 0.75], [425, 1.1], [470, 2.4], [560, 3.5]];
const bull = scripted(BASE, BULL);

test('bullish PDH: BREAK → ACCEPT → RETEST → DEFEND → CONTINUE produces exactly one BUY candidate', () => {
  const { steps } = run(bull.bars, bull.start - 30 * M, bull.end);
  const phases = new Set(steps.flatMap((r) => r.pd.filter((m) => m.level === 'PDH').flatMap((m) => m.transitions.map((x) => x.to))));
  for (const p of ['APPROACHING', 'LEVEL_BROKEN', 'WAITING_FOR_ACCEPTANCE', 'BREAKOUT_ACCEPTED', 'WAITING_FOR_RETEST', 'RETEST_IN_PROGRESS', 'RETEST_DEFENDED', 'ENTRY_ARMED', 'ENTRY']) assert.ok(phases.has(p as never), `missing ${p}; saw ${[...phases]}`);
  const recs = pdRecs(steps);
  assert.equal(recs.length, 1, 'one candidate, no duplicates');
  const { x } = recs[0]; const c = x.cand!;
  assert.equal(x.side, 'BUY');
  assert.ok(c.stop < bull.H - 0.25 * bull.A, `stop ${c.stop} must sit beyond the level buffer, not on PDH ${bull.H}`);
  assert.ok(c.entry > bull.H && c.entry - bull.H <= 1.5 * bull.A + 1e-6, 'entry near the defended retest, not chased');
  assert.ok(c.target > c.entry && c.evidence.some((e) => e.startsWith('acceptance')) && c.evidence.some((e) => e.startsWith('defense')));
  if (CONFIG32.rules[PD_SETUP].mode === 'SHADOW') assert.equal(x.status, 'SHADOW_ONLY', 'SHADOW module is logged and outcome-tracked, never sent to Flow');
});

test('bearish PDL mirror produces exactly one SELL candidate', () => {
  const bars = mirror(bull.bars);
  const { steps } = run(bars, bull.start - 30 * M, bull.end);
  const recs = pdRecs(steps);
  assert.equal(recs.length, 1); assert.equal(recs[0].x.side, 'SELL');
  const c = recs[0].x.cand!; assert.ok(c.stop > c.entry && c.target < c.entry);
  assert.ok(recs[0].r.pd.some((m) => m.level === 'PDL' && m.phase === 'ENTRY'));
});

test('liquidity sweep above PDH (wick, close back below, bearish displacement) never triggers a BUY', () => {
  const SWEEP: [number, number][] = [[0, -3], [150, -1.0], [178, -0.2], [181, 1.1], [184, -0.4], [190, -1.4], [260, -2.5]];
  const sw = scripted(BASE, SWEEP, 5);
  const { steps } = run(sw.bars, sw.start - 30 * M, sw.end);
  assert.equal(pdRecs(steps).filter((r) => r.x.side === 'BUY').length, 0);
  const pdh = steps[steps.length - 1].pd.filter((m) => m.level === 'PDH');
  assert.ok(pdh.some((m) => m.phase === 'FAILED' && /^SWEEP/.test(m.failReason ?? '')), `expected a SWEEP failure, got ${pdh.map((m) => `${m.phase}:${m.failReason}`)}`);
});

test('state persists: a fresh state (worker restart) rebuilds the identical machine at every minute', () => {
  const s = buildSeries(bull.bars); const cont = newState32(); let n = 0;
  for (let a = bull.start - 30 * M; a <= bull.end; a += M) {
    const r1 = step32(s, a, cont);
    if ((a / M) % 7 !== 0) continue;
    const r2 = step32(s, a, newState32());
    const key = (r: Step32) => r.pd.filter((m) => m.dayKey === tradingDayKey(a - M)).map((m) => [anchorOf(m), m.phase, m.version, m.retestExt, m.trigger, m.entry?.px].join('|'));
    assert.deepEqual(key(r2), key(r1), `diverged at ${new Date(a).toISOString()}`); n++;
  }
  assert.ok(n > 50);
});

test('duplicate protection: re-running the entry minute with the same seen-set yields no second candidate', () => {
  const s = buildSeries(bull.bars); const st = newState32(); let at = 0;
  for (let a = bull.start - 30 * M; a <= bull.end; a += M) { const r = step32(s, a, st); if (r.records.some((x) => x.setup === PD_SETUP && x.cand)) at = a; }
  assert.ok(at > 0);
  const again = newState32(); again.seen = st.seen;                       // restart: seen reloaded from genx3_candidates
  const r = step32(s, at, again);
  assert.equal(r.records.filter((x) => x.setup === PD_SETUP && x.cand).length, 0);
  // one entry per level per trading day: the finished PDH machine never re-arms that day
  const last = step32(s, bull.end, st).pd.filter((m) => m.level === 'PDH');
  assert.equal(last.filter((m) => m.phase === 'ENTRY').length, 1);
  assert.ok(!last.some((m) => m.cycle > 1));
});

test('Flow receives the same normalized GENX 3.2 signal format; PD log row carries the review fields', () => {
  const rules = CONFIG32.rules[PD_SETUP]; const prev = rules.mode; rules.mode = 'LIVE';
  try {
    const s = buildSeries(bull.bars); const st = newState32(); let sel: Step32 | null = null;
    for (let a = bull.start - 30 * M; a <= bull.end && !sel; a += M) { const r = step32(s, a, st); if (r.selected?.setup === PD_SETUP) sel = r; }
    if (!sel) { const any = pdRecs(run(bull.bars, bull.start - 30 * M, bull.end).steps)[0]; assert.fail(`PD candidate not selectable: ${any?.x.status} ${any?.x.reasons}`); }
    const sig = buildSignal32(sel.selected!, sel, 1000);
    assert.deepEqual(validateSignal32(sig), []);
    assert.equal(sig.strategy_version, STRATEGY_VERSION_32); assert.equal(sig.setup_type, PD_SETUP); assert.equal(sig.symbol_canonical, 'XAUUSD');
    const m = sel.pd.find((x) => anchorOf(x) === sel!.selected!.anchor)!;
    const row = pdRow(m, sel.selected!, sig.signal_id);
    for (const k of ['level_price', 'break_at', 'break_displacement_atr5', 'acceptance_evidence', 'retest_at', 'retest_depth', 'retest_zone', 'defense_evidence', 'entry_trigger', 'entry_price', 'stop', 'target', 'confidence', 'transitions']) assert.ok(row[k as keyof typeof row] != null, `log field ${k}`);
    assert.ok(row.transitions.length >= 9);
  } finally { rules.mode = prev; }
});

test('3.2.2 keeps every 3.2.1 setup and rule; the new module is additive', () => {
  for (const k of ['SESSION_BREAK', 'BOS_PULLBACK', 'MICRO_CONTINUATION', 'BREAKOUT_RETEST_V2', 'COMPRESSION_EXPANSION', 'SWEEP_RECLAIM_DISPLACEMENT', 'TREND_REENTRY', 'MOMENTUM_EXPANSION'] as const) assert.ok(CONFIG32.rules[k]);
  assert.deepEqual(CONFIG32.priority.slice(0, 3), ['SESSION_BREAK', 'BOS_PULLBACK', 'BREAKOUT_RETEST_V2']);
  assert.equal(CONFIG32.rules.MICRO_CONTINUATION.mode, 'SHADOW'); assert.equal(CONFIG32.rules.MOMENTUM_EXPANSION.mode, 'SHADOW');
  assert.equal(CONFIG32.maxRiskAtr15, 3.5); assert.equal(CONFIG32.maxRiskUsd, 60); assert.equal(CONFIG32.minNetRR, 1.2);
  void lastClosed;
});
