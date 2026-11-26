import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  hasFastConsent, hasNitrousConsent, hasSweepConsent, NITROUS_CONSENT_VERSION, NITROUS_FAST_CONSENT_VERSION,
  NITROUS_SETUP_CONFIGS, NITROUS_SWEEP_CONSENT_VERSION, setupAuthorized, setupCapability, validateSettingsChange,
} from "../src/lib/nitrous/policy";
import { publicNitrousScenario } from "../src/lib/nitrous/scenarios";
import { getNitrousStatus } from "../src/lib/nitrous/server";
import { NITROUS_CONFIG, NITROUS_FAST_CONFIG, NITROUS_SWEEP_CONFIG } from "../nitrous/config";

const NOW = Date.UTC(2026, 10, 26, 6);
const v1 = NITROUS_CONSENT_VERSION, v2 = NITROUS_FAST_CONSENT_VERSION, v3 = NITROUS_SWEEP_CONSENT_VERSION;
const configs = NITROUS_SETUP_CONFIGS;

test("sweep consent adds the new capability without removing baseline or fast authorization", () => {
  assert.equal(v3, "nitrous-consent-v3-sweep");
  for (const consent of [v1, v2, v3]) {
    assert.equal(hasNitrousConsent(consent), true);
    for (const mode of ["slow_drip", "nitrous"]) {
      for (const family of ["trend_pullback", "break_retest"]) {
        assert.equal(setupAuthorized(configs.baseline, family, mode, consent), true);
      }
    }
    assert.equal(hasFastConsent(consent), consent !== v1);
    assert.equal(hasSweepConsent(consent), consent === v3);
    for (const family of ["trend_pullback", "break_retest", "range_reaction"]) {
      assert.equal(setupAuthorized(configs.fast, family, "nitrous", consent), consent !== v1);
      assert.equal(setupAuthorized(configs.fast, family, "slow_drip", consent), false);
    }
    assert.equal(setupAuthorized(configs.sweep, "sweep_reclaim", "nitrous", consent), consent === v3);
    assert.equal(setupAuthorized(configs.sweep, "sweep_reclaim", "slow_drip", consent), false);
  }
});

test("only exact supported configuration and family combinations are classified or authorized", () => {
  assert.deepEqual(configs, { baseline: NITROUS_CONFIG.configVersion, fast: NITROUS_FAST_CONFIG.configVersion,
    sweep: NITROUS_SWEEP_CONFIG.configVersion }, "authorization versions must match the generated strategy configurations");
  assert.equal(setupCapability(configs.baseline, "trend_pullback"), "baseline");
  assert.equal(setupCapability(configs.fast, "range_reaction"), "fast");
  assert.equal(setupCapability(configs.sweep, "sweep_reclaim"), "sweep");
  for (const [config, family] of [
    [configs.baseline, "sweep_reclaim"], [configs.fast, "sweep_reclaim"], [configs.sweep, "break_retest"],
    [configs.baseline, "range_reaction"], [configs.fast, "momentum"], [configs.sweep, "__proto__"],
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

test("status preserves fast permission for v3 and exposes sweep only on the authorized Nitrous account", async () => {
  const at = new Date().toISOString();
  const definitions = [
    { id: "baseline", profile: "nitrous", consent_version: v1 },
    { id: "fast", profile: "nitrous", consent_version: v2 },
    { id: "sweep", profile: "nitrous", consent_version: v3 },
    { id: "slow", profile: "slow_drip", consent_version: v3 },
  ];
  const rows = definitions.map(a => ({ ...a, user_id: "member", connection_id: "connection", broker_account_id: "demo-1234",
    environment: "demo", status: "linked", automation_enabled: true, management_enabled: true,
    risk_pct: a.profile === "nitrous" ? 3 : 0.5, equity: 500, equity_at: at, instrument_spec: { contractSize: 100 },
    spec_missing: [], ownership_check: { ok: true, checkedAt: at } }));
  const tables: Record<string, unknown> = {
    nitrous_accounts: rows, nitrous_broker_connections: [{ id: "connection", status: "connected" }],
    nitrous_control: { mode: "live", entries_paused: false }, nitrous_heartbeat: { at, info: { state: "ok" } },
    nitrous_positions: [], nitrous_intents: [], nitrous_telegram_settings: null,
    nitrous_addon_grants: [{ user_id: "member", active: true }], nitrous_addon_subscriptions: [],
  };
  const admin = {
    from(table: string) {
      assert.ok(Object.hasOwn(tables, table), `Unexpected table ${table}`);
      const result = Promise.resolve({ data: tables[table], error: null });
      const query = { select: () => query, eq: () => query, neq: () => query, order: () => query,
        in: () => query, range: () => query, maybeSingle: () => query, then: result.then.bind(result) };
      return query;
    },
    rpc: async (name: string) => { assert.equal(name, "nitrous_account_stats"); return { data: [], error: null }; },
  } as unknown as Parameters<typeof getNitrousStatus>[0];
  const status = await getNitrousStatus(admin, "member", true);
  assert.deepEqual(status.accounts.map(a => [a.id, a.fastStrategyEnabled, a.sweepStrategyEnabled]), [
    ["baseline", false, false], ["fast", true, false], ["sweep", true, true], ["slow", false, false],
  ]);
  assert.ok(status.accounts.every(a => a.automationEnabled));
  assert.equal(status.consentVersion, v1, "existing top-level baseline consent contract is retained");
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
  for (const config of Object.values(configs)) assert.ok(guard.includes(`p_config = '${config}'`));
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
