import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { reserveMarketData } from "@/lib/marketData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Live Plays — a professional buy-&-hold desk. Picks the best longer-horizon
 * ideas across stocks + crypto, grounded in current prices, with a thesis, a buy
 * zone, a horizon and a risk note. Educational only, not financial advice.
 *
 * SHARED, GLOBAL cache with a 2-hour floor (public.live_plays_cache, one row):
 *   - GET               → the current shared plays (generates once if empty).
 *   - POST {}           → same as GET (a plain load, never regenerates if cached).
 *   - POST {refresh:true}→ regenerate ONLY if the shared set is >2h old; otherwise
 *     return the cached set flagged `throttled` (so it can't be run over and over).
 * Everyone sees the same latest set; one member's refresh updates it for all.
 */
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.OM_AI_MODEL || "claude-sonnet-4-6";
const CACHE_ID = "global";
const TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

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

type Payload = { plays: unknown[]; note: string };

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
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

// ── Shared cache (public.live_plays_cache, single row keyed by CACHE_ID) ──
async function readCache(): Promise<{ payload: Payload; generatedAt: number } | null> {
  try {
    const admin = createAdminClient();
    if (!admin) return null;
    const { data, error } = await admin.from("live_plays_cache").select("payload, generated_at").eq("id", CACHE_ID).maybeSingle();
    if (error || !data || !data.payload) return null;
    return { payload: data.payload as Payload, generatedAt: new Date(data.generated_at as string).getTime() };
  } catch { return null; }
}

async function writeCache(payload: Payload): Promise<void> {
  try {
    const admin = createAdminClient();
    if (!admin) return;
    await admin.from("live_plays_cache").upsert({ id: CACHE_ID, payload, generated_at: new Date().toISOString() }, { onConflict: "id" });
  } catch { /* best-effort — a failed write just means the next request regenerates */ }
}

function shape(payload: Payload, generatedAt: number, extra: Record<string, unknown> = {}) {
  const age = Date.now() - generatedAt;
  const ageMinutes = Math.max(0, Math.round(age / 60000));
  const stale = age >= TTL_MS;
  const nextRefreshMinutes = Math.max(0, Math.ceil((TTL_MS - age) / 60000));
  return json({ ...payload, generatedAt: new Date(generatedAt).toISOString(), ageMinutes, stale, nextRefreshMinutes, ...extra });
}

async function requireUser(): Promise<boolean> {
  const supabase = createClient();
  if (!supabase) return true; // no auth layer configured → fail open
  const { data: { user } } = await supabase.auth.getUser();
  return !!user;
}

// ── Generate a fresh shared set. Returns the payload, or an error Response. ──
async function generatePlays(): Promise<{ ok: true; data: Payload } | { ok: false; resp: Response }> {
  const aiKey = process.env.ANTHROPIC_API_KEY;
  const mdKey = process.env.TWELVEDATA_API_KEY;
  if (!aiKey) return { ok: false, resp: json({ notConfigured: "ai" }, 200) };

  // Ground the analysis in current prices. Only tickers we could actually price
  // reach the AI, so it can never reason about (or quote) a stale price.
  if (mdKey) {
    const md = await reserveMarketData(UNIVERSE.length);
    if (!md.ok) return { ok: false, resp: json({ error: "no_prices", detail: "The data desk is busy — this week's plays will load shortly." }, 200) };
  }
  const quoted = mdKey
    ? await Promise.all(UNIVERSE.map(async (a) => ({ ...a, q: await quote(a.td, mdKey) })))
    : [];
  const priced = quoted.filter((a) => a.q) as (typeof UNIVERSE[number] & { q: { price: number; pct: number | null } })[];
  if (priced.length === 0) return { ok: false, resp: json({ error: "no_prices", detail: "Couldn't fetch current prices — try again shortly." }, 200) };
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
    if (!r.ok) return { ok: false, resp: json({ error: "ai_error", detail: (ai?.error?.message || `status ${r.status}`).slice(0, 200) }, 502) };
  } catch { return { ok: false, resp: json({ error: "ai_unreachable" }, 502) }; }

  const raw = Array.isArray(ai.content) ? ai.content.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("") : "";
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return { ok: false, resp: json({ error: "parse_error" }, 502) };
  let parsed: { plays?: unknown; note?: unknown };
  try { parsed = JSON.parse(match[0]); } catch { return { ok: false, resp: json({ error: "parse_error" }, 502) }; }

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

  return { ok: true, data: { plays, note: typeof parsed.note === "string" ? parsed.note : "" } };
}

// Serve the shared cache; generate the first set if the cache is empty.
async function loadShared(): Promise<Response> {
  const cached = await readCache();
  if (cached) return shape(cached.payload, cached.generatedAt, { cached: true });
  const g = await generatePlays();
  if (!g.ok) return g.resp;
  await writeCache(g.data);
  return shape(g.data, Date.now(), { cached: false });
}

export async function GET() {
  if (!(await requireUser())) return json({ error: "unauthorized" }, 401);
  return loadShared();
}

export async function POST(req: NextRequest) {
  if (!(await requireUser())) return json({ error: "unauthorized" }, 401);
  let body: { refresh?: unknown } = {};
  try { body = await req.json(); } catch { /* plain load */ }
  const refresh = body?.refresh === true;

  const cached = await readCache();
  const fresh = cached ? Date.now() - cached.generatedAt < TTL_MS : false;

  // Plain load, or a refresh while the shared set is still fresh → serve cache.
  if (cached && (!refresh || fresh)) {
    return shape(cached.payload, cached.generatedAt, { cached: true, throttled: refresh && fresh });
  }

  // Refresh with a stale/empty shared set → regenerate for everyone.
  const g = await generatePlays();
  if (!g.ok) {
    // Generation failed — serve the stale set rather than nothing, if we have one.
    if (cached) return shape(cached.payload, cached.generatedAt, { cached: true });
    return g.resp;
  }
  await writeCache(g.data);
  return shape(g.data, Date.now(), { cached: false });
}
