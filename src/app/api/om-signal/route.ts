import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { findAsset } from "@/data/signalAssets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.OM_AI_MODEL || "claude-sonnet-4-6";

type Row = { datetime: string; open: string; high: string; low: string; close: string };

function sma(vals: number[], n: number): number | null {
  if (vals.length < n) return null;
  return vals.slice(-n).reduce((a, b) => a + b, 0) / n;
}
function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let g = 0, l = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) g += d; else l -= d;
  }
  const ag = g / period, al = l / period;
  if (al === 0) return 100;
  return 100 - 100 / (1 + ag / al);
}
// Fair Value Gaps (3-candle imbalance). Returns most recent zones, newest last.
function findFVGs(rows: Row[]) {
  const bull: [number, number][] = [], bear: [number, number][] = [];
  for (let i = 2; i < rows.length; i++) {
    const aH = +rows[i - 2].high, aL = +rows[i - 2].low, cH = +rows[i].high, cL = +rows[i].low;
    if (aH < cL) bull.push([aH, cL]);
    if (aL > cH) bear.push([cH, aL]);
  }
  return { bull: bull.slice(-2), bear: bear.slice(-2) };
}
async function fetchSeries(td: string, interval: string, size: number, key: string): Promise<Row[] | null> {
  try {
    const r = await fetch(
      `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(td)}&interval=${interval}&outputsize=${size}&apikey=${key}`,
      { cache: "no-store" }
    );
    const j = await r.json();
    if (j.status === "error" || !Array.isArray(j.values)) return null;
    return [...(j.values as Row[])].reverse(); // chronological
  } catch { return null; }
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

  let body: { td?: unknown; orderType?: unknown; style?: unknown };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const td = typeof body?.td === "string" ? body.td : "";
  const orderType = body?.orderType === "market" ? "Market" : "Limit";
  const STYLE: Record<string, { interval: string; htf: string; htfLabel: string; label: string; note: string }> = {
    scalp: { interval: "15min", htf: "1h", htfLabel: "1H", label: "Scalp (15m)", note: "a very short-term scalp — tight stop, nearby targets" },
    intraday: { interval: "1h", htf: "4h", htfLabel: "4H", label: "Intraday (1H)", note: "an intraday trade on the 1H timeframe" },
    swing: { interval: "1day", htf: "1week", htfLabel: "1W", label: "Swing (Daily)", note: "a multi-day swing on the daily timeframe — wider stop and targets" },
  };
  const styleKey = typeof body?.style === "string" && STYLE[body.style] ? (body.style as string) : "intraday";
  const sty = STYLE[styleKey];
  const found = findAsset(td);
  if (!found) return json({ error: "unknown_asset" }, 400);

  const rows = await fetchSeries(td, sty.interval, 80, mdKey);
  if (!rows || rows.length < 25) return json({ error: "marketdata_error", detail: "insufficient candles" }, 502);

  const closes = rows.map((v) => +v.close);
  const highs = rows.map((v) => +v.high);
  const lows = rows.map((v) => +v.low);
  const price = closes[closes.length - 1];
  const rangeHi = Math.max(...highs.slice(-40));
  const rangeLo = Math.min(...lows.slice(-40));
  const eq = (rangeHi + rangeLo) / 2;
  const zone = price > eq ? "PREMIUM (above equilibrium)" : "DISCOUNT (below equilibrium)";
  const fvg = findFVGs(rows.slice(-30));
  const dec = price >= 1000 ? 2 : price >= 1 ? 4 : 6;
  const f = (n: number) => n.toFixed(dec);

  // Higher-timeframe bias
  const htf = await fetchSeries(td, sty.htf, 60, mdKey);
  let htfBias = "unavailable";
  if (htf && htf.length > 20) {
    const hc = htf.map((v) => +v.close);
    const hp = hc[hc.length - 1], hs20 = sma(hc, 20), hs50 = sma(hc, 50);
    const hHi = Math.max(...htf.map((v) => +v.high)), hLo = Math.min(...htf.map((v) => +v.low));
    const hEq = (hHi + hLo) / 2;
    const trend = hs20 && hs50 ? (hp > hs20 && hs20 > hs50 ? "bullish" : hp < hs20 && hs20 < hs50 ? "bearish" : "ranging") : "ranging";
    htfBias = `${trend}; price in ${hp > hEq ? "premium" : "discount"} of the ${sty.htfLabel} range (${f(hLo)}–${f(hHi)})`;
  }

  // Compact recent candle series for structure reading
  const recent = rows.slice(-40);
  const series = recent.map((v) => `${f(+v.open)},${f(+v.high)},${f(+v.low)},${f(+v.close)}`).join(" | ");

  const system = `You are OM AI's signal engine for the 1 Mission trading community. You trade EXCLUSIVELY with ICT (Inner Circle Trader) and Smart Money Concepts (SMC).

Method — build the play in this order:
1) BIAS: align with the higher-timeframe (${sty.htfLabel}) bias and the current dealing range (premium vs discount). Longs are highest-probability from DISCOUNT; shorts from PREMIUM.
2) LIQUIDITY: identify the draw on liquidity — the buy-side liquidity (above equal/old highs) or sell-side liquidity (below equal/old lows) price is likely to run. Favor setups that just SWEPT the opposing liquidity (stop hunt) before reversing.
3) POI: place entry at a valid Point of Interest confirmed by displacement/BOS — an order block, fair value gap (imbalance), or breaker — in the correct premium/discount zone.
4) RISK: stop-loss goes just beyond the POI / swing that invalidates the idea. Targets = the identified liquidity pool(s), opposing range extreme, and/or the next imbalance. Aim for clean R:R (≥1:2 when possible).

Be SELECTIVE — only give LONG/SHORT when there is real confluence (bias + liquidity + POI + zone). If there is no A+ setup, return "NEUTRAL" and explain what's missing. Reserve confidence "High" for textbook A+ confluence.

Ground every number in the current price (${price}). Levels must be internally consistent (LONG: SL below entry, TPs above; SHORT: reverse), realistic, and sized for a ${sty.label} play. Use ${dec} decimals.

Respond with ONLY valid minified JSON, exactly:
{"direction":"LONG|SHORT|NEUTRAL","setup":"the SMC setup in a few words e.g. 'Bullish OB in discount after SSL sweep'","bias":"HTF bias in a few words","poi":"entry POI zone e.g. '1H bullish order block 64100-64300 + FVG'","liquidityTarget":"the liquidity being targeted e.g. 'BSL above equal highs at 66990'","entry":number,"stopLoss":number,"takeProfits":[number,number,number],"confidence":"Low|Medium|High","riskReward":"e.g. 1:2.5","timeframe":"${sty.label}","rationale":"2-4 sentences using ICT/SMC terms (structure/BOS/CHoCH, liquidity sweep, OB/FVG, premium/discount, displacement)","invalidation":"one line: the structural level that kills the idea"}
This is educational analysis, not financial advice. Do not guarantee outcomes.`;

  const user = `Asset: ${found.asset.symbol} (${found.asset.name}) · ${orderType} · ${sty.label}
Current price: ${f(price)}
Higher-timeframe (${sty.htfLabel}) bias: ${htfBias}
Dealing range (last 40 ${sty.label} bars): high(BSL) ${f(rangeHi)} | low(SSL) ${f(rangeLo)} | equilibrium ${f(eq)} → price is in ${zone}
Momentum: RSI(14) ${rsi(closes)?.toFixed(1) ?? "n/a"} | SMA20 ${sma(closes, 20) ? f(sma(closes, 20)!) : "n/a"} | SMA50 ${sma(closes, 50) ? f(sma(closes, 50)!) : "n/a"}
Recent unfilled FVGs — bullish: ${fvg.bull.map(([a, b]) => `${f(a)}-${f(b)}`).join(", ") || "none"} | bearish: ${fvg.bear.map(([a, b]) => `${f(a)}-${f(b)}`).join(", ") || "none"}
Recent 40 candles (O,H,L,C, oldest→newest): ${series}
Read the structure (swing points, BOS/CHoCH, order blocks, liquidity) from these candles and return the JSON SMC signal.`;

  let ai: { content?: { type?: string; text?: string }[]; error?: { message?: string } };
  try {
    const r = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": aiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: 900, system, messages: [{ role: "user", content: user }] }),
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
    style: sty.label,
    price,
    asOf: rows[rows.length - 1].datetime,
    candles: recent.map((v) => ({ t: v.datetime, o: +v.open, h: +v.high, l: +v.low, c: +v.close })),
    signal,
  }, 200);
}

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
