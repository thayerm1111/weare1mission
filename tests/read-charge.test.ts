import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chargedRead, chargedGhostRead, engineReadHasPlan } from "../src/lib/readCharge";
import { hasPlay } from "../src/lib/setupLock";
import { buildGenx, MODES } from "../src/lib/genxCompute";
import { genfxOf } from "../src/lib/genfx/compute";
import { PAIRS } from "../src/lib/genfx/pairs";

/*
 * A read that shows a plan is a read that is paid for (owner 10-06). Live setups take credits to view
 * everywhere on the site; the one way left to see a play for nothing was a GENX or GEN FX read on
 * which the engine said NO TRADE, which was free and still printed a range plan with an entry, a
 * stop and targets. These hold the rule: charged when the engine found a setup or the read carries a
 * plan; free only when there is nothing in it to trade from.
 */
const code = (p: string): string => readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const GOLD = { mode: "intraday" as const, price: 4112, session: "London", dataStatus: "live", hold: MODES.intraday.hold, triggerTf: MODES.intraday.triggerTf, contextTf: MODES.intraday.contextTf, pip: 0.1, dec: 2, marketStory: [], volatility: "normal", atr: 6, m15: [] };
const FX = { mode: "intraday" as const, price: 1.1205, session: "London", dataStatus: "live", hold: MODES.intraday.hold, triggerTf: MODES.intraday.triggerTf, contextTf: MODES.intraday.contextTf, marketStory: [], volatility: "normal", atr: 0.0008 };
const gold = (read: Record<string, unknown>) => buildGenx(read as never, GOLD as never);
const fx = (read: Record<string, unknown>) => genfxOf(PAIRS.EURUSD, read as never, FX as never);

test("a read on which the engine found a setup is charged, as it always was", () => {
  for (const state of ["TRADE_READY", "DEVELOPING_SETUP", "WATCHLIST"]) {
    assert.equal(chargedRead(state, gold({ state, direction: "buy", levels: { support: 4100, resistance: 4160 }, scores: { overall: 60 } })), true, state);
    // …whether or not levels came with it.
    assert.equal(chargedRead(state, {}), true, `${state}, no plan`);
    assert.equal(chargedRead(state, null), true);
  }
});

test("a NO TRADE read that still hands over a plan is charged: the plan is one the desk trades", () => {
  const g = gold({ state: "NO_TRADE", levels: { support: 4100, resistance: 4160 }, scores: { overall: 40 } });
  // What the member is shown on such a read: a side to wait for, where to enter, the stop and two targets.
  assert.equal(g.engine_state, "NO_TRADE");
  assert.deepEqual([g.action, g.entry, g.stop_loss, g.tp1, g.tp2], ["WAIT_FOR_BUY_TRIGGER", 4100, 4091, 4130, 4160]);
  assert.equal(chargedRead("NO_TRADE", g), true);
  const f = fx({ state: "NO_TRADE", levels: { support: 1.118, resistance: 1.124 }, scores: { overall: 40 } });
  assert.ok(f.entry != null && f.stop_loss != null && f.tp1 != null);
  assert.equal(chargedRead("NO_TRADE", f), true);
  // It is the same test the lock uses: what is charged in the tool is exactly what is kept back on the cards.
  for (const read of [g, f, gold({ state: "NO_TRADE" }), fx({ state: "NO_TRADE" })]) assert.equal(chargedRead("NO_TRADE", read), hasPlay(read));
});

test("a read with nothing in it to trade from is still free", () => {
  // No levels to draw a range from, one level only, not enough data, no data: the engine draws no plan.
  const empty: [string, Record<string, unknown>][] = [
    ["NO_TRADE", { state: "NO_TRADE", scores: { overall: 40 } }],
    ["NO_TRADE", { state: "NO_TRADE", levels: { support: 4100 }, scores: { overall: 40 } }],
    ["INSUFFICIENT_DATA", { state: "INSUFFICIENT_DATA" }],
    ["DATA_UNAVAILABLE", { state: "DATA_UNAVAILABLE" }],
  ];
  for (const [state, read] of empty) {
    const g = gold(read);
    assert.deepEqual([g.entry, g.stop_loss, g.tp1, g.tp2, g.tp3], [null, null, null, null, null], JSON.stringify(read));
    assert.equal(chargedRead(state, g), false, JSON.stringify(read));
    assert.equal(chargedRead(state, fx(read)), false, `fx ${JSON.stringify(read)}`);
  }
  for (const state of ["NO_TRADE", "", null, undefined, "anything"]) for (const read of [null, undefined, {}, [], "BUY 4100", { action: "WAIT_FOR_BUY_TRIGGER", directional_bias: "bullish", closest_support: 4100, closest_resistance: 4160 }]) assert.equal(chargedRead(state, read), false);
});

test("MFX Ghost returns the engine's read raw: a plan there is an entry, a stop, a target, a zone — or the two levels of the range", () => {
  // A raw read keeps its plan in objects, not flat fields: the lock's own test does not see it.
  const withTrade = { state: "WATCHLIST", direction: "sell", provisional_trade: { entry: { price: 2869.56, zone_low: 2869.56, zone_high: 2871.49 }, stop_loss: { price: 2893.01 }, take_profits: [{ price: 2822.66 }] }, levels: { support: 2858.88, resistance: 3057.45 } };
  assert.equal(hasPlay(withTrade), false);
  assert.equal(engineReadHasPlan(withTrade), true);
  // Any one part of a plan is a plan.
  const parts: Record<string, unknown>[] = [
    { entry: { price: 4100 } }, { entry: { zone_low: 4099.5 } }, { entry: { zone_high: "4100.8" } }, { stop_loss: { price: 4091 } }, { take_profits: [{ price: 4130 }] },
    { setup_zone: { zone_low: 4099.5, zone_high: 4100.8 } }, { provisional_trade: { entry: { price: 4100 } } }, { provisional_trade: { stop_loss: { price: 4091 } } }, { provisional_trade: { take_profits: [{}, { price: 4130 }] } },
    // No trade of its own — and still the support and the resistance the range plan is drawn from. On
    // The Floor's card those two numbers are the entry and the far target.
    { state: "NO_TRADE", direction: null, provisional_trade: null, setup_zone: null, levels: { support: 2858.88, resistance: 3057.45, equilibrium: 2958.16 } },
  ];
  for (const read of parts) { assert.equal(engineReadHasPlan(read), true, JSON.stringify(read)); assert.equal(chargedGhostRead("NO_TRADE", read), true, JSON.stringify(read)); }
  // Nothing to trade from: no levels, one level only, empty objects, not enough data.
  const empty: unknown[] = [null, undefined, {}, [], "SELL 4100", { state: "INSUFFICIENT_DATA" }, { levels: {} }, { levels: { support: 4100 } }, { levels: { resistance: 4160 } }, { levels: { support: null, resistance: "—" } },
    { entry: null, stop_loss: null, take_profits: [], provisional_trade: null, setup_zone: null }, { entry: { price: null }, stop_loss: { reason: "above the high" }, take_profits: [{ label: "TP1" }] }, { direction: "sell", headline: "SELL bias", proximity: { status: "far" } }];
  for (const read of empty) { assert.equal(engineReadHasPlan(read), false, JSON.stringify(read)); for (const state of ["NO_TRADE", "WATCHLIST", "INSUFFICIENT_DATA", "DATA_UNAVAILABLE"]) assert.equal(chargedGhostRead(state, read), false, `${state} ${JSON.stringify(read)}`); }
  // A trade or a developing setup is charged whatever came with it, as it always was.
  for (const state of ["TRADE_READY", "DEVELOPING_SETUP"]) assert.equal(chargedGhostRead(state, {}), true, state);
});

test("the three tools charge by these rules and nothing else: after the read is built, once, and never before the work succeeds", () => {
  const genx = code("src/app/api/genx/route.ts");
  const at = (s: string, src = genx) => { const i = src.indexOf(s); assert.ok(i > 0, s); return i; };
  assert.ok(at("const genx = buildGenx(read,") < at("const chargeable = chargedRead(read.state, genx);"));
  assert.ok(at("const chargeable = chargedRead(read.state, genx);") < at('if (chargeable) await chargeCredit("genx");'));
  assert.ok(at('const gate = await gateCredits("genx");') < at("const rr = await computeGenxRead("), "out of credits is still refused before any work");
  assert.equal((genx.match(/chargeCredit\(/g) ?? []).length, 1);
  const genfx = code("src/app/api/genfx/route.ts");
  assert.ok(at("const genfx = genfxOf(pair, read,", genfx) < at("const chargeable = chargedRead(read.state, genfx);", genfx));
  // The owner's GEN FX billing switch still decides whether a GEN FX read costs anything at all.
  assert.ok(at("const chargeable = chargedRead(read.state, genfx);", genfx) < at('if (ctl.billing && chargeable) await chargeCredit("genx");', genfx));
  assert.equal((genfx.match(/chargeCredit\(/g) ?? []).length, 1);
  const ghost = code("src/app/api/xaughost/route.ts");
  // Ghost: WHETHER it is charged is decided on the engine's own read — before the story is asked for,
  // and before the read is rewritten for the old app (that pass turns its direction into other words)…
  assert.ok(at("const read = runEngine(cfg,", ghost) < at("const chargeable = chargedGhostRead(read.state, read);", ghost));
  assert.ok(at("const chargeable = chargedGhostRead(read.state, read);", ghost) < at("await fetch(ANTHROPIC_URL", ghost));
  assert.ok(at("const chargeable = chargedGhostRead(read.state, read);", ghost) < at("legacyOverlay(read);", ghost));
  // …and the credits are TAKEN last of all: nothing that can fail or stall stands between the charge and the answer.
  // (If the spend fails because the credits have gone — another read took them meanwhile — the read is refused, not given away.)
  assert.match(ghost, /legacyOverlay\(read\);\s*if \(chargeable && !\(await chargeCredit\("ghost"\)\)\) \{\s*const again = await gateCredits\("ghost"\);\s*if \(!again\.ok && again\.reason === "insufficient"\) return json\(\{ error: "insufficient_credits", balance: again\.balance \}, 402\);\s*\}\s*return json\(\{ ok: true, price,/);
  // The story is another service's: it is given 20 seconds, so a stall there cannot run the whole read out of time.
  assert.match(ghost, /await fetch\(ANTHROPIC_URL, \{[\s\S]{0,900}?signal: AbortSignal\.timeout\(20_000\),\s*\}\);/);
  assert.ok(at('const gate = await gateCredits("ghost");', ghost) < at('series(TD, "1day"', ghost), "out of credits is still refused before any work");
  assert.equal((ghost.match(/chargeCredit\(/g) ?? []).length, 1);
  // In all three the story is asked for before any credits are taken: a read lost to that service is not a read paid for.
  assert.ok(at("await fetch(ANTHROPIC_URL", genx) < at('if (chargeable) await chargeCredit("genx");', genx));
  assert.ok(at("await fetch(ANTHROPIC_URL", genfx) < at('if (ctl.billing && chargeable) await chargeCredit("genx");', genfx));
  assert.ok(at("await fetch(ANTHROPIC_URL", ghost) < at('if (chargeable && !(await chargeCredit("ghost"))) {', ghost));
  for (const r of [genx, genfx, ghost]) assert.ok(!/const chargeable = read\.state === "/.test(r), "the old rule is not left standing beside the new one");
});
