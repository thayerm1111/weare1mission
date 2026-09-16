import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildRealResults, type RealRow } from "@/lib/genx/realResults";
import { statsSince } from "@/lib/genx/statsSince";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * DESK RECORD — GENX GOLD ONLY, REAL TRADES ONLY, FROM THE RESET (owner 09-16:
 * "completely restart over — everything 0 — start recording now").
 *
 * Every number here comes from trades GENX actually fired to member broker accounts
 * (flow_managed_positions, XAUUSD) opened at or after STATS_SINCE. No forex, no signal
 * ledger, nothing from before the reset. Trade history itself is kept in the database;
 * only what the site counts starts over. Set env FLOOR_STATS_SINCE (ISO time) to move
 * the reset point without a deploy.
 *
 * A "trade" in the desk totals is one GENX fire (same side within 10 min, across all
 * accounts), graded once every account that took it has closed, at the average realized
 * result on those accounts. The four management results (BE on / BE off / self manage /
 * play out) are per account — see src/lib/genx/realResults.ts.
 *
 * The response keeps the field names older panels read (forex, perPair, recent …); the
 * forex fields are always empty.
 */
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export async function GET() {
  const supabase = createClient();
  if (supabase) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
  }
  const admin = createAdminClient();
  if (!admin) return json({ error: "not_configured" }, 200);

  const since = statsSince();
  const since7d = new Date(Math.max(Date.parse(since), Date.now() - 7 * 24 * 3600e3)).toISOString();

  const { data, error } = await admin
    .from("flow_managed_positions")
    .select("side,outcome,result_pips,created_at,resolved_at,manage_style,status")
    .eq("symbol", "XAUUSD")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(20000);
  if (error) return json({ error: "load_failed", detail: error.message }, 200);

  const rows = (data || []) as RealRow[];
  const real = buildRealResults(rows);
  const s = real.summary;
  const liveOpen = rows.filter((r) => r.status === "open").length;
  const plays7d = real.recentFiresAll.filter((f) => f.at >= since7d).length;

  const closedFires = real.recentFiresAll.filter((f) => f.open === 0 && f.avgPips != null);
  const recent = closedFires.slice(0, 16).map((f) => {
    const pips = f.avgPips ?? 0;
    return { symbol: "XAUUSD", side: f.side, outcome: pips > 0 ? "target" : pips < 0 ? "stop" : "breakeven", win: pips > 0, hitTp: 0, pips, at: f.at, accounts: f.accounts, results: f.results };
  });
  const breakeven = closedFires.filter((f) => (f.avgPips ?? 0) === 0).length;
  const decided = s.wins + s.losses;

  return json({
    since,
    open: liveOpen,
    liveOpen,
    plays7d,
    trades: s.trades,
    wins: s.wins,
    stops: s.losses,
    breakeven,
    trailed: 0,
    fullTarget: 0,
    partialsTaken: 0,
    pips: s.netPips,
    pipsNet: s.netPips,
    pipsWon: s.grossWon,
    winRate: decided ? Math.round((s.wins / decided) * 100) : null,
    perPair: s.trades ? [{ symbol: "XAUUSD", trades: s.trades, wins: s.wins, stops: s.losses, breakeven, trailed: 0, fullTarget: 0, partialsTaken: 0, pips: s.netPips, winRate: s.winRate }] : [],
    recent: recent.slice(0, 10),
    goldRecent: recent,
    forexRecent: [],
    gold: { wins: s.wins, losses: s.losses, pips: s.grossWon, netPips: s.netPips, winRate: s.winRate, trades: s.trades },
    forex: { wins: 0, stops: 0, pips: 0, winRate: null, trades: 0, open: 0 },
    genxReal: { fires: real.fires, openTrades: real.openTrades, buckets: real.buckets, recentFires: real.recentFires },
  }, 200);
}
