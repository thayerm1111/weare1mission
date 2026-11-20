import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildRealResults, type RealRow } from "@/lib/genx/realResults";
import { statsSince } from "@/lib/genx/statsSince";
import { allRows, type Paged } from "@/lib/floor/rows";

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
 *
 * THE WHOLE RECORD (11-20). Two things were keeping trades out of it:
 *   1. One request returns at most 1,000 rows, whatever `limit` asks for, and says nothing when it cuts
 *      the rest off. With more than three thousand account-trades since the reset, the record was being
 *      folded from the newest thousand — it counted from early November, not from the reset it names.
 *      The rows are now read a thousand at a time until there are no more (src/lib/floor/rows.ts), and
 *      a read that cannot be finished is reported as a failure rather than shown as the record.
 *   2. A row retired without a result (outcome 'excluded': the broker stopped listing the position
 *      before its close was booked) was folded as a trade still open, so the WHOLE GENX trade it belonged
 *      to — every other account's real result with it — was never graded. Those rows are dropped before
 *      the fold, as the Live Trade card has done since 09-29; the trade is graded on the accounts that
 *      have a result. `liveOpen` already counted only rows whose status is open.
 * Neither changes what a trade is, how it is graded, or the reset point.
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

  const read = await allRows<RealRow>(() => admin
    .from("flow_managed_positions")
    .select("side,outcome,result_pips,created_at,resolved_at,manage_style,status")
    .eq("symbol", "XAUUSD")
    .gte("created_at", since)
    // Oldest first, so a trade opened while the pages are being read lands after the last page instead of
    // pushing every row down one and being read twice. The fold sorts for itself.
    .order("created_at", { ascending: true })
    .order("id", { ascending: true }) as unknown as Paged);
  if (!read.complete) return json({ error: "load_failed", detail: "the record could not be read in full" }, 200);

  const rows = read.rows.filter((r) => r.outcome !== "excluded");
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
