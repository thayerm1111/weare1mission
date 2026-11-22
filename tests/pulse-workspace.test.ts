import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scanMs, categoryOf, SCAN_FRESH_MS } from '../src/lib/pulse/scan';

/**
 * MARKET PULSE IN THE TRADING PLATFORM'S SHELL (owner 11-20 brief §13).
 *
 * The scanner, its ranking and its paid actions are unchanged: inside the new shell MarketPulse's own state is
 * drawn as a ranked list with the selected market beside it. Opening it never scans.
 */
const read = (p: string) => readFileSync(p, 'utf8');
const pulse = read('src/components/portal/floor/MarketPulse.tsx');
const home = read('src/components/om/pulse/PulseHome.tsx');

test('opening Market Pulse never scans: the page shows the last scan kept on the device', () => {
  assert.match(pulse, /const next = useNextShell\(\);\n  const \[setups, setSetups\]/);
  assert.match(pulse, /<PulseHome setups=\{setups\} loading=\{loading\} asOf=\{asOf\} msg=\{msg\} hydrated=\{hydrated\} scan=\{\(\) => void scan\(\)\} onDeepDive=\{setDive\} \/>/);
  assert.ok(!/fetch\(/.test(home), 'the new page asks the server for nothing of its own');
  assert.match(home, /<button type="button" className="om-btn" onClick=\{scan\} disabled=\{loading\}>/, 'the scan is the member\'s tap');
  assert.match(home, /\{CREDIT_COST\.scan\} credits a scan/);
});

test('the scan\'s own time is read, shown with its age, and an earlier scan says so', () => {
  assert.equal(scanMs('2026-11-20 23:15 UTC'), Date.parse('2026-11-20T23:15:00Z'));
  assert.equal(scanMs('2026-11-20T23:15:00.000Z'), Date.parse('2026-11-20T23:15:00Z'));
  assert.equal(scanMs(''), null);
  assert.equal(scanMs('soon'), null);
  assert.equal(SCAN_FRESH_MS, 15 * 60_000);
  assert.match(home, /An earlier scan · \{when\(at!\)\}/);
  assert.match(home, /not what is tradable now/);
  assert.match(home, /The list below is still the scan from \$\{when\(at\)\}\./, 'a failed scan keeps the last list, with its own date');
});

test('the ranking is the scanner\'s: its order, its count — no badge, score or probability added', () => {
  assert.match(home, /setups\.map\(\(s, i\) => \(\{ s, rank: i \+ 1 \}\)\)/, 'rank is the scan\'s own order, kept through a filter');
  assert.match(home, /\{s\.confirmed\} of \{s\.total\}/);
  assert.ok(!/A\+|probability|%<\/|chance/i.test(home.replace(/\/\*[\s\S]*?\*\//g, '')), 'no A+ badge, no probability');
  assert.match(home, /A lean is not a trade\./);
  assert.match(home, /Not a confirmed setup\./);
});

test('a selected market carries its scan into Atlas, with a separate priced generation step', () => {
  assert.match(home, /openAtlas\(\{ tool: "plays", context \}\)/);
  assert.match(home, /<Link href=\{playsHref\(s\.td, "intraday"\)\} className="om-btn-quiet">Open in OM AI Plays<\/Link>/);
  assert.match(home, /then generate for \{CREDIT_COST\.signal\} credits/);
  assert.match(home, /Deep dive · \{CREDIT_COST\.deepdive\} credit/);
  assert.match(home, /asOf: scanAt \? new Date\(scanAt\)\.toISOString\(\) : null/);
  assert.match(home, /confirmedSetup: false/);
  assert.ok(!/window\.location\.assign|leaveGenerateIntent|leaveFloorQuestion/.test(home));
  assert.match(home, /Copy trade/);
});

test('markets are grouped by the scanner\'s own rule', () => {
  assert.equal(categoryOf('BTC/USD'), 'Crypto');
  assert.equal(categoryOf('XAU/USD'), 'Commodities');
  assert.equal(categoryOf('NDX'), 'Indices');
  assert.equal(categoryOf('EUR/USD'), 'Forex');
  assert.match(read('src/components/portal/floor/FloorWorkspace.tsx'), /if \(bare && tab === "pulse"\) return <MarketPulse \/>;/);
});
