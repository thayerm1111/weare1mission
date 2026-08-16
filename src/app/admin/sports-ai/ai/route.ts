import { type NextRequest } from "next/server";
import { gateAdmin, sportsDb } from "@/lib/sports/gate";
import { getProvider, type League } from "@/lib/sports/provider";
import { rankOpportunities } from "@/lib/sports/engine";
import { fmtAmerican } from "@/lib/sports/odds";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Betting AI chat — server-side Anthropic (no key in the browser), owner/admin
 * gated. CRITICAL: before answering, it pulls CURRENT real odds + the edge
 * engine's ranked opportunities and injects them as context, and the system
 * prompt forbids inventing games/odds/injuries/lines. If no live data is
 * available, it must say so and refuse to generate a bet.
 */
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.OM_AI_MODEL || "claude-sonnet-4-6";
const LEAGUES: League[] = ["NFL", "NBA", "MLB"];

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" },
  });
}

const SYSTEM = `You are OM SPORTS AI — a disciplined, quantitative sports-betting analyst for the admin's PRIVATE use. You cover NFL, NBA, and MLB.

ABSOLUTE RULES (never break these):
1. REAL DATA ONLY. You may ONLY reference games, odds, prices, and edges that appear in the CURRENT DATA block provided to you in the user message. NEVER invent or recall from memory any game, score, line, odds, injury, starting pitcher, QB, lineup, or stat. If the data you need is not in the CURRENT DATA block, say "DATA UNAVAILABLE — I won't generate that bet" and stop.
2. If the CURRENT DATA block says data is unavailable or empty, do NOT produce a pick. Say there are no priced games / no data right now.
3. Be comfortable saying "NO BET" and "NO HIGH-QUALITY OPPORTUNITIES." Do not chase action. Never call any bet or parlay "guaranteed," "safe," "lock," or "certain."
4. Edges here are price/consensus edges (best available price vs no-vig market consensus). Inputs currently exclude injuries/lineups/situational data, so keep confidence honest and flag that limitation.
5. This is analysis for the admin's own decisions — never place or submit bets. End actionable answers with a short, clear rationale (odds, implied vs fair prob, edge, and what would invalidate it).

Tone: sharp, concise, institutional — like a trading desk, not a hype tout.`;

async function settingsKey(): Promise<string | null> {
  const db = sportsDb();
  if (!db) return null;
  const { data } = await db.from("sports_admin_settings").select("value").eq("key", "provider_key").maybeSingle();
  const v = data?.value as { odds_api_key?: string } | null;
  return v?.odds_api_key || null;
}

async function buildDataContext(): Promise<string> {
  const sk = await settingsKey();
  const { provider, configured } = getProvider(sk);
  if (!configured) return "CURRENT DATA: DATA UNAVAILABLE — no sports-data provider is connected. Do not generate any bet.";
  try {
    const odds = (await Promise.all(LEAGUES.map((lg) => provider.getOdds(lg))))
      .flatMap((r) => (r.ok ? r.data : []));
    if (!odds.length) return "CURRENT DATA: No games are currently priced across NFL/NBA/MLB. Treat as NO GAMES AVAILABLE.";
    const ranked = rankOpportunities(odds).slice(0, 25);
    const lines = ranked.map((o) =>
      `- [${o.league}] ${o.matchup} | ${o.selection} @ ${fmtAmerican(o.oddsAmerican)} (${o.book}) | implied ${(o.impliedProb * 100).toFixed(1)}% vs fair ${(o.modelProb * 100).toFixed(1)}% | edge ${o.edgePts.toFixed(1)}pts | conf ${o.confidence} | ${o.classification} | data ${o.dataQuality}`
    );
    return `CURRENT DATA (real odds pulled just now; ${ranked.length} of ${rankOpportunities(odds).length} opportunities shown, ranked by price edge):\n${lines.join("\n")}\n\nOnly discuss games/lines in this list.`;
  } catch (e) {
    return `CURRENT DATA: LIVE DATA TEMPORARILY UNAVAILABLE (${String(e).slice(0, 120)}). Do not generate a bet.`;
  }
}

export async function POST(req: NextRequest) {
  const gate = await gateAdmin();
  if (!gate.ok) return json({ error: "not_found" }, 404);

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return json({ notConfigured: true, message: "AI is server-backed but ANTHROPIC_API_KEY is not set." }, 200);

  let body: { prompt?: unknown; messages?: unknown } = {};
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }

  let messages: { role: "user" | "assistant"; content: string }[] = [];
  if (Array.isArray(body.messages)) {
    messages = (body.messages as { role: "user" | "assistant"; content: string }[])
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .slice(-10)
      .map((m) => ({ role: m.role, content: String(m.content).slice(0, 8000) }));
  } else if (typeof body.prompt === "string" && body.prompt.trim()) {
    messages = [{ role: "user", content: body.prompt.slice(0, 8000) }];
  }
  if (!messages.length) return json({ error: "no_prompt" }, 400);

  // Inject fresh real-data context ahead of the latest user turn.
  const ctx = await buildDataContext();
  const last = messages[messages.length - 1];
  last.content = `${ctx}\n\n----\nQUESTION: ${last.content}`;

  try {
    const r = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: 1600, system: SYSTEM, messages }),
    });
    const j = await r.json();
    if (!r.ok) return json({ error: "ai_error", detail: (j?.error?.message || "").slice(0, 300) }, 502);
    // best-effort token usage tracking
    try {
      const db = sportsDb();
      if (db) {
        const { data } = await db.from("sports_admin_settings").select("value").eq("key", "usage").maybeSingle();
        const cur = (data?.value as Record<string, number> | null) ?? {};
        await db.from("sports_admin_settings").upsert({
          key: "usage",
          value: { ...cur, ai_tokens_in: (cur.ai_tokens_in ?? 0) + (j?.usage?.input_tokens ?? 0), ai_tokens_out: (cur.ai_tokens_out ?? 0) + (j?.usage?.output_tokens ?? 0) },
          updated_at: new Date().toISOString(),
        });
      }
    } catch { /* ignore */ }
    const text = Array.isArray(j?.content)
      ? j.content.filter((b: { type?: string }) => b?.type === "text").map((b: { text?: string }) => b.text ?? "").join("").trim()
      : "";
    return json({ ok: true, reply: text || "No answer produced." }, 200);
  } catch (e) {
    return json({ error: "server_error", detail: String(e).slice(0, 200) }, 500);
  }
}
