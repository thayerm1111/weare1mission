import { DEFAULT_CONFIG, withOverrides, type RapidConfig } from "../rapid/config/defaults";
import { profileFor } from "../src/lib/nitrous/policy";
import type { NitrousMode } from "../src/lib/nitrous/types";

// Versioned proposed parameters. No profitability claim is implied by enabling execution.
export const NITROUS_CONFIG: RapidConfig = withOverrides(DEFAULT_CONFIG, "nitrous.1", {
  version: "om_nitrous_v1", managementVersion: "om_nitrous_mgmt_v1", liveEnabled: true,
  target: { minUsd: 6, maxUsd: 15, markersUsd: [6, 10], minNetRewardRisk: 1.25 },
  risk: { presetsPct: [0.5, 1, 3, 5], defaultPct: 0.5, maxPct: 5,
    // Conservative provision until a broker supplies an account-specific fee schedule.
    commissionPerLotRoundTrip: 10, sessionLossCeilingPct: 3 },
  entry: { reentryCooldownSec: 120, momentumEnabled: false },
  feed: { maxSignalToSubmitMs: 5_000 },
});

/** Faster setup discovery; baseline remains unchanged. */
export const NITROUS_FAST_CONFIG = withOverrides(NITROUS_CONFIG, "fast.2", {
  entry: { minBodyRatio: 0.45, closeOuterFraction: 0.35, touchMaxUsd: 1.5, touchAtrMult: 0.15 },
  protection: { stopCapUsd: 12 },
});
export function isFastSetup(setup: { configVersion: string }): boolean {
  return setup.configVersion === NITROUS_FAST_CONFIG.configVersion;
}
export function configFor(mode: NitrousMode, fast = false): RapidConfig {
  const profile = profileFor(mode);
  const base = mode === "nitrous" && fast ? NITROUS_FAST_CONFIG : NITROUS_CONFIG;
  return { ...base, risk: { ...base.risk,
    maxPct: Math.max(...profile.riskPresets), defaultPct: profile.defaultRisk,
    sessionLossCeilingPct: profile.dailyLossPct } };
}
