import test from 'node:test';
import assert from 'node:assert/strict';
import { foldBilling, PACK_LABELS } from '../src/lib/adminBilling';

/**
 * WHO BOUGHT WHAT (owner 09-29: "see what users have purchased what and whos on the subscription").
 * The Approvals page folds the ledger, the subscription rows and the auto-refill settings into one
 * summary per member. These pin what counts as a purchase and what "on a subscription" means.
 */

const future = new Date(Date.now() + 10 * 86400000).toISOString();
const past = new Date(Date.now() - 10 * 86400000).toISOString();
const sub = (over: Partial<Parameters<typeof foldBilling>[1][number]>) => ({
  user_id: 'u1', plan: 'flow_pass', status: 'active', stripe_customer_id: null, stripe_subscription_id: null,
  current_period_end: future, cancel_at_period_end: false, canceled_at: null, ...over,
});

test('packs are counted per purchase and credits add up; the newest purchase is the last one', () => {
  const b = foldBilling([
    { user_id: 'u1', feature: 'pack_trader', amount: 200, created_at: '2026-09-20T00:00:00Z' },
    { user_id: 'u1', feature: 'pack_trader', amount: 200, created_at: '2026-09-28T00:00:00Z' },
    { user_id: 'u1', feature: 'pack_starter', amount: 50, created_at: '2026-09-25T00:00:00Z' },
    { user_id: 'u1', feature: 'autorefill', amount: 50, created_at: '2026-09-26T00:00:00Z' },
  ], [], []);
  assert.equal(b.u1.packs.trader, 2);
  assert.equal(b.u1.packs.starter, 1);
  assert.equal(b.u1.packs.autorefill, 1);
  assert.equal(b.u1.packs.pro, 0);
  assert.equal(b.u1.creditsBought, 500);
  assert.equal(b.u1.lastPurchaseAt, '2026-09-28T00:00:00Z');
});

test('grants are not purchases — an owner grant or a promo never shows as money in', () => {
  const b = foldBilling([
    { user_id: 'u1', feature: 'owner_grant', amount: 100, created_at: '2026-09-28T00:00:00Z' },
    { user_id: 'u1', feature: 'promo_rich', amount: 5, created_at: '2026-09-28T00:00:00Z' },
    { user_id: 'u1', feature: 'trial_welcome', amount: 5, created_at: '2026-09-28T00:00:00Z' },
  ], [], []);
  assert.equal(b.u1?.creditsBought ?? 0, 0);
  assert.equal(b.u1?.lastPurchaseAt ?? null, null);
});

test('an active FLOW Pass reads as active with its label; a lapsed one is still shown, as not active', () => {
  const b = foldBilling([], [sub({}), sub({ user_id: 'u2', plan: 'trading_suite', status: 'canceled', current_period_end: past })], []);
  assert.equal(b.u1.sub?.active, true);
  assert.equal(b.u1.sub?.label, 'FLOW Pass');
  assert.equal(b.u2.sub?.active, false);
  assert.equal(b.u2.sub?.label, 'Trading Suite');
  assert.equal(b.u2.sub?.status, 'canceled');
});

test('a subscription past its period end is not active even if Stripe still says active', () => {
  const b = foldBilling([], [sub({ current_period_end: past })], []);
  assert.equal(b.u1.sub?.active, false);
});

test('auto-refill shows only when it is switched on', () => {
  const b = foldBilling([], [], [
    { user_id: 'u1', enabled: true, refill_credits: 200, card_last4: '4242' },
    { user_id: 'u2', enabled: false, refill_credits: 50, card_last4: null },
  ]);
  assert.equal(b.u1.autoRefill?.enabled, true);
  assert.equal(b.u1.autoRefill?.credits, 200);
  assert.equal(b.u2.autoRefill?.enabled, false);
});

test('pack labels carry the credit size so the card reads "Trader (200)"', () => {
  assert.match(PACK_LABELS.trader, /Trader \(200\)/);
  assert.match(PACK_LABELS.starter, /Starter \(50\)/);
  assert.match(PACK_LABELS.pro, /Pro \(500\)/);
});
