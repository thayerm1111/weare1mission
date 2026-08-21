import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GENX FOLLOWER readout — the raw GENX gold record, read from the SAME ledger
 * (`genx_signals`) the site-wide GENX/FLOW gold numbers come from, so this always
 * agrees with the FLOW results card. GENX is gold-only, so every decided signal is
 * a gold trade; a follower account set to "follow every GENX signal" takes each of
 * these at a flat 0.01, so this record is exactly what that account mirrors.
 *
 * We report the full win/loss tally (wins, losses, win rate, gross pips won, gross
 * lost, net) plus how many signals a follower account has ACTUALLY placed so far
 * (genx_follower_fills) — so the "taken" count builds up from the moment a toggle
 * is switched on. No auth: it exposes only trade outcomes, nothing sensitive.
 */
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

type GoldSig = {
  created_at: string; resolved_at: string | null; direction: string | null; outcome: string | null;
  stop_pips: number | null; tp1_pips: number | null; tp2_pips: number | null; tp3_pips: number | null;
  tp1_hit: boolean | null; tp2_hit: boolean | null; tp3_hit: boolean | null;
};
// A GENX win banks the pips of the highest target it filled; a loss books the stop.
function winPips(s: GoldSig): number {
  if (s.tp3_hit && s.tp3_pips) return s.tp3_pips;
  if (s.tp2_hit && s.tp2_pips) return s.tp2_pips;
  if (s.tp1_hit && s.tp1_pips) return s.tp1_pips;
  return s.tp1_pips ?? 0;
}

export async function GET() {
  const empty = { wins: 0, losses: 0, total: 0, winRate: 0, grossWon: 0, grossLost: 0, netPips: 0, best: 0, worst: 0 };
  const admin = createAdminClient();
  if (!admin) return json({ ok: false, record: empty, takenCount: 0, recent: [] });

  const [{ data: sigRaw }, { data: fillsRaw }] = await Promise.all([
    admin.from("genx_signals")
      .select("created_at,resolved_at,direction,outcome,stop_pips,tp1_pips,tp2_pips,tp3_pips,tp1_hit,tp2_hit,tp3_hit")
      .not("outcome", "is", null)
      .order("resolved_at", { ascending: false, nullsFirst: false })
      .limit(1000),
    admin.from("genx_follower_fills").select("signal_key").limit(5000),
  ]);

  const rows = ((sigRaw || []) as GoldSig[]).filter((s) => s.outcome === "WIN" || s.outcome === "LOSS");
  let wins = 0, losses = 0, grossWon = 0, grossLost = 0, best = 0, worst = 0;
  for (const s of rows) {
    if (s.outcome === "WIN") { const p = winPips(s); wins++; grossWon += p; if (p > best) best = p; }
    else { const p = s.stop_pips ?? 0; losses++; grossLost += p; if (-p < worst) worst = -p; }
  }
  const total = wins + losses;
  const record = {
    wins, losses, total,
    winRate: total ? Math.round((wins / total) * 100) : 0,
    grossWon: Math.round(grossWon),
    grossLost: Math.round(grossLost),
    netPips: Math.round(grossWon - grossLost),
    best: Math.round(best),
    worst: Math.round(worst),
  };

  const recent = rows.slice(0, 14).map((s) => {
    const win = s.outcome === "WIN";
    return { side: (s.direction || "").toLowerCase(), win, pips: Math.round(win ? winPips(s) : -(s.stop_pips ?? 0)), at: s.resolved_at || s.created_at };
  });

  // How many signals a follower account has actually placed so far (builds up live).
  const takenCount = new Set((fillsRaw ?? []).map((f) => String((f as { signal_key: string }).signal_key))).size;

  return json({ ok: true, record, takenCount, recent });
}
