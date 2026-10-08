/*
 * THE TWO SCREENS FOR THE THREE TRADE SETTINGS (owner 10-08): the FLOW page on the site and the phone app's
 * broker screen. They must say the same thing, offer the same choices, send the same request, and show at
 * once what the server will answer.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as copy from "../src/lib/flow/manageCopy";
import { applyMgmtPatch, mgmtView, backfilled, FOLLOW_MODES, BE_PIPS_CHOICES, PARTIAL_CHOICES, type MgmtRow, type FollowMode, type PartialPct } from "../src/lib/flow/manageSettings";
import { optimisticMgmt, type MgmtChange } from "../src/components/portal/floor/TradeManagement";

const app = readFileSync("public/app/index.html", "utf8");
const site = readFileSync("src/components/portal/floor/FlowConnect.tsx", "utf8");

/** The phone app's own helpers, run as the app runs them. */
function phoneHelpers(): { MG_BE: number[]; MG_COPY: any; mgBeLine: (on: boolean, p: number) => string; mgFollowLine: (m: string, be: boolean) => string; mgSummary: (a: any) => string } {
  const start = app.indexOf("  var MG_BE = [");
  const end = app.indexOf("\n  }\n", app.indexOf("  function mgSummary(a) {")) + 4;
  assert.ok(start > 0 && end > start, "the phone app defines its trade-settings helpers");
  return new Function(`${app.slice(start, end)}; return { MG_BE, MG_COPY, mgBeLine, mgFollowLine, mgSummary };`)();
}

test("the phone app says exactly what the site says", () => {
  const p = phoneHelpers();
  assert.deepEqual(p.MG_BE, [...BE_PIPS_CHOICES]);
  assert.equal(p.MG_COPY.title, copy.MGMT_TITLE);
  assert.equal(p.MG_COPY.applies, copy.MGMT_APPLIES);
  assert.equal(p.MG_COPY.unread, copy.MGMT_UNREAD);
  for (const on of [true, false]) for (const pips of [10, 20, 30, 35, 40, 50, 100]) assert.equal(p.mgBeLine(on, pips), copy.beLine(on, pips));
  for (const m of FOLLOW_MODES) for (const be of [true, false]) assert.equal(p.mgFollowLine(m, be), copy.followLine(m, be), `${m}/${be}`);
  for (const pct of PARTIAL_CHOICES) assert.equal(p.MG_COPY.partials[pct], copy.PARTIAL_LINES[pct]);
  const shapes = [
    { beEnabled: true, breakEvenPips: 30, followPrice: "normal", followActive: true, partialPct: 0 },
    { beEnabled: true, breakEvenPips: 10, followPrice: "tight", followActive: true, partialPct: 50 },
    { beEnabled: false, breakEvenPips: 30, followPrice: "loose", followActive: false, partialPct: 25 },
    { beEnabled: true, breakEvenPips: 40, followPrice: "off", followActive: false, partialPct: 0 },
    { settingsUnread: true },
  ] as const;
  for (const a of shapes) assert.equal(p.mgSummary(a), copy.mgmtSummary(a));
});

test("the one 'AI Pips' switch is gone from FLOW on both screens (the ATLAS profile keeps its own)", () => {
  assert.ok(!/🎯 AI Pips/.test(site), "site account card");
  assert.ok(!/setAccountAiPips|setAccountGoldBePips|setAccountManage\b/.test(site), "the old handlers are gone");
  assert.ok(/<TradeManagement /.test(site));
  const broker = app.slice(app.indexOf("function GxBrokerConnect(props)"), app.indexOf("function GxBrokerConnect(props)") + 40000);
  assert.ok(!/🎯 AI Pips/.test(broker), "phone broker screen");
  assert.ok(!/function setAiPips|function setBe\(|function setPartials\(|function setGuard\(|function setGoldBe\(/.test(app), "the old phone handlers are gone");
  assert.ok(!/>AI Pips<\/button>/.test(app), "phone home: no AI Pips switch");
  assert.ok(/toggle\("AI Pips"/.test(app), "the ATLAS trading profile's own switch is untouched");
});

test("both screens send one request, action 'management', with only the changed setting", () => {
  assert.match(site, /action: "management", accountId: a\.accountId, connectionId: a\.connectionId, \.\.\.change/);
  assert.match(app, /Object\.assign\(\{ action: "management", accountId: a\.accountId, connectionId: a\.connectionId \}, change\)/);
  // the phone sends breakEven / followPrice / partials, the names the server reads
  assert.match(app, /setMgmt\(a, \{ breakEven: "off" \}\)/);
  assert.match(app, /setMgmt\(a, \{ breakEven: p \}\)/);
  assert.match(app, /setMgmt\(a, \{ followPrice: m \}\)/);
  assert.match(app, /setMgmt\(a, \{ partials: p \}\)/);
});

test("what the site shows at once is what the server answers", () => {
  const starts: MgmtRow[] = [
    backfilled({ manage_trades: true, gold_be_pips: null }),
    backfilled({ manage_trades: true, gold_be_pips: 10 }),
    backfilled({ manage_trades: false, gold_be_pips: 35 }),
    { manage_trades: true, be_enabled: false, trail_mode: "tight", partial_pct: 50, gold_be_pips: 20 },
  ];
  const changes: MgmtChange[] = [
    ...([...BE_PIPS_CHOICES, "off"] as const).map((b) => ({ breakEven: b as "off" | number })),
    ...FOLLOW_MODES.map((f) => ({ followPrice: f as FollowMode })),
    ...PARTIAL_CHOICES.map((p) => ({ partials: p as PartialPct })),
  ];
  const keys = ["manageTrades", "beEnabled", "breakEvenPips", "followPrice", "followActive", "partialPct", "partialsEnabled", "profitGuard"] as const;
  for (const row of starts) for (const c of changes) {
    const shown = optimisticMgmt(mgmtView(row), c) as Record<string, unknown>;
    const patch = { ...(c.breakEven !== undefined ? { breakEven: c.breakEven } : {}), ...(c.followPrice ? { follow: c.followPrice } : {}), ...(c.partials !== undefined ? { partials: c.partials } : {}) };
    const saved = mgmtView({ ...row, ...applyMgmtPatch(row, patch) }) as Record<string, unknown>;
    for (const k of keys) assert.deepEqual(shown[k], saved[k], `${JSON.stringify(row)} + ${JSON.stringify(c)}: ${k}`);
  }
});

test("the site's settings block, drawn: the account's own choices pressed, and nothing to press when its settings could not be read", async () => {
  const React = await import("react");
  const { createElement } = React;
  (globalThis as any).React = React;              // the test runner compiles JSX the classic way
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { TradeManagement } = await import("../src/components/portal/floor/TradeManagement");
  const draw = (a: Record<string, unknown>) => renderToStaticMarkup(createElement(TradeManagement, { a, busy: false, error: "", onChange: () => {} }));
  const pressed = (html: string) => [...html.matchAll(/aria-pressed="true" aria-label="([^"]+)"/g)].map((m) => m[1]);
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
  // AI Pips on, as every account starts
  assert.deepEqual(pressed(draw(mgmtView(backfilled({ manage_trades: true, gold_be_pips: null })))), ["Break-even 30 pips", "Follow price Normal", "Partials off"]);
  // an older number of its own shows as its own button, pressed
  assert.deepEqual(pressed(draw(mgmtView(backfilled({ manage_trades: true, gold_be_pips: 10 })))), ["Break-even 10 pips (your current setting)", "Follow price Normal", "Partials off"]);
  // break-even off: follow price is shown but cannot be pressed, and says why
  const off = draw(mgmtView({ manage_trades: true, be_enabled: false, trail_mode: "tight", partial_pct: 50 }));
  assert.deepEqual(pressed(off), ["Break-even off", "Follow price Tight", "Bank 50% halfway to target"]);
  assert.match(off, /aria-label="Follow price Normal"[^>]*disabled=""|disabled=""[^>]*aria-label="Follow price Normal"/);
  assert.ok(off.includes(esc(copy.FOLLOW_NEEDS_BE)));
  // settings that could not be read: the line, and no buttons
  const unread = draw({ settingsUnread: true });
  assert.ok(unread.includes(esc(copy.MGMT_UNREAD)));
  assert.ok(!/<button/.test(unread));
});
