import type { SupabaseClient } from "@supabase/supabase-js";
import type { NitrousAccount, NitrousPosition, NitrousStats, NitrousStatus } from "./types";
import { finiteNumber, freshAt, isNitrousMode, NITROUS_CONSENT_VERSION, NITROUS_PROFILES, profileFor, readinessBlockers, WORKER_FRESH_MS } from "./policy";
import { readNitrousTelegramPublicState } from "../nitrous-telegram-store";

export const UNRESOLVED_STATES = ["reserved", "submitting", "acknowledged", "partially_filled", "filled", "submission_unknown", "protection_pending", "cancel_requested"];

export async function readinessContext(admin: SupabaseClient, userId: string, account: Record<string, unknown>) {
  const [connection, control, heartbeat, intents] = await Promise.all([
    admin.from("nitrous_broker_connections").select("id,status").eq("id", account.connection_id).eq("user_id", userId).maybeSingle(),
    admin.from("nitrous_control").select("mode,entries_paused,pause_reason").eq("id", 1).maybeSingle(),
    admin.from("nitrous_heartbeat").select("at,info").eq("component", "nitrous-watchdog").maybeSingle(),
    admin.from("nitrous_intents").select("id", { count: "exact", head: true }).eq("account_id", account.id).in("state", UNRESOLVED_STATES),
  ]);
  if ([connection, control, heartbeat, intents].some((r) => r.error)) throw new Error("readiness_unavailable");
  return { account, connection: connection.data, control: control.data, workerAt: heartbeat.data?.info?.state === "ok" ? heartbeat.data.at : null,
    unresolved: intents.count ?? 0, now: Date.now() };
}

const posView = (p: Record<string, unknown>): NitrousPosition => ({
  id: String(p.id), side: p.side === "sell" ? "sell" : "buy", entry: Number(p.entry),
  stop: finiteNumber(p.current_stop ?? p.initial_stop), target: finiteNumber(p.target),
  quantity: Number(p.current_qty), openedAt: String(p.opened_at), status: String(p.status),
  protectionState: String(p.protection_state), managementEnabled: p.management_enabled === true,
  closeRequestedAt: typeof p.close_requested_at === "string" ? p.close_requested_at : null,
  closeRequestState: ["requested", "dispatching", "acknowledged", "uncertain", "rejected"].includes(String(p.close_request_state))
    ? p.close_request_state as NitrousPosition["closeRequestState"] : null,
  closeRequestError: typeof p.close_request_error === "string" ? p.close_request_error : null,
});

function statsView(row?: Record<string, unknown>): NitrousStats {
  return { wins: Number(row?.wins ?? 0), losses: Number(row?.losses ?? 0), flat: Number(row?.flat ?? 0),
    closed: Number(row?.closed ?? 0), unresolved: Number(row?.unresolved ?? 0),
    netPnl: finiteNumber(row?.net_pnl), recordedPnl: finiteNumber(row?.recorded_pnl), grossPnl: finiteNumber(row?.gross_pnl),
    winningPnl: finiteNumber(row?.winning_pnl), verifiedClosed: Number(row?.verified_closed ?? 0),
    pnlVerified: row?.pnl_verified === true, period: "all_time", basis: "recorded_realised_pnl" };
}

export async function getNitrousStatus(admin: SupabaseClient, userId: string, membershipActive: boolean): Promise<NitrousStatus> {
  const now = Date.now();
  const [accountResult, conns, controlResult, heartbeatResult, statsResult, telegramResult] = await Promise.all([
    admin.from("nitrous_accounts").select("*").eq("user_id", userId).neq("status", "disabled").order("created_at", { ascending: false }),
    admin.from("nitrous_broker_connections").select("id,status").eq("user_id", userId),
    admin.from("nitrous_control").select("mode,entries_paused,pause_reason").eq("id", 1).maybeSingle(),
    admin.from("nitrous_heartbeat").select("at,info").eq("component", "nitrous-watchdog").maybeSingle(),
    admin.rpc("nitrous_account_stats", { p_user: userId }),
    readNitrousTelegramPublicState(admin),
  ]);
  if ([accountResult, conns, controlResult, heartbeatResult, statsResult].some((r) => r.error)) throw new Error("status_unavailable");
  const rows = (accountResult.data ?? []) as Array<Record<string, unknown>>;
  const ids = rows.map((a) => String(a.id));
  const [positions, unresolved] = ids.length ? await Promise.all([
    admin.from("nitrous_positions").select("id,account_id,side,entry,current_stop,initial_stop,target,current_qty,opened_at,status,protection_state,management_enabled,close_requested_at,close_request_state,close_request_error").in("account_id", ids).in("status", ["open", "closing", "orphan_review"]),
    admin.from("nitrous_intents").select("id,account_id").in("account_id", ids).in("state", UNRESOLVED_STATES),
  ]) : [{ data: [], error: null }, { data: [], error: null }];
  if (positions.error || unresolved.error) throw new Error("position_status_unavailable");
  const control = controlResult.data as Record<string, unknown> | null;
  const workerAt = (heartbeatResult.data?.at as string | undefined) ?? null;
  const workerHealthy = freshAt(workerAt, now, WORKER_FRESH_MS) && heartbeatResult.data?.info?.state === "ok";
  const connections = (conns.data ?? []) as Array<Record<string, unknown>>;
  const stats = (statsResult.data ?? []) as Array<Record<string, unknown>>;
  const accounts: NitrousAccount[] = rows.map((a) => {
    const connection = connections.find((c) => c.id === a.connection_id) ?? null;
    const blockers = readinessBlockers({ account: a, connection, control, workerAt,
      unresolved: (unresolved.data ?? []).filter((r) => r.account_id === a.id).length, now });
    if (!workerHealthy && freshAt(workerAt, now, WORKER_FRESH_MS)) blockers.push("The execution service is checking market or broker data.");
    if (!membershipActive) blockers.push("Active One Mission access is required for new entries.");
    const mode = isNitrousMode(a.profile) ? a.profile : "slow_drip";
    const equity = finiteNumber(a.equity);
    const risk = finiteNumber(a.risk_pct) ?? profileFor(mode).defaultRisk;
    const armed = a.automation_enabled === true;
    const masked = `••••${String(a.broker_account_id).slice(-4)}`;
    return {
      id: String(a.id), accountId: String(a.id), connectionId: String(a.connection_id),
      name: typeof a.name === "string" ? a.name : null, environment: a.environment === "live" ? "live" : "demo",
      masked, accountMasked: masked, currency: typeof a.currency === "string" ? a.currency : null,
      balance: finiteNumber(a.balance), equity, equityAt: typeof a.equity_at === "string" ? a.equity_at : null,
      balanceAt: typeof a.balance_at === "string" ? a.balance_at : null,
      mode, riskPct: risk, plannedRisk: equity === null ? null : equity * risk / 100,
      dailyLossPct: profileFor(mode).dailyLossPct, automationEnabled: armed, managementEnabled: a.management_enabled === true,
      state: connection?.status === "reconnect_required" || connection?.status === "revoked" ? "reconnect_required"
        : blockers.length ? "degraded" : armed ? "active" : a.automation_enabled_at ? "paused" : "connected",
      blockers, resolvedSymbol: (a.instrument_spec as { brokerSymbol?: string } | null)?.brokerSymbol ?? null,
      stats: statsView(stats.find((s) => s.account_id === a.id)),
      positions: ((positions.data ?? []) as Array<Record<string, unknown>>).filter((p) => p.account_id === a.id).map(posView),
    };
  });
  return { available: true, serverTime: new Date(now).toISOString(), accounts,
    worker: { healthy: workerHealthy, lastBeatAt: workerAt, ageMs: workerAt ? Math.max(0, now - Date.parse(workerAt)) : null },
    control: { mode: String(control?.mode ?? "off"), entriesPaused: control?.entries_paused !== false,
      pauseReason: typeof control?.pause_reason === "string" ? control.pause_reason : null },
    telegram: { configured: telegramResult.configured && telegramResult.status === "ready", url: telegramResult.url, name: telegramResult.title ?? "One Mission Nitrous" },
    profiles: NITROUS_PROFILES, consentVersion: NITROUS_CONSENT_VERSION };
}
