import { type NextRequest } from "next/server";
import { gateAdmin, sportsDb } from "@/lib/sports/gate";
import { getProvider, type League } from "@/lib/sports/provider";
import { rankOpportunities } from "@/lib/sports/engine";
import { gradeBet, buildCalibration, type CalRec } from "@/lib/sports/grade";
import { clvPoints, americanToDecimal } from "@/lib/sports/odds";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Learning + results endpoint. Owner/admin-gated.
 *   action 'sync'  → update closing prices for pending calls, grade any whose
 *                    games are final (real scores), then recompute calibration.
 *   action 'stats' → the AI Call Record + "what the model learned" dashboard.
 * No fabrication: grading uses actual final scores; learning is pure math.
 */
const LEAGUES: League[] = ["NFL", "NBA", "MLB"];

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" },
  });
}
const norm = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

async function settingsKey(): Promise<string | null> {
  const db = sportsDb();
  if (!db) return null;
  const { data } = await db.from("sports_admin_settings").select("value").eq("key", "provider_key").maybeSingle();
  const v = data?.value as { odds_api_key?: string } | null;
  return v?.odds_api_key || null;
}

type RecRow = {
  id: string; league: string; matchup: string; bet_type: string; market: string | null; side: string | null;
  point: number | null; selection: string; odds_american: number | null; closing_american: number | null;
  implied_prob: number | null; model_prob: number | null; edge_pct: number | null; confidence: number | null;
  classification: string | null; result: string; clv_pct: number | null; game_date: string | null; commence_time: string | null;
};

async function doSync() {
  const db = sportsDb();
  if (!db) return { graded: 0, pending: 0, closingUpdated: 0, calBuckets: 0 };

  // 1) Pull pending calls.
  const { data: pend } = await db.from("sports_recommendations").select("*").eq("result", "pending").limit(500);
  const pending = (pend as RecRow[]) || [];

  // 2) Live odds + scores.
  const sk = await settingsKey();
  const { provider, configured } = getProvider(sk);
  let closingUpdated = 0, graded = 0;
  const scoresByLeague = new Map<string, { matchup: string; home: number | null; away: number | null; final: boolean }[]>();
  const priceMap = new Map<string, number>(); // league|matchup|selection -> current price

  if (configured) {
    // current prices (closing proxy)
    const oddsByLeague = await Promise.all(LEAGUES.map((lg) => provider.getOdds(lg)));
    LEAGUES.forEach((lg, i) => {
      const r = oddsByLeague[i];
      if (!r.ok) return;
      for (const o of rankOpportunities(r.data, "bovada")) {
        priceMap.set(`${o.league}|${norm(o.matchup)}|${norm(o.selection)}`, o.oddsAmerican);
      }
    });
    // final scores
    const gamesByLeague = await Promise.all(LEAGUES.map((lg) => provider.getGames(lg)));
    LEAGUES.forEach((lg, i) => {
      const r = gamesByLeague[i];
      if (!r.ok) return;
      scoresByLeague.set(lg, r.data.map((g) => ({
        matchup: `${g.awayTeam} @ ${g.homeTeam}`, home: g.homeScore, away: g.awayScore, final: g.status === "final",
      })));
    });
  }

  // 3) Update closing + grade.
  for (const rec of pending) {
    // closing price refresh
    const px = priceMap.get(`${rec.league}|${norm(rec.matchup)}|${norm(rec.selection)}`);
    if (px != null && px !== rec.closing_american) {
      await db.from("sports_recommendations").update({ closing_american: px }).eq("id", rec.id);
      rec.closing_american = px; closingUpdated++;
    }
    // grade if final
    const games = scoresByLeague.get(rec.league) || [];
    const g = games.find((x) => norm(x.matchup) === norm(rec.matchup) && x.final);
    if (g && g.home != null && g.away != null && rec.market) {
      const result = gradeBet({ market: rec.market, side: rec.side || "", point: rec.point, matchup: rec.matchup }, g.home, g.away);
      if (result) {
        const clv = clvPoints(rec.odds_american, rec.closing_american);
        await db.from("sports_recommendations").update({
          result, final_home: g.home, final_away: g.away, clv_pct: clv, settled_at: new Date().toISOString(),
        }).eq("id", rec.id);
        graded++;
      }
    }
  }

  // 4) Recompute calibration from all graded calls.
  const { data: allGraded } = await db.from("sports_recommendations").select("league,bet_type,classification,confidence,model_prob,odds_american,result,clv_pct").in("result", ["win", "loss", "push"]).limit(5000);
  const cal = buildCalibration(((allGraded as CalRec[]) || []));
  if (cal.length) {
    await db.from("sports_model_performance").upsert(
      cal.map((c) => ({ ...c, updated_at: new Date().toISOString() })),
      { onConflict: "bucket_type,bucket_key" },
    );
  }
  return { graded, pending: pending.length, closingUpdated, calBuckets: cal.length };
}

function summarize(rows: RecRow[]) {
  const settled = rows.filter((r) => ["win", "loss", "push"].includes(r.result));
  const wins = settled.filter((r) => r.result === "win").length;
  const losses = settled.filter((r) => r.result === "loss").length;
  const pushes = settled.filter((r) => r.result === "push").length;
  let net = 0, staked = 0, clvSum = 0, clvN = 0;
  for (const r of settled) {
    const dec = americanToDecimal(r.odds_american) ?? 1;
    if (r.result === "win") { net += dec - 1; staked += 1; }
    else if (r.result === "loss") { net += -1; staked += 1; }
    if (r.clv_pct != null) { clvSum += r.clv_pct; clvN++; }
  }
  const decided = wins + losses;
  return {
    totalCalls: rows.length, pending: rows.filter((r) => r.result === "pending").length,
    settled: settled.length, wins, losses, pushes,
    winRate: decided ? +(wins / decided * 100).toFixed(1) : null,
    netUnits: +net.toFixed(2), roiPct: staked ? +(net / staked * 100).toFixed(1) : null,
    avgClvPct: clvN ? +(clvSum / clvN).toFixed(2) : null,
  };
}

export async function POST(req: NextRequest) {
  const gate = await gateAdmin();
  if (!gate.ok) return json({ error: "not_found" }, 404);
  const db = sportsDb();
  if (!db) return json({ error: "db_unavailable" }, 500);

  let body: { action?: string } = {};
  try { body = await req.json(); } catch { /* default */ }
  const action = String(body.action || "stats");

  let sync: Awaited<ReturnType<typeof doSync>> | null = null;
  if (action === "sync") {
    try { sync = await doSync(); } catch (e) { return json({ error: "sync_failed", message: String(e).slice(0, 160) }, 200); }
  }

  // Stats (also returned after a sync).
  const { data: recData } = await db.from("sports_recommendations").select("*").order("generated_at", { ascending: false }).limit(500);
  const rows = (recData as RecRow[]) || [];
  const summary = summarize(rows);
  const { data: perf } = await db.from("sports_model_performance").select("*").limit(200);
  const graded = rows.filter((r) => ["win", "loss", "push"].includes(r.result)).slice(0, 40);
  const pendingCalls = rows.filter((r) => r.result === "pending").slice(0, 40);

  return json({ ok: true, sync, summary, performance: perf || [], gradedCalls: graded, pendingCalls, lastUpdated: new Date().toISOString() });
}
