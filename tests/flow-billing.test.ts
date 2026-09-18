import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { billingDue, billingOpen, isManualSource, FLOW_ACCOUNT_WINDOW_MS, FLOW_ACCOUNT_COST } from '../src/lib/flow/flowBilling';

const T = Date.UTC(2026, 8, 16, 15, 0);   // Wed 11:00 NY
test('a member is billed 1 credit per 30-minute window', () => {
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
test('owner 09-18: every placement path charges the TRADE event; watching is free', () => {
  const ex = readFileSync('src/lib/flow/executor.ts', 'utf8');
  assert.ok(/billedAccountIdsForFire\(tlog, accts\.map/.test(ex), 'copy / FLOW placement bills the fire');
  const ae = readFileSync('src/lib/flow/autoExec.ts', 'utf8');
  const follower = ae.slice(ae.indexOf('export async function placeGenxFollower'));
  assert.ok(/billedAccountIdsForFire\(admin, \[String\(a\.account_id\)\], fireKey\)/.test(follower), 'follower accounts billed per fire');
  const meter = ae.slice(ae.indexOf('async function meterAutoRun'), ae.indexOf('const COOLDOWN_MIN'));
  assert.ok(!/hasActiveSuite\(/.test(meter), 'no free pass for Trading Suite');
  const worker = readFileSync('worker/index.ts', 'utf8');
  assert.ok(!/billFlowAccounts\(/.test(worker), 'the worker no longer bills by the clock');
  const scan = readFileSync('src/app/api/cron/genx-scan/route.ts', 'utf8');
  assert.ok(/billSetupForming\(admin, dedupeKey\)/.test(scan), 'a forming setup charges its one credit');
});

test('owner 09-18: the event charge is idempotent per member per event', () => {
  const sql = readFileSync('supabase/migrations/20260918180000_flow_event_billing.sql', 'utf8');
  assert.ok(/primary key \(user_id, event_key\)/.test(sql), 'one row per member per event');
  assert.ok(/pg_advisory_xact_lock/.test(sql), 'member+event lock');
  assert.ok(/'already'/.test(sql), 'a repeat charge returns already, never a second spend');
  const fb = readFileSync('src/lib/flow/flowBilling.ts', 'utf8');
  assert.ok(/SETUP_COST = 1/.test(fb) && /TRADE_COST = 5/.test(fb), '1 forming / 5 per trade');
});

test('owner 09-17: one credit per MEMBER per window, no matter how many accounts', () => {
  const fb = readFileSync('src/lib/flow/flowBilling.ts', 'utf8');
  assert.ok(/rpc\("flow_bill_member"/.test(fb), 'billing goes through the per-member function');
  assert.ok(!/p_feature: "flow_autorun"/.test(fb), 'no per-account spend call left in TypeScript');
  const sql = readFileSync('supabase/migrations/20260917140000_flow_bill_member.sql', 'utf8');
  assert.ok(/pg_advisory_xact_lock/.test(sql) && /where user_id = p_user/.test(sql), 'member lock + all the member accounts updated together');
});
