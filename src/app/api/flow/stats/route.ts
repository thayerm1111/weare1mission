import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * FLOW track record — how the FLOW auto-engine has actually performed, read
 * straight from the `flow_managed_positions` outcome ledger the trade-manager
 * fills when each position closes. Every signed-in member can read this desk-wide
 * aggregate (same pattern as the GENX track record); it exposes ONLY engine-level
 * numbers, never per-member data.
 *
 * Outcomes (classifyOutcome in flowManage.ts):
 *   stop      — stopped out before +1R  → the ONLY loss
 *   breakeven — reached +1R (partial banked), runner scratched at break-even
 *   trail     — reached +1R, runner trailed out in profit below target
 *   target    — reached +1R and price hit the full target
 * A win is anything that isn't a stop (BE and better all bank the partial).
 * 'excluded' rows (bug-duplicate legs closed manually) are left out entirely.
 *
 * The same signal fans out across many accounts, so we DEDUPE by signal
 * (symbol+side+entry) and keep the largest-size fill as the representative — so
 * the record reads as one trade per signal, not one per account.
 */
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

type Row = {
  symbol: string; side: string; entry: number; qty: number;
  outcome: string | null; result_pips: number | null; resolved_at: string | null; created_at: string;
};

const WIN = new Set(["breakeven", "trail", "target"]);

type Tally = { trades: number; wins: number; stop: number; breakeven: number; trail: number; target: number; partials: number; pips: number };
const emptyTally = (): Tally => ({ trades: 0, wins: 0, stop: 0, breakeven: 0, trail: 0, target: 0, partials: 0, pips: 0 });
function add(t: Tally, o: string, pips: number) {
  t.trades++;
  t.pips += pips;
  if (o === "stop") t.stop++;
  else { t.wins++; if (o === "breakeven") t.breakeven++; else if (o === "trail") t.trail++; else if (o === "target") t.target++; }
  if (o === "breakeven" || o === "trail" || o === "target") t.partials++;
}
function summarize(t: Tally) {
  return {
    trades: t.trades,
    wins: t.wins,
    stops: t.stop,
    breakeven: t.breakeven,
    trailed: t.trail,
    fullTarget: t.target,
    partialsTaken: t.partials,
    pips: Math.round(t.pips),
    winRate: t.trades ? +((t.wins / t.trades) * 100).toFixed(0) : null,
  };
}

// GOLD comes from the GENX engine's own outcome ledger (genx_signals) — GENX is
// gold-only, so every decided signal is a gold trade. A GENX WIN banks the pips of
// the highest target it filled; a LOSS books the stop distance. We fold gold into
// the same desk-wide "flow results" so the member sees ONE record that already
// includes the gold wins + pips, plus a gold/forex split for the scoreboard.
type GoldSig = {
  created_at: string; resolved_at: string | null; direction: string | null; outcome: string | null;
  stop_pips: number | null; tp1_pips: number | null; tp2_pips: number | null; tp3_pips: number | null;
  tp1_hit: boolean | null; tp2_hit: boolean | null; tp3_hit: boolean | null;
};
function goldWinPips(s: GoldSig): number {
  if (s.tp3_hit && s.tp3_pips) return s.tp3_pips;
  if (s.tp2_hit && s.tp2_pips) return s.tp2_pips;
  if (s.tp1_hit && s.tp1_pips) return s.tp1_pips;
  return s.tp1_pips ?? 0;
}

export async function GET() {
  // Signed-in members only (protects the aggregate from anonymous scraping).
  const supabase = createClient();
  if (supabase) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
  }

  const admin = createAdminClient();
  if (!admin) return json({ error: "not_configured" }, 200);

  // FOREX comes from FLOW's own ledger, scoped to the LEAD account (every member
  // copies the lead, so this is the desk's canonical, divergence-free result).
  // GOLD comes from the GENX ledger below and is merged in.
  const LEAD_USER_ID = "3b5e06e5-258c-4880-b1f2-d1623cbca100";
  const [{ count: openCount }, { data, error }, gold] = await Promise.all([
    admin.from("flow_managed_positions").select("id", { count: "exact", head: true }).eq("status", "open").eq("user_id", LEAD_USER_ID).neq("symbol", "XAUUSD"),
    admin
      .from("flow_managed_positions")
      .select("symbol,side,entry,qty,outcome,result_pips,resolved_at,created_at")
      .eq("user_id", LEAD_USER_ID)
      .neq("symbol", "XAUUSD")
      .not("outcome", "is", null)
      .neq("outcome", "excluded")
      .order("resolved_at", { ascending: false, nullsFirst: false })
      .limit(2000),
    admin
      .from("genx_signals")
      .select("created_at,resolved_at,direction,outcome,stop_pips,tp1_pips,tp2_pips,tp3_pips,tp1_hit,tp2_hit,tp3_hit")
      .not("outcome", "is", null)
      .order("resolved_at", { ascending: false, nullsFirst: false })
      .limit(1000),
  ]);
  if (error) return json({ error: "load_failed", detail: error.message }, 200);

  const rows = (data || []) as Row[];

  // Dedupe the fan-out: one entry per SIGNAL (symbol|side|entry), keeping the
  // largest-size fill as the representative outcome for that signal.
  const bySignal = new Map<string, Row>();
  for (const r of rows) {
    const key = `${String(r.symbol).toUpperCase()}|${r.side}|${r.entry}`;
    const cur = bySignal.get(key);
    if (!cur || (r.qty ?? 0) > (cur.qty ?? 0)) bySignal.set(key, r);
  }
  const signals = [...bySignal.values()];

  // ── FOREX tally (from FLOW's outcome ledger) ──
  const overall = emptyTally();
  const perPairMap = new Map<string, Tally>();
  for (const s of signals) {
    const o = s.outcome as string;
    const pips = typeof s.result_pips === "number" ? s.result_pips : 0;
    add(overall, o, pips);
    const sym = String(s.symbol).toUpperCase();
    if (!perPairMap.has(sym)) perPairMap.set(sym, emptyTally());
    add(perPairMap.get(sym)!, o, pips);
  }
  const forexSummary = summarize(overall); // capture BEFORE folding gold in

  // ── GOLD tally (from the GENX ledger) — WIN → banked target pips, LOSS → stop. ──
  const goldRows = ((gold?.data || []) as GoldSig[]).filter((s) => s.outcome === "WIN" || s.outcome === "LOSS");
  const goldT = emptyTally();
  const goldRecent: { symbol: string; side: string; outcome: string; win: boolean; pips: number | null; at: string }[] = [];
  for (const s of goldRows) {
    const win = s.outcome === "WIN";
    const pips = win ? goldWinPips(s) : -(s.stop_pips ?? 0);
    // Map to the flow taxonomy: a gold win hit its target; a gold loss is a stop.
    add(goldT, win ? "target" : "stop", pips);
    goldRecent.push({
      symbol: "XAUUSD",
      side: (s.direction || "").toLowerCase(),
      outcome: win ? "target" : "stop",
      win,
      pips: Math.round(pips),
      at: s.resolved_at || s.created_at,
    });
  }
  const goldSummary = summarize(goldT);
  // Gold banks the WHOLE position at target (no half-partial), so don't inflate the
  // desk-wide "partials banked" count with gold wins.
  goldT.partials = 0;

  // ── Fold gold into the desk-wide totals + add its own per-pair row. ──
  overall.trades += goldT.trades; overall.wins += goldT.wins; overall.stop += goldT.stop;
  overall.target += goldT.target; overall.pips += goldT.pips;
  if (goldT.trades > 0) perPairMap.set("XAUUSD", goldT);

  const perPair = [...perPairMap.entries()]
    .map(([symbol, t]) => ({ symbol, ...summarize(t) }))
    .sort((a, b) => b.trades - a.trades);

  const forexRecent = signals.map((s) => ({
    symbol: String(s.symbol).toUpperCase(),
    side: (s.side || "").toLowerCase(),
    outcome: s.outcome as string,
    win: WIN.has(String(s.outcome)),
    pips: typeof s.result_pips === "number" ? Math.round(s.result_pips) : null,
    at: s.resolved_at || s.created_at,
  }));
  const recent = forexRecent.concat(goldRecent)
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(0, 10);

  return json({
    open: openCount ?? 0,
    ...summarize(overall),          // COMBINED desk-wide totals (forex + gold)
    perPair,
    recent,
    // Split for the scoreboard cards — same numbers, grouped by engine.
    gold: { wins: goldSummary.wins, losses: goldSummary.stops, pips: goldSummary.pips, winRate: goldSummary.winRate, trades: goldSummary.trades },
    forex: { wins: forexSummary.wins, stops: forexSummary.stops, pips: forexSummary.pips, winRate: forexSummary.winRate, trades: forexSummary.trades, open: openCount ?? 0 },
  }, 200);
}
