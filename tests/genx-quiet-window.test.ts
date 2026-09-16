import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inScanQuietWindow } from '../src/lib/flow/autoExec';

const ny = (y: number, mo: number, d: number, h: number, mi: number) => new Date(Date.UTC(y, mo - 1, d, h + 4, mi)); // EDT = UTC-4
test('GENX scanning stops 45 minutes before the close and resumes when entries reopen (7pm NY)', () => {
  assert.equal(inScanQuietWindow(ny(2026, 9, 16, 16, 14)), false, '4:14pm scanning');
  assert.equal(inScanQuietWindow(ny(2026, 9, 16, 16, 15)), true, '4:15pm quiet');
  assert.equal(inScanQuietWindow(ny(2026, 9, 16, 16, 56)), true, '4:56pm quiet (the screenshot case)');
  assert.equal(inScanQuietWindow(ny(2026, 9, 16, 18, 30)), true, 'after the 6pm reopen, still quiet until 7pm');
  assert.equal(inScanQuietWindow(ny(2026, 9, 16, 19, 0)), false, '7:00pm scanning resumes');
});
test('quiet all weekend: Friday 4:15pm → Sunday 7pm NY', () => {
  assert.equal(inScanQuietWindow(ny(2026, 9, 18, 16, 20)), true);
  assert.equal(inScanQuietWindow(ny(2026, 9, 19, 12, 0)), true);
  assert.equal(inScanQuietWindow(ny(2026, 9, 20, 18, 30)), true);
  assert.equal(inScanQuietWindow(ny(2026, 9, 20, 19, 5)), false);
});
test('every GENX scanner respects the quiet window', () => {
  assert.ok(/inScanQuietWindow\(\)\) \{ modeOut\.skip/.test(readFileSync('src/app/api/cron/genx-scan/route.ts', 'utf8')));
  assert.ok(/inScanQuietWindow\(\)\) return json/.test(readFileSync('src/app/api/cron/genx-scan/route.ts', 'utf8')));
  assert.ok(/inScanQuietWindow\(\)\) \{ await sleep/.test(readFileSync('worker/index.ts', 'utf8')));
  assert.ok(/inScanQuietWindow\(new Date\(now\)\)/.test(readFileSync('src/lib/genx/pdTick.ts', 'utf8')));
});
