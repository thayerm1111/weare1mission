import { type NextRequest } from "next/server";
import { gateAdmin, sportsDb } from "@/lib/sports/gate";
import { getProvider, type League } from "@/lib/sports/provider";
import { rankOpportunities, bestMoneylines, type Opportunity } from "@/lib/sports/engine";
import { classify } from "@/lib/sports/odds";
import { calibrationFactor } from "@/lib/sports/grade";
import { getGameContext } from "@/lib/sports/context";
import { computeGameModel, type GameModel } from "@/lib/sports/model";
import type { GameOdds } from "@/lib/sports/provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Data endpoint for OM Sports AI. Owner/admin-gated. Pulls REAL data through the
 * provider abstraction and (for BEST BETS) runs the deterministic edge engine.
 * If no provider is configured or a call fails, it returns an explicit
 * unavailable/stale marker instead of fabricated games/odds. The provider key
 * lives server-side only (env ODDS_API_KEY, or the admin-only settings row).
 */
const LEAGUES: League[] = ["NFL", "NBA", "MLB"];

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" },
  });
}

async function settingsKey(): Promise<string | null> {
  const db = sportsDb();
  if (!db) return null;
  const { data } = await db.from("sports_admin_settings").select("value").eq("key", "provider_key").maybeSingle();
  const v = data?.value as { odds_api_key?: string } | null;
  return v?.odds_api_key || null;
}

// The book you actually bet at — its exact line is what the engine evaluates.
// Defaults to Bovada; overridable via the preferred_book setting.
async function preferredBook(): Promise<string> {
  const db = sportsDb();
  if (!db) return "bovada";
  const { data } = await db.from("sports_admin_settings").select("value").eq("key", "preferred_book").maybeSingle();
  const v = data?.value as { book?: string } | null;
  return (v?.book || "bovada").toLowerCase();
}

async function bumpUsage(apiCalls: number) {
  try {
    const db = sportsDb();
    if (!db) return;
    const { data } = await db.from("sports_admin_settings").select("value").eq("key", "usage").maybeSingle();
    const cur = (data?.value as { api_calls?: number; ai_tokens_in?: number; ai_tokens_out?: number } | null) ?? {};
    await db.from("sports_admin_settings").upsert({
      key: "usage",
      value: { ...cur, api_calls: (cur.api_calls ?? 0) + apiCalls },
      updated_at: new Date().toISOString(),
    });
  } catch { /* usage tracking is best-effort */ }
}

// Load the learned calibration factors (league × bet-type) from performance.
async function loadCalibration(): Promise<{ bucket_type: string; bucket_key: string; calibration_factor: number }[]> {
  const db = sportsDb();
  if (!db) return [];
  const { data } = await db.from("sports_model_performance").select("bucket_type,bucket_key,calibration_factor").eq("bucket_type", "league_bettype");
  return (data as { bucket_type: string; bucket_key: string; calibration_factor: number }[]) || [];
}

// Apply learning: nudge confidence by the segment's historical calibration,
// then re-classify. Segments that have under-performed get quieter.
function applyCalibration(opps: Opportunity[], cal: { bucket_type: string; bucket_key: string; calibration_factor: number }[]): Opportunity[] {
  if (!cal.length) return opps;
  return opps.map((o) => {
    const f = calibrationFactor(cal, o.league, o.betType);
    if (f === 1) return o;
    const confidence = Math.max(0, Math.min(100, Math.round(o.confidence * f)));
    return { ...o, confidence, classification: classify(o.edgePts, confidence) };
  });
}

// Auto-log the bets the engine actually CALLS (ELITE/STRONG/LEAN). Idempotent:
// one row per day/game/market/selection, keeping the first-seen call price so
// CLV can be measured against the closing line later.
async function logCalls(opps: Opportunity[]) {
  try {
    const db = sportsDb();
    if (!db) return;
    const called = opps.filter((o) => ["ELITE", "STRONG", "LEAN"].includes(o.classification) && o.dataQuality !== "LOW");
    if (!called.length) return;
    const rows = called.slice(0, 40).map((o) => ({
      league: o.league, matchup: o.matchup, commence_time: o.commenceTime,
      game_date: o.commenceTime ? new Date(o.commenceTime).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10),
      bet_type: o.betType, market: o.market, side: o.side, point: o.point, selection: o.selection,
      book: o.book, odds_american: o.oddsAmerican, implied_prob: o.impliedProb, model_prob: o.modelProb,
      edge_pct: o.edgePts, confidence: o.confidence, data_quality: o.dataQuality, classification: o.classification,
      reasoning: o.reasoning, model_version: "consensus-cal-v1", result: "pending", stake: 1, called: true,
    }));
    await db.from("sports_recommendations").upsert(rows, { onConflict: "game_date,league,matchup,bet_type,selection", ignoreDuplicates: true });
  } catch { /* logging is best-effort — never block the response */ }
}

// Build the AI prediction model per game from REAL ESPN context (records, home/road
// splits, MLB starters, injuries). The per-league ESPN feeds are cached/deduped in
// context.ts, so a whole slate costs ~one scoreboard + one injury fetch per league
// (plus MLB weather). Any game we can't match/model simply gets no entry and the
// engine falls back to the market consensus for it — never a guessed number.
async function buildModels(games: GameOdds[]): Promise<Map<string, GameModel>> {
  const map = new Map<string, GameModel>();
  await Promise.all(games.map(async (g) => {
    try {
      const ctx = await getGameContext(g.league, g.homeTeam, g.awayTeam);
      const model = computeGameModel(g.league, ctx, null);
      if (model.applied) map.set(g.gameId, model);
    } catch { /* one game's context failing must not sink the batch */ }
  }));
  return map;
}

export async function POST(req: NextRequest) {
  const gate = await gateAdmin();
  if (!gate.ok) return json({ error: "not_found" }, 404); // no signal the feature exists

  let body: { action?: string; league?: string; gameId?: string } = {};
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const action = String(body.action || "analyze");

  const sk = await settingsKey();
  const { provider, configured, via } = getProvider(sk);
  const stamp = new Date().toISOString();

  if (!configured) {
    return json({
      configured: false,
      via,
      message: "DATA UNAVAILABLE — no sports-data provider is connected. Add an Odds API key in Settings (or set ODDS_API_KEY).",
      lastUpdated: stamp,
    });
  }

  const wantLeagues: League[] = body.league && LEAGUES.includes(body.league as League) ? [body.league as League] : LEAGUES;

  try {
    if (action === "games" || action === "live") {
      const results = await Promise.all(wantLeagues.map(async (lg) => {
        const r = action === "live" ? await provider.getLiveGames(lg) : await provider.getGames(lg);
        return { league: lg, ...(r.ok ? { ok: true, games: r.data } : { ok: false, reason: r.reason, message: r.message }) };
      }));
      await bumpUsage(wantLeagues.length);
      return json({ configured: true, via, action, leagues: results, lastUpdated: stamp });
    }

    if (action === "odds") {
      const results = await Promise.all(wantLeagues.map(async (lg) => {
        const r = await provider.getOdds(lg);
        return { league: lg, ...(r.ok ? { ok: true, odds: r.data } : { ok: false, reason: r.reason, message: r.message }) };
      }));
      await bumpUsage(wantLeagues.length);
      return json({ configured: true, via, action, leagues: results, lastUpdated: stamp });
    }

    // analyze | best-bets | moneylines -> pull odds, run the edge engine.
    const oddsByLeague = await Promise.all(wantLeagues.map(async (lg) => {
      const r = await provider.getOdds(lg);
      return { league: lg, ok: r.ok, data: r.ok ? r.data : [], message: r.ok ? null : r.message };
    }));
    await bumpUsage(wantLeagues.length);

    const allGames = oddsByLeague.flatMap((x) => x.data);
    const unavailable = oddsByLeague.filter((x) => !x.ok).map((x) => ({ league: x.league, message: x.message }));

    if (!allGames.length) {
      return json({
        configured: true, via, action,
        opportunities: [],
        message: unavailable.length
          ? "LIVE DATA TEMPORARILY UNAVAILABLE for some leagues."
          : "NO HIGH-QUALITY OPPORTUNITIES CURRENTLY AVAILABLE — no games are currently priced.",
        unavailable, lastUpdated: stamp,
      });
    }

    const pref = await preferredBook();
    const cal = await loadCalibration();
    const models = await buildModels(allGames);
    const rankedRaw = action === "moneylines" ? bestMoneylines(allGames, pref, models) : rankOpportunities(allGames, pref, models);
    const ranked = applyCalibration(rankedRaw, cal);
    void logCalls(ranked); // fire-and-forget: record every called bet
    const positive = ranked.filter((o) => o.edgePts > 0);
    const feed = action === "best-bets" ? positive : ranked;

    return json({
      configured: true, via, action,
      preferredBook: pref,
      count: feed.length,
      opportunities: feed.slice(0, 60),
      note: positive.length === 0
        ? "NO HIGH-QUALITY OPPORTUNITIES CURRENTLY AVAILABLE — no positive price edge vs consensus right now. Do not chase action."
        : null,
      unavailable, lastUpdated: stamp,
    });
  } catch (e) {
    return json({ configured: true, via, error: "provider_error", message: `LIVE DATA TEMPORARILY UNAVAILABLE: ${String(e).slice(0, 160)}`, lastUpdated: stamp }, 200);
  }
}
