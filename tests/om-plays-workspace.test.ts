import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * OM AI PLAYS IN THE TRADING PLATFORM'S SHELL (owner's brief, 11-20 evening).
 *
 * The tool is shared with the classic portal, which every member still uses. Inside the new shell it is
 * drawn as a workspace; everywhere else it is drawn exactly as before. Both run on the same state and the
 * same handlers, so the redesign cannot change what is generated, what it costs, or what is saved.
 */
const read = (p: string) => readFileSync(p, 'utf8');
const src = read('src/components/portal/SignalGenerator.tsx');
const start = src.indexOf('  if (next) {\n    const q = find.trim().toLowerCase();');
const end = src.indexOf('  return (\n    <div className="relative overflow-hidden rounded-3xl bg-[#0a0b10]');
const workspace = src.slice(start, end);
const classic = src.slice(end, src.indexOf('\nfunction dirStyle('));

test('the shell says where a tool is drawn, and nothing else', () => {
  const shell = read('src/components/om/shell.ts');
  assert.match(shell, /export const ShellContext = createContext\(false\);/, 'outside the new shell the answer is no');
  const provided = read('src/components/om/AppShell.tsx').match(/<ShellContext\.Provider value=\{true\}>([\s\S]*?)<\/ShellContext\.Provider>/)?.[1] ?? '';
  assert.match(provided, /\{children\}/, 'tool children remain inside the new-shell provider alongside the shared frame');
  assert.match(src, /const next = useNextShell\(\);/);
  assert.ok(start > 0 && end > start && workspace.length > 3000, 'the workspace is an early return of the same component');
});

test('the workspace runs on the generator the classic view runs on', () => {
  // One request path for a play, one price: both views call the same generate() and print the same cost.
  assert.equal((src.match(/fetch\("\/api\/om-signal"/g) ?? []).length, 1);
  assert.ok(!/fetch\(/.test(workspace), 'the workspace makes no request of its own');
  assert.match(workspace, /onClick=\{\(\) => void generate\(\)\}/);
  assert.match(workspace, /const cost: number = CREDIT_COST\.signal;/);
  assert.match(workspace, /\{cost\} \{cost === 1 \? "credit" : "credits"\} a play · included with the FLOW Pass · charged only when a play is made/, 'what it costs is beside the action, read from the setting');
  for (const h of ['checkResult(result)', 'getUpdate(result)', 'deleteResult(r.id)', 'pickMethod(m.k)', 'toggleConf(c.k)', 'setDive(result)']) assert.ok(workspace.includes(h), `${h} is the existing handler`);
  // Every choice the dialog offered is still offered.
  for (const c of ['setMode("institutional")', 'setMode("accelerator")', 'METHODS.map', 'CONFS.map', 'setOrderType("limit")', 'setOrderType("market")', '"scalp"', '"intraday"', '"swing"']) assert.ok(workspace.includes(c), c);
  assert.match(workspace, /const need = !asset \? "Choose a market to continue\." : confs\.length === 0 \? "Turn on at least one confirmation under Method to continue\." : null;/);
  assert.match(workspace, /disabled=\{!!need \|\| busy\}/, 'nothing can be generated without a market, a confirmation, or twice at once');
});

test('nothing is generated, charged or reset by looking', () => {
  assert.ok(!/\breset\(\)/.test(workspace), 'opening Advanced or choosing a market resets no selection');
  assert.ok(!/GEN_STEPS|genStep/.test(workspace), 'no invented progress stages: one honest "Analyzing" state');
  assert.match(workspace, /Nothing is analyzed until you press Generate\./);
  // The only automatic generation is the deep link — and in the new shell only for the member's own fresh,
  // one-time intent (11-21): a refresh, Back, a remount or a shared address charges nothing.
  assert.equal((src.match(/void generate\(found\.asset\);/g) ?? []).length, 1);
  const link = src.slice(src.indexOf('const td = q.get("td");'), src.indexOf('void generate(found.asset);'));
  assert.match(link, /const gen = q\.get\("generate"\), openOnly = q\.get\("open"\) === "1";\s*if \(next \|\| gen \|\| openOnly\) \{\s*if \(openOnly && !gen\) return;\s*let mine = false;\s*try \{ mine = takeGenerateIntent\(window\.sessionStorage, gen, td\); \} catch \{ mine = false; \}\s*if \(!mine\) return;/);
  assert.ok(link.indexOf('replaceState') < link.indexOf('takeGenerateIntent'), 'the address is cleaned before anything else');
  // Choosing a market — from the list or a quick pick — chooses it and nothing else.
  for (const m of workspace.matchAll(/onClick=\{\(\) => \{ setMarket\(m\); setAsset\(a\);[^}]*\}\}/g)) assert.ok(!/generate/.test(m[0]), m[0]);
});

test('a saved play says its setup and its outcome as two things, in words', async () => {
  const { analysisOf, trackingOf } = await import('../src/lib/plays/lifecycle');
  const sig = (o: object) => ({ direction: 'SHORT', status: 'setup', entry: 1.1, stopLoss: 1.11, takeProfits: [1.08], ...o }) as never;
  assert.equal(analysisOf(sig({ status: 'no_trade' })).label, 'Sell idea, not confirmed', 'an unconfirmed play is never called a setup');
  assert.equal(analysisOf(sig({})).label, 'Sell setup');
  assert.equal(analysisOf(sig({ status: undefined })).label, 'Sell setup', 'a play saved before the gate existed was released');
  assert.equal(analysisOf(sig({ direction: 'NEUTRAL' })).label, 'No setup');
  // 11-21: an idea whose levels price later reached is said as price, in a neutral voice — never a win.
  const idea = trackingOf({ status: 'win', hitTp: 2, signal: sig({ status: 'no_trade' }) });
  assert.deepEqual([idea.label, idea.tone], ['Price later reached target 2', null]);
  assert.match(idea.note, /never confirmed, and no order is implied/);
  const won = trackingOf({ status: 'win', hitTp: 1, signal: sig({}) });
  assert.deepEqual([won.label, won.tone], ['Price reached target 1', 'pos']);
  assert.match(won.note, /not an order on your account/);
  assert.deepEqual([trackingOf({ status: 'loss', signal: sig({}) }).label, trackingOf({ status: 'loss', signal: sig({ status: 'no_trade' }) }).tone], ['Price reached the stop', null]);
  assert.equal(trackingOf({ status: 'open', signal: sig({ status: 'no_trade' }) }).label, 'Not confirmed yet', 'a play still waiting is never called an open trade');
  for (const t of ['win', 'loss', 'open'] as const) assert.ok(!/won|lost|filled|profit/i.test(trackingOf({ status: t, signal: sig({}) }).label));
  assert.match(src, /const a = analysisOf\(r\.signal\), t = trackingOf\(r\);\s*return \{ setup: a\.label, outcome: t\.label, tone: t\.tone \};/);
  const row = src.slice(src.indexOf('function PlayRow('), src.indexOf('function CompactCard('));
  assert.match(row, /sure\s*\n?\s*\? <button type="button" role="menuitem" className="om-danger"/, 'deleting takes a second, named tap');
  assert.match(row, /const canCheck = r\.status === "open" && r\.signal\.direction !== "NEUTRAL";/);
});

test('the classic portal still draws the tool exactly as it did', () => {
  for (const s of ['Generate Signal', 'Step 1 · Market Type', 'Step 2 · Select Asset', 'Step 3 · Configure', '<CompactCard key={r.id}', 'GEN_STEPS.map']) assert.ok(classic.includes(s), s);
});

test('a link generates once, only for the member\'s own fresh intent (11-21 brief §9)', async () => {
  const { leaveGenerateIntent, takeGenerateIntent, playsHref, INTENT_TTL_MS } = await import('../src/lib/plays/intent');
  const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) }; };
  const t0 = 1_800_000_000_000;
  const a = mem(), n = leaveGenerateIntent(a, 'EUR/USD', 'intraday', t0);
  assert.equal(takeGenerateIntent(a, n, 'EUR/USD', t0 + 900), true);
  assert.equal(takeGenerateIntent(a, n, 'EUR/USD', t0 + 1000), false, 'a refresh, Back or a remount: used up');
  const b = mem(), nb = leaveGenerateIntent(b, 'EUR/USD', 'intraday', t0);
  assert.equal(takeGenerateIntent(b, nb, 'GBP/USD', t0 + 10), false, 'another market');
  const c = mem(), nc = leaveGenerateIntent(c, 'EUR/USD', 'intraday', t0);
  assert.equal(takeGenerateIntent(c, nc, 'EUR/USD', t0 + INTENT_TTL_MS + 1), false, 'stale');
  assert.equal(takeGenerateIntent(mem(), 'abc', 'EUR/USD', t0), false, 'a shared address has no intent behind it');
  assert.equal(takeGenerateIntent(mem(), null, 'EUR/USD', t0), false);
  assert.equal(playsHref('EUR/USD', 'intraday'), '/portal/signals?td=EUR%2FUSD&style=intraday&open=1', 'fill in only, in either view');
  assert.match(playsHref('EUR/USD', 'intraday', 'n1'), /&generate=n1$/);
});

test('the first action is obvious: market, style, then Generate — the method opens below it', () => {
  const i1 = workspace.indexOf('om-step-n" aria-hidden="true">1<'), i2 = workspace.indexOf('om-step-n" aria-hidden="true">2<'), i3 = workspace.indexOf('om-step-n" aria-hidden="true">3<');
  const adv = workspace.indexOf('id="om-plays-adv"');
  assert.ok(i1 > 0 && i2 > i1 && i3 > i2 && adv > i3, 'Generate sits before the method, so opening it never pushes the action away');
  assert.match(workspace, /for \(const r of recent\) offer\(r\.td\);\s*for \(const td of POPULAR\) offer\(td\);/, 'a few markets to start from: the member\'s own first');
  assert.match(workspace, /\{need && <p className="om-plays-need" id="om-plays-need" role="status">\{need\}<\/p>\}/, 'what is missing is said at the control');
  assert.match(workspace, /Your play appears here/);
  for (const w of ['The market read', 'The chart and the levels', 'What to do next']) assert.ok(workspace.includes(w), w);
  assert.match(workspace, /<PlayDetail r=\{result\}/);
});

test('an open play: decision first, the play\'s own chart and levels, tracking apart from orders, and an explicit ticket', () => {
  const d = read('src/components/om/plays/PlayDetail.tsx');
  assert.ok(!/fetch\(|\/api\//.test(d), 'the detail asks the server for nothing');
  const order = ['om-play-head', 'om-play-decision', 'om-play-chart', 'om-play-levels', 'om-play-track', 'om-play-next', 'om-play-why'].map((k) => d.indexOf(`className="${k}"`));
  assert.ok(order.every((x, i) => x > 0 && (i === 0 || x > order[i - 1])), `the hierarchy, in order: ${order}`);
  assert.match(d, /Since it was made · price against its levels/);
  assert.match(d, /not a chance of winning/);
  const t = src.slice(src.indexOf('function ExecuteSignal('), src.indexOf('function FullCard('));
  const nt = t.slice(t.indexOf('  if (next) {'), t.indexOf('  return (\n    <div className="mt-4 rounded-2xl border border-emerald-400/25'));
  assert.ok(nt.length > 2000);
  assert.match(nt, /Manual override\.<\/b> The engine has not confirmed this idea/);
  assert.match(nt, /"Place anyway · manual override"/);
  assert.match(nt, /onClick=\{\(\) => setConfirming\(true\)\}/, 'the first tap only reviews');
  assert.match(nt, /onClick=\{\(\) => \{ setConfirming\(false\); execute\(\); \}\}/, 'the order is the existing request, on the second tap');
  assert.match(nt, /not left waiting at the play's limit entry of/, 'a limit play is not silently turned into something else');
  assert.match(nt, /per\.map\(\(p\) => \{\s*const pl = p\.placement \?\? null/, 'each account with its own size');
  assert.equal((t.match(/fetch\("\/api\/flow\/execute"/g) ?? []).length, 2, 'the same preview and placement requests as before');
});
