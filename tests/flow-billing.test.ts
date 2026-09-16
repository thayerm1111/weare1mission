import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { billingDue, billingOpen, isManualSource, FLOW_ACCOUNT_WINDOW_MS, FLOW_ACCOUNT_COST } from '../src/lib/flow/flowBilling';

const T = Date.UTC(2026, 8, 16, 15, 0);   // Wed 11:00 NY
test('an account is billed 1 credit per 30-minute window', () => {
  assert.equal(FLOW_ACCOUNT_COST, 1); assert.equal(FLOW_ACCOUNT_WINDOW_MS, 30 * 60000);
  assert.equal(billingDue({ flow_last_credit_at: null, flow_credit_paused: false }, T), true, 'never billed → due now');
  assert.equal(billingDue({ flow_last_credit_at: new Date(T - 10 * 60000).toISOString(), flow_credit_paused: false }, T), false, 'inside a paid window');
  assert.equal(billingDue({ flow_last_credit_at: new Date(T - 30 * 60000).toISOString(), flow_credit_paused: false }, T), true, 'window elapsed');
  assert.equal(billingDue({ flow_last_credit_at: new Date(T - 1 * 60000).toISOString(), flow_credit_paused: true }, T), true, 'paused account retries every pass');
});
test('billing only while gold is open (not weekends, the daily break, or the last 30 min before Friday close)', () => {
  assert.equal(billingOpen(T), true);
  assert.equal(billingOpen(Date.UTC(2026, 8, 19, 15, 0)), false, 'Saturday');
  assert.equal(billingOpen(Date.UTC(2026, 8, 16, 21, 15)), false, 'daily break 17:00–18:00 NY');
  assert.equal(billingOpen(Date.UTC(2026, 8, 18, 20, 40)), false, 'Friday 16:40 NY');
  assert.equal(billingOpen(Date.UTC(2026, 8, 18, 19, 0)), true, 'Friday 15:00 NY');
});
test('manual plays/tests are not FLOW automation', () => {
  assert.ok(isManualSource('play')); assert.ok(isManualSource('test_order')); assert.ok(!isManualSource('genx')); assert.ok(!isManualSource('genx-pd'));
});
test('every automated placement path enforces per-account billing; Suite subscribers are no longer free', () => {
  const ex = readFileSync('src/lib/flow/executor.ts', 'utf8');
  assert.ok(/billedAccountIds\(tlog, accts\.map/.test(ex), 'copy / FLOW placement bills each account');
  const ae = readFileSync('src/lib/flow/autoExec.ts', 'utf8');
  const follower = ae.slice(ae.indexOf('export async function placeGenxFollower'));
  assert.ok(/billedAccountIds\(admin, \[String\(a\.account_id\)\]\)/.test(follower), 'follower accounts billed');
  const meter = ae.slice(ae.indexOf('async function meterAutoRun'), ae.indexOf('const COOLDOWN_MIN'));
  assert.ok(!/hasActiveSuite\(/.test(meter), 'no free pass for Trading Suite');
  assert.ok(/billingLoop\(\)/.test(readFileSync('worker/index.ts', 'utf8')), 'worker bills while watching');
});
