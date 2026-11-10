/*
 * OWNER 11-10 ("look at the stats and make flow better"): the two changes that held up in both halves of the
 * last 60 days — quick (5-minute) calls in London hours only, and no stop moved before a gold trade is 80% of
 * the way to its take-profit. See src/lib/flow/goldRules.ts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { quickCallAllowed, quickHoursUtc, goldProtectFromPx, protectAtSinceMs, GOLD_PROTECT_AT } from "../src/lib/flow/goldRules";
import { profitGuardPlan } from "../src/lib/flow/profitGuard";

const at = (hhmm: string) => Date.parse(`2026-11-11T${hhmm}:00Z`);

test("quick calls trade 07:00–12:00 UTC only (1–6 AM Central); intraday and swing at any hour", () => {
  assert.deepEqual(quickHoursUtc(), { from: 7, to: 12 });
  assert.equal(quickCallAllowed("quick", at("06:59")).ok, false);
  assert.equal(quickCallAllowed("quick", at("07:00")).ok, true);
  assert.equal(quickCallAllowed("quick", at("11:59")).ok, true);
  assert.equal(quickCallAllowed("quick", at("12:00")).ok, false);
  assert.equal(quickCallAllowed("quick", at("15:30")).ok, false);
  assert.equal(quickCallAllowed("quick", at("23:10")).ok, false);
  assert.equal(quickCallAllowed(null, at("15:30")).ok, false, "a call with no mode is read as quick, as the placement paths read it");
  assert.equal(quickCallAllowed(undefined, at("09:00")).ok, true);
  for (const h of ["00:30", "06:59", "12:00", "15:30", "23:59"]) {
    assert.equal(quickCallAllowed("intraday", at(h)).ok, true, `intraday ${h}`);
    assert.equal(quickCallAllowed("swing", at(h)).ok, true, `swing ${h}`);
  }
  assert.equal(quickCallAllowed("quick", at("15:30"), "genx3").ok, true, "GENX 3.x runs its own strategy");
  const r = quickCallAllowed("quick", at("15:30"));
  assert.ok(!r.ok && r.reason === "quick_outside_hours (quick calls trade 07:00–12:00 UTC; now 15:30 UTC)", "the skip says why, in the desk log");
});

test("the window is a setting: off takes quick calls at every hour; a window can wrap midnight", () => {
  const saved = process.env.FLOW_QUICK_HOURS_UTC;
  try {
    process.env.FLOW_QUICK_HOURS_UTC = "off";
    assert.equal(quickHoursUtc(), null);
    assert.equal(quickCallAllowed("quick", at("15:30")).ok, true);
    process.env.FLOW_QUICK_HOURS_UTC = "22-3";
    assert.equal(quickCallAllowed("quick", at("23:00")).ok, true);
    assert.equal(quickCallAllowed("quick", at("02:59")).ok, true);
    assert.equal(quickCallAllowed("quick", at("03:00")).ok, false);
    assert.equal(quickCallAllowed("quick", at("12:00")).ok, false);
    process.env.FLOW_QUICK_HOURS_UTC = "nonsense";
    assert.deepEqual(quickHoursUtc(), { from: 7, to: 12 }, "an unreadable setting falls back to London hours, never to every hour");
  } finally {
    if (saved == null) delete process.env.FLOW_QUICK_HOURS_UTC; else process.env.FLOW_QUICK_HOURS_UTC = saved;
  }
});

test("protection starts 80% of the way from the entry to the take-profit in force", () => {
  assert.equal(GOLD_PROTECT_AT, 0.8);
  const after = protectAtSinceMs() + 60_000;
  assert.equal(goldProtectFromPx("buy", 4000, 4010, 3990, after), 4008);
  assert.equal(goldProtectFromPx("sell", 4000, 3990, 4010, after), 3992);
  assert.equal(goldProtectFromPx("buy", 4000, 4006, 3990, after), 4004.8, "a nearer take-profit protects sooner");
  assert.equal(goldProtectFromPx("buy", 4000, null, 3992, after), 4006.4, "no target: the 1:1 target the trade is placed with");
  assert.equal(goldProtectFromPx("buy", 4000, 3995, 3992, after), 4006.4, "a target on the losing side is not a target");
  assert.equal(goldProtectFromPx("buy", 4000, 4010, 3990, protectAtSinceMs() - 60_000), null, "a trade opened before the change keeps its own rule");
  assert.equal(goldProtectFromPx("buy", 4000, 4010, 3990), 4008, "no open time: the current rule");
  assert.equal(goldProtectFromPx("buy", 4000, null, null, after), null, "nothing to measure from");
});

test("the reversal snap does not act before the trade reaches the protection price", () => {
  const base = { side: "buy", entry: 4000, R: 10, pip: 0.1, curStop: 3990, bePx: 4001.7, choch: "bearish" as const };
  assert.equal(profitGuardPlan({ ...base, price: 4005.5, best: 4006.2, protectFromPx: 4008 }), null, "peak 62 pips: short of 80%");
  const plan = profitGuardPlan({ ...base, price: 4007.9, best: 4008.3, protectFromPx: 4008 });
  assert.ok(plan && plan.why === "flip", "peak past 80%: the snap acts");
  assert.ok(profitGuardPlan({ ...base, price: 4005.5, best: 4006.2 }), "no floor (an older trade): as before");
});

test("both placement paths ask before taking a quick call, and the manager holds every stop move to the 80% price", () => {
  const exec = readFileSync("src/lib/flow/autoExec.ts", "utf8");
  const mgr = readFileSync("src/lib/flow/flowManage.ts", "utf8");
  const gold = exec.slice(exec.indexOf("export async function placeGenxGold("), exec.indexOf("export async function placeGenxGold(") + 4000);
  const follow = exec.slice(exec.indexOf("export async function placeGenxFollower("), exec.indexOf("export async function placeGenxFollower(") + 4000);
  assert.match(gold, /quickCallAllowed\(sig\.mode, Date\.now\(\), sig\.origin\)/);
  assert.match(follow, /quickCallAllowed\(sig\.mode, Date\.now\(\), sig\.origin\)/);
  assert.match(mgr, /goldProtectFromPx\(row\.side, entry, targetPx, row\.init_stop, openedMs\(row\)\)/);
  assert.match(mgr, /if \(protectFromPx != null\) beTriggerPx = long \? Math\.max\(beTriggerPx, protectFromPx\) : Math\.min\(beTriggerPx, protectFromPx\);/);
  assert.match(mgr, /protectFromPx,\n\s+\}\);/, "the snap is handed the same price");
});
