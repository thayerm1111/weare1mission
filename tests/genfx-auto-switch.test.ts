import { test } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { clearlyInView, PINNED } from "../src/lib/inView";
import { SETUP_COST, TRADE_COST } from "../src/lib/flow/flowBilling";

/*
 * GEN FX auto-trade can be switched on from a phone (owner 10-07: "I'm getting reports that people
 * can't set up the auto feature for Gen FX"). Nothing was failing — every switch anyone had reached
 * had saved — but turning a pair ON asks a question first, and the question opened under the account's
 * row: on a phone, 210 pixels below the switch, which is usually under the bottom of the screen. The
 * member tapped, the switch did not move, and nothing they could see changed.
 *
 * The page itself was driven in a browser at phone and desktop sizes for this (before: the "Turn it on"
 * button at 974 on an 844-pixel screen; after: on screen from every position, the switch ringed, the
 * change said in the account's own card). These hold the rule that decides it and what the section draws.
 *
 * (The components are compiled here with the classic JSX runtime, which looks for a global React.)
 */
(globalThis as unknown as { React: typeof React }).React = React;
const h = React.createElement;
const code = (p: string): string => readFileSync(p, "utf8");

test("a box is 'in view' only when all of it is on screen and clear of the header and the corner button", () => {
  const phone = 844;
  // Where the question used to open on a phone when the switch had just been scrolled into view.
  assert.equal(clearlyInView({ top: 800, bottom: 1016 }, phone), false);
  // Half on: not seen.
  assert.equal(clearlyInView({ top: 700, bottom: 900 }, phone), false);
  // All of it on screen, but its bottom edge (where "Turn it on" is) under the button pinned to the corner.
  assert.equal(clearlyInView({ top: 620, bottom: 830 }, phone), false);
  assert.equal(clearlyInView({ top: 560, bottom: phone - PINNED.bottom + 1 }, phone), false);
  assert.equal(clearlyInView({ top: 560, bottom: phone - PINNED.bottom }, phone), true);
  // Under the header that stays at the top of the page.
  assert.equal(clearlyInView({ top: 40, bottom: 250 }, phone), false);
  assert.equal(clearlyInView({ top: PINNED.top - 1, bottom: 300 }, phone), false);
  assert.equal(clearlyInView({ top: PINNED.top, bottom: 300 }, phone), true);
  // In the middle of the screen: left alone.
  assert.equal(clearlyInView({ top: 320, bottom: 530 }, phone), true);
  // Above the screen altogether; taller than the room there is; a size that could not be measured.
  assert.equal(clearlyInView({ top: -300, bottom: -90 }, phone), false);
  assert.equal(clearlyInView({ top: 100, bottom: 100 + phone }, phone), false);
  for (const bad of [NaN, Infinity, 0, -1]) assert.equal(clearlyInView({ top: 300, bottom: 400 }, bad), false, String(bad));
  assert.equal(clearlyInView({ top: NaN, bottom: 400 }, phone), false);
  // The margins can be given: with nothing pinned, the screen's own edges are the limit.
  assert.equal(clearlyInView({ top: 0, bottom: phone }, phone, { top: 0, bottom: 0 }), true);
  assert.equal(clearlyInView({ top: 0, bottom: phone + 1 }, phone, { top: 0, bottom: 0 }), false);
});

const ACCOUNT = { accountId: "735420", connectionId: "c1", accNum: "735420", name: "Live", currency: "USD", environment: "live", server: "GENFX", connected: true, riskPct: 1, killed: false, EURUSD: false, GBPJPY: false, inScope: true };
const desk = (o: Record<string, unknown> = {}) => ({
  ok: true, owner: false,
  switches: { readable: true, scan: true, auto: true, scope: "all", billing: true, telegram: true },
  pairs: [{ key: "EURUSD", name: "EUR/USD", minStopPips: 10, costPips: 1, dec: 5 }, { key: "GBPJPY", name: "GBP/JPY", minStopPips: 20, costPips: 2, dec: 3 }],
  limits: { maxMinLotRiskPct: 5, maxLots: 50 },
  accounts: [ACCOUNT, { ...ACCOUNT, accountId: "2458284", accNum: "2458284", connectionId: "c2", environment: "demo", riskPct: null, EURUSD: true }],
  alerts: [], activity: [], ...o,
});

test("the section as it is first drawn: every account, a switch for each pair, nothing asked and nothing said yet", async () => {
  const { AutoTrade } = await import("../src/components/portal/floor/GenFxDesk");
  const html = renderToStaticMarkup(h(AutoTrade, { desk: desk() as never, reload: async () => {} }));
  for (const [label, on] of [["EUR/USD auto-trade on account 735420", false], ["GBP/JPY auto-trade on account 735420", false], ["EUR/USD auto-trade on account 2458284", true], ["GBP/JPY auto-trade on account 2458284", false]] as const) {
    const m = new RegExp(`<button type="button" role="switch" aria-checked="${on}" aria-label="${label}"[^>]*>`).exec(html);
    assert.ok(m, label);
    assert.ok(!m[0].includes(' disabled=""'), `${label} can be tapped`);
    assert.ok(!m[0].includes("ring-2"), `${label} is not ringed before it is tapped`);
  }
  assert.ok(!html.includes("Turn it on") && !html.includes('role="status"'), "no question open, nothing said");
  assert.ok(html.includes("ON · every account that switches it on"));
  // Nobody connected: told where to connect, and no switches.
  const none = renderToStaticMarkup(h(AutoTrade, { desk: desk({ accounts: [] }) as never, reload: async () => {} }));
  assert.ok(none.includes('No broker account connected yet. <a href="/portal/trading?view=flow"') && none.includes(">Connect one under FLOW</a>, then come back and switch a pair on."), "and the way there is a link");
  assert.ok(!none.includes('role="switch"'));
  // An account the owner's scope does not reach cannot be switched on (one already on can still be switched off).
  const out = renderToStaticMarkup(h(AutoTrade, { desk: desk({ switches: { readable: true, scan: true, auto: true, scope: "demo", billing: true, telegram: true }, accounts: [{ ...ACCOUNT, inScope: false }, { ...ACCOUNT, accountId: "9", accNum: "9", inScope: false, GBPJPY: true }] }) as never, reload: async () => {} }));
  assert.match(out, /aria-checked="false" aria-label="EUR\/USD auto-trade on account 735420" disabled=""/);
  assert.ok(!/aria-checked="true" aria-label="GBP\/JPY auto-trade on account 9" disabled/.test(out));
  assert.ok(out.includes("Not open for this account yet — GEN FX is on demo accounts first."));
});

test("what switching on costs is said where it is switched on — at the meter's own prices, and only while GEN FX is billed", async () => {
  const { AutoTrade } = await import("../src/components/portal/floor/GenFxDesk");
  const line = `Credits: ${SETUP_COST} when a setup you are switched on for starts forming, ${TRADE_COST} when a trade is placed — once per call, however many of your accounts take it. Nothing on the FLOW Pass. With fewer than ${TRADE_COST} credits the trade is skipped.`;
  assert.equal([SETUP_COST, TRADE_COST].join(), "1,5");
  const billed = renderToStaticMarkup(h(AutoTrade, { desk: desk() as never, reload: async () => {} }));
  assert.ok(billed.includes(line), "billing on");
  const free = renderToStaticMarkup(h(AutoTrade, { desk: desk({ switches: { readable: true, scan: true, auto: true, scope: "all", billing: false, telegram: true } }) as never, reload: async () => {} }));
  assert.ok(!free.includes("Credits:"), "billing off: it costs nothing, so nothing is said");
});

test("the question is brought into view, and what a switch did is said in that account's own card", () => {
  const src = code("src/components/portal/floor/GenFxDesk.tsx");
  const at = (s: string) => { const i = src.indexOf(s); assert.ok(i > 0, s); return i; };
  // The question's box is the one that is measured and scrolled to, when it opens.
  assert.match(src, /useEffect\(\(\) => \{\s*if \(!asking\) return;\s*const box = question\.current;\s*if \(!box \|\| clearlyInView\(box\.getBoundingClientRect\(\), window\.innerHeight\)\) return;\s*try \{ box\.scrollIntoView\(\{ block: "center", behavior: "smooth" \}\); \} catch \{ box\.scrollIntoView\(\); \}\s*\}, \[asking\]\);/);
  assert.ok(at("{ask && (") < at('<div ref={question} className="mt-2 rounded-lg border border-sky-400/30'));
  // The tapped switch is ringed while its question is open, and shows where it is going while that is saved.
  assert.ok(src.includes("on={moving && moving.pair === p.key ? moving.enabled : a[p.key]} waiting={!!ask && ask.pair === p.key}"));
  // Progress and outcome are inside the account's card: after its question, before the card closes.
  const card = src.slice(at("{accounts.map((a) => {"), at("<ul className=\"mt-3 space-y-1 text-[11.5px] leading-relaxed text-white/45\">"));
  assert.ok(card.includes('{moving && <p role="status"') && card.includes('{told && !moving && <p role="status"'));
  assert.ok(card.indexOf("{ask && (") < card.indexOf('{moving && <p role="status"'));
  // …and nothing about a switch is said under the whole list any more, where it could be a screen away.
  assert.ok(!/\{note && <p/.test(src) && !src.includes("setNote("));
  // What is said: the server's yes is said as it stands; its no, with its reason; and where its answer was
  // lost, what the switch itself now shows decides — the change may have gone through all the same.
  assert.match(src, /if \(t\.outcome === "refused"\) return \{ tone: "warn", text: t\.detail \|\| "Couldn't save that switch — try again\." \};\s*if \(a\[t\.pair\] === t\.wanted\) return \{ tone: "ok", text: `\$\{pairName\(t\.pair\)\} auto-trade is \$\{t\.wanted \? "ON" : "OFF"\} for #\$\{a\.accNum \?\? a\.accountId\}\.` \};\s*return t\.outcome === "lost" \? \{ tone: "warn", text: "Couldn't reach the server, so that switch may not have changed\. Check it, and try again\." \} : null;/);
  // …and the page is read again whether or not the server answered, so the switch drawn is the switch as it is.
  assert.match(src, /\} catch \{ \/\* no answer\.[^\n]*\*\/ \}\s*try \{ await reload\(\); \} catch \{[^\n]*\}\s*setSaid\(\{ key, pair, wanted: enabled, outcome, detail \}\);/);
});
