import test from "node:test";
import assert from "node:assert/strict";
import { accountIsActive, money, validAnalyze } from "../src/components/om/nitrous/presentation";
import { activeKey, activeTabKey, NAV } from "../src/lib/floor/nav";
import type { NitrousAccount, NitrousStatus } from "../src/lib/nitrous/types";

const NOW = Date.parse("2026-11-25T22:00:00Z");
function fixture() {
  const account: NitrousAccount = {
    id: "member-account", accountId: "member-account", connectionId: "connection", name: "Test account", environment: "live",
    masked: "••••1234", accountMasked: "••••1234", currency: "USD", balance: 500, equity: 500,
    equityAt: new Date(NOW - 5_000).toISOString(), balanceAt: new Date(NOW - 5_000).toISOString(), mode: "slow_drip",
    riskPct: 0.5, plannedRisk: 2.5, dailyLossPct: 3, automationEnabled: true, managementEnabled: true,
    state: "active", blockers: [], resolvedSymbol: "XAUUSD", positions: [],
    stats: { wins: 0, losses: 0, flat: 0, closed: 0, unresolved: 0, netPnl: null, recordedPnl: null, grossPnl: null, winningPnl: null, pnlVerified: false, verifiedClosed: 0, period: "all_time", basis: "recorded_realised_pnl" },
  };
  const status: NitrousStatus = { available: true, serverTime: new Date(NOW).toISOString(), accounts: [account],
    worker: { healthy: true, lastBeatAt: new Date(NOW - 5_000).toISOString(), ageMs: 5_000 },
    control: { mode: "live", entriesPaused: false, pauseReason: null }, telegram: { configured: false, url: null, name: "Nitrous" }, profiles: [], consentVersion: "nitrous-consent-v1" };
  return { status, account };
}

test("Nitrous glow requires a fresh armed account and healthy execution service", () => {
  const { status, account } = fixture();
  assert.equal(accountIsActive(status, account, NOW, NOW), true);
  account.automationEnabled = false;
  assert.equal(accountIsActive(status, account, NOW, NOW), false, "connecting must not imply trading");
  account.automationEnabled = true; status.worker.healthy = false;
  assert.equal(accountIsActive(status, account, NOW, NOW), false);
  status.worker.healthy = true; status.control.entriesPaused = true;
  assert.equal(accountIsActive(status, account, NOW, NOW), false);
});
test("cached account state loses its active glow on network errors or stale data", () => {
  const { status, account } = fixture();
  assert.equal(accountIsActive(status, account, NOW, NOW + 46_000), false);
  assert.equal(accountIsActive(status, account, NOW, NOW, "network failed"), false);
  status.worker.lastBeatAt = new Date(NOW - 55_000).toISOString();
  assert.equal(accountIsActive(status, account, NOW, NOW + 10_000), false, "worker freshness must age between polls");
  status.worker.lastBeatAt = new Date(NOW - 5_000).toISOString();
  account.equityAt = new Date(NOW - 121_000).toISOString();
  assert.equal(accountIsActive(status, account, NOW, NOW), false);
  account.equityAt = new Date(NOW).toISOString(); account.blockers = ["Earlier order needs reconciliation"];
  assert.equal(accountIsActive(status, account, NOW, NOW), false);
});
test("unknown money stays unknown; zero is a valid broker value", () => {
  assert.equal(money(null), "—"); assert.equal(money(NaN), "—"); assert.equal(money(0), "$0.00");
});
test("invalid market geometry is refused before chart rendering", () => {
  assert.equal(validAnalyze({ available: true, stale: false, bars: [{ t: NOW, o: 4000, h: 3990, l: 3980, c: 4001 }], flow: [], scenarios: [], health: { state: "ok", reasons: [] } }), false);
});
test("Nitrous has a canonical dock destination and stays within Tools on legacy tabs", () => {
  assert.equal(activeKey("/portal/nitrous", null), "nitrous");
  assert.equal(activeKey("/portal/nitrous/", null), "nitrous");
  assert.equal(activeTabKey("/portal/nitrous", null), "tools");
  assert.equal(NAV.find(item => item.key === "nitrous")?.href, "/portal/nitrous");
});
