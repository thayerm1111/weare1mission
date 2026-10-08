/* eslint-disable @typescript-eslint/no-explicit-any */
/*
 * THE TRADE MANAGER, RUN FOR REAL (src/lib/flow/flowManage.ts, against the stand-in broker in _manager.ts).
 *
 * Part 1 — EXACTLY WHAT THEY HAVE TODAY. Every account starts on the settings AI Pips gave it (owner 10-08).
 * These scenarios were run on the manager deployed before the change (a4af225) and on this one, and both
 * made the same broker requests, wrote the same ledger and logged the same steps. The expectations below
 * are that recording: if one of them moves, an account on today's settings would be traded differently.
 *
 * Part 2 — THE NEW CHOICES. Break-even at 20/30/40/50 or off, follow price tight/normal/loose/off, and
 * partials of 25% or 50% halfway to the target.
 */
import { reset, account, trade, walk, pass, settle, broker, choch, logs, ledger, loadManager, T, fail, schema } from "./_manager";
import test from "node:test";
import assert from "node:assert/strict";
import { classifyOutcome } from "../src/lib/flow/flowManage";

type Mgr = { manageOpenPositions: () => Promise<any> };
const M = loadManager();
const AIPIPS_ON = { manage_trades: true, be_enabled: true, trail_mode: "normal", partial_pct: 0 };
const AIPIPS_OFF = { manage_trades: false, be_enabled: false, trail_mode: "off", partial_pct: 0 };
const set = (o: Record<string, unknown>) => ({ manage_trades: true, be_enabled: true, trail_mode: "normal", partial_pct: 0, gold_be_pips: null, ...o });

/* ── Part 1: today's settings ───────────────────────────────────────────────────────────────────── */
const TODAY: Record<string, (m: Mgr) => Promise<void>> = {
  "gold long, default 30 pips, runs to the near target": async (m) => {
    reset(); account("A1", AIPIPS_ON);
    trade({ account: "A1", symbol: "XAUUSD", side: "buy", entry: 4000, stop: 3990, tp1: 4020, tpAtBroker: 4005, qty: 1 });
    await walk(m, "XAUUSD", [4000.6, 4002.0, 4003.2, 4004.1, 4004.6, 4003.0, 4005.3]);
    await settle(m, "XAUUSD", 4005.3);
  },
  "gold short, own 10 pips, breaks even late (lock) and stops at the lock": async (m) => {
    reset(); account("A2", { ...AIPIPS_ON, gold_be_pips: 10 });
    trade({ account: "A2", symbol: "XAUUSD", side: "sell", entry: 4000, stop: 4010, tp1: 3980, tpAtBroker: 3995, qty: 0.5 });
    await walk(m, "XAUUSD", [3999, 3998.5, 3997.9, 3996.5, 3995.6, 3997, 3998.5]);
    await settle(m, "XAUUSD", 3998.5);
  },
  "gold long, own 40 pips and own 100 pips side by side": async (m) => {
    reset(); account("A3", { ...AIPIPS_ON, gold_be_pips: 40 }); account("A4", { ...AIPIPS_ON, gold_be_pips: 100 });
    trade({ account: "A3", symbol: "XAUUSD", side: "buy", entry: 4000, stop: 3990, tp1: 4020, tpAtBroker: 4005, qty: 1 });
    trade({ account: "A4", symbol: "XAUUSD", side: "buy", entry: 4000, stop: 3990, tp1: 4020, tpAtBroker: 4005, qty: 1 });
    await walk(m, "XAUUSD", [4001, 4003.1, 4004.3, 4004.9, 4003.5, 4006]);
    await settle(m, "XAUUSD", 4006);
  },
  "gold, AI Pips off: nothing is touched, and the stop takes it": async (m) => {
    reset(); account("A5", AIPIPS_OFF);
    trade({ account: "A5", symbol: "XAUUSD", side: "buy", entry: 4000, stop: 3990, tp1: 4020, tpAtBroker: 4005, qty: 1 });
    await walk(m, "XAUUSD", [4002, 4004.5, 4001, 3995, 3989]);
    await settle(m, "XAUUSD", 3989);
  },
  "EUR/USD long: halfway break-even, trail near the target, trailed out": async (m) => {
    reset(); account("F1", AIPIPS_ON);
    trade({ account: "F1", symbol: "EURUSD", side: "buy", entry: 1.084, stop: 1.0814, tp1: 1.0865, qty: 0.5 });
    await walk(m, "EURUSD", [1.0845, 1.0853, 1.08545, 1.086, 1.0858, 1.0855, 1.0851]);
    await settle(m, "EURUSD", 1.0851);
  },
  "GBP/JPY short: break-even, trail, target": async (m) => {
    reset(); account("F2", AIPIPS_ON);
    trade({ account: "F2", symbol: "GBPJPY", side: "sell", entry: 201.4, stop: 201.81, tp1: 200.8, qty: 0.3 });
    await walk(m, "GBPJPY", [201.2, 201.08, 200.95, 200.9, 200.82, 200.79, 200.78]);
    await settle(m, "GBPJPY", 200.78);
  },
  "gold, small stop and own 15 pips: the trail tightens near the plan's halfway mark": async (m) => {
    reset(); account("A6", { ...AIPIPS_ON, gold_be_pips: 15 });
    trade({ account: "A6", symbol: "XAUUSD", side: "buy", entry: 4000, stop: 3996.5, tp1: 4007, tpAtBroker: 4003, qty: 1 });
    await walk(m, "XAUUSD", [4001, 4001.8, 4002.1, 4002.8, 4002.95, 4002.7, 4003.2]);
    await settle(m, "XAUUSD", 4003.2);
  },
  "gold: the reversal snap on a 60-pip winner when the 5-minute structure flips": async (m) => {
    reset(); account("A7", AIPIPS_ON);
    trade({ account: "A7", symbol: "XAUUSD", side: "buy", entry: 4000, stop: 3986, tp1: 4028, tpAtBroker: 4007, qty: 1 });
    await walk(m, "XAUUSD", [4001, 4003.5, 4006.2]);
    choch.now = "bearish";
    await walk(m, "XAUUSD", [4005.5, 4004.0]);
    await settle(m, "XAUUSD", 4004.0);
  },
  "gold, AI Pips on vs off, the same snap": async (m) => {
    reset(); account("A8", AIPIPS_ON); account("A9", AIPIPS_OFF);
    for (const a of ["A8", "A9"]) trade({ account: a, symbol: "XAUUSD", side: "sell", entry: 4000, stop: 4014, tp1: 3972, tpAtBroker: 3993, qty: 1 });
    await walk(m, "XAUUSD", [3999, 3996.5, 3993.8]);
    choch.now = "bullish";
    await walk(m, "XAUUSD", [3994.5, 3996.2]);
    await settle(m, "XAUUSD", 3996.2);
  },
  "a broker that shows stops on the row: dropped stop and target put back, a hand-moved stop adopted": async (m) => {
    reset(); broker.pricesOnRow = true; account("B1", AIPIPS_ON); account("B2", AIPIPS_ON); account("B3", AIPIPS_OFF);
    const a = trade({ account: "B1", symbol: "XAUUSD", side: "buy", entry: 4000, stop: 3990, tp1: 4020, tpAtBroker: null, qty: 1 });
    broker.positions.get(a)!.sl = null;
    const b = trade({ account: "B2", symbol: "XAUUSD", side: "buy", entry: 4000, stop: 3990, tp1: 4020, tpAtBroker: 4005, qty: 1 });
    broker.positions.get(b)!.sl = 4000.4;
    const c = trade({ account: "B3", symbol: "XAUUSD", side: "buy", entry: 4000, stop: 3990, tp1: 4020, tpAtBroker: null, qty: 1 });
    broker.positions.get(c)!.sl = null;
    await walk(m, "XAUUSD", [4000.5, 4001.5, 4003.4, 4004.2, 4002.5, 4001.0]);
    await settle(m, "XAUUSD", 4001.0);
  },
  "one account on two rows: off on either wins; the last row's pips": async (m) => {
    reset();
    account("D1", AIPIPS_OFF); account("D1", { ...AIPIPS_ON, gold_be_pips: 15 });
    account("D2", { ...AIPIPS_ON, gold_be_pips: null }); account("D2", { ...AIPIPS_ON, gold_be_pips: 40 });
    trade({ account: "D1", symbol: "XAUUSD", side: "buy", entry: 4000, stop: 3990, tp1: 4020, tpAtBroker: 4005, qty: 1 });
    trade({ account: "D2", symbol: "XAUUSD", side: "buy", entry: 4000, stop: 3990, tp1: 4020, tpAtBroker: 4005, qty: 1 });
    await walk(m, "XAUUSD", [4002, 4003.5, 4004.3, 4004.8, 4002.0]);
    await settle(m, "XAUUSD", 4002.0);
  },
  "a member closes part of the trade by hand, then it stops out at the lock": async (m) => {
    reset(); account("P1", AIPIPS_ON);
    const id = trade({ account: "P1", symbol: "XAUUSD", side: "buy", entry: 4000, stop: 3990, tp1: 4020, tpAtBroker: 4005, qty: 1 });
    await walk(m, "XAUUSD", [4001, 4003.2]);
    broker.positions.get(id)!.qty = 0.6;
    broker.pricesOnRow = false;
    await walk(m, "XAUUSD", [4003.5, 4002.0, 4001.5]);
    await settle(m, "XAUUSD", 4001.5);
  },
  "the broker refuses the first break-even, then takes it; a 'nothing to change' counts as done": async (m) => {
    reset(); account("R1", AIPIPS_ON); account("R2", AIPIPS_ON);
    const a = trade({ account: "R1", symbol: "XAUUSD", side: "buy", entry: 4000, stop: 3990, tp1: 4020, tpAtBroker: 4005, qty: 1 });
    const b = trade({ account: "R2", symbol: "XAUUSD", side: "buy", entry: 4000, stop: 3990, tp1: 4020, tpAtBroker: 4005, qty: 1 });
    let once = true;
    broker.refuse.modify = (id) => (id === a && once ? ((once = false), "Market closed") : id === b ? "Nothing to change" : null);
    await walk(m, "XAUUSD", [4003.3, 4003.4, 4003.6, 4004.0]);
  },
  "a fill away from the signal's entry is re-anchored to the real fill": async (m) => {
    reset(); account("S1", AIPIPS_ON);
    trade({ account: "S1", symbol: "XAUUSD", side: "buy", entry: 4000, fill: 4000.8, stop: 3990, tp1: 4020, tpAtBroker: 4005, qty: 1 });
    await walk(m, "XAUUSD", [4002, 4003.4, 4003.9, 4004.2, 4005.2]);
    await settle(m, "XAUUSD", 4005.2);
  },
};

/** Recorded from the deployed manager (a4af225); the new one matched every request, ledger row and log line. */
const RECORDED: Record<string, { calls: string[]; rows: unknown[][]; log: string[] }> = {
  "gold long, default 30 pips, runs to the near target": {"calls": ["modify 9001 sl=4001.7"], "rows": [["9001", "closed", true, 4001.7, "target", 200, false, 1]], "log": ["break_even:broker_confirmed", "closed:target/target"]},
  "gold short, own 10 pips, breaks even late (lock) and stops at the lock": {"calls": ["modify 9001 sl=3998.3"], "rows": [["9001", "closed", true, 3998.3, "breakeven", 17, false, 0.5]], "log": ["break_even:broker_confirmed", "closed:breakeven/stop"]},
  "gold long, own 40 pips and own 100 pips side by side": {"calls": ["modify 9001 sl=4001.7"], "rows": [["9001", "closed", true, 4001.7, "target", 200, false, 1], ["9002", "closed", false, 3990, "trail", 50, false, 1]], "log": ["break_even:broker_confirmed", "closed:target/target", "closed:trail/target"]},
  "gold, AI Pips off: nothing is touched, and the stop takes it": {"calls": [], "rows": [["9001", "closed", false, 3990, "stop", -100, false, 1]], "log": ["closed:stop/stop"]},
  "EUR/USD long: halfway break-even, trail near the target, trailed out": {"calls": ["modify 9001 sl=1.0848", "modify 9001 sl=1.0852"], "rows": [["9001", "closed", true, 1.0852, "trail", 12, false, 0.5]], "log": ["break_even:broker_confirmed", "trail:broker_confirmed", "closed:trail/stop"]},
  "GBP/JPY short: break-even, trail, target": {"calls": ["modify 9001 sl=201.32", "modify 9001 sl=201.197", "modify 9001 sl=201.067", "modify 9001 sl=201.017", "modify 9001 sl=200.938", "modify 9001 sl=200.907"], "rows": [["9001", "closed", true, 200.907, "target", 60, false, 0.3]], "log": ["break_even:broker_confirmed", "trail:broker_confirmed", "trail:broker_confirmed", "trail:broker_confirmed", "trail:broker_confirmed", "trail:broker_confirmed", "closed:target/target"]},
  "gold, small stop and own 15 pips: the trail tightens near the plan's halfway mark": {"calls": ["modify 9001 sl=4001.7", "modify 9001 sl=4001.93"], "rows": [["9001", "closed", true, 4001.93, "target", 70, false, 1]], "log": ["break_even:broker_confirmed", "trail:broker_confirmed", "closed:target/target"]},
  "gold: the reversal snap on a 60-pip winner when the 5-minute structure flips": {"calls": ["modify 9001 sl=4001.7", "modify 9001 sl=4004.15"], "rows": [["9001", "closed", true, 4004.15, "trail", 42, false, 1]], "log": ["break_even:broker_confirmed", "profit_guard:choch_bearish", "closed:trail/stop"]},
  "gold, AI Pips on vs off, the same snap": {"calls": ["modify 9001 sl=3998.3", "modify 9001 sl=3995.85"], "rows": [["9001", "closed", true, 3995.85, "trail", 42, false, 1], ["9002", "open", false, 4014, null, null, false, 1]], "log": ["break_even:broker_confirmed", "profit_guard:choch_bullish", "closed:trail/stop"]},
  "a broker that shows stops on the row: dropped stop and target put back, a hand-moved stop adopted": {"calls": ["modify 9001 sl=3990 tp=4020", "modify 9001 sl=3990 tp=4005", "modify 9001 sl=4001.7"], "rows": [["9001", "closed", true, 4001.7, "breakeven", 17, false, 1], ["9002", "closed", false, 3990, "trail", 4, false, 1], ["9003", "open", false, 3990, null, null, false, 1]], "log": ["sl_reattached:broker_dropped_sl", "tp_reattached:broker_dropped_tp", "break_even:broker_confirmed", "closed:trail/stop", "closed:breakeven/stop"]},
  "one account on two rows: off on either wins; the last row's pips": {"calls": ["modify 9002 sl=4001.7"], "rows": [["9001", "open", false, 3990, null, null, false, 1], ["9002", "open", true, 4001.7, null, null, false, 1]], "log": ["break_even:broker_confirmed"]},
  "a member closes part of the trade by hand, then it stops out at the lock": {"calls": ["modify 9001 sl=4001.7"], "rows": [["9001", "closed", true, 4001.7, "breakeven", 38, true, 0.6]], "log": ["break_even:broker_confirmed", "partial_reconciled:broker_qty_reduced", "closed:breakeven/stop"]},
  "the broker refuses the first break-even, then takes it; a 'nothing to change' counts as done": {"calls": ["modify 9001 sl=4001.7", "modify 9002 sl=4001.7", "modify 9001 sl=4001.7"], "rows": [["9001", "open", true, 4001.7, null, null, false, 1], ["9002", "open", true, 4001.7, null, null, false, 1]], "log": ["break_even:already_at_be", "be_unconfirmed:readback_mismatch", "break_even:broker_confirmed"]},
  "a fill away from the signal's entry is re-anchored to the real fill": {"calls": ["modify 9001 sl=4002.5"], "rows": [["9001", "closed", true, 4002.5, "target", 192, false, 1]], "log": ["fill_reconciled:reanchor_to_broker_fill", "break_even:broker_confirmed", "closed:target/target"]},
};

for (const [name, run] of Object.entries(TODAY)) {
  test(`today's settings — ${name}`, async () => {
    await run(M);
    const want = RECORDED[name];
    assert.deepEqual(broker.calls, want.calls, "broker requests");
    assert.deepEqual(T("flow_managed_positions").map((x) => [x.position_id, x.status, x.be_done, x.cur_stop, x.outcome ?? null, x.result_pips ?? null, x.partial_done, x.qty]), want.rows, "ledger");
    assert.deepEqual(logs.map((l) => `${l.phase}:${l.reason}`), want.log, "log");
  });
}

/* ── Part 2: the new choices ────────────────────────────────────────────────────────────────────── */

const modifiesOf = (id: string) => broker.calls.filter((c) => c.startsWith(`modify ${id} `));
const closesOf = (id: string) => broker.calls.filter((c) => c.startsWith(`close ${id}`));

test("break-even at 20, 30, 40 or 50 pips moves a gold stop when the trade is that far up — and off never does", async () => {
  reset();
  const ids: Record<string, string> = {};
  for (const [acct, be] of [["E20", 20], ["E30", 30], ["E40", 40], ["E50", 50], ["EOFF", null]] as const) {
    account(acct, be == null ? set({ be_enabled: false, trail_mode: "off" }) : set({ gold_be_pips: be, trail_mode: "off" }));
    // 140-pip stop: the near take-profit sits 70 pips away, so even 50 comes first.
    ids[acct] = trade({ account: acct, symbol: "XAUUSD", side: "buy", entry: 4000, stop: 3986, tp1: 4028, tpAtBroker: 4007, qty: 1 });
  }
  const at: Record<string, number> = {};
  const path = [4001.0, 4002.2, 4003.2, 4004.2, 4005.2];
  for (let i = 0; i < path.length; i++) {
    await pass(M, "XAUUSD", path[i]);
    for (const a of Object.keys(ids)) if (at[a] == null && modifiesOf(ids[a]).length) at[a] = i;
  }
  // bid = mid − 0.15: pass 1 is 20.5 pips up, pass 2 is 30.5, pass 3 is 40.5, pass 4 is 50.5
  assert.deepEqual(at, { E20: 1, E30: 2, E40: 3, E50: 4 });
  for (const a of ["E20", "E30", "E40", "E50"]) assert.deepEqual(modifiesOf(ids[a]), [`modify ${ids[a]} sl=4001.7`], `${a}: one move, to the +17-pip lock`);
  assert.deepEqual(modifiesOf(ids.EOFF), [], "break-even off: the stop is never moved");
  assert.equal(ledger(ids.EOFF).be_done, false);
});

test("follow price on gold: Tight rides close behind the best price; Normal, Loose and Off hold the break-even lock to the target", async () => {
  reset();
  const ids: Record<string, string> = {};
  for (const mode of ["tight", "normal", "loose", "off"]) {
    account(mode, set({ trail_mode: mode }));
    // a typical gold trade: 90-pip stop, near take-profit 45 pips, GENX plan 1.9R
    ids[mode] = trade({ account: mode, symbol: "XAUUSD", side: "buy", entry: 4000, stop: 3991, tp1: 4017.1, tpAtBroker: 4004.5, qty: 1 });
  }
  await walk(M, "XAUUSD", [4001, 4003.2, 4003.8, 4004.3, 4003.0, 4002.8, 4004.7]);
  await settle(M, "XAUUSD", 4004.7);
  assert.deepEqual(modifiesOf(ids.tight), [`modify ${ids.tight} sl=4001.7`, `modify ${ids.tight} sl=4002.3`, `modify ${ids.tight} sl=4002.8`]);
  for (const mode of ["normal", "loose", "off"]) assert.deepEqual(modifiesOf(ids[mode]), [`modify ${ids[mode]} sl=4001.7`], `${mode}: break-even only`);
  // Tight was stopped out on the pullback at +28 pips; the other three rode on to the take-profit.
  assert.equal(ledger(ids.tight).outcome, "trail");
  assert.equal(ledger(ids.tight).exit_price, 4002.8);
  assert.equal(ledger(ids.tight).result_pips, 28);
  for (const mode of ["normal", "loose", "off"]) assert.equal(T("flow_managed_positions").find((r) => r.position_id === ids[mode])!.status, "closed");
});

test("follow price on EUR/USD: Tight, Normal and Loose trail at 0.15R, 0.25R and 0.375R near the target", async () => {
  reset();
  const ids: Record<string, string> = {};
  for (const mode of ["tight", "normal", "loose", "off"]) {
    account(mode, set({ trail_mode: mode }));
    ids[mode] = trade({ account: mode, symbol: "EURUSD", side: "buy", entry: 1.084, stop: 1.0814, tp1: 1.0865, qty: 0.5 });
  }
  await walk(M, "EURUSD", [1.0845, 1.08545, 1.08635]);
  assert.deepEqual(modifiesOf(ids.off), [`modify ${ids.off} sl=1.0848`], "Off: break-even, then the stop stays put");
  const stop = (m: string) => ledger(ids[m]).cur_stop as number;
  const R = Math.abs(1.084 - 1.0814), best = 1.0862;          // bid at the high
  const at = (g: number) => +(best - g * R).toFixed(5);
  assert.equal(stop("normal"), at(0.25), "Normal: 0.25R behind the best price near the target, exactly as before");
  assert.equal(stop("tight"), at(0.15));
  assert.equal(stop("loose"), at(0.375));
  assert.ok(stop("tight") > stop("normal") && stop("normal") > stop("loose") && stop("loose") > 1.0848, "all three above the break-even lock, in order");
  // each is taken out by its own pullback
  await walk(M, "EURUSD", [1.0859, 1.0857, 1.0852]);
  await settle(M, "EURUSD", 1.0852);
  assert.deepEqual(["tight", "normal", "loose"].map((m) => ledger(ids[m]).exit_price), [at(0.15), at(0.25), at(0.375)]);
  assert.deepEqual(["tight", "normal", "loose"].map((m) => ledger(ids[m]).outcome), ["trail", "trail", "trail"]);
});

test("a trail point that improves the stop by less than 5% of the risk is not sent (no broker churn), in every mode", async () => {
  reset();
  account("L", set({ trail_mode: "loose" }));
  const id = trade({ account: "L", symbol: "EURUSD", side: "buy", entry: 1.084, stop: 1.0814, tp1: 1.0865, qty: 0.5 });
  // best bid 1.08585: Loose's point is 1.08488, 0.8 pips over the 1.0848 lock — under the 1.3-pip step
  await walk(M, "EURUSD", [1.0845, 1.08545, 1.086]);
  assert.deepEqual(modifiesOf(id), [`modify ${id} sl=1.0848`]);
});

test("the gold reversal snap is part of follow price: off means it does not happen", async () => {
  reset();
  account("SNAP", set({ trail_mode: "normal" }));
  account("NOSNAP", set({ trail_mode: "off" }));
  const a = trade({ account: "SNAP", symbol: "XAUUSD", side: "buy", entry: 4000, stop: 3986, tp1: 4028, tpAtBroker: 4007, qty: 1 });
  const b = trade({ account: "NOSNAP", symbol: "XAUUSD", side: "buy", entry: 4000, stop: 3986, tp1: 4028, tpAtBroker: 4007, qty: 1 });
  await walk(M, "XAUUSD", [4001, 4003.5, 4006.2]);
  choch.now = "bearish";
  await pass(M, "XAUUSD", 4005.5);
  assert.deepEqual(modifiesOf(a), [`modify ${a} sl=4001.7`, `modify ${a} sl=4004.15`]);
  assert.deepEqual(modifiesOf(b), [`modify ${b} sl=4001.7`]);
  assert.ok(logs.some((l) => l.phase === "profit_guard" && l.position_id === a));
  assert.ok(!logs.some((l) => l.phase === "profit_guard" && l.position_id === b));
});

test("follow price needs break-even: with break-even off a stored 'Tight' does nothing — no trail, no snap", async () => {
  reset();
  account("X", set({ be_enabled: false, trail_mode: "tight" }));
  const id = trade({ account: "X", symbol: "XAUUSD", side: "buy", entry: 4000, stop: 3986, tp1: 4028, tpAtBroker: 4007, qty: 1 });
  await walk(M, "XAUUSD", [4002, 4004, 4006.2]);
  choch.now = "bearish";
  await walk(M, "XAUUSD", [4005.5, 4005.0]);
  assert.deepEqual(broker.calls, []);
  assert.equal(ledger(id).be_done, false);
});

test("everything off leaves the trade alone — not even a dropped stop is put back; a partial alone still keeps the stop guarded", async () => {
  reset(); broker.pricesOnRow = true;
  account("NONE", set({ be_enabled: false, trail_mode: "normal", partial_pct: 0, manage_trades: false }));
  account("PART", set({ be_enabled: false, trail_mode: "off", partial_pct: 25 }));
  const a = trade({ account: "NONE", symbol: "XAUUSD", side: "buy", entry: 4000, stop: 3990, tp1: 4020, tpAtBroker: 4005, qty: 1 });
  const b = trade({ account: "PART", symbol: "XAUUSD", side: "buy", entry: 4000, stop: 3990, tp1: 4020, tpAtBroker: 4005, qty: 1 });
  broker.positions.get(a)!.sl = null; broker.positions.get(b)!.sl = null;
  await pass(M, "XAUUSD", 4000.5);
  assert.deepEqual(modifiesOf(a), []);
  assert.deepEqual(modifiesOf(b), [`modify ${b} sl=3990 tp=4005`]);
});

test("a 25% partial banks a quarter halfway to the gold take-profit — on the live price, once", async () => {
  reset();
  account("P25", set({ partial_pct: 25 }));
  const id = trade({ account: "P25", symbol: "XAUUSD", side: "buy", entry: 4000, stop: 3990, tp1: 4020, tpAtBroker: 4005, qty: 1 });
  // near take-profit 4005 → halfway 4002.5
  await walk(M, "XAUUSD", [4001.5, 4002.6]);
  assert.deepEqual(closesOf(id), [], "bid 4002.45: not there yet");
  await pass(M, "XAUUSD", 4002.8);
  assert.deepEqual(closesOf(id), [`close ${id} qty=0.25`]);
  const r = ledger(id);
  assert.equal(r.partial_done, true);
  assert.equal(r.qty, 0.75);
  assert.equal(r.partial_px, 4002.65);
  assert.equal(r.partial_frac, 0.25);
  await walk(M, "XAUUSD", [4003.4, 4002.9, 4003.9, 4004.1]);
  assert.deepEqual(closesOf(id), [`close ${id} qty=0.25`], "never a second time");
  assert.deepEqual(modifiesOf(id), [`modify ${id} sl=4001.7`], "break-even still at its own 30 pips");
  assert.ok(logs.some((l) => l.phase === "partial" && l.reason === "broker_confirmed" && l.qty === 0.25 && l.price === 4002.65));
});

test("a 50% partial banks half; the broker's own take-profit, when the row shows it, is the target", async () => {
  reset(); broker.pricesOnRow = true;
  account("P50", set({ partial_pct: 50 }));
  // the member moved their take-profit to 4008: halfway is now 4004
  const id = trade({ account: "P50", symbol: "XAUUSD", side: "buy", entry: 4000, stop: 3990, tp1: 4020, tpAtBroker: 4008, qty: 0.8 });
  await walk(M, "XAUUSD", [4002.8, 4003.9]);
  assert.deepEqual(closesOf(id), [], "4002.65 and 4003.75 are short of 4004");
  await pass(M, "XAUUSD", 4004.3);
  assert.deepEqual(closesOf(id), [`close ${id} qty=0.4`]);
  assert.equal(ledger(id).qty, 0.4);
  assert.equal(ledger(id).partial_frac, 0.5);
});

test("break-even off with a partial on: the partial banks, and the stop never moves however far the trade runs", async () => {
  reset();
  account("PO", set({ be_enabled: false, trail_mode: "normal", partial_pct: 25 }));
  const id = trade({ account: "PO", symbol: "XAUUSD", side: "buy", entry: 4000, stop: 3986, tp1: 4028, tpAtBroker: 4007, qty: 1 });
  await walk(M, "XAUUSD", [4003.6, 4004.5, 4005.5, 4006.6]);   // halfway is 4003.5; 30, 40, 50, 60 pips up
  assert.deepEqual(broker.calls, [`close ${id} qty=0.25`]);
  assert.equal(ledger(id).be_done, false);
});

test("a wick that touched halfway and came back banks nothing", async () => {
  reset();
  account("W", set({ partial_pct: 50, be_enabled: false, trail_mode: "off" }));
  const id = trade({ account: "W", symbol: "XAUUSD", side: "buy", entry: 4000, stop: 3990, tp1: 4020, tpAtBroker: 4005, qty: 1 });
  ledger(id).best_price = 4003.4;          // the trade's recorded high is past halfway (4002.5)…
  await walk(M, "XAUUSD", [4001.0, 4001.4]); // …but the market is back at +9 pips
  assert.deepEqual(broker.calls, []);
});

test("a partial the broker refuses is not sent again, the broker is asked about it once a minute, and the stop still follows", async () => {
  reset();
  account("RF", set({ partial_pct: 25, trail_mode: "tight" }));
  const id = trade({ account: "RF", symbol: "XAUUSD", side: "buy", entry: 4000, stop: 3991, tp1: 4017.1, tpAtBroker: 4004.5, qty: 1 });
  broker.refuse.close = () => "Market is closed for this instrument";
  await pass(M, "XAUUSD", 4002.6);
  assert.deepEqual(closesOf(id), [`close ${id} qty=0.25`]);
  const readsAfterRefusal = broker.reads;
  await walk(M, "XAUUSD", [4003.2, 4003.8, 4004.3]);
  assert.deepEqual(closesOf(id), [`close ${id} qty=0.25`], "one attempt, ever");
  assert.equal(broker.reads - readsAfterRefusal, 3, "one positions read per pass — no extra read-back of the refused close");
  assert.deepEqual(modifiesOf(id), [`modify ${id} sl=4001.7`, `modify ${id} sl=4002.3`, `modify ${id} sl=4002.8`], "break-even and Tight carry on");
  assert.equal(ledger(id).partial_done, false);
  assert.equal(ledger(id).partial_px, null, "a close the broker refused is not on record as banked");
  assert.equal(ledger(id).partial_frac, null);
});

test("a partial the broker shows a pass late is picked up from the account, graded on what it banked", async () => {
  reset(); broker.qtyLag = true;
  account("LAG", set({ partial_pct: 50, be_enabled: false, trail_mode: "off" }));
  const id = trade({ account: "LAG", symbol: "XAUUSD", side: "buy", entry: 4000, stop: 3990, tp1: 4020, tpAtBroker: 4005, qty: 1 });
  await pass(M, "XAUUSD", 4002.8);
  assert.deepEqual(closesOf(id), [`close ${id} qty=0.5`]);
  assert.equal(ledger(id).partial_done, false, "the read-back still showed 1.0");
  assert.equal(ledger(id).partial_px, 4002.65, "but where it was sent is on record");
  await pass(M, "XAUUSD", 4002.0);
  assert.equal(ledger(id).partial_done, true);
  assert.equal(ledger(id).qty, 0.5);
  assert.deepEqual(closesOf(id), [`close ${id} qty=0.5`]);
  // then the rest stops out: half banked at +27 pips (4002.65), half lost 100 → −36.5 → −36, a loss
  await walk(M, "XAUUSD", [3995, 3989.5]);
  await settle(M, "XAUUSD", 3989.5);
  const r = ledger(id);
  assert.equal(r.outcome, "stop");
  assert.equal(r.result_pips, -36);
  assert.equal(r.partial_taken, true);
});

test("partials on a currency pair bank halfway to the plan's target, alongside its halfway break-even", async () => {
  reset();
  account("FX", set({ partial_pct: 25 }));
  const id = trade({ account: "FX", symbol: "EURUSD", side: "buy", entry: 1.084, stop: 1.0814, tp1: 1.0865, qty: 0.5 });
  await walk(M, "EURUSD", [1.0853, 1.08545]);
  assert.deepEqual(broker.calls, [`modify ${id} sl=1.0848`, `close ${id} qty=0.12`]);
  assert.equal(ledger(id).partial_frac, 0.24, "0.12 of 0.5 — the broker's lot step rounds a quarter down");
});

test("a position too small to split is never part-closed", async () => {
  reset();
  account("MIN", set({ partial_pct: 25 }));
  const id = trade({ account: "MIN", symbol: "XAUUSD", side: "buy", entry: 4000, stop: 3990, tp1: 4020, tpAtBroker: 4005, qty: 0.01 });
  await walk(M, "XAUUSD", [4002.8, 4003.4]);
  assert.deepEqual(closesOf(id), []);
  assert.deepEqual(modifiesOf(id), [`modify ${id} sl=4001.7`]);
});

/* ── grading a trade that banked part of itself ─────────────────────────────────────────────────── */

test("grading: a recorded partial counts in every way a trade can end", () => {
  const base = { symbol: "XAUUSD", side: "buy" as const, entry: 4000, init_stop: 3990, tp1: 4020, best_price: 4004, cur_stop: 4001.7, partial_done: true, partial_px: 4002.5, partial_frac: 0.5 };
  // stopped at the original stop, break-even never set: 0.5×25 + 0.5×(−100) = −37.5 → −37 (rounded half-up → −37)
  assert.deepEqual(classifyOutcome({ ...base, be_done: false }, 3990, "stop"), { outcome: "stop", result_pips: -37, exit_price: 3990, partial_taken: true });
  // never protected, but the rest closed in profit too
  assert.deepEqual(classifyOutcome({ ...base, be_done: false }, 4005, "unknown"), { outcome: "trail", result_pips: 38, exit_price: 4005, partial_taken: true });
  // break-even lock
  assert.deepEqual(classifyOutcome({ ...base, be_done: true }, 4001.7, "stop"), { outcome: "breakeven", result_pips: 21, exit_price: 4001.7, partial_taken: true });
  // closed by hand
  assert.deepEqual(classifyOutcome({ ...base, be_done: true }, 4003, "manual"), { outcome: "manual", result_pips: 28, exit_price: 4003, partial_taken: true });
  // a reduction the manager did not record (no price/share) is graded the old way: 25% at the plan's halfway
  const old = { ...base, partial_px: null, partial_frac: null };
  assert.deepEqual(classifyOutcome({ ...old, be_done: true }, 4001.7, "stop"), { outcome: "breakeven", result_pips: Math.round(0.25 * 100 + 0.75 * 17), exit_price: 4001.7, partial_taken: true });
  assert.deepEqual(classifyOutcome({ ...old, be_done: false }, 3990, "stop"), { outcome: "stop", result_pips: -100, exit_price: 3990, partial_taken: false });
  assert.deepEqual(classifyOutcome({ ...old, be_done: true }, 4003, "manual"), { outcome: "manual", result_pips: 30, exit_price: 4003, partial_taken: true });
});

/* ── when the settings cannot be read ───────────────────────────────────────────────────────────── */

test("a settings read that fails never puts an account back on AI Pips: with nothing read recently, the trade is left alone", async () => {
  reset();
  account("RD1", set({ be_enabled: false, trail_mode: "off", partial_pct: 25 }));   // break-even off, partials on
  const id = trade({ account: "RD1", symbol: "XAUUSD", side: "buy", entry: 4000, stop: 3986, tp1: 4028, tpAtBroker: 4007, qty: 1 });
  // the full read times out — while a smaller one (the columns of the AI Pips days) would have answered
  schema.flaky = true;
  await walk(M, "XAUUSD", [4003.6, 4004.1]);                  // past halfway (4003.5) and 41 pips up
  assert.deepEqual(broker.calls, [], "no stop moved, nothing closed");
  assert.equal(ledger(id).last_error, "settings_unread");
  assert.equal(ledger(id).be_done, false);
  // the whole table unreadable: the same
  schema.flaky = false; fail.tables.add("flow_broker_accounts");
  await pass(M, "XAUUSD", 4004.1);
  assert.deepEqual(broker.calls, []);
  // the read comes back: the member's own settings run — the partial, and still no break-even
  fail.tables.clear();
  await pass(M, "XAUUSD", 4004.2);
  assert.deepEqual(broker.calls, [`close ${id} qty=0.25`]);
  assert.equal(ledger(id).last_error, null);
});

test("…and with the settings read in the last ten minutes, those stand in for the failed read", async () => {
  reset();
  account("RD2", set({ be_enabled: false, trail_mode: "off", partial_pct: 50 }));
  account("RD3", set({ gold_be_pips: 20, trail_mode: "tight" }));
  const a = trade({ account: "RD2", symbol: "XAUUSD", side: "buy", entry: 4000, stop: 3986, tp1: 4028, tpAtBroker: 4007, qty: 1 });
  const b = trade({ account: "RD3", symbol: "XAUUSD", side: "buy", entry: 4000, stop: 3986, tp1: 4028, tpAtBroker: 4007, qty: 1 });
  await pass(M, "XAUUSD", 4001.0);                            // read once, fine
  schema.flaky = true;
  await walk(M, "XAUUSD", [4002.3, 4003.7]);
  assert.deepEqual(modifiesOf(a), [], "RD2: break-even stays off through the failed reads");
  assert.deepEqual(closesOf(a), [`close ${a} qty=0.5`], "RD2: its own 50% partial");
  assert.deepEqual(modifiesOf(b), [`modify ${b} sl=4001.7`], "RD3: its own 20-pip break-even");
});

test("a database without the new columns (the code ahead of its migration) runs every account exactly as AI Pips did", async () => {
  reset(); schema.noNewColumns = true;
  // a stale be_enabled=false under AI Pips on — the old manager never read it, and neither does this read
  account("OLD1", { manage_trades: true, be_enabled: false, gold_be_pips: 40, trail_mode: undefined, partial_pct: undefined });
  account("OLD2", { manage_trades: false, be_enabled: null, gold_be_pips: null, trail_mode: undefined, partial_pct: undefined });
  const a = trade({ account: "OLD1", symbol: "XAUUSD", side: "buy", entry: 4000, stop: 3986, tp1: 4028, tpAtBroker: 4007, qty: 1 });
  const b = trade({ account: "OLD2", symbol: "XAUUSD", side: "buy", entry: 4000, stop: 3986, tp1: 4028, tpAtBroker: 4007, qty: 1 });
  await walk(M, "XAUUSD", [4002, 4004.2, 4005.0]);
  assert.deepEqual(modifiesOf(a), [`modify ${a} sl=4001.7`], "AI Pips on: break-even at its own 40 pips");
  assert.deepEqual(modifiesOf(b), [], "AI Pips off: untouched");
  assert.equal(ledger(a).last_error, null);
});

test("the settings as last read keep standing in for as long as the reads keep failing — not just ten minutes", async () => {
  reset();
  account("LG", set({ gold_be_pips: 20, trail_mode: "off" }));
  const id = trade({ account: "LG", symbol: "XAUUSD", side: "buy", entry: 4000, stop: 3986, tp1: 4028, tpAtBroker: 4007, qty: 1 });
  await pass(M, "XAUUSD", 4000.5);                        // read once, fine
  schema.flaky = true;
  await pass(M, "XAUUSD", 4000.8, 3, 11 * 60_000);         // eleven minutes of failed reads later…
  await pass(M, "XAUUSD", 4002.3);                         // …the trade is 21.5 pips up: its own 20-pip break-even
  assert.deepEqual(modifiesOf(id), [`modify ${id} sl=4001.7`]);
});

test("a part-close that times out is an unknown outcome: when it did go through, it is recorded and graded on its own price", async () => {
  reset();
  account("UC1", set({ partial_pct: 50, be_enabled: false, trail_mode: "off" }));
  account("UC2", set({ partial_pct: 50, be_enabled: false, trail_mode: "off" }));
  const a = trade({ account: "UC1", symbol: "XAUUSD", side: "buy", entry: 4000, stop: 3990, tp1: 4020, tpAtBroker: 4005, qty: 1 });
  broker.closeUncertain = "done";
  await pass(M, "XAUUSD", 4002.8);
  assert.equal(ledger(a).partial_done, true, "the broker shows half gone: confirmed");
  assert.equal(ledger(a).partial_px, 4002.65);
  assert.equal(ledger(a).partial_frac, 0.5);
  // one that did not go through: never re-sent, and its price is on record but not counted — no partial was banked
  reset();
  account("UC2", set({ partial_pct: 50, be_enabled: false, trail_mode: "off" }));
  const b = trade({ account: "UC2", symbol: "XAUUSD", side: "buy", entry: 4000, stop: 3990, tp1: 4020, tpAtBroker: 4005, qty: 1 });
  broker.closeUncertain = "not_done";
  await walk(M, "XAUUSD", [4002.8, 4003.0]);
  assert.deepEqual(closesOf(b), [`close ${b} qty=0.5`]);
  assert.equal(ledger(b).partial_done, false);
  assert.equal(ledger(b).partial_px, 4002.65, "kept in case the broker shows it carried out later — counted only if it does");
  await walk(M, "XAUUSD", [3995, 3989.5]);
  await settle(M, "XAUUSD", 3989.5);
  assert.equal(ledger(b).outcome, "stop");
  assert.equal(ledger(b).result_pips, -100, "graded as the whole trade it was");
});
