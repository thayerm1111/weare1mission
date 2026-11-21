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
const start = src.indexOf('  if (next) {');
const end = src.indexOf('  return (\n    <div className="relative overflow-hidden rounded-3xl bg-[#0a0b10]');
const workspace = src.slice(start, end);
const classic = src.slice(end, src.indexOf('\nfunction dirStyle('));

test('the shell says where a tool is drawn, and nothing else', () => {
  const shell = read('src/components/om/shell.ts');
  assert.match(shell, /export const ShellContext = createContext\(false\);/, 'outside the new shell the answer is no');
  assert.match(read('src/components/om/AppShell.tsx'), /<ShellContext\.Provider value=\{true\}>\{children\}<\/ShellContext\.Provider>/);
  assert.match(src, /const next = useNextShell\(\);/);
  assert.ok(start > 0 && end > start && workspace.length > 3000, 'the workspace is an early return of the same component');
});

test('the workspace runs on the generator the classic view runs on', () => {
  // One request path for a play, one price: both views call the same generate() and print the same cost.
  assert.equal((src.match(/fetch\("\/api\/om-signal"/g) ?? []).length, 1);
  assert.ok(!/fetch\(/.test(workspace), 'the workspace makes no request of its own');
  assert.match(workspace, /onClick=\{\(\) => void generate\(\)\}/);
  assert.match(workspace, /const cost: number = CREDIT_COST\.signal;/);
  assert.match(workspace, /\{cost\} \{cost === 1 \? "credit" : "credits"\} per play/, 'what it costs is beside the action, read from the setting');
  for (const h of ['checkResult(result)', 'getUpdate(result)', 'deleteResult(r.id)', 'pickMethod(m.k)', 'toggleConf(c.k)', 'setDive(result)']) assert.ok(workspace.includes(h), `${h} is the existing handler`);
  // Every choice the dialog offered is still offered.
  for (const c of ['setMode("institutional")', 'setMode("accelerator")', 'METHODS.map', 'CONFS.map', 'setOrderType("limit")', 'setOrderType("market")', '"scalp"', '"intraday"', '"swing"']) assert.ok(workspace.includes(c), c);
  assert.match(workspace, /disabled=\{!asset \|\| confs\.length === 0 \|\| busy\}/, 'nothing can be generated without a market, a confirmation, or twice at once');
});

test('nothing is generated, charged or reset by looking', () => {
  assert.ok(!/\breset\(\)/.test(workspace), 'opening Advanced or choosing a market resets no selection');
  assert.ok(!/GEN_STEPS|genStep/.test(workspace), 'no invented progress stages: one honest "Analyzing" state');
  assert.match(workspace, /Nothing is analyzed until you ask\./);
  // The only automatic generation is the existing deep link from Market Pulse's own button, unchanged.
  assert.equal((src.match(/void generate\(found\.asset\);/g) ?? []).length, 1);
});

test('a saved play says its setup and its outcome as two things, in words', () => {
  assert.match(src, /const waiting = none \|\| s\.status === "no_trade";/);
  assert.match(src, /const setup = none \? "No setup" : waiting \? `\$\{side\} idea, not confirmed` : `\$\{side\} setup`;/, 'an unconfirmed play is never called a setup');
  assert.match(src, /r\.status === "loss" \? "Stopped out" : none \? "No trade" : waiting \? "Waiting for confirmation" : "Open"/, 'a play still waiting is never called an open trade');
  const row = src.slice(src.indexOf('function PlayRow('), src.indexOf('function CompactCard('));
  assert.match(row, /sure\s*\n?\s*\? <button type="button" role="menuitem" className="om-danger"/, 'deleting takes a second, named tap');
  assert.match(row, /const canCheck = r\.status === "open" && r\.signal\.direction !== "NEUTRAL";/);
});

test('the classic portal still draws the tool exactly as it did', () => {
  for (const s of ['Generate Signal', 'Step 1 · Market Type', 'Step 2 · Select Asset', 'Step 3 · Configure', '<CompactCard key={r.id}', 'GEN_STEPS.map']) assert.ok(classic.includes(s), s);
});
