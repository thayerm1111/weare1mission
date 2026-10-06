import { call, member, idOf, T, ago, iso, spends, balances, fail, setNow, T0, FEED, type Row } from "./_routes";
import { test } from "node:test";
import assert from "node:assert/strict";

/*
 * Live setups take credits to view (owner 10-05, 10-06) — the handlers themselves, called as the site
 * calls them, against a database and a market that answer like the real ones (tests/_routes.ts).
 * tests/setup-lock.test.ts holds the rules; these hold that the routes keep to them: what a member
 * with no window is actually sent, who is actually charged, and that paying actually opens the cards.
 */
let clock = T0;
/** Move the clock on. Two minutes outlives every cache a handler keeps between requests. */
const later = (ms = 2 * 60_000): void => { clock += ms; setNow(clock); };
const MIN = 60_000;
let n = 0;
const spend = (token: string, agoMs: number, o: Row = {}) => { T("credit_transactions").push({ id: `seed-${++n}`, user_id: idOf(token), kind: "spend", feature: "genx", amount: -5, created_at: ago(agoMs), ...o }); };
const flowFee = (token: string, agoMs: number, o: Row = {}) => { T("flow_billing_events").push({ user_id: idOf(token), event_key: `setup:${++n}`, kind: "setup", cost: 1, at: ago(agoMs), ...o }); };
const flowPass = (token: string, o: Row = {}) => { T("user_subscriptions").push({ user_id: idOf(token), plan: "flow_pass", status: "active", stripe_customer_id: null, stripe_subscription_id: null, current_period_end: iso(clock + 30 * 86_400_000), cancel_at_period_end: false, canceled_at: null, ...o }); };
const floor = (token: string | null, q = "mode=intraday&fresh=1") => call("floor/setup", "GET", `/api/floor/setup?${q}`, token);
const tap = (token: string | null) => call("setups/pass", "POST", "/api/setups/pass", token);
const CLOSED = { cost: 5, minutes: 30, open: false, via: null, until: null };
/** The owner, signed in — the one account GEN FX's switches and its scanner's notes belong to (genfx/control.ts OWNER_USER_ID). */
const OWNER = member("the-owner", { id: "3b5e06e5-258c-4880-b1f2-d1623cbca100", role: "admin" });
/** Every level of a read, as it would be printed. */
const levelsOf = (g: Row | null | undefined): string[] => (g ? [g.entry, g.entry_low, g.entry_high, g.stop_loss, g.tp1, g.tp2, g.tp3, g.invalidation_price, g.closest_support, g.closest_resistance] : []).filter((x) => typeof x === "number").map(String);
const DIRECTION = /sell|buy|bear|bull|short|long/i;

test("The Floor's card: the play goes to a member whose window is open, and to nobody else", async () => {
  const open = member("floor-open"), closed = member("floor-closed", { credits: 12 });
  spend(open, 5 * MIN);
  for (const sym of ["", "&symbol=EURUSD", "&symbol=GBPJPY"]) for (const mode of ["intraday", "quick", "swing"]) {
    const what = `${sym || "gold"} ${mode}`;
    const a = await floor(open, `mode=${mode}${sym}&fresh=1`), b = await floor(closed, `mode=${mode}${sym}&fresh=1`);
    assert.deepEqual([a.status, b.status], [200, 200], what);
    // Open: the map as it always was, plus the window.
    const levels = levelsOf(a.json.g).filter((x) => x !== String(a.json.price));
    assert.ok(levels.length >= 3, `${what}: the open member is sent a plan (${levels.join(", ")})`);
    assert.deepEqual(Object.keys(a.json).filter((k) => k !== "cached").sort(), ["asOf", "candles", "g", "mode", "price", "session", "setups", "symbol"], what);
    assert.deepEqual(a.json.setups, { cost: 5, minutes: 30, open: true, via: "credits", until: iso(clock + 25 * MIN) }, what);
    // Closed: the chart, the price and how far along it is — from the route's own 15-second cache or not.
    assert.deepEqual(Object.keys(b.json).filter((k) => k !== "cached").sort(), ["asOf", "candles", "g", "locked", "mode", "price", "session", "setups", "symbol"], what);
    assert.equal(b.json.cached, true, `${what}: answered from the cache the open member's request filled`);
    assert.equal(b.json.g, null, what);
    assert.ok(["live", "forming", "watching"].includes(b.json.locked.stage), what);
    assert.deepEqual(b.json.setups, CLOSED, what);
    assert.deepEqual([b.json.candles, b.json.price], [a.json.candles, a.json.price], `${what}: the market's own chart and price are sent either way`);
    const sent = JSON.stringify({ ...b.json, candles: [] });
    for (const lv of levels) assert.ok(!sent.includes(lv), `${what}: level ${lv} was sent to a member with no window`);
    assert.ok(!DIRECTION.test(sent), `${what}: ${sent}`);
  }
  assert.deepEqual(spends(closed), [], "looking charges nothing");
});

test("who has a window: a read they paid for, a FLOW fee, a Pass, an admin — and nothing a member can arrange for less", async () => {
  later();
  const yes: [string, string][] = [], no: [string, string][] = [];
  const add = (list: [string, string][], what: string, set: (t: string) => void) => { const t = member(`who-${list.length}-${list === yes ? "y" : "n"}`); set(t); list.push([what, t]); };
  add(yes, "a GENX read charged 29 minutes ago", (t) => spend(t, 29 * MIN));
  add(yes, "an MFX Ghost read charged just now", (t) => spend(t, 1000, { feature: "ghost" }));
  add(yes, "a FLOW setup fee", (t) => flowFee(t, 3 * MIN));
  add(yes, "a FLOW trade fee", (t) => flowFee(t, 3 * MIN, { kind: "trade", cost: 5 }));
  add(yes, "a FLOW Pass", (t) => flowPass(t));
  add(yes, "an admin", (t) => { T("profiles").find((p) => p.id === idOf(t))!.role = "admin"; });
  add(no, "nothing at all", () => {});
  add(no, "a read from 31 minutes ago", (t) => spend(t, 31 * MIN));
  // spend_credits takes the feature's name from the caller: a member can write this line for one credit.
  add(no, "a flow_autorun line the member can write themselves", (t) => spend(t, MIN, { feature: "flow_autorun", amount: -1 }));
  add(no, "a chat message", (t) => spend(t, MIN, { feature: "chat", amount: -1 }));
  add(no, "a Command Center pass", (t) => spend(t, MIN, { feature: "command_center" }));
  add(no, "a read that took no credits", (t) => spend(t, MIN, { amount: 0 }));
  add(no, "a Pass holder's free read after the Pass has gone", (t) => spend(t, MIN, { kind: "pass", amount: 0 }));
  add(no, "a credit purchase", (t) => spend(t, MIN, { kind: "purchase", feature: null, amount: 50 }));
  add(no, "a FLOW fee that cost nothing", (t) => flowFee(t, MIN, { cost: 0 }));
  add(no, "a FLOW fee from 31 minutes ago", (t) => flowFee(t, 31 * MIN));
  add(no, "a Pass that was cancelled", (t) => flowPass(t, { status: "canceled" }));
  add(no, "a Pass whose period is over", (t) => flowPass(t, { current_period_end: iso(clock - 3600_000) }));
  add(no, "another plan", (t) => flowPass(t, { plan: "trading_suite" }));
  for (const [what, t] of yes) { const r = await floor(t); assert.ok(r.json.g && r.json.setups.open === true && !r.json.locked, what); }
  for (const [what, t] of no) { const r = await floor(t); assert.deepEqual([r.json.g, r.json.setups, typeof r.json.locked?.stage], [null, CLOSED, "string"], what); }
  // Someone else's spend, Pass or role is not theirs.
  const mine = member("who-mine"), theirs = member("who-theirs"); spend(theirs, MIN);
  assert.equal((await floor(mine)).json.g, null);
  // Not signed in, or a token nobody issued: nothing at all.
  for (const t of [null, "tok-nobody"]) { const r = await floor(t); assert.deepEqual([r.status, r.json], [401, { error: "unauthorized" }]); }
});

test("the window ends: thirty minutes after the spend the card locks again", async () => {
  later();
  const m = member("ends"); spend(m, 28 * MIN);
  assert.equal((await floor(m)).json.setups.until, iso(clock + 2 * MIN));
  assert.ok((await floor(m, "mode=intraday")).json.g, "a poll inside the window is still open");
  later(2 * MIN);
  for (const q of ["mode=intraday", "mode=intraday&fresh=1"]) { const r = await floor(m, q); assert.deepEqual([r.json.g, r.json.setups], [null, CLOSED], q); }
  // A Pass that ends has no clock to run out. The card's 15-second polls may be answered from what this
  // server remembered for up to a minute; its first look after arriving, switching or paying — `fresh=1` — never is.
  const p = member("ends-pass"); flowPass(p);
  assert.equal((await floor(p)).json.setups.via, "pass");
  T("user_subscriptions").find((r) => r.user_id === idOf(p))!.status = "canceled";
  assert.ok((await floor(p, "mode=intraday")).json.g, "a poll inside the minute");
  assert.deepEqual((await floor(p, "mode=intraday&fresh=1")).json.setups, CLOSED, "a fresh look asks the database");
  assert.equal((await floor(p, "mode=intraday")).json.g, null, "and what was remembered went with it");
});

test("earlier maps are the same trade a few minutes younger: they open with the window, and no parameter gets round it", async () => {
  later();
  const open = member("past-open"), closed = member("past-closed"); spend(open, MIN);
  await floor(open);                                                     // a compute stores a snapshot
  const stored = T("floor_setup_history").filter((r) => r.mode === "intraday" && !r.instrument);
  assert.ok(stored.length >= 1, "the route stored at least one map to ask for");
  const id = stored[0].id;
  // Open: the list, and a stored map with its read in it.
  const list = await floor(open, "history=1&mode=intraday");
  assert.ok(Array.isArray(list.json.past) && list.json.past.length >= 1);
  const one = await floor(open, `id=${id}`);
  assert.ok(one.json.frozen === true && levelsOf(one.json.g).length >= 3);
  // Closed: an empty list that says why, and a refusal for a map asked for by its id.
  assert.deepEqual((await floor(closed, "history=1&mode=intraday")).json, { past: [], setups: CLOSED });
  const refused = await floor(closed, `id=${id}`);
  assert.deepEqual([refused.status, refused.json], [402, { error: "locked", setups: CLOSED }]);
  // …however it is asked.
  for (const q of [`id=${id}&fresh=1`, `id=${id}&history=1`, `id=${id}&mode=swing&symbol=EURUSD`, "history=true&mode=intraday", "history=1&mode=quick&symbol=GBPJPY", "mode=INTRADAY", "mode=intraday&symbol=xauusd", "mode=intraday&fresh=true", "mode=intraday&id=", "mode=intraday&history="]) {
    const r = await floor(closed, q);
    assert.ok(!r.json.g && (!Array.isArray(r.json.past) || r.json.past.length === 0), `${q} → ${r.text.slice(0, 120)}`);
    assert.ok(!levelsOf(stored[0].payload?.g).some((lv) => r.text.replace(/"candles":\[[^\]]*\]/, "").includes(lv) && lv !== String(r.json.price)), q);
  }
});

test("a read with no plan in it has nothing to keep back: everyone is sent the same thing", async () => {
  later();
  const open = member("thin-open"), closed = member("thin-closed"); spend(open, MIN);
  FEED["GBP/JPY"].thin = true;
  try {
    const a = await floor(open, "mode=swing&symbol=GBPJPY&fresh=1"), b = await floor(closed, "mode=swing&symbol=GBPJPY&fresh=1");
    assert.deepEqual(levelsOf(a.json.g), []);
    assert.ok(!("locked" in b.json) && !("setups" in b.json));
    assert.deepEqual({ ...b.json, cached: undefined }, { ...a.json, cached: undefined });
  } finally { FEED["GBP/JPY"].thin = false; }
});

test("FLOW's Find my trade: the same window in front of the same read", async () => {
  later();
  const open = member("flow-open"), closed = member("flow-closed", { credits: 12 }); spend(open, MIN);
  const read = (t: string, body: Row) => call("flow/read", "POST", "/api/flow/read", t, body);
  for (const body of [{ symbol: "XAUUSD", mode: "intraday" }, { symbol: "EURUSD", mode: "quick" }, { symbol: "XAUUSD", mode: "swing" }]) {
    const a = await read(open, body), b = await read(closed, body), what = JSON.stringify(body);
    assert.ok(a.json.ok && a.json.entry_engine && levelsOf(a.json.g).length >= 3 && a.json.setups.open === true, what);
    assert.deepEqual(Object.keys(b.json).sort(), ["data_status", "entry_engine", "g", "instrument", "locked", "mode", "ok", "price", "session", "setups", "symbol"], what);
    assert.deepEqual([b.json.g, b.json.entry_engine, b.json.setups, b.json.price], [null, null, CLOSED, a.json.price], what);
    for (const lv of levelsOf(a.json.g)) assert.ok(lv === String(a.json.price) || !b.text.includes(lv), `${what}: ${lv}`);
    assert.ok(!DIRECTION.test(b.text.replace(/"label":"[^"]*"/g, "")), b.text);
  }
  assert.deepEqual(spends(closed), []);
  // The list of markets is not a play.
  assert.ok(Array.isArray((await call("flow/read", "GET", "/api/flow/read", closed)).json.instruments));
});

test("GEN FX's lists: a call still open is its pair, horizon and stage; a member's own orders stay theirs", async () => {
  later();
  const open = member("desk-open"), closed = member("desk-closed", { credits: 12 }); spend(open, MIN);
  T("genfx_control").push({ id: 1, scan_enabled: true, auto_enabled: false, auto_scope: "owner", billing_enabled: true, telegram_enabled: false, config: {}, replay_request: null, updated_at: iso(clock) });
  // What the scanner decided on its last pass: every pair, every horizon, which way and why.
  const decisions = { EURUSD: { intraday: { verdict: "skip", side: "sell", why: "stop_too_tight (9.5 pips)" } }, GBPJPY: { intraday: { verdict: "armed", side: "buy", entry: 208.835 } } };
  T("flow_heartbeat").push({ component: "genfx", last_run: iso(clock - 20_000), detail: { at: iso(clock - 21_000), quiet: false, decisions } });
  const a = (o: Row) => ({ pair: "EURUSD", dedupe_key: "EURUSD:intraday:sell:11206:11209:20261006", mode: "intraday", side: "sell", state: "forming", entry: 1.12075, entry_low: 1.1206, entry_high: 1.1209, stop: 1.12269, tp1: 1.11617, confidence: 71, created_at: ago(8 * MIN - 17_000), enter_price: null, enter_sent_at: null, outcome: null, result_pips: null, resolved_at: null, ...o });
  T("genfx_alerts").push(
    a({ id: "fx1" }),
    a({ id: "fx2", pair: "GBPJPY", dedupe_key: "zone:GBPJPY:intraday:buy:83534:20261006", state: "zone", side: "buy", entry: 208.835, entry_low: null, entry_high: null, stop: 208.511, tp1: 209.468 }),
    a({ id: "fx3", state: "entered", enter_price: 1.11922, enter_sent_at: ago(4 * MIN - 7_000) }),
    a({ id: "fx4", state: "entered", enter_price: 1.12271, stop: 1.124, tp1: 1.12125, enter_sent_at: ago(120 * MIN), outcome: "win", result_pips: 17, resolved_at: ago(60 * MIN) }),
    a({ id: "fx5", state: "entered", enter_price: 1.11987, enter_sent_at: ago(300 * MIN), outcome: "expired", result_pips: -3, resolved_at: ago(100 * MIN) }),
  );
  // Each line is stamped to the millisecond it was written: the moment the call went out.
  const wrote = clock - 3 * MIN - 2_877;
  const ev = (t: string, o: Row) => T("flow_auto_events").push({ user_id: idOf(t), symbol: "EURUSD", side: "sell", account_id: "828568", created_at: iso(wrote), order_id: null, ...o });
  const alarm = "genfx: not adopted — the broker tied this order to a position that is not this order's alone: it is 0.05 lots and the order was 0.02 — CHECK THIS ACCOUNT";
  for (const t of [open, closed]) {
    ev(t, { status: "skipped", reason: "genfx: credits (not enough credits for this trade)" });
    ev(t, { status: "skipped", reason: "genfx: one_open (already in a EUR/USD sell on this account)" });
    ev(t, { status: "skipped", reason: "genfx: min_lot_over_risk (the smallest EUR/USD order would risk $12.50 on this stop — over 5% of this account)" });
    ev(t, { status: "error", reason: "genfx: Not enough margin to create Order 77 Sell 0.02 Price 1.12075", qty: 0.02 });
    ev(t, { status: "error", reason: "genfx: entry_deadline_passed", side: "buy", symbol: "GBPJPY" });
    ev(t, { status: "error", reason: alarm });
    ev(t, { status: "error", reason: "genfx: ORDER 9001 WAS ACCEPTED AFTER ITS RECORD HAD BEEN CLOSED — it is on the account and is NOT being followed. CHECK THIS ACCOUNT", order_id: "9001" });
    ev(t, { status: "placed", reason: "genfx: accepted — its record is pending", order_id: "9002" });
  }
  const desk = (t: string) => call("genfx/desk", "GET", "/api/genfx/desk?v=2", t);
  const full = (await desk(open)).json, shut = (await desk(closed)).json;
  // Open: everything, as before, plus the window.
  assert.equal(full.setups.open, true);
  assert.deepEqual(full.alerts.map((x: Row) => [x.id, x.side, x.stop]), [["fx1", "sell", 1.12269], ["fx2", "buy", 208.511], ["fx3", "sell", 1.12269], ["fx4", "sell", 1.124], ["fx5", "sell", 1.12269]]);
  assert.deepEqual(full.activity.map((x: Row) => [x.side, x.created_at]), ["sell", "sell", "sell", "sell", "buy", "sell", "sell", "sell"].map((side) => [side, iso(wrote)]));
  // Closed: the same five calls. The three still open and the one that expired have no side, no level, no key, and times to the five minutes.
  assert.deepEqual(shut.setups, CLOSED);
  const blank = { side: null, entry: null, entry_low: null, entry_high: null, stop: null, tp1: null, enter_price: null, confidence: null, result_pips: null, locked: true };
  const five = (ms: number) => iso(Math.floor(ms / (5 * MIN)) * 5 * MIN);
  assert.deepEqual(shut.alerts.filter((x: Row) => x.id !== "fx4"), [
    { id: "fx1", pair: "EURUSD", mode: "intraday", state: "forming", kind: "scanner", created_at: five(clock - 8 * MIN + 17_000), enter_sent_at: null, outcome: null, ...blank },
    { id: "fx2", pair: "GBPJPY", mode: "intraday", state: "zone", kind: "zone", created_at: five(clock - 8 * MIN + 17_000), enter_sent_at: null, outcome: null, ...blank },
    { id: "fx3", pair: "EURUSD", mode: "intraday", state: "entered", kind: "scanner", created_at: five(clock - 8 * MIN + 17_000), enter_sent_at: five(clock - 4 * MIN + 7_000), outcome: null, ...blank },
    { id: "fx5", pair: "EURUSD", mode: "intraday", state: "entered", kind: "scanner", created_at: five(clock - 8 * MIN + 17_000), enter_sent_at: five(clock - 300 * MIN), outcome: "expired", ...blank },
  ]);
  // The call that won is a result, and is sent whole.
  assert.deepEqual(shut.alerts.find((x: Row) => x.id === "fx4"), full.alerts.find((x: Row) => x.id === "fx4"));
  // Their activity: a call the account sat out, and an order the broker refused before it existed, say
  // nothing of the side — and not the second the call went out either (that second is the moment price
  // touched the entry): the time is to the five minutes, like every other time on a locked line.
  const at = five(wrote);
  assert.notEqual(at, iso(wrote));
  assert.deepEqual(shut.activity.slice(0, 5), [
    { symbol: "EURUSD", side: null, status: "skipped", created_at: at, account_id: "828568", reason: "genfx: credits (not enough credits for this trade)" },
    { symbol: "EURUSD", side: null, status: "skipped", created_at: at, account_id: "828568", reason: "genfx: not taken" },
    { symbol: "EURUSD", side: null, status: "skipped", created_at: at, account_id: "828568", reason: "genfx: min_lot_over_risk (the smallest order would risk too much of this account)" },
    { symbol: "EURUSD", side: null, status: "error", created_at: at, account_id: "828568", reason: "genfx: order not placed (the broker refused it)" },
    { symbol: "GBPJPY", side: null, status: "error", created_at: at, account_id: "828568", reason: "genfx: entry_deadline_passed" },
  ]);
  // …an alarm about their account is never cut down — with an order's id on the line or without one:
  // it must not come out reading "nothing was placed" — and an order of their own is theirs.
  assert.deepEqual(shut.activity.slice(5), full.activity.slice(5));
  assert.deepEqual(shut.activity.slice(5).map((x: Row) => [x.status, x.side, x.order_id, x.created_at]), [["error", "sell", null, iso(wrote)], ["error", "sell", "9001", iso(wrote)], ["placed", "sell", "9002", iso(wrote)]]);
  assert.equal(shut.activity[5].reason, alarm);
  assert.ok(shut.activity[6].reason.includes("CHECK THIS ACCOUNT"));
  const kept = JSON.stringify({ alerts: shut.alerts.filter((x: Row) => x.id !== "fx4"), activity: shut.activity.slice(0, 5) });
  for (const tell of ["sell", "buy", "Sell", "1.12", "1.11", "208.", "209.", "11206", "83534", "dedupe_key", "71", "-3", "12.50", "02.877", iso(wrote)]) assert.ok(!kept.includes(tell), `${tell} was sent`);
  // What each read decided is the owner's — window or no window, and an admin's role does not make an owner.
  const staff = member("desk-staff", { role: "admin" });
  const seen = (await desk(staff)).json;
  assert.equal(seen.setups.via, "admin");
  for (const [who, d] of [["open", full], ["closed", shut], ["an admin", seen]] as const) {
    assert.deepEqual(d.lastScan, { at: iso(clock - 21_000), beat: iso(clock - 20_000), quiet: false, decisions: null }, who);
    assert.deepEqual([d.owner, "ownerView" in d], [false, false], who);
    assert.ok(!JSON.stringify(d.lastScan).includes("stop_too_tight"), who);
  }
  const boss = (await desk(OWNER)).json;
  assert.deepEqual([boss.owner, boss.lastScan.decisions, typeof boss.ownerView?.armed], [true, decisions, "object"]);
  // A page loaded before a call could arrive locked (a tab left open across the release) printed every
  // call's side without looking. It does not say `v=2`, and is sent only the calls that are whole: the
  // graded one. Nothing with no side in it reaches it — and nothing of the play does either.
  const old = (t: string) => call("genfx/desk", "GET", "/api/genfx/desk", t);
  const was = (await old(closed)).json;
  assert.deepEqual(was.alerts, [full.alerts.find((x: Row) => x.id === "fx4")]);
  assert.ok(was.alerts.every((x: Row) => typeof x.side === "string"));
  assert.deepEqual([was.setups, was.activity], [CLOSED, shut.activity]);
  // With a window open it is sent everything, as it always was.
  assert.deepEqual((await old(open)).json.alerts, full.alerts);
  for (const q of ["v=1", "v=", "v=22", "V=2", "v=2x"]) assert.equal((await call("genfx/desk", "GET", `/api/genfx/desk?${q}`, closed)).json.alerts.length, 1, q);
});

test("GEN FX with the owner's billing switch off costs nothing — and that includes looking; gold is never free that way", async () => {
  later();
  const m = member("free-fx", { credits: 12 });
  const ctl = T("genfx_control")[0];
  const pairCard = () => floor(m, "mode=intraday&symbol=EURUSD&fresh=1");
  const free = { cost: 5, minutes: 30, open: true, via: "free", until: null };
  // Maps stored earlier by the first test: one of gold's, one of EUR/USD's.
  const goldMap = T("floor_setup_history").find((r) => !r.instrument)!, pairMap = T("floor_setup_history").find((r) => r.instrument === "EURUSD")!;
  assert.ok(goldMap && pairMap && levelsOf(pairMap.payload?.g).length >= 3);
  assert.equal((await pairCard()).json.g, null, "billing on: a pair's card is locked");
  assert.equal((await floor(m, `id=${pairMap.id}`)).status, 402, "…and so is an earlier map of the pair");
  // Changed in the database (by another server, say): every card has caught up ten seconds later.
  ctl.billing_enabled = false; later(10_000);
  const card = await pairCard();
  assert.ok(levelsOf(card.json.g).length >= 3); assert.deepEqual(card.json.setups, free);
  const desk = (await call("genfx/desk", "GET", "/api/genfx/desk?v=2", m)).json;
  assert.deepEqual(desk.setups, free); assert.equal(desk.alerts.find((x: Row) => x.id === "fx1").side, "sell");
  const read = await call("genfx", "POST", "/api/genfx", m, { pair: "EURUSD", mode: "intraday" });
  assert.deepEqual([read.json.billing, read.json.cost], [false, 0]); assert.ok(levelsOf(read.json.genfx).length >= 3);
  assert.deepEqual(spends(m), [], "a free read is free");
  // Gold's card and FLOW's read are not GEN FX: still locked.
  assert.equal((await floor(m)).json.g, null);
  assert.equal((await call("flow/read", "POST", "/api/flow/read", m, { symbol: "EURUSD", mode: "intraday" })).json.g, null);
  // An earlier map opens by the market it was STORED under, not the market the request names: the
  // pair's is free with the pair, and gold's is not free for being asked for "as EUR/USD".
  for (const q of [`id=${pairMap.id}`, `id=${pairMap.id}&symbol=EURUSD`, `id=${pairMap.id}&symbol=XAUUSD`]) { const r = await floor(m, q); assert.deepEqual([r.status, r.json.frozen, r.json.symbol], [200, true, "EURUSD"], q); }
  for (const q of [`id=${goldMap.id}`, `id=${goldMap.id}&symbol=EURUSD`, `id=${goldMap.id}&symbol=GBPJPY&mode=swing`, `id=${goldMap.id}&symbol=EURUSD&fresh=1`]) { const r = await floor(m, q); assert.deepEqual([r.status, r.json], [402, { error: "locked", setups: CLOSED }], q); }
  assert.deepEqual((await floor(m, "id=00000000-0000-4000-8000-999999999999&symbol=EURUSD")).json, { error: "locked", setups: CLOSED }, "an id nobody stored says nothing either");
  assert.ok((await floor(m, "history=1&mode=intraday&symbol=EURUSD")).json.past.length >= 1, "the pair's list is the pair's");
  assert.deepEqual((await floor(m, "history=1&mode=intraday")).json, { past: [], setups: CLOSED }, "gold's list is gold's");
  // A switch that cannot be read is not "off".
  ctl.billing_enabled = true; later(); fail.tables.add("genfx_control");
  try {
    assert.equal((await pairCard()).json.g, null);
    const dark = (await call("genfx/desk", "GET", "/api/genfx/desk?v=2", m)).json;
    assert.deepEqual([dark.setups, dark.alerts.find((x: Row) => x.id === "fx1").side], [CLOSED, null]);
  } finally { fail.tables.delete("genfx_control"); }
  later();
  assert.equal((await pairCard()).json.g, null, "billing back on: locked again");
  assert.equal((await floor(m, `id=${pairMap.id}`)).status, 402);
  // The owner moves the switch on the desk: the server that took the change forgets what it remembered,
  // so the very next look — the same second — is by the new setting. Both ways.
  const flip = (billing: boolean) => call("genfx/desk", "POST", "/api/genfx/desk", OWNER, { action: "control", billing });
  assert.equal((await flip(false)).json.switches.billing, false);
  assert.deepEqual((await pairCard()).json.setups, free, "off: free at once");
  assert.equal((await flip(true)).json.switches.billing, true);
  assert.deepEqual((await pairCard()).json.setups, CLOSED, "on: locked at once");
  // Nobody else can move it.
  assert.deepEqual([(await call("genfx/desk", "POST", "/api/genfx/desk", m, { action: "control", billing: false })).status, ctl.billing_enabled], [403, true]);
});

test("See the play: one spend of a read's credits opens every card, and a second tap costs nothing", async () => {
  later();
  const m = member("pay", { credits: 12 });
  assert.equal((await floor(m)).json.g, null);
  const first = await tap(m);
  assert.deepEqual([first.status, first.json], [200, { cost: 5, minutes: 30, open: true, via: "credits", until: iso(clock + 30 * MIN), charged: true, balance: 7 }]);
  assert.deepEqual(spends(m), ["genx -5"], "charged as a read: the read's price, the read's ledger line");
  // Every card, at once — asked afresh or not, on gold or a pair, live or earlier, and FLOW's read and GEN FX's lists too.
  for (const q of ["mode=intraday&fresh=1", "mode=intraday", "mode=swing&symbol=GBPJPY", "mode=quick&symbol=EURUSD&fresh=1"]) assert.ok(levelsOf((await floor(m, q)).json.g).length >= 3, q);
  assert.ok((await floor(m, "history=1&mode=intraday")).json.past.length >= 1);
  assert.ok((await call("flow/read", "POST", "/api/flow/read", m, { symbol: "XAUUSD", mode: "intraday" })).json.g);
  assert.equal((await call("genfx/desk", "GET", "/api/genfx/desk?v=2", m)).json.alerts.find((x: Row) => x.id === "fx1").side, "sell");
  // Tapping again inside the window: the same window, nothing charged.
  later(10 * MIN);
  const again = await tap(m);
  assert.deepEqual([again.status, again.json.charged, again.json.until], [200, false, first.json.until]);
  assert.deepEqual([spends(m), balances.get(idOf(m))], [["genx -5"], 7]);
  // After it ends, a tap is a new window and a new spend.
  later(21 * MIN);
  assert.equal((await floor(m)).json.g, null);
  const next = await tap(m);
  assert.deepEqual([next.json.charged, next.json.balance, next.json.until], [true, 2, iso(clock + 30 * MIN)]);
  // And with 2 credits left, the one after that is refused before anything is taken.
  later(31 * MIN);
  const short = await tap(m);
  assert.deepEqual([short.status, short.json], [402, { ...CLOSED, charged: false, error: "insufficient", balance: 2 }]);
  assert.deepEqual([spends(m), balances.get(idOf(m))], [["genx -5", "genx -5"], 2]);
  // GET says where the window stands and takes nothing.
  assert.deepEqual((await call("setups/pass", "GET", "/api/setups/pass", m)).json, CLOSED);
});

test("See the play: nobody who already has a window is charged for one", async () => {
  later();
  const cases: [string, string, string][] = [];
  const add = (what: string, via: string, set: (t: string) => void) => { const t = member(`has-${cases.length}`, { credits: 50 }); set(t); cases.push([what, via, t]); };
  add("a paid read", "credits", (t) => spend(t, 2 * MIN));
  add("an MFX Ghost read", "credits", (t) => spend(t, 2 * MIN, { feature: "ghost" }));
  add("a FLOW fee", "credits", (t) => flowFee(t, 2 * MIN));
  add("a Pass", "pass", (t) => flowPass(t));
  add("an admin", "admin", (t) => { T("profiles").find((p) => p.id === idOf(t))!.role = "admin"; });
  for (const [what, via, t] of cases) {
    const before = spends(t).length, r = await tap(t);
    assert.deepEqual([r.status, r.json.open, r.json.via, r.json.charged], [200, true, via, false], what);
    assert.deepEqual([spends(t).length, balances.get(idOf(t))], [before, 50], what);
  }
  assert.deepEqual([(await tap(null)).status, (await tap("tok-nobody")).status], [401, 401]);
});

test("See the play: no credits are taken on a guess, and a spend whose answer was lost is found before anything is said", async () => {
  later();
  // Any one of the four things that say whether there is already a window cannot be read: nothing is charged.
  for (const table of ["credit_transactions", "flow_billing_events", "profiles", "user_subscriptions"]) {
    const m = member(`dark-${table}`, { credits: 12 });
    fail.tables.add(table);
    try {
      const r = await tap(m);
      assert.deepEqual([r.status, r.json], [503, { ...CLOSED, charged: false, error: "unavailable" }], table);
      assert.equal((await floor(m)).json.g, null, `${table}: and the card fails closed`);
    } finally { fail.tables.delete(table); }
    assert.deepEqual([spends(m), balances.get(idOf(m))], [[], 12], table);
  }
  // The spend went through and its answer did not come back: the ledger is asked, and the window opens.
  const lost = member("lost", { credits: 12 });
  fail.spendLosesAnswer = true;
  try { assert.deepEqual((await tap(lost)).json, { cost: 5, minutes: 30, open: true, via: "credits", until: iso(clock + 30 * MIN), charged: true, balance: null }); } finally { fail.spendLosesAnswer = false; }
  assert.deepEqual(spends(lost), ["genx -5"]);
  assert.equal((await tap(lost)).json.charged, false, "and the tap after it is free");
  assert.deepEqual(spends(lost), ["genx -5"]);
  // The spend itself failed: nothing was taken, and the answer says so.
  const down = member("down", { credits: 12 });
  fail.rpc.add("spend_credits");
  try { assert.deepEqual((await tap(down)).json, { ...CLOSED, charged: false, error: "charge_failed" }); } finally { fail.rpc.delete("spend_credits"); }
  assert.deepEqual([spends(down), balances.get(idOf(down))], [[], 12]);
  // The balance cannot be read (that check lets a member through) and they turn out to be short: refused, nothing taken.
  const poor = member("poor", { credits: 3 });
  fail.rpc.add("get_credit_balance");
  try { const r = await tap(poor); assert.deepEqual([r.json.open, r.json.charged, r.json.error], [false, false, "charge_failed"]); } finally { fail.rpc.delete("get_credit_balance"); }
  assert.deepEqual([spends(poor), balances.get(idOf(poor))], [[], 3]);
});

test("See the play: two taps at the same instant are one spend", async () => {
  later();
  const m = member("twice", { credits: 12 });
  const [a, b] = await Promise.all([tap(m), tap(m)]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const busy = a.status === 409 ? a : b, done = a.status === 409 ? b : a;
  assert.deepEqual([busy.json, done.json.charged], [{ ...CLOSED, charged: false, error: "busy" }, true]);
  assert.deepEqual([spends(m), balances.get(idOf(m))], [["genx -5"], 7]);
});
