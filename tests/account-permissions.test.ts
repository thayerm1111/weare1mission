import test from 'node:test';
import assert from 'node:assert/strict';
import { can, resolveAll, sanitisePermissions, isKilled, PERMISSION_KEYS, PERMISSION_DEFAULTS } from '../src/lib/flow/permissions';

const NOW = Date.UTC(2026, 8, 18, 20, 0, 0);
const acct = (over: Record<string, unknown> = {}) => ({ account_id: '1', autotrade_enabled: true, manage_trades: true, permissions: {}, kill_switch_at: null, ...over });

test('a new account trades nothing until the member says so, but is protectable', () => {
  const a = acct({ autotrade_enabled: false });
  assert.equal(can(a, 'allow_entries', NOW).allowed, false);
  assert.equal(can(a, 'allow_close', NOW).allowed, true, 'an open position can still be closed');
  assert.equal(can(a, 'allow_break_even', NOW).allowed, true, 'and still protected');
});

test('exposure-adding actions are opt-in; protection is opt-out', () => {
  assert.equal(PERMISSION_DEFAULTS.allow_entries, false);
  assert.equal(PERMISSION_DEFAULTS.allow_pending, false);
  assert.equal(PERMISSION_DEFAULTS.allow_scale_in, false);
  assert.equal(PERMISSION_DEFAULTS.allow_close, true);
  assert.equal(PERMISSION_DEFAULTS.allow_stop_move, true);
});

test('the kill switch stops new trades and NEVER stops defending open ones', () => {
  const k = acct({ kill_switch_at: new Date(NOW - 60_000).toISOString(), permissions: { allow_entries: true } });
  assert.equal(can(k, 'allow_entries', NOW).allowed, false);
  assert.equal(can(k, 'allow_pending', NOW).allowed, false);
  assert.equal(can(k, 'allow_scale_in', NOW).allowed, false);
  for (const key of ['allow_close', 'allow_partial', 'allow_stop_move', 'allow_break_even', 'allow_choch_exit'] as const) {
    assert.equal(can(k, key, NOW).allowed, true, `${key} must survive the kill switch`);
  }
  assert.equal(isKilled(k, NOW), true);
});

test('a kill switch stamped in the future is not yet active', () => {
  const k = acct({ kill_switch_at: new Date(NOW + 3600_000).toISOString(), permissions: { allow_entries: true } });
  assert.equal(can(k, 'allow_entries', NOW).allowed, true);
  assert.equal(isKilled(k, NOW), false);
});

test('an explicit switch beats the default, in both directions', () => {
  assert.equal(can(acct({ permissions: { allow_entries: true } }), 'allow_entries', NOW).allowed, true);
  assert.equal(can(acct({ permissions: { allow_break_even: false } }), 'allow_break_even', NOW).allowed, false);
});

test('the legacy management master switch still turns management off wholesale', () => {
  const a = acct({ manage_trades: false, permissions: { allow_close: true } });
  assert.equal(can(a, 'allow_close', NOW).allowed, false);
  assert.equal(can(a, 'allow_entries', NOW).allowed, false, 'entries still need their own permission');
});

test('every refusal explains itself to the member', () => {
  const v = can(acct({ permissions: { allow_partial: false } }), 'allow_partial', NOW);
  assert.equal(v.allowed, false);
  assert.match(v.reason, /partial/i);
  assert.ok(can(acct({ kill_switch_at: new Date(NOW).toISOString() }), 'allow_entries', NOW).reason.includes('still protected'));
});

test('a missing account is refused everything', () => {
  for (const k of PERMISSION_KEYS) assert.equal(can(null, k, NOW).allowed, false);
});

test('client input is sanitised to known boolean keys only', () => {
  const clean = sanitisePermissions({ allow_entries: true, allow_close: 'yes', nonsense: true, __proto__: { x: 1 } });
  assert.deepEqual(clean, { allow_entries: true });
  assert.deepEqual(sanitisePermissions('nope'), {});
});

test('resolveAll answers for every key', () => {
  const all = resolveAll(acct({ permissions: { allow_entries: true } }), NOW);
  assert.equal(Object.keys(all).length, PERMISSION_KEYS.length);
  assert.equal(all.allow_entries, true);
});
