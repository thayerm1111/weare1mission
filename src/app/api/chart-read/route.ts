import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { gateCredits, chargeCredit } from "@/lib/credits";
import { reserveMarketData } from "@/lib/marketData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * OM Charts — AI Chart Read.
 * The member marks up a chart in OM Charts, snapshots it, and sends the image
 * here with (optionally) a note on what they're seeing. We pull live price +
 * multi-timeframe context from Twelve Data so the read is grounded in real
 * levels, then hand BOTH the image and that context to OM AI (vision) and ask
 * it to: describe what it sees in the member's markup, say whether it agrees,
 * read the pair, and give a directional view with levels + invalidation.
 * Educational only — not financial advice.
 */
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.OM_AI_MODEL || "claude-sonnet-4-6";

type Row = { datetime: string; open: string; high: string; low: string; close: string };
const numOk = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

// Map a few friendly symbols → Twelve Data symbols. Anything else is passed
// through as-is (Twelve Data accepts most "BASE/QUOTE" forms directly).
function toTd(input: string): string {
  const s = (input || "").trim().toUpperCase().replace(/\s+/g, "");
  const map: Record<string, string> = {
    "XAUUSD": "XAU/USD", "GOLD": "XAU/USD", "XAU/USD": "XAU/USD",
    "XAGUSD": "XAG/USD", "SILVER": "XAG/USD",
    "EURUSD": "EUR/USD", "GBPUSD": "GBP/USD", "USDJPY": "USD/JPY",
    "AUDUSD": "AUD/USD", "USDCAD": "USD/CAD", "NZDUSD": "NZD/USD",
    "BTCUSD": "BTC/USD", "ETHUSD": "ETH/USD", "SOLUSD": "SOL/USD",
  };
  if (map[s]) return map[s];
  // If they typed "OANDA:XAUUSD" style, strip the exchange prefix.
  const noEx = s.includes(":") ? s.split(":")[1] : s;
  if (map[noEx]) return map[noEx];
  // Insert a slash for 6-letter FX-style tickers without one.
  if (/^[A-Z]{6}$/.test(noEx)) return `${noEx.slice(0, 3)}/${noEx.slice(3)}`;
  return noEx || "XAU/USD";
}

async function series(td: string, interval: string, size: number, key: string): Promise<Row[] | null> {
  try {
    const r = await fetch(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(td)}&interval=${interval}&outputsize=${size}&apikey=${key}`, { cache: "no-store" });
    const j = await r.json();
    if (!Array.isArray(j?.values)) return null;
    return (j.values as Row[]).slice().reverse(); // oldest → newest
  } catch { return null; }
}
async function livePrice(td: string, key: string): Promise<number | null> {
  try {
    const r = await fetch(`https://api.twelvedata.com/price?symbol=${encodeURIComponent(td)}&apikey=${key}`, { cache: "no-store" });
    const j = await r.json();
    const p = Number(j?.price);
    return Number.isFinite(p) ? p : null;
  } catch { return null; }
}

const fmt = (n: number | null | undefined) => {
  if (!numOk(n)) return "—";
  return Math.abs(n) >= 1000 ? n.toFixed(2) : Math.abs(n) >= 1 ? n.toFixed(3) : n.toFixed(5);
};

/** Compact per-timeframe summary the model can trust — range, last close,
 *  simple trend read and swing hi/lo — so its view stays on real levels. */
function tfSummary(rows: Row[] | null): string {
  if (!rows || rows.length < 5) return "unavailable";
  const c = rows.map((r) => +r.close);
  const h = rows.map((r) => +r.high);
  const l = rows.map((r) => +r.low);
  const last = c[c.length - 1];
  const first = c[0];
  const hi = Math.max(...h), lo = Math.min(...l);
  const chg = ((last - first) / (first || 1)) * 100;
  const sma = (n: number) => (c.length >= n ? c.slice(-n).reduce((a, b) => a + b, 0) / n : null);
  const s20 = sma(20), s50 = sma(50);
  const trend = s20 && s50 ? (last > s20 && s20 > s50 ? "up" : last < s20 && s20 < s50 ? "down" : "mixed") : "n/a";
  return `last ${fmt(last)}, range ${fmt(lo)}–${fmt(hi)}, ${chg >= 0 ? "+" : ""}${chg.toFixed(2)}% over window, trend ${trend}, sma20 ${fmt(s20)}, sma50 ${fmt(s50)}`;
}

export async function POST(req: NextRequest) {
  // Auth + credits FIRST (before any paid work).
  const supabase = createClient();
  if (supabase) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
  }
  const gate = await gateCredits("chartread");
  if (!gate.ok && gate.reason === "unauthorized") return json({ error: "unauthorized" }, 401);
  if (!gate.ok && gate.reason === "insufficient") return json({ error: "insufficient_credits" }, 402);

  const aiKey = process.env.ANTHROPIC_API_KEY;
  if (!aiKey) return json({ notConfigured: "ai" }, 200);

  let body: { image?: string; notes?: string; symbol?: string };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }

  const dataUrl = String(body.image || "");
  const m = dataUrl.match(/^data:(image\/(png|jpeg|jpg|webp|gif));base64,([\s\S]+)$/i);
  if (!m) return json({ error: "bad_image" }, 400);
  const mediaType = m[1].toLowerCase() === "image/jpg" ? "image/jpeg" : m[1].toLowerCase();
  const b64 = m[3];
  // Guard against oversized payloads (~5MB decoded is Anthropic's ceiling).
  if (b64.length > 6_800_000) return json({ error: "image_too_large" }, 413);

  const notes = String(body.notes || "").slice(0, 1200).trim();
  const td = toTd(String(body.symbol || "XAU/USD"));

  // Live context (best-effort — the read still works image-only if data is down).
  const mdKey = process.env.TWELVEDATA_API_KEY;
  let context = "Live market data is not connected — analyze from the chart image and the member's notes only.";
  if (mdKey) {
    const md = await reserveMarketData(5);
    if (md.ok) {
      const [d1, h4, h1, m15, price] = await Promise.all([
        series(td, "1day", 60, mdKey),
        series(td, "4h", 60, mdKey),
        series(td, "1h", 80, mdKey),
        series(td, "15min", 96, mdKey),
        livePrice(td, mdKey),
      ]);
      context =
        `Symbol: ${td}\n` +
        `Live price: ${price != null ? fmt(price) : "unavailable"}\n` +
        `Daily: ${tfSummary(d1)}\n` +
        `4H: ${tfSummary(h4)}\n` +
        `1H: ${tfSummary(h1)}\n` +
        `15m: ${tfSummary(m15)}`;
    }
  }

  const system = `You are OM AI's chart-read analyst for the 1 Mission trading community. A member has drawn their own markup on a chart (trendlines, zones, arrows, levels, notes) and wants your honest second opinion.

Do FOUR things:
1. READ THEIR MARKUP: describe what you actually see they've drawn/annotated on the chart — the structure, levels, zones, direction they seem to be leaning. Be specific to the image.
2. AGREE OR NOT: state clearly whether you agree, partly agree, or disagree with their read, and WHY — using both the picture and the live context provided. Be candid; if their idea is weak or their level is off, say so respectfully.
3. READ THE PAIR: give your own read of ${td} using the live multi-timeframe context.
4. DIRECTION: say which way the market may go from here, with concrete levels — a bullish scenario, a bearish scenario, the side you lean, an entry idea, and the invalidation that would kill the trade.

Ground every level in the live context numbers where possible; do not invent prices far from them. This is educational analysis, NOT financial advice.

Return ONLY a JSON object (no prose, no markdown fences) with EXACTLY these keys:
{
  "observed": "what you see in their markup (2-4 sentences)",
  "verdict": "agree" | "partial" | "disagree",
  "agreement": "why you agree / partly agree / disagree (2-4 sentences)",
  "bias": "LONG" | "SHORT" | "NEUTRAL",
  "confidence": "Low" | "Medium" | "High",
  "pairRead": "your own read of the pair from the live context (2-4 sentences)",
  "resistance": [numbers, nearest first],
  "support": [numbers, nearest first],
  "bullCase": "what sends it up + the level/trigger (1-3 sentences)",
  "bearCase": "what sends it down + the level/trigger (1-3 sentences)",
  "likely": "which way it may go from here and why, in plain English (2-3 sentences)",
  "entryIdea": "a concrete entry idea with level (1-2 sentences)",
  "invalidation": "the price/level that invalidates the lean (1 sentence)",
  "watch": ["3-5 short things to watch next"],
  "caveat": "one honest risk/uncertainty line"
}`;

  const userText =
    `Pair: ${td}\n\n` +
    `LIVE CONTEXT:\n${context}\n\n` +
    (notes ? `MEMBER'S OWN NOTES / WHAT THEY'RE SEEING:\n${notes}\n\n` : `The member did not add written notes — infer their thesis from the markup itself.\n\n`) +
    `The attached image is the member's marked-up chart. Analyze it now and return the JSON.`;

  let ai: { content?: { type?: string; text?: string }[]; error?: { message?: string } };
  try {
    const r = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": aiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1800,
        system,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: b64 } },
            { type: "text", text: userText },
          ],
        }],
      }),
    });
    ai = await r.json();
  } catch {
    return json({ error: "ai_unavailable" }, 502);
  }
  if (ai?.error) return json({ error: "ai_error", detail: ai.error.message }, 502);

  const raw = Array.isArray(ai.content) ? ai.content.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("") : "";
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return json({ error: "parse_error" }, 502);
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(match[0]); } catch { return json({ error: "parse_error" }, 502); }

  // Success → charge the credit now (never before the work succeeds).
  await chargeCredit("chartread");

  return json({ ok: true, symbol: td, read: parsed }, 200);
}

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
