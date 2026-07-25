import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { findAsset } from "@/data/signalAssets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.OM_AI_MODEL || "claude-sonnet-4-6";

type Row = { datetime: string; open: string; high: string; low: string; close: string };
const numOk = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

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
    const r = await fetch(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(td)}&interval=${interval}&outputsize=${size}&apikey=${key}`, { cache: "no-store" });
    const j = await r.json();
    if (j.status === "error" || !Array.isArray(j.values)) return null;
    return [...(j.values as Row[])].reverse();
  } catch { return null; }
}

// Confirmations catalog — keys must match the client.
const CONFIRMATIONS: Record<string, string> = {
  structure: "Market structure (swing highs/lows, BOS / CHoCH, trend)",
  ob: "Order blocks (last opposing candle before displacement)",
  fvg: "Fair value gaps / imbalances",
  liquidity: "Liquidity sweeps of equal highs/lows (stop hunts)",
  sr: "Support / resistance & supply/demand zones",
  trend: "Trend via moving averages (SMA20/50 alignment)",
  rsi: "RSI momentum (overbought/oversold, divergence)",
  fib: "Fibonacci / OTE (0.62–0.79 optimal trade entry)",
  volume: "Volume behaviour (expansion on displacement)",
};

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

  let body: { td?: unknown; orderType?: unknown; style?: unknown; method?: unknown; confirmations?: unknown };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const td = typeof body?.td === "string" ? body.td : "";
  const orderType = body?.orderType === "market" ? "Market" : "Limit";
  const STYLE: Record<string, { interval: string; htf: string; htfLabel: string; label: string; note: string }> = {
    scalp: { interval: "15min", htf: "1h", htfLabel: "1H", label: "Scalp (15m)", note: "a very short-term scalp — tight stop, nearby targets" },
    intraday: { interval: "1h", htf: "4h", htfLabel: "4H", label: "Intraday (1H)", note: "an intraday trade on the 1H timeframe" },
    swing: { interval: "1day", htf: "1week", htfLabel: "1W", label: "Swing (Daily)", note: "a multi-day swing on the daily timeframe" },
  };
  const styleKey = typeof body?.style === "string" && STYLE[body.style] ? (body.style as string) : "intraday";
  const sty = STYLE[styleKey];
  const method = ["best", "smc", "structure"].includes(String(body?.method)) ? String(body?.method) : "best";
  const confs: string[] = Array.isArray(body?.confirmations)
    ? (body!.confirmations as unknown[]).filter((c): c is string => typeof c === "string" && !!CONFIRMATIONS[c])
    : [];
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
    const trend = hs20 && hs50 ? (hp > hs20 && hs20 > hs50 ? "bullish" : hp < hs20 && hs20 < hs50 ? "bearish" : "ranging") : "ranging";
    htfBias = `${trend}; price in ${hp > (hHi + hLo) / 2 ? "premium" : "discount"} of the ${sty.htfLabel} range (${f(hLo)}–${f(hHi)})`;
  }

  // Market open/closed.
  // Crypto trades 24/7. Forex, metals, stocks and indices close on weekends
  // (and stocks/indices have daily sessions). We trust Twelve Data's
  // `is_market_open` when it gives a definitive answer, and fall back to a
  // UTC time-based check so the "closed" note is reliable even when the quote
  // endpoint is rate-limited or omits the field.
  let marketClosed = false;
  const mkt = found.market.id;
  if (mkt !== "crypto") {
    // UTC-based fallback first (always available).
    const now = new Date();
    const dow = now.getUTCDay(); // 0 Sun … 6 Sat
    const hr = now.getUTCHours();
    const mins = hr * 60 + now.getUTCMinutes();
    // FX/metals week: opens Sun 21:00 UTC, closes Fri 21:00 UTC.
    const fxClosed =
      dow === 6 ||
      (dow === 0 && hr < 21) ||
      (dow === 5 && hr >= 21);
    if (mkt === "forex" || mkt === "metal") {
      marketClosed = fxClosed;
    } else {
      // Stocks / indices: closed on weekends and outside the regular US cash
      // session (~13:30–20:00 UTC). Approximate; the quote field refines it.
      marketClosed = dow === 0 || dow === 6 || mins < 13 * 60 + 30 || mins >= 20 * 60;
    }
    // Let a definitive quote answer override the approximation either way.
    try {
      const q = await fetch(`https://api.twelvedata.com/quote?symbol=${encodeURIComponent(td)}&apikey=${mdKey}`, { cache: "no-store" });
      const qj = await q.json();
      if (qj && (qj.is_market_open === true || qj.is_market_open === false)) {
        marketClosed = qj.is_market_open === false;
      }
    } catch { /* keep time-based fallback */ }
  }

  const recent = rows.slice(-40);
  const series = recent.map((v) => `${f(+v.open)},${f(+v.high)},${f(+v.low)},${f(+v.close)}`).join(" | ");

  const methodLine =
    method === "smc"
      ? "Analyze PURELY with ICT / Smart Money Concepts: liquidity (BSL/SSL) & sweeps, order blocks, fair value gaps, premium/discount of the dealing range, displacement, and BOS/CHoCH."
      : method === "structure"
      ? "Analyze primarily with CLASSICAL MARKET STRUCTURE: trend via swing highs/lows (HH/HL vs LH/LL), break of structure / change of character, and support/resistance & supply/demand zones."
      : "Use OM AI's OPTIMAL high-probability blend: higher-timeframe bias + market structure + a key smart-money POI (order block or fair value gap) + a momentum check (RSI) + support/resistance. Prioritise the cleanest confluence.";
  const confLine = confs.length
    ? `The trader has selected these confirmations — require confluence across them and reference each you use: ${confs.map((c) => CONFIRMATIONS[c]).join("; ")}.`
    : "Use the cleanest set of confirmations you judge best for this market.";

  const system = `You are OM AI's signal engine for the 1 Mission trading community.
${methodLine}
${confLine}

Build the play: 1) align with the higher-timeframe (${sty.htfLabel}) bias; 2) identify the draw on liquidity / next objective; 3) place entry at a valid point of interest confirmed by displacement/structure, in the correct premium/discount zone; 4) stop-loss just beyond the level that invalidates it; targets at liquidity / opposing range / next imbalance. Aim for clean R:R (≥1:2 when possible).

Be SELECTIVE — only give LONG/SHORT when there is real confluence across the selected confirmations. If there is no A+ setup, return "NEUTRAL" and explain what's missing. Reserve "High" confidence for textbook A+ confluence.

CRITICAL — numbers: the current price is EXACTLY ${price}. Entry, stopLoss and every take-profit MUST be within a few percent of ${price} and in the same order of magnitude — never add or drop a digit. Sanity-check each number against ${price} before returning. LONG: SL below entry, TPs above; SHORT: reverse. Sized for a ${sty.label} play. Use ${dec} decimals.

Respond with ONLY valid minified JSON, exactly:
{"direction":"LONG|SHORT|NEUTRAL","setup":"the setup in a few words","bias":"HTF bias in a few words","poi":"entry POI zone","liquidityTarget":"the liquidity/objective targeted","entry":number,"stopLoss":number,"takeProfits":[number,number,number],"confidence":"Low|Medium|High","riskReward":"e.g. 1:2.5","timeframe":"${sty.label}","rationale":"2-4 sentences referencing the confirmations you used","invalidation":"one line: the level that kills the idea"}
Educational analysis, not financial advice. No guarantees.`;

  const user = `Asset: ${found.asset.symbol} (${found.asset.name}) · ${orderType} · ${sty.label}
Current price: ${f(price)}${marketClosed ? " (market currently CLOSED — analyse last session)" : ""}
Higher-timeframe (${sty.htfLabel}) bias: ${htfBias}
Dealing range (last 40 bars): high(BSL) ${f(rangeHi)} | low(SSL) ${f(rangeLo)} | equilibrium ${f(eq)} → price is in ${zone}
Momentum: RSI(14) ${rsi(closes)?.toFixed(1) ?? "n/a"} | SMA20 ${sma(closes, 20) ? f(sma(closes, 20)!) : "n/a"} | SMA50 ${sma(closes, 50) ? f(sma(closes, 50)!) : "n/a"}
Recent unfilled FVGs — bullish: ${fvg.bull.map(([a, b]) => `${f(a)}-${f(b)}`).join(", ") || "none"} | bearish: ${fvg.bear.map(([a, b]) => `${f(a)}-${f(b)}`).join(", ") || "none"}
Recent 40 candles (O,H,L,C, oldest→newest): ${series}
Return the JSON signal now.`;

  let ai: { content?: { type?: string; text?: string }[]; error?: { message?: string } };
  try {
    const r = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": aiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: 900, system, messages: [{ role: "user", content: user }] }),
    });
    ai = await r.json();
    if (!r.ok) return json({ error: "ai_error", detail: (ai?.error?.message || `status ${r.status}`).slice(0, 200) }, 502);
  } catch { return json({ error: "ai_unreachable" }, 502); }

  const raw = Array.isArray(ai.content) ? ai.content.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("") : "";
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return json({ error: "parse_error" }, 502);
  let signal: Record<string, unknown>;
  try { signal = JSON.parse(match[0]); } catch { return json({ error: "parse_error" }, 502); }

  // Sanitise levels against the real price (guards digit typos / outliers).
  const off = (L: unknown) => (numOk(L) ? Math.abs(L - price) / price : Infinity);
  if (off(signal.entry) > 0.3) signal.entry = price;             // repair outlier entry → current price
  signal.stopLoss = off(signal.stopLoss) > 0.3 ? null : signal.stopLoss;
  signal.takeProfits = Array.isArray(signal.takeProfits)
    ? (signal.takeProfits as unknown[]).map((t) => (off(t) > 0.3 ? null : t)).filter((t) => t !== null)
    : [];

  return json({
    symbol: found.asset.symbol,
    name: found.asset.name,
    market: found.market.name,
    td,
    interval: sty.interval,
    orderType,
    style: sty.label,
    method,
    price,
    asOf: rows[rows.length - 1].datetime,
    marketClosed,
    candles: recent.map((v) => ({ t: v.datetime, o: +v.open, h: +v.high, l: +v.low, c: +v.close })),
    signal,
  }, 200);
}

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
