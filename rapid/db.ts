import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Service-role client for Rapid's own tables. RLS is bypassed here, which is why every route that
 * uses it must have already established who the caller is and what they own.
 */
let cached: SupabaseClient | null = null;

export function admin(): SupabaseClient {
  if (cached) return cached;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) throw new Error("rapid_no_admin_client");
  cached = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  return cached;
}

export const adminOrNull = (): SupabaseClient | null => {
  try { return admin(); } catch { return null; }
};

/** Append-only decision journal. Never throws: losing a log line must not lose a trade. */
export async function journal(row: {
  accountId?: string | null;
  userId?: string | null;
  visitId?: string | null;
  intentId?: string | null;
  snapshotId?: string | null;
  stage: string;
  code: string;
  decision: string;
  reason: string;
  evidence?: Record<string, unknown>;
}): Promise<void> {
  try {
    await admin().from("rapid_journal").insert({
      account_id: row.accountId ?? null,
      user_id: row.userId ?? null,
      visit_id: row.visitId ?? null,
      intent_id: row.intentId ?? null,
      snapshot_id: row.snapshotId ?? null,
      stage: row.stage,
      code: row.code,
      decision: row.decision,
      reason: row.reason,
      evidence: row.evidence ?? {},
    });
  } catch {
    /* best effort */
  }
}

export async function health(component: string, state: "ok" | "degraded" | "blocked", detail?: Record<string, unknown>, accountId?: string | null): Promise<void> {
  try {
    await admin().from("rapid_health_events").insert({ component, state, account_id: accountId ?? null, detail: detail ?? {} });
  } catch {
    /* best effort */
  }
}

export async function beat(component: string, info: Record<string, unknown>): Promise<void> {
  try {
    await admin().from("rapid_heartbeat").upsert({ component, at: new Date().toISOString(), info }, { onConflict: "component" });
  } catch {
    /* best effort */
  }
}
