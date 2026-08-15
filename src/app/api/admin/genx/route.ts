import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveGenxOpen } from "@/lib/genxResolve";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GENX Lab — admin analytics (spec §33–§35). Read-only overview of every recorded
 * GENX signal and its tracked outcome: win-rate, net pips, per-mode / per-action /
 * per-confidence-bucket performance and a confidence-calibration check. POST grades
 * any still-open signals on demand (same resolver the cron uses).
 *
 * The decision fields are never rewritten here — this only reads them and the
 * outcome_* columns the resolver fills (spec §27 immutability).
 */
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

async function requireAdmin() {
  const supabase = createClient();
  if (!supabase) return { error: json({ error: "not_configured" }, 500) };
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: json({ error: "unauthorized" }, 401) };
  const { data: me } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (!me || me.role !== "admin") return { error: json({ error: "forbidden" }, 403) };
  return { ok: true as const };
}

type Sig = {
  id: string; created_at: string; mode: string | null; action: string | null;
  direction: string | null; confidence: number | null; entry: number | null;
  stop_pips: number | null; tp1_pips: number | null;
  outcome: string | null; filled: boolean | null;
  mfe_pips: number | null; mae_pips: number | null;
  minutes_to_tp: number | null; directional_correct: boolean | null;
  market_regime: string | null;
};

const isWin = (o: string | null) => o === "WIN";
const isLoss = (o: string | null) => o === "LOSS";
const pct = (a: number, b: number) => (b ? +((a / b) * 100).toFixed(1) : 0);

function rollup<T extends string | number>(rows: Sig[], keyOf: (s: Sig) => T | null) {
  const map = new Map<string, { key: string; n: number; resolved: number; wins: number; losses: number }>();
  for (const s of rows) {
    const k = keyOf(s);
    if (k === null || k === undefined || k === "") continue;
    const key = String(k);
    const e = map.get(key) || { key, n: 0, resolved: 0, wins: 0, losses: 0 };
    e.n++;
    if (s.outcome) { e.resolved++; if (isWin(s.outcome)) e.wins++; if (isLoss(s.outcome)) e.losses++; }
    map.set(key, e);
  }
  return [...map.values()].map((e) => ({ ...e, win_rate: pct(e.wins, e.resolved) }));
}

const CONF_BUCKETS: { label: string; lo: number; hi: number }[] = [
  { label: "≥80", lo: 80, hi: 200 },
  { label: "70–79", lo: 70, hi: 80 },
  { label: "60–69", lo: 60, hi: 70 },
  { label: "50–59", lo: 50, hi: 60 },
  { label: "<50", lo: 0, hi: 50 },
];

export async function GET(_req: NextRequest) {
  const gate = await requireAdmin();
  if ("error" in gate) return gate.error;
  const admin = createAdminClient();
  if (!admin) return json({ error: "no_admin_client" }, 500);

  const { data, error } = await admin
    .from("genx_signals")
    .select("id,created_at,mode,action,direction,confidence,entry,stop_pips,tp1_pips,outcome,filled,mfe_pips,mae_pips,minutes_to_tp,directional_correct,market_regime")
    .order("created_at", { ascending: false })
    .limit(1000);

  // Table not created yet → tell the UI to prompt for the migration.
  if (error) {
    const missing = /relation .* does not exist|could not find the table|schema cache/i.test(error.message || "");
    return json({ ok: true, needs_migration: missing, error: missing ? null : error.message, empty: true,
      overview: null, by_mode: [], by_action: [], by_confidence: [], recent: [] }, 200);
  }

  const rows = (data || []) as Sig[];
  const resolvedRows = rows.filter((r) => r.outcome);
  const wins = resolvedRows.filter((r) => isWin(r.outcome)).length;
  const losses = resolvedRows.filter((r) => isLoss(r.outcome)).length;
  const net_pips = resolvedRows.reduce((a, r) => a + (isWin(r.outcome) ? (r.tp1_pips ?? 0) : isLoss(r.outcome) ? -(r.stop_pips ?? 0) : 0), 0);
  const mfeVals = resolvedRows.map((r) => r.mfe_pips).filter((n): n is number => typeof n === "number");
  const maeVals = resolvedRows.map((r) => r.mae_pips).filter((n): n is number => typeof n === "number");
  const dirVals = resolvedRows.filter((r) => typeof r.directional_correct === "boolean");
  const dirCorrect = dirVals.filter((r) => r.directional_correct).length;
  const avg = (xs: number[]) => (xs.length ? +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1) : 0);

  const overview = {
    total: rows.length,
    resolved: resolvedRows.length,
    open: rows.length - resolvedRows.length,
    wins, losses,
    win_rate: pct(wins, resolvedRows.length),
    net_pips: +net_pips.toFixed(1),
    avg_mfe: avg(mfeVals),
    avg_mae: avg(maeVals),
    directional_accuracy: pct(dirCorrect, dirVals.length),
    filled_rate: pct(resolvedRows.filter((r) => r.filled).length, resolvedRows.length),
  };

  const by_mode = rollup(rows, (s) => s.mode).sort((a, b) => b.n - a.n);
  const by_action = rollup(rows, (s) => s.action).sort((a, b) => b.n - a.n);
  const by_confidence = CONF_BUCKETS.map((b) => {
    const inB = rows.filter((s) => typeof s.confidence === "number" && s.confidence! >= b.lo && s.confidence! < b.hi);
    const res = inB.filter((s) => s.outcome);
    const w = res.filter((s) => isWin(s.outcome)).length;
    return { key: b.label, n: inB.length, resolved: res.length, wins: w, losses: res.filter((s) => isLoss(s.outcome)).length, win_rate: pct(w, res.length) };
  });

  const recent = rows.slice(0, 20).map((s) => ({
    id: s.id, created_at: s.created_at, mode: s.mode, action: s.action, direction: s.direction,
    confidence: s.confidence, entry: s.entry, outcome: s.outcome, filled: s.filled,
    mfe_pips: s.mfe_pips, mae_pips: s.mae_pips, minutes_to_tp: s.minutes_to_tp, regime: s.market_regime,
  }));

  return json({ ok: true, needs_migration: false, empty: rows.length === 0, overview, by_mode, by_action, by_confidence, recent }, 200);
}

export async function POST(_req: NextRequest) {
  const gate = await requireAdmin();
  if ("error" in gate) return gate.error;
  const mdKey = process.env.TWELVEDATA_API_KEY;
  if (!mdKey) return json({ error: "no_market_data_key" }, 500);
  try {
    const r = await resolveGenxOpen(mdKey);
    return json({ ok: true, ...r }, 200);
  } catch (e) {
    return json({ error: "resolve_failed", detail: String(e).slice(0, 200) }, 500);
  }
}
