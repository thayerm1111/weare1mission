import { test } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { lockSetup, lockAlerts, type SetupGate } from "../src/lib/setupLock";
import { CLOSED } from "../src/lib/setupAccess";
import { floorInstrument, setupQuery } from "../src/lib/floor/setupInstruments";
import { buildGenx, MODES } from "../src/lib/genxCompute";

/*
 * The pages, drawn. Live setups take credits to view (owner 10-05): with a member's window closed the
 * card and the lists are drawn from an answer with no play in it, and with it open they are drawn as
 * they always were. These draw both and read the result, the way a browser would be handed it.
 *
 * (The components are compiled here with the classic JSX runtime, which looks for a global React.)
 */
(globalThis as unknown as { React: typeof React }).React = React;
const h = React.createElement;
const NOW = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const paid = (minutes: number): SetupGate => ({ open: true, via: "credits", until: iso(NOW + minutes * 60_000), cost: 5, minutes: 30 });
const noop = () => {};

const READ = buildGenx({
  state: "DEVELOPING_SETUP", direction: "sell", strategy: "trend_pullback", market_regime: "Bearish trend",
  entry: { price: 4130.9, zone_low: 4129.98, zone_high: 4131.84 }, stop_loss: { price: 4170.6, reason: "A close above the swing high." },
  take_profits: [{ price: 4048.74, risk_reward: 2.1 }, { price: 4021.5 }], levels: { support: 4046.2, resistance: 4168.4 }, scores: { overall: 66, directional: 70 },
}, { mode: "swing", price: 4122.01, session: "Asia", dataStatus: "live", hold: MODES.swing.hold, triggerTf: MODES.swing.triggerTf, contextTf: MODES.swing.contextTf, pip: 0.1, dec: 2, marketStory: [], volatility: "normal", atr: 9.5, m15: [] });
const CANDLES = Array.from({ length: 48 }, (_, i) => ({ t: iso(NOW - (48 - i) * 3600_000), o: 4100 + i * 0.5, h: 4103 + i * 0.5, l: 4098 + i * 0.5, c: 4101 + i * 0.5 }));
const BODY = { g: READ, candles: CANDLES, price: 4122.01, session: "Asia", mode: "swing", asOf: iso(NOW), symbol: "XAUUSD" };
/** What the play looks like once printed: its levels, and its direction in the card's own words. */
const PRINTED = ["4,130.90", "4,129.98", "4,170.60", "4,048.74", "4,021.50", "REACTION ZONE", "ENTRY ZONE", "INVALIDATION", "TP1", "TP2", "Bearish", "SELL", "R:R"];

test("The Floor's card, window closed: the lock, the stage, the price of opening it — and nothing of the trade", async () => {
  const { SetupForming } = await import("../src/components/portal/floor/FloorHome");
  const html = renderToStaticMarkup(h(SetupForming, {
    data: { ...lockSetup(BODY), setups: CLOSED } as never, mode: "swing", inst: floorInstrument("XAUUSD"),
    onSymbol: noop, onMode: noop, onExpand: noop, onOpened: noop,
  }));
  assert.ok(html.includes("GENX · SWING — setup forming"), "says what is behind it");
  assert.ok(html.includes("See the play · 5 credits"));
  assert.ok(html.includes("Opens every live setup on the site for 30 minutes."));
  for (const t of PRINTED) assert.ok(!html.includes(t), `"${t}" is on a locked card`);
  assert.ok(!/41[0-9]{2}\.[0-9]{2}|4,[01][0-9]{2}/.test(html.replace(/<svg[\s\S]*?<\/svg>/g, "")), "no price is printed outside the chart");
  assert.ok(!html.includes("min left"));
  // The market toggle and the horizon tabs are still there: a member can look at what else is locked.
  for (const chip of ["Gold", "EUR/USD", "GBP/JPY", ">5m<", ">15m<", ">1h<"]) assert.ok(html.includes(chip), chip);
  // A pair says whose read it is.
  const fx = renderToStaticMarkup(h(SetupForming, {
    data: { ...lockSetup({ ...BODY, g: { ...READ, action: "BUY_NOW" }, symbol: "EURUSD", mode: "quick" }), setups: CLOSED } as never, mode: "quick", inst: floorInstrument("EURUSD"),
    onSymbol: noop, onMode: noop, onExpand: noop, onOpened: noop,
  }));
  assert.ok(fx.includes("GEN FX · QUICK — entry is live now"));
  assert.ok(!/BUY|Bullish/.test(fx));
});

test("The Floor's card, window open: the map as it always was, and how long is left on a paid window", async () => {
  const { SetupForming } = await import("../src/components/portal/floor/FloorHome");
  const draw = (setups: SetupGate | undefined) => renderToStaticMarkup(h(SetupForming, {
    data: { ...BODY, ...(setups ? { setups } : {}) } as never, mode: "swing", inst: floorInstrument("XAUUSD"), onSymbol: noop, onMode: noop, onExpand: noop, onOpened: noop,
  }));
  const html = draw(paid(12.4));
  for (const t of ["4,170.60", "4,048.74", "TP1", "INVALIDATION", "Bearish", "R:R"]) assert.ok(html.includes(t), `"${t}" is on the open card`);
  assert.ok(!html.includes("See the play"));
  assert.ok(html.includes("Open · 13 min left"));
  // A Pass holder, an admin, and an answer from before the lock existed are drawn the same, with no clock.
  const plain = draw(undefined);
  assert.equal(draw({ open: true, via: "pass", until: null, cost: 5, minutes: 30 }), plain);
  assert.equal(draw({ open: true, via: "admin", until: null, cost: 5, minutes: 30 }), plain);
  assert.ok(!plain.includes("min left") && plain.includes("4,170.60"));
  // …and the paid one differs from them by the clock alone.
  assert.equal(html.replace(/<span[^>]*title="Your window on the live setups"[^>]*>Open · 13 min left<\/span>/, ""), plain);
});

test("GEN FX's lists, window closed: each open call is its pair and horizon; one button; a graded call is a result", async () => {
  const { Watching } = await import("../src/components/portal/floor/GenFxDesk");
  const a = (o: Record<string, unknown>) => ({ id: String(o.id), pair: "EURUSD", dedupe_key: "EURUSD:intraday:sell:11206:11209:20261005", mode: "intraday", side: "sell", state: "forming", kind: "scanner", entry: 1.12075, entry_low: 1.1206, entry_high: 1.1209, stop: 1.12269, tp1: 1.11617, confidence: 70, created_at: iso(NOW - 600_000), enter_price: null, enter_sent_at: null, outcome: null, result_pips: null, ...o });
  const alerts = [
    a({ id: 1 }),
    a({ id: 2, pair: "GBPJPY", state: "zone", kind: "zone", entry: 208.835, stop: 209.161, tp1: 208.179, side: "buy" }),
    a({ id: 3, state: "entered", enter_price: 1.11922, enter_sent_at: iso(NOW - 300_000) }),
    a({ id: 4, state: "entered", enter_price: 1.12271, stop: 1.124, tp1: 1.12125, enter_sent_at: iso(NOW - 7200_000), outcome: "win", result_pips: 17 }),
  ];
  const desk = (open: boolean) => ({ ok: true, alerts: open ? alerts : lockAlerts(alerts), setups: open ? paid(20) : CLOSED, switches: { scan: true }, lastScan: { at: iso(NOW - 60_000), beat: null, quiet: false, decisions: null } });
  const locked = renderToStaticMarkup(h(Watching, { desk: desk(false) as never, reload: noop }));
  assert.equal((locked.match(/See the play · 5 credits/g) ?? []).length, 1, "one button for the list");
  assert.equal((locked.match(/side, entry, stop and target open with credits/g) ?? []).length, 3, "the three open calls");
  for (const t of ["EUR/USD", "GBP/JPY", "intraday", "enters on touch", "waiting to confirm", "running"]) assert.ok(locked.includes(t), t);
  // The graded call is printed whole — it is a result. Nothing of the three open ones is.
  assert.ok(locked.includes("WIN +17p") && locked.includes("in @ 1.12271 · stop 1.12400 · TP1 1.12125"));
  for (const t of ["1.12075", "1.12060", "1.12090", "1.12269", "1.11617", "1.11922", "208.835", "209.161", "208.179", "BUY"]) assert.ok(!locked.includes(t), `"${t}" is in a locked list`);
  assert.equal((locked.match(/SELL/g) ?? []).length, 1, "only the graded call says which way");
  // Open: every call says which way and where, there is no button, and the clock shows.
  const open = renderToStaticMarkup(h(Watching, { desk: desk(true) as never, reload: noop }));
  for (const t of ["1.12060–1.12090", "1.12269", "1.11617", "in @ 1.11922", "208.835", "GBP/JPY BUY", "EUR/USD SELL", "Open · 20 min left"]) assert.ok(open.includes(t), t);
  assert.ok(!open.includes("See the play") && !open.includes("open with credits"));
  // Nothing to lock, nothing to sell: an empty list has no button.
  const empty = renderToStaticMarkup(h(Watching, { desk: { ok: true, alerts: [], setups: CLOSED } as never, reload: noop }));
  assert.ok(empty.includes("Nothing lined up right now.") && !empty.includes("See the play"));
  // The button says what is behind it: setups lined up, calls running — or, when all that is kept
  // back is a call that ran out of time, earlier calls. An expired call keeps its levels back too.
  const drawn = (list: Record<string, unknown>[]) => renderToStaticMarkup(h(Watching, { desk: { ok: true, alerts: lockAlerts(list), setups: CLOSED } as never, reload: noop }));
  assert.ok(locked.includes("GEN FX — setups lined up"));
  assert.ok(drawn([alerts[2], alerts[3]]).includes("GEN FX — calls running"));
  const old = drawn([a({ id: 9, state: "entered", enter_price: 1.11987, enter_sent_at: iso(NOW - 6 * 3600_000), outcome: "expired", result_pips: -3 }), alerts[3]]);
  assert.ok(old.includes("GEN FX — earlier calls") && old.includes("expired") && old.includes("WIN +17p"));
  assert.equal((old.match(/side, entry, stop and target open with credits/g) ?? []).length, 1);
  for (const t of ["1.11987", "1.12269", "1.11617", "-3p"]) assert.ok(!old.includes(t), `"${t}" is in a locked list`);
});

test("the lock itself: the price and the half hour come from the window, in either colour scheme", async () => {
  const { SetupLock, SetupTimer, LockedSetupCard } = await import("../src/components/portal/SetupLock");
  const dark = renderToStaticMarkup(h(SetupLock, { what: "XAUUSD · QUICK — watching for the trigger", gate: CLOSED, onOpened: noop }));
  const light = renderToStaticMarkup(h(SetupLock, { what: "XAUUSD · QUICK — watching for the trigger", gate: CLOSED, tone: "light", onOpened: noop }));
  for (const html of [dark, light]) {
    assert.ok(html.includes("XAUUSD · QUICK — watching for the trigger") && html.includes("See the play · 5 credits") && html.includes("for 30 minutes"));
    assert.ok(html.includes("Which way, the entry, the stop and the targets open with credits."));
    assert.ok(html.includes("Opens every live setup on the site for 30 minutes. So does a paid GENX, GEN FX or MFX Ghost read."), "a read opens them only if it was charged");
    assert.equal((html.match(/<button/g) ?? []).length, 1);
  }
  assert.notEqual(dark, light);
  // Other numbers, when the window says so; the usual ones when it says nothing.
  assert.ok(renderToStaticMarkup(h(SetupLock, { what: "x", gate: { ...CLOSED, cost: 8, minutes: 45 }, onOpened: noop })).includes("See the play · 8 credits"));
  assert.ok(renderToStaticMarkup(h(SetupLock, { what: "x", onOpened: noop })).includes("See the play · 5 credits"));
  // The clock: a paid window only.
  assert.equal(renderToStaticMarkup(h(SetupTimer, { gate: CLOSED })), "");
  assert.equal(renderToStaticMarkup(h(SetupTimer, { gate: { open: true, via: "pass", until: null, cost: 5, minutes: 30 } })), "");
  assert.ok(renderToStaticMarkup(h(SetupTimer, { gate: paid(29.2), tone: "light" })).includes("Open · 30 min left"));
  // The card behind the lock is the market's candles and nothing else; too few candles, no chart.
  const card = renderToStaticMarkup(h(LockedSetupCard, { what: "GENX · SWING — setup forming", gate: CLOSED, candles: CANDLES, onOpened: noop }));
  const chart = card.slice(card.indexOf("<svg viewBox"), card.indexOf("</svg>"));
  assert.equal((chart.match(/<rect/g) ?? []).length, 44, "the last 44 candles");
  assert.ok(!/<text/.test(chart), "nothing is written on it");
  assert.ok(!renderToStaticMarkup(h(LockedSetupCard, { what: "x", gate: CLOSED, candles: CANDLES.slice(0, 3), onOpened: noop })).includes("<svg viewBox"));
});

test("the card's first look asks for a fresh check of the window; gold's polls are the request they always were", () => {
  assert.equal(setupQuery("intraday", "XAUUSD", "&fresh=1"), "mode=intraday&fresh=1");
  assert.equal(setupQuery("intraday", "XAUUSD", ""), "mode=intraday");
  assert.equal(setupQuery("swing", "GBPJPY", "&fresh=1"), "mode=swing&symbol=GBPJPY&fresh=1");
});

test("See the play is one payment at a time for the whole page: a second button joins the one that is out", async () => {
  const { seeThePlayOnce, seeThePlayIsOut } = await import("../src/components/portal/SetupLock");
  const realFetch = globalThis.fetch, realWindow = (globalThis as { window?: unknown }).window;
  const sent: string[] = [], told: string[] = [];
  let answer: (r: Response) => void = () => {};
  let next: () => Promise<Response> = () => new Promise<Response>((res) => { answer = res; });
  (globalThis as { fetch: unknown }).fetch = (url: string, init?: { method?: string }) => { sent.push(`${init?.method ?? "GET"} ${url}`); return next(); };
  (globalThis as { window?: unknown }).window = { dispatchEvent: (e: Event) => { told.push(e.type); return true; } };
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  try {
    // Two buttons tapped while the first payment is still out — the card redrawn for another market, say.
    assert.equal(seeThePlayIsOut(), false);
    const a = seeThePlayOnce();
    assert.equal(seeThePlayIsOut(), true);
    const b = seeThePlayOnce(), c = seeThePlayOnce();
    assert.ok(a === b && b === c, "they are the same payment");
    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(sent, ["POST /api/setups/pass"], "one request, however many taps");
    answer(reply({ cost: 5, minutes: 30, open: true, via: "credits", until: iso(NOW + 30 * 60_000), charged: true, balance: 7 }));
    const outs = await Promise.all([a, b, c]);
    for (const o of outs) assert.deepEqual(o, { opened: true, charged: true, flyer: false, message: "" });
    assert.deepEqual(told, ["credits-updated"], "and the header is told once, not once per button");
    // Once it has landed the next tap is a new request (the server answers "already open" and takes nothing).
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(seeThePlayIsOut(), false);
    next = async () => reply({ cost: 5, minutes: 30, open: true, via: "credits", until: iso(NOW + 30 * 60_000), charged: false });
    assert.deepEqual(await seeThePlayOnce(), { opened: true, charged: false, flyer: false, message: "" });
    assert.deepEqual([sent.length, told], [2, ["credits-updated"]], "nothing spent, nothing to tell the header");
    // Not enough credits: both buttons hear it, and the page is sent to the credits flyer once.
    await new Promise((r) => setTimeout(r, 0));
    next = async () => reply({ open: false, charged: false, error: "insufficient", balance: 3 }, 402);
    const [x, y] = await Promise.all([seeThePlayOnce(), seeThePlayOnce()]);
    assert.deepEqual([x, y], [x, x]);
    assert.deepEqual([x.opened, x.flyer, x.message, sent.length], [false, true, "Not enough credits — you have 3.", 3]);
    assert.deepEqual(told, ["credits-updated", "open-credits-flyer"]);
    // No answer at all (the network dropped): said, and the next tap is free to try again.
    await new Promise((r) => setTimeout(r, 0));
    next = async () => { throw new Error("offline"); };
    const lost = await seeThePlayOnce();
    assert.deepEqual([lost.opened, lost.message], [false, "That didn't go through. Tap again — you won't be charged twice."]);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(seeThePlayIsOut(), false);
    // An answer that is not JSON: the same.
    next = async () => new Response("oops", { status: 500 });
    assert.equal((await seeThePlayOnce()).opened, false);
    assert.equal(sent.length, 5);
    // Neither of those is "not enough credits": the flyer was opened for that one refusal and no other.
    assert.deepEqual(told, ["credits-updated", "open-credits-flyer"]);
  } finally { (globalThis as { fetch: unknown }).fetch = realFetch; (globalThis as { window?: unknown }).window = realWindow; }
});
