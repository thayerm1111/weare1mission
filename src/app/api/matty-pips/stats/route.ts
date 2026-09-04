import { getProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * MATTY PIPS — PERFORMANCE ANALYTICS. Aggregates the graded outcomes so the
 * engine's honesty is inspectable: win rate and average excursion by setup
 * family, session, 4H regime, volatility state, and conviction band. Pure
 * read; member-authenticated; matty_pips_* tables only.
 */
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

type ORow = {
  status: string; direction: string; conviction: number | null;
  execution_state: string | null; setup_family: string | null;
  regime: string | null; session: string | null; volatility: string | null;
  mfe: number | null; mae: number | null; plus3_before_minus3: boolean | null;
  call_at: string;
};

const WIN = new Set(["win_tp1", "win_tp2", "win_tp3", "expired_win"]);
const LOSS = new Set(["loss", "expired_loss"]);

function bucketize(rows: ORow[], keyOf: (r: ORow) => string | null) {
  const m = new Map<string, { n: number; w: number; l: number; mfe: number; mae: number; plus3: number; plus3n: number }>();
  for (const r of rows) {
    const k = keyOf(r);
    if (!k) continue;
    const b = m.get(k) ?? { n: 0, w: 0, l: 0, mfe: 0, mae: 0, plus3: 0, plus3n: 0 };
    b.n++;
    if (WIN.has(r.status)) b.w++;
    if (LOSS.has(r.status)) b.l++;
    if (r.mfe != null) b.mfe += r.mfe;
    if (r.mae != null) b.mae += r.mae;
    if (r.plus3_before_minus3 != null) { b.plus3n++; if (r.plus3_before_minus3) b.plus3++; }
    m.set(k, b);
  }
  return Object.fromEntries([...m.entries()].map(([k, b]) => [k, {
    calls: b.n, wins: b.w, losses: b.l,
    winRate: b.w + b.l > 0 ? Math.round((b.w / (b.w + b.l)) * 100) : null,
    avgMfe: b.n ? +(b.mfe / b.n).toFixed(2) : null,
    avgMae: b.n ? +(b.mae / b.n).toFixed(2) : null,
    plus3First: b.plus3n ? Math.round((b.plus3 / b.plus3n) * 100) : null,
  }]));
}

export async function GET() {
  const profile = await getProfile();
  if (!profile) return json({ ok: false, error: "unauthorized" }, 401);
  const admin = createAdminClient();
  if (!admin) return json({ ok: false, error: "not_configured" }, 500);

  const sinceIso = new Date(Date.now() - 30 * 86400_000).toISOString();
  const { data, error } = await admin.from("matty_pips_outcomes")
    .select("status, direction, conviction, execution_state, setup_family, regime, session, volatility, mfe, mae, plus3_before_minus3, call_at")
    .gte("call_at", sinceIso).limit(2000);
  if (error) return json({ ok: true, available: false, note: "Outcome tracking is warming up — stats appear once calls are graded." });

  const rows = (data ?? []) as ORow[];
  const resolved = rows.filter((r) => r.status !== "pending" && r.status !== "unfilled");
  const wins = resolved.filter((r) => WIN.has(r.status)).length;
  const losses = resolved.filter((r) => LOSS.has(r.status)).length;

  return json({
    ok: true, available: true, since: sinceIso,
    totals: {
      calls: rows.length, resolved: resolved.length,
      pending: rows.filter((r) => r.status === "pending").length,
      unfilled: rows.filter((r) => r.status === "unfilled").length,
      wins, losses,
      winRate: wins + losses > 0 ? Math.round((wins / (wins + losses)) * 100) : null,
      tp1: resolved.filter((r) => r.status === "win_tp1").length,
      tp2: resolved.filter((r) => r.status === "win_tp2").length,
      tp3: resolved.filter((r) => r.status === "win_tp3").length,
    },
    bySetup: bucketize(resolved, (r) => r.setup_family),
    bySession: bucketize(resolved, (r) => r.session),
    byRegime: bucketize(resolved, (r) => r.regime),
    byVolatility: bucketize(resolved, (r) => r.volatility),
    byExecution: bucketize(resolved, (r) => r.execution_state),
    byConviction: bucketize(resolved, (r) => r.conviction == null ? null : r.conviction >= 75 ? "75+" : r.conviction >= 60 ? "60-74" : r.conviction >= 45 ? "45-59" : "<45"),
    byDirection: bucketize(resolved, (r) => r.direction),
  });
}
