import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pdEntryChecks } from '../src/lib/genx/pdTick';
import type { Cand32 } from '../src/lib/genx3/v32/engines';

const cand = (risk: number, hard: string[] = []): Cand32 => ({ setup: 'PDH_PDL_BREAK_RETEST_CONTINUATION', side: 'BUY', anchor: 'PD32:PDH:BUY:2026-09-16:c1', entry: 4320, invalidation: 4320 - risk + 0.5, stop: 4320 - risk, risk, targetR: 2, target: 4320 + 2 * risk, roomR: 0.5, feats: {}, evidence: ['x'], hard });
const ok = { atr15: 4, volExtreme: false, dataInvalid: false, blackout: false, latencyMs: 2000 };

test('GENX 1.0 PDH/PDL: a formed setup enters — no score threshold and no structural-room requirement', () => {
  assert.deepEqual(pdEntryChecks(cand(6), ok), []);            // roomR 0.5, no score involved
});
test('GENX 1.0 PDH/PDL: only data, blackout, spike, unusable-stop, erratic-tape and lateness stop an entry', () => {
  assert.ok(pdEntryChecks(cand(6), { ...ok, dataInvalid: true }).length);
  assert.ok(pdEntryChecks(cand(6), { ...ok, blackout: true }).length);
  assert.ok(pdEntryChecks(cand(6), { ...ok, volExtreme: true }).length);
  assert.ok(pdEntryChecks(cand(0.8), ok).some((x) => /noise/.test(x)));
  assert.ok(pdEntryChecks(cand(20), ok).some((x) => /sane structure/.test(x)));
  assert.ok(pdEntryChecks(cand(6, ['erratic: 9 5M closes crossed PDH in 3h']), ok).length);
  assert.ok(pdEntryChecks(cand(6), { ...ok, latencyMs: 60_000 }).length);
});
test('GENX 1.0 placement: two-loss, break-even-in-a-row and post-win pauses are gone; one-at-a-time and falling-knife guards stay', () => {
  const src = readFileSync('src/lib/flow/autoExec.ts', 'utf8');
  const hold = src.slice(src.indexOf('async function goldEntryHold'), src.indexOf('export function genxLimitPrice'));
  assert.ok(!/goldRealLossOnSide\(|goldRecentWinOnSide\(/.test(hold), 'no two-strike / post-win pause in the entry hold');
  assert.ok(/goldChangeOfCharacter\(\)/.test(hold), 'change-of-character (falling knife) guard kept');
  const place = src.slice(src.indexOf('export async function placeGenxGold'));
  assert.ok(!/goldBeSetupGate\(|goldRecentBeEntries\(|goldParticipantAccounts\(/.test(place), 'no break-even / premium holds in placement');
  assert.ok(/newsHold\("XAUUSD"\)/.test(place), 'news guard kept');
  assert.ok(/genxGoldStillOpen\(ledgerPids, brokerOpen\)/.test(place) && /reserveGold\(/.test(place), 'one open gold trade per account kept');
  assert.ok(/genx_follower_fills/.test(place), 'follower duplicate protection kept');
  const filt = src.slice(src.indexOf('async function filterAccountsForAsset'), src.indexOf('async function systemSwitches'));
  assert.ok(/asset === "gold"/.test(filt), 'gold no longer uses the 2-losses-in-a-row account cutoff');
});
test('falling-knife guards hold aggressive accounts too: change of character is desk-wide and applies to followers', () => {
  const src = readFileSync('src/lib/flow/autoExec.ts', 'utf8');
  const hold = src.slice(src.indexOf('async function goldEntryHold'), src.indexOf('export function genxLimitPrice'));
  const choch = hold.slice(hold.indexOf('const choch'));
  assert.ok(/scope: "desk"/.test(choch) && !/scope: "conservative"/.test(choch), 'change of character holds every account');
  const follower = src.slice(src.indexOf('export async function placeGenxFollower'));
  assert.ok(/newsHold\("XAUUSD"\)/.test(follower) && /goldEntryHold\(admin, sig\.side, entry\)/.test(follower), 'follower path has news + change-of-character guards');
});
