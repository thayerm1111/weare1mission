import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GENX public track record — a MEMBER-SAFE, anonymized aggregate of how the
 * GENX Gold engine has actually performed. Any signed-in member can read it (it
 * powers the low-balance flyer); it exposes ONLY desk-wide aggregate numbers and
 * the engine's own recent winning calls — never any per-member data.
 *
 * Numbers come straight from the immutable `genx_signals.outcome_*` ledger the
 * resolver fills, so nothing here is fabricated. Win rate is over DECIDED trades
 * (wins vs losses); expired/unfilled setups are excluded from the rate and shown
 * separately, which is the honest, standard way to read a track record.
 */
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

const isWin = (o: string | null) => o === "WIN";
const isLoss = (o: string | null) => o === "LOSS";

/** Pips banked on a winning call: the pips of the highest target that filled. */
function winPips(s: Sig): number {
  if (s.tp3_hit && s.tp3_pips) return s.tp3_pips;
  if (s.tp2_hit && s.tp2_pips) return s.tp2_pips;
  if (s.tp1_hit && s.tp1_pips) return s.tp1_pips;
  return s.tp1_pips ?? 0;
}

type Sig = {
  created_at: string; resolved_at: string | null; mode: string | null; action: string | null;
  direction: string | null; outcome: string | null;
  stop_pips: number | null; tp1_pips: number | null; tp2_pips: number | null; tp3_pips: number | null;
  tp1_hit: boolean | null; tp2_hit: boolean | null; tp3_hit: boolean | null;
};

export async function GET() {
  // Signed-in members only (protects the aggregate from anonymous scraping).
  const supabase = createClient();
  if (supabase) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
  }

  const admin = createAdminClient();
  if (!admin) return json({ error: "not_configured" }, 200);

  const [{ count: generated }, { data, error }] = await Promise.all([
    admin.from("genx_signals").select("id", { count: "exact", head: true }),
    admin
      .from("genx_signals")
      .select("created_at,resolved_at,mode,action,direction,outcome,stop_pips,tp1_pips,tp2_pips,tp3_pips,tp1_hit,tp2_hit,tp3_hit")
      .not("outcome", "is", null)
      .order("resolved_at", { ascending: false, nullsFirst: false })
      .limit(600),
  ]);
  if (error) return json({ error: "load_failed", detail: error.message }, 200);

  const rows = (data || []) as Sig[];
  let wins = 0, losses = 0, other = 0, netPips = 0, rrN = 0, rrSum = 0;
  for (const s of rows) {
    if (isWin(s.outcome)) {
      wins++;
      netPips += winPips(s);
    } else if (isLoss(s.outcome)) {
      losses++;
      netPips -= s.stop_pips ?? 0;
    } else {
      other++;
    }
    if (s.tp1_pips && s.stop_pips) { rrSum += s.tp1_pips / s.stop_pips; rrN++; }
  }
  const decided = wins + losses;
  const winRate = decided ? +((wins / decided) * 100).toFixed(0) : null;
  const avgRr = rrN ? +(rrSum / rrN).toFixed(2) : null;

  const recent = rows
    .filter((s) => isWin(s.outcome))
    .slice(0, 6)
    .map((s) => {
      const tp = s.tp3_hit ? 3 : s.tp2_hit ? 2 : s.tp1_hit ? 1 : null;
      const p = winPips(s);
      return {
        mode: s.mode || null,
        direction: (s.direction || "").toLowerCase(),
        tp,
        pips: p > 0 ? Math.round(p) : null,
        at: s.resolved_at || s.created_at,
      };
    });

  return json({
    generated: generated ?? rows.length,
    resolved: rows.length,
    wins, losses, other, decided,
    winRate,
    avgRr,
    netPips: Math.round(netPips),
    recent,
  }, 200);
}
