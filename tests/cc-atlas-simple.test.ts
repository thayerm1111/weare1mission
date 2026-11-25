import test from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SimplePlan } from "../src/components/command-center/hud/SimplePlan";
import type { AtlasIdea } from "../command-center/engines/idea";
import type { TradeStateView } from "../src/components/command-center/TradePanel";

(globalThis as unknown as { React: typeof React }).React = React;
const NOW = Date.parse("2026-11-25T15:05:00Z");
const idea = (change: Partial<AtlasIdea> = {}): AtlasIdea => ({
  at: NOW - 60_000, expiresAt: NOW + 60_000, side: "buy", kind: "enter_now", headline: "Gold buy plan",
  entry: { type: "market", price: 3550.4, low: 3549.7, high: 3550.4, level: null, trigger: "A closed candle above 3550.40", confirm: "close_15m", text: "At the recorded price", distancePips: 0 },
  stop: { price: 3541.2, pips: 92, what: "Confirmed swing low" },
  targets: [{ label: "TP1", price: 3568.8, pips: 184, r: 2, basis: "measured", what: "Two times the risk" }],
  waitingFor: [], warnings: ["Watch the next scheduled release."],
  invalidation: { text: "A close below the confirmed swing low", price: 3541.2 },
  execute: { now: true, via: "manual", note: "Valid when generated", approved: null, manual: null },
  ...change,
} as AtlasIdea);
const position = (change: Partial<TradeStateView> = {}): TradeStateView => ({
  active: true, side: "sell", entry: 3548.1, stop: 3554.9, takeProfit: 3533.6, unmanaged: [], ...change,
} as TradeStateView);
const html = (change: Partial<React.ComponentProps<typeof SimplePlan>> = {}) => renderToStaticMarkup(React.createElement(SimplePlan, {
  idea: null, trade: null, now: NOW, replay: false, readUnavailable: false, onReview: () => {}, onManage: () => {}, ...change,
}));

test("a generated plan shows its original levels, condition and invalidation without treating execute.now as current permission", () => {
  const out = html({ idea: idea() });
  for (const text of ["Recorded buy plan", "3,549.70 – 3,550.40", "3,541.20", "3,568.80", "Risk projection", "A closed candle above 3550.40", "A close below the confirmed swing low", "Watch the next scheduled release.", "not a current entry instruction", "Review plan"]) assert.ok(out.includes(text), text);
  assert.doesNotMatch(out, /Enter now|Trade ready|Execute|Place order/);
});

test("expired or unavailable reads retain evidence and make the stale status visible", () => {
  const expired = html({ idea: idea({ expiresAt: NOW }), readUnavailable: true });
  assert.match(expired, /This plan has expired/);
  assert.ok(expired.includes("3,541.20"), "the original stop is preserved as evidence");
  const unavailable = html({ idea: idea(), readUnavailable: true });
  assert.match(unavailable, /market read is not current/);
  assert.match(unavailable, /recorded levels, pending a fresh review/);
});

test("an active position takes precedence over an unrelated generated idea and keeps management available after a read failure", () => {
  const out = html({ idea: idea(), trade: position(), readUnavailable: true });
  for (const text of ["Open sell position", "Manage position", "3,548.10", "3,554.90", "3,533.60", "Position controls remain available", "adjust protection, reduce size or close"]) assert.ok(out.includes(text), text);
  assert.ok(!out.includes("3,568.80"), "a different idea's target cannot become this position's target");
});

test("an empty or stand-aside result never fabricates entry levels", () => {
  assert.match(html(), /Generate a gold signal/);
  const out = html({ idea: idea({ kind: "stand_aside", side: null, entry: null, stop: null, targets: [], headline: "No confirmed structure is available." }) });
  assert.match(out, /No entry plan/);
  assert.match(out, /No confirmed structure is available/);
  assert.doesNotMatch(out, /<dt>Entry|<dt>Stop loss|<dt>TP1/);
});

test("untracked positions retain their review action in the simplified view", () => {
  const out = html({ trade: position({ active: false, unmanaged: [{ brokerPositionId: "recorded-position", side: "sell", qty: 0.1, entry: 3550 }] }) });
  assert.match(out, /Review 1 untracked gold position/);
});

test("recorded replay positions and generated ideas keep their replay identity", () => {
  assert.match(html({ trade: position(), replay: true }), /Recorded sell position/);
  const out = html({ idea: idea(), replay: true });
  assert.match(out, /Replay/);
  assert.doesNotMatch(out, /Open buy position|Live plan/);
});
