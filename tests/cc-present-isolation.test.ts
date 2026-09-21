import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/*
 * THE GAUGES NEVER TOUCH THE STEERING WHEEL.
 *
 * command-center/present/* is the read-only presentation layer for the Command Center screen. Only the
 * reads that serve the screen (engines/live.ts, engines/replay.ts) may import it. If any engine, core, brain, adapter
 * or worker file — or FLOW / GENX — ever imports it, display analytics could leak into a trading
 * decision, and this test fails.
 */
const ALLOWED = new Set(['command-center/engines/live.ts', 'command-center/engines/replay.ts']);
function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (n === 'node_modules' || n.startsWith('.')) continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(n)) out.push(p);
  }
  return out;
}

test('nothing on the trading path imports the presentation layer', () => {
  const files = [...walk('command-center'), ...walk('src/lib')].filter((f) => !f.startsWith('command-center/present/'));
  const offenders = files.filter((f) => !ALLOWED.has(f) && /from\s+["'][^"']*\/present\//.test(readFileSync(f, 'utf8')));
  assert.deepEqual(offenders, []);
});
