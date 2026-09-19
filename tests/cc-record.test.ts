import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { extractClaim, trackRecordLines, type TrackRecord } from "../command-center/engines/record";
import { nextNfp, calendarLines, LOCKOUT_BEFORE_MIN } from "../command-center/adapters/calendar";

/*
 * THE RECORD ONLY MEANS ANYTHING IF IT CANNOT BE GAMED.
 *
 * A system that invents a position it never took so that it can score a win is worse than one with no
 * record at all, so the extractor is conservative to the point of being unhelpful — and that is the
 * property these tests protect.
 */

test("a clear directional read is recorded as one", () => {
  assert.equal(extractClaim("Buyers are in control here and I'd favour the long.").direction, "up");
  assert.equal(extractClaim("Sellers look stronger; this is breaking down.").direction, "down");
});

test("hedging is not a call, however much direction is in the sentence", () => {
  // "Buyers are stronger but I'd wait" is a description plus a refusal. Scoring it as a long would be
  // putting words in its mouth.
  for (const s of [
    "Buyers are stronger, but I'd wait for the retest.",
    "It could go either way from here.",
    "Gold is closed right now, so there's nothing live to read.",
    "I don't know yet — too early to say.",
  ]) assert.equal(extractClaim(s).direction, "none", s);
});

test("a sentence pointing both ways is not a call either", () => {
  assert.equal(extractClaim("Buyers are in control on the hourly, sellers are in control on the five.").direction, "none");
});

test("the horizon comes from what was implied, so a scalp is not judged on tomorrow", () => {
  assert.equal(extractClaim("Quick long here, buyers in control.").horizonMin, 30);
  assert.equal(extractClaim("For the swing I'd favour the long this week.").horizonMin, 1440);
  assert.equal(extractClaim("Intraday, buyers are in control.").horizonMin, 240);
  assert.equal(extractClaim("Buyers are in control.").horizonMin, 60);
});

/*
 * A THIN SAMPLE IS NOT A HIT RATE.
 *
 * Six resolved calls presented as "67%" is the same false precision the rest of this system refuses.
 */
test("it refuses to quote a percentage from too few calls", () => {
  const thin: TrackRecord = {
    scored: 12, right: 4, wrong: 2, flat: 6, noCall: 0, hitRate: 4 / 6,
    byHorizon: [], recentMisses: [],
  };
  const lines = trackRecordLines(thin).join("\n");
  assert.ok(/far too few to be a hit rate/.test(lines));
  assert.ok(!/67%/.test(lines), "and does not print one anyway");

  const fat: TrackRecord = {
    scored: 60, right: 18, wrong: 12, flat: 30, noCall: 0, hitRate: 0.6,
    byHorizon: [], recentMisses: [],
  };
  assert.ok(/60% on the calls that resolved/.test(trackRecordLines(fat).join("\n")));
});

test("misses are put in front of it and wins are not", () => {
  const t: TrackRecord = {
    scored: 40, right: 10, wrong: 10, flat: 20, noCall: 0, hitRate: 0.5,
    byHorizon: [{ horizon: 60, right: 6, wrong: 7 }],
    recentMisses: [{ at: Date.now() - 7_200_000, direction: "up", movedPips: -180, answer: "Buyers are in control." }],
  };
  const lines = trackRecordLines(t).join("\n");
  assert.ok(/recent miss/.test(lines), "the useful thing is the last time this read failed");
  assert.ok(/Never claim a win that is not in these numbers/.test(lines));
});

test("a call is never scored before its horizon has matured", async () => {
  const src = await fs.readFile("command-center/engines/record.ts", "utf8");
  assert.ok(/if \(matureAt > nowMs\) continue;/.test(src), "unmatured calls are skipped, not graded early");
  assert.ok(/MEANINGFUL_PIPS/.test(src), "and a move inside the noise floor counts as neither right nor wrong");
});

test("the journal can never break a conversation", async () => {
  const src = await fs.readFile("command-center/engines/record.ts", "utf8");
  const fn = src.slice(src.indexOf("export async function recordCall"), src.indexOf("const MEANINGFUL_PIPS"));
  assert.ok(/catch \{/.test(fn), "a failed insert is swallowed");
  const voice = await fs.readFile("command-center/brain/voiceLlm.ts", "utf8");
  assert.ok(/void recordCall\(/.test(voice), "and never awaited on the answer path");
});

/* ── the calendar ─────────────────────────────────────────────────────── */

/*
 * A WRONG DATE IN FRONT OF A TRADER IS WORSE THAN AN EMPTY CALENDAR.
 *
 * Payrolls is the first Friday of the month at a fixed Eastern time — a published, stable rule, safe
 * to compute. FOMC and CPI dates are not derivable and are never guessed.
 */
test("payrolls is derived correctly on both sides of a daylight-saving change", () => {
  const ny = (ms: number) => new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(ms));

  const summer = nextNfp(Date.parse("2026-09-19T20:00:00Z"));
  assert.match(ny(summer.at), /^Friday, October 2(,| at) 08:30$/);
  const winter = nextNfp(Date.parse("2026-01-15T20:00:00Z"));
  assert.match(ny(winter.at), /^Friday, February 6(,| at) 08:30$/);
});

test("with the sources unreachable it says so instead of guessing a date", () => {
  const lines = calendarLines({ events: [], source: "derived_only", next: null, minutesToNext: null, inLockout: false }).join("\n");
  assert.ok(/UNREACHABLE/.test(lines), "a feed that is down says it is down");
  assert.ok(/never guess a date/.test(lines));
  assert.ok(/You do NOT know this week's FOMC, CPI or PPI dates/.test(lines));
});

test("the news lockout is finally wired to something", async () => {
  const worker = await fs.readFile("command-center/worker/index.ts", "utf8");
  assert.ok(/upcoming\(now\)/.test(worker), "the worker reads the calendar");
  assert.ok(/inLockout: cal\.inLockout/.test(worker), "and puts the lockout into the snapshot");
  assert.ok(/news\b/.test(worker), "which is the field that has always existed and never been filled");
  assert.ok(LOCKOUT_BEFORE_MIN > 0);
});

/*
 * A QUESTION ABOUT ITSELF IS NOT A QUESTION ABOUT THE MARKET.
 *
 * "How accurate have your calls been" came back as "gold is closed" — the same failure as refusing to
 * discuss last week, one layer up. The record either exists or it does not, and neither answer has
 * anything to do with whether the market happens to be open.
 */
test("it can be asked about its own record at any hour", async () => {
  const { asksAboutRecord } = await import("../command-center/engines/record");
  for (const q of [
    "How accurate have your calls been lately?",
    "what's your track record",
    "how often are you right",
    "have you been right this week",
    "how many did you get wrong",
  ]) assert.ok(asksAboutRecord(q), q);

  for (const q of ["where is gold", "what happened last week", "how's my trade"]) {
    assert.ok(!asksAboutRecord(q), q);
  }

  const src = await fs.readFile("command-center/brain/voiceLlm.ts", "utf8");
  assert.ok(src.indexOf("asksAboutRecord(question)") < src.indexOf("!memory.now && !history"),
    "and it is routed before the market-state check, not after it");
  assert.ok(/haven't got a scored record yet/.test(src),
    "with an empty record it says that, rather than blaming the market being closed");
});
