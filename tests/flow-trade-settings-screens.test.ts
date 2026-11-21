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

test("the phone app says exactly what the site says: it frames the site (owner 11-21)", () => {
  // The installed app no longer carries its own copy of FLOW's trade settings; it shows the site's own screen.
  assert.match(app, /<iframe id="om-app"/);
  assert.ok(!/MG_BE|mgSummary|function GxBrokerConnect/.test(app), "no second copy of the settings to drift");
  assert.ok(/<TradeManagement /.test(site), "the one screen both now show");
});

test("the one 'AI Pips' switch is gone from FLOW on both screens (the ATLAS profile keeps its own)", () => {
  assert.ok(!/🎯 AI Pips/.test(site), "site account card");
  assert.ok(!/setAccountAiPips|setAccountGoldBePips|setAccountManage\b/.test(site), "the old handlers are gone");
  assert.ok(/<TradeManagement /.test(site));
  // The phone shows the site's own screen (the installed app frames the site), so the same holds there.
  assert.ok(!/AI Pips/.test(app), "no phone copy of the switch");
});

test("both screens send one request, action 'management', with only the changed setting", () => {
  assert.match(site, /action: "management", accountId: a\.accountId, connectionId: a\.connectionId, \.\.\.change/);
  // The phone sends exactly this request too: it is the site's own screen, inside the installed app's frame.
  assert.match(app, /<iframe id="om-app"/);
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
