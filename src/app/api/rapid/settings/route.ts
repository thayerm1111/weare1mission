import { clampRisk, json, requireAccount, requireUser, RISK_PRESETS, MAX_RISK_PCT } from "../_shared";

export const dynamic = "force-dynamic";

/**
 * The member's four controls.
 *
 * Turning automation ON is an authenticated, account-specific action taken by a person. It is never
 * a side effect of a deploy, a migration, or another setting changing — which is why the column
 * defaults to false and why `automation_version` increments on every change: an intent approved
 * under an older version is refused at submission time.
 */
export async function GET() {
  const auth = await requireUser();
  if ("error" in auth) return auth.error;
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const admin = createAdminClient();
  if (!admin) return json({ error: "not_configured" }, 503);
  const { data } = await admin
    .from("rapid_accounts")
    .select("id, name, environment, currency, equity, automation_enabled, management_enabled, risk_pct, allow_shared_account, status, spec_missing, ownership_check")
    .eq("user_id", auth.user.id);
  return json({ presets: RISK_PRESETS, maxRiskPct: MAX_RISK_PCT, accounts: data ?? [] });
}

export async function POST(req: Request) {
  const auth = await requireUser();
  if ("error" in auth) return auth.error;

  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; } catch { return json({ error: "bad_request" }, 400); }

  const accountId = String(body.accountId ?? "");
  if (!accountId) return json({ error: "accountId is required" }, 400);
  const owned = await requireAccount(auth.user.id, accountId);
  if ("error" in owned) return owned.error;
  const { admin, account } = owned;

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  const audit: string[] = [];

  if (body.riskPct !== undefined) {
    const risk = clampRisk(body.riskPct);
    if (risk == null) return json({ error: "riskPct must be a positive number" }, 400);
    patch.risk_pct = risk;
    audit.push(`risk ${account.risk_pct} -> ${risk}%${risk !== Number(body.riskPct) ? ` (clamped to the ${MAX_RISK_PCT}% ceiling)` : ""}`);
  }

  if (body.managementEnabled !== undefined) {
    patch.management_enabled = body.managementEnabled === true;
    audit.push(`management ${body.managementEnabled === true ? "on" : "off"}`);
  }

  if (body.automationEnabled !== undefined) {
    const on = body.automationEnabled === true;
    if (on) {
      // Arming requires the account to actually be ready. The UI showing a toggle is not readiness.
      const missing = (account.spec_missing as string[] | null) ?? [];
      const ownership = account.ownership_check as { ok?: boolean; reason?: string } | null;
      const blockers: string[] = [];
      if (!account.instrument_spec) blockers.push("gold has not been resolved on this account");
      if (missing.length) blockers.push(`instrument metadata incomplete: ${missing.join(", ")}`);
      if (ownership && ownership.ok === false) blockers.push(ownership.reason ?? "ownership check failed");
      if (account.status !== "linked") blockers.push(`account is ${account.status}`);
      if (blockers.length) return json({ error: "not_ready", blockers }, 409);
      patch.automation_enabled = true;
      patch.automation_enabled_at = new Date().toISOString();
    } else {
      patch.automation_enabled = false;
    }
    // Every change bumps the version, so an in-flight decision made under the old value is refused.
    patch.automation_version = Number(account.automation_version ?? 0) + 1;
    audit.push(`automation ${on ? "ON" : "OFF"}`);
  }

  if (body.allowSharedAccount !== undefined) {
    patch.allow_shared_account = body.allowSharedAccount === true;
    audit.push(`shared account ${body.allowSharedAccount === true ? "allowed" : "refused"}`);
  }

  const { error } = await admin.from("rapid_accounts").update(patch).eq("id", accountId);
  if (error) return json({ error: error.message }, 500);

  await admin.from("rapid_journal").insert({
    account_id: accountId, user_id: auth.user.id, stage: "settings", code: "changed",
    decision: "applied", reason: audit.join("; "), evidence: patch,
  });

  // Turning automation off closes the automation session and cancels unfilled Rapid entry orders,
  // but never touches an open position's protection. The worker reads this on its next pass.
  if (body.automationEnabled === false) {
    await admin.from("rapid_automation_sessions")
      .update({ ended_at: new Date().toISOString(), ended_reason: "automation switched off by the member" })
      .eq("account_id", accountId).is("ended_at", null);
  }

  const { data } = await admin.from("rapid_accounts").select("*").eq("id", accountId).maybeSingle();
  return json({ ok: true, applied: audit, account: safeAccount(data as Record<string, unknown> | null) });
}

function safeAccount(a: Record<string, unknown> | null) {
  if (!a) return null;
  const { ...rest } = a;
  return {
    id: rest.id, name: rest.name, environment: rest.environment, currency: rest.currency, equity: rest.equity,
    automationEnabled: rest.automation_enabled, managementEnabled: rest.management_enabled,
    riskPct: rest.risk_pct, allowSharedAccount: rest.allow_shared_account, status: rest.status,
    specMissing: rest.spec_missing, ownershipCheck: rest.ownership_check,
  };
}
