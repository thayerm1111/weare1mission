import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 45;

/**
 * Daily Market Brief — a professional AI morning read for the members' home.
 * Pulls live quotes across the macro complex (gold, indices, FX, crypto), then
 * has OM AI write the day's tone, a short summary, the notable movers and the
 * levels/themes to watch. Cached once per UTC day so it's cheap and stable.
 * Educational only, not financial advice.
 */
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.OM_AI_MODEL || "claude-sonnet-4-6";

// A tight macro snapshot — 6 quotes stays within the free rate limit (8/min).
const UNIVERSE: { symbol: string; name: string; td: string }[] = [
  { symbol: "XAU/USD", name: "Gold", td: "XAU/USD" },
  { symbol: "US30", name: "Dow Jones", td: "DJI" },
  { symbol: "NAS100", name: "Nasdaq 100", td: "NDX" },
  { symbol: "EUR/USD", name: "Euro", td: "EUR/USD" },
  { symbol: "BTC/USD", name: "Bitcoin", td: "BTC/USD" },
  { symbol: "ETH/USD", name: "Ethereum", td: "ETH/USD" },
];

type Cache = { day: string; data: unknown } | null;
let CACHE: Cache = null;

function utcDay(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

async function quote(td: string, key: string): Promise<{ price: number; pct: number | null } | null> {
  try {
    const r = await fetch(`https://api.twelvedata.com/quote?symbol=${encodeURIComponent(td)}&apikey=${key}`, { cache: "no-store" });
    const j = await r.json();
    const price = Number(j?.close ?? j?.price);
    if (!Number.isFinite(price)) return null;
    const pct = Number(j?.percent_change);
    return { price, pct: Number.isFinite(pct) ? pct : null };
  } catch { return null; }
}

export async function POST(req: NextRequest) {
  void req;
  const supabase = createClient();
  if (supabase) { const { data: { user } } = await supabase.auth.getUser(); if (!user) return json({ error: "unauthorized" }, 401); }
  const aiKey = process.env.ANTHROPIC_API_KEY;
  const mdKey = process.env.TWELVEDATA_API_KEY;
  if (!aiKey) return json({ notConfigured: "ai" }, 200);

  const day = utcDay();
  if (CACHE && CACHE.day === day) return json({ day, cached: true, ...(CACHE.data as object) }, 200);

  const quoted = mdKey
    ? await Promise.all(UNIVERSE.map(async (a) => ({ ...a, q: await quote(a.td, mdKey) })))
    : [];
  const priced = quoted.filter((a) => a.q) as (typeof UNIVERSE[number] & { q: { price: number; pct: number | null } })[];
  if (priced.length === 0) return json({ error: "no_prices", detail: "Couldn't fetch prices — try again shortly." }, 200);

  const fmtP = (n: number) => (n >= 1000 ? Math.round(n).toLocaleString() : n >= 1 ? n.toFixed(2) : n.toFixed(4));
  const lines = priced.map((a) => `${a.symbol} (${a.name}) — ${fmtP(a.q.price)}${a.q.pct != null ? ` (${a.q.pct >= 0 ? "+" : ""}${a.q.pct.toFixed(2)}% today)` : ""}`).join("\n");

  const system = `You are OM AI's desk analyst writing the Daily Market Brief for the 1 Mission community — a sharp, plain-English morning read a trader would actually want. Base it ONLY on the live snapshot provided; do not invent news events you can't see in the data.

From the snapshot, judge the day's tone, write a short summary, call out the notable movers, and give a few levels/themes to keep an eye on. Keep it tight and useful. EDUCATIONAL only — no guarantees, no income claims, not financial advice.

Respond with ONLY valid minified JSON, exactly:
{"tone":"Risk-on|Risk-off|Mixed|Cautious","headline":"one punchy line for the day","summary":"2-3 sentences on what the tape is saying across gold, indices, FX and crypto","movers":[{"symbol":"XAU/USD","name":"Gold","dir":"up|down|flat","note":"short read"}],"watch":["a level or theme to watch","another"]}`;

  const user = `Live snapshot (${day} UTC):\n${lines}\n\nWrite the brief now. Return JSON only.`;

  let ai: { content?: { type?: string; text?: string }[]; error?: { message?: string } };
  try {
    const r = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": aiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: 1000, system, messages: [{ role: "user", content: user }] }),
    });
    ai = await r.json();
    if (!r.ok) return json({ error: "ai_error", detail: (ai?.error?.message || `status ${r.status}`).slice(0, 200) }, 502);
  } catch { return json({ error: "ai_unreachable" }, 502); }

  const raw = Array.isArray(ai.content) ? ai.content.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("") : "";
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return json({ error: "parse_error" }, 502);
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(match[0]); } catch { return json({ error: "parse_error" }, 502); }

  // Attach the real prices so the UI can render an accurate snapshot strip.
  const snapshot = priced.map((a) => ({ symbol: a.symbol, name: a.name, price: a.q.price, pct: a.q.pct }));
  const data = { ...parsed, snapshot };
  CACHE = { day, data };
  return json({ day, cached: false, ...data }, 200);
}

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
