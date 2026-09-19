import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { mapFedEvents, parseBlsPage } from "../command-center/adapters/econCalendar";

const ny = (ms: number) => new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short",
}).format(new Date(ms));

/*
 * A CONTROL THAT STOPS REAL MONEY SHOULD NOT SIT BEHIND SOMEBODY'S FREE TIER.
 *
 * The first calendar called a commercial API and came back 403 — the endpoint was premium. These
 * events now come from the Federal Reserve and the Bureau of Labor Statistics, who create them.
 */
test("it reads the organisations that publish the events", async () => {
  const src = await fs.readFile("command-center/adapters/econCalendar.ts", "utf8");
  assert.ok(/federalreserve\.gov\/json\/calendar\.json/.test(src));
  assert.ok(/bls\.gov\/schedule\/news_release\/cpi\.htm/.test(src));
  assert.ok(/empsit\.htm/.test(src), "payrolls, which is the one that moves gold hardest");
  // No key anywhere: nothing here can be switched off by a vendor.
  assert.ok(!/API_KEY|token=|apikey/i.test(src), "no credential is involved at all");
});

/*
 * THE DECISION LANDS ON THE SECOND DAY.
 *
 * `days` is a string and a two-day meeting reads "9-10". Taking the first number would place the
 * lockout a full day before the statement — open during the event it exists to avoid.
 */
test("a two-day FOMC meeting is dated on the day the statement drops", () => {
  const got = mapFedEvents({ events: [
    { title: "FOMC Meeting", time: "2:00 p.m.", month: "2026-12", days: "9-10", type: "FOMC" },
  ]});
  assert.equal(got.length, 1);
  assert.match(ny(got[0].at), /^Dec 10, 2026, 2:00 PM$/);
  assert.equal(got[0].importance, "high");
  assert.equal(got[0].timeKnown, true);
});

test("speeches are not treated as market events on this instrument", () => {
  const got = mapFedEvents({ events: [
    { title: "Speech - Governor Michael S. Barr", time: "10:05 a.m.", month: "2026-09", days: "23", type: "Speeches" },
    { title: "G.5 - Foreign Exchange Rates", time: "4:15 p.m.", month: "2026-12", days: "1", type: "Stat" },
    { title: "FOMC Minutes", time: "2:00 p.m.", month: "2026-12", days: "30", type: "FOMC" },
  ]});
  assert.deepEqual(got.map((e) => e.name), ["FOMC Minutes"], "only the one that moves gold survives");
});

/*
 * THE OFFSET HAS TO BE RECOVERED, NOT ASSUMED.
 *
 * Both sources publish wall-clock Eastern with no offset. A fixed -5 would put every release an hour
 * wrong for eight months of the year, and the lockout would open exactly when it should be shut.
 */
test("Eastern time is resolved correctly on both sides of the clock change", () => {
  const rows = parseBlsPage(
    "Oct. 14, 2026 | 08:30 AM  Nov. 10, 2026 | 08:30 AM",
    "US Consumer Price Index");
  assert.equal(rows.length, 2);
  assert.match(ny(rows[0].at), /^Oct 14, 2026, 8:30 AM$/);   // daylight time
  assert.match(ny(rows[1].at), /^Nov 10, 2026, 8:30 AM$/);   // standard time
  // And they really are different UTC offsets, which is the thing being tested.
  assert.notEqual(new Date(rows[0].at).getUTCHours(), new Date(rows[1].at).getUTCHours());
});

test("a schedule page with no usable rows yields nothing rather than a guess", () => {
  assert.deepEqual(parseBlsPage("<p>The schedule will be posted shortly.</p>", "US Consumer Price Index"), []);
});

/*
 * THE GAP THAT NO OFFICIAL SOURCE FILLS.
 *
 * A release moves gold through the SURPRISE against consensus, and nobody official publishes what
 * economists expected. The packet has to say so, or the model will imply a forecast it does not have.
 */
test("the absent consensus forecast is declared, not papered over", async () => {
  const src = await fs.readFile("command-center/adapters/calendar.ts", "utf8");
  assert.ok(/consensus/i.test(src));
  assert.ok(/never what it is expected to be/.test(src), "and it is told not to invent one");
});

test("a stale feed must not look like a quiet week", async () => {
  const src = await fs.readFile("command-center/adapters/calendar.ts", "utf8");
  assert.ok(/UNREACHABLE/.test(src), "an unreachable source says so");
  assert.ok(/never guess a date/.test(src));
  // Per-source failure: losing one must not lose the other.
  assert.ok(/fedEvents\(\)\.catch/.test(src) && /blsEvents\(\)\.catch/.test(src));
});
