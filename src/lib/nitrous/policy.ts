import type { NitrousMode, NitrousStats } from "./types";

export const NITROUS_CONSENT_VERSION = "nitrous-consent-v1";
export const WORKER_FRESH_MS = 60_000;
export const ACCOUNT_FRESH_MS = 120_000;
export const SNAPSHOT_FRESH_MS = 45_000;
export const WORKER_ACCOUNT_READ_FRESH_MS = 30_000;
export const NITROUS_PROFILES = [
  { mode: "slow_drip" as const, label: "Slow Drip", riskPresets: [0.5, 1], defaultRisk: 0.5, dailyLossPct: 3 },
  { mode: "nitrous" as const, label: "Nitrous", riskPresets: [3, 5], defaultRisk: 3, dailyLossPct: 15 },
];

export const isNitrousMode = (v: unknown): v is NitrousMode => v === "slow_drip" || v === "nitrous";
export const profileFor = (mode: NitrousMode) => NITROUS_PROFILES.find((p) => p.mode === mode)!;
export function validRisk(mode: NitrousMode, value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return profileFor(mode).riskPresets.includes(value) ? value : null;
}
export function finiteNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
export function freshAt(value: unknown, now: number, ttl: number): boolean {
  if (typeof value !== "string") return false;
  const age = now - Date.parse(value);
  return Number.isFinite(age) && age >= -5_000 && age <= ttl;
}

/** Cookie writes require the same origin. Native requests use an explicit bearer credential. */
export function allowedWriteOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (origin) {
    try { return new URL(origin).origin === new URL(req.url).origin; } catch { return false; }
  }
  return /^Bearer\s+\S+$/i.test(req.headers.get("authorization") ?? "");
}

export type ReadinessInput = {
  account: Record<string, unknown>; connection: Record<string, unknown> | null;
  workerAt: unknown; control: Record<string, unknown> | null; unresolved: number;
  now: number;
};
/** The dedicated worker continuously verifies broker exposure, contract and positive margin.
 * Reuse only its recent, connection-scoped, server-owned verification for activation.
 * This is not entry permission: readinessBlockers and the worker's pre-order checks still apply. */
export function hasFreshWorkerReadiness(i: ReadinessInput): boolean {
  const a = i.account;
  const proof = a.ownership_check as { ok?: boolean; checkedAt?: string; workerVerified?: boolean; workerConnectionId?: string } | null;
  return typeof a.connection_id === "string" && !!a.connection_id
    && proof?.ok === true && proof.workerVerified === true && proof.workerConnectionId === a.connection_id
    && freshAt(proof.checkedAt, i.now, WORKER_ACCOUNT_READ_FRESH_MS)
    && freshAt(a.equity_at, i.now, WORKER_ACCOUNT_READ_FRESH_MS)
    && (finiteNumber(a.equity) ?? 0) > 0
    && freshAt(i.workerAt, i.now, WORKER_FRESH_MS);
}

/** Shared by status and arming. Absence/error is never treated as healthy. */
export function readinessBlockers(i: ReadinessInput): string[] {
  const a = i.account;
  const blockers: string[] = [];
  if (!i.connection || i.connection.status !== "connected") blockers.push("Reconnect TradeLocker to restore broker access.");
  if (a.status !== "linked") blockers.push("This account is not ready for new entries.");
  for (const reason of [a.block_reason, a.execution_block_reason]) {
    if (typeof reason === "string" && reason.trim() && !blockers.includes(reason)) blockers.push(reason);
  }
  if (!a.instrument_spec || typeof a.instrument_spec !== "object") blockers.push("Gold contract details have not been verified for this account.");
  if (!Array.isArray(a.spec_missing) || a.spec_missing.length) blockers.push("Some broker contract details needed for sizing are unavailable.");
  const ownership = a.ownership_check as { ok?: boolean; checkedAt?: string } | null;
  if (!ownership || ownership.ok !== true) blockers.push("Account exposure must be reconciled before automation starts.");
  else if (!freshAt(ownership.checkedAt, i.now, ACCOUNT_FRESH_MS)) blockers.push("The account exposure check needs to refresh.");
  if (!freshAt(a.equity_at, i.now, ACCOUNT_FRESH_MS) || !(Number(a.equity) > 0)) blockers.push("A fresh positive account equity is required.");
  if (!freshAt(i.workerAt, i.now, WORKER_FRESH_MS)) blockers.push("The execution service has not checked in recently.");
  if (i.control?.mode !== "live") blockers.push("The execution service is not available for new entries.");
  if (i.control?.entries_paused !== false) blockers.push("New entries are currently paused.");
  if (i.unresolved > 0) blockers.push("An earlier order needs reconciliation before another entry.");
  const mode = a.profile;
  if (!isNitrousMode(mode) || validRisk(mode, finiteNumber(a.risk_pct)) === null) blockers.push("Choose a valid mode and risk setting.");
  return blockers;
}

/** Never turn a target touch, unknown close or missing realised amount into a winning trade. */
export function recordedStats(rows: Array<Record<string, unknown>>): NitrousStats {
  const stats: NitrousStats = { wins: 0, losses: 0, flat: 0, closed: 0, unresolved: 0,
    netPnl: null, recordedPnl: null, grossPnl: null, winningPnl: null, pnlVerified: false, verifiedClosed: 0,
    period: "all_time", basis: "recorded_realised_pnl" };
  let sum = 0; let wins = 0; let graded = 0; let gross = 0; let grossCount = 0;
  for (const row of rows) {
    if (row.status !== "closed") continue;
    stats.closed++;
    const pnl = finiteNumber(row.realised_pnl);
    if (pnl === null || !["broker_net","calculated_gross"].includes(String(row.realised_pnl_source))) { stats.unresolved++; continue; }
    graded++; sum += pnl;
    if (row.realised_pnl_source === "calculated_gross") { gross += pnl; grossCount++; }
    if (row.realised_pnl_source === "broker_net" && row.fees_verified === true) stats.verifiedClosed++;
    if (pnl > 0) { stats.wins++; wins += pnl; }
    else if (pnl < 0) stats.losses++;
    else stats.flat++;
  }
  if (graded > 0) { stats.recordedPnl = sum; stats.winningPnl = wins; }
  if (grossCount > 0) stats.grossPnl = gross;
  stats.pnlVerified = stats.closed > 0 && stats.verifiedClosed === stats.closed;
  if (stats.pnlVerified) stats.netPnl = sum;
  return stats;
}

export function safeTelegramUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && u.hostname === "t.me" && u.pathname.length > 1 && !u.username && !u.password ? u.href : null;
  } catch { return null; }
}

export function validateSettingsChange(account: Record<string, unknown>, body: Record<string, unknown>, activeMember: boolean):
  { ok: true; patch: Record<string, unknown>; arming: boolean } | { ok: false; error: string; status: number } {
  for (const field of ["automationEnabled", "managementEnabled"]) {
    if (body[field] !== undefined && typeof body[field] !== "boolean") return { ok: false, error: `${field} must be true or false`, status: 400 };
  }
  // Pausing must stay possible even if a saved profile is no longer a supported preset.
  if (body.automationEnabled === false && body.mode === undefined && body.riskPct === undefined) {
    return { ok: true, arming: false, patch: { automation_enabled: false,
      ...(body.managementEnabled === undefined ? {} : { management_enabled: body.managementEnabled }) } };
  }
  const mode = body.mode === undefined ? account.profile : body.mode;
  if (!isNitrousMode(mode)) return { ok: false, error: "Choose Slow Drip or Nitrous.", status: 400 };
  const changedMode = mode !== account.profile;
  const risk = body.riskPct === undefined ? changedMode ? profileFor(mode).defaultRisk : finiteNumber(account.risk_pct) : body.riskPct;
  const checkedRisk = validRisk(mode, risk);
  if (checkedRisk === null) return { ok: false, error: "Choose one of the risk settings for this mode.", status: 400 };
  const changedRisk = checkedRisk !== finiteNumber(account.risk_pct);
  if (account.automation_enabled === true && (changedMode || changedRisk)) return { ok: false, error: "Pause auto trading before changing mode or risk.", status: 409 };
  const arming = body.automationEnabled === true;
  if (arming && !activeMember) return { ok: false, error: "Active One Mission access is required to start auto trading.", status: 403 };
  if (arming && (body.acknowledgedRisk !== true || body.consentVersion !== NITROUS_CONSENT_VERSION || body.mode !== mode || body.riskPct !== checkedRisk)) {
    return { ok: false, error: "Review and confirm the selected account, mode and risk before starting.", status: 400 };
  }
  const patch: Record<string, unknown> = { profile: mode, risk_pct: checkedRisk };
  if (body.managementEnabled !== undefined) patch.management_enabled = body.managementEnabled;
  if (body.automationEnabled !== undefined) patch.automation_enabled = body.automationEnabled;
  if (arming) { patch.consent_version = NITROUS_CONSENT_VERSION; patch.consented_at = new Date().toISOString(); }
  return { ok: true, patch, arming };
}

export function verifiedOwnedPosition(ledger: Record<string, unknown>, broker: { positionId: string; strategyId: string | null } | undefined): boolean {
  const tag = ledger.broker_strategy_id;
  return Boolean(broker && typeof tag === "string" && tag.startsWith("NITROUS:") && tag.length > 8
    && broker.positionId === String(ledger.broker_position_id) && broker.strategyId === tag);
}
