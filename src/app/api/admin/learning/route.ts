import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { computeAdjustments, REASON_LABEL, type GradedTrade } from "@/lib/learning";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Admin-only analytics for the continuous-learning desk: overall expectancy, the
 * "why trades fail" breakdown, per-bucket expectancy, and the adjustments the gate
 * is currently applying. Read-only.
 */
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

type MetaShape = { mode?: unknown; ctx?: { mode?: unknown } } | null;

export async function GET(_req: NextRequest) {
  const supabase = createClient();
  if (!supabase) return json({ error: "not_configured" }, 500);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);
  const { data: me } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (!me || me.role !== "admin") return json({ error: "forbidden" }, 403);

  const admin = createAdminClient();
  if (!admin) return json({ error: "no_admin_client" }, 500);

  const { data: rowsRaw } = await admin
    .from("signal_log")
    .select("status,realized_r,mfe_r,instrument,session,regime,method,engine,meta,failure_reasons,resolved_at")
    .in("status", ["win", "loss", "expired", "unfilled"])
    .order("resolved_at", { ascending: false })
    .limit(1000);
  const rows = (rowsRaw || []) as Array<{
    status: string; realized_r: number | null; mfe_r: number | null;
    instrument: string | null; session: string | null; regime: string | null;
    method: string | null; engine: string | null; meta: MetaShape; failure_reasons: string[] | null;
  }>;

  const graded = rows.filter((r) => typeof r.realized_r === "number" && Number.isFinite(r.realized_r));
  const trades: GradedTrade[] = graded.map((r) => ({
    status: r.status, realized_r: r.realized_r, instrument: r.instrument, session: r.session,
    regime: r.regime, mode: ((r.meta?.mode ?? r.meta?.ctx?.mode) as string | undefined) ?? null,
    setup: r.method, failure_reasons: r.failure_reasons,
  }));

  // Overview
  const n = trades.length;
  const wins = trades.filter((t) => t.status === "win").length;
  const losses = trades.filter((t) => t.status === "loss" || (t.status === "expired" && (t.realized_r ?? 0) < 0)).length;
  const rs = trades.map((t) => t.realized_r as number);
  const grossWin = rs.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(rs.filter((r) => r < 0).reduce((a, b) => a + b, 0));
  const expectancy = n ? rs.reduce((a, b) => a + b, 0) / n : 0;
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : null;

  // Why trades fail — count each reason across losing trades
  const reasonCount: Record<string, number> = {};
  let lossWithReasons = 0;
  for (const t of trades) {
    const isLoss = t.status === "loss" || (t.status === "expired" && (t.realized_r ?? 0) < 0);
    if (!isLoss) continue;
    if (t.failure_reasons && t.failure_reasons.length) lossWithReasons++;
    for (const fr of t.failure_reasons || []) reasonCount[fr] = (reasonCount[fr] || 0) + 1;
  }
  const byReason = Object.entries(reasonCount)
    .map(([reason, count]) => ({ reason, label: REASON_LABEL[reason as keyof typeof REASON_LABEL] || reason, count }))
    .sort((a, b) => b.count - a.count);

  // Per-bucket expectancy (reuse the exact roll-up the loop uses)
  const adj = computeAdjustments(trades);
  const byDim = (d: string) => adj.filter((a) => a.dimension === d).sort((a, b) => a.expectancy_r - b.expectancy_r);

  // What the gate is actually applying right now
  const { data: activeRaw } = await admin
    .from("scoring_adjustments").select("dimension,bucket,n,expectancy_r,penalty,top_reason")
    .gt("penalty", 0).order("penalty", { ascending: false });

  return json({
    ok: true,
    window: { graded: n, wins, losses, resolved_shown: rows.length },
    overview: {
      graded: n, wins, losses,
      win_rate: n ? +((wins / n) * 100).toFixed(1) : 0,
      expectancy_r: +expectancy.toFixed(3),
      profit_factor: profitFactor == null ? null : +profitFactor.toFixed(2),
      loss_autopsied_pct: losses ? +((lossWithReasons / losses) * 100).toFixed(0) : 0,
    },
    by_reason: byReason,
    by_instrument: byDim("instrument"),
    by_session: byDim("session"),
    by_mode: byDim("mode"),
    by_setup: byDim("setup"),
    active_adjustments: (activeRaw || []),
  }, 200);
}
