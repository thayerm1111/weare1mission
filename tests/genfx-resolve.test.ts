import { test } from "node:test";
import assert from "node:assert/strict";
import { PAIRS } from "../src/lib/genfx/pairs";
import { gradeRead, type Sig } from "../src/lib/genfx/resolve";

/*
 * The page's own record: every read a member runs, graded against the five-minute candles after it.
 * The rule is the one the scanner's calls are graded by — what a candle cannot show is settled against
 * the read — so the two records on the page mean the same thing.
 */
const E = PAIRS.EURUSD;
const M5 = 300_000;
const T0 = Date.UTC(2026, 9, 6, 12, 2, 0);                    // issued two minutes into the 12:00 candle
const at = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const c = (i: number, high: number, low: number, close = (high + low) / 2) => ({ datetime: at(Date.UTC(2026, 9, 6, 12, 0) + i * M5), open: String(close), high: String(high), low: String(low), close: String(close) });
const buy = (o: Partial<Sig> = {}): Sig => ({ id: "s", created_at: new Date(T0).toISOString(), mode: "quick", action: "BUY_NOW", direction: "bullish", entry: 1.084, stop_loss: 1.0825, tp1: 1.087, tp2: 1.089, tp3: null, ...o });
const LATER = T0 + 6 * 3600_000;

test("the candle a read was issued in can stop it, but cannot pay it", () => {
  // The 12:00 candle — the read came at 12:02 — reaches the target. Part of that range was printed before the read.
  const paidEarly = [c(0, 1.0872, 1.0838), c(1, 1.0845, 1.0838)];
  assert.equal(gradeRead(E, buy(), paidEarly, LATER).status, "open");
  // The same candle reaching the stop IS a loss. (GENX's rule skips this candle and never sees it.)
  const stoppedEarly = [c(0, 1.0845, 1.0824), c(1, 1.0872, 1.084)];
  const v = gradeRead(E, buy(), stoppedEarly, LATER);
  assert.deepEqual([v.status, v.sl_hit, v.minutes_to_sl], ["LOSS", true, 3]);
  // The next candle can pay.
  const w = gradeRead(E, buy(), [c(0, 1.0845, 1.0838), c(1, 1.0871, 1.084)], LATER);
  assert.deepEqual([w.status, w.tp1_hit, w.tp2_hit, w.minutes_to_tp], ["WIN", true, false, 8]);
  // Both in one candle: a loss.
  assert.equal(gradeRead(E, buy(), [c(0, 1.0845, 1.0838), c(1, 1.0871, 1.0824)], LATER).status, "LOSS");
  // A candle that had closed before the read says nothing.
  assert.equal(gradeRead(E, buy(), [c(-1, 1.09, 1.08), c(0, 1.0845, 1.0838)], LATER).status, "open");
});

test("a waiting entry has to be reached first — and the candle that reaches it cannot also pay it", () => {
  const wait = buy({ action: "BUY_LIMIT", entry: 1.083 });
  // Never comes back to 1.0830: nothing, then EXPIRED unfilled once its twelve hours are up (and the candles in hand reach the end of them).
  const away = [c(1, 1.086, 1.084), c(2, 1.088, 1.085)];
  assert.equal(gradeRead(E, wait, away, LATER).status, "open");
  const exp = gradeRead(E, wait, [...away, c(150, 1.088, 1.085)], T0 + 13 * 3600_000);
  assert.deepEqual([exp.status, exp.filled], ["EXPIRED", false]);
  // One candle dips to the entry and runs to the target: filled, not yet paid.
  assert.equal(gradeRead(E, wait, [c(1, 1.0872, 1.0829)], LATER).status, "open");
  // …the candle after pays it.
  assert.equal(gradeRead(E, wait, [c(1, 1.0872, 1.0829), c(2, 1.0873, 1.085)], LATER).status, "WIN");
  // …and the filling candle can stop it.
  assert.equal(gradeRead(E, wait, [c(1, 1.084, 1.0824)], LATER).status, "LOSS");
});

test("only closed candles, and none past the read's deadline", () => {
  // The newest candle is still forming at `now`: it has touched the target and is not read yet.
  const now = Date.UTC(2026, 9, 6, 12, 12, 0);
  assert.equal(gradeRead(E, buy(), [c(1, 1.0845, 1.084), c(2, 1.0871, 1.0842)], now).status, "open");
  assert.equal(gradeRead(E, buy(), [c(1, 1.0845, 1.084), c(2, 1.0871, 1.0842)], now + M5).status, "WIN");
  // A Quick read lives twelve hours. The target printing in the thirteenth is not a win.
  const flat = Array.from({ length: 143 }, (_, i) => c(i + 1, 1.0845, 1.0838, 1.0842));
  const v = gradeRead(E, buy(), [...flat, c(150, 1.0875, 1.084)], T0 + 14 * 3600_000);
  assert.deepEqual([v.status, v.filled, v.directional_correct], ["EXPIRED", true, true]);
  // A sell mirrors a buy.
  const sell = buy({ action: "SELL_NOW", direction: "bearish", entry: 1.084, stop_loss: 1.0855, tp1: 1.081, tp2: null });
  assert.equal(gradeRead(E, sell, [c(0, 1.0845, 1.0838), c(1, 1.0842, 1.0809)], LATER).status, "WIN");
  assert.equal(gradeRead(E, sell, [c(0, 1.0856, 1.0838)], LATER).status, "LOSS");
  // A read with no levels is never graded.
  assert.equal(gradeRead(E, buy({ stop_loss: null }), [c(1, 1.09, 1.08)], LATER).status, "open");
});

test("the candle a read was issued in cannot FILL a waiting entry either — and how far price ran is measured from after the read", () => {
  // A buy limit at 1.0830. The 12:00 candle traded down through it at 12:01; the read was issued at 12:02.
  const wait = buy({ action: "BUY_LIMIT", entry: 1.083, stop_loss: 1.0815, tp1: 1.086, tp2: null });
  // Price never comes back to 1.0830 and later runs to the target. (The second version called this a filled WIN.)
  const never = [c(0, 1.0845, 1.0829), c(1, 1.0848, 1.0838), c(2, 1.0862, 1.0845)];
  assert.equal(gradeRead(E, wait, never, LATER).status, "open");
  const exp = gradeRead(E, wait, [...never, c(150, 1.0862, 1.0845)], T0 + 13 * 3600_000);
  assert.deepEqual([exp.status, exp.filled, exp.mfe_pips, exp.mae_pips], ["EXPIRED", false, 0, 0]);
  // It does come back, in a later candle: filled there, paid by the candle after.
  const back = [c(0, 1.0845, 1.0829), c(1, 1.0848, 1.0829), c(2, 1.0862, 1.0835)];
  const w = gradeRead(E, wait, back, LATER);
  assert.deepEqual([w.status, w.filled, w.minutes_to_tp], ["WIN", true, 13]);
  // The issue candle's own range — mostly printed before the read existed — is not how far the trade ran.
  // A BUY NOW at 1.0840 issued at 12:02: the 12:00 candle had already been to 1.0822 and 1.0868.
  const now = buy({ stop_loss: 1.082, tp1: 1.087, tp2: null });
  const v = gradeRead(E, now, [c(0, 1.0868, 1.0822), c(1, 1.0846, 1.0837), c(2, 1.0872, 1.0841)], LATER);
  assert.deepEqual([v.status, v.mfe_pips, v.mae_pips], ["WIN", 32, 3]);         // from the two candles after it: +32 / −3, not +28 / −18
  // Stopped inside the issue candle: a loss — and it went at least the stop's distance against the read.
  const s = gradeRead(E, now, [c(0, 1.0845, 1.0819)], LATER);
  assert.deepEqual([s.status, s.mae_pips], ["LOSS", 20]);
});

test("a read is out of time only once the LAST candle of its window has closed and is in hand", () => {
  // A Quick read issued at 12:02:00: twelve hours, to 00:02:00. The last candle that counts is the one
  // that opens at 00:00 — it starts before the deadline — and it closes at 00:05.
  const read = buy({ stop_loss: 1.082, tp1: 1.087, tp2: null });
  const flat = Array.from({ length: 143 }, (_, i) => c(i + 1, 1.0845, 1.0838, 1.0842));        // 12:05 … 23:55, nothing happens
  const last = c(144, 1.0872, 1.0841);                                                         // 00:00–00:05: the target prints
  const deadline = T0 + 12 * 3600_000;
  // A pass at 00:03 — past the deadline, the 00:00 candle still forming. (The third version: EXPIRED,
  // and the read stays that way; five minutes later the same candle would have made it a WIN.)
  assert.equal(gradeRead(E, read, [...flat, last], deadline + 60_000).status, "open");
  // 00:05:05 — closed by the clock, but the feed has not had its eight seconds: not yet.
  assert.equal(gradeRead(E, read, [...flat, last], deadline + 185_000).status, "open");
  // 00:05:10 — closed and in hand: a WIN.
  const win = gradeRead(E, read, [...flat, last], deadline + 190_000);
  assert.deepEqual([win.status, win.tp1_hit], ["WIN", true]);
  // The same moment with the last candle doing nothing: now it is EXPIRED.
  assert.equal(gradeRead(E, read, [...flat, c(144, 1.0845, 1.0838, 1.0842)], deadline + 190_000).status, "EXPIRED");
  // The candles in hand stop short of the window's end (the feed is behind): wait for them rather than call it.
  assert.equal(gradeRead(E, read, flat, deadline + 3_600_000).status, "open");
  // A candle that opens AT or after the deadline says nothing about the read — but it does show the feed has moved past the window.
  const after = gradeRead(E, read, [...flat, c(145, 1.09, 1.0841)], deadline + 3_600_000);
  assert.deepEqual([after.status, after.filled], ["EXPIRED", true]);
});
