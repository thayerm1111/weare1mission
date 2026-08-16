import { type NextRequest } from "next/server";
import { gateAdmin, sportsDb } from "@/lib/sports/gate";
import { getProvider, type League } from "@/lib/sports/provider";
import { rankOpportunities } from "@/lib/sports/engine";
import { buildStakingPlan, type PlanStyle } from "@/lib/sports/plan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Staking plan endpoint. Owner/admin-gated. Pulls REAL odds, ranks value with
 * the edge engine (Bovada-first, outliers already flagged LOW), and allocates
 * the chosen budget deterministically via buildStakingPlan. No fabrication.
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
async function preferredBook(): Promise<string> {
  const db = sportsDb();
  if (!db) return "bovada";
  const { data } = await db.from("sports_admin_settings").select("value").eq("key", "preferred_book").maybeSingle();
  const v = data?.value as { book?: string } | null;
  return (v?.book || "bovada").toLowerCase();
}

export async function POST(req: NextRequest) {
  const gate = await gateAdmin();
  if (!gate.ok) return json({ error: "not_found" }, 404);

  let body: { budget?: number; style?: string } = {};
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const budget = Math.max(50, Math.min(350, Math.round(Number(body.budget) || 200)));
  const style = (["conservative", "balanced", "aggressive"].includes(String(body.style)) ? body.style : "balanced") as PlanStyle;

  const sk = await settingsKey();
  const { provider, configured } = getProvider(sk);
  if (!configured) {
    return json({ configured: false, message: "DATA UNAVAILABLE — connect a provider in Settings before building a plan." });
  }

  const pref = await preferredBook();
  const stamp = new Date().toISOString();
  try {
    const odds = (await Promise.all(LEAGUES.map((lg) => provider.getOdds(lg)))).flatMap((r) => (r.ok ? r.data : []));
    if (!odds.length) {
      return json({ configured: true, plan: null, message: "No games are currently priced — nothing to build a plan from.", lastUpdated: stamp });
    }
    const ranked = rankOpportunities(odds, pref);
    const plan = buildStakingPlan(ranked, budget, style);
    return json({ configured: true, plan, lastUpdated: stamp });
  } catch (e) {
    return json({ configured: true, plan: null, message: `LIVE DATA TEMPORARILY UNAVAILABLE: ${String(e).slice(0, 140)}`, lastUpdated: stamp });
  }
}
