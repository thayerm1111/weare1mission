import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * AI Plays of the Week — a professional buy-&-hold desk. Picks the best
 * longer-horizon ideas across stocks + crypto, grounded in current prices, with
 * a thesis, a buy zone, a horizon and a risk note. Regenerated once per ISO week
 * and cached in memory so it's cheap. Educational only, not financial advice.
 */
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.OM_AI_MODEL || "claude-sonnet-4-6";

// Kept to 7 so all price lookups fit the free market-data rate limit (8/min),
// which keeps every buy zone grounded in a real current price. Expand on Grow+.
const UNIVERSE: { ticker: string; name: string; td: string; type: "Stock" | "Crypto" }[] = [
  { ticker: "AAPL", name: "Apple", td: "AAPL", type: "Stock" },
  { ticker: "NVDA", name: "NVIDIA", td: "NVDA", type: "Stock" },
  { ticker: "MSFT", name: "Microsoft", td: "MSFT", type: "Stock" },
  { ticker: "GOOGL", name: "Alphabet", td: "GOOGL", type: "Stock" },
  { ticker: "AMZN", name: "Amazon", td: "AMZN", type: "Stock" },
  { ticker: "BTC", name: "Bitcoin", td: "BTC/USD", type: "Crypto" },
  { ticker: "ETH", name: "Ethereum", td: "ETH/USD", type: "Crypto" },
];

type Cache = { week: string; data: unknown } | null;
let CACHE: Cache = null;

function isoWeek(): string {
  const d = new Date();
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((t.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${t.getUTCFullYear()}-W${week}`;
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

  const week = isoWeek();
  if (CACHE && CACHE.week === week) return json({ week, cached: true, ...(CACHE.data as object) }, 200);

  // Ground the analysis in current prices. Only tickers we could actually price
  // reach the AI, so it can never reason about (or quote) a stale price.
  const quoted = mdKey
    ? await Promise.all(UNIVERSE.map(async (a) => ({ ...a, q: await quote(a.td, mdKey) })))
    : [];
  const priced = quoted.filter((a) => a.q) as (typeof UNIVERSE[number] & { q: { price: number; pct: number | null } })[];
  if (priced.length === 0) return json({ error: "no_prices", detail: "Couldn't fetch current prices — try again shortly." }, 200);
  const priceByTicker: Record<string, number> = {};
  for (const a of priced) priceByTicker[a.ticker.toUpperCase()] = a.q.price;

  const lines = priced.map((a) => `${a.ticker} (${a.name}, ${a.type}) — current $${a.q.price}${a.q.pct != null ? ` (${a.q.pct >= 0 ? "+" : ""}${a.q.pct.toFixed(2)}% today)` : ""}`).join("\n");

  const system = `You are OM AI's buy-&-hold desk for the 1 Mission community — a professional analyst choosing longer-horizon positions (weeks to months), NOT day trades.

From the universe below, pick the best 3–4 buy-and-hold ideas for this week — favour a mix of stocks and crypto and genuine quality/timing, not hype. Only choose tickers listed below. For each: a clear one-line thesis grounded in the asset's real drivers, a "buy zone" to accumulate, a horizon, and an honest risk note.

CRITICAL: the buy zone MUST sit within ~12% of the CURRENT price given for that ticker — a level or small range near or just below it. Never output a price far from the current one. This is EDUCATIONAL, not financial advice — no guarantees, no income claims.

Respond with ONLY valid minified JSON, exactly:
{"plays":[{"ticker":"AAPL","name":"Apple","type":"Stock","thesis":"one line","buyZone":"a range/level within ~12% of current","horizon":"e.g. 1–3 months","risk":"one line","conviction":"Low|Medium|High"}],"note":"one-line market context for the week"}`;

  const user = `Universe with current prices:\n${lines}\n\nReturn the JSON now.`;

  let ai: { content?: { type?: string; text?: string }[]; error?: { message?: string } };
  try {
    const r = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": aiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: 1200, system, messages: [{ role: "user", content: user }] }),
    });
    ai = await r.json();
    if (!r.ok) return json({ error: "ai_error", detail: (ai?.error?.message || `status ${r.status}`).slice(0, 200) }, 502);
  } catch { return json({ error: "ai_unreachable" }, 502); }

  const raw = Array.isArray(ai.content) ? ai.content.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("") : "";
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return json({ error: "parse_error" }, 502);
  let parsed: { plays?: unknown; note?: unknown };
  try { parsed = JSON.parse(match[0]); } catch { return json({ error: "parse_error" }, 502); }

  const fmtP = (n: number) => (n >= 1000 ? Math.round(n).toLocaleString() : n >= 1 ? n.toFixed(2) : n.toFixed(4));
  const rawPlays = Array.isArray(parsed.plays) ? (parsed.plays as Record<string, unknown>[]) : [];
  const plays = rawPlays
    .map((p) => {
      const ticker = String(p.ticker || "").toUpperCase();
      const price = priceByTicker[ticker];
      if (!price) return null;                                   // drop anything we didn't price
      let buyZone = typeof p.buyZone === "string" ? p.buyZone : "";
      // Hard-guard: if the zone's first number is >20% from the live price
      // (or unparseable), replace it with a real range around the live price.
      const firstNum = parseFloat((buyZone.match(/[\d,.]+/)?.[0] || "").replace(/,/g, ""));
      const bad = !Number.isFinite(firstNum) || Math.abs(firstNum - price) / price > 0.2;
      if (bad) buyZone = `${fmtP(price * 0.95)} – ${fmtP(price)}`;
      return { ...p, ticker, buyZone, price };
    })
    .filter(Boolean);

  const data = { plays, note: typeof parsed.note === "string" ? parsed.note : "" };
  CACHE = { week, data };
  return json({ week, cached: false, ...data }, 200);
}

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
