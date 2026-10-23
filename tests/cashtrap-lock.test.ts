import test from "node:test";
import assert from "node:assert/strict";
import { lockAlerts, lockHistory, lockMarket, lockSnapshot, LOCKED_REASON } from "../src/lib/cashtrap/lock";
import type { Snapshot } from "../src/lib/cashtrap/snapshot";
import type { SignalRecord } from "../src/lib/cashtrap/signals";
import type { Decision } from "../src/lib/cashtrap/engine";

/**
 * Cashtrap on The Floor for members, live plays locked (owner 10-23). A member without a window is
 * never SENT which way a live signal or forming setup goes, nor its reference entry; results, prices,
 * the chart and a market that is simply waiting stay open.
 */
const now = Date.UTC(2026, 9, 23, 14, 2, 0);
const signal = (over: Partial<SignalRecord> = {}): SignalRecord => ({
  dedupeKey: "EURUSD:CALL:1:v", setupId: "EURUSD:BUY:a:v", symbol: "EURUSD", direction: "CALL", setupCandleT: now - 600_000, confirmationT: now - 300_000, confirmedAt: now - 90_000,
  publishedAt: now - 60_000, entryWindowStart: now - 60_000, entryDeadline: now - 50_000, expiryMode: "duration", expiryDurationSec: 300, expiryAt: now + 240_000,
  referencePrice: 1.12345, referenceAt: now - 59_700, referenceSource: "TwelveData price", settlementPrice: null, settlementAt: null, settlementSource: null,
  status: "active", result: "pending", recordType: "reference-feed", payoutRate: null, payout: null,
  exhaustionValues: { close: 1.1222 } as SignalRecord["exhaustionValues"], confirmationValues: { close: 1.1231 } as SignalRecord["confirmationValues"], zone: null,
  strategyVersion: "cashtrap-1.0.0", configVersion: "cfg", notes: [], ...over,
});
const decision = (status: Decision["status"], direction: Decision["direction"]): Decision => ({
  symbol: "EURUSD", candleT: now - 390_000, decidedAt: now - 90_000, status, direction, leading: direction, checklist: null, met: 5, reasonCode: "x",
  reason: `${direction ?? ""} ${status === "CONFIRMED" ? "CALL confirmed" : "armed"}`, values: null, zoneId: "z", setupId: "EURUSD:BUY:a:v", strategyVersion: "v", configVersion: "c",
});
const snap = (over: Partial<Snapshot>): Snapshot => ({
  symbol: "EURUSD", updatedAt: now, price: { px: 1.1235, at: now - 2_000, source: "TwelveData" }, feed: { open: true, ok: true, reason: null, lagMs: 1000, latestCandleT: now - 390_000 },
  status: "ACTIVE", reason: "CALL active from 1.12345", direction: "BUY", checklist: { band: true, rsi: true, stoch: true, zone: true, dmi: true }, met: 5,
  nextCloseAt: now + 180_000, lastDecision: decision("CONFIRMED", "BUY"), armed: null, developing: null, signal: signal(),
  dmi: { mode: "calculation", available: true, label: "x", notes: [] }, strategyVersion: "v", configVersion: "c", ...over,
} as Snapshot);
const leaks = (x: unknown): string[] => {
  const s = JSON.stringify(x);
  return ["CALL", "PUT", "BUY", "SELL", "1.12345"].filter((w) => s.includes(w));
};

test("a live signal's card: LOCKED, with nothing that says which way or where", () => {
  const out = lockSnapshot(snap({}))!;
  assert.equal(out.status, "LOCKED");
  assert.equal(out.reason, LOCKED_REASON);
  assert.deepEqual([out.direction, out.checklist, out.signal, out.lastDecision, out.armed], [null, null, null, null, null]);
  assert.deepEqual(leaks(out), []);
  assert.equal(out.price?.px, 1.1235, "the price stays");
});

test("a forming setup (ARMED, DEVELOPING) is locked too; an armed setup is withheld whatever the status", () => {
  const armed = { id: "EURUSD:SELL:b:v", direction: "SELL", values: {}, checklist: {}, zone: null } as unknown as Snapshot["armed"];
  const a = lockSnapshot(snap({ status: "ARMED", direction: "SELL", signal: null, lastDecision: decision("ARMED", "SELL"), armed, reason: "SELL armed" }))!;
  assert.equal(a.status, "LOCKED");
  assert.deepEqual(leaks(a), []);
  const d = lockSnapshot(snap({ status: "DATA_UNAVAILABLE", direction: null, checklist: null, signal: null, lastDecision: null, armed, reason: "Data unavailable — feed is behind." }))!;
  assert.equal(d.status, "DATA_UNAVAILABLE");
  assert.equal(d.armed, null);
  assert.deepEqual(leaks(d), []);
});

test("a market that is only waiting, and a finished signal (a result), stay open", () => {
  const w = snap({ status: "WAIT", direction: "SELL", signal: null, lastDecision: decision("WAIT", "SELL"), reason: "WAIT — leaning SELL" });
  assert.deepEqual(lockSnapshot(w), w);
  const done = snap({ status: "EXPIRED", signal: signal({ status: "settled", result: "win", settlementPrice: 1.1240 }), reason: "CALL from 14:00 win" });
  const out = lockSnapshot(done)!;
  assert.equal(out.status, "EXPIRED");
  assert.equal(out.signal?.result, "win");
});

test("the market detail drops the live signal, the setup behind it, armed setups and an arming/confirming decision — and keeps results", () => {
  const live = signal();
  const old = signal({ dedupeKey: "old", setupId: "EURUSD:SELL:old:v", direction: "PUT", status: "settled", result: "loss" });
  const out = lockMarket({
    setups: [{ id: live.setupId, status: "confirmed" }, { id: "EURUSD:SELL:z:v", status: "armed" }, { id: old.setupId, status: "confirmed" }],
    signals: [old, live], decision: decision("CONFIRMED", "BUY"), snapshot: snap({}),
  });
  assert.deepEqual(out.setups.map((s) => s.id), [old.setupId]);
  assert.deepEqual(out.signals.map((s) => s.dedupeKey), ["old"]);
  assert.equal(out.decision, null);
  assert.equal(out.snapshot?.status, "LOCKED");
});

test("history keeps results and leaves out what is still in play", () => {
  const live = signal({ status: "published", referencePrice: null });
  const old = signal({ dedupeKey: "old", setupId: "o", status: "settled", result: "win" });
  const out = lockHistory({ referenceFeed: [live, old], brokerVerified: [], setups: [{ id: live.setupId, status: "confirmed" }, { id: "o", status: "confirmed" }, { id: "x", status: "armed" }] });
  assert.deepEqual(out.referenceFeed.map((s) => s.dedupeKey), ["old"]);
  assert.deepEqual(out.setups.map((s) => s.id), ["o"]);
});

test("fresh alerts about a play say THAT there is one, not which way; older alerts and outcomes are unchanged", () => {
  const at = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
  const alerts = [
    { kind: "signal", symbol: "EURUSD", title: "EUR/USD: CALL", body: "Published 14:00:31 UTC.", created_at: at(2) },
    { kind: "entry", symbol: "EURUSD", title: "EUR/USD: CALL active", body: "Reference entry 1.12345", created_at: at(2) },
    { kind: "armed", symbol: "EURUSD", title: "EUR/USD: BUY setup armed", body: "waiting for the DMI B", created_at: at(4) },
    { kind: "outcome", symbol: "EURUSD", title: "EUR/USD: CALL win", body: "WIN", created_at: at(1) },
    { kind: "signal", symbol: "EURUSD", title: "EUR/USD: PUT", body: "old", created_at: at(40) },
  ];
  const out = lockAlerts(alerts, now, () => "EUR/USD");
  assert.deepEqual(leaks(out.slice(0, 3)), []);
  assert.equal(out[3].title, "EUR/USD: CALL win", "an outcome is a result");
  assert.equal(out[4].title, "EUR/USD: PUT", "an old signal is history");
});

test("every Cashtrap route that can carry a live play asks for the viewer's window and withholds the play when it is closed", async () => {
  const { readFileSync } = await import("node:fs");
  const routes: Array<[string, string]> = [
    ["src/app/api/cashtrap/dashboard/route.ts", "lockSnapshot"],
    ["src/app/api/cashtrap/market/route.ts", "lockMarket"],
    ["src/app/api/cashtrap/history/route.ts", "lockHistory"],
    ["src/app/api/cashtrap/alerts/route.ts", "lockAlerts"],
  ];
  for (const [file, fn] of routes) {
    const src = readFileSync(file, "utf8");
    assert.ok(src.includes("cashtrapGate(a)"), `${file} asks for the window`);
    assert.ok(src.includes(`${fn}(`) && /gate\.open \?/.test(src), `${file} withholds with ${fn} when the window is closed`);
  }
});

test("on a locked market the indicator values and DMI events since the live setup began are blanked; earlier candles keep theirs", () => {
  const live = signal();                                                       // setup candle: now − 600 s
  const pt = (t: number, ev: "B" | "S" | null) => ({ t, o: 1, h: 1, l: 1, c: 1, bbBasis: 1, bbUpper: 1.1, bbLower: 0.9, rsi: 12, rsiMa: 20, stochK: 8, dmiStoch: 15, dmiEvent: ev });
  const points = [pt(now - 1_200_000, "S"), pt(now - 900_000, null), pt(now - 600_000, null), pt(now - 300_000, "B")];
  const out = lockMarket({ setups: [], signals: [live], decision: null, snapshot: snap({}), points });
  assert.deepEqual(out.points!.map((k) => k.dmiEvent), ["S", null, null, null], "the confirming B is not sent");
  assert.deepEqual(out.points!.map((k) => k.rsi), [12, 12, null, null]);
  assert.deepEqual(leaks(out.points), []);
});
