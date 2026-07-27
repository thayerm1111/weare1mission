import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { gateCredits, chargeCredit } from "@/lib/credits";
import { reserveMarketData } from "@/lib/marketData";
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
// Returns the candles, or "ratelimit" when Twelve Data says we're out of
// per-minute credits (so the caller can show an honest message instead of
// mislabelling it "insufficient candles"), or null on any other failure.
async function fetchSeries(td: string, interval: string, size: number, key: string): Promise<Row[] | "ratelimit" | null> {
  try {
    const r = await fetch(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(td)}&interval=${interval}&outputsize=${size}&apikey=${key}`, { cache: "no-store" });
    const j = await r.json();
    if (j.status === "error" || !Array.isArray(j.values)) {
      const msg = String(j?.message || "");
      if (r.status === 429 || j?.code === 429 || /credit|limit|per minute/i.test(msg)) return "ratelimit";
      return null;
    }
    return [...(j.values as Row[])].reverse();
  } catch { return null; }
}

// Repair glitch/spike bars from the data feed (e.g. a single bar whose wick
// prints hundreds of points away from every other candle, or a stale weekend
// feed that briefly flickers). We NEVER expand a bar — we only clip wicks that
// stick out far beyond the bar's own body relative to the recent typical range,
// so a bad tick can't corrupt the dealing range, the AI's targets, or the chart.
// Bodies (open/close) are trusted; only implausible high/low wicks are clamped.
function cleanRows(rows: Row[] | null): Row[] | null {
  if (!Array.isArray(rows) || rows.length < 5) return rows;
  const ranges = rows
    .map((r) => Math.abs(+r.high - +r.low))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  if (!ranges.length) return rows;
  const med = ranges[Math.floor(ranges.length / 2)] || 0;
  const px = Math.abs(+rows[rows.length - 1].close) || 1;
  // Max wick beyond the body: 12× the typical bar range, with a small
  // price-based floor so perfectly-flat (frozen) data still allows a real wick.
  const cap = Math.max(med * 12, px * 0.0015);
  return rows.map((r) => {
    const o = +r.open, c = +r.close, h = +r.high, l = +r.low;
    if (![o, c, h, l].every(Number.isFinite)) return r;
    const bodyTop = Math.max(o, c), bodyBot = Math.min(o, c);
    // clip an over-extended wick back toward the body, never past the body
    const nh = Math.max(bodyTop, Math.min(h, bodyTop + cap));
    const nl = Math.min(bodyBot, Math.max(l, bodyBot - cap));
    if (nh === h && nl === l) return r;
    return { ...r, high: String(nh), low: String(nl) };
  });
}

// Live spot price (latest tick) — used to anchor a MARKET play to the real
// fill price instead of the last completed candle's close, which can trail the
// market by a couple of dollars during a fast move. Returns null on any failure
// so the caller can fall back to the candle close.
async function fetchLivePrice(td: string, key: string): Promise<number | null> {
  try {
    const r = await fetch(`https://api.twelvedata.com/price?symbol=${encodeURIComponent(td)}&apikey=${key}`, { cache: "no-store" });
    const j = await r.json();
    const p = Number(j?.price);
    return Number.isFinite(p) ? p : null;
  } catch { return null; }
}

// Confirmations catalog — keys must match the client.
// Swing pivots (fractal highs/lows) — the basis for structure, S/R, fib and break-&-retest.
function pivots(highs: number[], lows: number[], k = 2) {
  const sh: { i: number; p: number }[] = [];
  const sl: { i: number; p: number }[] = [];
  for (let i = k; i < highs.length - k; i++) {
    let isH = true, isL = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      if (highs[j] >= highs[i]) isH = false;
      if (lows[j] <= lows[i]) isL = false;
    }
    if (isH) sh.push({ i, p: highs[i] });
    if (isL) sl.push({ i, p: lows[i] });
  }
  return { sh, sl };
}

const CONFIRMATIONS: Record<string, string> = {
  structure: "Market structure (swing highs/lows, BOS / CHoCH, trend)",
  ob: "Order blocks (last opposing candle before displacement)",
  fvg: "Fair value gaps / imbalances",
  liquidity: "Liquidity sweeps of equal highs/lows (stop hunts)",
  sr: "Support / resistance & supply/demand zones",
  trend: "Trend via moving averages (SMA20/50 alignment)",
  rsi: "RSI momentum (overbought/oversold, divergence)",
  fib: "Fibonacci / OTE (0.62–0.79 optimal trade entry)",
  breakRetest: "Break & retest of a reclaimed level or structure",
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

  // Credit gate — reject before doing any paid work if the member is out.
  const gate = await gateCredits("signal");
  if (!gate.ok && gate.reason === "unauthorized") return json({ error: "unauthorized" }, 401);
  if (!gate.ok && gate.reason === "insufficient") return json({ error: "insufficient_credits", balance: gate.balance }, 402);

  // Global governor — reserve the ~3 data credits this play needs (main + HTF + quote).
  const md = await reserveMarketData(3);
  if (!md.ok) return json({ error: "system_busy", detail: "The data desk is at capacity for a moment — try again in a few seconds." }, 429);

  const rowsRes = await fetchSeries(td, sty.interval, 80, mdKey);
  if (rowsRes === "ratelimit") return json({ error: "ratelimit", detail: "You've hit the free market-data limit (8 requests a minute). Give it about a minute, then generate again." }, 429);
  const rows = cleanRows(rowsRes);
  if (!rows || rows.length < 25) return json({ error: "marketdata_error", detail: "not enough price history for this asset on this timeframe — try a different timeframe." }, 502);

  const closes = rows.map((v) => +v.close);
  const highs = rows.map((v) => +v.high);
  const lows = rows.map((v) => +v.low);
  // Anchor to the LIVE tick when we can get it (matches the "current price" the
  // card shows and the price a market order actually fills at); fall back to the
  // last candle close. A 5% sanity band rejects a garbage tick.
  const candleClose = closes[closes.length - 1];
  const liveTick = await fetchLivePrice(td, mdKey);
  const price = (liveTick != null && Math.abs(liveTick - candleClose) / candleClose < 0.05) ? liveTick : candleClose;
  const rangeHi = Math.max(...highs.slice(-40));
  const rangeLo = Math.min(...lows.slice(-40));
  const eq = (rangeHi + rangeLo) / 2;
  const zone = price > eq ? "PREMIUM (above equilibrium)" : "DISCOUNT (below equilibrium)";
  const fvg = findFVGs(rows.slice(-30));
  const dec = price >= 1000 ? 2 : price >= 1 ? 4 : 6;
  const f = (n: number) => n.toFixed(dec);

  // Higher-timeframe bias
  const htfRes = await fetchSeries(td, sty.htf, 60, mdKey);
  const htf = Array.isArray(htfRes) ? cleanRows(htfRes) : null;   // rate-limited HTF just means "bias unavailable", not a hard fail
  let htfBias = "unavailable";
  let htfTrend: "bullish" | "bearish" | "ranging" = "ranging";
  if (htf && htf.length > 20) {
    const hc = htf.map((v) => +v.close);
    const hp = hc[hc.length - 1], hs20 = sma(hc, 20), hs50 = sma(hc, 50);
    const hHi = Math.max(...htf.map((v) => +v.high)), hLo = Math.min(...htf.map((v) => +v.low));
    const trend = hs20 && hs50 ? (hp > hs20 && hs20 > hs50 ? "bullish" : hp < hs20 && hs20 < hs50 ? "bearish" : "ranging") : "ranging";
    htfTrend = trend;
    htfBias = `${trend}; price in ${hp > (hHi + hLo) / 2 ? "premium" : "discount"} of the ${sty.htfLabel} range (${f(hLo)}–${f(hHi)})`;
  }

  // Data-driven higher-probability lean — biases the call toward the side the
  // objective factors favour (so the engine stops, e.g., shorting into an
  // uptrend). The engine ALWAYS returns a direction; the lean just guides it.
  const rsiNow = rsi(closes);
  let leanScore = 0;
  if (htfTrend === "bullish") leanScore += 2; else if (htfTrend === "bearish") leanScore -= 2;
  leanScore += price <= eq ? 1 : -1;
  if (rsiNow != null) { if (rsiNow < 40) leanScore += 1; else if (rsiNow > 60) leanScore -= 1; }
  const leanDir = leanScore >= 0 ? "LONG" : "SHORT";

  // Market open/closed.
  // Crypto trades 24/7. Forex & metals follow the FX week (Sun 21:00 → Fri
  // 21:00 UTC) — Twelve Data's `is_market_open` is unreliable for FX, so the
  // calendar is authoritative there. Stocks & indices: trust the quote when it
  // answers, otherwise fall back to a rough US cash-session window.
  let marketClosed = false;
  const mkt = found.market.id;
  if (mkt !== "crypto") {
    const now = new Date();
    const dow = now.getUTCDay(); // 0 Sun … 6 Sat
    const hr = now.getUTCHours();
    const mins = hr * 60 + now.getUTCMinutes();
    const fxWeekendClosed =
      dow === 6 ||
      (dow === 0 && hr < 21) ||
      (dow === 5 && hr >= 21);

    if (mkt === "forex" || mkt === "metal") {
      // Calendar is authoritative; do not let the quote flip this open.
      marketClosed = fxWeekendClosed;
    } else {
      // Stocks / indices — prefer a definitive quote answer.
      let decided = false;
      try {
        const q = await fetch(`https://api.twelvedata.com/quote?symbol=${encodeURIComponent(td)}&apikey=${mdKey}`, { cache: "no-store" });
        const qj = await q.json();
        if (qj && (qj.is_market_open === true || qj.is_market_open === false)) {
          marketClosed = qj.is_market_open === false;
          decided = true;
        }
      } catch { /* fall through to time window */ }
      if (!decided) {
        // Rough regular US cash session ~13:30–20:00 UTC, closed weekends.
        marketClosed = dow === 0 || dow === 6 || mins < 13 * 60 + 30 || mins >= 20 * 60;
      }
    }
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

ALWAYS return a directional call — LONG or SHORT — for the HIGHER-PROBABILITY side of this market RIGHT NOW. Never return NEUTRAL. When confluence is thin, still pick the better side, note what's missing in the rationale, and keep confidence Low.

The data-driven lean right now is ${leanDir}. Default to ${leanDir} unless clean market structure (a confirmed CHoCH, or a strong opposing point of interest) makes the other side clearly higher-probability — in which case take it and explain why.

CONSISTENCY: the setup, bias, poi, liquidityTarget and rationale MUST all describe the SAME side as "direction". Never write a bearish narrative (e.g. a sweep of buy-side liquidity that reverses down) for a LONG, or a bullish one for a SHORT. If you catch yourself doing that, flip the direction to match the read.

Build the SINGLE highest-probability trade a professional would take — synthesise ACROSS these factors, never rely on just one. The more that genuinely align, the higher the conviction:
- TREND & higher-timeframe bias (${sty.htfLabel}) — trade with it unless a confirmed shift says otherwise.
- MARKET STRUCTURE — BOS / CHoCH and the sequence of swing highs/lows.
- SMART MONEY — order blocks, fair value gaps / imbalances, and liquidity sweeps of equal highs/lows.
- FIBONACCI / OTE — the 0.62–0.79 retracement of the last impulse leg.
- SUPPORT / RESISTANCE & supply/demand zones.
- BREAK & RETEST — price reclaiming a broken level or structure and retesting it.
- MOMENTUM (RSI) — with-trend, or a clean reversal from an overbought/oversold extreme.
Enter at a REAL point of interest where these stack up (not mid-range); stop just beyond the level that invalidates the idea; targets at liquidity / opposing range / next imbalance. Aim for clean R:R (≥1:2 when possible). In the rationale, name the specific factors that line up.

CRITICAL — numbers: the current price is EXACTLY ${price}. Entry, stopLoss and every take-profit MUST be within a few percent of ${price} and in the same order of magnitude — never add or drop a digit. Sanity-check each number against ${price} before returning. LONG: SL below entry, TPs above; SHORT: reverse. Sized for a ${sty.label} play. Use ${dec} decimals.

Respond with ONLY valid minified JSON, exactly:
{"direction":"LONG|SHORT","setup":"the setup in a few words","bias":"HTF bias in a few words","poi":"entry POI zone","liquidityTarget":"the liquidity/objective targeted","entry":number,"stopLoss":number,"takeProfits":[number,number,number],"confidence":"Low|Medium|High","riskReward":"e.g. 1:2.5","timeframe":"${sty.label}","rationale":"2-4 sentences referencing the confirmations you used","invalidation":"one line: the level that kills the idea"}
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

  // ── Anchor & sanity-check the levels against the REAL price ───────────────
  // The AI's raw numbers can drift off the current price or carry an inconsistent
  // stop/target geometry. We repair that in code so every play is tradeable:
  //  • a MARKET order fills at the live price — re-anchor the whole play there,
  //    preserving the AI's stop/target *shape* by shifting every level equally;
  //  • a LIMIT entry must sit on the correct side of price;
  //  • the stop must be on the correct side and a realistic (ATR-scaled) distance;
  //  • targets form a clean ≥1:1.8 ladder if the AI's are missing/too tight;
  //  • the displayed risk:reward is recomputed from the final numbers.
  const isLong = signal.direction !== "SHORT";
  let aiEntry = numOk(signal.entry) ? (signal.entry as number) : price;
  if (Math.abs(aiEntry - price) / price > 0.25) aiEntry = price;   // gross digit-typo guard
  let sl: number | null = numOk(signal.stopLoss) ? (signal.stopLoss as number) : null;
  let tps: number[] = Array.isArray(signal.takeProfits)
    ? (signal.takeProfits as unknown[]).filter(numOk) as number[]
    : [];

  let entry = aiEntry;
  if (orderType === "Market") {
    const delta = price - aiEntry;                                // re-anchor to the live fill price
    entry = price;
    if (sl != null) sl += delta;
    tps = tps.map((t) => t + delta);
  } else if (isLong ? aiEntry > price : aiEntry < price) {
    entry = isLong ? price * 0.999 : price * 1.001;               // limit must pull back / rally to fill
  }

  // ATR of the recent candles → a natural, timeframe-scaled stop distance.
  const trs: number[] = [];
  for (let i = 1; i < recent.length; i++) {
    const h = +recent[i].high, l = +recent[i].low, pc = +recent[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const atr = trs.length ? trs.reduce((a, b) => a + b, 0) / trs.length : (rangeHi - rangeLo) * 0.05 || price * 0.002;
  const stopMult = styleKey === "scalp" ? 1.1 : styleKey === "swing" ? 2.4 : 1.6;
  const fallbackRisk = Math.max(atr * stopMult, price * 0.0006);

  const slValid = sl != null && (isLong ? sl < entry : sl > entry) && Math.abs(entry - sl) >= atr * 0.5 && Math.abs(entry - sl) <= atr * 6;
  if (!slValid) sl = isLong ? entry - fallbackRisk : entry + fallbackRisk;
  const risk = Math.abs(entry - (sl as number)) || fallbackRisk;

  // Keep the AI's targets only if they're on the right side and the nearest is a
  // real reward (≥0.9R); otherwise build a clean 1.0 / 1.8 / 2.8 R ladder.
  let ladder = tps.filter((t) => (isLong ? t > entry : t < entry)).sort((a, b) => (isLong ? a - b : b - a));
  const nearOk = ladder.length >= 3 && Math.abs(ladder[0] - entry) >= risk * 0.9;
  if (!nearOk) ladder = [1.0, 1.8, 2.8].map((m) => (isLong ? entry + risk * m : entry - risk * m));
  ladder = ladder.slice(0, 3);

  const rnd = (n: number) => +n.toFixed(dec);
  signal.entry = rnd(entry);
  signal.stopLoss = rnd(sl as number);
  signal.takeProfits = ladder.map(rnd);
  const midTp = ladder[1] ?? ladder[ladder.length - 1] ?? entry;
  signal.riskReward = `1:${(risk > 0 ? Math.abs(midTp - entry) / risk : 0).toFixed(1)}`;

  // ── Objective, multi-factor confirmation checklist ────────────────────────
  // Each professional factor is computed from the real candles (not the model's
  // self-report). The checklist reflects the factors the trader SELECTED (or a
  // full pro set by default); confidence is the share that confirm.
  const dir = signal.direction === "SHORT" ? "SHORT" : "LONG";
  signal.direction = dir;
  const E = numOk(signal.entry) ? (signal.entry as number) : price;
  const span = (rangeHi - rangeLo) || 1;
  const tol = span * 0.06;                                        // "at a level" ≈ within 6% of the range

  const piv = pivots(highs, lows, 2);
  const shs = piv.sh, sls = piv.sl;
  const lastSH = shs.length ? shs[shs.length - 1] : null;
  const lastSL = sls.length ? sls[sls.length - 1] : null;
  const prevSH = shs.length > 1 ? shs[shs.length - 2] : null;
  const prevSL = sls.length > 1 ? sls[sls.length - 2] : null;

  // Market structure — a break of structure, or a clean HH-HL / LH-LL sequence.
  let structureDir: "LONG" | "SHORT" | "none" = "none";
  if (lastSH && price > lastSH.p) structureDir = "LONG";
  else if (lastSL && price < lastSL.p) structureDir = "SHORT";
  else if (prevSH && lastSH && prevSL && lastSL) {
    if (lastSH.p > prevSH.p && lastSL.p > prevSL.p) structureDir = "LONG";
    else if (lastSH.p < prevSH.p && lastSL.p < prevSL.p) structureDir = "SHORT";
  }

  // Fibonacci OTE — 0.62–0.79 retracement of the last swing leg.
  const legHi = lastSH ? lastSH.p : rangeHi;
  const legLo = lastSL ? lastSL.p : rangeLo;
  const legSpan = (legHi - legLo) || 1;
  const inOTE = dir === "LONG"
    ? E >= legHi - 0.79 * legSpan && E <= legHi - 0.62 * legSpan
    : E >= legLo + 0.62 * legSpan && E <= legLo + 0.79 * legSpan;

  const fvgEdges = [...fvg.bull.flat(), ...fvg.bear.flat()].filter(numOk) as number[];
  const srLevels = [...shs.map((s) => s.p), ...sls.map((s) => s.p), rangeHi, rangeLo, eq].filter(numOk);

  // Liquidity sweep — a wick past a swing that closes back through it.
  const last6 = rows.slice(-6);
  const swept = dir === "LONG"
    ? !!lastSL && last6.some((c) => +c.low < lastSL!.p && +c.close > lastSL!.p)
    : !!lastSH && last6.some((c) => +c.high > lastSH!.p && +c.close < lastSH!.p);

  // Break & retest — a swing broken in our direction that price is now retesting.
  const brOk = dir === "LONG"
    ? shs.some((s) => price > s.p && Math.abs(E - s.p) <= tol * 1.5 && s.i < highs.length - 2)
    : sls.some((s) => price < s.p && Math.abs(E - s.p) <= tol * 1.5 && s.i < lows.length - 2);

  // Momentum — with-trend, or a clean reversal from an overbought/oversold extreme.
  const momentumOk = rsiNow == null ? false
    : dir === "LONG" ? (rsiNow >= 45 && rsiNow <= 72) || rsiNow < 32
    : (rsiNow <= 55 && rsiNow >= 28) || rsiNow > 68;

  const FACTORS: Record<string, { label: string; ok: boolean }> = {
    trend:       { label: "Trend aligned (HTF)",         ok: dir === "LONG" ? htfTrend !== "bearish" : htfTrend !== "bullish" },
    structure:   { label: "Market structure (BOS/CHoCH)", ok: structureDir === dir },
    ob:          { label: "At an order block / origin",  ok: dir === "LONG" ? !!lastSL && Math.abs(E - lastSL.p) <= tol * 1.5 : !!lastSH && Math.abs(E - lastSH.p) <= tol * 1.5 },
    fvg:         { label: "Fair value gap / imbalance",  ok: fvgEdges.some((L) => Math.abs(E - L) <= tol) },
    liquidity:   { label: "Liquidity swept",             ok: swept },
    sr:          { label: "At support / resistance",     ok: srLevels.some((L) => Math.abs(E - L) <= tol) },
    fib:         { label: "In fib OTE zone (0.62–0.79)", ok: inOTE },
    breakRetest: { label: "Break & retest",              ok: brOk },
    rsi:         { label: "Momentum (RSI) agrees",       ok: momentumOk },
  };

  const PRO_DEFAULT = ["trend", "structure", "fvg", "liquidity", "sr", "fib", "breakRetest", "rsi"];
  const active = (confs.length ? confs : PRO_DEFAULT).filter((k) => FACTORS[k]);
  const checklist = active.map((k) => FACTORS[k]);
  const confirmed = checklist.filter((c) => c.ok).length;
  const ratio = checklist.length ? confirmed / checklist.length : 0;
  signal.checklist = checklist;
  signal.confirmed = confirmed;
  signal.total = checklist.length;
  signal.confidence = ratio >= 0.75 ? "High" : ratio >= 0.45 ? "Medium" : "Low";

  // Work succeeded — now charge the credit (best-effort; never charged on failure above).
  const credits = await chargeCredit("signal");

  return json({
    credits,
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
