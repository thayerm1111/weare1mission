import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULT_STATS_SINCE, statsSince, windowStart } from "../src/lib/statsClock";
import { statsSince as viaGenx, DEFAULT_STATS_SINCE as viaGenxDefault } from "../src/lib/genx/statsSince";
import { communityStats, type PlayRow } from "../src/lib/communityStats";
import { trackRecordLines, type TrackRecord } from "../command-center/engines/record";

/**
 * Owner 10-11: "please reset all the stats on the platform". Every member-facing and public results
 * number counts from one clock, and nothing is deleted to do it.
 */
const code = (f: string) => readFileSync(f, "utf8");

test("the record restarts at 5pm New York on Sunday 10-11, before the forex and gold reopen", () => {
  assert.equal(DEFAULT_STATS_SINCE, "2026-10-11T21:00:00Z");
  assert.equal(viaGenxDefault, DEFAULT_STATS_SINCE, "lib/genx re-exports the one clock");
});

test("the clock is the later of the code and the env — the env's older reset cannot hold it back", () => {
  // FLOOR_STATS_SINCE on Vercel still says the 09-25 reset. Before 10-11 it won outright.
  assert.equal(statsSince("2026-09-26T01:45:00Z"), DEFAULT_STATS_SINCE);
  assert.equal(statsSince(undefined), DEFAULT_STATS_SINCE);
  assert.equal(statsSince(""), DEFAULT_STATS_SINCE);
  assert.equal(statsSince("not a date"), DEFAULT_STATS_SINCE);
  assert.equal(statsSince(" 2026-10-20T00:00:00Z\n"), "2026-10-20T00:00:00.000Z", "a stray space or newline in the env is not a reason to ignore it");
  // A later env still moves the record forward without a deploy.
  assert.equal(statsSince("2026-10-20T00:00:00Z"), "2026-10-20T00:00:00.000Z");
  const prev = process.env.FLOOR_STATS_SINCE;
  process.env.FLOOR_STATS_SINCE = "2026-09-26T01:45:00Z";
  try { assert.equal(viaGenx(), DEFAULT_STATS_SINCE); } finally { if (prev === undefined) delete process.env.FLOOR_STATS_SINCE; else process.env.FLOOR_STATS_SINCE = prev; }
});

test("a rolling window never reaches back past the reset", () => {
  const reset = Date.parse(DEFAULT_STATS_SINCE);
  assert.equal(windowStart(reset - 30 * 86_400_000), reset);
  assert.equal(windowStart(reset + 5_000), reset + 5_000);
});

test("every results number on the platform reads the clock", () => {
  // Already on it before 10-11: the Floor/desk cards, GENX stats, the follower record, the Live Trade card.
  assert.match(code("src/app/api/flow/stats/route.ts"), /const since = statsSince\(\);[\s\S]*\.gte\("created_at", since\)/);
  assert.match(code("src/app/api/genx-stats/route.ts"), /\.gte\("created_at", statsSince\(\)\)[\s\S]*\.gte\("created_at", statsSince\(\)\)/);
  assert.match(code("src/app/api/floor/live-trade/route.ts"), /Date\.parse\(statsSince\(\)\)/);
  // Brought onto it on 10-11.
  const follower = code("src/app/api/genx/follower/route.ts");
  assert.match(follower, /from\("genx_follower_fills"\)\.select\("signal_key"\)\.gte\("placed_at", since\)/, "the follower's taken count");
  const wins = code("src/app/api/genx/wins/route.ts");
  assert.equal((wins.match(/\.gte\("created_at", since\)/g) ?? []).length, 2, "the /wins page: the list and the all-time count");
  const desk = code("src/app/api/genfx/desk/route.ts");
  assert.match(desk, /const d30 = new Date\(windowStart\(Date\.now\(\) - 30 \* 24 \* 3600_000\)\)\.toISOString\(\);/);
  assert.match(desk, /const d7ms = windowStart\(Date\.now\(\) - 7 \* 24 \* 3600_000\);/);
  assert.match(desk, /\.in\("outcome", \["win", "loss"\]\)\.gte\("resolved_at", d30\)\.gte\("enter_sent_at", since\)/, "GEN FX's graded calls");
  assert.match(desk, /\.eq\("state", "entered"\)\.or\(`enter_sent_at\.gte\.\$\{since\},outcome\.is\.null`\)/, "latest calls: new ones, and older ones still running");
  const cs = code("src/app/api/community-stats/route.ts");
  assert.match(cs, /const since = statsSince\(\);/);
  assert.match(cs, /\.eq\("engine", "plays"\)\s*\.gte\("created_at", since\)/);
  assert.match(cs, /\.range\(page \* PAGE, page \* PAGE \+ PAGE - 1\);[\s\S]*if \(got\.length < PAGE\) break;/, "every play, not the first page of them");
  assert.match(code("src/app/api/signals/route.ts"), /return json\(\{ signals, since: statsSince\(\) \}\);/);
  const plays = code("src/components/portal/SignalGenerator.tsx");
  assert.match(plays, /const counted = recent\.filter\(\(r\) => madeAt\(r\) >= sinceMs\);/);
  assert.match(plays, /if \(Number\.isFinite\(n\) && n > 1e12\) return n;\n  const saved = Date\.parse\(r\.createdAt \?\? ""\);/, "a play keyed by symbol and price goes by when it was saved");
  assert.match(code("src/app/api/signals/route.ts"), /createdAt: r\.created_at \?\? undefined,/);
  assert.match(plays, /const wins = counted\.filter[\s\S]*const losses = counted\.filter[\s\S]*const totalPips = Math\.round\(counted\.filter/);
  assert.match(code("command-center/engines/record.ts"), /const startMs = windowStart\(back\);/, "ATLAS's own record");
  assert.match(code("src/app/api/matty-pips/stats/route.ts"), /windowStart\(Date\.now\(\) - 30 \* 86400_000\)/);
  assert.match(code("src/app/api/admin/my-results/route.ts"), /const mine = effectiveSince\(statsSince\(\), await memberStatsSince\(admin, OWNER_USER_ID\)\);/, "the owner's own results");
});

test("nothing is deleted: no route touched by the reset writes or removes a row", () => {
  for (const f of ["src/app/api/genx/wins/route.ts", "src/app/api/community-stats/route.ts", "src/lib/statsClock.ts", "src/lib/communityStats.ts"]) {
    assert.ok(!/\.delete\(|\.update\(|\.insert\(|\.upsert\(/.test(code(f)), f);
  }
});

/* ── Community Results ─────────────────────────────────────────────────────────────────────────── */

const NOW = Date.parse("2026-10-20T12:00:00Z");
const row = (o: Partial<PlayRow>): PlayRow => ({
  engine: "plays", user_id: "u1", instrument: "XAU/USD", direction: "long", status: "open", confidence: "High",
  rr_planned: 2, realized_r: null, hit_tp: null, created_at: "2026-10-19T10:00:00Z", resolved_at: null, ...o,
});

test("community results count each play once — `launch` no longer repeats the resolved ones", () => {
  const rows = [
    row({ status: "win", realized_r: 2, resolved_at: "2026-10-19T12:00:00Z", hit_tp: 1 }),
    row({ status: "win", realized_r: "1.5", resolved_at: "2026-10-19T13:00:00Z", user_id: "u2" }),
    row({ status: "loss", realized_r: -1, resolved_at: "2026-10-19T14:00:00Z", direction: "short" }),
    row({ status: "expired", resolved_at: "2026-10-19T15:00:00Z", confidence: "low" }),
    row({ status: "unfilled" }),
    row({ status: "open", instrument: "EUR/USD", created_at: "2026-10-01T00:00:00Z", rr_planned: "3.0" }),
    row({ status: null, confidence: "Medium" }),
  ];
  const s = communityStats(rows, NOW);
  assert.deepEqual(s.launch, { resolved: 0, wins: 0, losses: 0 });
  assert.equal(s.live.resolved, 3);
  assert.equal(s.live.wins, 2);
  assert.equal(s.live.losses, 1);
  assert.equal(s.live.expired, 1);
  assert.equal(s.live.open, 1, "unfilled, expired and a missing status are not open");
  assert.equal(s.live.generated, 7);
  assert.equal(s.live.generated_7d, 6, "the 10-01 play is outside the last 7 days");
  assert.equal(s.members_using, 2);
  assert.equal(s.live.avg_realized_r, 0.83, "(2 + 1.5 − 1) / 3, to two places, over resolved plays only");
  assert.equal(s.live.avg_planned_rr, 2.14);
  assert.deepEqual(s.live.direction, { long: 6, short: 1 });
  assert.deepEqual(s.live.confidence, { High: 5, Medium: 1, Low: 1 });
  assert.deepEqual(s.live.top_instruments, [{ instrument: "XAU/USD", n: 6 }, { instrument: "EUR/USD", n: 1 }]);
  assert.deepEqual(s.live.by_engine, [{ engine: "plays", generated: 7, resolved: 3, wins: 2, losses: 1 }]);
  // Newest finished first; wins, losses and expiries only.
  assert.deepEqual(s.live.recent.map((r) => r.status), ["expired", "loss", "win", "win"]);
  assert.equal(s.live.recent[3].hit_tp, 1);
});

test("an empty record is a clean zero, not an error", () => {
  const s = communityStats([], NOW);
  assert.equal(s.live.generated, 0);
  assert.equal(s.live.resolved, 0);
  assert.equal(s.live.avg_realized_r, null);
  assert.equal(s.live.avg_planned_rr, null);
  assert.deepEqual(s.live.recent, []);
  assert.equal(s.members_using, 0);
});

test("the site and the phone app read the reset-aware route and no longer add `launch` on top", () => {
  const site = code("src/components/portal/CommunityResults.tsx");
  assert.match(site, /fetch\("\/api\/community-stats"/);
  assert.ok(!/community_signal_stats|data\.launch\./.test(site));
  const app = code("public/app/index.html");
  assert.match(app, /apiGet\("\/api\/community-stats"\)/);
  assert.ok(!/community_signal_stats|launch\.resolved|launch\.wins/.test(app));
});

/* ── ATLAS ─────────────────────────────────────────────────────────────────────────────────────── */

test("ATLAS says where its record starts when the reset cut it short", () => {
  const base: TrackRecord = { scored: 3, right: 1, wrong: 1, flat: 1, noCall: 0, hitRate: 0.5, byHorizon: [], recentMisses: [] };
  assert.match(trackRecordLines({ ...base, since: "2026-10-11T21:00:00.000Z", fromReset: true })[0], /measured since 2026-10-11, when the platform's record was reset/);
  assert.match(trackRecordLines(base)[0], /last 30 days/);
  assert.match(trackRecordLines({ ...base, since: "2026-10-01T00:00:00.000Z", fromReset: false })[0], /last 30 days/);
});

test("averages round as the database did: halves away from zero", () => {
  // The four plays the old database function last counted: its avg_realized_r was −0.13.
  const four = [2.5, -1, -1, -1].map((r, i) => row({ status: r > 0 ? "win" : "loss", realized_r: r, resolved_at: `2026-10-0${i + 1}T00:00:00Z` }));
  assert.equal(communityStats(four, NOW).live.avg_realized_r, -0.13);
  assert.equal(communityStats([row({ status: "win", realized_r: 0.125, resolved_at: "2026-10-01T00:00:00Z" })], NOW).live.avg_realized_r, 0.13);
  assert.ok(Object.is(communityStats([row({ status: "win", realized_r: -0.001, resolved_at: "2026-10-01T00:00:00Z" })], NOW).live.avg_realized_r, 0), "never −0");
});
