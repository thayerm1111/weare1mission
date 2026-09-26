import { json, requireUser } from "../_shared";
import { createAdminClient } from "@/lib/supabase/admin";
import { DEFAULT_CONFIG } from "../../../../../rapid/config/defaults";

export const dynamic = "force-dynamic";

/**
 * Readiness, per account, continuously re-evaluated.
 *
 * A successful login is not readiness. A developer key is not readiness. Readiness is: this account,
 * right now, has valid credentials, a resolved contract with the metadata sizing needs, no unresolved
 * positions, a fresh feed, and a risk configuration — and the product itself is switched on.
 */
export async function GET() {
  const auth = await requireUser();
  if ("error" in auth) return auth.error;
  const admin = createAdminClient();
  if (!admin) return json({ error: "not_configured" }, 503);

  const [{ data: conns }, { data: accounts }, { data: control }, { data: beats }] = await Promise.all([
    admin.from("rapid_broker_connections").select("id, environment, server, email_masked, status, last_error, last_auth_at").eq("user_id", auth.user.id),
    admin.from("rapid_accounts").select("*").eq("user_id", auth.user.id),
    admin.from("rapid_control").select("mode, entries_paused, pause_reason, strategy_version, config_version").eq("id", 1).maybeSingle(),
    admin.from("rapid_heartbeat").select("component, at, info"),
  ]);

  const accountRows = (accounts ?? []) as Array<Record<string, unknown>>;
  const ids = accountRows.map((a) => String(a.id));
  const { data: positions } = ids.length
    ? await admin.from("rapid_positions").select("*").in("account_id", ids).in("status", ["open", "closing"])
    : { data: [] as unknown[] };
  const { data: unresolved } = ids.length
    ? await admin.from("rapid_intents").select("id, account_id, state").in("account_id", ids).in("state", ["submission_unknown", "protection_pending", "cancel_requested"])
    : { data: [] as unknown[] };

  const workerAt = ((beats ?? []) as Array<{ component: string; at: string }>).find((b) => b.component === "rapid-watchdog")?.at ?? null;
  const workerAgeMs = workerAt ? Date.now() - new Date(workerAt).getTime() : null;

  const states = accountRows.map((a) => {
    const conn = ((conns ?? []) as Array<Record<string, unknown>>).find((c) => c.id === a.connection_id);
    const missing = (a.spec_missing as string[] | null) ?? [];
    const ownership = a.ownership_check as { ok?: boolean; reason?: string } | null;
    const mine = ((unresolved ?? []) as Array<{ account_id: string }>).filter((u) => u.account_id === a.id);

    const blockers: string[] = [];
    if (!conn) blockers.push("no broker connection");
    else if (conn.status === "reconnect_required") blockers.push("reconnect required: the broker session could not be renewed");
    else if (conn.status === "revoked") blockers.push("this connection was disconnected");
    if (!a.instrument_spec) blockers.push(a.block_reason ? `gold not resolved on this account: ${a.block_reason}` : "gold has not been resolved on this account");
    if (missing.length) blockers.push(`contract metadata incomplete: ${missing.join(", ")}`);
    if (ownership && ownership.ok === false) blockers.push(ownership.reason ?? "account is shared with another product");
    if (mine.length) blockers.push(`${mine.length} unresolved order(s) must be reconciled first`);
    if (workerAgeMs == null || workerAgeMs > 60_000) blockers.push("the Rapid worker has not reported in the last minute");
    if ((control as { mode?: string } | null)?.mode !== "live") blockers.push("Rapid is not switched on for live execution");

    const state =
      !conn ? "disconnected"
      : conn.status === "revoked" ? "disconnected"
      : conn.status === "reconnect_required" ? "reconnect_required"
      : blockers.length === 0 && a.automation_enabled ? "execution_ready"
      : blockers.length === 0 ? "connected"
      : "degraded";

    return {
      accountId: a.id,
      environment: a.environment,
      server: a.server,
      // Masked. The full account number is never sent to a browser.
      accountMasked: `••••${String(a.broker_account_id).slice(-4)}`,
      currency: a.currency,
      resolvedSymbol: (a.instrument_spec as { brokerSymbol?: string } | null)?.brokerSymbol ?? null,
      equity: a.equity,
      lastReconciliation: a.instrument_resolved_at ?? null,
      automationEnabled: a.automation_enabled === true,
      managementEnabled: a.management_enabled === true,
      riskPct: Number(a.risk_pct),
      state,
      blockers,
    };
  });

  return json({
    strategyVersion: (control as { strategy_version?: string } | null)?.strategy_version ?? DEFAULT_CONFIG.version,
    configVersion: (control as { config_version?: string } | null)?.config_version ?? DEFAULT_CONFIG.configVersion,
    mode: (control as { mode?: string } | null)?.mode ?? "off",
    entriesPaused: (control as { entries_paused?: boolean } | null)?.entries_paused !== false,
    pauseReason: (control as { pause_reason?: string } | null)?.pause_reason ?? null,
    worker: { lastBeatAt: workerAt, ageMs: workerAgeMs, healthy: workerAgeMs != null && workerAgeMs < 60_000 },
    connections: (conns ?? []).map((c) => {
      const r = c as Record<string, unknown>;
      return { id: r.id, environment: r.environment, server: r.server, emailMasked: r.email_masked, status: r.status, lastError: r.last_error };
    }),
    accounts: states,
    openPositions: positions ?? [],
  });
}
