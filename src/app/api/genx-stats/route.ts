import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { goldTally, dedupeGold, goldWinPips, type GoldSig } from "@/lib/genx/goldRecord";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GENX public track record — a MEMBER-SAFE, anonymized aggregate of how the
 * GENX Gold engine has actually performed. Any signed-in member can read it (it
 * powers the low-balance flyer); it exposes ONLY desk-wide aggregate numbers and
 * the engine's own recent winning calls — never any per-member data.
 *
 * Numbers come from the immutable `genx_signals` ledger via the shared goldRecord
 * helper, which DEDUPES fan-out (one call is recorded once per member/view) and
 * derives pips from the filled price at the standard gold pip (0.1) — so this is
 * the honest per-signal record. Win rate is over DECIDED trades (wins vs losses).
 */
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

type Sig = GoldSig & { mode: string | null; action: string | null };

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
      .select("created_at,resolved_at,mode,action,direction,outcome,entry,stop_loss,tp1,tp2,tp3,stop_pips,tp1_pips,tp2_pips,tp3_pips,tp1_hit,tp2_hit,tp3_hit")
      .not("outcome", "is", null)
      .order("resolved_at", { ascending: false, nullsFirst: false })
      .limit(4000),
  ]);
  if (error) return json({ error: "load_failed", detail: error.message }, 200);

  const rows = (data || []) as Sig[];
  const t = goldTally(rows);         // deduped, price-derived
  const ded = dedupeGold(rows) as Sig[];

  let rrN = 0, rrSum = 0;
  for (const s of ded) {
    if (s.tp1_pips && s.stop_pips) { rrSum += s.tp1_pips / s.stop_pips; rrN++; }
  }
  const decided = t.trades;
  const avgRr = rrN ? +(rrSum / rrN).toFixed(2) : null;

  const recent = ded
    .filter((s) => s.outcome === "WIN")
    .slice(0, 6)
    .map((s) => {
      const tp = s.tp3_hit ? 3 : s.tp2_hit ? 2 : s.tp1_hit ? 1 : null;
      const p = goldWinPips(s);
      return {
        mode: s.mode || null,
        direction: (s.direction || "").toLowerCase(),
        tp,
        pips: p > 0 ? Math.round(p) : null,
        at: s.resolved_at || s.created_at,
      };
    });

  return json({
    generated: generated ?? decided,
    resolved: decided,
    wins: t.wins, losses: t.losses, other: 0, decided,
    winRate: t.winRate,
    avgRr,
    netPips: t.net,
    recent,
  }, 200);
}
