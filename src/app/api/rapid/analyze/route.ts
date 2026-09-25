import { createAdminClient } from "@/lib/supabase/admin";
import { json, requireUser } from "../_shared";
import { DEFAULT_CONFIG } from "../../../../../rapid/config/defaults";

export const dynamic = "force-dynamic";

/**
 * Analyze.
 *
 * Read-only by construction: it reads the newest snapshot the worker has already produced, plus this
 * member's account eligibility. It creates no setup, reserves no risk and sends no order, so it is
 * safe to press with Automation OFF, and pressing it can never arm anything.
 *
 * A stale cached analysis is returned WITH its age, never refreshed into looking live.
 */
export async function GET() {
  const auth = await requireUser();
  if ("error" in auth) return auth.error;
  const admin = createAdminClient();
  if (!admin) return json({ error: "not_configured" }, 503);

  const [{ data: snapRow }, { data: control }, { data: accounts }] = await Promise.all([
    admin.from("rapid_snapshots").select("*").order("generated_at", { ascending: false }).limit(1).maybeSingle(),
    admin.from("rapid_control").select("mode, entries_paused, pause_reason, strategy_version, config_version").eq("id", 1).maybeSingle(),
    admin.from("rapid_accounts").select("*").eq("user_id", auth.user.id).eq("status", "linked"),
  ]);

  if (!snapRow) {
    return json({
      available: false,
      reason: "no analysis has been produced yet",
      control: control ?? null,
      strategyVersion: DEFAULT_CONFIG.version,
      configVersion: DEFAULT_CONFIG.configVersion,
    });
  }

  const snap = snapRow as Record<string, unknown>;
  const payload = (snap.payload ?? {}) as { scenarios?: unknown[]; range?: unknown; explanation?: string; rejections?: unknown[] };
  const generatedAt = new Date(String(snap.generated_at)).getTime();
  const ageMs = Date.now() - generatedAt;

  const accountRows = (accounts ?? []) as Array<Record<string, unknown>>;
  const accountIds = accountRows.map((a) => String(a.id));
  const { data: owned } = accountIds.length
    ? await admin.from("rapid_positions").select("*").in("account_id", accountIds).in("status", ["open", "closing"])
    : { data: [] as unknown[] };

  const eligibility = accountRows.map((a) => {
    const blockers: string[] = [];
    const missing = (a.spec_missing as string[] | null) ?? [];
    if (missing.length) blockers.push(`instrument metadata incomplete: ${missing.join(", ")}`);
    if (!a.instrument_spec) blockers.push("gold has not been resolved on this account yet");
    if (a.status !== "linked") blockers.push(`account ${a.status}`);
    const ownership = a.ownership_check as { ok?: boolean; reason?: string } | null;
    if (ownership && ownership.ok === false) blockers.push(ownership.reason ?? "account ownership check failed");
    if ((control as { mode?: string } | null)?.mode !== "live") blockers.push("Rapid is not enabled for live execution yet");
    if ((control as { entries_paused?: boolean } | null)?.entries_paused) blockers.push((control as { pause_reason?: string }).pause_reason || "new entries are paused");
    if (!a.automation_enabled) blockers.push("automation is off for this account");
    return {
      accountId: a.id,
      name: a.name,
      environment: a.environment,
      currency: a.currency,
      automationEnabled: a.automation_enabled === true,
      managementEnabled: a.management_enabled === true,
      selectedRisk: Number(a.risk_pct),
      equity: a.equity,
      blockers,
    };
  });

  return json({
    available: true,
    snapshotId: snap.snapshot_id,
    strategyVersion: snap.strategy_version,
    configVersion: snap.config_version,
    generatedAt: snap.generated_at,
    // The age is always shown. "TAKE NOW" on a stale snapshot is the thing this prevents.
    ageMs,
    stale: ageMs > 30_000,
    marketEventTime: snap.market_event_time,
    feedSource: snap.feed_source,
    quoteAgeMs: snap.quote_age_ms,
    health: snap.health,
    regimes: snap.regimes,
    regimeConflict: snap.regime_conflict,
    range: payload.range ?? null,
    scenarios: payload.scenarios ?? [],
    rejectionSample: (payload.rejections ?? []).slice(0, 25),
    deterministicExplanation: payload.explanation ?? "",
    accountEligibility: eligibility,
    ownedPositions: owned ?? [],
    control,
  });
}
