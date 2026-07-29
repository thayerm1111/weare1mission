import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { gateCredits, chargeCredit } from "@/lib/credits";
import { reserveMarketData, resolveTd } from "@/lib/marketData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Deep Dive — the reasoning behind a play. Given a ticker, we pull the live
 * quote plus a daily series, compute an objective technical read in code, then
 * ask OM AI to lay out WHY it's a call: a heat map of factor scores, the drivers
 * and catalysts, the technical picture, the strategy a professional would use,
 * and the honest risks. Educational only, not financial advice.
 */
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.OM_AI_MODEL || "claude-sonnet-4-6";

// Map a play ticker onto the Twelve Data symbol we can price it with.
const TD: Record<string, string> = {
  AAPL: "AAPL", NVDA: "NVDA", MSFT: "MSFT", GOOGL: "GOOGL", AMZN: "AMZN",
  TSLA: "TSLA", META: "META",
  BTC: "BTC/USD", ETH: "ETH/USD", SOL: "SOL/USD", XRP: "XRP/USD", DOGE: "DOGE/USD",
};

type Row = { datetime: string; open: string; high: string; low: string; close: string };

const numOk = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
function sma(v: number[], n: number) { if (v.length < n) return null; let s = 0; for (let i = v.length - n; i < v.length; i++) s += v[i]; return s / n; }
function rsi(c: number[], p = 14) { if (c.length < p + 1) return null; let g = 0, l = 0; for (let i = c.length - p; i < c.length; i++) { const d = c[i] - c[i - 1]; if (d >= 0) g += d; else l -= d; } const ag = g / p, al = l / p; if (al === 0) return 100; return 100 - 100 / (1 + ag / al); }
const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

async function fetchDaily(td: string, key: string): Promise<Row[] | null> {
  const { fetchTd, scale } = resolveTd(td);
  try {
    const r = await fetch(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(fetchTd)}&interval=1day&outputsize=220&apikey=${key}`, { cache: "no-store" });
    const j = await r.json();
    if (!Array.isArray(j?.values)) return null;
    const rows = (j.values as Row[]).slice().reverse();
    if (scale === 1) return rows;
    const m = (x: string) => String(Number(x) * scale);
    return rows.map((v) => ({ ...v, open: m(v.open), high: m(v.high), low: m(v.low), close: m(v.close) }));
  } catch { return null; }
}

/** Objective technical read from the daily candles — this is the ground truth
 *  we hand the AI so its reasoning can't drift off real levels. */
function readTechnicals(rows: Row[]) {
  const closes = rows.map((v) => +v.close), highs = rows.map((v) => +v.high), lows = rows.map((v) => +v.low);
  const price = closes[closes.length - 1];
  const s20 = sma(closes, 20), s50 = sma(closes, 50), s200 = sma(closes, 200);
  const rv = rsi(closes);
  const hi52 = Math.max(...highs), lo52 = Math.min(...lows);
  const fromHigh = ((price - hi52) / hi52) * 100;   // negative = below the high
  const offLow = ((price - lo52) / (lo52 || 1)) * 100;
  const chg30 = closes.length > 30 ? ((price - closes[closes.length - 31]) / closes[closes.length - 31]) * 100 : null;
  const chg90 = closes.length > 90 ? ((price - closes[closes.length - 91]) / closes[closes.length - 91]) * 100 : null;

  const trend: "up" | "down" | "sideways" =
    s50 && s200 ? (price > s50 && s50 > s200 ? "up" : price < s50 && s50 < s200 ? "down" : "sideways") : "sideways";

  // Factor scores (0–100) the UI renders as a heat map. Computed, not guessed.
  const trendScore = clamp(50 + (s20 && price > s20 ? 12 : -12) + (s50 && price > s50 ? 13 : -13) + (s200 && price > s200 ? 15 : -15) + (trend === "up" ? 10 : trend === "down" ? -10 : 0));
  const momentumScore = rv == null ? 50 : clamp(rv <= 30 ? 40 : rv >= 70 ? 78 : 40 + (rv - 30) * 0.95);
  const valueScore = clamp(50 - fromHigh * 0.9);     // deeper below the 52w high = more "value" room
  const strengthScore = clamp(50 + (chg90 ?? 0) * 0.8);
  const stabilityScore = clamp(70 - Math.abs(chg30 ?? 0) * 0.6);   // calmer 30d = steadier

  const fmt = (n: number | null) => (n == null ? null : n >= 1000 ? Math.round(n) : n >= 1 ? +n.toFixed(2) : +n.toFixed(4));
  return {
    price: fmt(price), sma20: fmt(s20), sma50: fmt(s50), sma200: fmt(s200),
    rsi: rv == null ? null : Math.round(rv),
    high52: fmt(hi52), low52: fmt(lo52),
    fromHigh: +fromHigh.toFixed(1), offLow: +offLow.toFixed(1),
    chg30: chg30 == null ? null : +chg30.toFixed(1), chg90: chg90 == null ? null : +chg90.toFixed(1),
    trend,
    heat: {
      Trend: Math.round(trendScore),
      Momentum: Math.round(momentumScore),
      Value: Math.round(valueScore),
      Strength: Math.round(strengthScore),
      Stability: Math.round(stabilityScore),
    },
  };
}

export async function POST(req: NextRequest) {
  const supabase = createClient();
  if (supabase) { const { data: { user } } = await supabase.auth.getUser(); if (!user) return json({ error: "unauthorized" }, 401); }
  const aiKey = process.env.ANTHROPIC_API_KEY;
  const mdKey = process.env.TWELVEDATA_API_KEY;
  if (!aiKey) return json({ notConfigured: "ai" }, 200);

  let body: { ticker?: string; name?: string; type?: string; thesis?: string; td?: string; context?: string; dir?: string; style?: string } = {};
  try { body = await req.json(); } catch { /* empty */ }
  const ticker = String(body.ticker || "").toUpperCase().trim();
  if (!ticker) return json({ error: "no_ticker" }, 400);

  const gate = await gateCredits("deepdive");
  if (!gate.ok && gate.reason === "unauthorized") return json({ error: "unauthorized" }, 401);
  if (!gate.ok && gate.reason === "insufficient") return json({ error: "insufficient_credits", balance: gate.balance }, 402);

  const name = String(body.name || ticker);
  const type = typeof body.type === "string" && body.type.trim() ? body.type.trim() : "Stock";
  // Callers may pass the exact Twelve Data symbol (FX/indices/commodities);
  // otherwise fall back to the stock/crypto map, then the ticker itself.
  const td = (typeof body.td === "string" && body.td.trim()) || TD[ticker] || ticker;
  // "signal" = a directional trade setup (OM AI Plays / Market Pulse);
  // otherwise a buy-&-hold read (Plays of the Week).
  const isSignal = body.context === "signal";
  const dir = body.dir === "LONG" || body.dir === "SHORT" ? body.dir : "";
  const style = typeof body.style === "string" ? body.style : "";

  let tech: ReturnType<typeof readTechnicals> | null = null;
  if (mdKey) {
    const md = await reserveMarketData(1);
    if (md.ok) {
      const rows = await fetchDaily(td, mdKey);
      if (rows && rows.length >= 30) tech = readTechnicals(rows);
    }
    // If the governor is at capacity, we simply proceed without live technicals
    // rather than blocking the whole deep dive — the AI reasons from fundamentals.
  }

  const techBlock = tech
    ? `Live technical read (daily candles — treat these as ground truth):
- Price: $${tech.price}
- 20/50/200-day SMA: ${tech.sma20 ?? "n/a"} / ${tech.sma50 ?? "n/a"} / ${tech.sma200 ?? "n/a"}
- RSI(14): ${tech.rsi ?? "n/a"}
- 52-period high/low: $${tech.high52} / $${tech.low52}  (price is ${tech.fromHigh}% vs high, +${tech.offLow}% off low)
- 30d change: ${tech.chg30 ?? "n/a"}% · 90d change: ${tech.chg90 ?? "n/a"}%
- Primary trend: ${tech.trend}
- Computed factor scores (0–100): Trend ${tech.heat.Trend}, Momentum ${tech.heat.Momentum}, Value ${tech.heat.Value}, Strength ${tech.heat.Strength}, Stability ${tech.heat.Stability}`
    : `Live technical data isn't available for this ticker right now — reason from the asset's known fundamentals and structure, and keep any prices as approximate ranges.`;

  const framing = isSignal
    ? `A member tapped "${ticker}" (${name}) to understand the reasoning behind a ${dir || "directional"} ${style ? `${style} ` : ""}trade setup our scanner/AI flagged. Explain the WHY behind THIS trade direction — the market structure, momentum, levels and confluence a professional would lean on. The "stance" should read as the directional bias (e.g. "${dir === "SHORT" ? "Short bias" : "Long bias"}"). The "strategy" should describe how a pro executes this specific ${dir || ""} setup — entry trigger, where the stop belongs, and how to manage toward targets.`
    : `A member tapped "${ticker}" (${name}, ${type}) to understand the full reasoning behind a buy-&-hold call. The "stance" should be one of Accumulate | Hold | Watch | Reduce. The "strategy" should describe how a pro accumulates and manages the position.`;

  const system = `You are OM AI's senior analyst for the 1 Mission community. Give a professional, plain-English deep dive — the WHY behind the call.

${framing}

${techBlock}

Ground every price you mention in the live read above. This is EDUCATIONAL, not financial advice — no guarantees, no income promises.

Respond with ONLY valid minified JSON, exactly this shape:
{"headline":"one punchy line on the setup","stance":"${isSignal ? (dir === "SHORT" ? "Short bias" : "Long bias") : "Accumulate|Hold|Watch|Reduce"}","heat":[{"factor":"Trend","score":0-100,"note":"short why"},{"factor":"Momentum","score":0-100,"note":"..."},{"factor":"Value","score":0-100,"note":"..."},{"factor":"Strength","score":0-100,"note":"..."},{"factor":"Stability","score":0-100,"note":"..."}],"drivers":["${isSignal ? "confluence / reason one" : "catalyst / driver one"}","two","three"],"technical":"2–3 sentences reading the chart structure, key levels and what price is doing","strategy":"${isSignal ? "how to execute this " + (dir || "") + " setup — entry trigger, stop placement, target management" : "how to approach entries, adds, and management"} (2–3 sentences)","levels":{"support":"level or range","resistance":"level or range","invalidation":"where the ${isSignal ? "setup" : "thesis"} breaks"},"risks":["risk one","risk two"]}

For the heat array, use the computed factor scores above as your anchor (you may nudge ±10 with justification in the note). Keep every field tight and specific.`;

  const user = `Deliver the deep dive for ${ticker} now. Return the JSON only.`;

  let ai: { content?: { type?: string; text?: string }[]; error?: { message?: string } };
  try {
    const r = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": aiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: 1500, system, messages: [{ role: "user", content: user }] }),
    });
    ai = await r.json();
    if (!r.ok) return json({ error: "ai_error", detail: (ai?.error?.message || `status ${r.status}`).slice(0, 200) }, 502);
  } catch { return json({ error: "ai_unreachable" }, 502); }

  const raw = Array.isArray(ai.content) ? ai.content.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("") : "";
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return json({ error: "parse_error" }, 502);
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(match[0]); } catch { return json({ error: "parse_error" }, 502); }

  // Prefer computed heat scores where the AI's drift too far from ground truth.
  if (tech && Array.isArray(parsed.heat)) {
    parsed.heat = (parsed.heat as Record<string, unknown>[]).map((h) => {
      const factor = String(h.factor || "");
      const computed = (tech!.heat as Record<string, number>)[factor];
      let score = Number(h.score);
      if (numOk(computed)) { if (!Number.isFinite(score) || Math.abs(score - computed) > 15) score = computed; }
      return { ...h, factor, score: clamp(Math.round(score || 0)) };
    });
  }

  const credits = await chargeCredit("deepdive");
  return json({ ticker, name, type, tech, credits, ...parsed }, 200);
}

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
