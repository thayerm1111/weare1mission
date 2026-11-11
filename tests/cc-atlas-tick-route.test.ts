import { call, member, idOf, T, iso, setNow, T0 } from "./_routes";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildSnapshot } from "../command-center/engines/snapshot";
import { ATLAS_READ_VERSION } from "../command-center/core/atlasContract";
import type { Bar } from "../command-center/core/types";

/*
 * ATLAS FEED, THROUGH THE REAL HANDLERS (tests/_routes.ts): /api/command-center/tick serves the newest relayed
 * gold tick under exactly the access rule /api/command-center/live uses, and /live now says where its price came
 * from (`feed`) and which persisted snapshot its analysis is (`analysis`).
 */
let clock = T0;
/** Move the clock on. Two minutes outlives the /tick route's half-second row cache. */
const later = (ms = 2 * 60_000): void => { clock += ms; setNow(clock); };
const tick = (t: string | null) => call("command-center/tick", "GET", "/api/command-center/tick", t);
const live = (t: string | null) => call("command-center/live", "GET", "/api/command-center/live", t);
/** An open Command Center window: one 5-credit spend a minute ago (src/lib/ccPass.ts). */
const openPass = (token: string) => {
  T("credit_transactions").push({ id: `pass-${token}-${clock}`, user_id: idOf(token), kind: "spend", feature: "command_center", amount: -5, created_at: iso(clock - 60_000) });
};
const row = (o: Record<string, unknown> = {}) => ({
  symbol: "XAU/USD", price: 4047.43595, tick_at: iso(clock - 57_000), received_at: iso(clock - 400), updated_at: iso(clock - 350), ...o,
});

test("/tick answers only whom /live answers: signed in, with an open pass", async () => {
  assert.equal((await tick(null)).status, 401);
  assert.equal((await live(null)).status, 401, "the same rule on /live");
  const visitor = member("tick-visitor");
  const refused = await tick(visitor);
  assert.deepEqual([refused.status, refused.json?.error], [402, "pass_required"]);
  assert.equal((await live(visitor)).status, 402, "the same rule on /live");
  const src = readFileSync("src/app/api/command-center/tick/route.ts", "utf8");
  assert.ok(/"cache-control": "no-store"/.test(src) && /dynamic = "force-dynamic"/.test(src), "never cached");
  assert.ok(!/twelvedata\.com|adapters\/twelvedata"\)\.price|tdPrice/.test(src), "it never calls the market-data provider");
});

test("/tick: the newest relayed tick, the server's clock, and its feed state as a poll", async () => {
  later();
  const holder = member("tick-holder");
  openPass(holder);
  T("market_live_ticks").push(row());
  const r = await tick(holder);
  assert.equal(r.status, 200);
  assert.equal(r.json.serverTime, clock);
  assert.deepEqual(r.json.tick, { symbol: "XAU/USD", price: 4047.43595, tickAt: clock - 57_000, receivedAt: clock - 400, updatedAt: clock - 350 });
  assert.deepEqual([r.json.feed.status, r.json.feed.transport, r.json.feed.ageMs, r.json.feed.providerTs], ["delayed", "poll", 400, clock - 57_000]);
  assert.match(r.json.feed.reason, /^Polled every 2 s/);

  // Nothing published yet: no tick, and the status says so.
  later();
  T("market_live_ticks").length = 0;
  const none = await tick(holder);
  assert.deepEqual([none.status, none.json.tick, none.json.feed.status], [200, null, "stale"]);
});

test("/live carries `feed` (the headline price's provenance) and `analysis` (the persisted snapshot it read)", async () => {
  later();
  const holder = member("live-holder");
  openPass(holder);
  // No snapshot written yet: no price, no analysis — and no pretence of either.
  const empty = await live(holder);
  assert.equal(empty.status, 200);
  assert.deepEqual([empty.json.feed.status, empty.json.feed.price, empty.json.analysis.snapshotId, empty.json.analysis.readVersion], ["stale", null, null, ATLAS_READ_VERSION]);

  // A snapshot 30 s old, and a streamed tick received 0.4 s ago.
  const M5 = 5 * 60_000;
  const bars: Bar[] = Array.from({ length: 160 }, (_, i) => {
    const t = Math.floor(clock / M5) * M5 - (159 - i) * M5, o = 4040 + Math.sin(i / 7) * 2;
    return { t, o, h: o + 1.1, l: o - 1.1, c: o + 0.3 };
  });
  const snapAt = clock - 30_000;
  const snap = buildSnapshot({ now: snapAt, bars: { "5m": bars, "15m": bars, "1h": bars, "4h": bars }, price: 4046.9, feeds: [{ feed: "twelvedata", state: "live", lastTickMs: snapAt, ageMs: 3_000 }] });
  T("cc_snapshots").push({ id: 4242, at: iso(snapAt), raw: snap, bars_5m: bars });
  T("market_live_ticks").length = 0;
  T("market_live_ticks").push(row());
  const r = await live(holder);
  assert.equal(r.status, 200, r.text.slice(0, 300));
  assert.equal(r.json.price, 4047.43595, "the headline price is the streamed tick");
  assert.deepEqual(
    [r.json.feed.status, r.json.feed.transport, r.json.feed.price, r.json.feed.receivedTs, r.json.feed.providerTs],
    ["live", "websocket_relay", 4047.43595, clock - 400, clock - 57_000],
    "the same price, its provider stamp and when we received it",
  );
  assert.deepEqual(r.json.analysis, { snapshotId: 4242, analysisVersion: snap.snapshotVersion, analysisAt: snapAt, analysisAgeMs: 30_000, readVersion: ATLAS_READ_VERSION });

  // The stream goes quiet for 25 s: the screen's price falls back to the snapshot's, and says so.
  later(25_000);
  T("cc_snapshots")[0].at = iso(clock - 20_000);
  (T("cc_snapshots")[0].raw as { at: number }).at = clock - 20_000;
  const quiet = await live(holder);
  assert.deepEqual([quiet.json.feed.status, quiet.json.feed.transport, quiet.json.feed.price], ["delayed", "snapshot", 4046.9]);
});
