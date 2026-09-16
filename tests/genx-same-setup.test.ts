import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sameSetupZone } from '../src/lib/genx/watchTick';

const z = (side: 'buy' | 'sell', lo: number, hi: number) => ({ side, entry_low: lo, entry_high: hi });
test('the 09-16 repeated SELL zones are recognised as ONE setup', () => {
  const first = z('sell', 4274.19, 4277.64);
  for (const [lo, hi] of [[4274.55, 4278], [4277.82, 4281.27], [4278.26, 4281.73], [4279.72, 4283.19], [4276.44, 4279.91], [4275.35, 4278.82]]) assert.ok(sameSetupZone(first, z('sell', lo, hi)), `${lo}-${hi}`);
  assert.ok(sameSetupZone(z('buy', 4313.31, 4314.44), z('buy', 4310.89, 4312.02)), 'the 18:15 double BUY');
});
test('a genuinely different setup is not merged', () => {
  assert.ok(!sameSetupZone(z('sell', 4274.19, 4277.64), z('buy', 4274.19, 4277.64)), 'opposite side');
  assert.ok(!sameSetupZone(z('buy', 4313.31, 4314.44), z('buy', 4342, 4343)), '$30 away');
});
test('scan and watch both apply the same-setup dedupe; alerts are recorded before they are posted', () => {
  const scan = readFileSync('src/app/api/cron/genx-scan/route.ts', 'utf8');
  assert.ok(/findSameSetup\(admin, \{ side, entry_low: genx\.entry_low/.test(scan));
  assert.ok((scan.match(/if \(insErr\) \{ modeOut\.result = "already_recorded"; continue; \}/g) ?? []).length === 2);
  assert.ok(/findSameSetup\(admin, row, row\.id\)/.test(readFileSync('src/lib/genx/watchTick.ts', 'utf8')));
});
