import test from 'node:test';
import assert from 'node:assert/strict';
import {
  periodOf, periodWindow, accountsFrom, pickAccount, maskAccount, accountName, foldFlow, estimateAmount, genxPeriod, flowSource, HISTORY_MAX,
  figuresState, ageText, money, pipsText, toneOf, atlasReadFor, setupView, stageSentence, STAGE_LABEL,
  FIGURES_FRESH_MS, ATLAS_READ_FRESH_MS, type FloorAccount, type FlowPosIn, type GenxFireIn,
} from '../src/lib/floor/overview';
import { buildRealResults, type RealRow } from '../src/lib/genx/realResults';

/*
 * THE FLOOR's numbers (owner 11-20). The rules these pin down are the ones a member could be misled by:
 * what a period covers, whose account a number belongs to, counting a trade once, never showing a number
 * that was not read, and never calling an old reading current.
 */
const NOW = Date.parse('2026-11-20T15:00:00Z');
const SINCE = '2026-10-20T17:15:00Z';
const H = 3600_000, D = 24 * H;

/* ── periods ── */
test('a period nobody recognises falls back to the default, never to "all"', () => {
  assert.equal(periodOf('7D'), '7d');
  assert.equal(periodOf('today'), 'today');
  assert.equal(periodOf('year'), '7d');
  assert.equal(periodOf(undefined, 'today'), 'today');
});

test('Today starts at the member\'s own midnight, not the server\'s', () => {
  // 15:00 UTC is 09:00 in Chicago (offset 360 minutes west): their day began at 06:00 UTC.
  const chi = periodWindow('today', NOW, SINCE, 360);
  assert.equal(new Date(chi.from).toISOString(), '2026-11-20T06:00:00.000Z');
  assert.equal(chi.to, NOW);
  // In Tokyo (540 minutes east) the same instant is exactly midnight: their day starts now.
  const tok = periodWindow('today', NOW, SINCE, -540);
  assert.equal(new Date(tok.from).toISOString(), '2026-11-20T15:00:00.000Z');
  // A nonsense offset is clamped to a real one rather than moving the day by weeks.
  const wild = periodWindow('today', NOW, SINCE, 99999);
  assert.ok(NOW - wild.from <= D && NOW - wild.from >= 0);
});

test('7 and 30 days are rolling, All is from the record\'s restart, and nothing reaches back before it', () => {
  assert.equal(periodWindow('7d', NOW, SINCE).from, NOW - 7 * D);
  assert.equal(periodWindow('30d', NOW, SINCE).from, NOW - 30 * D);
  assert.equal(periodWindow('all', NOW, SINCE).from, Date.parse(SINCE));
  // A record restarted three days ago: "30 days" cannot bring back what it no longer counts.
  const recent = new Date(NOW - 3 * D).toISOString();
  assert.equal(periodWindow('30d', NOW, recent).from, NOW - 3 * D);
  assert.equal(periodWindow('7d', NOW, recent).from, NOW - 3 * D);
});

/* ── accounts ── */
const CONNS = [{ id: 'c1', broker: 'tradelocker', environment: 'live', status: 'connected' }, { id: 'c2', broker: 'tradelocker', environment: 'demo', status: 'error' }];

test('an account number is never shown whole', () => {
  assert.equal(maskAccount('1234567'), '•••• 4567');
  assert.equal(maskAccount('998877', '3'), '•••• 8877');
  assert.equal(maskAccount('42'), '•••• 42');
  assert.equal(maskAccount(null, null), '••••');
});

// Seen on the live preview, 11-20: the owner's account read "•••• 3" — its position on the login — and was
// titled with the broker's machine identifier.
test('the number shown is the account\'s own, not its position on the login', () => {
  assert.equal(maskAccount('1234669', '3'), '•••• 4669');
  assert.equal(maskAccount('', '3'), '•••• 3', 'the position is used only when there is no number at all');
  const [a] = accountsFrom([{ id: 'c1', broker: 'tradelocker', environment: 'live', status: 'connected' }],
    [{ account_id: '1234669', acc_num: '3', name: 'GENFX#95e9f433-abed-4001-bf51-1d1d37241a87#3#3', currency: 'USD', environment: 'live', is_selected: true, connection_id: 'c1' }]);
  assert.equal(a.masked, '•••• 4669');
  assert.equal(a.name, 'GENFX account');
});

test('a person is never shown a machine identifier as an account\'s name', () => {
  assert.equal(accountName('Main', 'live', '•••• 4669'), 'Main', 'a name that reads like a name is the broker\'s own');
  assert.equal(accountName('My Gold Account 2', 'demo', '•••• 4669'), 'My Gold Account 2');
  assert.equal(accountName('GENFX#95e9f433-abed-4001-bf51-1d1d37241a87#3#3', 'live', '•••• 4669'), 'GENFX account');
  assert.equal(accountName('95e9f433-abed-4001-bf51-1d1d37241a87', 'live', '•••• 4669'), 'Live account 4669');
  assert.equal(accountName('abc-95e9f433-abed-4001-bf51-1d1d37241a87', 'demo', '•••• 12'), 'Demo account 12', 'a lead that is only more of the identifier is not a name');
  assert.equal(accountName('', 'demo', '•••• 4669'), 'Demo account 4669');
  assert.equal(accountName(null, 'live', '••••'), 'Live account');
  assert.equal(accountName('x'.repeat(60), 'live', '•••• 9'), 'Live account 9', 'nor a label too long to be one');
});

test('one account on two logins is one account; Live and Demo with the same number are two', () => {
  const list = accountsFrom(
    [...CONNS, { id: 'c3', broker: 'tradelocker', environment: 'live', status: 'error' }],
    [
      { account_id: '777', acc_num: '1', name: 'Main', currency: 'usd', environment: 'live', is_selected: false, connection_id: 'c3' },
      { account_id: '777', acc_num: '1', name: 'Main', currency: 'usd', environment: 'live', is_selected: true, connection_id: 'c1' },
      { account_id: '777', acc_num: '1', name: 'Practice', currency: 'USD', environment: 'demo', is_selected: false, connection_id: 'c2' },
      { account_id: '', acc_num: '9', name: 'no id', connection_id: 'c1' },
    ],
  );
  assert.equal(list.length, 2);
  const live = list.find((a) => a.environment === 'live')!, demo = list.find((a) => a.environment === 'demo')!;
  assert.equal(live.connection, 'connected', 'connected if either login is');
  assert.equal(live.isDefault, true);
  assert.equal(live.currency, 'USD');
  assert.equal(live.broker, 'TradeLocker');
  assert.equal(demo.connection, 'attention');
  assert.equal(demo.name, 'Practice');
});

test('the account shown is one of the member\'s own — an id that is not theirs shows their default', () => {
  const mine: FloorAccount[] = [
    { id: 'a', name: 'A', masked: '•••• 1', broker: 'TradeLocker', environment: 'demo', currency: 'USD', connection: 'connected', isDefault: false },
    { id: 'b', name: 'B', masked: '•••• 2', broker: 'TradeLocker', environment: 'live', currency: 'USD', connection: 'connected', isDefault: true },
  ];
  assert.equal(pickAccount(mine, 'a', 'demo')!.id, 'a');
  assert.equal(pickAccount(mine, 'someone-elses-account', 'live')!.id, 'b');
  assert.equal(pickAccount(mine, 'a', 'live')!.id, 'b', 'the right id in the wrong environment is not that account');
  assert.equal(pickAccount(mine, null)!.id, 'b');
  assert.equal(pickAccount([], 'a'), null);
  // A default that needs reconnecting is still the default — the screen says it needs attention.
  const broken = mine.map((x) => (x.id === 'b' ? { ...x, connection: 'attention' as const } : { ...x, isDefault: false }));
  assert.equal(pickAccount(broken, null)!.id, 'b');
});

/* ── My FLOW ── */
const ACC = { id: 'acc1', environment: 'live' as const, currency: 'USD' };
const WIN = { from: NOW - D, to: NOW };
const pos = (o: Partial<FlowPosIn>): FlowPosIn => ({
  position_id: 'p' + Math.random(), account_id: 'acc1', environment: 'live', symbol: 'XAUUSD', side: 'buy', qty: 0.1,
  exit_price: 4000, result_pips: 50, status: 'closed', outcome: 'target', created_at: new Date(NOW - 5 * H).toISOString(), resolved_at: new Date(NOW - 4 * H).toISOString(), ...o,
});

test('a position is counted once, however many rows carry it', () => {
  const r = foldFlow([pos({ position_id: 'same' }), pos({ position_id: 'same' }), pos({ position_id: 'other', result_pips: -20 })], ACC, WIN);
  assert.equal(r.closed, 2);
  assert.equal(r.wins, 1);
  assert.equal(r.losses, 1);
  assert.equal(r.netPips, 30);
});

test('only this account, in this environment, inside this window', () => {
  const r = foldFlow([
    pos({ position_id: '1' }),
    pos({ position_id: '2', account_id: 'someone-else' }),
    pos({ position_id: '3', environment: 'demo' }),                                       // same number, the demo twin
    pos({ position_id: '4', resolved_at: new Date(NOW - 2 * D).toISOString() }),         // closed before the window
    pos({ position_id: '5', resolved_at: new Date(NOW).toISOString() }),                 // the window is half-open
  ], ACC, WIN);
  assert.equal(r.closed, 1);
  assert.equal(r.netPips, 50);
});

test('an open trade is open whatever the window; a trade with no recorded result is counted but never graded', () => {
  const r = foldFlow([
    pos({ position_id: 'o1', status: 'open', result_pips: null, resolved_at: null, created_at: new Date(NOW - 9 * D).toISOString() }),
    pos({ position_id: 'x1', outcome: 'excluded', result_pips: null }),
    pos({ position_id: 'w1', result_pips: 0 }),
  ], ACC, WIN);
  assert.equal(r.open, 1);
  assert.equal(r.closed, 2);
  assert.equal(r.ungraded, 1);
  assert.equal(r.breakeven, 1);
  assert.equal(r.wins + r.losses, 0);
  assert.equal(r.netPips, 0);
});

test('the money figure is the recorded result times the size — and only where that is honest', () => {
  // Gold: 50 pips × $0.10 × 0.1 lot × 100 oz = $50.
  assert.equal(estimateAmount({ symbol: 'XAUUSD', qty: 0.1, result_pips: 50, exit_price: 4000 }, 'USD'), 50);
  assert.equal(estimateAmount({ symbol: 'XAUUSD', qty: 0.1, result_pips: -36.5, exit_price: 4000 }, 'USD'), -36.5);
  // EUR/USD: 20 pips × 0.0001 × 0.5 lot × 100,000 = $100.
  assert.equal(estimateAmount({ symbol: 'EURUSD', qty: 0.5, result_pips: 20, exit_price: 1.1 }, 'USD'), 100);
  // A cross needs a conversion rate this record does not hold: left out, not guessed.
  assert.equal(estimateAmount({ symbol: 'GBPJPY', qty: 0.5, result_pips: 20, exit_price: 200 }, 'USD'), null);
  // An account in another currency, a missing size, a missing result, an unknown market: no figure.
  assert.equal(estimateAmount({ symbol: 'XAUUSD', qty: 0.1, result_pips: 50, exit_price: 4000 }, 'EUR'), null);
  assert.equal(estimateAmount({ symbol: 'XAUUSD', qty: null, result_pips: 50, exit_price: 4000 }, 'USD'), null);
  assert.equal(estimateAmount({ symbol: 'XAUUSD', qty: 0.1, result_pips: null, exit_price: 4000 }, 'USD'), null);
  assert.equal(estimateAmount({ symbol: 'DOGEUSD', qty: 1, result_pips: 50, exit_price: 1 }, 'USD'), null);
});

test('the amount says how many trades are in it and how many are not', () => {
  const r = foldFlow([
    pos({ position_id: 'g', result_pips: 50, qty: 0.1 }),
    pos({ position_id: 'c', symbol: 'GBPJPY', result_pips: 10, qty: 0.2, exit_price: 200 }),
  ], ACC, WIN);
  assert.deepEqual(r.realized, { amount: 50, currency: 'USD', counted: 1, left: 1 });
  assert.equal(r.netPips, 60, 'pips are exact for every graded trade');
  // No trade that can be priced: no amount at all — not $0.00.
  const none = foldFlow([pos({ position_id: 'c2', symbol: 'GBPJPY', exit_price: 200 })], ACC, WIN);
  assert.equal(none.realized, null);
  const empty = foldFlow([], ACC, WIN);
  assert.equal(empty.realized, null);
  assert.equal(empty.closed, 0);
});

/* ── GENX results ── */
const fire = (o: Partial<GenxFireIn>): GenxFireIn => ({ at: new Date(NOW - 2 * H).toISOString(), side: 'buy', open: 0, avgPips: 40, ...o });

test('GENX results count a trade once, in the period it was opened, and only when every account has closed', () => {
  const fires = [
    fire({ avgPips: 40 }), fire({ avgPips: -25, side: 'SELL' }), fire({ avgPips: 0 }),
    fire({ at: new Date(NOW - 9 * D).toISOString(), avgPips: 300 }),      // before a 7-day window
    fire({ open: 2, avgPips: 15 }),                                         // still open on two accounts
    fire({ avgPips: null }),                                                // nothing gradable on it
  ];
  const r = genxPeriod(fires, { from: NOW - 7 * D, to: NOW });
  assert.equal(r.trades, 3);
  assert.equal(r.wins, 1);
  assert.equal(r.losses, 1);
  assert.equal(r.breakeven, 1);
  assert.equal(r.winRate, 50, 'out of wins and losses; a flat trade is neither');
  assert.equal(r.netPips, 15);
  assert.equal(r.open, 1);
  assert.equal(r.series[0], 0);
  assert.equal(r.series[r.series.length - 1], 15);
  assert.equal(r.recent.length, 3);
  assert.equal(r.recent.find((x) => x.pips === -25)!.side, 'sell');
});

test('no closed trades is zero trades with no win rate — never a 0% record', () => {
  const r = genxPeriod([fire({ open: 1 })], { from: NOW - D, to: NOW });
  assert.equal(r.trades, 0);
  assert.equal(r.winRate, null);
  assert.equal(r.netPips, 0);
  assert.deepEqual(r.series, [0]);
});

test('over "All", GENX results are the desk record itself', () => {
  const row = (o: Partial<RealRow>): RealRow => ({ side: 'buy', outcome: 'target', result_pips: 60, created_at: '2026-11-01T14:00:00Z', resolved_at: '2026-11-01T15:00:00Z', manage_style: 'be_on', status: 'closed', ...o });
  const rows = [
    row({}), row({ created_at: '2026-11-01T14:03:00Z', result_pips: 20 }),                              // one fire, two accounts: +40
    row({ side: 'sell', created_at: '2026-11-02T09:00:00Z', outcome: 'stop', result_pips: -55 }),       // a loss
    row({ created_at: '2026-11-03T09:00:00Z', outcome: 'manual', result_pips: 9 }),                     // hand-closed: still counted
    row({ created_at: '2026-11-04T09:00:00Z', outcome: null, result_pips: null, resolved_at: null, status: 'open' }),
  ];
  const real = buildRealResults(rows);
  const mine = genxPeriod(real.recentFiresAll, { from: Date.parse(SINCE), to: NOW });
  assert.equal(mine.trades, real.summary.trades);
  assert.equal(mine.wins, real.summary.wins);
  assert.equal(mine.losses, real.summary.losses);
  assert.equal(mine.netPips, real.summary.netPips);
  assert.equal(mine.winRate, real.summary.winRate);
  assert.equal(mine.open, 1);
});

test('a row retired without a result must be dropped before the fold, or its whole trade is never graded', () => {
  // The broker stopped listing one account's position before its close was booked (outcome "excluded").
  const row = (o: Partial<RealRow>): RealRow => ({ side: 'buy', outcome: 'target', result_pips: 80, created_at: '2026-11-05T14:00:00Z', resolved_at: '2026-11-05T15:00:00Z', manage_style: 'be_on', status: 'closed', ...o });
  const rows = [row({}), row({ created_at: '2026-11-05T14:02:00Z', result_pips: 60 }), row({ created_at: '2026-11-05T14:04:00Z', outcome: 'excluded', result_pips: null })];
  const win = { from: Date.parse(SINCE), to: NOW };
  const left = genxPeriod(buildRealResults(rows).recentFiresAll, win);
  assert.equal(left.trades, 0, 'left in, the fold holds the trade open for ever');
  const dropped = genxPeriod(buildRealResults(rows.filter((r) => r.outcome !== 'excluded')).recentFiresAll, win);
  assert.equal(dropped.trades, 1);
  assert.equal(dropped.netPips, 70, 'graded on the accounts that have a result');
});

/* ── broker figures ── */
test('a reading is current only inside the freshness window; older is "last known"; nothing read is unavailable', () => {
  const iso = (ago: number) => new Date(NOW - ago).toISOString();
  assert.equal(figuresState(iso(10_000), NOW, true), 'live');
  assert.equal(figuresState(iso(FIGURES_FRESH_MS), NOW, true), 'live');
  assert.equal(figuresState(iso(FIGURES_FRESH_MS + 1000), NOW, true), 'last_known');
  assert.equal(figuresState(null, NOW, true), 'last_known', 'a number with no time is never called current');
  assert.equal(figuresState(iso(10_000), NOW, false), 'unavailable');
});

test('ages read at a glance', () => {
  const iso = (ago: number) => new Date(NOW - ago).toISOString();
  assert.equal(ageText(iso(20_000), NOW), 'just now');
  assert.equal(ageText(iso(4 * 60_000), NOW), '4 min ago');
  assert.equal(ageText(iso(3 * H), NOW), '3 h ago');
  assert.equal(ageText(iso(2 * D), NOW), '2 days ago');
  assert.equal(ageText(iso(D), NOW), '1 day ago');
  assert.equal(ageText(null, NOW), 'not yet read');
});

test('money and pips: a missing number is a dash, a loss carries a true minus, a gain a plus only when asked', () => {
  assert.equal(money(10000, 'USD'), '$10,000.00');
  assert.equal(money(-36.5, 'USD'), '−$36.50');
  assert.equal(money(240, 'USD', { sign: true }), '+$240.00');
  assert.equal(money(0, 'USD', { sign: true }), '$0.00');
  assert.equal(money(1250.5, 'EUR'), '€1,250.50');
  assert.equal(money(99, 'SEK'), 'SEK 99.00');
  assert.equal(money(null, 'USD'), '—');
  assert.equal(money(NaN, 'USD'), '—');
  assert.equal(pipsText(120), '+120 pips');
  assert.equal(pipsText(-36.5), '−36.5 pips');
  assert.equal(pipsText(1), '+1 pip');
  assert.equal(pipsText(0), '0 pips');
  assert.equal(pipsText(null), '—');
  assert.equal(toneOf(5), 'up');
  assert.equal(toneOf(-5), 'down');
  assert.equal(toneOf(0), 'flat');
  assert.equal(toneOf(null), 'flat');
});

/* ── Atlas on The Floor ── */
test('ATLAS\'s read is shown only while it is recent; an old one is not put forward as its view', () => {
  const iso = (ago: number) => new Date(NOW - ago).toISOString();
  assert.deepEqual(atlasReadFor({ at: iso(2 * 60_000), summary: '  Gold is ranging.  ' }, NOW), { at: iso(2 * 60_000), summary: 'Gold is ranging.' });
  assert.equal(atlasReadFor({ at: iso(ATLAS_READ_FRESH_MS + 1000), summary: 'Gold is ranging.' }, NOW), null);
  assert.equal(atlasReadFor({ at: iso(60_000), summary: '   ' }, NOW), null);
  assert.equal(atlasReadFor({ at: 'not a time', summary: 'x' }, NOW), null);
  assert.equal(atlasReadFor({ at: new Date(NOW + 10 * 60_000).toISOString(), summary: 'from the future' }, NOW), null);
  assert.equal(atlasReadFor(null, NOW), null);
});

/* ── the setup, as the chart card says it ── */
test('a locked answer yields only how far along the setup is — no side, no level', () => {
  const v = setupView({ g: null, locked: { stage: 'forming' } });
  assert.equal(v.stage, 'forming');
  assert.equal(v.open, false);
  assert.equal(v.side, null);
  assert.deepEqual(v.levels, []);
  assert.equal(v.zone, null);
  assert.equal(v.waitingFor, null);
  assert.equal(setupView({ g: null, locked: { stage: 'something-else' } }).stage, null);
  assert.equal(setupView(null).stage, null);
});

test('while GENX is only watching, the chart shows support and resistance — not a second copy of them as a plan', () => {
  const v = setupView({ g: { action: 'WAIT_FOR_BUY_TRIGGER', closest_support: 3532.8, closest_resistance: 3565.77, entry: 3532.8, stop_loss: 3525, tp1: 3549, entry_low: 3532.3, entry_high: 3533.6, trigger_condition: ' Wait for a reaction. ', invalidation_reason: '' } });
  assert.equal(v.stage, 'watching');
  assert.equal(v.open, true);
  assert.equal(v.side, 'buy');
  assert.deepEqual(v.levels.map((l) => l.kind), ['resistance', 'support']);
  assert.equal(v.zone, null);
  assert.equal(v.waitingFor, 'Wait for a reaction.');
  assert.equal(v.changesIf, null);
});

test('once GENX has a setup of its own, its entry, stop and first target are drawn — each once', () => {
  const v = setupView({ g: { action: 'SELL_LIMIT', closest_support: 3532.8, closest_resistance: 3565.77, entry: 3565.77, stop_loss: 3571.4, tp1: 3549, entry_low: 3564, entry_high: 3567 } });
  assert.equal(v.stage, 'forming');
  assert.equal(v.side, 'sell');
  assert.deepEqual(v.levels.map((l) => l.kind), ['resistance', 'support', 'stop', 'target'], 'the entry sits on resistance: one line, not two');
  assert.deepEqual(v.zone, { low: 3564, high: 3567 });
  assert.equal(setupView({ g: { action: 'BUY_NOW', entry: 3550, stop_loss: 3540, tp1: 3570 } }).stage, 'live');
});

test('the three states have one name each, and the sentence under the chart names no direction', () => {
  assert.deepEqual(STAGE_LABEL, { watching: 'Watching', forming: 'Waiting for confirmation', live: 'Ready' });
  for (const s of ['watching', 'forming', 'live'] as const) {
    const line = stageSentence(s, 'GENX', 'gold');
    assert.ok(line.includes('GENX') && line.includes('gold'));
    assert.ok(!/\b(buy|sell|long|short|bullish|bearish)\b/i.test(line), `"${line}" must be true for a member who has not opened the play`);
  }
  assert.equal(stageSentence('watching', 'GENX', 'gold'), 'GENX is watching gold. No confirmed entry.');
});

/* ── FLOW's own page: the open trades, the closed ones, and where each came from ── */
test('each trade says which engine it came from, read from what that engine writes', () => {
  assert.equal(flowSource({ symbol: 'EURUSD', strategy_version: 'genfx-1.0' }), 'genfx', 'GEN FX stamps its version');
  assert.equal(flowSource({ symbol: 'GBPJPY', strategy_version: 'GENFX-2' }), 'genfx');
  assert.equal(flowSource({ symbol: 'XAUUSD', strategy_version: null }), 'genx', 'every gold row is GENX\'s');
  assert.equal(flowSource({ symbol: 'XAU/USD' }), 'genx');
  assert.equal(flowSource({ symbol: 'NAS100' }), 'flow', 'the rest are FLOW\'s own');
  assert.equal(flowSource({ symbol: 'EURUSD', strategy_version: '' }), 'flow');
});

test('the open trades are listed with where the stop is now; nothing is made up for a missing value', () => {
  const r = foldFlow([
    pos({ position_id: 'o1', status: 'open', resolved_at: null, entry: 4010, fill_price: 4011.2, init_stop: 3990, cur_stop: 4012, tp1: 4060, created_at: new Date(NOW - 2 * H).toISOString() }),
    pos({ position_id: 'o2', status: 'open', resolved_at: null, symbol: 'EURUSD', strategy_version: 'genfx-1.0', entry: 1.084, fill_price: null, init_stop: 1.082, cur_stop: null, tp1: null, qty: 0.25, created_at: new Date(NOW - 1 * H).toISOString() }),
    pos({ position_id: 'o2', status: 'open', resolved_at: null }),           // the same position on a second row
    pos({ position_id: 'c1' }),
  ], ACC, WIN);
  assert.equal(r.open, 2);
  assert.equal(r.positions!.length, 2, 'one line per position');
  const [newest, older] = r.positions!;
  assert.equal(newest.id, 'o2', 'newest first');
  assert.deepEqual([newest.source, newest.entry, newest.stop, newest.target, newest.qty], ['genfx', 1.084, 1.082, null, 0.25], 'no fill: the price sent; no moved stop: the stop placed; no target: none');
  assert.deepEqual([older.source, older.entry, older.stop, older.target, older.side], ['genx', 4011.2, 4012, 4060, 'buy'], 'the fill, and the stop where the trade manager has it now');
});

test('the history is the window\'s closed trades, newest first, capped and counted', () => {
  const rows = Array.from({ length: HISTORY_MAX + 7 }, (_, i) => pos({ position_id: 'h' + i, result_pips: i % 3 === 0 ? -10 : 20, resolved_at: new Date(NOW - (i + 1) * 60_000).toISOString() }));
  const r = foldFlow([...rows, pos({ position_id: 'old', resolved_at: new Date(NOW - 3 * D).toISOString() })], ACC, WIN);
  assert.equal(r.closed, HISTORY_MAX + 7, 'every closed trade in the window is counted');
  assert.equal(r.history!.length, HISTORY_MAX, 'only so many are listed');
  assert.equal(r.historyMore, 7, 'the rest are said, not hidden');
  assert.equal(r.history![0].id, 'h0', 'newest first');
  assert.ok(!r.history!.some((h) => h.id === 'old'), 'a trade outside the window is not in it');
  assert.equal(r.recent.length, 5, 'The Floor\'s short list is unchanged');
  const none = foldFlow([pos({ position_id: 'x', result_pips: null })], ACC, WIN);
  assert.equal(none.history![0].pips, null, 'a close with no recorded result is listed as such, never as 0');
});
