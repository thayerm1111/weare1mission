import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findSameSetup, retiredBy, isScannerKey, SAME_SETUP_WINDOW_MS, SAME_SETUP_OPEN_MS } from '../src/lib/genx/watchTick';
import { fakeDb, type Row } from './_genfx_fakedb';

/*
 * THE SAME-SETUP RULE ON INTRADAY AND SWING (10-05). The rule of 09-16 — a drifted zone is the setup
 * already open, not a new one — looked only at Quick rows. From 09-18 to 10-05, 122 of 156 Intraday
 * setups and 93 of 107 Swing setups were a re-reading of one still open. These hold the extension to:
 * an Intraday or Swing setup is also checked against its OWN horizon while the earlier one is open,
 * and nothing about Quick moved.
 */
type Admin = Parameters<typeof findSameSetup>[0];
const NOW = Date.now();
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
let n = 0;
const alert = (key: string, lo: number, hi: number, o: Row = {}): Row =>
  ({ id: `a${++n}`, dedupe_key: key, mode: key.startsWith('zone:') ? key.split(':')[1] : key.split(':')[0], side: key.includes(':sell:') ? 'sell' : 'buy', entry_low: lo, entry_high: hi, state: 'entered', outcome: null, created_at: ago(10), ...o });
const A = (rows: Row[]) => fakeDb({ genx_alerts: rows }) as unknown as Admin;
const z = (side: 'buy' | 'sell', lo: number, hi: number, mode?: 'quick' | 'intraday' | 'swing', created_at?: string) => ({ side, entry_low: lo, entry_high: hi, ...(mode ? { mode } : {}), ...(created_at ? { created_at } : {}) });
const key = async (rows: Row[], zone: ReturnType<typeof z>, excludeId?: string) => (await findSameSetup(A(rows), zone, excludeId))?.dedupe_key ?? null;

test('10-05: the intraday buy recorded eight times is the first one, seven times over', async () => {
  const first = alert('intraday:buy:4146:4147', 4145.91, 4147.19, { created_at: ago(21) });
  for (const [lo, hi] of [[4147.63, 4148.91], [4148.84, 4150.12], [4148.49, 4149.77], [4145.22, 4146.5], [4144.87, 4146.15], [4144.35, 4145.63], [4143.48, 4144.76]]) {
    assert.equal(await key([first], z('buy', lo, hi, 'intraday')), 'intraday:buy:4146:4147', `${lo}-${hi}`);
  }
  // Still pending rather than entered: the same.
  assert.equal(await key([{ ...first, state: 'forming' }], z('buy', 4147.63, 4148.91, 'intraday')), 'intraday:buy:4146:4147');
  // Swing against Swing likewise.
  assert.equal(await key([alert('swing:sell:4295:4300', 4295.14, 4299.54)], z('sell', 4293.31, 4297.71, 'swing')), 'swing:sell:4295:4300');
});

test('only its OWN horizon, only while the earlier one is open, only a real scanner setup', async () => {
  const intraday = alert('intraday:buy:4146:4147', 4145.91, 4147.19);
  const near = [4147.63, 4148.91] as const;
  // Another horizon's open setup at the same zone is another call.
  assert.equal(await key([intraday], z('buy', ...near, 'swing')), null);
  assert.equal(await key([alert('swing:buy:4146:4150', 4146, 4150)], z('buy', ...near, 'intraday')), null);
  // The other side; a zone $20 away.
  assert.equal(await key([intraday], z('sell', ...near, 'intraday')), null);
  assert.equal(await key([intraday], z('buy', 4167, 4168.3, 'intraday')), null);
  // Graded, invalidated or timed out: finished. The same zone forming again is a new setup, as with Quick.
  for (const done of [{ outcome: 'loss' }, { outcome: 'win' }, { outcome: 'expired' }, { state: 'invalidated' }, { state: 'expired' }]) {
    assert.equal(await key([{ ...intraday, ...done }], z('buy', ...near, 'intraday')), null, JSON.stringify(done));
  }
  // Rows other modules write on that horizon are not scanner setups.
  const fade = alert('intraday:buy:rng:2026-09-22T15:45:00', 4146, 4147);
  const page = alert('zone:intraday:buy:4146.5', 4146.2, 4146.8);
  assert.equal(isScannerKey(String(fade.dedupe_key)) || isScannerKey(String(page.dedupe_key)), false);
  assert.equal(await key([fade, page], z('buy', ...near, 'intraday')), null);
  // A row is never its own twin (the scan and the watch pass the row's id).
  assert.equal(await key([intraday], z('buy', 4145.91, 4147.19, 'intraday'), String(intraday.id)), null);
  // Open for as long as it is open: a Swing setup pending since yesterday is still that setup; one older than the look-back is not read.
  assert.equal(SAME_SETUP_OPEN_MS, 3 * 86_400_000);
  const pending = alert('swing:sell:4295:4300', 4295.14, 4299.54, { state: 'forming', created_at: ago(26 * 60) });
  assert.equal(await key([pending], z('sell', 4293.31, 4297.71, 'swing')), 'swing:sell:4295:4300');
  assert.equal(await key([{ ...pending, created_at: ago(73 * 60) }], z('sell', 4293.31, 4297.71, 'swing')), null);
  // Of several, the earliest open one is the setup (the later ones were its re-readings).
  const later = alert('intraday:buy:4148:4149', 4147.63, 4148.91, { created_at: ago(5) });
  assert.equal(await key([later, { ...intraday, created_at: ago(16) }], z('buy', 4148.84, 4150.12, 'intraday')), 'intraday:buy:4146:4147');
});

test('Quick is exactly as it was', async () => {
  const quick = alert('quick:sell:4274:4278', 4274.19, 4277.64);
  const drift = [4277.82, 4281.27] as const;
  // A Quick setup against an open Quick one — with the horizon said, and without (as callers passed it before).
  assert.equal(await key([quick], z('sell', ...drift, 'quick')), 'quick:sell:4274:4278');
  assert.equal(await key([quick], z('sell', ...drift)), 'quick:sell:4274:4278');
  // Still only for four hours.
  assert.equal(SAME_SETUP_WINDOW_MS, 4 * 3600_000);
  assert.equal(await key([{ ...quick, created_at: ago(241) }], z('sell', ...drift, 'quick')), null);
  // A Quick setup is checked against nothing new: an open Intraday or Swing setup at its zone does not stop it.
  const others = [alert('intraday:sell:4275:4278', 4275, 4278), alert('swing:sell:4274:4279', 4274, 4279)];
  assert.equal(await key(others, z('sell', ...drift, 'quick')), null);
  assert.equal(await key(others, z('sell', ...drift)), null);
  // An Intraday or Swing setup at an open Quick setup's zone is still that Quick setup, as before — and it is asked first.
  assert.equal(await key([quick], z('sell', ...drift, 'intraday')), 'quick:sell:4274:4278');
  assert.equal(await key([alert('intraday:sell:4275:4278', 4275, 4278, { created_at: ago(30) }), quick], z('sell', ...drift, 'intraday')), 'quick:sell:4274:4278');
});

test('a pending row is retired only by a setup recorded BEFORE it — and an armed Intraday or Swing row is left to run', async () => {
  const t = (min: number) => ago(min);
  const pending = (key: string, minAgo: number, armed = false) => ({ dedupe_key: key, created_at: t(minAgo), enter_sent_at: armed ? t(1) : null });
  // The first reading stays; the later one goes. Never the other way round.
  assert.equal(retiredBy(pending('intraday:buy:4148:4149', 5), { created_at: t(10) }), true);
  assert.equal(retiredBy(pending('intraday:buy:4148:4149', 10), { created_at: t(5) }), false, 'the twin is the later one: this row is the setup');
  assert.equal(retiredBy(pending('intraday:buy:4148:4149', 5), null), false);
  assert.equal(retiredBy(pending('intraday:buy:4148:4149', 5), { created_at: t(5) }), true, 'recorded in the same instant: one of the two goes (the caller passes the other as the twin)');
  // Armed: ENTER NOW is out and its five minutes are running. Intraday and Swing are left alone; Quick is retired as it always was.
  assert.equal(retiredBy(pending('intraday:buy:4148:4149', 5, true), { created_at: t(10) }), false);
  assert.equal(retiredBy(pending('swing:sell:4293:4298', 5, true), { created_at: t(10) }), false);
  assert.equal(retiredBy(pending('quick:sell:4278:4281', 5, true), { created_at: t(10) }), true);
  assert.equal(retiredBy(pending('quick:sell:4278:4281', 5), { created_at: t(10) }), true);
  // Asked about a ROW, only an earlier setup is its twin — so a newer Quick setup at its zone does not hide the
  // older Intraday one it is really a re-reading of.
  const older = alert('intraday:buy:4146:4147', 4145.91, 4147.19, { created_at: ago(16) });
  const newerQuick = alert('quick:buy:4147:4148', 4147.2, 4148.1, { created_at: ago(2) });
  const row = alert('intraday:buy:4148:4149', 4147.63, 4148.91, { created_at: ago(5), state: 'forming' });
  assert.equal(await key([older, newerQuick, row], z('buy', 4147.63, 4148.91, 'intraday', String(row.created_at)), String(row.id)), 'intraday:buy:4146:4147');
  // …and the FIRST reading, asked the same way, has no earlier twin: it is never the one retired.
  assert.equal(await key([older, newerQuick, row], z('buy', 4145.91, 4147.19, 'intraday', String(older.created_at)), String(older.id)), null);
  // A fresh read (no row yet) is checked against everything open, newer Quick setup included — as before.
  assert.equal(await key([older, newerQuick], z('buy', 4147.63, 4148.91, 'intraday')), 'quick:buy:4147:4148');
  // A Quick row is answered exactly as it always was: the first open Quick twin, older or not.
  const q1 = alert('quick:sell:4274:4278', 4274.19, 4277.64, { created_at: ago(3) });
  const q0 = alert('quick:sell:4277:4281', 4277.82, 4281.27, { created_at: ago(9), state: 'forming' });
  assert.equal(await key([q1, q0], z('sell', 4277.82, 4281.27, 'quick', String(q0.created_at)), String(q0.id)), 'quick:sell:4274:4278');
});

test('the scanner says which horizon it is asking about, and the watch merges a repeat on any horizon', () => {
  const scan = readFileSync('src/app/api/cron/genx-scan/route.ts', 'utf8');
  assert.ok(scan.includes('const twin = await findSameSetup(admin, { side, entry_low: genx.entry_low, entry_high: genx.entry_high, mode });'));
  assert.ok(scan.includes('if (twin) { modeOut.result = `same_setup:${twin.dedupe_key}:${twin.state}`; continue; }'), 'a repeat records, bills and posts nothing');
  assert.ok(scan.includes('const twin = await findSameSetup(admin, row, row.id);\n        if (twin && retiredBy(row, twin)) {'), 'a pending row is checked with its own horizon (the row carries it), and retired by the one rule');
  const watch = readFileSync('src/lib/genx/watchTick.ts', 'utf8');
  assert.ok(watch.includes('if (row.dedupe_key.startsWith("quick:") || isScannerKey(row.dedupe_key)) {\n        const twin = await findSameSetup(admin, row, row.id);\n        if (retiredBy(row, twin)) {'));
  // Retiring a row is silent and touches nothing else: state only, and only while it is still pending.
  assert.ok(watch.includes('if (retiredBy(row, twin)) {\n          await admin.from("genx_alerts").update({ state: "invalidated", last_checked_at: nowIso, updated_at: nowIso }).eq("id", row.id).eq("state", "forming");\n          sent.push(`${row.mode}:MERGED`);\n          continue;'));
  // The Quick query is the one it was, character for character.
  assert.ok(watch.includes('.like("dedupe_key", "quick:%").gte("created_at", since).order("created_at", { ascending: true }).limit(50);'));
});
