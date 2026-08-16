import { type NextRequest } from "next/server";
import { gateAdmin } from "@/lib/sports/gate";
import { getGameContext, type GameContext } from "@/lib/sports/context";
import type { League } from "@/lib/sports/provider";
import { fmtAmerican } from "@/lib/sports/odds";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Deep, per-bet breakdown. Owner/admin-gated.
 *
 * It returns TWO things:
 *   1) `context` — REAL data pulled live from ESPN (records, home/road splits,
 *      probable pitchers + ERA, injuries) and Open-Meteo (weather for outdoor
 *      games). The UI renders these verbatim, so they can NEVER be fabricated.
 *   2) `read` — an AI narrative that INTERPRETS only the real data above (the
 *      "why" behind the bet). The prompt forbids inventing any fact; anything
 *      missing is called out as "not available".
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

const SYSTEM = `You are OM SPORTS AI writing the full reasoning behind ONE bet for the admin's private use.

HARD RULES:
- Use ONLY the facts in the DATA block. NEVER invent or recall any record, pitcher, ERA, injury, weather value, score, or trend that is not printed there.
- If a factor says "not available", explicitly say it's not available and do not substitute a guess. It is fine — and expected — to say a factor is unknown.
- The "edge" is a price gap vs market consensus, not a guarantee. If the edge is very large, treat it as a likely stale/limited line, not free money, and say so.
- Never call a bet safe, guaranteed, a lock, or certain.

Write a tight, desk-style breakdown with these labeled parts (skip a part only if you truly have no data for it, and say why):
KEY REASONS — the 2-4 strongest points for/against, grounded in the printed records/pitching/injuries/weather.
TEAM TRENDS — what the records and home/road splits say.
INJURIES — who's out and whether it plausibly matters (only players printed).
PITCHING (MLB) — the probable-pitcher edge from the printed W-L/ERA.
WEATHER — only if printed; how wind/temp/precip could affect the total or play.
RISKS & INVALIDATORS — what would kill this bet.
BOTTOM LINE — one honest sentence: is this a real spot or a pass, and why.

Keep it concise and specific. No hype.`;

function ctxToText(c: GameContext, bet: BetInfo): string {
  const L: string[] = [];
  L.push(`BET: ${bet.selection} at ${fmtAmerican(bet.oddsAmerican)} (${bet.book}), ${bet.league} — ${bet.matchup}.`);
  L.push(`PRICE MATH: your price implies ${pct(bet.impliedProb)}, no-vig market consensus ${pct(bet.modelProb)}, edge ${bet.edgePts == null ? "n/a" : bet.edgePts.toFixed(1)} pts, model confidence ${bet.confidence ?? "n/a"}, data quality ${bet.dataQuality ?? "n/a"}.`);
  if (!c.matched) L.push(`GAME CONTEXT: not available — ${c.notes.join(" ")}`);
  const t = (label: string, tm: GameContext["home"]) => {
    if (!tm) return;
    const bits = [
      tm.overall ? `overall ${tm.overall}` : null,
      tm.home ? `home ${tm.home}` : null,
      tm.road ? `road ${tm.road}` : null,
      tm.probablePitcher ? `probable: ${tm.probablePitcher}` : null,
    ].filter(Boolean);
    L.push(`${label} — ${tm.name}: ${bits.length ? bits.join(", ") : "records not available"}.`);
  };
  t("HOME", c.home);
  t("AWAY", c.away);
  if (c.venue) L.push(`VENUE: ${c.venue}${c.indoor === true ? " (indoor/roof)" : c.indoor === false ? " (outdoor)" : ""}.`);
  if (c.weather) {
    const w = c.weather;
    L.push(`WEATHER (${w.source}): ${[w.tempF != null ? `${Math.round(w.tempF)}°F` : null, w.conditions, w.windMph != null ? `wind ${Math.round(w.windMph)}mph ${w.windDir ?? ""}`.trim() : null, w.precipPct != null ? `${w.precipPct}% precip` : null].filter(Boolean).join(", ")}.`);
  } else {
    L.push(`WEATHER: not available.`);
  }
  const inj = (label: string, list: GameContext["injuriesHome"]) => {
    if (!list || !list.length) { L.push(`${label} INJURIES: none listed / not available.`); return; }
    L.push(`${label} INJURIES: ${list.map((i) => `${i.player} (${i.status})`).join("; ")}.`);
  };
  inj("HOME", c.injuriesHome);
  inj("AWAY", c.injuriesAway);
  if (c.notes.length) L.push(`NOTES: ${c.notes.join(" ")}`);
  return L.join("\n");
}
function pct(x: number | null | undefined): string { return x == null ? "n/a" : `${(x * 100).toFixed(1)}%`; }

type BetInfo = {
  league: League; matchup: string; selection: string; betType?: string;
  oddsAmerican: number | null; book?: string; edgePts: number | null;
  impliedProb: number | null; modelProb: number | null; confidence?: number | null; dataQuality?: string | null;
};

function parseMatchup(m: string): { away: string; home: string } {
  // Opportunity matchup is "Away @ Home".
  const parts = (m || "").split(" @ ");
  return { away: (parts[0] || "").trim(), home: (parts[1] || parts[0] || "").trim() };
}

export async function POST(req: NextRequest) {
  const gate = await gateAdmin();
  if (!gate.ok) return json({ error: "not_found" }, 404);

  let b: Partial<BetInfo> = {};
  try { b = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const league = (b.league && LEAGUES.includes(b.league) ? b.league : null);
  if (!league || !b.matchup) return json({ error: "missing_fields", message: "league and matchup required." }, 400);

  const bet: BetInfo = {
    league, matchup: String(b.matchup), selection: String(b.selection || ""), betType: b.betType,
    oddsAmerican: b.oddsAmerican ?? null, book: b.book || "your book", edgePts: b.edgePts ?? null,
    impliedProb: b.impliedProb ?? null, modelProb: b.modelProb ?? null, confidence: b.confidence ?? null, dataQuality: b.dataQuality ?? null,
  };
  const { home, away } = parseMatchup(bet.matchup);

  let context: GameContext;
  try {
    context = await getGameContext(league, home, away);
  } catch (e) {
    return json({ ok: true, context: null, read: null, message: `Context lookup failed: ${String(e).slice(0, 120)}` });
  }

  const dataText = ctxToText(context, bet);

  // AI read (optional — only if the key is set). Real data is returned regardless.
  const key = process.env.ANTHROPIC_API_KEY;
  let read: string | null = null;
  if (key) {
    try {
      const r = await fetch(ANTHROPIC_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: MODEL, max_tokens: 1200, system: SYSTEM,
          messages: [{ role: "user", content: `DATA:\n${dataText}\n\nWrite the full breakdown for this bet using only the data above.` }],
        }),
      });
      const j = await r.json();
      if (r.ok && Array.isArray(j?.content)) {
        read = j.content.filter((x: { type?: string }) => x?.type === "text").map((x: { text?: string }) => x.text ?? "").join("").trim() || null;
      }
    } catch { /* leave read null; real context still returned */ }
  }

  return json({
    ok: true,
    matched: context.matched,
    context: {
      home: context.home, away: context.away, venue: context.venue, indoor: context.indoor,
      date: context.date, weather: context.weather,
      injuriesHome: context.injuriesHome, injuriesAway: context.injuriesAway, notes: context.notes,
    },
    read,
  });
}
