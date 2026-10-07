import { call, member, idOf, T, iso, spends, balances, setNow, T0, story, storyOf, fail, type Row } from "./_routes";
import { test } from "node:test";
import assert from "node:assert/strict";
import { GENX_FAIR_USE_PER_DAY } from "../src/lib/creditConfig";

/*
 * A FLOW Pass covers every GENX and GEN FX read (owner 10-07: "this person bought the flow pass, but
 * it's saying he needs more credits"). The Pass had a fair-use count on those reads — 100 in a day —
 * and past it the member was handed back to the meter: a Pass holder ran 100 reads inside 23 hours,
 * his next nine took 45 of his 50 credits, and GENX then refused him for being out of credits.
 *
 * These call the real handlers (tests/_routes.ts) and hold what fair use is now: a limit on how many
 * reads a day the AI writes up, and nothing else. Past it the read is still served, still free, with
 * the engine's own summary where the story would be. Everyone without a Pass is on the meter as before.
 */
let clock = T0;
/** Move the clock on. Two minutes outlives every cache a handler keeps between requests. */
const later = (ms = 2 * 60_000): void => { clock += ms; setNow(clock); };
const HOUR = 3600_000, DAY = 24 * HOUR;
const flowPass = (token: string, o: Row = {}) => { T("user_subscriptions").push({ user_id: idOf(token), plan: "flow_pass", status: "active", stripe_customer_id: null, stripe_subscription_id: null, current_period_end: iso(clock + 30 * DAY), cancel_at_period_end: false, canceled_at: null, ...o }); };
/** `n` covered reads already in this member's ledger, each `agoMs` old. */
const covered = (token: string, n: number, agoMs = HOUR) => { for (let i = 0; i < n; i++) T("credit_transactions").push({ id: `seeded-${token}-${agoMs}-${i}`, user_id: idOf(token), kind: "pass", feature: "genx", amount: 0, created_at: iso(clock - agoMs) }); };
const counted = (token: string): number => T("credit_transactions").filter((r) => r.user_id === idOf(token) && r.kind === "pass" && r.feature === "genx").length;
const genx = (t: string) => call("genx", "POST", "/api/genx", t, { mode: "intraday" });
const genfx = (t: string) => call("genfx", "POST", "/api/genfx", t, { pair: "EURUSD", mode: "intraday" });
const ghost = (t: string) => call("xaughost", "POST", "/api/xaughost", t, { symbol: "XAU/USD" });
const floor = (t: string) => call("floor/setup", "GET", "/api/floor/setup?mode=intraday&fresh=1", t);
const tap = (t: string) => call("setups/pass", "POST", "/api/setups/pass", t);
/** Every level of a read, as it would be printed. */
const levelsOf = (g: Row | null | undefined): string[] => (g ? [g.entry, g.entry_low, g.entry_high, g.stop_loss, g.tp1, g.tp2, g.tp3, g.invalidation_price, g.closest_support, g.closest_resistance] : []).filter((x) => typeof x === "number").map(String);
const told = ["Price has been drifting inside its range.", "Neither side has the edge yet."];
/** The story service, answering — and counting how often it was asked. */
const service = (): { asked: number } => { const s = { asked: 0 }; process.env.ANTHROPIC_API_KEY = "test-key"; story.reply = () => { s.asked++; return storyOf(told); }; return s; };
const serviceOff = (): void => { delete process.env.ANTHROPIC_API_KEY; story.reply = null; };
// The owner's GEN FX billing switch, on — as it is in production: a GEN FX read is priced as a GENX read is.
T("genfx_control").push({ id: 1, scan_enabled: true, auto_enabled: false, auto_scope: "owner", billing_enabled: true, telegram_enabled: false, config: {}, replay_request: null, updated_at: iso(T0) });

test("fair use is 100 reads a day unless the environment says otherwise", () => {
  assert.equal(process.env.GENX_FAIR_USE_PER_DAY, undefined);
  assert.equal(GENX_FAIR_USE_PER_DAY, 100);
});

test("past fair use a Pass holder is still served and never charged: not refused with 2 credits or with none, nothing taken from 50", async () => {
  const ai = service();
  try {
    // The member this was written for: on the Pass, 100 covered reads inside a day, 2 credits left.
    const m = member("pass-heavy", { credits: 2 }); flowPass(m); covered(m, GENX_FAIR_USE_PER_DAY);
    const tools: [string, () => Promise<{ status: number; json: Row; text: string }>, (j: Row) => Row, string][] = [["GENX", () => genx(m), (j) => j.genx, "genx_signals"], ["GEN FX", () => genfx(m), (j) => j.genfx, "genfx_signals"]];
    for (const [name, run, readOf, table] of tools) {
      const r = await run();
      assert.equal(r.status, 200, `${name}: he is not told he is out of credits — ${r.text.slice(0, 200)}`);
      const read = readOf(r.json);
      // The whole read, every number the engine's — the plan is in it…
      assert.ok(levelsOf(read).length >= 3, `${name}: the plan is in the read`);
      // …and the engine's own summary where the story would be.
      assert.ok(Array.isArray(read.market_story) && read.market_story.length >= 1 && read.market_story.every((s: unknown) => typeof s === "string" && s.length > 0), `${name}: a summary is there`);
      assert.ok(!read.market_story.some((s: string) => told.includes(s)), `${name}: and it is not the AI's`);
      // It is on record like any other read.
      assert.equal(T(table).filter((x) => x.user_id === idOf(m)).length, 1, `${name}: recorded`);
    }
    assert.equal(T("genfx_signals").find((x) => x.user_id === idOf(m))!.model_version, null, "GEN FX records that no model wrote this one");
    assert.equal(ai.asked, 0, "the AI was not asked");
    assert.deepEqual([spends(m), balances.get(idOf(m))], [[], 2], "nothing was taken");
    assert.equal(counted(m), GENX_FAIR_USE_PER_DAY, "and these reads are not counted: the count is of stories");
    // The cards the same play is kept back on are open to him, and the button takes nothing either.
    assert.ok(levelsOf((await floor(m)).json.g).length >= 3, "the Floor's card is open");
    const t = await tap(m);
    assert.deepEqual([t.status, t.json.open, t.json.via, t.json.charged], [200, true, "pass", false]);
    // With no credits at all it is the same: the Pass is what pays for the read, not the balance.
    later();
    balances.set(idOf(m), 0);
    for (const [name, run, readOf] of tools) {
      const r = await run();
      assert.deepEqual([r.status, levelsOf(readOf(r.json)).length >= 3], [200, true], `${name} with no credits: ${r.text.slice(0, 160)}`);
    }
    assert.deepEqual([ai.asked, spends(m), balances.get(idOf(m)), counted(m)], [0, [], 0, GENX_FAIR_USE_PER_DAY]);
    // And with his month's 50 in hand — where that member was when it started — none of them are taken.
    const full = member("pass-heavy-50", { credits: 50 }); flowPass(full); covered(full, GENX_FAIR_USE_PER_DAY);
    for (const run of [genx, genx, genfx]) assert.equal((await run(full)).status, 200);
    assert.deepEqual([ai.asked, spends(full), balances.get(idOf(full)), counted(full)], [0, [], 50, GENX_FAIR_USE_PER_DAY]);
  } finally { serviceOff(); }
});

test("within fair use the AI writes the story and the read is counted; the hundredth is the last it writes that day", async () => {
  later();
  const ai = service();
  try {
    // (These members hold credits: a charge could not hide behind a balance too small to take it from.)
    const m = member("pass-99", { credits: 50 }); flowPass(m); covered(m, GENX_FAIR_USE_PER_DAY - 1);
    const first = await genx(m);
    assert.deepEqual([first.status, first.json.genx.market_story], [200, told]);
    assert.deepEqual([ai.asked, counted(m), spends(m), balances.get(idOf(m))], [1, GENX_FAIR_USE_PER_DAY, [], 50]);
    // The next one, a GEN FX read: the two tools share the count, as they share the price.
    later();
    const second = await genfx(m);
    assert.equal(second.status, 200, second.text.slice(0, 200));
    assert.ok(levelsOf(second.json.genfx).length >= 3 && !second.json.genfx.market_story.some((s: string) => told.includes(s)));
    assert.deepEqual([ai.asked, counted(m), spends(m), balances.get(idOf(m))], [1, GENX_FAIR_USE_PER_DAY, [], 50]);
    // A Pass holder nowhere near it: story, one line in the ledger, nothing spent. What counts is his
    // own covered reads and nothing else — not the reads he paid for before he had the Pass, not the
    // Pass's other lines, not another member's hundred.
    later();
    const light = member("pass-light", { credits: 50 }); flowPass(light);
    for (let i = 0; i < GENX_FAIR_USE_PER_DAY + 20; i++) {
      T("credit_transactions").push({ id: `paid-before-${i}`, user_id: idOf(light), kind: "spend", feature: "genx", amount: -5, created_at: iso(clock - 2 * HOUR) });
      T("credit_transactions").push({ id: `autorun-${i}`, user_id: idOf(light), kind: "pass", feature: "flow_autorun", amount: 0, created_at: iso(clock - 2 * HOUR) });
    }
    assert.deepEqual((await genx(light)).json.genx.market_story, told);
    assert.deepEqual([ai.asked, counted(light), balances.get(idOf(light))], [2, 1, 50]);
    // A GEN FX read on the Pass is the same: written up, counted, free.
    const fxRead = await genfx(light);
    assert.deepEqual([fxRead.status, fxRead.json.genfx.market_story], [200, told]);
    assert.deepEqual([ai.asked, counted(light), balances.get(idOf(light))], [3, 2, 50]);
    assert.equal(spends(light).length, GENX_FAIR_USE_PER_DAY + 20, "no new spend");
  } finally { serviceOff(); }
});

test("the count is of the last 24 hours: as the day's reads age out, the story comes back", async () => {
  later();
  const ai = service();
  try {
    const m = member("pass-aging", { credits: 50 }); flowPass(m);
    // A hundred reads, the newest of them 23 hours 59 minutes old; and, older than a day, a hundred more that no longer count.
    covered(m, GENX_FAIR_USE_PER_DAY, DAY - 60_000); covered(m, GENX_FAIR_USE_PER_DAY, DAY + HOUR);
    const before = await genx(m);
    assert.equal(before.status, 200);
    assert.ok(!before.json.genx.market_story.some((s: string) => told.includes(s)));
    assert.equal(ai.asked, 0);
    // Two minutes on they are more than a day old.
    later();
    const after = await genx(m);
    assert.deepEqual([after.status, after.json.genx.market_story, ai.asked], [200, told, 1]);
    assert.equal(counted(m), 2 * GENX_FAIR_USE_PER_DAY + 1, "and that one is counted");
    assert.deepEqual([spends(m), balances.get(idOf(m))], [[], 50]);
    // One short of the number, all inside the day: still written up.
    later();
    const n = member("pass-under", { credits: 50 }); flowPass(n); covered(n, GENX_FAIR_USE_PER_DAY - 1, DAY - 10 * 60_000);
    assert.deepEqual((await genx(n)).json.genx.market_story, told);
    assert.deepEqual([spends(n), balances.get(idOf(n))], [[], 50]);
  } finally { serviceOff(); }
});

test("without an active Pass a member is on the meter exactly as before — a Pass that has ended, another plan, no plan", async () => {
  later();
  const ai = service();
  try {
    const ended: [string, Row | null][] = [
      ["the period has run out", { current_period_end: iso(clock - HOUR) }],
      ["cancelled", { status: "canceled" }],
      ["payment failed", { status: "past_due" }],
      ["the old Suite plan", { plan: "trading_suite" }],
      ["no plan at all", null],
    ];
    for (const [why, sub] of ended) {
      // Too few credits for a read: refused, whatever a Pass once covered.
      const short = member(`short-${why}`, { credits: 4 }); if (sub) flowPass(short, sub); covered(short, 3);
      for (const run of [genx, genfx]) {
        const r = await run(short);
        assert.deepEqual([r.status, r.json.error], [402, "insufficient_credits"], why);
      }
      assert.deepEqual([spends(short), balances.get(idOf(short))], [[], 4], why);
      // Enough for one: served with the story, and charged for it.
      const paid = member(`paid-${why}`, { credits: 12 }); if (sub) flowPass(paid, sub);
      const asked = ai.asked;
      const r = await genx(paid);
      assert.deepEqual([r.status, r.json.genx.market_story, ai.asked - asked], [200, told, 1], why);
      assert.deepEqual([spends(paid), balances.get(idOf(paid)), counted(paid)], [["genx -5"], 7, 0], why);
      later();
    }
    // A member past the number with no Pass is simply a member: the number is the Pass's, not theirs.
    const many = member("no-pass-many", { credits: 12 }); covered(many, GENX_FAIR_USE_PER_DAY + 5);
    const r = await genx(many);
    assert.deepEqual([r.status, r.json.genx.market_story, spends(many), balances.get(idOf(many))], [200, told, ["genx -5"], 7]);
  } finally { serviceOff(); }
});

test("the Pass covers GENX and GEN FX reads and nothing more: MFX Ghost still takes credits", async () => {
  later();
  const m = member("pass-ghost", { credits: 4 }); flowPass(m);
  const refused = await ghost(m);
  assert.deepEqual([refused.status, refused.json.error], [402, "insufficient_credits"]);
  balances.set(idOf(m), 12);
  assert.equal((await ghost(m)).status, 200);
  assert.deepEqual([spends(m), balances.get(idOf(m)), counted(m)], [["ghost -5"], 7, 0]);
});

test("when the count cannot be read a confirmed Pass still covers the read, story and all; when the Pass cannot be confirmed the member is metered", async () => {
  later();
  const ai = service();
  try {
    // The ledger is unreadable: how many reads he has had cannot be counted. The Pass is confirmed, so the read is covered.
    const m = member("pass-dark", { credits: 50 }); flowPass(m); covered(m, GENX_FAIR_USE_PER_DAY);
    fail.tables.add("credit_transactions");
    try {
      const r = await genx(m);
      assert.deepEqual([r.status, r.json.genx.market_story, ai.asked], [200, told, 1]);
    } finally { fail.tables.delete("credit_transactions"); }
    assert.deepEqual([spends(m), balances.get(idOf(m))], [[], 50]);
    // The Pass itself cannot be looked up: that fails closed, as it always has (subscription.ts) — no
    // Pass is assumed, so a member with too few credits is refused and one with enough is charged.
    later();
    const short = member("pass-unconfirmed", { credits: 2 }); flowPass(short);
    const paid = member("pass-unconfirmed-paid", { credits: 12 }); flowPass(paid);
    fail.tables.add("user_subscriptions");
    try {
      const r = await genx(short);
      assert.deepEqual([r.status, r.json.error], [402, "insufficient_credits"]);
      assert.equal((await genx(paid)).status, 200);
    } finally { fail.tables.delete("user_subscriptions"); }
    assert.deepEqual([spends(short), spends(paid), balances.get(idOf(paid))], [[], ["genx -5"], 7]);
  } finally { serviceOff(); }
});
