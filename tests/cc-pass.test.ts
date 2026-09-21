import test from 'node:test';
import assert from 'node:assert/strict';
import { CC_PASS_MS, CC_PASS_COST } from '../src/lib/ccPass';

test('Command Center pass: 5 credits for 30 minutes', () => {
  assert.equal(CC_PASS_COST, 5);
  assert.equal(CC_PASS_MS, 30 * 60_000);
});
