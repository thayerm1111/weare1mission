import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { parseWindow, isRetrospective, measure, retrospectiveLines } from "../command-center/engines/history";
import { wantsDomainKnowledge, GOLD_KNOWLEDGE } from "../command-center/brain/gold";

const NOW = Date.parse("2026-09-19T20:00:00Z");
const DAY = 86_400_000;

/*
 * THE BUG THIS FILE EXISTS FOR.
 *
 * Asked "what happened to gold last week", THE BRAIN said the market was closed. Twice. The market
 * being shut has nothing to do with a question about finished history — everything was being routed
 * through one live snapshot, so a missing tick silenced the entire system.
 */
test("a question about the past is recognised as one", () => {
  for (const q of [
    "what happened to gold last week?",
    "No, I said, what happened to gold last week?",
    "what did it do yesterday",
    "how did gold move over the last 3 days",
    "what has this month looked like",
  ]) assert.ok(isRetrospective(q, NOW), `should look back: ${q}`);
});

test("a question about right now does not pay for a history fetch", () => {
  for (const q of [
    "where is gold trading",
    "how's my trade",
    "is there a setup",
    "why do you like the long",
    "what are you watching",
  ]) assert.ok(!isRetrospective(q, NOW), `should not look back: ${q}`);
});

test("the window is read on a chart that suits its length", () => {
  // A week told in one-minute bars is noise; a day told in daily bars is one candle.
  assert.equal(parseWindow("last week", NOW)?.tf, "4h");
  assert.equal(parseWindow("today", NOW)?.tf, "15m");
  assert.equal(parseWindow("the last month", NOW)?.tf, "1d");
});

/*
 * EVERY NUMBER IS ARITHMETIC OVER REAL BARS.
 *
 * This is the property that matters: the model describes a measurement rather than recalling an
 * impression. A system that can invent last week's range is worse than one that says it doesn't know.
 */
test("the measurement is arithmetic, and it is right", () => {
  const path = [
    [4000, 4030, 3990, 4025], [4025, 4060, 4015, 4055], [4055, 4100, 4050, 4095],
    [4095, 4098, 4020, 4030], [4030, 4045, 4005, 4040], [4040, 4060, 4030, 4050],
    [4050, 4055, 4040, 4050],
  ];
  const bars = path.map((p, i) => ({ t: NOW - (7 - i) * DAY, o: p[0], h: p[1], l: p[2], c: p[3] }));
  const m = measure(parseWindow("last week", NOW)!, bars)!;
  assert.equal(m.open, 4000);
  assert.equal(m.close, 4050);
  assert.equal(m.high, 4100);
  assert.equal(m.low, 3990);
  assert.equal(Math.round(m.movePips), 500);   // gold's pip is 0.10, so $50 is 500 pips
  assert.equal(Math.round(m.rangePips), 1100);
  assert.equal(m.direction, "up");
});

test("a round trip is called sideways, not a trend", () => {
  // Covered ground and gave it all back. Calling that "up" because the close was a dollar higher is
  // the false precision this system exists to avoid.
  const bars = [
    { t: NOW - 3 * DAY, o: 4000, h: 4090, l: 3995, c: 4080 },
    { t: NOW - 2 * DAY, o: 4080, h: 4085, l: 3990, c: 4005 },
    { t: NOW - 1 * DAY, o: 4005, h: 4020, l: 3998, c: 4001 },
  ];
  assert.equal(measure(parseWindow("the last 3 days", NOW)!, bars)!.direction, "sideways");
});

test("not enough bars produces nothing rather than a guess", () => {
  assert.equal(measure(parseWindow("last week", NOW)!, [{ t: NOW, o: 1, h: 1, l: 1, c: 1 }]), null);
});

/*
 * THE HONESTY CLAUSE.
 *
 * Nothing has ever been written to cc_snapshots or cc_brain_thesis — they are empty. So "what did you
 * think on Tuesday" genuinely has no answer, and reconstructing a past opinion to match a known
 * outcome is the most dishonest thing a trading system can do.
 */
test("measured history is never presented as a recorded opinion", () => {
  const bars = [
    { t: NOW - 2 * DAY, o: 4000, h: 4050, l: 3990, c: 4040 },
    { t: NOW - 1 * DAY, o: 4040, h: 4060, l: 4030, c: 4055 },
  ];
  const lines = retrospectiveLines(measure(parseWindow("last week", NOW)!, bars)!).join("\n");
  assert.ok(/NOT a record of what THE BRAIN thought/.test(lines), "the packet says so in the packet itself");
  assert.ok(/do not claim to have called any of it/i.test(lines));
});

/* ── the domain knowledge ─────────────────────────────────────────────── */

test("a question about mechanism gets the background, a question about price does not", () => {
  for (const q of ["how does news affect gold this week", "why does the dollar matter", "what moves gold",
    "when is the next fed meeting", "explain real yields"]) {
    assert.ok(wantsDomainKnowledge(q), `should carry background: ${q}`);
  }
  for (const q of ["where is gold", "how's my trade", "close half"]) {
    assert.ok(!wantsDomainKnowledge(q), `should not: ${q}`);
  }
});

/*
 * THE LINE THE BACKGROUND MUST NOT CROSS.
 *
 * "Gold usually falls when real yields rise" is a mechanism. "Gold is falling because real yields are
 * rising" is a claim about right now, and nothing in the background licenses it. A model that blurs
 * the two narrates things it cannot see.
 */
test("the background never licenses a claim about the current market", () => {
  assert.ok(/NOT current data/i.test(GOLD_KNOWLEDGE), "it says what it is in its own heading");
  // The prose is wrapped, so the check has to be too — a line break is not a missing sentence.
  assert.ok(/never\s+evidence about what is happening right now/i.test(GOLD_KNOWLEDGE));
  assert.ok(/must come from the measured context/i.test(GOLD_KNOWLEDGE));
  // No prices, no dates — a file that quietly ages into being wrong is worse than one that says less.
  assert.ok(!/\$\s?\d{3,}/.test(GOLD_KNOWLEDGE), "no price levels that go stale");
  assert.ok(!/\b20\d\d\b/.test(GOLD_KNOWLEDGE), "no years that date it");
});

/* ── the routing fix itself ───────────────────────────────────────────── */

test("a closed market no longer silences questions that need no tick", async () => {
  const src = await fs.readFile("command-center/brain/voiceLlm.ts", "utf8");
  assert.ok(/!memory\.now && !history && !needsBackground/.test(src),
    "refusal requires all three sources to be empty, not just the live one");
  assert.ok(/nothing below is a current price/.test(src),
    "and when it answers anyway, it says the price is not live");
  // Both surfaces, or the app and the web disagree about what can be asked.
  const brain = await fs.readFile("src/app/api/command-center/brain/route.ts", "utf8");
  assert.ok(/isRetrospective/.test(brain) && /wantsDomainKnowledge/.test(brain),
    "the typed console gets the same two sources");
});

/*
 * "BUT WHAT ABOUT FRIDAY AND THURSDAY, WHERE THE HIGH AND THE LOW WAS?"
 *
 * Answered with "gold is closed." The fourth time that refusal has landed on a perfectly reasonable
 * question, and the single most damaging thing this system does — it makes an intelligent product
 * look stupid. The parser only knew the word "last".
 */
test("a named weekday is a question about the past", () => {
  for (const q of [
    "But what about, you know, based on Friday and Thursday of where the high and the low was?",
    "where was the high on Thursday",
    "what did Monday look like",
  ]) assert.ok(isRetrospective(q, NOW), q);

  assert.equal(parseWindow("where was the high on Thursday", NOW)?.label, "Thursday");
});

test("weekdays are read in the order they were said", () => {
  // Not in calendar order: a member who says "Friday and Thursday" gets those words back.
  assert.equal(
    parseWindow("based on Friday and Thursday of where the high and the low was", NOW)?.label,
    "Friday and Thursday");
});

/*
 * A WEEKDAY CAN POINT FORWARDS AS EASILY AS BACKWARDS.
 *
 * "When the market opens on Sunday" is not a question about last Sunday, and folding it in produced
 * "Sunday and Thursday and Friday" for a question about two of them.
 */
test("a weekday in the future is not treated as history", () => {
  assert.equal(parseWindow("what happens when it opens on Sunday", NOW), null);
  assert.equal(
    parseWindow("based on Friday and Thursday where the high was? When the market opens on Sunday, should it follow the trend?", NOW)?.label,
    "Friday and Thursday",
    "the forward-looking day is excluded and the two real ones survive");
});

/*
 * THE ASYMMETRY THAT SHOULD DRIVE THIS DESIGN.
 *
 * A false positive costs one cached market-data call. A false negative costs a member being told the
 * market is closed in answer to a sensible question. So the past test is deliberately generous.
 */
test("a question shaped like the past is treated as the past even with no period named", () => {
  for (const q of ["how did it close", "did it hold that level", "where was the low"]) {
    assert.ok(isRetrospective(q, NOW), q);
  }
  for (const q of ["where is gold trading", "how is my trade", "is there a setup"]) {
    assert.ok(!isRetrospective(q, NOW), q);
  }
});

test("each session is measured on its own, so two days can be compared", () => {
  const H = 3_600_000;
  const bars = [];
  for (let d = 3; d >= 0; d--) {
    for (let h = 0; h < 6; h++) {
      const base = 4000 + (3 - d) * 10 + h;
      bars.push({ t: NOW - d * DAY - (6 - h) * H, o: base, h: base + 5, l: base - 3, c: base + 1 });
    }
  }
  const m = measure(parseWindow("Thursday and Friday", NOW)!, bars)!;
  assert.ok(m.days.length >= 3, "the window is broken into days");
  for (const d of m.days) {
    assert.ok(d.h >= d.l, "each day has its own high and low");
    assert.ok(d.h >= d.o && d.h >= d.c, "and the high really is the high");
  }
  const lines = retrospectiveLines(m).join("\n");
  assert.ok(/each session separately:/.test(lines));
  assert.ok(/Thursday|Friday|Wednesday/.test(lines), "named by weekday, as the question was");
});
