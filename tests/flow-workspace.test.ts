import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pairName, priceFor, lotsText, entryWords, decimalsFor } from '../src/lib/flow/display';
import { placementRisk, placementSize } from '../src/lib/flow/ticketSizing';

/**
 * FLOW IN THE TRADING PLATFORM'S SHELL (owner 11-20 brief §9).
 *
 * FLOW's components are shared with the classic portal, which every member still uses. Inside the new shell
 * they are drawn differently; everywhere else exactly as before. The new drawing runs on the same state and
 * calls the same handlers — so it cannot change what is saved, when, or for which account.
 */
const read = (p: string) => readFileSync(p, 'utf8');
const desk = read('src/components/portal/floor/FlowDesk.tsx');
const connect = read('src/components/portal/floor/FlowConnect.tsx');
const exec = read('src/components/om/flow/FlowExecution.tsx');
const home = read('src/components/om/flow/FlowHome.tsx');
const record = read('src/components/portal/floor/FlowTrackRecord.tsx');

test('opening FLOW reads nothing: a reading is made only when the member asks for one', () => {
  assert.match(desk, /useEffect\(\(\) => \{ if \(!next\) run\(\); \}, \[run, next\]\);/, 'the classic desk still reads on open; the new shell does not');
  const branch = desk.slice(desk.indexOf('  if (next) {\n    const horizon'), desk.indexOf('    return <FlowHome find={find} />;'));
  assert.ok(branch.length > 1000);
  assert.match(branch, /onClick=\{run\}/, 'Find my trade is the member\'s own tap');
  assert.match(branch, /onOpened=\{\(\) => runNow\.current\(\)\}/, 'and the play being opened');
  assert.ok(!/useEffect/.test(branch), 'nothing in the new branch reads by itself');
});

test('the settings panel is the same component, the same state and the same handlers', () => {
  const start = connect.indexOf('  if (next) {');
  const end = connect.indexOf('  return (\n    <div className="space-y-4">');
  assert.ok(start > 0 && end > start, 'an early return, after every hook');
  const branch = connect.slice(start, end);
  for (const h of ['toggleAccount', 'setAccountFollow', 'setAccountRisk', 'setManagement', 'setAccountMode', 'lockRisk', 'toggleAuto', 'load', 'disconnect', 'connect']) {
    assert.match(branch, new RegExp(`void ${h}\\(`), `${h} is the classic handler`);
  }
  assert.ok(!/fetch\(/.test(exec), 'the panel itself asks the server for nothing');
  assert.ok(!/FlowTour/.test(branch), 'the classic walkthrough is not mounted over the new page');
});

test('the platform-wide switches are not on a member\'s page: the owner gets a link to where they live', () => {
  assert.ok(!/api\/admin\/switches/.test(exec), 'the panel never reads or writes them');
  assert.match(exec, /\{c\.owner && <a className="om-go om-flow-admin" href="\/admin\/controls">/);
  assert.match(read('src/app/admin/controls/page.tsx'), /\/api\/admin\/switches/, 'the separate admin page keeps them, unchanged');
});

test('the words say what the service does: Auto-run on, off and never set are three different things', () => {
  assert.match(exec, /No automated trade reaches any of your accounts — neither FLOW's nor GENX's\./);
  assert.match(exec, /FLOW's own forex and index trades are not placed\. GENX trades still reach accounts with Trading or Follow GENX on\./);
  assert.match(exec, /if \(auto\.set === false\) return \{ on: false, label: "Not switched on"/);
  assert.match(read('src/app/api/flow/autorun/route.ts'), /set: r != null,/, 'the service says whether the switch was ever set');
  assert.ok(!/never trades on its own|never places a live-money order without/i.test(connect.replace(/\/\*[\s\S]*?\*\/|\{\/\*[\s\S]*?\*\/\}/g, '')), 'the classic panel no longer says FLOW never trades on its own');
  assert.match(exec, /A new account starts with <b>Trading on<\/b>/, 'connecting is said to arm the account, because today it does');
  assert.match(exec, /Paused by FLOW: out of credits/, 'a pause is the service\'s own report, never inferred from a switch');
});

test('a pause, a disconnect and a close are different things, and disconnect says how far it reaches', () => {
  assert.match(exec, /To pause new entries on this account, switch off Trading and Follow every GENX signal\. Trades already open stay open/);
  assert.match(exec, /This disconnects every broker login you have connected to FLOW, not just this account\./);
  assert.match(exec, /\{!sure && <button type="button" className="om-btn-quiet om-danger" onClick=\{\(\) => setSure\(true\)\}>Disconnect…<\/button>\}/, 'one tap never disconnects');
});

test('the account looked at is The Floor\'s, and looking changes nothing', () => {
  assert.match(home, /const KEY_ACCOUNT = "om:floor:account", KEY_PERIOD = "om:floor:flow", KEY_HIDE = "om:floor:hide"/, 'the same keys The Floor uses');
  assert.match(read('src/components/om/floor/Floor.tsx'), /store\.get\("om:floor:account"\)/);
  assert.match(home, /headers\["x-floor-account"\] = pick\.id/, 'named in a header, not the address');
  assert.ok(!/method: "POST"/.test(home), 'the page writes nothing of its own');
});

test('the desk record is labelled as the desk\'s, and shows only what it counts', () => {
  const branch = record.slice(record.indexOf('function DeskRecord('));
  assert.match(branch, /Not your account: yours is My FLOW, above\./);
  assert.ok(!/fullTarget|trailed|partialsTaken/.test(branch), 'no tile for a count the answer does not make');
  assert.match(record, /if \(next\) return <DeskRecord/);
});

test('FLOW draws on the shell\'s page, not inside the classic frame', () => {
  assert.match(read('src/components/portal/floor/FloorWorkspace.tsx'), /if \(bare && tab === "flow"\) return <FlowDesk \/>;/);
});

test('quotes are written to the market\'s own precision, never with a raw decimal tail', () => {
  assert.equal(priceFor('XAUUSD', 2034.5600000001), '2,034.56');
  assert.equal(priceFor('EURUSD', 1.0842151), '1.08422');
  assert.equal(priceFor('GBPJPY', 199.123456), '199.123');
  assert.equal(priceFor('NAS100', 21050.25), '21,050.3');
  assert.equal(priceFor('ABCXYZ', 12.3456789), '12.346', 'an unknown market is read from the size of its price');
  assert.equal(decimalsFor('XAU/USD', 1), 2);
  assert.equal(priceFor('XAUUSD', null), '—');
  assert.equal(pairName('XAUUSD'), 'XAU/USD');
  assert.equal(pairName('NAS100'), 'NAS100');
  assert.equal(lotsText(0.1), '0.1 lots');
  assert.equal(lotsText(1), '1 lot');
  assert.equal(lotsText(null), '—');
});

test('a setup\'s state is said in the platform\'s words, and only a confirmed entry is Ready', () => {
  assert.deepEqual(['ENTER_NOW', 'ARMED', 'WAIT', 'APPROACHING', 'MISSED', 'INVALIDATED', 'EXPIRED', 'STAND_ASIDE', 'ENTER_ON_PULLBACK', 'NO_TRADE', ''].map((s) => entryWords(s).ready), [true, false, false, false, false, false, false, false, false, false, false]);
  assert.equal(entryWords('ARMED').label, 'Waiting for confirmation');
  assert.equal(entryWords('WAIT').label, 'Watching');
  assert.ok(!/_/.test(entryWords('NO_TRADE').label), 'never a raw engine name');
  assert.match(desk, /"Place anyway · manual override"/, 'an unconfirmed ticket says it is an override');
});

/* ── the ticket's sizing, account by account ── */
test('the ticket shows the size each account is placed at: its own risk, the small-account caps', () => {
  assert.equal(placementRisk(null, 1, 10_000), 1, 'no risk of its own: the ticket\'s');
  assert.equal(placementRisk(0.5, 2, 10_000), 0.5, 'its own risk wins');
  assert.equal(placementRisk(null, 3, 1_500), 2, 'under $2,000: at most 2%');
  assert.equal(placementRisk(null, 1, 500), 0.5, '$600 or less: at most 0.5%');
  assert.equal(placementRisk(5, 1, 600), 0.5);
  const s = placementSize({ canonical: 'XAUUSD', entry: 4000, stop: 3990, equity: 500, accountRiskPct: null, ticketRiskPct: 1 })!;
  assert.equal(s.riskPct, 0.5);
  assert.equal(s.capped, true);
  assert.ok(s.lots != null && s.lots > 0, 'the broker minimum rather than nothing');
  assert.equal(placementSize({ canonical: 'XAUUSD', entry: 4000, stop: 3990, equity: null, ticketRiskPct: 1 }), null, 'no equity: no size, never a guess');
});

test('the ticket\'s rule is the executor\'s rule — this fails if the executor ever changes it', () => {
  const ex = read('src/lib/flow/executor.ts');
  assert.match(ex, /let acctRisk = a\.riskPct != null && a\.riskPct > 0 \? a\.riskPct : opts\.riskPct;/);
  assert.match(ex, /if \(a\.equity < 2000\) acctRisk = Math\.min\(acctRisk, 2\);/);
  assert.match(ex, /if \(a\.equity <= 600\) acctRisk = Math\.min\(acctRisk, 0\.5\);/);
  assert.match(ex, /const s = sizeFromRisk\(\{ canonical, entry: opts\.entry, stop, equity: a\.equity, riskPct: acctRisk, floorToMinLot: true \}\);/);
  const route = read('src/app/api/flow/execute/route.ts');
  assert.match(route, /placement: placementSize\(\{ canonical: symbol, entry, stop, equity: a\.equity, accountRiskPct: a\.riskPct \?\? null, ticketRiskPct: riskPct \}\)/);
  assert.match(route, /const res = await placeOnActiveAccounts\(\{ userId: user\.id, symbol, side, entry, stop, tp, riskPct, source: "play", accounts: accts \}\);/, 'placing is unchanged');
});

test('the panel over the page is closed off the edge, fits a phone, and is drawn above the bar', () => {
  const css = read('src/components/om/om.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(css, /\.om-drawer-panel \{[^}]*max-width: 100vw;[^}]*transform: translateX\(100%\); visibility: hidden/);
  assert.match(css, /\.om-drawer \{ position: fixed; inset: 0; z-index: 70;/);
  const drawer = read('src/components/om/Drawer.tsx');
  assert.match(drawer, /const shut = \(open \? \{\} : \{ inert: "" \}\)/, 'closed, nothing in it can be reached');
  assert.match(drawer, /if \(e\.key === "Escape"\)/);
  assert.match(drawer, /back\?\.focus\?\.\(\)/, 'focus goes back to what opened it');
});

test('FLOW names no account state until the account it is looking at, and its Auto-run setting, are known (11-21)', async () => {
  const React = await import('react');
  (globalThis as unknown as { React: unknown }).React = React;     // the test runner compiles JSX the classic way
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { FlowExecution } = await import('../src/components/om/flow/FlowExecution');
  const acct = { accountId: 'A1', accNum: 1, name: 'Main', environment: 'live', autotradeEnabled: true, genxFollower: false, selected: true, riskPct: null } as never;
  const base = {
    loading: false, connected: true, conn: null, accounts: [acct], view: acct, viewName: 'Main', health: null,
    auto: { enabled: true, set: true }, defaultRisk: 1, riskLocked: false, autoBusy: false, autoMsg: '', owner: false, busy: false, err: '', ok: '',
    mgmtBusy: false, mgmtErr: '', manage: null, onManage: () => {}, onRecheck: () => {},
    form: { env: 'demo', server: '', email: '', password: '', adding: false, setEnv() {}, setServer() {}, setEmail() {}, setPassword() {}, setAdding() {}, connect() {} },
  } as never as Record<string, unknown>;
  // The summary beside the results (the settings panel is a separate, closed drawer).
  const html = (over: Record<string, unknown>) => {
    const out = renderToStaticMarkup(React.createElement(FlowExecution as never, { ...base, ...over } as never));
    return out.slice(0, out.indexOf('</aside>'));
  };
  // Which account is being looked at is not known yet: loading, nothing claimed, nothing to press.
  const waiting = html({ viewReady: false });
  assert.match(waiting, /Loading account status/);
  assert.ok(!/Taken|Trading on|Not taken|Manage execution/.test(waiting), waiting);
  // The Auto-run setting is still on its way: the same.
  assert.match(html({ viewReady: true, auto: null }), /Loading account status/);
  // It could not be read: what depends on it is said to, and nothing is called on or off.
  const failed = html({ viewReady: true, auto: null, autoFailed: true });
  assert.match(failed, /Depends on Auto-run, which could not be read/);
  assert.ok(!/Taken · /.test(failed));
  // Known: the account's own state.
  assert.match(html({ viewReady: true }), /Taken · Trading on/);
  // The page tells the panel when it knows; an error answer from Auto-run is not read as a setting.
  assert.match(home, /viewReady=\{ovState !== "loading"\}/);
  assert.match(connect, /if \(!r\.ok\) \{ setAutoFailed\(true\); return; \}/);
  // The settings panel shows no account's switches while it is unknown which account it is, and an
  // Auto-run switch whose position could not be read cannot be pressed.
  const drawer = renderToStaticMarkup(React.createElement(FlowExecution as never, { ...base, viewReady: false } as never));
  assert.ok(!/aria-label="Trading on this account"/.test(drawer));
  assert.match(exec, /disabled=\{c\.autoBusy \|\| !c\.auto\}/);
});
