import type { NitrousAddonAccess } from "./addon-policy";

/** Browser-safe contracts. Broker credentials and full identifiers never enter these payloads. */
export type NitrousMode = "slow_drip" | "nitrous";
export type NitrousStats = {
  wins: number; losses: number; flat: number; closed: number; unresolved: number;
  netPnl: number | null; recordedPnl: number | null; grossPnl: number | null;
  winningPnl: number | null; pnlVerified: boolean; verifiedClosed: number;
  period: "all_time"; basis: "recorded_realised_pnl";
};
export type NitrousPosition = {
  id: string; side: "buy" | "sell"; entry: number; stop: number | null; target: number | null;
  quantity: number; openedAt: string; status: string; protectionState: string;
  managementEnabled: boolean; closeRequestedAt: string | null;
  closeRequestState: "requested" | "dispatching" | "acknowledged" | "uncertain" | "rejected" | null;
  closeRequestError: string | null;
};
export type NitrousAccount = {
  id: string; accountId: string; connectionId: string; name: string | null;
  environment: "live" | "demo"; masked: string; accountMasked: string; currency: string | null;
  balance: number | null; equity: number | null; equityAt: string | null; balanceAt: string | null;
  mode: NitrousMode; riskPct: number; plannedRisk: number | null; dailyLossPct: number;
  automationEnabled: boolean; managementEnabled: boolean; fastStrategyEnabled?: boolean;
  state: "active" | "connected" | "paused" | "degraded" | "reconnect_required";
  blockers: string[]; resolvedSymbol: string | null; stats: NitrousStats; positions: NitrousPosition[];
};
export type NitrousStatus = {
  available: boolean; serverTime: string; error?: string; reason?: string;
  addon: NitrousAddonAccess;
  accounts: NitrousAccount[];
  worker: { healthy: boolean; lastBeatAt: string | null; ageMs: number | null };
  control: { mode: string; entriesPaused: boolean; pauseReason: string | null };
  telegram: { configured: boolean; url: string | null; name: string };
  profiles: Array<{ mode: NitrousMode; label: string; riskPresets: number[]; defaultRisk: number; dailyLossPct: number }>;
  consentVersion: string;
};
export type NitrousCandle = { t: number; o: number; h: number; l: number; c: number };
export type NitrousScenario = {
  setupId: string; family: string; side: "buy" | "sell"; timeframe: string; state: string; profile?: "both" | "nitrous"; configVersion?: string;
  entryBandLow: number; entryBandHigh: number; refEntry: number; stop: number; target: number;
  stopUsd: number; targetUsd: number; expiresAt: number;
  conditionsMet: string[]; conditionsPending: string[]; invalidation: number; explanation?: string;
};
export type NitrousAnalyze = {
  available: boolean; reason?: string; asOf: string | null; generatedAt: string | null;
  ageMs: number | null; stale: boolean; price: number | null; symbol: "XAUUSD";
  source: string | null; bars: NitrousCandle[]; scenarios: NitrousScenario[];
  flow: Array<{ timeframe: string; direction: "up" | "down" | "range" | "unknown"; label: string }>;
  explanation: string; health: { state: string; reasons: string[] };
  strategyVersion: string | null;
};
export type NitrousBrokerAccount = {
  accountId: string; accNum: string; name: string | null; currency: string | null;
  balance: number | null;
};
