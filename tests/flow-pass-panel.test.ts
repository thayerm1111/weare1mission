import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isFlowPass } from '../src/lib/subscription';

/**
 * THE PASS, SAID ON THE PANEL (owner 10-01: a FLOW Pass member reported "bought the unlimited but
 * getting charged credits"). Billing already skipped him — 24 trades free since the Pass, balance
 * untouched — but the FLOW panel told every member "1 credit per setup, 5 per trade".
 */
const future = new Date(Date.now() + 20 * 86_400_000).toISOString();
const past = new Date(Date.now() - 86_400_000).toISOString();

test('an active, unexpired FLOW Pass is a Pass; a lapsed one or another plan is not', () => {
  const row = (over: Record<string, unknown>) => ({ user_id: 'u', plan: 'flow_pass', status: 'active', current_period_end: future, ...over }) as never;
  assert.equal(isFlowPass(row({})), true);
  assert.equal(isFlowPass(row({ current_period_end: past })), false);
  assert.equal(isFlowPass(row({ plan: 'trading_suite' })), false);
  assert.equal(isFlowPass(null), false);
});

test('the panel status carries the Pass, never shows a Pass holder as credit-paused or low on credits', () => {
  const route = readFileSync('src/app/api/flow/autorun/route.ts', 'utf8');
  assert.ok(/const pass = isFlowPass\(sub\)/.test(route));
  assert.ok(/paused: pass \? false : !!r\?\.credit_paused/.test(route));
  assert.ok(/lowCredits: !st\.pass && credits </.test(route));
  const panel = readFileSync('src/components/portal/floor/FlowConnect.tsx', 'utf8');
  const passAt = panel.indexOf('{auto?.pass ? (');
  const priceAt = panel.indexOf('<b>1 credit when a setup starts forming, 5 when a trade is actually placed</b>');
  assert.ok(passAt > 0 && priceAt > passAt, 'the per-credit pricing is the non-Pass branch');
  assert.ok(/FLOW Pass active/.test(panel));
});
