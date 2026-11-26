import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  hasAggressiveConsent, hasFastConsent, hasNitrousConsent, hasSweepConsent, NITROUS_AGGRESSIVE_CONSENT_VERSION, NITROUS_CONSENT_VERSION, NITROUS_FAST_CONSENT_VERSION,
  NITROUS_SETUP_CONFIGS, NITROUS_SWEEP_CONSENT_VERSION, setupAuthorized, setupCapability, validateSettingsChange,
} from "../src/lib/nitrous/policy";
import { publicNitrousScenario } from "../src/lib/nitrous/scenarios";
import { getNitrousStatus } from "../src/lib/nitrous/server";
import { NITROUS_AGGRESSIVE_CONFIG, NITROUS_CONFIG, NITROUS_FAST_CONFIG, NITROUS_SWEEP_CONFIG } from "../nitrous/config";

const NOW = Date.UTC(2026, 10, 26, 6);
const v1 = NITROUS_CONSENT_VERSION, v2 = NITROUS_FAST_CONSENT_VERSION, v3 = NITROUS_SWEEP_CONSENT_VERSION, v4 = NITROUS_AGGRESSIVE_CONSENT_VERSION;
const configs = NITROUS_SETUP_CONFIGS;

test("strategy authorizations are cumulative and scoped to the chosen account mode", () => {
  assert.equal(v3, "nitrous-consent-v3-sweep");
  for (const consent of [v1, v2, v3, v4]) {
    assert.equal(hasNitrousConsent(consent), true);
    for (const mode of ["slow_drip", "nitrous"]) {
      for (const family of ["trend_pullback", "break_retest"]) {
        assert.equal(setupAuthorized(configs.baseline, family, mode, consent), true);
      }
    }
    assert.equal(hasFastConsent(consent), consent !== v1);
    assert.equal(hasSweepConsent(consent), consent === v3 || consent === v4);
    assert.equal(hasAggressiveConsent(consent), consent === v4);
    for (const family of ["trend_pullback", "break_retest", "range_reaction"]) {
      assert.equal(setupAuthorized(configs.fast, family, "nitrous", consent), consent !== v1);
      assert.equal(setupAuthorized(configs.fast, family, "slow_drip", consent), false);
    }
    assert.equal(setupAuthorized(configs.sweep, "sweep_reclaim", "nitrous", consent), consent === v3 || consent === v4);
    assert.equal(setupAuthorized(configs.sweep, "sweep_reclaim", "slow_drip", consent), false);
    for (const family of ["range_edge_rejection", "compression_breakout"]) {
      assert.equal(setupAuthorized(configs.aggressive, family, "nitrous", consent), consent === v4);
      assert.equal(setupAuthorized(configs.aggressive, family, "slow_drip", consent), false);
      for (const old of [configs.baseline, configs.fast, configs.sweep]) assert.equal(setupCapability(old, family), null);
    }
  }
});

test("only exact supported configuration and family combinations are classified or authorized", () => {
  assert.deepEqual(configs, { baseline: NITROUS_CONFIG.configVersion, fast: NITROUS_FAST_CONFIG.configVersion,
    sweep: NITROUS_SWEEP_CONFIG.configVersion, aggressive: NITROUS_AGGRESSIVE_CONFIG.configVersion }, "authorization versions must match the generated strategy configurations");
  assert.equal(setupCapability(configs.baseline, "trend_pullback"), "baseline");
  assert.equal(setupCapability(configs.fast, "range_reaction"), "fast");
  assert.equal(setupCapability(configs.sweep, "sweep_reclaim"), "sweep");
  for (const [config, family] of [
    [configs.baseline, "sweep_reclaim"], [configs.fast, "sweep_reclaim"], [configs.sweep, "break_retest"],
    [configs.aggressive, "sweep_reclaim"], [configs.aggressive, "momentum"], [configs.baseline, "range_reaction"], [configs.fast, "momentum"], [configs.sweep, "__proto__"],
    [`${configs.sweep}.unknown`, "sweep_reclaim"], ["invented+fast.2", "range_reaction"], [null, "sweep_reclaim"],
    [configs.sweep, null], [configs.sweep, undefined],
  ]) {
    assert.equal(setupCapability(config, family), null);
    assert.equal(setupAuthorized(config, family, "nitrous", v3), false);
  }
  for (const consent of [null, undefined, "", "nitrous-consent-v4", true]) {
    assert.equal(hasNitrousConsent(consent), false);
    assert.equal(setupAuthorized(configs.baseline, "trend_pullback", "nitrous", consent), false);
    assert.equal(setupAuthorized(configs.sweep, "sweep_reclaim", "nitrous", consent), false);
  }
  assert.equal(setupAuthorized(configs.baseline, "break_retest", "unknown", v3), false);
});

test("an armed account can explicitly add sweep consent at its existing mode and risk", () => {
  const account = { profile: "nitrous", risk_pct: 3, automation_enabled: true, consent_version: v2 };
  const confirmation = { mode: "nitrous", riskPct: 3, automationEnabled: true, acknowledgedRisk: true, consentVersion: v3 };
  const approved = validateSettingsChange(account, confirmation, true);
  assert.equal(approved.ok, true);
  if (approved.ok) {
    assert.equal(approved.arming, true);
    assert.equal(approved.patch.consent_version, v3);
    assert.equal(approved.patch.automation_enabled, true);
    assert.equal(approved.patch.profile, account.profile);
    assert.equal(approved.patch.risk_pct, account.risk_pct);
    assert.ok(Number.isFinite(Date.parse(String(approved.patch.consented_at))));
  }
  for (const patch of [
    { acknowledgedRisk: false }, { mode: undefined }, { riskPct: undefined }, { riskPct: 5 },
    { mode: "slow_drip", riskPct: 0.5 }, { consentVersion: "nitrous-consent-v3-sweep-extra" },
  ]) assert.equal(validateSettingsChange(account, { ...confirmation, ...patch }, true).ok, false);
  assert.equal(validateSettingsChange(account, confirmation, false).ok, false);
  const slow = { profile: "slow_drip", risk_pct: 0.5, automation_enabled: false };
  assert.equal(validateSettingsChange(slow, { ...confirmation, mode: "slow_drip", riskPct: 0.5 }, true).ok, false);
  const saved = validateSettingsChange(account, { mode: "nitrous", riskPct: 3, consentVersion: v3 }, true);
  assert.equal(saved.ok, true);
  if (saved.ok) {
    assert.equal(saved.patch.consent_version, undefined);
    assert.equal(saved.patch.consented_at, undefined);
    assert.equal(saved.patch.automation_enabled, undefined);
  }
  const paused = validateSettingsChange(account, { automationEnabled: false }, false);
  assert.deepEqual(paused, { ok: true, arming: false, patch: { automation_enabled: false } });
});

const evidence = {
  pivotId: "low:M5:example", pivotKind: "low", pivotPrice: 4200, pivotTime: NOW - 1_800_000,
  pivotKnownAt: NOW - 1_200_000, candleOpenedAt: NOW - 360_000, candleClosedAt: NOW - 60_000,
  candleOpen: 4201, candleHigh: 4203, candleLow: 4198, candleClose: 4202,
  sweepExtreme: 4198, confirmationThreshold: 4200,
};
const scenario = {
  setupId: "nitrous:sweep-example", family: "sweep_reclaim", side: "buy", timeframe: "M5", state: "armed",
  configVersion: configs.sweep, entryBandLow: 4201, entryBandHigh: 4203, refEntry: 4202,
  stop: 4197, target: 4212, stopUsd: 5, targetUsd: 10, invalidation: 4198, expiresAt: NOW + 240_000,
  conditionsMet: ["A completed sweep and reclaim."], conditionsPending: ["Broker price and risk must qualify."], sweepEvidence: evidence,
};

test("analysis exposes a Nitrous-only sweep with only declared public evidence fields", () => {
  const result = publicNitrousScenario({ ...scenario, account_id: "private", token: "private",
    sweepEvidence: { ...evidence, user_id: "private", brokerAccountId: "private" } }, NOW, false);
  assert.ok(result);
  assert.equal(result.profile, "nitrous");
  assert.equal(result.capability, "sweep");
  assert.deepEqual(result.sweepEvidence, evidence);
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.equal(publicNitrousScenario({ ...scenario, configVersion: "invented+fast.2" }, NOW, false), null);
  assert.equal(publicNitrousScenario({ ...scenario, configVersion: configs.fast }, NOW, false), null);
  assert.equal(publicNitrousScenario({ ...scenario, sweepEvidence: undefined }, NOW, false), null);
  for (const changed of [
    { pivotKnownAt: evidence.candleOpenedAt + 1 }, { candleClosedAt: NOW + 1 }, { candleClosedAt: evidence.candleClosedAt - 1 },
    { candleHigh: 4197 }, { candleLow: 4204 }, { candleClose: NaN }, { pivotKind: "high" },
  ]) assert.equal(publicNitrousScenario({ ...scenario, sweepEvidence: { ...evidence, ...changed } }, NOW, false), null);
  assert.equal(publicNitrousScenario(scenario, NOW, true)?.state, "stale");
  assert.equal(publicNitrousScenario(scenario, scenario.expiresAt, false)?.state, "expired");
  assert.equal(publicNitrousScenario({ ...scenario, family: "trend_pullback", configVersion: configs.baseline }, NOW, false)?.profile, "both");
  const fast = publicNitrousScenario({ ...scenario, family: "range_reaction", configVersion: configs.fast }, NOW, false);
  assert.equal(fast?.profile, "nitrous");
  assert.equal(fast?.sweepEvidence, undefined);
});

function statusFixture() {
  const at = new Date().toISOString();
  const definitions = [
    { id: "baseline", profile: "nitrous", consent_version: v1 },
    { id: "fast", profile: "nitrous", consent_version: v2 },
    { id: "sweep", profile: "nitrous", consent_version: v3 },
    { id: "aggressive", profile: "nitrous", consent_version: v4 },
    { id: "slow", profile: "slow_drip", consent_version: v3 },
  ];
  const rows = definitions.map(a => ({ ...a, user_id: "member", connection_id: "connection", broker_account_id: "demo-1234",
    environment: "demo", status: "linked", automation_enabled: true, management_enabled: true,
    risk_pct: a.profile === "nitrous" ? 3 : 0.5, equity: 500, equity_at: at, instrument_spec: { contractSize: 100 },
    consented_at: at, spec_missing: [], ownership_check: { ok: true, checkedAt: at } }));
  const journalFilters: Array<[string, unknown]> = [];
  const tables: Record<string, unknown> = {
    nitrous_accounts: rows, nitrous_broker_connections: [{ id: "connection", status: "connected" }],
    nitrous_control: { mode: "live", entries_paused: false }, nitrous_heartbeat: { at, info: { state: "ok" } },
    nitrous_positions: [], nitrous_intents: [], nitrous_telegram_settings: null, nitrous_journal: null,
    nitrous_addon_grants: [{ user_id: "member", active: true }], nitrous_addon_subscriptions: [],
  };
  const admin = {
    from(table: string) {
      assert.ok(Object.hasOwn(tables, table), `Unexpected table ${table}`);
      const result = Promise.resolve({ data: tables[table], error: null });
      const query = { select: () => query, eq: (k: string, v: unknown) => {
        if (table === "nitrous_journal") journalFilters.push([k, v]);
        return query;
      }, neq: () => query, order: () => query, limit: () => query,
        in: () => query, range: () => query, maybeSingle: () => query, then: result.then.bind(result) };
      return query;
    },
    rpc: async (name: string) => { assert.equal(name, "nitrous_account_stats"); return { data: [], error: null }; },
  } as unknown as Parameters<typeof getNitrousStatus>[0];
  return { admin, at, tables, journalFilters };
}

test("status preserves fast permission for v3 and exposes sweep only on the authorized Nitrous account", async () => {
  const { admin } = statusFixture();
  const status = await getNitrousStatus(admin, "member", true);
  assert.deepEqual(status.accounts.map(a => [a.id, a.fastStrategyEnabled, a.sweepStrategyEnabled, a.aggressiveStrategyEnabled]), [
    ["baseline", false, false, false], ["fast", true, false, false], ["sweep", true, true, false],
    ["aggressive", true, true, true], ["slow", false, false, false],
  ]);
  assert.ok(status.accounts.every(a => a.automationEnabled));
  assert.equal(status.consentVersion, v1, "existing top-level baseline consent contract is retained");
});

test("only the selected owned account gets a dated journal observation for its current authorization", async () => {
  const { admin, at, tables, journalFilters } = statusFixture();
  const reason = "Waiting for broker price to enter the setup's entry range.";
  tables.nitrous_journal = { at, reason, decision: "wait", evidence: { private: true } };
  for (const id of [undefined, "unowned"]) {
    const status = await getNitrousStatus(admin, "member", true, id);
    assert.ok(status.accounts.every(a => !a.lastEntryCheck));
  }
  assert.deepEqual(journalFilters, []);
  const status = await getNitrousStatus(admin, "member", true, "sweep");
  assert.deepEqual(journalFilters, [["user_id", "member"], ["account_id", "sweep"], ["stage", "entry"]]);
  assert.deepEqual(status.accounts.filter(a => a.lastEntryCheck).map(a => [a.id, a.lastEntryCheck]), [["sweep", { at, reason }]]);
  for (const last of [{ at, decision: "protected", reason }, { at: "2000-01-01T00:00:00Z", decision: "skip", reason }, null]) {
    tables.nitrous_journal = last;
    const refreshed = await getNitrousStatus(admin, "member", true, "");
    assert.ok(refreshed.accounts.every(a => !a.lastEntryCheck));
    assert.equal(refreshed.accounts.length, status.accounts.length);
  }
});

function functionBody(sql: string, name: string): string {
  const index = sql.toLowerCase().indexOf(`function public.${name}(`);
  assert.ok(index >= 0, name);
  const match = sql.slice(index).match(/\bas\s+\$(\w*)\$([\s\S]*?)\$\1\$/i);
  assert.ok(match, name);
  return match[2];
}
const compact = (s: string) => s.replace(/\s+/g, " ").trim();

test("sweep migration preserves installed reservation and settings semantics outside capability authorization", () => {
  const previous = readFileSync("scripts/sql/nitrous-fast-profile.sql", "utf8");
  const migration = readFileSync("scripts/sql/nitrous-sweep-profile.sql", "utf8");
  const settings = functionBody(migration, "nitrous_apply_settings");
  const previousSettings = functionBody(previous, "nitrous_apply_settings");
  assert.equal(compact(settings.replace(
    "in ('nitrous-consent-v2-fast','nitrous-consent-v3-sweep')", "= 'nitrous-consent-v2-fast'")), compact(previousSettings));

  const reservation = functionBody(migration, "nitrous_reserve_intent");
  const previousReservation = functionBody(previous, "nitrous_reserve_intent");
  const oldGuard = previousReservation.slice(previousReservation.indexOf("  if p_config ="), previousReservation.indexOf("  if not exists (select 1 from public.nitrous_control"));
  const guardStart = reservation.indexOf("  -- This exact config/family/capability allowlist");
  const guardEnd = reservation.indexOf("  if not exists (select 1 from public.nitrous_control");
  assert.ok(guardStart > 0 && guardEnd > guardStart);
  const restored = (reservation.slice(0, guardStart) + oldGuard + reservation.slice(guardEnd))
    .replace("not in ('nitrous-consent-v1','nitrous-consent-v2-fast','nitrous-consent-v3-sweep')", "not in ('nitrous-consent-v1','nitrous-consent-v2-fast')");
  assert.equal(compact(restored), compact(previousReservation), "ownership, leases, entitlement, risk, exposure and journaling stay intact");

  const guard = reservation.slice(guardStart, guardEnd);
  for (const config of [configs.baseline, configs.fast, configs.sweep]) assert.ok(guard.includes(`p_config = '${config}'`));
  assert.ok(guard.includes("p_family = 'sweep_reclaim'"));
  assert.ok(guard.includes("v_account.consent_version = 'nitrous-consent-v3-sweep'"));
  assert.ok(guard.includes("p_family in ('trend_pullback','break_retest')"));
  assert.ok(guard.includes("p_family in ('trend_pullback','break_retest','range_reaction')"));
  assert.equal((guard.match(/v_account\.profile = 'nitrous'/g) ?? []).length, 2);
  assert.ok(guard.includes("if not coalesce((") && guard.includes("), false) then"), "unknown/null capability inputs are denied");
  assert.match(guard, /return query[\s\S]*?;\s*return;\s*end if;/);
  assert.ok(migration.includes("check (family in ('range_reaction','break_retest','trend_pullback','momentum','sweep_reclaim'))"));
  const outsideFunctions = migration.replace(/CREATE OR REPLACE FUNCTION[\s\S]*?\$function\$;/g, "");
  assert.equal(/\b(?:update|insert\s+into|delete\s+from)\s+(?:public\.)?nitrous_accounts\b/i.test(outsideFunctions), false);
  assert.ok(outsideFunctions.includes("from public,anon,authenticated"));
  assert.ok(outsideFunctions.includes("to service_role"));
  assert.ok(migration.trimEnd().endsWith("commit;"));
});

test("v4 requires a fresh account-specific activation at the selected risk and can be revoked in place", () => {
  const active = { profile: "nitrous", risk_pct: 3, automation_enabled: true, consent_version: v3 };
  const review = { mode: "nitrous", riskPct: 3, automationEnabled: true, consentVersion: v4, acknowledgedRisk: true };
  for (const consentVersion of [v3, v4]) {
    const change = validateSettingsChange(active, { ...review, consentVersion }, true);
    assert.ok(change.ok && change.arming);
    assert.equal(change.patch.consent_version, consentVersion);
    assert.equal(change.patch.risk_pct, 3);
  }
  for (const invalid of [{ mode: undefined }, { acknowledgedRisk: false }, { riskPct: 5 }, { consentVersion: v4 + ".1" }]) {
    assert.equal(validateSettingsChange(active, { ...review, ...invalid }, true).ok, false);
  }
  const slow = { profile: "slow_drip", risk_pct: 0.5, automation_enabled: false };
  assert.equal(validateSettingsChange(slow, { ...review, mode: "slow_drip", riskPct: 0.5 }, true).ok, false);
  assert.equal(validateSettingsChange(active, review, false).ok, false);
  const save = validateSettingsChange(active, { consentVersion: v4, managementEnabled: true }, true);
  assert.ok(save.ok && !save.arming && !("consent_version" in save.patch));
});

test("aggressive migration adds only two consented families and preserves all existing reservation and account fences", () => {
  const previous = readFileSync("scripts/sql/nitrous-sweep-profile.sql", "utf8");
  const migration = readFileSync("scripts/sql/nitrous-aggressive-profile.sql", "utf8");
  const from = (s: string, name: string) => compact(functionBody(s, name));
  const v4Addition = ",'" + v4 + "'";
  assert.equal(from(migration, "nitrous_apply_settings").replace(v4Addition, ""), from(previous, "nitrous_apply_settings"));

  const newGuard = " or (p_config = '" + configs.aggressive + "' and p_family in ('range_edge_rejection','compression_breakout')" +
    " and v_account.profile = 'nitrous' and v_account.consent_version = '" + v4 + "')";
  const reserve = from(migration, "nitrous_reserve_intent");
  assert.ok(reserve.includes(newGuard));
  const restored = reserve.replace(newGuard, "").replaceAll(v4Addition, "")
    .replace("v_account.consent_version in ('" + v3 + "')", "v_account.consent_version = '" + v3 + "'");
  assert.equal(restored, from(previous, "nitrous_reserve_intent"));
  const ddl = migration.replace(/CREATE OR REPLACE FUNCTION[\s\S]*?\$function\$;/g, "");
  assert.match(ddl, /check \(family in \('range_reaction','break_retest','trend_pullback','momentum','sweep_reclaim','range_edge_rejection','compression_breakout'\)\)/);
  assert.doesNotMatch(ddl, /\b(?:insert\s+into|update|delete\s+from)\s+(?:public\.)?nitrous_/i);
  assert.equal((ddl.match(/from public,anon,authenticated;/g) ?? []).length, 2);
  assert.equal((ddl.match(/to service_role;/g) ?? []).length, 2);
});
