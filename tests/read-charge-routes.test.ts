import { call, member, idOf, T, iso, spends, balances, setNow, T0, FEED, calls, story, storyOf, fail, type Row } from "./_routes";
import { test } from "node:test";
import assert from "node:assert/strict";

/*
 * A read that shows a plan is a read that is paid for (owner 10-06) — the three tools' handlers, called
 * as the site calls them (tests/_routes.ts). The rule itself is in tests/read-charge.test.ts; these
 * hold that GENX, GEN FX and MFX Ghost each charge by it, once, and that a charged read opens the
 * cards the same play is kept back on.
 */
let clock = T0;
/** Move the clock on. Two minutes outlives every cache a handler keeps between requests. */
const later = (ms = 2 * 60_000): void => { clock += ms; setNow(clock); };
const flowPass = (token: string) => { T("user_subscriptions").push({ user_id: idOf(token), plan: "flow_pass", status: "active", stripe_customer_id: null, stripe_subscription_id: null, current_period_end: iso(clock + 30 * 86_400_000), cancel_at_period_end: false, canceled_at: null }); };
const floor = (token: string, q = "mode=intraday&fresh=1") => call("floor/setup", "GET", `/api/floor/setup?${q}`, token);
const tap = (token: string) => call("setups/pass", "POST", "/api/setups/pass", token);
/** Every level of a read, as it would be printed. */
const levelsOf = (g: Row | null | undefined): string[] => (g ? [g.entry, g.entry_low, g.entry_high, g.stop_loss, g.tp1, g.tp2, g.tp3, g.invalidation_price, g.closest_support, g.closest_resistance] : []).filter((x) => typeof x === "number").map(String);
// The owner's GEN FX billing switch, on — as it is in production.
T("genfx_control").push({ id: 1, scan_enabled: true, auto_enabled: false, auto_scope: "owner", billing_enabled: true, telegram_enabled: false, config: {}, replay_request: null, updated_at: iso(T0) });

test("a read that shows a plan is paid for, in all three tools — and paying for one opens the cards", async () => {
  const tools: [string, string, Row, string, (j: Row) => Row][] = [
    ["GENX", "genx", { mode: "intraday" }, "genx -5", (j) => j.genx],
    ["GEN FX", "genfx", { pair: "EURUSD", mode: "intraday" }, "genx -5", (j) => j.genfx],
    ["MFX Ghost", "xaughost", { symbol: "XAU/USD" }, "ghost -5", (j) => j.read],
  ];
  for (const [name, route, body, line, readOf] of tools) {
    const m = member(`read-${route}`, { credits: 12 });
    assert.equal((await floor(m)).json.g, null, name);
    const r = await call(route, "POST", `/api/${route}`, m, body);
    assert.equal(r.status, 200, `${name}: ${r.text.slice(0, 200)}`);
    const read = readOf(r.json);
    // On this market the engine has no setup of its own — the case that used to be free — and still hands over a plan.
    assert.ok(["NO_TRADE", "WATCHLIST"].includes(read.engine_state ?? read.state), `${name}: ${read.engine_state ?? read.state}`);
    assert.ok(route === "xaughost" ? typeof read.levels?.support === "number" && typeof read.levels?.resistance === "number" : levelsOf(read).length >= 3, `${name} carries a plan`);
    assert.deepEqual([spends(m), balances.get(idOf(m))], [[line], 7], `${name}: one read, one charge`);
    // The same play on the cards is open to them now.
    assert.ok(levelsOf((await floor(m)).json.g).length >= 3, `${name}: the card opens`);
    assert.equal((await tap(m)).json.charged, false, `${name}: and the button does not charge them again`);
  }
});

test("a read with nothing in it to trade from is still free; too few credits is refused before any work; a Pass is not charged", async () => {
  later();
  const m = member("thin-read", { credits: 12 });
  FEED["XAU/USD"].thin = true;
  try {
    const gx = await call("genx", "POST", "/api/genx", m, { mode: "swing" });
    assert.ok(gx.status === 200 && levelsOf(gx.json.genx).length === 0, gx.text.slice(0, 160));
    const ghost = await call("xaughost", "POST", "/api/xaughost", m, { symbol: "XAU/USD" });
    assert.deepEqual([ghost.status, ghost.json.read.state, ghost.json.read.levels ?? null], [200, "INSUFFICIENT_DATA", null]);
  } finally { FEED["XAU/USD"].thin = false; }
  assert.deepEqual([spends(m), balances.get(idOf(m))], [[], 12]);
  // Not enough for a read: refused before the market is even asked.
  later();
  const short = member("short-read", { credits: 4 });
  for (const [route, body] of [["genx", { mode: "intraday" }], ["genfx", { pair: "EURUSD", mode: "intraday" }], ["xaughost", { symbol: "XAU/USD" }]] as const) {
    const asked = calls.filter((c) => c.includes("twelvedata")).length;
    const r = await call(route, "POST", `/api/${route}`, short, body);
    assert.deepEqual([r.status, r.json.error], [402, "insufficient_credits"], route);
    assert.equal(calls.filter((c) => c.includes("twelvedata")).length, asked, `${route}: no market data was spent on it`);
  }
  assert.deepEqual([spends(short), balances.get(idOf(short))], [[], 4]);
  // A FLOW Pass covers GENX and GEN FX reads: served, logged, nothing spent. (Ghost is not on the Pass.)
  const pass = member("pass-read", { credits: 12 }); flowPass(pass);
  assert.ok(levelsOf((await call("genx", "POST", "/api/genx", pass, { mode: "intraday" })).json.genx).length >= 3);
  assert.deepEqual([spends(pass), balances.get(idOf(pass))], [[], 12]);
  assert.equal(T("credit_transactions").filter((r) => r.user_id === idOf(pass) && r.kind === "pass" && r.feature === "genx" && r.amount === 0).length, 1);
});

test("the story is another service's: nothing is taken before it answers, and a read is paid for once whether it answers or not", async () => {
  later();
  const tools: [string, string, Row, string, (j: Row) => string[]][] = [
    ["GENX", "genx", { mode: "intraday" }, "genx -5", (j) => j.genx.market_story],
    ["GEN FX", "genfx", { pair: "EURUSD", mode: "intraday" }, "genx -5", (j) => j.genfx.market_story],
    ["MFX Ghost", "xaughost", { symbol: "XAU/USD" }, "ghost -5", (j) => j.read.desk_read],
  ];
  const told = ["Price has been drifting inside its range.", "Neither side has the edge yet."];
  process.env.ANTHROPIC_API_KEY = "test-key";
  try {
    for (const [name, route, body, line, storyIn] of tools) {
      // It answers. At the moment it is asked, the member has been charged nothing.
      const m = member(`story-${route}`, { credits: 12 });
      const seen: { spends: string[]; limit: unknown }[] = [];
      story.reply = (init) => { seen.push({ spends: spends(m), limit: init?.signal ?? null }); return storyOf(told); };
      const r = await call(route, "POST", `/api/${route}`, m, body);
      assert.equal(r.status, 200, `${name}: ${r.text.slice(0, 200)}`);
      assert.deepEqual(seen.map((x) => x.spends), [[]], `${name}: asked once, with nothing yet taken`);
      assert.deepEqual(storyIn(r.json), told, `${name}: the story is in the read`);
      assert.deepEqual([spends(m), balances.get(idOf(m))], [[line], 7], `${name}: one read, one charge`);
      // Ghost's wait for it has an end.
      if (route === "xaughost") assert.ok(seen[0].limit instanceof AbortSignal, "the story call carries a time limit");
      // It is down. The read still comes, in the engine's own words, and is paid for once.
      later();
      const d = member(`down-${route}`, { credits: 12 });
      // (Recorded here and checked after the call: the handler catches whatever its story call throws,
      // so a check made in here could not fail the test.)
      const takenWhenAsked: string[][] = [];
      story.reply = () => { takenWhenAsked.push(spends(d)); throw new Error("harness: the story service is down"); };
      const lost = await call(route, "POST", `/api/${route}`, d, body);
      assert.equal(lost.status, 200, name);
      assert.deepEqual(takenWhenAsked, [[]], `${name}: asked once, with nothing yet taken`);
      assert.ok(Array.isArray(storyIn(lost.json)) && storyIn(lost.json).length >= 1 && !storyIn(lost.json).includes(told[0]), `${name}: the engine's own words stand in`);
      assert.deepEqual([spends(d), balances.get(idOf(d))], [[line], 7], `${name}: still one charge`);
      // It answers with something that is not a story: the same.
      later();
      const j = member(`junk-${route}`, { credits: 12 });
      story.reply = () => new Response("upstream timed out", { status: 504 });
      const junk = await call(route, "POST", `/api/${route}`, j, body);
      assert.equal(junk.status, 200, name);
      assert.ok(storyIn(junk.json).length >= 1, name);
      assert.deepEqual([spends(j), balances.get(idOf(j))], [[line], 7], name);
      later();
    }
    // A read with nothing in it to trade from asks for no story and takes nothing.
    const thin = member("story-thin", { credits: 12 });
    let asked = 0; story.reply = () => { asked++; return storyOf(told); };
    FEED["XAU/USD"].thin = true;
    try { assert.equal((await call("xaughost", "POST", "/api/xaughost", thin, { symbol: "XAU/USD" })).json.read.state, "INSUFFICIENT_DATA"); } finally { FEED["XAU/USD"].thin = false; }
    assert.deepEqual([asked, spends(thin), balances.get(idOf(thin))], [0, [], 12]);
  } finally { delete process.env.ANTHROPIC_API_KEY; story.reply = null; }
});

test("MFX Ghost takes its credits last — and a read whose credits have gone by then is refused, not given away", async () => {
  later();
  const ghost = (t: string, symbol = "XAU/USD") => call("xaughost", "POST", "/api/xaughost", t, { symbol });
  const told = ["Price has been drifting inside its range."];
  process.env.ANTHROPIC_API_KEY = "test-key";
  try {
    // Credits for one read. While its story is being written another read of theirs takes them.
    const m = member("ghost-gone", { credits: 5 });
    story.reply = () => { balances.set(idOf(m), 0); return storyOf(told); };
    const r = await ghost(m);
    assert.deepEqual([r.status, r.json], [402, { error: "insufficient_credits", balance: { dailyLeft: 0, purchased: 0, dailyAllowance: 5 } }]);
    assert.ok(!r.text.includes("support") && !r.text.includes("desk_read"), "nothing of the read is in the refusal");
    assert.deepEqual([spends(m), balances.get(idOf(m))], [[], 0], "and nothing was taken for it");
    // Two reads at once on credits for one: one is delivered and paid for, the other refused.
    later();
    const two = member("ghost-two", { credits: 5 });
    let waiting: (() => void)[] = [];
    story.reply = () => new Promise<Response>((res) => { waiting.push(() => res(storyOf(told))); });
    const both = [ghost(two, "XAU/USD"), ghost(two, "EUR/USD")];
    for (let i = 0; i < 400 && waiting.length < 2; i++) await new Promise((res) => setImmediate(res));
    assert.equal(waiting.length, 2, "both reads are at their story, both past the door, neither charged");
    assert.deepEqual(spends(two), []);
    for (const go of waiting) go(); waiting = [];
    const [a, b] = await Promise.all(both);
    assert.deepEqual([a.status, b.status].sort(), [200, 402]);
    assert.deepEqual([spends(two), balances.get(idOf(two))], [["ghost -5"], 0]);
    // The credit system cannot be reached at the end: that still fails open, as it does everywhere — the read is delivered.
    later();
    const dark = member("ghost-dark", { credits: 12 });
    story.reply = () => storyOf(told);
    fail.rpc.add("spend_credits");
    try { const d = await ghost(dark); assert.deepEqual([d.status, d.json.read.desk_read], [200, told]); } finally { fail.rpc.delete("spend_credits"); }
    assert.deepEqual([spends(dark), balances.get(idOf(dark))], [[], 12]);
    // …and so does a spend that fails with the balance unreadable too.
    later();
    fail.rpc.add("spend_credits"); fail.rpc.add("get_credit_balance");
    try { assert.equal((await ghost(dark)).status, 200); } finally { fail.rpc.delete("spend_credits"); fail.rpc.delete("get_credit_balance"); }
  } finally { delete process.env.ANTHROPIC_API_KEY; story.reply = null; }
});
