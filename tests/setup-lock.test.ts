import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SETUP_WINDOW_MS, SETUP_MINUTES, PLAY_LEVELS, STAGE_TEXT,
  hasPlay, stageOf, lockSetup, lockAlerts, lockActivity, safeReason, safeErrorNote, lockFlowRead, readFits, minutesLeft, tapOutcome, type SetupGate,
} from "../src/lib/setupLock";
import { setupAccess, lookAtSetupAccess, forgetSetupAccess, genfxIsFree, forgetGenfxFree, gateFrom, SETUP_COST, READ_FEATURE, READ_FEATURES, CLOSED, OPEN_UNMETERED, OPEN_FREE, type SetupLook } from "../src/lib/setupAccess";
import { openSetups, oneAtATime, type PassDeps, type GateAnswer } from "../src/lib/setupPass";
import { CREDIT_COST } from "../src/lib/creditConfig";
import { CC_PASS_MS, CC_PASS_COST } from "../src/lib/ccPass";
import { buildGenx, MODES } from "../src/lib/genxCompute";

/*
 * Live setups take credits to view (owner 10-05: "Make them use credits to view"; 10-06: "Yes, lock
 * the site"). The site was handing the play to any signed-in member in three places. These hold the
 * three to one rule: the play leaves the server only for a member whose window is open, what everyone
 * else is sent cannot be read back into a trade, and opening a window takes credits once — never on a
 * guess, never twice. (The handlers themselves are called in tests/setup-lock-routes.test.ts.)
 */
const src = (p: string): string => readFileSync(p, "utf8");
const code = (p: string): string => src(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const NOW = Date.UTC(2026, 9, 6, 3, 0, 0);
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

/* A read exactly as the engine builds it: a swing sell with a zone, a stop and three targets. */
const READ = buildGenx({
  state: "DEVELOPING_SETUP", direction: "sell", strategy: "trend_pullback", market_regime: "Bearish trend",
  entry: { price: 4130.9, zone_low: 4129.98, zone_high: 4131.84 }, stop_loss: { price: 4170.6, reason: "A close above the swing high at 4170.60." },
  take_profits: [{ price: 4048.74, risk_reward: 2.1 }, { price: 4021.5 }, { price: 3990.25 }],
  levels: { support: 4046.2, resistance: 4168.4 }, scores: { overall: 66, directional: 70 }, proximity: { status: "Approaching Setup Zone" },
  what_next: ["Wait for the rally into 4130."],
}, { mode: "swing", price: 4122.01, session: "Asia", dataStatus: "live", hold: MODES.swing.hold, triggerTf: MODES.swing.triggerTf, contextTf: MODES.swing.contextTf, pip: 0.1, dec: 2, marketStory: [], volatility: "normal", atr: 9.5, m15: [] });
const CANDLES = Array.from({ length: 48 }, (_, i) => ({ t: iso(NOW - (48 - i) * 3600_000), o: 4100 + i, h: 4104 + i, l: 4097 + i, c: 4101 + i }));
const BODY = { g: READ, candles: CANDLES, price: 4122.01, session: "Asia", mode: "swing", asOf: iso(NOW), symbol: "XAUUSD" };

/** Every level a play is made of, as it would appear in JSON sent to a browser. (The live price is the market's, and is sent.) */
function tellsOf(g: Record<string, unknown>): string[] {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === "number" && Number.isFinite(v) && Math.abs(v) > 100) out.add(String(v));
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  for (const k of [...PLAY_LEVELS, "closest_support", "closest_resistance", "projected_path", "scalp"]) walk(g[k]);
  out.delete(String(BODY.price));
  return [...out];
}

/* ── what a play is, and what a member without a window is sent ───────────────────────────────── */

test("the engine's read is a play: it has the levels a trade is made of, and the test knows them", () => {
  assert.equal(READ.action, "SELL_LIMIT");
  assert.deepEqual([READ.entry, READ.entry_low, READ.entry_high, READ.stop_loss, READ.tp1, READ.tp2, READ.tp3], [4130.9, 4129.98, 4131.84, 4170.6, 4048.74, 4021.5, 3990.25]);
  assert.equal(hasPlay(READ), true);
  assert.ok(tellsOf(READ).length >= 7);
});

test("a play is any read carrying a level; a read with none has nothing to keep back", () => {
  for (const k of PLAY_LEVELS) assert.equal(hasPlay({ [k]: 4130.5 }), true, k);
  assert.equal(hasPlay({ entry_low: "4129.98", entry_high: "4131.84" }), true, "levels that arrive as text are still levels");
  for (const g of [null, undefined, {}, [], "SELL", 4130, { action: "WAIT_FOR_BUY_TRIGGER", directional_bias: "bullish", closest_support: 4046.2 }, { entry: null, stop_loss: null, tp1: NaN, tp2: "", tp3: "—" }]) assert.equal(hasPlay(g), false, JSON.stringify(g));
  // The range plan the engine draws when it has no setup of its own is a play too: the desk trades it.
  const range = buildGenx({ state: "NO_TRADE", levels: { support: 4100, resistance: 4160 }, scores: { overall: 40 } },
    { mode: "intraday", price: 4112, session: "London", dataStatus: "live", hold: MODES.intraday.hold, triggerTf: MODES.intraday.triggerTf, contextTf: MODES.intraday.contextTf, pip: 0.1, dec: 2, marketStory: [], volatility: "normal", atr: 6, m15: [] });
  assert.equal(range.engine_state, "NO_TRADE");
  assert.equal(range.action, "WAIT_FOR_BUY_TRIGGER");
  assert.ok(range.entry != null && range.stop_loss != null && range.tp1 != null);
  assert.equal(hasPlay(range), true);
});

test("how far along a setup is, in words with no direction in them", () => {
  assert.deepEqual(["BUY_NOW", "SELL_NOW"].map((a) => stageOf({ action: a })), ["live", "live"]);
  assert.deepEqual(["BUY_LIMIT", "SELL_LIMIT"].map((a) => stageOf({ action: a })), ["forming", "forming"]);
  assert.deepEqual(["WAIT_FOR_BUY_TRIGGER", "WAIT_FOR_SELL_TRIGGER", "", "anything"].map((a) => stageOf({ action: a })), ["watching", "watching", "watching", "watching"]);
  assert.equal(stageOf(null), "watching");
  for (const t of Object.values(STAGE_TEXT)) assert.ok(!/\b(buy|sell|long|short|bullish|bearish|up|down|above|below|higher|lower)\b|\d/i.test(t), t);
  // A buy and a sell at the same stage read the same.
  assert.equal(JSON.stringify(lockSetup({ ...BODY, g: { ...READ, action: "BUY_LIMIT" } }).locked), JSON.stringify(lockSetup(BODY).locked));
});

test("The Floor's card with the window closed: the chart, the price, the stage — and no read", () => {
  const out = lockSetup(BODY);
  assert.deepEqual(Object.keys(out).sort(), ["asOf", "candles", "g", "locked", "mode", "price", "session", "symbol"]);
  assert.equal(out.g, null);
  assert.deepEqual(out.locked, { stage: "forming" });
  assert.deepEqual([out.candles, out.price, out.session, out.mode, out.asOf, out.symbol], [CANDLES, 4122.01, "Asia", "swing", iso(NOW), "XAUUSD"]);
  // Nothing of the trade is in what is sent — not a level, not a word. (The candles are the market's.)
  const sent = JSON.stringify({ ...out, candles: [] });
  for (const t of tellsOf(READ)) assert.ok(!sent.includes(t), `level ${t} was sent`);
  assert.ok(!/sell|buy|bear|bull|short|long|SELL_LIMIT/i.test(sent), sent);
  // A field added to the answer later is not passed on by default.
  const more = lockSetup({ ...BODY, cached: true, ...({ levels: [4130.9], note: "sell 4130" } as object) });
  assert.deepEqual(Object.keys(more).sort(), ["asOf", "cached", "candles", "g", "locked", "mode", "price", "session", "symbol"]);
  assert.ok(!JSON.stringify({ ...more, candles: [] }).includes("4130"));
});

test("GEN FX lists with the window closed: a call still open is its pair, horizon and stage; only a win or a loss is a result", () => {
  const forming = { id: "a1", pair: "EURUSD", dedupe_key: "EURUSD:intraday:sell:11206:11209:20261005", mode: "intraday", side: "sell", state: "forming", entry: 1.12075, entry_low: 1.1206, entry_high: 1.1209, stop: 1.12269, tp1: 1.11617, confidence: 71, created_at: iso(NOW - 8 * MIN + 17_345), enter_price: null, enter_sent_at: null, outcome: null, result_pips: null, kind: "scanner" };
  const zone = { ...forming, id: "a2", pair: "GBPJPY", dedupe_key: "zone:GBPJPY:intraday:sell:83534:20261005", state: "zone", entry: 208.835, entry_low: null, entry_high: null, stop: 209.161, tp1: 208.179, kind: "zone" };
  const running = { ...forming, id: "a3", state: "entered", enter_price: 1.11922, enter_sent_at: iso(NOW - 4 * MIN + 7_000) };
  const won = { ...forming, id: "a4", state: "entered", enter_price: 1.12271, enter_sent_at: iso(NOW - 120 * MIN), outcome: "win", result_pips: 17 };
  const lost = { ...won, id: "a5", outcome: "loss", result_pips: -19 };
  // Ran out of time with its stop and its target both unbroken: its levels are still a trade.
  const expired = { ...forming, id: "a6", state: "entered", enter_price: 1.11987, enter_sent_at: iso(NOW - 300 * MIN), outcome: "expired", result_pips: -3 };
  const out = lockAlerts([forming, zone, running, won, lost, expired]);
  const blank = { side: null, entry: null, entry_low: null, entry_high: null, stop: null, tp1: null, enter_price: null, confidence: null, result_pips: null, locked: true };
  // When it was called is kept to the five minutes: to the second, "entered at 02:56:07" is the entry, read off any
  // chart, and to the minute it is still one small candle. (02:52:17 → 02:50; 02:56:07 → 02:55.)
  assert.deepEqual(out[0], { id: "a1", pair: "EURUSD", mode: "intraday", state: "forming", kind: "scanner", created_at: iso(NOW - 10 * MIN), enter_sent_at: null, outcome: null, ...blank });
  assert.deepEqual(out[1], { id: "a2", pair: "GBPJPY", mode: "intraday", state: "zone", kind: "zone", created_at: iso(NOW - 10 * MIN), enter_sent_at: null, outcome: null, ...blank });
  assert.deepEqual(out[2], { id: "a3", pair: "EURUSD", mode: "intraday", state: "entered", kind: "scanner", created_at: iso(NOW - 10 * MIN), enter_sent_at: iso(NOW - 5 * MIN), outcome: null, ...blank });
  assert.equal(out[3], won, "a win is sent as it was");
  assert.equal(out[4], lost, "a loss is sent as it was");
  assert.deepEqual(out[5], { id: "a6", pair: "EURUSD", mode: "intraday", state: "entered", kind: "scanner", created_at: iso(NOW - 10 * MIN), enter_sent_at: iso(NOW - 300 * MIN), outcome: "expired", ...blank });
  // The key spells the side and the zone, so it does not travel either.
  const open = JSON.stringify([out[0], out[1], out[2], out[5]]);
  for (const t of ["sell", "buy", "11206", "83534", "1.12", "1.11", "208.", "209.", "dedupe_key", "71", "-3"]) assert.ok(!open.includes(t), `${t} was sent`);
  // An outcome this code has never heard of is not taken for a result.
  assert.equal(lockAlerts([{ ...won, outcome: "void" }])[0].side, null);
  assert.deepEqual(lockAlerts([]), []);
});

test("a call a member's account sat out: no side, and a reason that cannot give the side back", () => {
  // The reasons as GEN FX writes them (src/lib/genfx/place.ts), and what may be shown of each.
  const cases: [string, string][] = [
    // About the member's account: the code, and its detail when that names no direction and no price.
    ["genfx: credits (not enough credits for this trade)", "genfx: credits (not enough credits for this trade)"],
    ["genfx: no_broker_token (reconnect your broker)", "genfx: no_broker_token (reconnect your broker)"],
    ["genfx: broker_unreadable (couldn't load the broker's instruments — the broker may have API trading switched off for this account)", "genfx: broker_unreadable (couldn't load the broker's instruments — the broker may have API trading switched off for this account)"],
    ["genfx: conservative_cooldown (3 EUR/USD losses in a row — 2h)", "genfx: conservative_cooldown (3 EUR/USD losses in a row — 2h)"],
    ["genfx: contract_size (this broker's EUR/USD lot is 1000 units; GEN FX sizes for 100000)", "genfx: contract_size (this broker's EUR/USD lot is 1000 units; GEN FX sizes for 100000)"],
    ["genfx: ledger_unreadable (couldn't take this account's lock)", "genfx: ledger_unreadable (couldn't take this account's lock)"],
    // …and the code alone when the detail is the broker's own words and they name a side, a price, or one price against another.
    ["genfx: broker_unreadable (order rejected: SELL 0.02 EURUSD @ 1.12075)", "genfx: broker_unreadable"],
    ["genfx: broker_unreadable (SELL_LIMIT is not allowed on this account)", "genfx: broker_unreadable"],
    ["genfx: broker_unreadable (stop loss must be lower than the limit price)", "genfx: broker_unreadable"],
    ["genfx: broker_unreadable (take profit is below current ask)", "genfx: broker_unreadable"],
    ["genfx: broker_unreadable (limit price 1.12075 rejected)", "genfx: broker_unreadable"],
    ["genfx: broker_unreadable (price 208.9 rejected)", "genfx: broker_unreadable"],
    ["genfx: instrument_not_found (no GBPJPY.r on this server — markets move up and down)", "genfx: instrument_not_found"],
    ["genfx: permission (live buys are switched off)", "genfx: permission"],
    // About the account, but the detail carries a figure of the trade (what the smallest order would lose at this stop): fixed words.
    ["genfx: min_lot_over_risk (the smallest EUR/USD order would risk $12.50 on this stop — over 5% of this account)", "genfx: min_lot_over_risk (the smallest order would risk too much of this account)"],
    ["genfx: min_lot_over_leverage (the smallest EUR/USD order is worth more than 30 times this account)", "genfx: min_lot_over_leverage (the smallest order is too large for this account)"],
    ["genfx: no_risk_pct (this account could not be sized for this trade)", "genfx: no_risk_pct (no risk % is set on this account)"],
    // About the trade: the same two words for every one of them. "one_open" is only ever written when
    // the new call points the same way as a trade the member already has on — so the code alone was the side.
    ["genfx: one_open (already in a EUR/USD sell on this account)", "genfx: not taken"],
    ["genfx: one_open (another GEN FX GBP/JPY buy on this account is being placed or confirmed)", "genfx: not taken"],
    ["genfx: one_open (resting EUR/USD order)", "genfx: not taken"],
    ["genfx: stop_too_tight (the stop is 9.5 pips from this broker's price — under the 12-pip minimum)", "genfx: not taken"],
    ["genfx: chased (this broker's price is past the 0.8-to-1 floor)", "genfx: not taken"],
    ["genfx: through_stop (this broker's price is already through the stop)", "genfx: not taken"],
    // The desk's own notes, written with a dash.
    ["genfx: change_of_character — GBP/JPY structure just flipped bullish — not taking a SELL against it", "genfx: not taken"],
    ["genfx: quality_gate — the 4-hour average moved -3.2 pips in 4 hours — not rising enough", "genfx: not taken"],
    ["genfx: fanout 12 armed → 3 placed (credits 5, one_open 1) · intraday zone · stop 35p", "genfx: not taken"],
    // A code nobody listed, a code that names a side, no code at all.
    ["genfx: something_new (it will be looked at again on the next candle)", "genfx: not taken"],
    ["genfx: sell_blocked (by the desk)", "genfx: not taken"],
    ["genfx", "genfx: not taken"],
    ["sell limit rejected at 1.12075", "genfx: not taken"],
  ];
  for (const [given, shown] of cases) assert.equal(safeReason(given), shown, given);
  for (const [, shown] of cases) assert.ok(!/\b(buy\w*|sell\w*|long|short|bullish|bearish|rising|falling|above|below|higher|lower)\b|\d\.\d/i.test(shown), shown);
  for (const empty of [null, undefined, "", "   ", 42]) { assert.equal(safeReason(empty), null); assert.equal(safeErrorNote(empty), null); }

  // An ERROR line with no order behind it and no alarm in it: the order path's own refusals are named;
  // the broker's words are not passed on at all — they are the broker's to choose, so they are said in ours.
  const refused = "genfx: order not placed (the broker refused it)";
  const errors: [string, string][] = [
    ["genfx: entry_deadline_passed", "genfx: entry_deadline_passed"],
    ["genfx: entry_quote_unavailable", "genfx: entry_quote_unavailable"],
    ["genfx: entry_bracket_already_crossed", "genfx: entry_bracket_already_crossed"],
    ["genfx: invalid_broker_quantity", "genfx: invalid_broker_quantity"],
    ["genfx: Not enough margin to create Order 77 Sell 0.02 Price 1.12075", refused],
    ["genfx: Stop level 208.9 is too close", refused],
    ["genfx: Stop loss must be lower than the limit price", refused],
    ["genfx: Take profit is below current ask", refused],
    ["genfx: trading is disabled for this instrument", refused],
    ["genfx: entry_deadline_passed (sell 1.12075)", refused],
    ["genfx: some_new_code", refused],
  ];
  for (const [given, shown] of errors) assert.equal(safeErrorNote(given), shown, given);

  const at = iso(NOW - 3 * MIN + 2_877), atShown = iso(NOW - 5 * MIN);       // 02:57:02.877 → 02:55
  const row = (o: Record<string, unknown>) => ({ user_id: "u1", symbol: "EURUSD", side: "sell", created_at: at, account_id: "828568", order_id: null, ...o });
  const warn = "genfx: AN ORDER WHOSE OUTCOME IS UNKNOWN WAS SENT AFTER ITS RECORD HAD BEEN CLOSED — if it reached the broker it is NOT being followed. CHECK THIS ACCOUNT";
  const rows = [
    row({ id: 1, side: "buy", status: "skipped", reason: "genfx: credits (not enough credits for this trade)", entry: 1.12075, stop: 1.11881, tp: 1.12533 }),
    row({ id: 2, status: "skipped", reason: "genfx: one_open (already in a EUR/USD sell on this account)" }),
    row({ id: 3, status: "deferred", reason: "genfx: Reason for rejection: New orders are forbidden" }),
    row({ id: 4, status: "fanout", symbol: "GBPJPY", side: "buy", reason: "genfx: fanout 12 armed → 3 placed (credits 5) · swing scanner · stop 35p", account_id: null }),
    // The broker refused it before an order existed: nothing is on the account, and the line says which way the call was.
    row({ id: 5, status: "error", reason: "genfx: Not enough margin to create Order 77 Sell 0.02 Price 1.12075", qty: 0.02 }),
    row({ id: 6, status: "error", side: "buy", symbol: "GBPJPY", reason: "genfx: entry_deadline_passed", qty: 0.02 }),
    // Orders of their own.
    row({ id: 7, status: "placed", symbol: "GBPJPY", reason: "genfx: accepted — its record is pending", order_id: "9002", qty: 0.02 }),
    row({ id: 8, status: "uncertain", reason: "genfx: order outcome unknown — being checked with the broker (timeout)" }),
    row({ id: 9, status: "cancelled", reason: "genfx: accepted — its record is pending", order_id: "9003" }),
    row({ id: 10, status: "error", reason: "genfx: the broker closed order 9004 early", order_id: 9004 }),
    // Alarms about their account, with or without an order's id on the line. These are never cut down:
    // the second one has figures in it, and must not come out reading "nothing was placed".
    row({ id: 11, status: "error", reason: warn, qty: 0.02 }),
    row({ id: 12, status: "error", reason: "genfx: not adopted — the broker tied this order to a position that is not this order's alone: it is 0.05 lots and the order was 0.02 — CHECK THIS ACCOUNT" }),
    row({ id: 13, status: "error", reason: "genfx: the stop could not be confirmed on a position — CHECK SL/TP ON THE POSITION" }),
    row({ id: 14, status: "error", reason: "genfx: SWITCHED OFF on this account — the broker put a GEN FX order into a position that was already open (the account nets its positions)" }),
    row({ id: 15, status: "error", reason: "genfx: ORDER 9001 WAS ACCEPTED AFTER ITS RECORD HAD BEEN CLOSED — it is on the account and is NOT being followed. CHECK THIS ACCOUNT", order_id: "9001" }),
  ];
  const out = lockActivity(rows);
  const locked = (o: Record<string, unknown>) => ({ symbol: "EURUSD", side: null, created_at: atShown, account_id: "828568", ...o });
  // Not theirs: six listed fields, no side, a safe reason, the time to the five minutes — and nothing else that was on the row.
  assert.deepEqual(out.slice(0, 6), [
    locked({ status: "skipped", reason: "genfx: credits (not enough credits for this trade)" }),
    locked({ status: "skipped", reason: "genfx: not taken" }),
    locked({ status: "deferred", reason: "genfx: not taken" }),
    locked({ status: "fanout", symbol: "GBPJPY", account_id: null, reason: "genfx: not taken" }),
    locked({ status: "error", reason: refused }),
    locked({ status: "error", symbol: "GBPJPY", reason: "genfx: entry_deadline_passed" }),
  ]);
  for (const r of out.slice(0, 6)) assert.deepEqual(Object.keys(r).sort(), ["account_id", "created_at", "reason", "side", "status", "symbol"]);
  // Theirs: sent as it was, side and all, to the second.
  for (let i = 6; i < rows.length; i++) assert.equal(out[i], rows[i], `row ${i + 1}`);
  const kept = JSON.stringify(out.slice(0, 6));
  for (const t of ['"buy"', '"sell"', "Sell", "1.12", "1.11", "user_id", "35p", "qty", "order_id", "02.877"]) assert.ok(!kept.includes(t), `${t} was sent`);
  // An order id that is empty is not an order; an alarm is an alarm only in its own capitals.
  assert.equal(lockActivity([row({ status: "error", reason: "genfx: Sell refused", order_id: "" })])[0].side, null);
  assert.equal(lockActivity([row({ status: "skipped", reason: "genfx: check this account's sell at 1.12075" })])[0].reason, "genfx: not taken");
});

test("an alarm about a member's account is sent whole however long it ran: a line is cut to 200 characters when it is written", () => {
  // Every alarm GEN FX writes (genfx/settle.ts, genfx/place.ts), each with the longest detail it can carry, cut as it is stored.
  const whys = [
    "it is on the other side", "it is 12.34 lots and the order was 0.02", "it is on another instrument", "it was opened before the order was sent",
    "another trade's ledger row already holds it", "another trade's ledger row already holds it (and it is 12.34 lots and the order was 0.02)",
    "the broker's history shows another order in the same position",
  ];
  const lines = [
    ...whys.map((w) => `not adopted — the broker tied this order to a position that is not this order's alone: ${w} — CHECK THIS ACCOUNT`),
    "not booked — the position this order opened is not in the broker's open list, and nothing in its history closed it — CHECK THIS ACCOUNT",
    "the stop could not be confirmed on a position — CHECK SL/TP ON THE POSITION",
    "SWITCHED OFF on this account — the broker put a GEN FX order into a position that was already open (the account nets its positions)",
    "AN ORDER WHOSE OUTCOME IS UNKNOWN WAS SENT AFTER ITS RECORD HAD BEEN CLOSED — if it reached the broker it is NOT being followed. CHECK THIS ACCOUNT",
    "ORDER ? WAS ACCEPTED AFTER ITS RECORD HAD BEEN CLOSED — it is on the account and is NOT being followed. CHECK THIS ACCOUNT",
    "ORDER 4417720931 WAS ACCEPTED AFTER ITS RECORD HAD BEEN CLOSED — it is on the account and is NOT being followed. CHECK THIS ACCOUNT",
  ].map((t) => `genfx: ${t}`.slice(0, 200));
  // The case this is for: the longest of them loses its closing words to the cut, and is an alarm all the same.
  assert.ok(lines.some((l) => l.length === 200 && !l.includes("CHECK THIS ACCOUNT")), "one of them is long enough to lose its closing words");
  for (const reason of lines) {
    const row = { user_id: "u1", symbol: "GBPJPY", side: "buy", status: "error", created_at: iso(NOW - 62_877), account_id: "828568", order_id: null, qty: 0.02, reason };
    assert.equal(lockActivity([row])[0], row, reason);
  }
  // …and these are all of them: a new alarm added to either file is a new line to list here.
  const settle = code("src/lib/genfx/settle.ts"), place = code("src/lib/genfx/place.ts");
  assert.deepEqual((settle.match(/say\("error", [^)]*\)/g) ?? []).sort(), [
    'say("error", "the stop could not be confirmed on a position — CHECK SL/TP ON THE POSITION")',
    'say("error", `${UNSEEN_NOTE} — CHECK THIS ACCOUNT`)',
    'say("error", `${note} — CHECK THIS ACCOUNT`)',
  ]);
  assert.ok(settle.includes("const note = `not adopted — the broker tied this order to a position that is not this order's alone: ${foreign.why}`;"));
  assert.ok(settle.includes('const UNSEEN_NOTE = "not booked — the position this order opened is not in the broker\'s open list, and nothing in its history closed it";'));
  assert.ok(settle.includes("const reason = `genfx: SWITCHED OFF on this account — ${why}`.slice(0, 200);"));
  assert.deepEqual((settle.match(/status: "error"/g) ?? []).length, 1, "the stand-down line is the only error line settle.ts writes outside say()");
  const placed = place.match(/status: "error"[^\n]*/g) ?? [];
  assert.equal(placed.length, 2);
  assert.ok(placed[0].includes('reason: "genfx: AN ORDER WHOSE OUTCOME IS UNKNOWN WAS SENT AFTER ITS RECORD HAD BEEN CLOSED — if it reached the broker it is NOT being followed. CHECK THIS ACCOUNT"'));
  assert.ok(placed[1].includes('reason: `genfx: ORDER ${orderId ?? "?"} WAS ACCEPTED AFTER ITS RECORD HAD BEEN CLOSED — it is on the account and is NOT being followed. CHECK THIS ACCOUNT`'));
  // What is NOT an alarm stays cut down: the broker's refusal in its own words, whatever it shouts.
  for (const reason of ["genfx: Not enough margin to create Order 77 Sell 0.02 Price 1.12075", "genfx: ORDER REJECTED: SELL LIMIT 1.12075", "genfx: not enough money", "genfx: the stop is too close"]) {
    const out = lockActivity([{ symbol: "EURUSD", side: "sell", status: "error", created_at: iso(NOW), account_id: "1", order_id: null, reason }])[0];
    assert.deepEqual([out.side, out.reason], [null, "genfx: order not placed (the broker refused it)"], reason);
  }
});

test("FLOW's read with the window closed: the market, its price and the stage — not the entry engine's verdict", () => {
  const payload = {
    ok: true, symbol: "XAUUSD", instrument: { canonical: "XAUUSD", label: "Gold (XAU/USD)", assetClass: "gold", pipSize: 0.1, pricePrecision: 2 }, mode: "swing", price: 4122.01, data_status: "live", session: "Asia",
    entry_engine: { entryState: "ENTER_ON_PULLBACK", direction: "SHORT", actionable: true, headline: "SELL LIMIT 4130.90", preferredEntry: 4130.9, reasons: ["Sell the rally into 4129.98–4131.84"] },
    confirm: { state: "AT_ZONE", detail: "Price 4129.80 is at the sell zone" },
    g: { symbol: "XAUUSD", directional_bias: READ.directional_bias, action: READ.action, engine_state: READ.engine_state, confidence_score: 66, entry: READ.entry, entry_low: READ.entry_low, entry_high: READ.entry_high, stop_loss: READ.stop_loss, tp1: READ.tp1, tp2: READ.tp2, tp3: READ.tp3, stop_pips: READ.stop_pips, tp1_pips: READ.tp1_pips, tp2_pips: READ.tp2_pips, tp3_pips: READ.tp3_pips, market_regime: READ.market_regime, session: "Asia" },
  };
  const out = lockFlowRead(payload);
  // "Stand aside" is said of a trade against the trend and "enter on the pullback" of one with it: the state is half of which way.
  assert.deepEqual(out, { ok: true, symbol: "XAUUSD", instrument: payload.instrument, mode: "swing", price: 4122.01, data_status: "live", session: "Asia", entry_engine: null, g: null, locked: { stage: "forming" } });
  const sent = JSON.stringify(out);
  for (const t of ["4130", "4129", "4131", "4170", "4048", "SELL", "sell", "SHORT", "bear", "PULLBACK", "headline", "confirm", "pips"]) assert.ok(!sent.includes(t), `${t} was sent`);
  assert.deepEqual(lockFlowRead({ g: { action: "BUY_NOW" } }).locked, { stage: "live" });
});

/* ── the window ───────────────────────────────────────────────────────────────────────────────── */

test("a FLOW read is drawn only under the market and horizon it was made for", () => {
  const read = { symbol: "XAUUSD", mode: "quick", g: {} };
  assert.equal(readFits(read, "XAUUSD", "quick"), true);
  // Another market, another horizon: not this screen's read.
  assert.equal(readFits(read, "EURUSD", "quick"), false);
  assert.equal(readFits(read, "XAUUSD", "intraday"), false);
  assert.equal(readFits({ symbol: "EURUSD", mode: "swing" }, "XAUUSD", "quick"), false);
  // Spelling is not what is compared: the route upper-cases the symbol it echoes, whatever the list of markets calls it.
  assert.equal(readFits({ symbol: "XAUUSD", mode: "quick" }, "XauUsd", "quick"), true);
  assert.equal(readFits({ symbol: "xauusd", mode: "QUICK" }, "XAUUSD", "quick"), true);
  // A read that does not say what it is for (an older server) is drawn, as it always was; no read at all is not.
  for (const bare of [{}, { symbol: null, mode: null }, { symbol: "", mode: "" }, { symbol: "XAUUSD" }, { mode: "quick" }]) assert.equal(readFits(bare, "XAUUSD", "quick"), true, JSON.stringify(bare));
  assert.equal(readFits({ symbol: "XAUUSD" }, "EURUSD", "quick"), false);
  for (const none of [null, undefined]) assert.equal(readFits(none, "XAUUSD", "quick"), false);
});

test("the window: 30 minutes from a spend, as the Command Center's is; open without a clock for a Pass or an admin", () => {
  assert.equal(SETUP_WINDOW_MS, 30 * MIN);
  assert.equal(SETUP_MINUTES, 30);
  assert.deepEqual([SETUP_WINDOW_MS, SETUP_COST], [CC_PASS_MS, CC_PASS_COST], "the owner's own rule for the Command Center: 5 credits, 30 minutes");
  assert.equal(SETUP_COST, CREDIT_COST.genx, "one read");
  assert.equal(READ_FEATURE, "genx", "charged as a read: no price of its own, no new line in the tariff");
  assert.deepEqual([...READ_FEATURES], ["genx", "ghost"], "the two ledger lines that are a read of this engine's play");
  assert.deepEqual(OPEN_FREE, { cost: 5, minutes: 30, open: true, via: "free", until: null });
  assert.ok(!("setups" in CREDIT_COST));
  const base = { cost: 5, minutes: 30 };
  assert.deepEqual(gateFrom({ admin: false, pass: false, lastSpendMs: null }, NOW), { ...base, open: false, via: null, until: null });
  assert.deepEqual(gateFrom({ admin: false, pass: false, lastSpendMs: NOW - 10 * MIN }, NOW), { ...base, open: true, via: "credits", until: iso(NOW + 20 * MIN) });
  assert.equal(gateFrom({ admin: false, pass: false, lastSpendMs: NOW - 30 * MIN + 1 }, NOW).open, true, "a millisecond inside");
  assert.equal(gateFrom({ admin: false, pass: false, lastSpendMs: NOW - 30 * MIN }, NOW).open, false, "the half hour is up");
  assert.equal(gateFrom({ admin: false, pass: false, lastSpendMs: NaN }, NOW).open, false);
  assert.deepEqual(gateFrom({ admin: false, pass: true, lastSpendMs: null }, NOW), { ...base, open: true, via: "pass", until: null });
  assert.deepEqual(gateFrom({ admin: true, pass: true, lastSpendMs: NOW }, NOW), { ...base, open: true, via: "admin", until: null });
  assert.deepEqual(CLOSED, { ...base, open: false, via: null, until: null });
  assert.equal(OPEN_UNMETERED.open, true);
});

test("minutes left are shown for a paid window only, rounded up", () => {
  const paid = (ms: number): SetupGate => ({ open: true, via: "credits", until: iso(NOW + ms), cost: 5, minutes: 30 });
  assert.equal(minutesLeft(paid(30 * MIN), NOW), 30);
  assert.equal(minutesLeft(paid(12 * MIN + 1), NOW), 13);
  assert.equal(minutesLeft(paid(1), NOW), 1);
  assert.equal(minutesLeft(paid(0), NOW), null);
  assert.equal(minutesLeft(paid(-5000), NOW), null);
  for (const g of [null, CLOSED, OPEN_UNMETERED, { open: true, via: "pass", until: null, cost: 5, minutes: 30 } as SetupGate, { open: true, via: "credits", until: "soon", cost: 5, minutes: 30 } as SetupGate]) assert.equal(minutesLeft(g, NOW), null);
  // A Pass or an admin has no clock even if one were sent; nor does a window that is not open.
  for (const via of ["pass", "admin"] as const) assert.equal(minutesLeft({ open: true, via, until: iso(NOW + 5 * MIN), cost: 5, minutes: 30 }, NOW), null, via);
  assert.equal(minutesLeft({ open: false, via: "credits", until: iso(NOW + 5 * MIN), cost: 5, minutes: 30 }, NOW), null);
});

/* ── who has a window: the lookup, against tables that answer like the real ones ──────────────── */

type Row = Record<string, unknown>;
type Db = { credit_transactions?: Row[]; flow_billing_events?: Row[]; profiles?: Row[]; user_subscriptions?: Row[]; genfx_control?: Row[] };
/** A database that filters, sorts and limits the way the real one does, so a test can put a row in a ledger and see whether it opens anything. */
function fakeDb(db: Db, opts: { fail?: (keyof Db)[]; boom?: (keyof Db)[] } = {}) {
  const calls: string[] = [];
  const admin = {
    from(table: keyof Db) {
      calls.push(table);
      let out = [...(db[table] ?? [])];
      const q: Record<string, unknown> = {
        select: () => q,
        eq: (c: string, v: unknown) => { out = out.filter((r) => r[c] === v); return q; },
        in: (c: string, vs: unknown[]) => { out = out.filter((r) => vs.includes(r[c])); return q; },
        gt: (c: string, v: number) => { out = out.filter((r) => Number(r[c]) > v); return q; },
        lt: (c: string, v: number) => { out = out.filter((r) => Number(r[c]) < v); return q; },
        gte: (c: string, v: string) => { out = out.filter((r) => String(r[c]) >= v); return q; },
        order: (c: string, o: { ascending: boolean }) => { out.sort((a, b) => (String(a[c]) < String(b[c]) ? -1 : 1) * (o.ascending ? 1 : -1)); return q; },
        limit: (n: number) => { out = out.slice(0, n); return q; },
        maybeSingle: async () => {
          if (opts.boom?.includes(table)) throw new Error("network");
          if (opts.fail?.includes(table)) return { data: null, error: { message: "timeout" } };
          return { data: out[0] ?? null, error: null };
        },
      };
      return q;
    },
  };
  return { admin: admin as never, calls };
}
let uid = 0;
const member = () => `member-${++uid}`;
const spend = (user_id: string, agoMs: number, o: Row = {}): Row => ({ user_id, kind: "spend", feature: "genx", amount: -5, created_at: iso(NOW - agoMs), ...o });
const fee = (user_id: string, agoMs: number, o: Row = {}): Row => ({ user_id, event_key: `k${agoMs}`, kind: "setup", cost: 1, at: iso(NOW - agoMs), ...o });
const pass = (user_id: string, o: Row = {}): Row => ({ user_id, plan: "flow_pass", status: "active", stripe_customer_id: null, stripe_subscription_id: null, current_period_end: iso(Date.now() + 86_400_000), cancel_at_period_end: false, canceled_at: null, ...o });
const open = (untilMs: number): SetupGate => ({ cost: 5, minutes: 30, open: true, via: "credits", until: iso(untilMs) });
const look = (db: Db, id: string, o: { fail?: (keyof Db)[]; boom?: (keyof Db)[] } = {}) => lookAtSetupAccess(fakeDb(db, o).admin, id, { nowMs: NOW, fresh: true });

test("a read the member was charged for opens the window for the 30 minutes after it", async () => {
  const id = member();
  const { admin, calls } = fakeDb({ credit_transactions: [spend(id, 10 * MIN)] });
  assert.deepEqual(await lookAtSetupAccess(admin, id, { nowMs: NOW }), { gate: open(NOW + 20 * MIN), complete: true });
  assert.deepEqual([...calls].sort(), ["credit_transactions", "flow_billing_events", "profiles", "user_subscriptions"], "four reads, one of each");
  // The newest spend sets the clock.
  assert.deepEqual((await look({ credit_transactions: [spend(id, 25 * MIN), spend(id, 2 * MIN), spend(id, 14 * MIN)] }, id)).gate, open(NOW + 28 * MIN));
  // Half an hour on, it has closed.
  assert.deepEqual(await look({ credit_transactions: [spend(id, 30 * MIN)] }, id), { gate: CLOSED, complete: true });
  assert.equal((await look({ credit_transactions: [spend(id, 30 * MIN - 1000)] }, id)).gate.open, true);
  // An MFX Ghost read is a read of the same engine's play.
  assert.deepEqual((await look({ credit_transactions: [spend(id, 4 * MIN, { feature: "ghost" })] }, id)).gate, open(NOW + 26 * MIN));
});

test("nothing else in the member's ledger opens it — least of all a line a member can write for one credit", async () => {
  const id = member();
  const not: [string, Row][] = [
    // spend_credits takes the feature's name from the caller: any signed-in member can write this line themselves, for 1 credit.
    ["a flow_autorun line in the ledger", spend(id, MIN, { feature: "flow_autorun", amount: -1 })],
    ["a chat message", spend(id, MIN, { feature: "chat", amount: -1 })],
    ["a market scan", spend(id, MIN, { feature: "scan" })],
    ["a Command Center pass", spend(id, MIN, { feature: "command_center" })],
    ["a chart read", spend(id, MIN, { feature: "chartread", amount: -2 })],
    ["a credit purchase", spend(id, MIN, { kind: "purchase", feature: null, amount: 50 })],
    ["a weekly top-up", spend(id, MIN, { kind: "grant", amount: 5 })],
    ["a Pass holder's free read, once the Pass has gone", spend(id, MIN, { kind: "pass", amount: 0 })],
    ["a read that took no credits", spend(id, MIN, { amount: 0 })],
    ["a correction to the balance that is not a spend", spend(id, MIN, { kind: "admin", amount: -5 })],
    ["a line that added credits", spend(id, MIN, { amount: 5 })],
    ["an MFX Ghost line that took nothing", spend(id, MIN, { feature: "ghost", amount: 0 })],
    ["another member's read", spend("someone-else", MIN)],
    ["a read from before the half hour", spend(id, 31 * MIN)],
  ];
  for (const [what, row] of not) assert.deepEqual(await look({ credit_transactions: [row] }, id), { gate: CLOSED, complete: true }, what);
  assert.deepEqual(await look({ credit_transactions: not.map(([, r]) => r) }, id), { gate: CLOSED, complete: true }, "all of them together");
  assert.deepEqual(await look({}, id), { gate: CLOSED, complete: true }, "no rows at all");
});

test("a fee FLOW charged the member opens it too — read from FLOW's own record of its fees", async () => {
  const id = member();
  assert.deepEqual(await look({ flow_billing_events: [fee(id, 5 * MIN)] }, id), { gate: open(NOW + 25 * MIN), complete: true });
  assert.deepEqual((await look({ flow_billing_events: [fee(id, 5 * MIN, { kind: "trade", cost: 5 })] }, id)).gate, open(NOW + 25 * MIN));
  // A fee that cost nothing (a Pass holder's, a waived one) is not a spend; nor is someone else's, nor an old one.
  for (const row of [fee(id, MIN, { cost: 0 }), fee("someone-else", MIN), fee(id, 31 * MIN)]) assert.deepEqual(await look({ flow_billing_events: [row] }, id), { gate: CLOSED, complete: true }, JSON.stringify(row));
  // Whichever ledger has the newer spend sets the clock.
  assert.deepEqual((await look({ credit_transactions: [spend(id, 20 * MIN)], flow_billing_events: [fee(id, 5 * MIN)] }, id)).gate, open(NOW + 25 * MIN));
  assert.deepEqual((await look({ credit_transactions: [spend(id, 3 * MIN)], flow_billing_events: [fee(id, 12 * MIN)] }, id)).gate, open(NOW + 27 * MIN));
  // A date that is not a date opens nothing.
  assert.deepEqual((await look({ credit_transactions: [spend(id, 0, { created_at: "yesterday" })] }, id)).gate, CLOSED);
});

test("a FLOW Pass or an admin: open, with no clock; a Pass that has gone is not a Pass", async () => {
  const id = member();
  assert.deepEqual(await look({ profiles: [{ id, role: "admin" }] }, id), { gate: { cost: 5, minutes: 30, open: true, via: "admin", until: null }, complete: true });
  assert.deepEqual(await look({ profiles: [{ id, role: "member" }], user_subscriptions: [pass(id)] }, id), { gate: { cost: 5, minutes: 30, open: true, via: "pass", until: null }, complete: true });
  for (const sub of [pass(id, { status: "canceled" }), pass(id, { current_period_end: iso(Date.now() - 3600_000) }), pass(id, { plan: "trading_suite" }), pass("someone-else")]) {
    assert.deepEqual(await look({ profiles: [{ id, role: "member" }], user_subscriptions: [sub] }, id), { gate: CLOSED, complete: true }, JSON.stringify(sub));
  }
  assert.deepEqual(await look({ profiles: [{ id: "someone-else", role: "admin" }] }, id), { gate: CLOSED, complete: true });
});

test("what cannot be read counts for nothing, and the answer says it could not tell", async () => {
  const id = member();
  const all: Db = { credit_transactions: [spend(id, MIN)], flow_billing_events: [fee(id, MIN)], profiles: [{ id, role: "admin" }], user_subscriptions: [pass(id)] };
  const tables = ["credit_transactions", "flow_billing_events", "profiles", "user_subscriptions"] as const;
  // No way to look at all.
  assert.deepEqual(await lookAtSetupAccess(null, id, { nowMs: NOW }), { gate: CLOSED, complete: false });
  // Everything unreadable — by an error answer or by a thrown one: closed, and marked as a guess.
  for (const how of ["fail", "boom"] as const) assert.deepEqual(await look(all, id, how === "fail" ? { fail: [...tables] } : { boom: [...tables] }), { gate: CLOSED, complete: false }, how);
  // One part unreadable: that part counts for nothing, the rest still does, and the answer is still marked.
  assert.deepEqual(await look({ ...all, profiles: [], user_subscriptions: [] }, id, { fail: ["credit_transactions"] }), { gate: open(NOW + 29 * MIN), complete: false }, "the FLOW fee still opens it");
  assert.deepEqual(await look({ credit_transactions: [spend(id, MIN)] }, id, { boom: ["flow_billing_events"] }), { gate: open(NOW + 29 * MIN), complete: false });
  assert.deepEqual(await look({ user_subscriptions: [pass(id)] }, id, { fail: ["credit_transactions", "flow_billing_events"] }), { gate: { cost: 5, minutes: 30, open: true, via: "pass", until: null }, complete: false });
  // An admin whose profile could not be read is not taken for one — and "closed" here is not "has no window".
  assert.deepEqual(await look({ profiles: [{ id, role: "admin" }] }, id, { fail: ["profiles"] }), { gate: CLOSED, complete: false });
  assert.deepEqual(await look({ user_subscriptions: [pass(id)] }, id, { boom: ["user_subscriptions"] }), { gate: CLOSED, complete: false });
  for (const t of tables) assert.equal((await look({}, id, { fail: [t] })).complete, false, t);
  // The pages are given the gate alone.
  assert.deepEqual(await setupAccess(fakeDb(all, { fail: [...tables] }).admin, id, { nowMs: NOW, fresh: true }), CLOSED);
});

test("an open window is remembered for a minute and never past its end; a closed one is never remembered", async () => {
  // Closed: every look asks. The page that takes the credits and the pages that show the play run on
  // different servers, so a remembered "closed" would tell a member who has just paid that they are locked out.
  const a = fakeDb({}), id = member();
  await setupAccess(a.admin, id, { nowMs: NOW });
  assert.equal(a.calls.length, 4, "one look, four reads");
  await setupAccess(a.admin, id, { nowMs: NOW + 1 });
  assert.equal(a.calls.length, 8, "asked again a millisecond later");
  // So a spend made on another server is seen by the very next look, fresh or not.
  const paid = fakeDb({ credit_transactions: [spend(id, -1000)] });
  assert.equal((await setupAccess(paid.admin, id, { nowMs: NOW + 2000 })).open, true);
  assert.equal(paid.calls.length, 4);
  // Open: answered from memory…
  a.calls.length = 0;
  assert.equal((await setupAccess(a.admin, id, { nowMs: NOW + 3000 })).open, true, "the open answer is the remembered one now");
  assert.equal(a.calls.length, 0);
  // …unless the look is marked fresh, which always asks — and what it finds replaces what was remembered.
  assert.equal((await setupAccess(a.admin, id, { nowMs: NOW + 4000, fresh: true })).open, false);
  assert.equal(a.calls.length, 4);
  assert.equal((await setupAccess(paid.admin, id, { nowMs: NOW + 5000 })).open, true);
  assert.equal(paid.calls.length, 8, "the closed answer was not kept");

  // Open on credits: remembered for a minute, and never past the end of the window.
  const id2 = member(), b = fakeDb({ credit_transactions: [spend(id2, 29 * MIN + 30_000)] });
  const g = await setupAccess(b.admin, id2, { nowMs: NOW });
  assert.deepEqual([g.open, g.until], [true, iso(NOW + 30_000)]);
  assert.equal((await setupAccess(b.admin, id2, { nowMs: NOW + 29_000 })).open, true);
  assert.equal(b.calls.length, 4);
  assert.equal((await setupAccess(b.admin, id2, { nowMs: NOW + 30_000 })).open, false, "at the end of the window the ledger is asked, not memory");
  assert.equal(b.calls.length, 8);
  const id3 = member(), c = fakeDb({ credit_transactions: [spend(id3, MIN)] });
  await setupAccess(c.admin, id3, { nowMs: NOW });
  await setupAccess(c.admin, id3, { nowMs: NOW + 59_000 });
  assert.equal(c.calls.length, 4);
  await setupAccess(c.admin, id3, { nowMs: NOW + 60_000 });
  assert.equal(c.calls.length, 8, "an open answer is checked again after a minute");

  // Forgetting: the next look asks.
  const id4 = member(), d = fakeDb({ profiles: [{ id: id4, role: "admin" }] });
  await setupAccess(d.admin, id4, { nowMs: NOW });
  forgetSetupAccess(id4);
  await setupAccess(d.admin, id4, { nowMs: NOW + 1 });
  assert.equal(d.calls.length, 8);
  // A look that could not read everything is not kept — not even an open one — and it drops what was kept before.
  const id5 = member(), e = fakeDb({ credit_transactions: [spend(id5, MIN)] }, { fail: ["profiles"] });
  assert.equal((await setupAccess(e.admin, id5, { nowMs: NOW })).open, true);
  await setupAccess(e.admin, id5, { nowMs: NOW + 1000 });
  assert.equal(e.calls.length, 8, "asked again a second later");
  const id6 = member(), ok = fakeDb({ profiles: [{ id: id6, role: "admin" }] }), bad = fakeDb({}, { boom: ["profiles"] });
  assert.equal((await setupAccess(ok.admin, id6, { nowMs: NOW })).open, true);
  assert.equal((await setupAccess(bad.admin, id6, { nowMs: NOW + 1000, fresh: true })).open, false);
  assert.equal((await setupAccess(ok.admin, id6, { nowMs: NOW + 2000 })).open, true);
  assert.equal(ok.calls.length, 8, "the failed look left nothing behind to answer from");
  // One member's answer is never another's.
  const adminId = member(), other = member();
  assert.equal((await setupAccess(fakeDb({ profiles: [{ id: adminId, role: "admin" }] }).admin, adminId, { nowMs: NOW })).open, true);
  assert.equal((await setupAccess(fakeDb({}).admin, other, { nowMs: NOW })).open, false);
});

test("GEN FX is free only when the owner's switch says so: off is free, on is not, and unreadable is not off", async () => {
  const ctl = (billing_enabled: unknown) => fakeDb({ genfx_control: [{ id: 1, billing_enabled }] });
  forgetGenfxFree();
  const off = ctl(false);
  assert.equal(await genfxIsFree(off.admin, NOW), true);
  assert.equal(await genfxIsFree(ctl(true).admin, NOW + 9_000), true, "kept for ten seconds: less than one poll of a card");
  assert.equal(off.calls.length, 1);
  assert.equal(await genfxIsFree(ctl(true).admin, NOW + 10_000), false, "then asked again");
  assert.equal(await genfxIsFree(off.admin, NOW + 11_000), false, "and that answer is kept for its ten seconds too");
  forgetGenfxFree();
  assert.equal(await genfxIsFree(off.admin, NOW + 12_000), true, "unless it is forgotten: the switch was just changed");
  // Anything but a plain "off" is not free; nor is a switch that cannot be read, and that answer is not kept.
  for (const v of [null, undefined, "false", 0]) { forgetGenfxFree(); assert.equal(await genfxIsFree(ctl(v).admin, NOW), false, String(v)); }
  forgetGenfxFree();
  assert.equal(await genfxIsFree(null, NOW), false);
  assert.equal(await genfxIsFree(fakeDb({}).admin, NOW), false, "no row");
  for (const how of ["fail", "boom"] as const) assert.equal(await genfxIsFree(fakeDb({ genfx_control: [{ id: 1, billing_enabled: false }] }, how === "fail" ? { fail: ["genfx_control"] } : { boom: ["genfx_control"] }).admin, NOW), false, how);
  assert.equal(await genfxIsFree(off.admin, NOW), true, "the failures left nothing behind: the next look asks and is believed");
  forgetGenfxFree();
});

/* ── "See the play": what is charged, when, and what is answered ──────────────────────────────── */

const SEEN_OPEN: SetupLook = { gate: open(NOW + 30 * MIN), complete: true };
const SEEN_CLOSED: SetupLook = { gate: CLOSED, complete: true };
const COULD_NOT_TELL: SetupLook = { gate: CLOSED, complete: false };
const CAN_PAY: GateAnswer = { ok: true };
const SHORT: GateAnswer = { ok: false, reason: "insufficient", balance: 3 };
/** The member, the ledger and the charge, scripted: each call takes the next answer, and one that was not expected fails the test. */
function tap(o: { looks: SetupLook[]; gates?: GateAnswer[]; charges?: (number | null)[] }) {
  const log: string[] = [];
  const looks = [...o.looks], gates = [...(o.gates ?? [])], charges = [...(o.charges ?? [])];
  const next = <T>(what: string, from: T[]): T => { log.push(what); if (!from.length) throw new Error(`an unexpected ${what}`); return from.shift() as T; };
  const d: PassDeps = {
    look: async () => next("look", looks),
    gate: async () => next("gate", gates),
    charge: async () => next("charge", charges),
    forget: () => { log.push("forget"); },
    now: () => NOW,
  };
  return { run: () => openSetups(d), log };
}

test("See the play: nothing is charged while a window is open", async () => {
  const windows: SetupGate[] = [open(NOW + 12 * MIN), { cost: 5, minutes: 30, open: true, via: "pass", until: null }, { cost: 5, minutes: 30, open: true, via: "admin", until: null }];
  for (const gate of windows) {
    for (const complete of [true, false]) {
      const t = tap({ looks: [{ gate, complete }] });
      assert.deepEqual(await t.run(), { status: 200, body: { ...gate, charged: false } }, `${gate.via}, complete ${complete}`);
      assert.deepEqual(t.log, ["look"], "no balance check, no charge");
    }
  }
});

test("See the play: nothing is charged on a guess — a look that could not read the ledgers takes no credits", async () => {
  const t = tap({ looks: [COULD_NOT_TELL] });
  assert.deepEqual(await t.run(), { status: 503, body: { ...CLOSED, charged: false, error: "unavailable" } });
  assert.deepEqual(t.log, ["look"]);
});

test("See the play: not signed in, or not enough credits — refused before any charge", async () => {
  const a = tap({ looks: [SEEN_CLOSED], gates: [{ ok: false, reason: "unauthorized" }] });
  assert.deepEqual(await a.run(), { status: 401, body: { ...CLOSED, charged: false, error: "unauthorized" } });
  const b = tap({ looks: [SEEN_CLOSED], gates: [SHORT] });
  assert.deepEqual(await b.run(), { status: 402, body: { ...CLOSED, charged: false, error: "insufficient", balance: 3 } });
  for (const t of [a, b]) assert.deepEqual(t.log, ["look", "gate"]);
});

test("See the play: one spend opens the window, and the answer is the window the ledger now shows", async () => {
  const t = tap({ looks: [SEEN_CLOSED, SEEN_OPEN], gates: [CAN_PAY], charges: [37] });
  assert.deepEqual(await t.run(), { status: 200, body: { ...open(NOW + 30 * MIN), charged: true, balance: 37 } });
  assert.deepEqual(t.log, ["look", "gate", "charge", "forget", "look"], "what was remembered is dropped before the ledger is asked again");
  // The spend went through but the look after it failed, or did not show it yet: they are not told
  // "locked" for what they have just paid for. The window runs from now.
  for (const after of [COULD_NOT_TELL, SEEN_CLOSED]) {
    const u = tap({ looks: [SEEN_CLOSED, after], gates: [CAN_PAY], charges: [0] });
    assert.deepEqual(await u.run(), { status: 200, body: { ...open(NOW + 30 * MIN), charged: true, balance: 0 } });
  }
  // A Pass that arrived between the look and the charge: the charge spent nothing (credits.ts), and the answer says so.
  const passGate: SetupGate = { cost: 5, minutes: 30, open: true, via: "pass", until: null };
  const p = tap({ looks: [SEEN_CLOSED, { gate: passGate, complete: true }], gates: [CAN_PAY], charges: [40] });
  assert.deepEqual(await p.run(), { status: 200, body: { ...passGate, charged: false, balance: 40 } });
});

test("See the play: a spend with no answer is looked for in the ledger before anything is said", async () => {
  // It went through; only the answer was lost. The window is open and they are told they were charged.
  const found = tap({ looks: [SEEN_CLOSED, SEEN_OPEN], gates: [CAN_PAY], charges: [null] });
  assert.deepEqual(await found.run(), { status: 200, body: { ...open(NOW + 30 * MIN), charged: true, balance: null } });
  assert.deepEqual(found.log, ["look", "gate", "charge", "forget", "look"]);
  // It was refused for want of credits (the first balance check lets a member through when the balance cannot be read).
  const short = tap({ looks: [SEEN_CLOSED, SEEN_CLOSED], gates: [CAN_PAY, SHORT], charges: [null] });
  assert.deepEqual(await short.run(), { status: 402, body: { ...CLOSED, charged: false, error: "insufficient", balance: 3 } });
  // It did not go through, and the ledger was read and shows nothing: certainly not charged.
  const failed = tap({ looks: [SEEN_CLOSED, SEEN_CLOSED], gates: [CAN_PAY, CAN_PAY], charges: [null] });
  assert.deepEqual(await failed.run(), { status: 200, body: { ...CLOSED, charged: false, error: "charge_failed" } });
  assert.deepEqual(failed.log, ["look", "gate", "charge", "forget", "look", "gate"]);
  // The ledger could not be read afterwards: whether they were charged is not known, and that is what is said —
  // even if the balance now looks short, which is what it would look like either way.
  for (const again of [CAN_PAY, SHORT]) {
    const unknown = tap({ looks: [SEEN_CLOSED, COULD_NOT_TELL], gates: [CAN_PAY, again], charges: [null] });
    assert.deepEqual(await unknown.run(), { status: 200, body: { ...CLOSED, charged: null, error: "charge_failed" } });
  }
});

test("See the play: whatever happens, one tap is at most one spend", async () => {
  const looks = [SEEN_OPEN, SEEN_CLOSED, COULD_NOT_TELL], gates: GateAnswer[] = [CAN_PAY, SHORT, { ok: false, reason: "unauthorized" }], charges = [37, null];
  let ran = 0;
  for (const first of looks) for (const g1 of gates) for (const c of charges) for (const second of looks) for (const g2 of gates) {
    const t = tap({ looks: [first, second], gates: [g1, g2], charges: [c] });
    const out = await t.run();
    ran += 1;
    const spends = t.log.filter((x) => x === "charge").length;
    assert.ok(spends <= 1);
    // No spend unless the first look was a certain "closed" and the balance check passed.
    if (spends) assert.ok(!first.gate.open && first.complete && g1.ok);
    // Told the window is open only if it was open already or a spend was attempted; told "charged" only after a spend.
    if (out.body.open) assert.ok(first.gate.open || spends === 1);
    if (out.body.charged) assert.equal(spends, 1);
    // A spend that returned a balance always ends with the window open.
    if (spends && c != null) assert.equal(out.body.open, true);
  }
  assert.equal(ran, 162);
});

test("one tap at a time: a second request while the first is between its look and its spend is turned away unspent", async () => {
  let release: (v: string) => void = () => {};
  const first = oneAtATime("m1", () => "busy", () => new Promise<string>((r) => { release = r; }));
  assert.equal(await oneAtATime("m1", () => "busy", async () => "ran"), "busy");
  assert.equal(await oneAtATime("m2", () => "busy", async () => "ran"), "ran", "another member is not held up");
  release("done");
  assert.equal(await first, "done");
  assert.equal(await oneAtATime("m1", () => "busy", async () => "ran"), "ran", "free again once the first has answered");
  // A request that throws does not leave the member locked out.
  await assert.rejects(oneAtATime("m1", () => "busy", async () => { throw new Error("boom"); }));
  assert.equal(await oneAtATime("m1", () => "busy", async () => "ran"), "ran");
});

test("what the button says: 'this tap took no credits' only where that is known", () => {
  const no = (message: string, flyer = false) => ({ opened: false, charged: false, flyer, message });
  // Open: the caller asks again; the balance in the header moves only if this tap spent credits.
  assert.deepEqual(tapOutcome(200, { ...open(NOW + 30 * MIN), charged: true, balance: 37 }), { opened: true, charged: true, flyer: false, message: "" });
  assert.deepEqual(tapOutcome(200, { ...open(NOW + 12 * MIN), charged: false }), { opened: true, charged: false, flyer: false, message: "" });
  assert.deepEqual(tapOutcome(200, { ...open(NOW + 30 * MIN), charged: null }), { opened: true, charged: false, flyer: false, message: "" });
  // Not enough credits: says how many they have, and opens the credits flyer.
  assert.deepEqual(tapOutcome(402, { ...CLOSED, charged: false, error: "insufficient", balance: 3 }), no("Not enough credits — you have 3.", true));
  assert.deepEqual(tapOutcome(402, null), no("Not enough credits.", true));
  assert.deepEqual(tapOutcome(401, { error: "unauthorized" }), no("Sign in again to continue."));
  // Known not charged.
  assert.deepEqual(tapOutcome(503, { ...CLOSED, charged: false, error: "unavailable" }), no("Couldn't check your access just now, so this tap took no credits. Try again in a moment."));
  assert.deepEqual(tapOutcome(200, { ...CLOSED, charged: false, error: "charge_failed" }), no("That didn't go through, and this tap took no credits. Try again."));
  assert.deepEqual(tapOutcome(409, { ...CLOSED, charged: false, error: "busy" }), no("Already opening — one moment."));
  // Not known: no promise about the charge, only what is true either way — an open window is never charged again.
  const unsure = no("That didn't go through. Tap again — you won't be charged twice.");
  assert.deepEqual(tapOutcome(200, { ...CLOSED, charged: null, error: "charge_failed" }), unsure);
  for (const [status, reply] of [[0, null], [500, null], [502, {}], [200, {}], [200, { ...CLOSED }]] as const) assert.deepEqual(tapOutcome(status, reply), unsure, `${status} ${JSON.stringify(reply)}`);
  for (const m of [unsure.message, "Already opening — one moment.", "Sign in again to continue.", "Not enough credits — you have 3."]) assert.ok(!/took no credits|nothing was charged/.test(m));
});

/* ── the pages: a locked answer draws the lock ────────────────────────────────────────────────── */

test("the pay route is the tested steps wired to the real ledger, and nothing else in it can charge", () => {
  // (What it does is tested by calling it: tests/setup-lock-routes.test.ts. This holds how it is put together.)
  const p = code("src/app/api/setups/pass/route.ts");
  assert.ok(/const out = await oneAtATime\(userId, busy, \(\) => openSetups\(\{/.test(p));
  assert.ok(p.includes("look: () => lookAtSetupAccess(admin, userId, { fresh: true }),"), "the look that decides a charge is never from memory");
  assert.equal((p.match(/chargeCredit\(/g) ?? []).length, 1, "one place a charge can come from");
  // It is the ordinary read's price and the ordinary spend: no price of its own, no call to the database's spend by hand.
  assert.ok(!/p_cost|spend_credits|\.rpc\(/.test(p));
  // The steps themselves touch neither the database nor the credits module: they are handed both.
  assert.ok(!/supabase|lib\/credits|createAdminClient|\.rpc\(/.test(code("src/lib/setupPass.ts")));
  // The three answers that carry a play charge nothing themselves.
  for (const f of ["src/app/api/floor/setup/route.ts", "src/app/api/genfx/desk/route.ts", "src/app/api/flow/read/route.ts"]) assert.ok(!/chargeCredit|gateCredits|spend_credits/.test(code(f)), f);
});

test("the pages: a locked answer draws the lock, and the play is drawn only from an answer that has one", () => {
  const floor = src("src/components/portal/floor/FloorHome.tsx");
  assert.ok(floor.includes("const locked = data?.locked ?? null;"));
  // (Keyed by market and horizon: a message printed under one lock does not follow the member to another.)
  assert.ok(/\{locked \? \(\s*<LockedSetupCard key=\{`\$\{inst\.key\}:\$\{mode\}`\} what=\{`\$\{inst\.engine\} · \$\{mode\.toUpperCase\(\)\} — \$\{STAGE_TEXT\[locked\.stage\] \?\? STAGE_TEXT\.watching\}`\} gate=\{data\?\.setups\} candles=\{candles\} onOpened=\{\(\) => onOpened\?\.\(\)\} \/>\s*\) : !g \? \(/.test(floor));
  // An earlier map asked for after the window has closed: the card asks again, and says so.
  assert.ok(floor.includes("else if (r.status === 402) setSetupTick((n) => n + 1);"));
  assert.ok(floor.includes("onOpened={() => setSetupTick((n) => n + 1)}") && floor.includes("}, [setupMode, setupSym, setupTick]);"), "opening the window asks again at once");
  assert.ok(floor.includes('let first = "&fresh=1";') && floor.includes('const fresh = first; first = "";'), "the first look is a fresh one");
  assert.ok(floor.includes("setPastLocked(d.setups?.open === false);") && floor.includes("Earlier maps open with the play."));
  // A locked card does not go on to ask for the earlier maps: the server would only keep them back.
  const skip = floor.indexOf("if (lockedNow) { setPast([]); setPastLocked(true); return; }");
  assert.ok(skip > floor.indexOf("lockedNow = !!d.locked;") && skip < floor.indexOf("/api/floor/setup?history=1&"));
  const fx = src("src/components/portal/floor/GenFxDesk.tsx");
  assert.ok(fx.includes("const anyLocked = [...live, ...called].some((a) => a.locked);"));
  assert.ok(fx.includes('{nameOf(a.pair)}{a.locked || !a.side ? "" : ` ${a.side.toUpperCase()}`}'));
  assert.ok(/\{a\.locked\s*\? <span[^>]*>side, entry, stop and target open with credits<\/span>\s*: <span/.test(fx));
  assert.ok(fx.includes("onOpened={reload}") && fx.includes("<Watching desk={desk} reload={loadDesk} />"));
  assert.ok(fx.includes("void loadPlays(); void loadDesk();"), "a paid read opens the lists at once");
  const flow = code("src/components/portal/floor/FlowDesk.tsx");
  assert.ok(flow.includes("{res && locked && (") && flow.includes("{res && g && !locked && ("));
  // Opening the window reads the market on the screen NOW, and a read is drawn only under the market it was made for.
  assert.ok(flow.includes('<SetupLock key={`${symbol}:${mode}`} tone="light" className="mt-4" gate={res.setups} onOpened={() => runNow.current()}'));
  assert.ok(flow.includes("runNow.current = run;") && flow.includes("if (mine !== seq.current) return;"));
  assert.ok(flow.includes("const fits = readFits(res, symbol, mode);"));
  // An older read that fails, or finishes, after a newer one was asked for says nothing and stops no spinner.
  assert.ok(flow.includes('.catch(() => { if (mine === seq.current) setErr("Something went wrong — try again."); })'));
  assert.ok(flow.includes(".finally(() => { if (mine === seq.current) setLoading(false); });"));
  assert.ok(flow.includes("const g = fits ? res?.g : null;") && flow.includes("const locked = fits ? (res?.locked ?? null) : null;"));
  // The locked FLOW card has no side on it and no entry-engine state: both live only in the open one.
  const lockedCard = flow.slice(flow.indexOf("{res && locked && ("), flow.indexOf("{res && g && !locked && ("));
  assert.ok(lockedCard.length > 200 && !/\bside\b|\bstate\b|STATE_TONE|TrendingUp|TrendingDown|LevelCell|ExecuteFlow|entry_engine/.test(lockedCard), lockedCard);
  // The button: one tap is one request; it says what tapOutcome says; the header's balance is told when credits moved.
  const lock = src("src/components/portal/SetupLock.tsx");
  assert.ok(lock.includes('if (phase !== "idle") return;') && lock.includes("const out = tapOutcome(status, reply);") && lock.includes("setErr(out.message);"));
  // There is ONE place a payment is sent from, and every button goes through it (tests/setup-lock-pages.test.ts runs it).
  assert.equal((lock.match(/fetch\("\/api\/setups\/pass"/g) ?? []).length, 1);
  assert.ok(lock.includes("settle(await seeThePlayOnce());") && lock.includes("if (paying) return paying;"));
  // A lock drawn while a payment is out starts down and waits for that payment — held from the moment it was drawn.
  assert.ok(lock.includes("const [joined] = useState<Promise<TapOutcome> | null>(() => paying);") && lock.includes('useState<"idle" | "busy" | "opened">(joined ? "busy" : "idle")'));
  assert.ok(lock.includes("void joined.then((o) => { if (here) settle(o); });"));
  assert.ok(lock.includes('if (out.opened && out.charged) { try { window.dispatchEvent(new Event("credits-updated"));'));
  assert.ok(lock.includes('if (!out.opened && out.flyer) { try { window.dispatchEvent(new Event("open-credits-flyer"));'));
  assert.ok(lock.includes('disabled={phase !== "idle"}') && lock.includes("`See the play · ${cost} credits`"));
});

test("the phone app: the same lock on its FLOW screen, with the same button; its gold tile points there", () => {
  const app = src("public/app/index.html");
  const at = (s: string) => { const i = app.indexOf(s); assert.ok(i > 0, s); return i; };
  // The button: one request per tap, to the same route, with the same words for each way it can end.
  const lock = app.slice(at("function SeeThePlay(props) {"), at("  function FlowScreen(props) {"));
  // One request per tap — and one payment at a time for the whole app: the button never sends one itself,
  // it joins the one that is out, and a lock drawn while one is out starts down and waits for it.
  const once = app.slice(at("  function seeThePlayOnce() {"), at("  function SeeThePlay(props) {"));
  assert.ok(once.includes("if (seePlayOut) return seePlayOut;") && once.includes('var mine = apiPost("/api/setups/pass", {})') && once.includes("if (seePlayOut === mine) seePlayOut = null;"));
  assert.equal((app.match(/apiPost\("\/api\/setups\/pass"/g) ?? []).length, 1, "the app sends a payment from one place only");
  assert.ok(lock.includes('if (phase[0] !== "idle") return;') && lock.includes("seeThePlayOnce().then(settle);"));
  assert.ok(lock.includes("var joined = useState(function () { return seePlayOut; })[0];") && lock.includes('var phase = useState(joined ? "busy" : "idle")'));
  assert.ok(lock.includes("joined.then(function (o) { if (here) settle(o); });"));
  assert.ok(lock.includes('if (r && r.open) { phase[1]("opened"); if (now.onOpened) now.onOpened(); return; }'));
  for (const said of [
    "Couldn't check your access just now, so this tap took no credits. Try again in a moment.", "Already opening — one moment.",
    "That didn't go through, and this tap took no credits. Try again.", "That didn't go through. Tap again — you won't be charged twice.",
  ]) { assert.ok(lock.includes(said), said); assert.ok(tapMessages().includes(said), `the site says it too: ${said}`); }
  assert.ok(lock.includes('"See the play · " + cost + " credits"') && lock.includes("e.code === 402"));
  assert.deepEqual(JSON.parse(app.slice(at("var SETUP_STAGE = ") + 18, at("function setupStage(")).trim().replace(/;$/, "").replace(/(\w+):/g, '"$1":')), STAGE_TEXT);
  // FLOW's screen: a locked answer draws the lock where the entry card would be. Opening it reads again
  // even if a read was already on its way (that one was asked for before the window opened), and only
  // the last read asked for is drawn — an older one that comes back later cannot put the lock back.
  const flow = app.slice(at("  function FlowScreen(props) {"), at("  function GxReadDetail(props) {"));
  assert.ok(flow.includes('${d && d.locked ? html`<${SeeThePlay} what=${symbol[0] + " · " + String(mode[0]).toUpperCase() + " — " + setupStage(d.locked)} gate=${d.setups} onOpened=${function () { run(true); }} onLogout=${props.onLogout} />` : null}'));
  assert.ok(flow.includes("if (loading[0] && force !== true) return; loading[1](true);") && flow.includes("var mine = ++runSeq.current;"));
  // …and it is asked for the market on the screen at that moment, and drawn only under the market it was made for.
  assert.ok(flow.includes("picked.current = { mode: mode[0], symbol: symbol[0] };") && flow.includes('apiPost("/api/flow/read", { mode: picked.current.mode || mode[0], symbol: picked.current.symbol || symbol[0] })'));
  assert.ok(flow.includes("var d = flowReadFits(res[0], symbol[0], mode[0]) ? res[0] : null;"));
  // (The app cannot import the site's readFits; this is the same rule, word for word.)
  const fitsFn = app.slice(at("  function flowReadFits(d, symbol, mode) {"), at("  var seePlayOut = null;"));
  assert.ok(fitsFn.includes('function same(said, shown) { return said == null || said === "" || String(said).toUpperCase() === String(shown).toUpperCase(); }'));
  assert.ok(fitsFn.includes("return !!d && same(d.symbol, symbol) && same(d.mode, mode);"));
  assert.ok(code("src/lib/setupLock.ts").includes('const same = (said: unknown, shown: string) => said == null || said === "" || String(said).toUpperCase() === String(shown).toUpperCase();'));
  // An older read that fails after a newer one was asked for says nothing.
  assert.ok(flow.includes('.catch(function (e) { if (mine !== runSeq.current) return; if (e && e.code === 401) props.onLogout(); else err[1]("Something went wrong — try again."); })'));
  // A change of market asks for its own read even while the last market's is still out — or the screen would be left with neither.
  assert.ok(flow.includes("useEffect(function () { run(true); }, [mode[0], symbol[0]]);"));
  assert.ok(flow.includes("if (mine !== runSeq.current) return;") && flow.includes(".then(function () { if (mine === runSeq.current) loading[1](false); });"));
  assert.ok(flow.includes("${d && d.entry_engine ? html`<${GxEntry}"), "the entry card is drawn only from an answer that has one");
  // (Its handler used to go on to the GENX screen's replay and plays, which do not exist here, and printed an error on every good read.)
  assert.ok(!/replay\[1\]|loadPlays\(/.test(flow));
  // The gold tile never drew the play — only the trend — so it does not sell it. With no read there is
  // no trend to name: it says a setup is there and sends the member to where the play is shown.
  const tile = app.slice(at("  function GoldFlowTile(props) {"), at("  function TradeControls() {"));
  assert.ok(tile.includes("var locked = (d && d.locked) || null;"));
  assert.ok(!tile.includes("SeeThePlay") && !tile.includes("/api/setups/pass"), "nothing is charged from the tile");
  assert.ok(tile.includes("Which way, the entry, the stop and the targets open with credits.") && tile.includes("See the play in FLOW ›") && tile.includes("props.goFlow()"));
  assert.ok(tile.indexOf("${locked ? html`") < tile.indexOf("No side is in control"), "the trend note is the other branch");
  assert.ok(app.includes("<${GoldFlowTile} goFlow=${props.goFlow} />"));
});

/** Every message tapOutcome can print, gathered by asking it. */
function tapMessages(): string[] {
  return [
    tapOutcome(503, { error: "unavailable" }), tapOutcome(409, { error: "busy" }), tapOutcome(200, { error: "charge_failed", charged: false }),
    tapOutcome(200, { error: "charge_failed", charged: null }), tapOutcome(402, null), tapOutcome(401, null),
  ].map((o) => o.message);
}
