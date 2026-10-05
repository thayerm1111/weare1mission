import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bornDead, within, BORN_DEAD_WAIT_MS } from '../src/lib/genx/watchTick';

/*
 * BORN DEAD (10-05). Gold's scanner recorded, billed and announced a new setup without asking whether
 * its own confirmation already said INVALIDATED — the question the watch asks a second later, and ends
 * the setup on. Five hours into the week of 10-05, nine of the eleven setups members had paid for had
 * lived three seconds or less. The scanner now asks first. These hold it to: only a positive
 * INVALIDATED stops a setup, it is the watch's own question, and nothing else about a setup changes.
 */
type Confirm = NonNullable<Parameters<typeof bornDead>[1]>;
// The 05:05 UTC swing sell: zone 4133.99–4134.56, invalidation 4137.78.
const SWING_SELL = { side: 'sell' as const, entryLow: 4133.99, entryHigh: 4134.56, watch: 4134.56, invalidation: 4137.78, mode: 'swing' as const, mdKey: 'k' };
// The 00:05 UTC quick buy: zone 4148.6–4149.6, invalidation below it.
const QUICK_BUY = { side: 'buy' as const, entryLow: 4148.6, entryHigh: 4149.6, watch: 4148.6, invalidation: 4144.2, mode: 'quick' as const, mdKey: 'k' };
const says = (state: string, seen: unknown[] = []): Confirm =>
  (async (o: unknown) => { seen.push(o); return { state, detail: '', side: 'sell', price: 4140, enter: null, zoneLow: 0, zoneHigh: 0, invalidation: 0, interval: '1h' }; }) as unknown as Confirm;

test('a new setup whose confirmation already reads INVALIDATED is born dead — and only that', async () => {
  assert.equal(await bornDead(SWING_SELL, says('INVALIDATED')), true);
  for (const s of ['WAIT', 'AT_ZONE', 'CONFIRMED', 'BUSY', 'NO_DATA']) assert.equal(await bornDead(SWING_SELL, says(s)), false, s);
  // A confirmation that cannot be read is not a verdict: the setup is recorded as before and the watch decides.
  assert.equal(await bornDead(SWING_SELL, (async () => { throw new Error('feed down'); }) as unknown as Confirm), false);
  // Nor is one that does not answer: the question may not hold the recording up. (Even if the answer, when it
  // finally comes, would have been INVALIDATED.)
  assert.equal(BORN_DEAD_WAIT_MS, 8_000);
  const slow = (async () => { await new Promise((r) => setTimeout(r, 120)); return { state: 'INVALIDATED' }; }) as unknown as Confirm;
  const t0 = Date.now();
  assert.equal(await bornDead(SWING_SELL, slow, 20), false);
  assert.ok(Date.now() - t0 < 100, 'it stopped waiting');
  assert.equal(await bornDead(SWING_SELL, slow, 1_000), true, 'answered in time');
  assert.equal(await within(Promise.resolve(7), 50), 7);
  assert.equal(await within(new Promise(() => {}), 10), null);
});

test("it asks the watch's question with the watch's inputs: fresh candles on the horizon's own timeframe", async () => {
  const seen: unknown[] = [];
  await bornDead(SWING_SELL, says('WAIT', seen));
  assert.deepEqual(seen, [{ side: 'sell', entryLow: 4133.99, entryHigh: 4134.56, watch: 4134.56, invalidation: 4137.78, mode: 'swing', mdKey: 'k', fresh: true }]);
  // No `interval` override on either side, so the confirmation picks the horizon's own (5-minute, 15-minute, 1-hour).
  const watch = readFileSync('src/lib/genx/watchTick.ts', 'utf8');
  assert.ok(/mode: row\.mode, mdKey, fresh: true,\s*\}\);\s*const cOk/.test(watch), 'the watch passes the mode and fresh, and no interval');
  assert.ok(!/interval:/.test(watch.slice(watch.indexOf('export async function bornDead'), watch.indexOf('// ── THE WATCH LOCK'))), 'bornDead passes no interval either');
});

type K = { o: number; h: number; l: number; c: number };
/** The feed, caught at the network. `candles` are oldest → newest and the last one is still forming. */
function feed(candles: K[], live: number): { asked: string[]; close: () => void } {
  const real = globalThis.fetch, asked: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const u = String(input); asked.push(u);
    if (u.startsWith('https://api.twelvedata.com/time_series')) {
      const values = candles.map((k, i) => ({ datetime: `2026-10-05 ${String(i).padStart(2, '0')}:00:00`, open: String(k.o), high: String(k.h), low: String(k.l), close: String(k.c) })).reverse();
      return new Response(JSON.stringify({ values }), { status: 200 });
    }
    if (u.startsWith('https://api.twelvedata.com/price')) return new Response(JSON.stringify({ price: String(live) }), { status: 200 });
    throw new Error(`test: unexpected network call ${u}`);
  }) as typeof fetch;
  return { asked, close: () => { globalThis.fetch = real; } };
}
const k = (o: number, c: number): K => ({ o, c, h: Math.max(o, c) + 0.8, l: Math.min(o, c) - 0.8 });

test('through the real confirmation: the swing sell of 05:05 was already over, and is not recorded', async () => {
  // Gold had closed its hours at 4158, 4151, 4146 and 4143 before falling: four of the last five closed
  // hourly candles sit above the 4137.78 invalidation. The watch ended this setup one second after it was billed.
  const f = feed([k(4160, 4158), k(4158, 4151), k(4151, 4146), k(4146, 4143), k(4143, 4136), k(4136, 4135)], 4135);
  try {
    assert.equal(await bornDead(SWING_SELL), true);
    assert.ok(f.asked.some((u) => /time_series\?symbol=XAU%2FUSD&interval=1h&/.test(u)), 'read on the 1-hour candles — swing\'s own');
  } finally { f.close(); }
  // The same sell with every one of those hours closed BELOW the invalidation is alive, and is recorded as before.
  const g = feed([k(4139, 4137), k(4137, 4136.5), k(4136.5, 4135), k(4135, 4133), k(4133, 4132), k(4132, 4131.5)], 4131.5);
  try { assert.equal(await bornDead(SWING_SELL), false); } finally { g.close(); }
});

test('through the real confirmation: a buy with a recent close under its invalidation is born dead; one without is not', async () => {
  const dead = feed([k(4152, 4150), k(4150, 4149), k(4149, 4143.5), k(4143.5, 4146), k(4146, 4148), k(4148, 4149)], 4149);
  try {
    assert.equal(await bornDead(QUICK_BUY), true);
    assert.ok(dead.asked.some((u) => /interval=5min&/.test(u)), 'read on the 5-minute candles — quick\'s own');
  } finally { dead.close(); }
  const alive = feed([k(4155, 4153), k(4153, 4152), k(4152, 4151), k(4151, 4150.5), k(4150.5, 4150), k(4150, 4149.8)], 4149.8);
  try { assert.equal(await bornDead(QUICK_BUY), false); } finally { alive.close(); }
  // Only the last five CLOSED candles count, as for the watch: a close under the invalidation six candles back does not.
  const old = feed([k(4146, 4143), k(4143, 4151), k(4151, 4152), k(4152, 4151), k(4151, 4150.5), k(4150.5, 4150), k(4150, 4149.8)], 4149.8);
  try { assert.equal(await bornDead(QUICK_BUY), false); } finally { old.close(); }
  // A feed that answers nothing is not a verdict.
  const none = feed([], 4149);
  try { assert.equal(await bornDead(QUICK_BUY), false); } finally { none.close(); }
});

test('the scanner asks before it records, bills, announces or warms — and only for a setup that is still developing', () => {
  const scan = readFileSync('src/app/api/cron/genx-scan/route.ts', 'utf8');
  const call = 'if (await bornDead({ side, entryLow: genx.entry_low, entryHigh: genx.entry_high, watch: (watch ?? genx.entry_low) as number, invalidation: (invalidation ?? genx.stop_loss) as number, mode, mdKey })) { modeOut.result = "not_yet:invalidated"; continue; }';
  assert.equal(scan.split(call).length - 1, 1, 'asked once, with the levels the row would be stored with');
  const at = scan.indexOf(call);
  const immediate = scan.indexOf('state: "entered", enter_price: rr.price, heads_up_sent_at: nowIso, enter_sent_at: nowIso, last_checked_at: nowIso,');
  const forming = scan.indexOf('state: "forming", heads_up_sent_at: nowIso, last_checked_at: nowIso,');
  const bill = scan.indexOf('await billSetupForming(admin, dedupeKey, mode)');
  const note = scan.indexOf('await sendTelegram(headsUpMsg(side, mode,');
  const twinAsk = scan.indexOf('const twin = await findSameSetup(admin, { side, entry_low: genx.entry_low, entry_high: genx.entry_high');
  const gate = scan.indexOf('const tg = await genxTrendGate(side, mdKey');
  for (const [name, i] of Object.entries({ at, immediate, forming, bill, note, twinAsk, gate })) assert.ok(i > 0, `found in the scanner: ${name}`);
  // After the trade-ready branch (which enters at once and is not touched), before everything a developing setup causes.
  assert.ok(immediate < at && at < forming && forming < bill && bill < note, 'order: ask → record → bill → announce');
  // The same-setup check and the trend gate still come first, so a merged or gated setup costs no extra read.
  assert.ok(twinAsk < at && gate < at);
  // Nothing about how the watch ends a setup changed.
  const watch = readFileSync('src/lib/genx/watchTick.ts', 'utf8');
  assert.ok(/if \(o\.confState === "INVALIDATED"\) return \{ do: "invalidate", reason: "invalidated" \};/.test(watch));
  assert.ok(/\} else if \(act\.do === "invalidate"\) \{\s*if \(tgReady\) await sendTelegram\(invalidMsg\(side, row\.mode,/.test(watch));
});
