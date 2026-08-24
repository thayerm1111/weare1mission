import { createAdminClient } from "@/lib/supabase/admin";
import { goldTally, dedupeGold, goldIsWin, goldOutcomePips, type GoldSig } from "@/lib/genx/goldRecord";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GENX FOLLOWER readout — the raw GENX gold record, built by the shared goldRecord
 * helper (same math as the FLOW results card, so they always agree). It DEDUPES
 * fan-out — one market call is recorded once per member/view, so raw sums multiply
 * it — and derives pips from the filled price at the standard gold pip (0.1). GENX
 * is gold-only, so every decided signal is a gold trade; a follower account takes
 * each at a flat 0.01, so this per-signal record is exactly what it mirrors.
 *
 * `takenCount` = how many signals a follower account has actually placed so far.
 * No auth: it exposes only trade outcomes, nothing sensitive.
 */
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export async function GET() {
  const empty = { wins: 0, losses: 0, total: 0, winRate: 0, grossWon: 0, grossLost: 0, netPips: 0, best: 0, worst: 0 };
  const admin = createAdminClient();
  if (!admin) return json({ ok: false, record: empty, takenCount: 0, recent: [] });

  const [{ data: sigRaw }, { data: fillsRaw }] = await Promise.all([
    admin.from("genx_signals")
      .select("created_at,resolved_at,direction,outcome,entry,stop_loss,tp1,tp2,tp3,stop_pips,tp1_pips,tp2_pips,tp3_pips,tp1_hit,tp2_hit,tp3_hit,mfe_pips")
      .not("outcome", "is", null)
      .order("resolved_at", { ascending: false, nullsFirst: false })
      .limit(4000),
    admin.from("genx_follower_fills").select("signal_key").limit(5000),
  ]);

  const rows = (sigRaw || []) as GoldSig[];
  const t = goldTally(rows); // deduped, price-derived
  const record = {
    wins: t.wins, losses: t.losses, total: t.trades,
    winRate: t.winRate ?? 0,
    grossWon: t.grossWon, grossLost: t.grossLost, netPips: t.net,
    best: t.best, worst: t.worst,
  };

  const recent = dedupeGold(rows).slice(0, 14).map((s) => {
    const win = goldIsWin(s); // breakeven-saved stops count as wins
    return { side: (s.direction || "").toLowerCase(), win, pips: Math.round(goldOutcomePips(s)), at: s.resolved_at || s.created_at };
  });

  // How many signals a follower account has actually placed so far (builds up live).
  const takenCount = new Set((fillsRaw ?? []).map((f) => String((f as { signal_key: string }).signal_key))).size;

  return json({ ok: true, record, takenCount, recent });
}
