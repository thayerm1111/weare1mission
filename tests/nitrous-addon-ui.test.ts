import test from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NitrousAddonPanel } from "../src/components/om/nitrous/NitrousAddonPanel";
import type { NitrousAddonAccess } from "../src/lib/nitrous/addon-policy";

(globalThis as unknown as { React: typeof React }).React = React;
const locked: NitrousAddonAccess = { entitled: false, source: null, adminGranted: false, priceUsd: 19.99, interval: "month", subscription: null };
function panel(addon: NitrousAddonAccess | null, change: Partial<React.ComponentProps<typeof NitrousAddonPanel>> = {}) {
  return renderToStaticMarkup(React.createElement(NitrousAddonPanel, { addon, loading: false, unavailable: false, onUpdated: async () => {}, ...change }));
}

test("a locked member sees the exact monthly add-on price and no implied trading activation", () => {
  const html = panel(locked);
  assert.match(html, /Add Nitrous · \$19\.99\/month/);
  assert.match(html, /Renews monthly/);
  assert.match(html, /Included when granted by your admin/);
  assert.match(html, /Purchasing access does not turn on trading/);
  assert.doesNotMatch(html, /Turn on auto trading|Cancel renewal/);
});

test("complimentary access removes the purchase action and identifies the admin grant", () => {
  const html = panel({ ...locked, entitled: true, source: "admin", adminGranted: true });
  assert.match(html, /Your access is included/);
  assert.match(html, /no add-on charge/);
  assert.doesNotMatch(html, /Add Nitrous ·|Cancel renewal/);
});

test("paid members can see their renewal state and a scoped cancellation control", () => {
  const paid: NitrousAddonAccess = { ...locked, entitled: true, source: "subscription", subscription: { status: "active", cancelAtPeriodEnd: false, currentPeriodEnd: "2026-12-25T22:00:00Z" } };
  assert.match(panel(paid), /Cancel renewal/);
  assert.doesNotMatch(panel(paid), /Add Nitrous ·/);
  const canceled = panel({ ...paid, subscription: { ...paid.subscription!, cancelAtPeriodEnd: true } });
  assert.match(canceled, /Renewal canceled/);
  assert.match(canceled, /Access continues through/);
  assert.doesNotMatch(canceled, /Cancel renewal/);
});

test("unknown entitlement disables checkout while retaining a refresh path", () => {
  const html = panel(null, { unavailable: true });
  assert.match(html, /Access check unavailable\. Refresh to retry/);
  assert.match(html, /Existing account controls remain available/);
  assert.match(html, /disabled=""[^>]*>.*?Add Nitrous · \$19\.99\/month/);
  assert.match(html, /Refresh access/);
});
