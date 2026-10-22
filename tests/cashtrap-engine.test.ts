import test from "node:test";
import assert from "node:assert/strict";
import { closeOf, M5, type Candle } from "../src/lib/cashtrap/candles";
import { initialState, step, withBreaks, type ArmedSetup, type EngineState } from "../src/lib/cashtrap/engine";
import { manualZonesAt, type ManualZoneInput } from "../src/lib/cashtrap/zones";
import { replay } from "../src/lib/cashtrap/replay";
import { dmiStochastic } from "../src/lib/cashtrap/dmi";
import { buyScenario, calm, cfgWith, then } from "./_cashtrap";

/**
 * The Cashtrap setup rules, candle by candle. DMI events are fed in exactly where each test needs them
 * ("event-feed" mode), so the rule under test is the only thing that varies.
 */
type B = [number, number, number, number];
const cfg = cfgWith();
const sc = buyScenario(cfg.assumptions);
const exIdx = sc.before.length;                       // index of the exhaustion candle
const exT = sc.before[sc.before.length - 1].t + M5;
const HOLD: B = [99.62, 99.66, 99.61, 99.64];          // stays above the zone, extension clears
const after = (...bars: B[]) => then(sc.before, [sc.exhaustion, ...bars]);
const ev = (t: number, type: "B" | "S") => ({ symbol: "EURUSD" as const, candleT: t, type, source: "test", knownAt: closeOf(t) });

async function run(candles: Candle[], events: Array<ReturnType<typeof ev>> = [], over: { dmiMode?: "event-feed" | "off"; startIndex?: number; config?: ReturnType<typeof cfgWith> } = {}) {
  const mode = over.dmiMode ?? "event-feed";
  return replay({
    symbol: "EURUSD", candles, config: over.config ?? cfg, dmiMode: mode, dmiAvailable: mode !== "off", externalEvents: events,
    decisionLatencyMs: 8_000, publishLatencyMs: 0, quotes: null, startIndex: over.startIndex ?? exIdx,
  });
}

test("an exhaustion candle (band, RSI 4, Stochastic, support zone) arms a BUY setup — not a signal", async () => {
  const r = await run(after(HOLD, HOLD));
  const d0 = r.decisions[0];
  assert.equal(d0.status, "ARMED");
  assert.equal(d0.direction, "BUY");
  assert.deepEqual([d0.checklist?.BUY.band, d0.checklist?.BUY.rsi, d0.checklist?.BUY.stoch, d0.checklist?.BUY.zone], [true, true, true, true]);
  assert.equal(d0.met, 4, "4 of 5: the DMI B has not come");
  assert.ok((d0.values?.rsi as number) < 20 && (d0.values?.stochK as number) < 20 && (d0.values?.low as number) < (d0.values?.bbLower as number));
  assert.equal(d0.zoneId, sc.zone.id, "the exact zone that contributed");
  assert.equal(r.signals.length, 0);
});

test("a DMI B on the exhaustion candle confirms it at once: CALL", async () => {
  const r = await run(after(HOLD), [ev(exT, "B")]);
  assert.equal(r.decisions[0].status, "CONFIRMED");
  assert.equal(r.signals.length, 1);
  assert.equal(r.signals[0].direction, "CALL");
  assert.equal(r.signals[0].setupCandleT, exT);
  assert.equal(r.signals[0].confirmationT, exT);
});

test("a DMI B on either of the next two candles confirms; on the third it is too late", async () => {
  for (const k of [1, 2]) {
    const r = await run(after(HOLD, HOLD, HOLD), [ev(exT + k * M5, "B")]);
    assert.equal(r.decisions[k].status, "CONFIRMED", `B on candle +${k}`);
    assert.equal(r.signals[0].confirmationT, exT + k * M5);
  }
  const late = await run(after(HOLD, HOLD, HOLD), [ev(exT + 3 * M5, "B")]);
  assert.equal(late.signals.length, 0);
  assert.equal(late.setups[0].status, "expired");
  assert.match(String(late.setups[0].reason), /no DMI B within 3 candles/);
  assert.equal(late.decisions[2].reasonCode, "expired", "the window ends with the second candle after the exhaustion");
});

test("RSI and Stochastic need not still be extreme when the B arrives", async () => {
  const bounce: B = [99.62, 99.75, 99.61, 99.74];
  const r = await run(after(bounce, HOLD), [ev(exT + M5, "B")]);
  assert.equal(r.decisions[1].status, "CONFIRMED");
  assert.ok((r.decisions[1].values?.rsi as number) > 20, "RSI is back above 20 — the recorded exhaustion still stands");
  assert.ok((r.signals[0].exhaustionValues.rsi as number) < 20, "the signal keeps the exhaustion candle's values");
});

test("an opposite DMI S cancels the BUY setup", async () => {
  const r = await run(after(HOLD, HOLD), [ev(exT + M5, "S"), ev(exT + 2 * M5, "B")]);
  assert.equal(r.setups[0].status, "cancelled");
  assert.match(String(r.setups[0].reason), /opposite DMI S/);
  assert.equal(r.signals.length, 0, "the later B does not revive it");
});

test("a close below the support zone cancels the BUY setup — even if a B prints on that candle", async () => {
  const breaks: B = [99.62, 99.63, 99.5, 99.55];
  const r = await run(after(breaks, HOLD), [ev(exT + M5, "B")]);
  assert.equal(r.setups[0].status, "cancelled");
  assert.match(String(r.setups[0].reason), /below the support zone/);
  assert.equal(r.signals.length, 0);
});

test("without DMI events (source required) a setup can arm but never confirm", async () => {
  const r = await run(after(HOLD, HOLD, HOLD), [], { dmiMode: "off" });
  assert.equal(r.decisions[0].status, "ARMED");
  assert.equal(r.decisions[0].checklist?.BUY.dmi, null, "the DMI condition is unavailable, not false");
  assert.equal(r.setups[0].status, "expired");
  assert.match(String(r.setups[0].reason), /DMI source required/);
  assert.equal(r.signals.length, 0);
});

test("a missing candle makes the data unreliable: no decision, and the armed setup is cancelled", async () => {
  const s = after(HOLD, HOLD);
  const gapped = [...s.slice(0, exIdx + 1), ...s.slice(exIdx + 2)];         // drop the candle after the exhaustion
  const r = await run(gapped);
  assert.equal(r.decisions[1].status, "DATA_UNAVAILABLE");
  assert.match(r.decisions[1].reason, /missing candle/);
  assert.equal(r.setups[0].status, "cancelled");
  assert.match(String(r.setups[0].reason), /data unavailable/);
});

test("too little history is DATA UNAVAILABLE (warming up), never a guess", async () => {
  const r = await replay({ symbol: "EURUSD", candles: calm(120), config: cfg, dmiMode: "off", dmiAvailable: false, decisionLatencyMs: 8_000, publishLatencyMs: 0, quotes: null, startIndex: 100 });
  assert.ok(r.decisions.every((d) => d.status === "DATA_UNAVAILABLE" && /warming up/.test(d.reason)));
});

/* ── the rules that need a prior state: drive step() directly ─────────────────────────────────── */
const exCandles = after();
const stepAt = (state: EngineState, candles: Candle[], events: Array<ReturnType<typeof ev>> = [], decidedAt = closeOf(candles[candles.length - 1].t) + 8_000, config = cfg) =>
  step(state, { candles, manualZones: [], dmiMode: "event-feed", dmiAvailable: true, externalEvents: events, decidedAt, config });
const fresh = (): EngineState => ({ ...initialState("EURUSD"), lastT: exT - M5 });

test("the same direction cannot arm again until its conditions have reset", () => {
  const blocked = stepAt({ ...fresh(), needsReset: { BUY: true, SELL: false } }, exCandles);
  assert.equal(blocked.decision.reasonCode, "no_reset");
  assert.equal(blocked.events.length, 0);
  const ok = stepAt(fresh(), exCandles);
  assert.equal(ok.events[0]?.type, "armed");
  assert.equal(ok.state.needsReset.BUY, true, "arming uses the extreme up");
  const cleared = stepAt(ok.state, after([99.7, 99.86, 99.7, 99.85]));
  assert.equal(cleared.state.needsReset.BUY, false, "a candle where the band excursion, RSI extreme and Stochastic extreme all cleared resets it");
});

test("an opposite exhaustion cancels the armed setup (and arms its own)", () => {
  const sellArmed: ArmedSetup = {
    id: "EURUSD:SELL:x", symbol: "EURUSD", direction: "SELL", exhaustionT: exT - 2 * M5, armedAt: 0, seen: 0,
    zone: { id: "z", kind: "resistance", origin: "auto", lower: 100.5, upper: 100.6, center: 100.55, createdAt: 0, pivotT: 0, halfWidth: 0.05, atrAtCreation: 0.3 },
    values: {} as ArmedSetup["values"], checklist: { band: true, rsi: true, stoch: true, zone: true, dmi: false },
  };
  const out = stepAt({ ...fresh(), armed: sellArmed }, exCandles);
  const cancel = out.events.find((e) => e.type === "cancelled");
  assert.ok(cancel && cancel.type === "cancelled" && /opposite BUY exhaustion/.test(cancel.reason));
  assert.equal(out.state.armed?.direction, "BUY");
});

test("one active signal per symbol: a confirmation while a signal is running is recorded, not published", () => {
  const busy = { ...fresh(), activeSignal: { setupId: "earlier", direction: "SELL" as const, until: closeOf(exT) + 60_000 } };
  const out = stepAt(busy, exCandles, [ev(exT, "B")]);
  const c = out.events.find((e) => e.type === "confirmed");
  assert.ok(c && c.type === "confirmed" && c.publish === false && /still running/.test(String(c.suppressedReason)));
  const free = stepAt({ ...busy, activeSignal: { ...busy.activeSignal, until: closeOf(exT) } }, exCandles, [ev(exT, "B")]);
  const c2 = free.events.find((e) => e.type === "confirmed");
  assert.ok(c2 && c2.type === "confirmed" && c2.publish === true, "once the window has passed, it publishes");
});

test("a DMI event is used only once it is known: one received after the decision does not count", () => {
  const late = { ...ev(exT, "B"), knownAt: closeOf(exT) + 30_000 };
  const out = stepAt(fresh(), exCandles, [late]);
  assert.equal(out.decision.status, "ARMED");
});

test("a candle is decided once: the same candle (or an older one) again is refused", () => {
  const out = stepAt(fresh(), exCandles);
  assert.throws(() => stepAt(out.state, exCandles), /is not after/);
});

/* ── calculation mode: every confirmation sits on a DMI event of the owner's indicator ─────────── */
test("with the calculated DMI, every confirmation is on a candle where the DMI-Stochastic crossed (B for CALL, S for PUT)", async () => {
  let x = 11;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  const candles: Candle[] = [];
  let px = 100;
  for (let i = 0; i < 3000; i++) {
    const o = px, c = o + (rnd() - 0.5) * 0.3 * (1 + (i % 97 < 6 ? 3 : 0));
    candles.push({ t: Date.UTC(2026, 9, 6) + i * M5, o, h: Math.max(o, c) + rnd() * 0.06, l: Math.min(o, c) - rnd() * 0.06, c });
    px = c;
  }
  // Keep it on weekdays: drop Saturday/Sunday slots so the closed market is not mistaken for gaps.
  const open = candles.filter((k) => { const d = new Date(k.t).getUTCDay(); return d >= 1 && d <= 5; });
  const r = await replay({ symbol: "EURUSD", candles: open, config: cfg, dmiMode: "calculation", dmiAvailable: true, decisionLatencyMs: 8_000, publishLatencyMs: 0, quotes: null });
  const confirmed = r.setups.filter((s) => s.status === "confirmed");
  for (const s of confirmed) {
    const i = open.findIndex((k) => k.t === s.confirmT);
    const win = open.slice(Math.max(0, i + 1 - cfg.assumptions.data.windowCandles), i + 1);
    const d = dmiStochastic(win.map((k) => k.h), win.map((k) => k.l), win.map((k) => k.c));
    assert.ok(s.direction === "BUY" ? d.buy[win.length - 1] : d.sell[win.length - 1], `confirmation at ${new Date(s.confirmT as number).toISOString()}`);
  }
  assert.ok(r.setups.length > 0, "the sample produced setups");
});

test("a setup never carries across a market closure: armed at Friday's last candle, cancelled at Sunday's open", async () => {
  const friLast = Date.UTC(2026, 9, 23, 20, 55);                       // Friday 16:55 New York
  const shift = friLast - exT;
  const s = after().map((k) => ({ ...k, t: k.t + shift }));
  const sunday = Date.UTC(2026, 9, 25, 21, 0);                         // Sunday 17:00 New York (fx open)
  const withSunday = [...s, { t: sunday, o: 99.62, h: 99.66, l: 99.61, c: 99.64 }];
  const r = await replay({ symbol: "EURUSD", candles: withSunday, config: cfg, dmiMode: "event-feed", dmiAvailable: true, externalEvents: [ev(sunday, "B")], decisionLatencyMs: 8_000, publishLatencyMs: 0, quotes: null, startIndex: exIdx });
  assert.equal(r.decisions[0].status, "ARMED");
  assert.equal(r.setups[0].status, "cancelled");
  assert.match(String(r.setups[0].reason), /market closed/);
  assert.equal(r.signals.length, 0, "the B on Sunday's first candle does not confirm Friday's setup");
});

test("no repainting: every decision is the same whether or not later candles exist", async () => {
  let x = 29;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  const all: Candle[] = [];
  let px = 100;
  for (let i = 0; all.length < 1600; i++) {
    const t = Date.UTC(2026, 9, 6) + i * M5;
    const d = new Date(t).getUTCDay();
    if (d < 1 || d > 5 || (d === 5 && new Date(t).getUTCHours() >= 20)) continue;   // weekdays only
    const o = px, c = o + (rnd() - 0.5) * 0.3 * (1 + (i % 97 < 6 ? 3 : 0));
    all.push({ t, o, h: Math.max(o, c) + rnd() * 0.06, l: Math.min(o, c) - rnd() * 0.06, c });
    px = c;
  }
  const opts = { symbol: "EURUSD" as const, config: cfg, dmiMode: "calculation" as const, dmiAvailable: true, decisionLatencyMs: 8_000, publishLatencyMs: 0, quotes: null };
  const cut = 1100;
  const early = await replay({ ...opts, candles: all.slice(0, cut) });
  const later = await replay({ ...opts, candles: all });
  const key = (d: (typeof early.decisions)[number]) => JSON.stringify([d.candleT, d.status, d.direction, d.leading, d.met, d.reasonCode, d.reason, d.setupId, d.zoneId, d.checklist, d.values]);
  assert.ok(early.decisions.length > 800);
  for (let i = 0; i < early.decisions.length; i++) assert.equal(key(later.decisions[i]), key(early.decisions[i]), `candle ${new Date(early.decisions[i].candleT).toISOString()}`);
  assert.ok(early.decisions.some((d) => d.status === "ARMED") && early.decisions.some((d) => d.status === "CONFIRMED"), "the stretch has setups and confirmations in it");
});

/* ── review fixes ─────────────────────────────────────────────────────────────────────────────── */
test("a confirmation decided too late (the runner was down) is recorded, not published — and holds nothing up", () => {
  const late = stepAt(fresh(), exCandles, [ev(exT, "B")], closeOf(exT) + 75_000);
  const c = late.events.find((e) => e.type === "confirmed");
  assert.ok(c && c.type === "confirmed" && c.publish === false && /too late to publish/.test(String(c.suppressedReason)));
  assert.equal(late.state.activeSignal, null, "a signal that was never sent does not block the next one");
  const onTime = stepAt(fresh(), exCandles, [ev(exT, "B")]);
  assert.ok(onTime.state.activeSignal, "an on-time one does");
});

test("no signal is published into a closed market — at publication or at expiry", () => {
  const shiftTo = (exhaustionT: number) => { const d = exhaustionT - exT; return exCandles.map((k) => ({ ...k, t: k.t + d })); };
  const fri1655 = Date.UTC(2026, 9, 23, 20, 55);                    // Friday 16:55 New York: closes at 17:00, the weekly close
  const a = stepAt({ ...initialState("EURUSD"), lastT: fri1655 - M5 }, shiftTo(fri1655), [ev(fri1655, "B")]);
  const ca = a.events.find((e) => e.type === "confirmed");
  assert.ok(ca && ca.type === "confirmed" && ca.publish === false && /closed at publication/.test(String(ca.suppressedReason)));
  const fri1650 = fri1655 - M5;                                      // published 16:55:08, a 300 s expiry would land after 17:00
  const b = stepAt({ ...initialState("EURUSD"), lastT: fri1650 - M5 }, shiftTo(fri1650), [ev(fri1650, "B")]);
  const cb = b.events.find((e) => e.type === "confirmed");
  assert.ok(cb && cb.type === "confirmed" && cb.publish === false && /closed at expiry/.test(String(cb.suppressedReason)));
  assert.equal(b.state.activeSignal, null);
  const wed = stepAt(fresh(), exCandles, [ev(exT, "B")]);           // the same setup mid-week publishes
  const cw = wed.events.find((e) => e.type === "confirmed");
  assert.ok(cw && cw.type === "confirmed" && cw.publish === true);
});

test("a fed DMI event that arrived before its candle closed (an alert fired mid-candle) does not count", () => {
  const early = { ...ev(exT, "B"), knownAt: closeOf(exT) - 60_000 };
  assert.equal(stepAt(fresh(), exCandles, [early]).decision.status, "ARMED");
  const atClose = { ...ev(exT, "B"), knownAt: closeOf(exT) + 2_000 };
  assert.equal(stepAt(fresh(), exCandles, [atClose]).decision.status, "CONFIRMED");
});

test("a manual zone broken by a close stays broken after that candle has left the calculation window", () => {
  let s = calm(100);
  s = then(s, [[100.0, 100.0, 99.38, 99.4]]);                         // index 100: closes below the zone
  s = [...s, ...calm(620, s[s.length - 1].t + M5)];
  const zone: ManualZoneInput = { id: "manual:EURUSD:test", symbol: "EURUSD", kind: "support", lower: 99.5, upper: 99.55, activeFrom: s[0].t, activeUntil: null };
  const out = step({ ...initialState("EURUSD"), lastT: s[299].t }, { candles: s.slice(0, 301), manualZones: [zone], dmiMode: "off", dmiAvailable: false, decidedAt: closeOf(s[300].t) + 8_000, config: cfg });
  assert.deepEqual(out.state.manualBroken?.[zone.id], { at: closeOf(s[100].t), close: 99.4 });
  // 600 candles on, the breaking candle is outside the 500-candle window.
  const win = s.slice(s.length - 501);
  const fromWindowOnly = manualZonesAt([zone], win, win.length - 1, cfg.assumptions.zones)[0];
  assert.equal(fromWindowOnly.invalidatedAt, null, "the window alone no longer shows the break");
  const remembered = manualZonesAt(withBreaks([zone], out.state), win, win.length - 1, cfg.assumptions.zones)[0];
  assert.equal(remembered.invalidatedAt, closeOf(s[100].t), "the remembered break keeps it broken");
  // And through the engine itself, candle after candle:
  const r = step(out.state, { candles: win, manualZones: [zone], dmiMode: "off", dmiAvailable: false, decidedAt: closeOf(win[win.length - 1].t) + 8_000, config: cfg });
  assert.ok(r.state.manualBroken?.[zone.id], "still remembered");
});
