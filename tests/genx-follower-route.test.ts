import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { goldRoute } from '../src/lib/flow/autoExec';

/**
 * FOLLOWER-ONLY ACCOUNTS NEVER TRADED (found 09-30 on the billing-deploy check). The follower fan-out
 * logged "fanout 0 follower accts → 0 eligible" on all 138 fires since the breadcrumb went in, while
 * 86 accounts (19 live) had "follow every GENX signal" on and autotrade off. The loader filtered on
 * genx_follower but never selected it, so goldRoute() read undefined and routed every one to "none".
 */
test('goldRoute needs the genx_follower field: without it a follower-only row routes nowhere', () => {
  assert.equal(goldRoute({ autotrade_enabled: false, genx_follower: true }), 'follower');
  assert.equal(goldRoute({ autotrade_enabled: false }), 'none', 'this is what an unselected column produced');
  assert.equal(goldRoute({ autotrade_enabled: true, genx_follower: true }), 'copy', 'autotrade accounts stay on the copy path');
});

test('the follower loader selects genx_follower on both its queries', () => {
  const src = readFileSync('src/lib/flow/autoExec.ts', 'utf8');
  const f = src.slice(src.indexOf('export async function placeGenxFollower'));
  const selects = [...f.slice(0, f.indexOf('ONE PATH PER ACCOUNT')).matchAll(/\.select\("([^"]+)"\)\.eq\("genx_follower", true\)/g)].map((m) => m[1]);
  assert.equal(selects.length, 2, 'primary and fallback loader');
  for (const cols of selects) assert.ok(/\bgenx_follower\b/.test(cols) && /\bautotrade_enabled\b/.test(cols), cols);
});
