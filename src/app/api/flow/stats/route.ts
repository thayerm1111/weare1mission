import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { goldTally, dedupeGold, goldWinPips, goldLossPips, type GoldSig } from "@/lib/genx/goldRecord";

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
// gold-only, so every decided signal is a gold trade. The record is built by the
// shared goldRecord helper, which DEDUPES fan-out (the same call is recorded once
// per member/view, so raw sums multiply it) and derives pips from the filled PRICE
// at the standard gold pip (0.1) — so this reads as one honest per-signal record.

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
  const since7d = new Date(Date.now() - 7 * 24 * 3600e3).toISOString();
  const [{ count: openCount }, { data, error }, gold, { count: liveOpenCount }, fx7d, gd7d] = await Promise.all([
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
      .select("created_at,resolved_at,direction,outcome,entry,stop_loss,tp1,tp2,tp3,stop_pips,tp1_pips,tp2_pips,tp3_pips,tp1_hit,tp2_hit,tp3_hit")
      .not("outcome", "is", null)
      .order("resolved_at", { ascending: false, nullsFirst: false })
      .limit(4000),
    // LIVE NOW — every open desk position (forex + gold), lead-scoped.
    admin.from("flow_managed_positions").select("id", { count: "exact", head: true }).eq("status", "open").eq("user_id", LEAD_USER_ID),
    // PLAYS · 7D — desk signals CALLED in the last 7 days (deduped below).
    admin.from("flow_managed_positions").select("symbol,side,entry").eq("user_id", LEAD_USER_ID).neq("symbol", "XAUUSD").gte("created_at", since7d).limit(3000),
    admin.from("genx_signals").select("direction,entry,stop_loss,tp1").gte("created_at", since7d).limit(3000),
  ]);
  if (error) return json({ error: "load_failed", detail: error.message }, 200);

  // Deduped desk activity for the last 7 days (fan-out collapsed on both ledgers).
  const forex7d = new Set(((fx7d.data || []) as { symbol: string; side: string; entry: number }[]).map((r) => `${String(r.symbol).toUpperCase()}|${r.side}|${r.entry}`)).size;
  const gold7d = new Set(((gd7d.data || []) as { direction: string | null; entry: number | null; stop_loss: number | null; tp1: number | null }[]).map((r) => `${String(r.direction || "").toLowerCase()}|${r.entry ?? "?"}|${r.stop_loss ?? "?"}|${r.tp1 ?? "?"}`)).size;
  const plays7d = forex7d + gold7d;
  const liveOpen = liveOpenCount ?? 0;

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
  let forexGross = 0; // pips banked by WINNERS only (losses shown in W/L, not netted out)
  for (const s of signals) {
    const o = s.outcome as string;
    const pips = typeof s.result_pips === "number" ? s.result_pips : 0;
    if (WIN.has(o)) forexGross += pips;
    add(overall, o, pips);
    const sym = String(s.symbol).toUpperCase();
    if (!perPairMap.has(sym)) perPairMap.set(sym, emptyTally());
    add(perPairMap.get(sym)!, o, pips);
  }
  const forexSummary = summarize(overall); // capture BEFORE folding gold in

  // ── GOLD tally — deduped (one row per signal) + price-derived, via goldRecord. ──
  const gRows = (gold?.data || []) as GoldSig[];
  const gT = goldTally(gRows);      // per-signal record (fan-out collapsed, pips from price)
  const gDed = dedupeGold(gRows);   // deduped rows, for the recent feed
  const goldGross = gT.grossWon;    // pips banked by GOLD winners (deduped)
  const goldRecent = gDed.map((s) => {
    const win = s.outcome === "WIN";
    const pips = win ? goldWinPips(s) : -goldLossPips(s);
    const hitTp = s.tp3_hit ? 3 : s.tp2_hit ? 2 : s.tp1_hit ? 1 : 0;
    return { symbol: "XAUUSD", side: (s.direction || "").toLowerCase(), outcome: win ? "target" : "stop", win, hitTp, pips: Math.round(pips), at: s.resolved_at || s.created_at || "" };
  });
  const goldSummary = { wins: gT.wins, stops: gT.losses, winRate: gT.winRate, trades: gT.trades };

  // ── Fold gold into the desk-wide totals + add its own per-pair row. `pips` is NET. ──
  overall.trades += gT.trades; overall.wins += gT.wins; overall.stop += gT.losses;
  overall.target += gT.wins; overall.pips += gT.net;
  if (gT.trades > 0) perPairMap.set("XAUUSD", { trades: gT.trades, wins: gT.wins, stop: gT.losses, breakeven: 0, trail: 0, target: gT.wins, partials: 0, pips: gT.net });

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
  // Separate feeds so the Floor can show GENX (gold) and FLOW (forex) on their own.
  const goldFeed = [...goldRecent].sort((a, b) => new Date(b.at || "").getTime() - new Date(a.at || "").getTime()).slice(0, 16);
  const forexFeed = [...forexRecent].sort((a, b) => new Date(b.at || "").getTime() - new Date(a.at || "").getTime()).slice(0, 16);

  return json({
    open: openCount ?? 0,
    ...summarize(overall),          // COMBINED desk-wide totals (forex + gold); `pips` here is NET (for the detailed FLOW track record)
    liveOpen,                       // open desk positions right now (forex + gold)
    plays7d,                        // deduped desk signals called in the last 7 days
    pipsNet: Math.round(overall.pips), // NET desk pips (wins − losses), deduped — the honest "how far ahead" figure
    pipsWon: Math.round(goldGross + forexGross), // GROSS pips banked by winners (kept for the legacy "Pips won" card)
    perPair,
    recent,
    goldRecent: goldFeed,   // GENX gold results (deduped) — for the GENX blotter
    forexRecent: forexFeed, // FLOW forex trades — for the FLOW results ledger
    // Split for the scoreboard cards — grouped by engine, pips = GROSS pips won.
    gold: { wins: goldSummary.wins, losses: goldSummary.stops, pips: Math.round(goldGross), winRate: goldSummary.winRate, trades: goldSummary.trades },
    forex: { wins: forexSummary.wins, stops: forexSummary.stops, pips: Math.round(forexGross), winRate: forexSummary.winRate, trades: forexSummary.trades, open: openCount ?? 0 },
  }, 200);
}
