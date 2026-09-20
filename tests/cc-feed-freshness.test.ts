/**
 * FRESHNESS, AND WHICH BLOCKER GETS REPORTED.
 *
 * Two bugs found during the first live open, both of which made a healthy system look like a broken or
 * idle one. Neither was in the trading logic; both were in how the system described itself.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildSnapshot, tradeable, MAX_TICK_AGE_MS } from "../command-center/engines/snapshot";
import type { Bar, FeedHealth } from "../command-center/core/types";

/** A gently trending 5-minute series, enough bars for the engine to form a read. */
function bars(n: number, endAt: number, stepMs = 5 * 60_000): Bar[] {
  const out: Bar[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const t = endAt - i * stepMs;
    const base = 4300 + (n - i) * 0.6;
    out.push({ t, o: base, h: base + 0.9, l: base - 0.4, c: base + 0.5, v: 120 });
  }
  return out;
}

// A Monday inside the London session, so `market_closed` is not in play.
const OPEN_AT = Date.UTC(2026, 8, 21, 10, 0, 0);

const feed = (ageMs: number | null, state: FeedHealth["state"] = "live"): FeedHealth[] => ([
  { feed: "twelvedata", state, lastTickMs: ageMs == null ? null : OPEN_AT - ageMs, ageMs },
]);

test("a bar four minutes into its own life is NOT a stale feed", () => {
  /*
   * THE BUG. A 5-minute bar is stamped at its OPEN, so the newest bar's age climbs 0 → 300s as it
   * fills. The worker reported that as feed age against a 90-second ceiling, which hard-blocked every
   * trade for the last 210 seconds of every bar — 70% of all market time, on a perfectly healthy feed.
   *
   * Freshness is now the age of the last QUOTE, which this loop fetches every tick. A few seconds.
   */
  assert.equal(MAX_TICK_AGE_MS, 90_000, "the ceiling is a quote ceiling, and this test assumes it");

  const snap = buildSnapshot({
    now: OPEN_AT,
    bars: { "5m": bars(120, OPEN_AT - 4 * 60_000) },   // newest bar opened 4 minutes ago
    price: 4372.5,
    feeds: feed(3_000),                                // but a quote arrived 3 seconds ago
    prevPressureNet: null,
  });

  assert.equal(
    snap.blockers.some((b) => b.code === "feed_stale"), false,
    "a live quote 3s old is fresh, whatever stage the current bar is at",
  );
});

test("a genuinely old quote is still stale", () => {
  const snap = buildSnapshot({
    now: OPEN_AT,
    bars: { "5m": bars(120, OPEN_AT) },
    price: 4372.5,
    feeds: feed(MAX_TICK_AGE_MS + 30_000),
    prevPressureNet: null,
  });
  assert.equal(snap.blockers.some((b) => b.code === "feed_stale"), true,
    "the gate must still catch a feed that has actually stopped");
});

test("a feed reporting its own state as stale blocks regardless of age", () => {
  const snap = buildSnapshot({
    now: OPEN_AT,
    bars: { "5m": bars(120, OPEN_AT) },
    price: 4372.5,
    feeds: feed(1_000, "stale"),
    prevPressureNet: null,
  });
  assert.equal(snap.blockers.some((b) => b.code === "feed_stale"), true);
});

test("the reported blocker is the CAUSE, not the consequence", () => {
  /*
   * The second bug. A closed weekend produces a flat tape, a flat tape scores as "chaotic", and
   * blockers were ordered by when the checks ran — so every log line read "blocked: chaotic" while the
   * snapshot also plainly carried "market_closed". The useless answer was the one on display.
   */
  const CLOSED_AT = Date.UTC(2026, 8, 19, 23, 30, 0);   // Saturday
  const snap = buildSnapshot({
    now: CLOSED_AT,
    bars: { "5m": bars(120, CLOSED_AT) },
    price: 4380,
    feeds: feed(MAX_TICK_AGE_MS + 60_000),
    prevPressureNet: null,
  });

  const codes = snap.blockers.map((b) => b.code);
  assert.ok(codes.includes("market_closed"), "the weekend is in there");

  const first = tradeable(snap).code;
  assert.equal(first, "market_closed", "a shut market outranks every description of what it looks like");
  if (codes.includes("chaotic")) {
    assert.ok(codes.indexOf("market_closed") < codes.indexOf("chaotic"),
      "chaos is what a closed market looks like, not why it cannot be traded");
  }
});
