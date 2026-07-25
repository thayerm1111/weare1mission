import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { findAsset } from "@/data/signalAssets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.OM_AI_MODEL || "claude-sonnet-4-6";

function sma(vals: number[], n: number): number | null {
  if (vals.length < n) return null;
  const slice = vals.slice(-n);
  return slice.reduce((a, b) => a + b, 0) / n;
}

function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period, avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export async function POST(req: NextRequest) {
  const supabase = createClient();
  if (supabase) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
  }

  const aiKey = process.env.ANTHROPIC_API_KEY;
  const mdKey = process.env.TWELVEDATA_API_KEY;
  if (!aiKey) return json({ notConfigured: "ai" }, 200);
  if (!mdKey) return json({ notConfigured: "marketdata" }, 200);

  let body: { td?: unknown; orderType?: unknown };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const td = typeof body?.td === "string" ? body.td : "";
  const orderType = body?.orderType === "market" ? "Market" : "Limit";
  const found = findAsset(td);
  if (!found) return json({ error: "unknown_asset" }, 400);

  // 1) Live candles from Twelve Data.
  let series: { values?: { datetime: string; open: string; high: string; low: string; close: string }[]; status?: string; message?: string };
  try {
    const r = await fetch(
      `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(td)}&interval=1h&outputsize=80&apikey=${mdKey}`,
      { cache: "no-store" }
    );
    series = await r.json();
  } catch {
    return json({ error: "marketdata_unreachable" }, 502);
  }
  if (series.status === "error" || !Array.isArray(series.values) || series.values.length < 20) {
    return json({ error: "marketdata_error", detail: (series.message || "no data").slice(0, 200) }, 502);
  }

  // Twelve Data returns newest-first; make chronological.
  const rows = [...series.values].reverse();
  const closes = rows.map((v) => Number(v.close));
  const highs = rows.map((v) => Number(v.high));
  const lows = rows.map((v) => Number(v.low));
  const price = closes[closes.length - 1];
  const recentHigh = Math.max(...highs.slice(-40));
  const recentLow = Math.min(...lows.slice(-40));
  const ind = {
    price,
    rsi14: rsi(closes),
    sma20: sma(closes, 20),
    sma50: sma(closes, 50),
    recentHigh,
    recentLow,
    asOf: rows[rows.length - 1].datetime,
  };

  const decimals = price >= 1000 ? 2 : price >= 100 ? 2 : price >= 1 ? 4 : 6;
  const system = `You are OM AI's signal engine for the 1 Mission trading community.
Using the REAL market data provided, produce ONE structured, educational trade idea for ${found.asset.symbol} (${found.asset.name}), ${orderType} order.
Ground every number in the current price (${price}). Entry, stop loss, and take-profits must be realistic levels near current price and internally consistent with the direction (LONG: TPs above entry, SL below; SHORT: reverse). Use ${decimals} decimal places.
Respond with ONLY valid minified JSON, no prose, matching exactly:
{"direction":"LONG|SHORT|NEUTRAL","entry":number,"stopLoss":number,"takeProfits":[number,number,number],"confidence":"Low|Medium|High","riskReward":"e.g. 1:2.5","timeframe":"e.g. Intraday (1H)","rationale":"2-3 sentences on WHY, referencing structure/RSI/MAs","invalidation":"one line: what makes this idea wrong"}
This is educational analysis, not financial advice. Do not guarantee outcomes.`;

  const user = `Market data for ${found.asset.symbol} (1H candles):
current price: ${price}
RSI(14): ${ind.rsi14?.toFixed(1) ?? "n/a"}
SMA20: ${ind.sma20?.toFixed(decimals) ?? "n/a"}
SMA50: ${ind.sma50?.toFixed(decimals) ?? "n/a"}
recent 40-bar high: ${recentHigh}
recent 40-bar low: ${recentLow}
Return the JSON signal now.`;

  let ai: { content?: { type?: string; text?: string }[]; error?: { message?: string } };
  try {
    const r = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": aiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: 700, system, messages: [{ role: "user", content: user }] }),
    });
    ai = await r.json();
    if (!r.ok) return json({ error: "ai_error", detail: (ai?.error?.message || `status ${r.status}`).slice(0, 200) }, 502);
  } catch {
    return json({ error: "ai_unreachable" }, 502);
  }

  const raw = Array.isArray(ai.content) ? ai.content.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("") : "";
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return json({ error: "parse_error" }, 502);
  let signal: Record<string, unknown>;
  try { signal = JSON.parse(match[0]); } catch { return json({ error: "parse_error" }, 502); }

  return json({
    symbol: found.asset.symbol,
    name: found.asset.name,
    market: found.market.name,
    orderType,
    price,
    asOf: ind.asOf,
    indicators: { rsi14: ind.rsi14, sma20: ind.sma20, sma50: ind.sma50, recentHigh, recentLow },
    signal,
  }, 200);
}

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
