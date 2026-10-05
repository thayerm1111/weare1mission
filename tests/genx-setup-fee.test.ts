import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { feeKeyFrom, stillLive, isHead, setupFeeKey, isScannerKey, FEE_RECALL_MS, FEE_LOOKBACK_MS, FEE_READ_WAIT_MS, type FeeAlert } from '../src/lib/genx/setupFee';
import { fakeDb, type Row } from './_genfx_fakedb';

/*
 * ONE IDEA, ONE SETUP FEE (10-05). Gold billed a setup fee per zone KEY, and the zone drifts a dollar
 * every scan — so one idea was billed over and over while it was still on the desk: 5,006 of the 10,995
 * setup credits charged since 09-18. The setups below are real ones, with their real times. The fee
 * now follows the idea, measured from its first reading; what is recorded, announced, entered and traded
 * is not touched by any of it.
 */
const at = (sec: number) => new Date(sec * 1000).toISOString();
const row = (key: string, lo: number, hi: number, state: string, outcome: string | null, created: number, updated: number | null = null, fee: string | null = null): FeeAlert =>
  ({ dedupe_key: key, fee_key: fee, side: key.split(':')[1] as 'buy' | 'sell', entry_low: lo, entry_high: hi, state, outcome, created_at: at(created), updated_at: updated == null ? null : at(updated) });
const zone = (r: FeeAlert) => ({ side: r.side, entry_low: r.entry_low, entry_high: r.entry_high });
/**
 * The scanner, as it records a run of setups one after another: each is asked about with the earlier
 * ones on the desk AS THEY STOOD THEN (`then` says how), and is stored with the key it was billed under.
 */
function recorded(seq: FeeAlert[], then: (earlier: FeeAlert, nowSec: number) => FeeAlert = (e) => e, history: FeeAlert[] = []): string[] {
  const desk: FeeAlert[] = [...history], out: string[] = [];
  for (const r of seq) {
    const now = Date.parse(r.created_at);
    const key = feeKeyFrom(desk.map((e) => then(e, now / 1000)), zone(r), r.dedupe_key, now);
    out.push(key); desk.push({ ...r, fee_key: key });
  }
  return out;
}

// Monday 10-05, 06:20–06:41 UTC: one intraday buy, recorded eight times, every one entered and still open.
const MORNING = [
  row('intraday:buy:4146:4147', 4145.91, 4147.19, 'entered', null, 1791181205),
  row('intraday:buy:4148:4149', 4147.63, 4148.91, 'entered', null, 1791181505),
  row('intraday:buy:4149:4150', 4148.84, 4150.12, 'entered', null, 1791181806),
  row('intraday:buy:4148:4150', 4148.49, 4149.77, 'entered', null, 1791181845),
  row('intraday:buy:4145:4147', 4145.22, 4146.5, 'entered', null, 1791182105),
  row('intraday:buy:4145:4146', 4144.87, 4146.15, 'entered', null, 1791182145),
  row('intraday:buy:4144:4146', 4144.35, 4145.63, 'entered', null, 1791182407),
  row('intraday:buy:4143:4145', 4143.48, 4144.76, 'entered', null, 1791182437),
];
// The same morning, 03:35 UTC: the same intraday buy twice, 43 seconds apart. Both graded a loss at 04:30.
const PAIR = [
  row('intraday:buy:4140:4141', 4140.45, 4141.31, 'entered', 'loss', 1791171304, 1791174601),
  row('intraday:buy:4141:4142', 4141.14, 4142, 'entered', 'loss', 1791171347, 1791174601),
];

test('what is on the desk: pending, or entered and not graded, or let go within the half hour', () => {
  const now = 1791000000_000, min = 60_000;
  assert.equal(FEE_RECALL_MS, 30 * min);
  assert.equal(stillLive(row('quick:buy:1:2', 1, 2, 'forming', null, 1), now), true, 'pending, however long ago it was recorded');
  assert.equal(stillLive(row('quick:buy:1:2', 1, 2, 'entered', null, 1), now), true);
  for (const o of ['win', 'loss', 'expired']) assert.equal(stillLive(row('quick:buy:1:2', 1, 2, 'entered', o, 1, now / 1000 - 1), now), false, `a graded call is finished at once (${o})`);
  for (const s of ['invalidated', 'expired']) {
    assert.equal(stillLive(row('quick:buy:1:2', 1, 2, s, null, 1, (now - 30 * min) / 1000), now), true, `${s} thirty minutes ago`);
    assert.equal(stillLive(row('quick:buy:1:2', 1, 2, s, null, 1, (now - 30 * min - 1000) / 1000), now), false, `${s} a second longer ago`);
  }
  // Let go with no time on record: counted from when it was recorded. No time at all, or a state this file does not know: not on the desk.
  assert.equal(stillLive(row('quick:buy:1:2', 1, 2, 'invalidated', null, (now - 10 * min) / 1000), now), true);
  assert.equal(stillLive({ ...row('quick:buy:1:2', 1, 2, 'invalidated', null, 1), created_at: 'not a time' }, now), false);
  for (const s of ['replaced', 'zone', 'meta', '']) assert.equal(stillLive(row('quick:buy:1:2', 1, 2, s, null, 1, now / 1000), now), false, s);
  // The first reading of an idea carries its own key; a row from before the column was billed under its own key too.
  assert.equal(isHead(row('quick:buy:1:2', 1, 2, 'forming', null, 1)), true);
  assert.equal(isHead(row('quick:buy:1:2', 1, 2, 'forming', null, 1, null, 'quick:buy:1:2')), true);
  assert.equal(isHead(row('quick:buy:1:2', 1, 2, 'forming', null, 1, null, 'quick:buy:0:1')), false);
});

test('the intraday buy recorded eight times in twenty-one minutes is one idea: one fee key', () => {
  assert.deepEqual(recorded(MORNING), Array(8).fill('intraday:buy:4146:4147'));
  // …with the first one still PENDING rather than entered, the same.
  assert.deepEqual(recorded(MORNING.map((r) => ({ ...r, state: 'forming' }))), Array(8).fill('intraday:buy:4146:4147'));
  // …and with rows written before this change (no fee key on them) already on the desk: the latest of those is taken as the first reading.
  assert.equal(feeKeyFrom(MORNING.slice(0, 5), zone(MORNING[5]), MORNING[5].dedupe_key, Date.parse(MORNING[5].created_at)), 'intraday:buy:4145:4147');
});

test('the pair 43 seconds apart is one idea — and once the first has been graded, the same zone forming again is a new one', () => {
  const open = PAIR.map((r) => ({ ...r, outcome: null, updated_at: null }));
  assert.deepEqual(recorded(open), ['intraday:buy:4140:4141', 'intraday:buy:4140:4141']);
  // 06:20: both graded at 04:30. The morning's buy sits $5.70 above — the same zone by the $6 rule — and is NOT that idea.
  assert.deepEqual(recorded(MORNING, (e) => e, [{ ...PAIR[0], fee_key: PAIR[0].dedupe_key }, { ...PAIR[1], fee_key: PAIR[0].dedupe_key }]), Array(8).fill('intraday:buy:4146:4147'));
  // The idea ends with its FIRST reading. Graded at 04:30:01 — and a re-reading of it (the second of the pair)
  // is still open: the same zone read again at 04:31 is a new idea all the same.
  const head = { ...PAIR[0], fee_key: PAIR[0].dedupe_key };
  const rereading = { ...PAIR[1], outcome: null, updated_at: null, fee_key: PAIR[0].dedupe_key };
  assert.equal(feeKeyFrom([head, rereading], zone(PAIR[0]), 'intraday:buy:4141:4141', 1791174661_000), 'intraday:buy:4141:4141');
  // …whereas a minute before the first was graded it was still that idea.
  assert.equal(feeKeyFrom([{ ...head, outcome: null }, rereading], zone(PAIR[0]), 'intraday:buy:4141:4141', 1791174541_000), 'intraday:buy:4140:4141');
});

test('a setup let go and read again within half an hour is the same idea; after that it is a new one', () => {
  // The 05:05 swing sell, ended a second after it was recorded, and read again a dollar or two away every scan.
  const first = row('swing:sell:4134:4135', 4133.99, 4134.56, 'invalidated', null, 1791176705, 1791176706);
  const again = { side: 'sell' as const, entry_low: 4134.1, entry_high: 4134.7 };
  const letGo = 1791176706_000;
  assert.equal(feeKeyFrom([first], again, 'swing:sell:4134:4136', letGo + FEE_RECALL_MS), 'swing:sell:4134:4135');
  assert.equal(feeKeyFrom([first], again, 'swing:sell:4134:4136', letGo + FEE_RECALL_MS + 1000), 'swing:sell:4134:4136');
  // The half hour runs from when the FIRST reading was let go. Re-readings in between do not extend it: thirteen
  // readings in fifty minutes (as that morning) are three ideas — not thirteen, and not one.
  const SWING: [string, number, number, number][] = [
    ['swing:sell:4134:4135', 4133.99, 4134.56, 1791176705], ['swing:sell:4134:4134', 4133.82, 4134.39, 1791176737], ['swing:sell:4138:4139', 4138.26, 4138.83, 1791177005],
    ['swing:sell:4139:4139', 4138.78, 4139.35, 1791177037], ['swing:sell:4140:4141', 4140.32, 4140.89, 1791177306], ['swing:sell:4141:4141', 4140.66, 4141.23, 1791177607],
    ['swing:sell:4141:4142', 4141, 4141.57, 1791177637], ['swing:sell:4139:4140', 4139.46, 4140.03, 1791178208], ['swing:sell:4140:4140', 4139.63, 4140.2, 1791178237],
    ['swing:sell:4137:4137', 4136.55, 4137.12, 1791178506], ['swing:sell:4142:4142', 4141.86, 4142.43, 1791179406], ['swing:sell:4137:4138', 4137.07, 4137.64, 1791179707], ['swing:sell:4136:4137', 4136.21, 4136.78, 1791179737],
  ];
  const fees = recorded(SWING.map(([k, lo, hi, c]) => row(k, lo, hi, 'invalidated', null, c, c + 1)));
  // 05:05: the first. 05:15: $6.33 from it — a different zone, its own idea, and the more recent one for what follows.
  // 05:50: both were let go more than half an hour ago — a third.
  assert.deepEqual([...new Set(fees)], ['swing:sell:4134:4135', 'swing:sell:4140:4141', 'swing:sell:4142:4142']);
  assert.equal(fees.filter((k, i) => k === SWING[i][0]).length, 3, 'three first readings, ten re-readings');
});

test('measured from the first reading: a zone that creeps away becomes a new idea, and a re-reading cannot carry the fee', () => {
  const A = row('intraday:sell:4300:4302', 4300, 4302, 'entered', null, 1000);
  const B = row('intraday:sell:4304:4306', 4304, 4306, 'entered', null, 1300);   // $4 from A
  const C = row('intraday:sell:4309:4311', 4309, 4311, 'entered', null, 1600);   // $5 from B — but $9 from A
  assert.deepEqual(recorded([A, B, C]), [A.dedupe_key, A.dedupe_key, C.dedupe_key]);
  // $5 further every twenty minutes for four hours, each call graded after forty-five (the reviewer's case): no
  // reading is ever billed under a key more than $6 from its own zone, and the last is not free on the first's key.
  const creep = Array.from({ length: 12 }, (_, i) => row(`intraday:buy:${4100 + 5 * i}:${4101 + 5 * i}`, 4100 + 5 * i, 4101 + 5 * i, 'entered', 'win', 10_000 + 1200 * i, 10_000 + 1200 * i + 2700));
  const then = (e: FeeAlert, now: number): FeeAlert => (now < Date.parse(e.updated_at as string) / 1000 ? { ...e, outcome: null } : e);
  const keys = recorded(creep, then);
  keys.forEach((k, i) => assert.ok(Math.abs(Number(k.split(':')[2]) - (4100 + 5 * i)) <= 6, `${creep[i].dedupe_key} billed under ${k}`));
  assert.notEqual(keys[11], keys[0]);
  assert.ok(new Set(keys).size >= 6, `a new idea at least every other reading (${new Set(keys).size} ideas)`);
});

test('only its own horizon and side, only scanner setups, and of two ideas within reach the more recent', () => {
  const A = row('intraday:sell:4300:4302', 4300, 4302, 'entered', null, 1000);
  const near = { side: 'sell' as const, entry_low: 4303, entry_high: 4305 };
  assert.equal(feeKeyFrom([A], near, 'intraday:sell:4303:4305', 1900_000), A.dedupe_key);
  assert.equal(feeKeyFrom([A], { ...near, side: 'buy' }, 'intraday:buy:4303:4305', 1900_000), 'intraday:buy:4303:4305', 'the other side');
  assert.equal(feeKeyFrom([A], near, 'swing:sell:4303:4305', 1900_000), 'swing:sell:4303:4305', 'another horizon is another call');
  assert.equal(feeKeyFrom([A], near, 'quick:sell:4303:4305', 1900_000), 'quick:sell:4303:4305');
  assert.equal(feeKeyFrom([A], { side: 'sell', entry_low: 4330, entry_high: 4332 }, 'intraday:sell:4330:4332', 1900_000), 'intraday:sell:4330:4332', '$29 away');
  // Rows other modules write are not setups.
  const fade = row('intraday:sell:rng:2026-09-22T15:45:00', 4303, 4304, 'entered', null, 1700);
  const brk = row('intraday:sell:brk:2026-09-22T15:45:00', 4303, 4304, 'entered', null, 1700);
  const page = row('zone:intraday:sell:4303.2', 4302.9, 4303.5, 'entered', null, 1700);
  const pd = row('pd:sell:4303', 4303, 4304, 'entered', null, 1700);
  for (const r of [fade, brk, page, pd]) assert.equal(isScannerKey(r.dedupe_key), false, r.dedupe_key);
  assert.ok(['quick:buy:4145:4145', 'intraday:sell:4363:4365', 'swing:sell:4134:4135'].every(isScannerKey));
  assert.equal(feeKeyFrom([fade, brk, page, pd], near, 'intraday:sell:4303:4305', 1900_000), 'intraday:sell:4303:4305');
  // 09-30, real rows: a buy at 4184–4187, then one at 4192 ($6.17 from the nearest reading and $8.46 from the first:
  // its own idea), then 4188 — within $6 of both first readings, both open. It is billed as the more recent idea.
  const first = row('intraday:buy:4183:4185', 4183.36, 4185.19, 'entered', null, 1790751612);
  const other = row('intraday:buy:4192:4194', 4191.8, 4193.67, 'entered', null, 1790753106);
  const mid = { side: 'buy' as const, entry_low: 4187.74, entry_high: 4189.61 };
  assert.equal(feeKeyFrom([first, other], mid, 'intraday:buy:4188:4190', 1790754006_000), 'intraday:buy:4192:4194');
  assert.equal(feeKeyFrom([other, first], mid, 'intraday:buy:4188:4190', 1790754006_000), 'intraday:buy:4192:4194', 'whatever order they are handed in');
  assert.equal(feeKeyFrom([first, { ...other, outcome: 'loss' }], mid, 'intraday:buy:4188:4190', 1790754006_000), 'intraday:buy:4183:4185');
});

test('reading the desk: what is open and what was just let go, for this horizon and side — and a desk that cannot be read bills as before', async () => {
  const NOW = 1791182500_000;
  type Admin = Parameters<typeof setupFeeKey>[0];
  const db = (rows: Row[], opts = {}) => fakeDb({ genx_alerts: rows }, opts) as unknown as Admin;
  const stored = (r: FeeAlert, fee: string | null = null): Row => ({ ...r, fee_key: fee, mode: r.dedupe_key.startsWith('zone:') ? r.dedupe_key.split(':')[1] : r.dedupe_key.split(':')[0] });
  const desk = [...MORNING.map((r, i) => stored(r, i === 0 ? r.dedupe_key : MORNING[0].dedupe_key)), ...PAIR.map((r) => stored(r, PAIR[0].dedupe_key))];
  const z = { side: 'buy' as const, entry_low: 4143.1, entry_high: 4144.4 };   // a ninth reading of the morning's buy
  assert.deepEqual(await setupFeeKey(db(desk), 'intraday', z, 'intraday:buy:4143:4144', NOW), { key: 'intraday:buy:4146:4147', read: true });
  // The same zone on another horizon, or the other side, has nothing on the desk: its own key.
  assert.deepEqual(await setupFeeKey(db(desk), 'quick', z, 'quick:buy:4143:4144', NOW), { key: 'quick:buy:4143:4144', read: true });
  assert.deepEqual(await setupFeeKey(db(desk), 'intraday', { ...z, side: 'sell' }, 'intraday:sell:4143:4144', NOW), { key: 'intraday:sell:4143:4144', read: true });
  // A first reading let go 29 minutes ago is found; 31 minutes ago it is not read at all.
  const gone = (minAgo: number) => [stored(row('swing:sell:4134:4135', 4133.99, 4134.56, 'invalidated', null, NOW / 1000 - 3600, NOW / 1000 - minAgo * 60))];
  const sz = { side: 'sell' as const, entry_low: 4134.1, entry_high: 4134.7 };
  assert.deepEqual(await setupFeeKey(db(gone(29)), 'swing', sz, 'swing:sell:4134:4136', NOW), { key: 'swing:sell:4134:4135', read: true });
  assert.deepEqual(await setupFeeKey(db(gone(31)), 'swing', sz, 'swing:sell:4134:4136', NOW), { key: 'swing:sell:4134:4136', read: true });
  // A page setup at the same zone is not a scanner setup, though it is open and on this horizon.
  const page = stored({ ...row('zone:intraday:buy:4143.5', 4143.2, 4143.8, 'entered', null, NOW / 1000 - 60) });
  assert.deepEqual(await setupFeeKey(db([page]), 'intraday', z, 'intraday:buy:4143:4144', NOW), { key: 'intraday:buy:4143:4144', read: true });
  // What is asked of the table, exactly.
  const asked: unknown[][] = [];
  const q = (): Record<string, unknown> => {
    const o: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'like', 'in', 'is', 'gte', 'order', 'limit']) o[m] = (...args: unknown[]) => { asked.push([m, ...args]); return o; };
    o.then = (ok: (v: { data: unknown[]; error: null }) => unknown) => ok({ data: [], error: null });
    return o;
  };
  await setupFeeKey({ from: (t: string) => { asked.push(['from', t]); return q(); } } as unknown as Admin, 'swing', sz, 'swing:sell:4134:4136', NOW);
  assert.equal(FEE_LOOKBACK_MS, 3 * 86_400_000);
  assert.deepEqual(asked.filter((c) => c[0] !== 'select'), [
    ['from', 'genx_alerts'], ['eq', 'mode', 'swing'], ['eq', 'side', 'sell'], ['like', 'dedupe_key', 'swing:%'], ['in', 'state', ['forming', 'entered']], ['is', 'outcome', null],
    ['gte', 'created_at', new Date(NOW - FEE_LOOKBACK_MS).toISOString()], ['order', 'created_at', { ascending: false }], ['limit', 400],
    ['from', 'genx_alerts'], ['eq', 'mode', 'swing'], ['eq', 'side', 'sell'], ['like', 'dedupe_key', 'swing:%'], ['in', 'state', ['invalidated', 'expired']],
    ['gte', 'updated_at', new Date(NOW - FEE_RECALL_MS).toISOString()], ['order', 'updated_at', { ascending: false }], ['limit', 400],
  ]);
  assert.ok(asked.filter((c) => c[0] === 'select').every((c) => String(c[1]).includes('fee_key')));
  // The table cannot be read, throws, or does not answer: the setup's own key — exactly what was billed before — and it says so.
  const own = { key: 'intraday:buy:4143:4144', read: false };
  assert.deepEqual(await setupFeeKey(db(desk, { fail: (op: { table: string }) => op.table === 'genx_alerts' }), 'intraday', z, own.key, NOW), own);
  assert.deepEqual(await setupFeeKey({ from() { throw new Error('no connection'); } } as unknown as Admin, 'intraday', z, own.key, NOW), own);
  // Either of the two lists unreadable is the desk unreadable: half an answer is not one.
  for (const failing of [1, 2]) {
    let n = 0;
    assert.deepEqual(await setupFeeKey(db(desk, { fail: () => ++n === failing }), 'intraday', z, own.key, NOW), own, `read #${failing} fails`);
  }
  const hung = (): Record<string, unknown> => { const o: Record<string, unknown> = {}; for (const m of ['select', 'eq', 'like', 'in', 'is', 'gte', 'order', 'limit']) o[m] = () => o; o.then = () => {}; return o; };
  assert.equal(FEE_READ_WAIT_MS, 5_000);
  const t0 = Date.now();
  assert.deepEqual(await setupFeeKey({ from: () => hung() } as unknown as Admin, 'intraday', z, own.key, NOW, 30), own);
  assert.ok(Date.now() - t0 < 1_000, 'it stopped waiting');
});

test('the scanner bills the idea and stores the key; nothing else about a setup moved', () => {
  const scan = readFileSync('src/app/api/cron/genx-scan/route.ts', 'utf8');
  const ask = 'const fee = await setupFeeKey(admin, mode, { side, entry_low: genx.entry_low, entry_high: genx.entry_high }, dedupeKey);';
  const record = 'let { error: insErr } = await admin.from("genx_alerts").insert({ ...forming, fee_key: fee.key });';
  const fallback = 'if (insErr && /fee_key/.test(String((insErr as { message?: unknown }).message ?? ""))) ({ error: insErr } = await admin.from("genx_alerts").insert(forming));';
  const bill = 'await billSetupForming(admin, fee.key, mode)';
  const idx = [ask, record, fallback, bill].map((t) => scan.indexOf(t));
  idx.forEach((i, n) => assert.ok(i > 0, `found in the scanner: #${n + 1}`));
  assert.ok(idx[0] < idx[1] && idx[1] < idx[2] && idx[2] < idx[3], 'asked before the setup is on record; recorded; billed');
  for (const t of [ask, record, fallback, bill]) assert.equal(scan.split(t).length - 1, 1);
  assert.equal((scan.match(/billSetupForming\(/g) ?? []).length, 1, 'one place bills a forming setup');
  // The row is recorded under its OWN key, as ever: only the fee looks elsewhere.
  assert.ok(/const forming = \{\s*dedupe_key: dedupeKey, mode, side, action: genx\.action,/.test(scan));
  // Both ways a recording can fail still end the same way, and the trade-ready branch is not touched.
  assert.equal((scan.match(/if \(insErr\) \{ modeOut\.result = "already_recorded"; continue; \}/g) ?? []).length, 2);
  // The meter is the one it was: one charge per member per key.
  const fb = readFileSync('src/lib/flow/flowBilling.ts', 'utf8');
  assert.ok(/const c = await billEvent\(admin, uid, setupKey, "setup", wasPaused\);/.test(fb));
  const fee = readFileSync('src/lib/genx/setupFee.ts', 'utf8');
  assert.ok(!/\.(insert|update|delete|upsert|rpc)\(/.test(fee), 'the fee-key reader writes nothing');
  // The column: additive, nullable, nothing else.
  const sql = readFileSync('supabase/migrations/20261005070000_genx_alerts_fee_key.sql', 'utf8').split('\n').filter((l) => !l.startsWith('--') && l.trim()).join('\n');
  assert.ok(/^set local lock_timeout = '5s';\nalter table public\.genx_alerts add column if not exists fee_key text;\ncomment on column public\.genx_alerts\.fee_key is '[^\n]*';$/.test(sql), sql);
});
