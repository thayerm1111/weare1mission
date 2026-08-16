import { type NextRequest } from "next/server";
import { gateAdmin, sportsDb } from "@/lib/sports/gate";
import { profitOnStake, clvPoints } from "@/lib/sports/odds";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Bet tracker + performance dashboard. Owner/admin-gated. Stores real, tracked
 * bets and grades P&L / CLV. Historical performance is reported as history only,
 * never as proof of future results (the UI states this).
 */
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" },
  });
}

type BetRow = {
  id: string; placed_on: string; league: string; matchup: string; bet_type: string;
  selection: string; odds_american: number | null; closing_american: number | null;
  stake: number; result: string; payout: number | null; pnl: number | null;
  confidence: number | null; edge_pct: number | null; clv_pct: number | null;
};

function summarize(rows: BetRow[]) {
  const settled = rows.filter((r) => ["win", "loss", "push"].includes(r.result));
  const wins = settled.filter((r) => r.result === "win").length;
  const losses = settled.filter((r) => r.result === "loss").length;
  const pushes = settled.filter((r) => r.result === "push").length;
  const staked = settled.reduce((s, r) => s + (r.stake || 0), 0);
  const pnl = settled.reduce((s, r) => s + (r.pnl ?? 0), 0);
  const clvVals = settled.map((r) => r.clv_pct).filter((x): x is number => x != null);
  const oddsVals = rows.map((r) => r.odds_american).filter((x): x is number => x != null);
  const decided = wins + losses;
  const byKey = (keyFn: (r: BetRow) => string) => {
    const m: Record<string, { bets: number; wins: number; losses: number; pushes: number; pnl: number }> = {};
    for (const r of settled) {
      const k = keyFn(r);
      m[k] ??= { bets: 0, wins: 0, losses: 0, pushes: 0, pnl: 0 };
      m[k].bets++;
      if (r.result === "win") m[k].wins++;
      else if (r.result === "loss") m[k].losses++;
      else if (r.result === "push") m[k].pushes++;
      m[k].pnl += r.pnl ?? 0;
    }
    return m;
  };
  return {
    totalBets: rows.length,
    settled: settled.length,
    pending: rows.filter((r) => r.result === "pending").length,
    wins, losses, pushes,
    winRate: decided ? +(wins / decided * 100).toFixed(1) : null,
    staked: +staked.toFixed(2),
    pnl: +pnl.toFixed(2),
    roiPct: staked ? +(pnl / staked * 100).toFixed(1) : null,
    avgOdds: oddsVals.length ? Math.round(oddsVals.reduce((a, b) => a + b, 0) / oddsVals.length) : null,
    avgClvPct: clvVals.length ? +(clvVals.reduce((a, b) => a + b, 0) / clvVals.length).toFixed(2) : null,
    byBetType: byKey((r) => r.bet_type || "unknown"),
    byLeague: byKey((r) => r.league || "unknown"),
    byConfidenceBand: byKey((r) => {
      const c = r.confidence;
      if (c == null) return "unknown";
      const lo = Math.floor(c / 10) * 10;
      return `${lo}-${lo + 9}`;
    }),
  };
}

export async function POST(req: NextRequest) {
  const gate = await gateAdmin();
  if (!gate.ok) return json({ error: "not_found" }, 404);
  const db = sportsDb();
  if (!db) return json({ error: "db_unavailable", message: "Service-role DB not configured." }, 500);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const action = String(body.action || "list");

  if (action === "list") {
    const { data, error } = await db.from("sports_bet_results").select("*").order("placed_on", { ascending: false }).limit(500);
    if (error) return json({ error: "query_failed", message: error.message }, 500);
    const rows = (data ?? []) as BetRow[];
    return json({ ok: true, bets: rows, summary: summarize(rows) });
  }

  if (action === "add") {
    const b = body as {
      league?: string; matchup?: string; bet_type?: string; selection?: string;
      odds_american?: number; stake?: number; confidence?: number; edge_pct?: number; model_version?: string; notes?: string;
    };
    if (!b.league || !b.matchup || !b.selection) return json({ error: "missing_fields", message: "league, matchup, selection required." }, 400);
    const insert = {
      league: b.league, matchup: b.matchup, bet_type: b.bet_type || "moneyline", selection: b.selection,
      odds_american: b.odds_american ?? null, stake: b.stake ?? 0, result: "pending",
      confidence: b.confidence ?? null, edge_pct: b.edge_pct ?? null, model_version: b.model_version ?? "consensus-v1", notes: b.notes ?? null,
    };
    const { data, error } = await db.from("sports_bet_results").insert(insert).select("*").maybeSingle();
    if (error) return json({ error: "insert_failed", message: error.message }, 500);
    return json({ ok: true, bet: data });
  }

  if (action === "grade") {
    const b = body as { id?: string; result?: string; closing_american?: number };
    if (!b.id || !b.result) return json({ error: "missing_fields", message: "id and result required." }, 400);
    const { data: cur, error: e1 } = await db.from("sports_bet_results").select("*").eq("id", b.id).maybeSingle();
    if (e1 || !cur) return json({ error: "not_found_row", message: e1?.message || "Bet not found." }, 404);
    const row = cur as BetRow;
    const stake = row.stake || 0;
    let payout: number | null = null;
    let pnl: number | null = null;
    if (b.result === "win") { const p = profitOnStake(stake, row.odds_american); pnl = p; payout = p == null ? null : stake + p; }
    else if (b.result === "loss") { pnl = -stake; payout = 0; }
    else if (b.result === "push" || b.result === "void") { pnl = 0; payout = stake; }
    const closing = b.closing_american ?? row.closing_american ?? null;
    const clv = clvPoints(row.odds_american, closing);
    const { data, error } = await db.from("sports_bet_results").update({
      result: b.result, closing_american: closing, payout, pnl, clv_pct: clv, updated_at: new Date().toISOString(),
    }).eq("id", b.id).select("*").maybeSingle();
    if (error) return json({ error: "update_failed", message: error.message }, 500);
    return json({ ok: true, bet: data });
  }

  if (action === "delete") {
    const id = String(body.id || "");
    if (!id) return json({ error: "missing_id" }, 400);
    const { error } = await db.from("sports_bet_results").delete().eq("id", id);
    if (error) return json({ error: "delete_failed", message: error.message }, 500);
    return json({ ok: true });
  }

  return json({ error: "unknown_action" }, 400);
}
