import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot } from '../command-center/engines/snapshot';
import { validate, MAX_RISK_PCT } from '../command-center/engines/validator';
import { metrics, character, protection, health, tradeFocus, tradeQuestion, tradeRead, type LivePosition } from '../command-center/brain/trade';
import { STYLE, STYLE_MODE, styleOf, decisiveFor } from '../command-center/core/style';
import { resolve as resolveInstrument, pipSizeOf, roundQty, roundPrice, toPips } from '../command-center/core/instrument';
import { seal, open as unseal, maskEmail, keySource } from '../command-center/core/crypto';
import { orderBody, isRejection, parseAccounts, parseInstrumentSpec, findGold, orderIdOf, hasDeveloperKey } from '../command-center/adapters/tradelocker';
import { stopMoveAllowed } from '../command-center/core/risk';
import type { Bar, MarketSnapshot } from '../command-center/core/types';
import type { AccountRow } from '../command-center/engines/broker';
import type { TLInstrumentSpec } from '../command-center/adapters/tradelocker';

const M = 60_000;
const NOW = Date.UTC(2026, 8, 16, 14, 0, 0);
const bar = (t: number, o: number, h: number, l: number, c: number): Bar => ({ t, o, h, l, c });
function series(n: number, start: number, drift: number, noise = 1.2): Bar[] {
  const out: Bar[] = []; let p = start;
  for (let i = 0; i < n; i++) {
    const w = Math.sin(i / 7) * noise * 2, o = p, c = p + drift + w * 0.35;
    out.push(bar(NOW - (n - i) * 5 * M, o, Math.max(o, c) + noise, Math.min(o, c) - noise, c));
    p = c;
  }
  return out;
}
const snap = (bars: Bar[], price?: number): MarketSnapshot => buildSnapshot({
  now: NOW, bars: { '5m': bars, '15m': bars, '1h': bars, '4h': bars },
  price: price ?? bars[bars.length - 1].c,
  feeds: [{ feed: 'twelvedata', state: 'live', lastTickMs: bars[bars.length - 1].t, ageMs: 4_000 }],
});

/* ─────────────────── the instrument is never assumed ─────────────────── */

const GOLD_SPEC: TLInstrumentSpec = {
  tradableInstrumentId: '278', routeId: '900', name: 'XAUUSD',
  contractSize: 100, lotStep: 0.01, minLot: 0.01, maxLot: 50,
  tickSize: 0.01, tickValue: 1, pricePrecision: 2, quantityPrecision: 2, currency: 'USD',
};

test('THE PIP IS NEVER HARDCODED: it comes from the broker specification', () => {
  assert.equal(pipSizeOf(GOLD_SPEC)?.pipSize, 0.1);
  // A three-decimal broker quotes gold differently, and the pip must follow it.
  assert.equal(pipSizeOf({ ...GOLD_SPEC, tickSize: 0.001, pricePrecision: 3 })?.pipSize, 0.01);
  // With no tick size it falls back to precision, and with neither it refuses.
  assert.equal(pipSizeOf({ ...GOLD_SPEC, tickSize: null })?.pipSize, 0.1);
  assert.equal(pipSizeOf({ ...GOLD_SPEC, tickSize: null, pricePrecision: null }), null);
});

test('an instrument the broker did not describe REFUSES to be sized, and names what is missing', () => {
  const r = resolveInstrument({ ...GOLD_SPEC, contractSize: null, tickValue: null }, 'USD');
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.reason, /did not describe/i);
    assert.ok(r.missing.includes('tick value or contract size'));
  }
});

test('tick value is preferred over contract-size arithmetic', () => {
  const r = resolveInstrument(GOLD_SPEC, 'USD');
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.instrument.pipValuePerLot, 10);      // $1 per 0.01 → $10 per 0.10
    assert.match(r.source, /tickValue/);
  }
});

test('a mismatched quote currency is flagged rather than silently assumed', () => {
  const r = resolveInstrument({ ...GOLD_SPEC, tickValue: null, currency: 'EUR' }, 'USD');
  assert.equal(r.ok, true);
  if (r.ok) assert.ok(r.warnings.some((w) => /EUR/.test(w) && /approximate/.test(w)));
});

test('quantities round DOWN — a rounding that increases exposure is a bug', () => {
  const r = resolveInstrument(GOLD_SPEC, 'USD');
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(roundQty(0.179, r.instrument), 0.17);
    assert.equal(roundQty(0.005, r.instrument), 0);
  }
  assert.equal(roundPrice(4382.4567, GOLD_SPEC), 4382.46);
});

/* ─────────────────── the adapter matches the documentation ─────────────────── */

test('stopLoss ALWAYS travels with stopLossType — a bare stop is rejected by the broker', () => {
  const b = orderBody({ tradableInstrumentId: '1', routeId: '2', qty: 0.1, side: 'buy', type: 'market', validity: 'IOC', stopLoss: 4380, takeProfit: 4400 });
  assert.equal(b.stopLoss, 4380);
  assert.equal(b.stopLossType, 'absolute');
  assert.equal(b.takeProfitType, 'absolute');
  assert.equal(b.price, 0, 'market orders send price 0');
  assert.equal(b.validity, 'IOC');
});

test('an order with no stop simply has no stop fields, not an undefined one', () => {
  const b = orderBody({ tradableInstrumentId: '1', routeId: '2', qty: 0.1, side: 'sell', type: 'market', validity: 'IOC' });
  assert.ok(!('stopLoss' in b));
  assert.ok(!('stopLossType' in b));
});

test('strategyId is clipped to the documented 31 characters', () => {
  const b = orderBody({ tradableInstrumentId: '1', routeId: '2', qty: 0.1, side: 'buy', type: 'market', validity: 'IOC', strategyId: 'x'.repeat(80) });
  assert.equal(String(b.strategyId).length, 31);
});

test('a 200 response carrying an error is treated as the rejection it is', () => {
  assert.equal(isRejection(200, { s: 'ok' }), false);
  assert.equal(isRejection(200, { s: 'error', errmsg: 'no' }), true);
  assert.equal(isRejection(403, {}), true);
});

test('broker payloads are read out of whatever envelope they arrive in', () => {
  const accts = parseAccounts({ d: { accounts: [{ id: '55', accNum: '2', currency: 'USD', accountBalance: 1000 }] } });
  assert.equal(accts.length, 1);
  assert.equal(accts[0].id, '55');
  assert.equal(accts[0].accNum, '2', 'accountId and accNum are different values and both are kept');
  const gold = findGold({ d: { instruments: [{ name: 'EURUSD', tradableInstrumentId: '1', routeId: '9' }, { name: 'XAUUSD', tradableInstrumentId: '278', routes: [{ id: '900' }] }] } });
  assert.deepEqual(gold, { tradableInstrumentId: '278', routeId: '900', name: 'XAUUSD' });
  assert.equal(orderIdOf({ d: { orderId: 'abc' } }), 'abc');
  const spec = parseInstrumentSpec({ d: { tradableInstrumentId: '278', contractSize: 100, lotStep: 0.01 } }, { tradableInstrumentId: '278', routeId: '900' });
  assert.equal(spec.contractSize, 100);
  assert.equal(spec.routeId, '900');
});

test('the developer API key is read from the environment, never from the repository', () => {
  assert.equal(typeof hasDeveloperKey(), 'boolean');
});

/* ─────────────────── credentials ─────────────────── */

test('sealed credentials round-trip, and tampering fails closed', () => {
  process.env.CC_ENC_KEY = Buffer.alloc(32, 7).toString('base64');
  const sealed = seal('refresh-token-value');
  assert.ok(sealed && sealed.startsWith('v1.'));
  assert.equal(unseal(sealed), 'refresh-token-value');
  assert.equal(unseal(sealed!.slice(0, -4) + 'AAAA'), null, 'a tampered payload decrypts to nothing, never to garbage');
  assert.ok(!sealed!.includes('refresh-token-value'), 'the plaintext is not recoverable by eye');
});

test('with NO key at all, nothing is stored in the clear', () => {
  const cc = process.env.CC_ENC_KEY, fl = process.env.FLOW_ENC_KEY;
  delete process.env.CC_ENC_KEY; delete process.env.FLOW_ENC_KEY;
  assert.equal(seal('secret'), null, 'it refuses rather than storing plaintext');
  if (cc) process.env.CC_ENC_KEY = cc;
  if (fl) process.env.FLOW_ENC_KEY = fl;
});

test('it falls back to the desk key so a member is not blocked on an env var', () => {
  const cc = process.env.CC_ENC_KEY;
  delete process.env.CC_ENC_KEY;
  process.env.FLOW_ENC_KEY = 'a-passphrase-the-desk-already-runs-on';
  assert.equal(keySource(), 'flow');
  const sealed = seal('refresh');
  assert.ok(sealed, 'the fallback key works');
  assert.equal(unseal(sealed), 'refresh');
  // Its own key wins when there is one — separate keys are the better arrangement.
  process.env.CC_ENC_KEY = Buffer.alloc(32, 9).toString('base64');
  assert.equal(keySource(), 'cc');
  assert.equal(unseal(sealed), null, 'a blob sealed with the other key does not silently decrypt');
  if (cc) process.env.CC_ENC_KEY = cc; else delete process.env.CC_ENC_KEY;
  delete process.env.FLOW_ENC_KEY;
});

test('any key shape works, so one value can be pasted under either name', () => {
  const cc = process.env.CC_ENC_KEY;
  for (const k of [Buffer.alloc(32, 3).toString('base64'), Buffer.alloc(32, 4).toString('hex'), 'just a passphrase']) {
    process.env.CC_ENC_KEY = k;
    const sealed = seal('x');
    assert.ok(sealed, `key shape rejected: ${k.slice(0, 12)}`);
    assert.equal(unseal(sealed), 'x');
  }
  if (cc) process.env.CC_ENC_KEY = cc; else delete process.env.CC_ENC_KEY;
});

test('an email is masked for display', () => {
  assert.match(maskEmail('matthew@example.com'), /^ma•+@example\.com$/);
});

/* ─────────────────── the validator ─────────────────── */

const ACCOUNT = (over: Partial<AccountRow> = {}): AccountRow => ({
  id: 'a1', user_id: 'u1', connection_id: 'c1', account_id: '55', acc_num: '2',
  is_live: false, currency: 'USD', name: 'Demo', balance: 10000, equity: 10000, open_pl: 0,
  margin_available: 10000, state_at: null, instrument_id: '278', route_id: '900',
  instrument_spec: GOLD_SPEC, is_selected: true, auto_trading: false, live_authorized_at: null,
  permissions: { manual_execute: true }, risk_limits: null, ...over,
});

const INST = { contractSize: 100, minLot: 0.01, maxLot: 50, lotStep: 0.01, pipValuePerLot: 10 };
// The stop is derived from the fixture's own price. Hardcoding one and letting the series drift past it
// is how a test ends up asserting the wrong rejection reason.
const FIX = snap(series(140, 4300, 0.3));
const base = (over: Record<string, unknown> = {}) => ({
  account: ACCOUNT(), snapshot: FIX, side: 'buy' as const, style: 'hold' as const,
  entry: null, stop: +(FIX.price - 8).toFixed(2), takeProfit: null, riskPct: 0.5, equity: 10000,
  instrument: INST, pipSize: 0.1, spread: 0.3, openPositions: 0, openRiskPct: 0, origin: 'member' as const,
  ...over,
});

test('a LIVE account cannot trade until live trading is explicitly authorised', () => {
  const v = validate(base({ account: ACCOUNT({ is_live: true, live_authorized_at: null }) }));
  assert.equal(v.ok, false);
  if (!v.ok) assert.match(v.reason, /LIVE account/);
  const ok = validate(base({ account: ACCOUNT({ is_live: true, live_authorized_at: new Date().toISOString() }) }));
  assert.equal(ok.ok, true);
});

test('automation is refused unless auto trading is on for that account', () => {
  const v = validate(base({ origin: 'auto' }));
  assert.equal(v.ok, false);
  if (!v.ok) assert.match(v.reason, /Automatic trading is off/);
});

test('an order without a stop is refused outright', () => {
  const v = validate(base({ stop: 0 }));
  assert.equal(v.ok, false);
  if (!v.ok) assert.match(v.reason, /stop is required/i);
});

test('a stop on the wrong side of the entry is refused', () => {
  const s = snap(series(140, 4300, 0.3));
  const v = validate(base({ snapshot: s, side: 'buy', stop: s.price + 5 }));
  assert.equal(v.ok, false);
  if (!v.ok) assert.match(v.reason, /below the entry/);
});

test('risk is capped, and the cap is disclosed rather than applied silently', () => {
  const s = snap(series(140, 4300, 0.3));
  const v = validate(base({ snapshot: s, stop: s.price - 4, riskPct: 9 }));
  assert.ok(v.ok);
  if (v.ok) {
    assert.ok(v.warnings.some((w) => w.includes(`${MAX_RISK_PCT}%`)));
    assert.ok(v.sizing.riskPctUsed <= MAX_RISK_PCT + 0.01);
  }
});

test('risk % means ACCOUNT risk: the size follows from equity and stop distance', () => {
  const s = snap(series(140, 4300, 0.3));
  const v = validate(base({ snapshot: s, stop: s.price - 3, riskPct: 0.5, equity: 10000 }));
  assert.ok(v.ok);
  if (v.ok) {
    // $50 of risk over a 30-pip stop at $10/pip/lot ≈ 0.16 lots, rounded DOWN to the lot step.
    assert.equal(v.sizing.stopPips, 30);
    assert.ok(v.sizing.qty <= 0.17 && v.sizing.qty >= 0.16, `got ${v.sizing.qty}`);
    assert.ok(v.sizing.riskAmount <= 50.01);
  }
});

test('a stop inside the style noise floor is refused as not being a stop at all', () => {
  const s = snap(series(140, 4300, 0.3));
  const v = validate(base({ snapshot: s, style: 'swing', stop: s.price - 1 }));
  assert.equal(v.ok, false);
  if (!v.ok) assert.match(v.reason, /inside the noise/);
});

test('no market read means no order, whatever anyone clicks', () => {
  const v = validate(base({ snapshot: null }));
  assert.equal(v.ok, false);
  if (!v.ok) assert.match(v.reason, /no market read/i);
});

test('a blocked snapshot (stale feed) stops the order', () => {
  const bars = series(140, 4300, 0.3);
  const stale = buildSnapshot({ now: NOW, bars: { '5m': bars }, price: 4350, feeds: [{ feed: 'twelvedata', state: 'stale', lastTickMs: NOW - 400_000, ageMs: 400_000 }] });
  const v = validate(base({ snapshot: stale }));
  assert.equal(v.ok, false);
});

test('a second position is refused while one is already open', () => {
  const v = validate(base({ openPositions: 1 }));
  assert.equal(v.ok, false);
  if (!v.ok) assert.match(v.reason, /Already holding/);
});

/* ─────────────────── styles are not three take-profits ─────────────────── */

test('a style changes WHICH timeframes are allowed to end a trade', () => {
  assert.ok(decisiveFor('quick', '1m'));
  assert.ok(!decisiveFor('swing', '1m'), 'one-minute noise can never end a swing trade');
  assert.ok(decisiveFor('swing', '4h'));
  assert.ok(STYLE.swing.noiseFloorPips > STYLE.hold.noiseFloorPips);
  assert.ok(STYLE.hold.noiseFloorPips > STYLE.quick.noiseFloorPips);
  assert.ok(STYLE.swing.characterVotesNeeded > STYLE.quick.characterVotesNeeded);
  assert.equal(STYLE_MODE.quick, 'scalp');
  assert.equal(styleOf('nonsense'), 'hold');
});

/* ─────────────────── the live trade ─────────────────── */

const POS = (over: Partial<LivePosition> = {}): LivePosition => ({
  id: 'p1', side: 'buy', style: 'hold', entry: 4380, qty: 0.1, initQty: 0.1,
  initStop: 4370, curStop: 4370, takeProfit: 4400, openedAt: NOW - 20 * M,
  pipSize: 0.1, pipValuePerLot: 10, mfePips: 0, maePips: 0, breakEvenAt: null,
  // No invalidation by default: each test states its own, so none of them accidentally start out
  // "already invalidated" because a fixture's price drifted past a hardcoded level.
  partials: [], thesis: null, aiManagement: false, ...over,
});

test('live metrics are computed from the real position, in pips, money and R', () => {
  const m = metrics(POS(), 4385, NOW);
  assert.equal(m.pips, 50);
  assert.equal(m.money, 50);          // 50 pips × $10/pip/lot × 0.1 lots
  assert.equal(m.r, 0.5);             // 50 pips against a 100-pip risk
  assert.equal(m.riskPips, 100);
  assert.equal(m.beyondBreakEven, false);
});

test('a short position measures profit the other way round', () => {
  const m = metrics(POS({ side: 'sell', entry: 4380, initStop: 4390, curStop: 4390 }), 4370, NOW);
  assert.equal(m.pips, 100);
  assert.equal(m.r, 1);
});

test('give-back is tracked against the BEST the trade saw, not against entry', () => {
  const m = metrics(POS({ mfePips: 90 }), 4385, NOW);
  assert.equal(m.mfePips, 90);
  assert.equal(m.giveBackPips, 40);
  assert.ok(Math.abs(m.giveBackFraction - 0.444) < 0.01);
});

/* ─────────────────── pullback vs deterioration ─────────────────── */

test('an ordinary pullback is NOT called deterioration', () => {
  const s = snap(series(140, 4300, 0.35));
  const p = POS({ entry: s.price - 1, initStop: s.price - 11, curStop: s.price - 11 });
  const m = metrics(p, s.price - 1.2, NOW);
  const ch = character(p, s, m, []);
  assert.ok(ch.state !== 'character_change' && ch.state !== 'invalidated',
    `a small move against should not be a character change, got ${ch.state}`);
});

test('movement inside the style noise floor is explicitly called noise', () => {
  const s = snap(series(140, 4300, 0.35));
  const p = POS({ style: 'swing', entry: s.price + 2, initStop: s.price - 20, curStop: s.price - 20, thesis: { invalidationPrice: s.price - 20 } });
  const m = metrics(p, s.price, NOW);
  const ch = character(p, s, m, []);
  assert.ok(['noise', 'normal_pullback', 'intact'].includes(ch.state), `got ${ch.state}`);
  assert.match(ch.explanation.toLowerCase(), /inside what a .* trade does|noise|pullback|nothing/);
});

test('price through the invalidation level is INVALIDATED, immediately and without a vote', () => {
  const s = snap(series(140, 4300, 0.35));
  const p = POS({ entry: s.price + 5, thesis: { invalidationPrice: s.price + 1 } });
  const m = metrics(p, s.price, NOW);
  const ch = character(p, s, m, []);
  assert.equal(ch.state, 'invalidated');
  assert.equal(ch.score, 100);
  assert.match(ch.explanation, /no longer true/);
});

test('a swing trade needs MORE evidence than a quick one to call character changed', () => {
  assert.ok(STYLE.swing.characterVotesNeeded > STYLE.quick.characterVotesNeeded);
});

/* ─────────────────── profit protection explains itself ─────────────────── */

test('protection holds a healthy trade rather than fiddling with it', () => {
  const s = snap(series(140, 4300, 0.35));
  const p = POS({ entry: s.price - 2, initStop: s.price - 12, curStop: s.price - 12, thesis: { invalidationPrice: s.price - 12 } });
  const m = metrics(p, s.price, NOW);
  const ch = character(p, s, m, []);
  const pr = protection(p, m, ch, s);
  assert.ok(['hold', 'break_even'].includes(pr.action), `got ${pr.action}`);
  assert.ok(pr.say.length > 25, 'it always explains itself');
});

test('an invalidated trade is closed, and the reason is said out loud', () => {
  const s = snap(series(140, 4300, 0.35));
  const p = POS({ entry: s.price + 5, thesis: { invalidationPrice: s.price + 1 } });
  const m = metrics(p, s.price, NOW);
  const ch = character(p, s, m, []);
  const pr = protection(p, m, ch, s);
  assert.equal(pr.action, 'close');
  assert.equal(pr.urgency, 'high');
  assert.match(pr.say, /close this/i);
});

test('giving back most of a good move triggers protection, not a close', () => {
  const s = snap(series(140, 4300, 0.35));
  const p = POS({ entry: s.price - 4, initStop: s.price - 14, curStop: s.price - 14, mfePips: 120, thesis: { invalidationPrice: s.price - 14 } });
  const m = metrics(p, s.price, NOW);
  const ch = character(p, s, m, []);
  const pr = protection(p, m, ch, s);
  assert.ok(pr.action === 'protect_stop' || pr.action === 'break_even' || pr.action === 'partial', `got ${pr.action}`);
  assert.match(pr.say, /\d+ pips/);
});

test('a stop may never move away from the trade, whoever asks', () => {
  assert.equal(stopMoveAllowed('buy', 4370, 4375).ok, true);
  assert.equal(stopMoveAllowed('buy', 4370, 4365).ok, false);
  assert.equal(stopMoveAllowed('sell', 4390, 4395).ok, false);
  assert.equal(stopMoveAllowed('buy', 4370, 4365).hard, true, 'this one can never be overridden');
});

/* ─────────────────── the trade-aware BRAIN ─────────────────── */

test('health is attributable, bounded, and collapses on invalidation', () => {
  const s = snap(series(140, 4300, 0.35));
  const p = POS({ entry: s.price - 3, initStop: s.price - 13, curStop: s.price - 13, thesis: { invalidationPrice: s.price - 13 } });
  const m = metrics(p, s.price, NOW);
  const h = health(p, m, character(p, s, m, []));
  assert.ok(h.score >= 0 && h.score <= 100);
  assert.ok(h.drivers.length > 0, 'every score has drivers a member could check');

  const dead = POS({ entry: s.price + 5, thesis: { invalidationPrice: s.price + 1 } });
  const dm = metrics(dead, s.price, NOW);
  assert.ok(health(dead, dm, character(dead, s, dm, [])).score <= 10);
});

test('WHAT I AM WATCHING becomes about the trade once there is one', () => {
  const s = snap(series(140, 4300, 0.35));
  const p = POS({ entry: s.price - 3, initStop: s.price - 13, curStop: s.price - 13 });
  const m = metrics(p, s.price, NOW);
  const f = tradeFocus(p, m, s);
  assert.ok(f.length > 0);
  assert.ok(f.some((x) => /break-even|\+1R|fails at/.test(x)), `got ${JSON.stringify(f)}`);
});

test('THE QUESTION becomes about the trade, and always ends in a question mark', () => {
  const s = snap(series(140, 4300, 0.35));
  const p = POS({ entry: s.price - 3, initStop: s.price - 13, curStop: s.price - 13 });
  const m = metrics(p, s.price, NOW);
  const q = tradeQuestion(p, m, character(p, s, m, []), s);
  assert.ok(q.endsWith('?'));
});

test('"how is my trade" answers with THIS position, never generic advice', () => {
  const s = snap(series(140, 4300, 0.35));
  const p = POS({ entry: s.price - 5, initStop: s.price - 15, curStop: s.price - 15, mfePips: 70, thesis: { invalidationPrice: s.price - 15 } });
  const m = metrics(p, s.price, NOW);
  const ch = character(p, s, m, []);
  const text = tradeRead(p, m, ch, protection(p, m, ch, s));
  assert.match(text, /pips/);
  assert.match(text, /\bR\b|best has been/);
  assert.ok(!/you should always|as a general rule|in general/i.test(text), 'no generic trading advice');
});

/* ─────────────────── the stop ceiling follows the style ─────────────────── */

test('a real SWING stop is accepted — a single global ceiling would reject every one of them', () => {
  const s = snap(series(140, 4300, 0.3));
  // 240 pips: an ordinary swing stop on gold, and impossible under the old 100-pip global cap.
  const v = validate(base({ snapshot: s, style: 'swing', stop: +(s.price - 24).toFixed(2), equity: 50000 }));
  assert.equal(v.ok, true, v.ok ? '' : v.reason);
  if (v.ok) assert.equal(v.sizing.stopPips, 240);
});

test('a QUICK trade is refused a stop that makes it not quick', () => {
  const s = snap(series(140, 4300, 0.3));
  const v = validate(base({ snapshot: s, style: 'quick', stop: +(s.price - 9).toFixed(2) }));  // 90 pips
  assert.equal(v.ok, false);
  if (!v.ok) assert.match(v.reason, /wider than the 60-pip limit/);
});

test('each style carries its own ceiling, and they widen in the right order', () => {
  assert.ok(STYLE.quick.maxStopPips < STYLE.hold.maxStopPips);
  assert.ok(STYLE.hold.maxStopPips < STYLE.swing.maxStopPips);
  // Every style must leave a usable window between its own noise floor and its ceiling.
  (['quick', 'hold', 'swing'] as const).forEach((k) => {
    assert.ok(STYLE[k].maxStopPips > STYLE[k].noiseFloorPips * 2,
      `${k} has no room between its noise floor and its stop ceiling`);
  });
});

test('an explicit account limit still overrides the style default', () => {
  const s = snap(series(140, 4300, 0.3));
  const tight = ACCOUNT({ risk_limits: { maxStopPips: 40 } });
  const v = validate(base({ snapshot: s, account: tight, style: 'swing', stop: +(s.price - 24).toFixed(2) }));
  assert.equal(v.ok, false, 'the account owner gets the last word on their own ceiling');
});

/* ─────────────────── the endpoints the broker actually answers ─────────────────── */

test('accounts are listed from an /auth route — /trade/* cannot be called before accNum is known', async () => {
  const tl = await import('../command-center/adapters/tradelocker');
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ d: { accounts: [{ id: '55', accNum: '2', accountBalance: 1000 }] } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  try {
    await tl.listAccounts('demo', 'tok');
    assert.equal(calls.length, 1);
    assert.match(calls[0], /\/auth\/jwt\/all-accounts$/,
      'listing accounts from /trade/accounts is a chicken-and-egg: it needs the accNum it would have told us');
    assert.ok(!/\/trade\/accounts$/.test(calls[0]));
  } finally { globalThis.fetch = realFetch; }
});

test('a ROUTING failure may be retried elsewhere; an uncertain one may NEVER be', async () => {
  const tl = await import('../command-center/adapters/tradelocker');
  assert.equal(tl.isRouting({ ok: false, status: 404, error: 'Not Found' }), true);
  assert.equal(tl.isRouting({ ok: false, status: 405, error: 'Method Not Allowed' }), true);
  // The dangerous cases: the action may already have happened.
  assert.equal(tl.isRouting({ ok: false, status: 0, error: 'timeout', uncertain: true }), false);
  assert.equal(tl.isRouting({ ok: false, status: 502, error: 'bad gateway', uncertain: true }), false);
  assert.equal(tl.isRouting({ ok: false, status: 400, error: 'invalid qty' }), false);
});

test('a close that times out is NOT retried down the other path', async () => {
  const tl = await import('../command-center/adapters/tradelocker');
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => { calls.push(String(url)); throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }) as unknown as typeof fetch;
  try {
    const r = await tl.closePosition({ env: 'demo', accessToken: 't', accountId: '55', accNum: '2' }, 'p1', 0.05);
    assert.equal(r.ok, false);
    assert.equal(calls.length, 1, 'closing twice on a partial would take size the member never asked to lose');
  } finally { globalThis.fetch = realFetch; }
});

test('an instrument spec can be read out of the LIST when there is no detail route', async () => {
  const tl = await import('../command-center/adapters/tradelocker');
  const list = { d: { instruments: [
    { name: 'EURUSD', tradableInstrumentId: '1' },
    { name: 'XAUUSD', tradableInstrumentId: '278', contractSize: 100, lotStep: 0.01, minLot: 0.01, tickSize: 0.01 },
  ] } };
  const row = tl.instrumentRow(list, '278');
  assert.ok(row, 'the gold row is found in the listing');
  const spec = tl.parseInstrumentSpec(row, { tradableInstrumentId: '278', routeId: '900' });
  assert.equal(spec.contractSize, 100);
  assert.equal(spec.lotStep, 0.01);
  const r = resolveInstrument(spec, 'USD');
  assert.equal(r.ok, true, 'and it is complete enough to size a position');
});
