import { createAdminClient } from "@/lib/supabase/admin";
import { computeAdjustments, penaltyFor, type GradedTrade, type ActiveAdj } from "@/lib/learning";

/**
 * DB glue for the continuous-learning loop (service-role only).
 *  - recomputeAdjustments: rebuild the scoring_adjustments table from the rolling
 *    window of graded trades. Called by the resolver after grading.
 *  - getAdjustmentPenalty: the read each engine does at scoring time to fetch the
 *    bounded, penalty-only adjustment for a setup's buckets (cached in-memory).
 * Both are best-effort: any failure returns a no-op so signals never break.
 */

type MetaShape = { mode?: unknown; ctx?: { mode?: unknown; setup?: unknown } } | null;
type Admin = NonNullable<ReturnType<typeof createAdminClient>>;

// Rebuild all adjustments from the most recent graded trades. Because it fully
// recomputes each run, penalties decay on their own as expectancy recovers.
export async function recomputeAdjustments(admin: Admin): Promise<number> {
  try {
    const { data } = await admin
      .from("signal_log")
      .select("realized_r,status,instrument,session,regime,method,meta,failure_reasons")
      .in("status", ["win", "loss", "expired"])
      .not("realized_r", "is", null)
      .order("resolved_at", { ascending: false })
      .limit(600);
    const rows = (data || []) as Array<{
      realized_r: number | null; status: string; instrument: string | null;
      session: string | null; regime: string | null; method: string | null;
      meta: MetaShape; failure_reasons: string[] | null;
    }>;
    const trades: GradedTrade[] = rows.map((r) => ({
      status: r.status,
      realized_r: r.realized_r,
      instrument: r.instrument,
      session: r.session,
      regime: r.regime,
      mode: ((r.meta?.mode ?? r.meta?.ctx?.mode) as string | undefined) ?? null,
      setup: r.method,
      failure_reasons: r.failure_reasons,
    }));
    const adj = computeAdjustments(trades);
    // Replace the whole table so stale/decayed buckets disappear.
    await admin.from("scoring_adjustments").delete().not("dimension", "is", null);
    if (adj.length) {
      const now = new Date().toISOString();
      await admin.from("scoring_adjustments").insert(adj.map((a) => ({ ...a, updated_at: now })));
    }
    return adj.filter((a) => a.penalty > 0).length;
  } catch {
    return 0;
  }
}

// ── Scoring-time read (cached) ───────────────────────────────────────────────
let cache: { at: number; rows: ActiveAdj[] } = { at: 0, rows: [] };
const TTL = 5 * 60 * 1000;

async function activeAdjustments(): Promise<ActiveAdj[]> {
  const now = Date.now();
  if (cache.at > 0 && now - cache.at < TTL) return cache.rows;
  const admin = createAdminClient();
  if (!admin) return cache.rows;
  const { data } = await admin
    .from("scoring_adjustments")
    .select("dimension,bucket,penalty,top_reason")
    .gt("penalty", 0);
  cache = { at: now, rows: (data || []) as ActiveAdj[] };
  return cache.rows;
}

export async function getAdjustmentPenalty(ctx: {
  instrument?: string | null; session?: string | null; mode?: string | null;
  setup?: string | null; regime?: string | null;
}): Promise<{ penalty: number; reasons: string[] }> {
  try {
    return penaltyFor(await activeAdjustments(), ctx);
  } catch {
    return { penalty: 0, reasons: [] };
  }
}
