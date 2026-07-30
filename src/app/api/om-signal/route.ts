import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { gateCredits, chargeCredit } from "@/lib/credits";
import { series, livePrice, isPriorityEmail } from "@/lib/marketData";
import { findAsset } from "@/data/signalAssets";
import { logSignal } from "@/lib/signalLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.OM_AI_MODEL || "claude-sonnet-4-6";

type Row = { datetime: string; open: string; high: string; low: string; close: string };
type Trend = "bullish" | "bearish" | "ranging";
type Dir = "LONG" | "SHORT";
type Factor = { label: string; ok: boolean };
type TFResult = { checklist: Factor[]; confirmed: number; total: number; tfTrend: Trend };
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
// Community-cached candle pull via the shared fetcher (skips API + budget on a cache hit).
async function fetchSeries(td: string, interval: string, size: number, key: string, fresh = false): Promise<Row[] | "ratelimit" | null> {
  return series(td, interval, size, key, fresh);
}

// Short-lived in-memory cache for the higher-timeframe "flow" candles (4H/1H).
// These barely change minute-to-minute, so caching them means a member can
// rapidly re-generate a scalp without re-pulling the slow frames every time —
// which keeps us well under Twelve Data's 8-requests/minute free limit. The
// cache lives on the warm serverless instance and is best-effort only.
type CacheEntry = { at: number; rows: Row[] };
const flowCache = new Map<string, CacheEntry>();
async function fetchSeriesCached(td: string, interval: string, size: number, key: string, ttlMs: number, fresh = false): Promise<Row[] | "ratelimit" | null> {
  const ck = `${td}|${interval}|${size}`;
  const now = Date.now();
  if (!fresh) {
    const hit = flowCache.get(ck);
    if (hit && now - hit.at < ttlMs) return hit.rows;
  }
  const res = await fetchSeries(td, interval, size, key, fresh);
  if (Array.isArray(res)) flowCache.set(ck, { at: now, rows: res });
  return res;
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
async function fetchLivePrice(td: string, key: string, fresh = false): Promise<number | null> {
  return livePrice(td, key, fresh);
}

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

// Simple trend read for one timeframe: price vs SMA20 vs SMA50 alignment.
function trendOf(rows: Row[] | null): Trend {
  if (!rows || rows.length < 20) return "ranging";
  const c = rows.map((v) => +v.close);
  const p = c[c.length - 1], s20 = sma(c, 20), s50 = sma(c, 50);
  if (!s20 || !s50) return "ranging";
  return p > s20 && s20 > s50 ? "bullish" : p < s20 && s20 < s50 ? "bearish" : "ranging";
}

// Combine the 4H and 1H reads into one "market flow". When both agree (and
// neither is ranging) the flow is aligned and strong. When they disagree we
// FOLLOW THE 1H direction but flag the flow as not-aligned, so confidence gets
// capped downstream. Both ranging → no clear flow.
function combineFlow(t4: Trend, t1: Trend): { t4: Trend; t1: Trend; dir: Dir | null; trend: Trend; aligned: boolean } {
  let dir: Dir | null = null;
  let trend: Trend = "ranging";
  let aligned = false;
  if (t4 !== "ranging" && t4 === t1) { trend = t4; aligned = true; dir = t4 === "bullish" ? "LONG" : "SHORT"; }
  else if (t1 !== "ranging") { trend = t1; dir = t1 === "bullish" ? "LONG" : "SHORT"; }
  else if (t4 !== "ranging") { trend = t4; dir = t4 === "bullish" ? "LONG" : "SHORT"; }
  return { t4, t1, dir, trend, aligned };
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
  breakRetest: "Break & retest of a reclaimed level or structure",
  volume: "Volume behaviour (expansion on displacement)",
};

// Objective, multi-factor confirmation checklist computed from ONE timeframe's
// real candles (not the model's self-report). `E` is the entry price we're
// checking for confluence; `flowTrend` is the shared higher-timeframe bias used
// for the "trend aligned" factor. Returns the checklist plus this frame's own
// trend so the card can show it.
function buildChecklist(rows: Row[], dir: Dir, E: number, flowTrend: Trend, confs: string[]): TFResult {
  const highs = rows.map((v) => +v.high);
  const lows = rows.map((v) => +v.low);
  const closes = rows.map((v) => +v.close);
  const rangeHi = Math.max(...highs.slice(-40));
  const rangeLo = Math.min(...lows.slice(-40));
  const eq = (rangeHi + rangeLo) / 2;
  const span = (rangeHi - rangeLo) || 1;
  const tol = span * 0.06;
  const fvg = findFVGs(rows.slice(-30));
  const rsiNow = rsi(closes);
  const price = closes[closes.length - 1];

  const piv = pivots(highs, lows, 2);
  const shs = piv.sh, sls = piv.sl;
  const lastSH = shs.length ? shs[shs.length - 1] : null;
  const lastSL = sls.length ? sls[sls.length - 1] : null;
  const prevSH = shs.length > 1 ? shs[shs.length - 2] : null;
  const prevSL = sls.length > 1 ? sls[sls.length - 2] : null;

  let structureDir: "LONG" | "SHORT" | "none" = "none";
  if (lastSH && price > lastSH.p) structureDir = "LONG";
  else if (lastSL && price < lastSL.p) structureDir = "SHORT";
  else if (prevSH && lastSH && prevSL && lastSL) {
    if (lastSH.p > prevSH.p && lastSL.p > prevSL.p) structureDir = "LONG";
    else if (lastSH.p < prevSH.p && lastSL.p < prevSL.p) structureDir = "SHORT";
  }

  const legHi = lastSH ? lastSH.p : rangeHi;
  const legLo = lastSL ? lastSL.p : rangeLo;
  const legSpan = (legHi - legLo) || 1;
  const inOTE = dir === "LONG"
    ? E >= legHi - 0.79 * legSpan && E <= legHi - 0.62 * legSpan
    : E >= legLo + 0.62 * legSpan && E <= legLo + 0.79 * legSpan;

  const fvgEdges = [...fvg.bull.flat(), ...fvg.bear.flat()].filter(numOk) as number[];
  const srLevels = [...shs.map((s) => s.p), ...sls.map((s) => s.p), rangeHi, rangeLo, eq].filter(numOk);

  const last6 = rows.slice(-6);
  const swept = dir === "LONG"
    ? !!lastSL && last6.some((c) => +c.low < lastSL!.p && +c.close > lastSL!.p)
    : !!lastSH && last6.some((c) => +c.high > lastSH!.p && +c.close < lastSH!.p);

  const brOk = dir === "LONG"
    ? shs.some((s) => price > s.p && Math.abs(E - s.p) <= tol * 1.5 && s.i < highs.length - 2)
    : sls.some((s) => price < s.p && Math.abs(E - s.p) <= tol * 1.5 && s.i < lows.length - 2);

  const momentumOk = rsiNow == null ? false
    : dir === "LONG" ? (rsiNow >= 45 && rsiNow <= 72) || rsiNow < 32
    : (rsiNow <= 55 && rsiNow >= 28) || rsiNow > 68;

  const FACTORS: Record<string, Factor> = {
    trend:       { label: "Trend aligned (HTF)",          ok: dir === "LONG" ? flowTrend !== "bearish" : flowTrend !== "bullish" },
    structure:   { label: "Market structure (BOS/CHoCH)", ok: structureDir === dir },
    ob:          { label: "At an order block / origin",   ok: dir === "LONG" ? !!lastSL && Math.abs(E - lastSL.p) <= tol * 1.5 : !!lastSH && Math.abs(E - lastSH.p) <= tol * 1.5 },
    fvg:         { label: "Fair value gap / imbalance",   ok: fvgEdges.some((L) => Math.abs(E - L) <= tol) },
    liquidity:   { label: "Liquidity swept",              ok: swept },
    sr:          { label: "At support / resistance",      ok: srLevels.some((L) => Math.abs(E - L) <= tol) },
    fib:         { label: "In fib OTE zone (0.62–0.79)",  ok: inOTE },
    breakRetest: { label: "Break & retest",               ok: brOk },
    rsi:         { label: "Momentum (RSI) agrees",        ok: momentumOk },
  };

  const PRO_DEFAULT = ["trend", "structure", "fvg", "liquidity", "sr", "fib", "breakRetest", "rsi"];
  const active = (confs.length ? confs : PRO_DEFAULT).filter((k) => FACTORS[k]);
  const checklist = active.map((k) => FACTORS[k]);
  const confirmed = checklist.filter((c) => c.ok).length;

  const s20 = sma(closes, 20), s50 = sma(closes, 50), last = closes[closes.length - 1];
  const tfTrend: Trend = s20 && s50 ? (last > s20 && s20 > s50 ? "bullish" : last < s20 && s20 < s50 ? "bearish" : "ranging") : "ranging";
  return { checklist, confirmed, total: checklist.length, tfTrend };
}

export async function POST(req: NextRequest) {
  const supabase = createClient();
  let fresh = false; // owner/admin: always fresh data, never throttled
  let loggedUserId: string | null = null;
  if (supabase) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
    fresh = isPriorityEmail(user.email);
    loggedUserId = user.id;
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
    scalp: { interval: "15min", htf: "1h", htfLabel: "4H/1H flow", label: "Scalp (5·15·30m)", note: "a very short-term scalp — tight stop, nearby targets" },
    intraday: { interval: "1h", htf: "4h", htfLabel: "4H", label: "Intraday (1H)", note: "an intraday trade on the 1H timeframe" },
    swing: { interval: "1day", htf: "1week", htfLabel: "1W", label: "Swing (Daily)", note: "a multi-day swing on the daily timeframe" },
  };
  const styleKey = typeof body?.style === "string" && STYLE[body.style] ? (body.style as string) : "intraday";
  const sty = STYLE[styleKey];
  const isScalp = styleKey === "scalp";
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

  const RL_MSG = "You've hit the free market-data limit (8 requests a minute). Give it about a minute, then generate again.";

  // ── Gather candles ────────────────────────────────────────────────────────
  // Scalp: 30m + 15m(entry) + 5m for the trade, 4H + 1H (cached) for the flow.
  // Intraday/swing: a single execution frame + one higher-timeframe bias frame.
  let rows: Row[] | null;
  let m30: Row[] | null = null;
  let m5: Row[] | null = null;
  let flow: { t4: Trend; t1: Trend; dir: Dir | null; trend: Trend; aligned: boolean } | null = null;

  if (isScalp) {
    const [r30, r15, r5, r4h, r1h] = await Promise.all([
      fetchSeries(td, "30min", 80, mdKey, fresh),
      fetchSeries(td, "15min", 80, mdKey, fresh),
      fetchSeries(td, "5min", 80, mdKey, fresh),
      fetchSeriesCached(td, "4h", 60, mdKey, 120000, fresh),
      fetchSeriesCached(td, "1h", 60, mdKey, 60000, fresh),
    ]);
    if (r15 === "ratelimit" || r30 === "ratelimit" || r5 === "ratelimit") return json({ error: "ratelimit", detail: RL_MSG }, 429);
    rows = cleanRows(Array.isArray(r15) ? r15 : null);
    m30 = cleanRows(Array.isArray(r30) ? r30 : null);
    m5 = cleanRows(Array.isArray(r5) ? r5 : null);
    const f4 = cleanRows(Array.isArray(r4h) ? r4h : null);
    const f1 = cleanRows(Array.isArray(r1h) ? r1h : null);
    flow = combineFlow(trendOf(f4), trendOf(f1));
  } else {
    const rowsRes = await fetchSeries(td, sty.interval, 80, mdKey, fresh);
    if (rowsRes === "ratelimit") return json({ error: "ratelimit", detail: RL_MSG }, 429);
    rows = cleanRows(rowsRes);
  }
  if (!rows || rows.length < 25) return json({ error: "marketdata_error", detail: "not enough price history for this asset on this timeframe — try a different timeframe." }, 502);

  const closes = rows.map((v) => +v.close);
  const highs = rows.map((v) => +v.high);
  const lows = rows.map((v) => +v.low);
  // Anchor to the LIVE tick when we can get it (matches the "current price" the
  // card shows and the price a market order actually fills at); fall back to the
  // last candle close. A 5% sanity band rejects a garbage tick.
  const candleClose = closes[closes.length - 1];
  const liveTick = await fetchLivePrice(td, mdKey, fresh);
  const price = (liveTick != null && Math.abs(liveTick - candleClose) / candleClose < 0.05) ? liveTick : candleClose;
  const rangeHi = Math.max(...highs.slice(-40));
  const rangeLo = Math.min(...lows.slice(-40));
  const eq = (rangeHi + rangeLo) / 2;
  const zone = price > eq ? "PREMIUM (above equilibrium)" : "DISCOUNT (below equilibrium)";
  const fvg = findFVGs(rows.slice(-30));
  const dec = price >= 1000 ? 2 : price >= 1 ? 4 : 6;
  const f = (n: number) => n.toFixed(dec);
  const briefTf = (rws: Row[] | null): string => {
    if (!rws || rws.length < 10) return "unavailable";
    const c = rws.map((v) => +v.close), h = rws.map((v) => +v.high), l = rws.map((v) => +v.low);
    const hi = Math.max(...h.slice(-30)), lo = Math.min(...l.slice(-30)), rr = rsi(c);
    return `trend ${trendOf(rws)}, range ${f(lo)}–${f(hi)}, RSI ${rr != null ? rr.toFixed(0) : "n/a"}`;
  };

  // Higher-timeframe bias / market flow
  let htfBias = "unavailable";
  let htfTrend: Trend = "ranging";
  if (isScalp && flow) {
    htfTrend = flow.trend;
    htfBias = `4H ${flow.t4}, 1H ${flow.t1} → ${flow.aligned ? `aligned ${flow.dir}` : flow.dir ? `mixed, following 1H (${flow.dir})` : "no clear flow"}`;
  } else if (!isScalp) {
    const htfRes = await fetchSeries(td, sty.htf, 60, mdKey, fresh);
    const htf = Array.isArray(htfRes) ? cleanRows(htfRes) : null;
    if (htf && htf.length > 20) {
      const hc = htf.map((v) => +v.close);
      const hp = hc[hc.length - 1], hs20 = sma(hc, 20), hs50 = sma(hc, 50);
      const hHi = Math.max(...htf.map((v) => +v.high)), hLo = Math.min(...htf.map((v) => +v.low));
      const trend: Trend = hs20 && hs50 ? (hp > hs20 && hs20 > hs50 ? "bullish" : hp < hs20 && hs20 < hs50 ? "bearish" : "ranging") : "ranging";
      htfTrend = trend;
      htfBias = `${trend}; price in ${hp > (hHi + hLo) / 2 ? "premium" : "discount"} of the ${sty.htfLabel} range (${f(hLo)}–${f(hHi)})`;
    }
  }

  // Direction is TREND-FIRST. We trade WITH the higher-timeframe flow and never
  // against it: in a downtrend we SELL pullbacks, in an uptrend we BUY dips.
  // Mean-reversion (discount zone / oversold RSI) is ONLY allowed to pick a side
  // when the higher timeframe is genuinely rangebound — a falling market can stay
  // "oversold" for a long time, so oversold RSI must NEVER, on its own, call a
  // long into a bearish trend. (This is the exact bug that produced repeated BUY
  // scalps into a falling gold market: bearish −2, discount +1, oversold +1 = 0,
  // and the old `>= 0` tie defaulted to LONG.) For a scalp, htfTrend is the
  // combined 4H/1H flow, so the flow is authoritative here too.
  const rsiNow = rsi(closes);
  let requiredDir: Dir;
  if (htfTrend === "bearish") requiredDir = "SHORT";
  else if (htfTrend === "bullish") requiredDir = "LONG";
  else {
    // Rangebound only: fade the extreme back toward equilibrium.
    let mr = 0;
    mr += price <= eq ? 1 : -1;
    if (rsiNow != null) { if (rsiNow < 35) mr += 1; else if (rsiNow > 65) mr -= 1; }
    requiredDir = mr >= 0 ? "LONG" : "SHORT";
  }
  const leanDir = requiredDir;                        // kept for the prompt below
  const trendLocked = htfTrend !== "ranging";         // clear trend → direction is not negotiable
  // A genuinely STRONG trend (clear direction + both HTF frames aligned for a scalp
  // + with-trend momentum) unlocks breakout-continuation entries, so the engine can
  // join a runaway move instead of only ever waiting for a pullback that may not come.
  const momWithTrend = rsiNow != null && (requiredDir === "LONG" ? rsiNow >= 55 : rsiNow <= 45);
  const strongTrend = trendLocked && (flow ? flow.aligned : true) && momWithTrend;

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

  const scalpDirective = isScalp
    ? `\nThis is a SCALP. Take DIRECTION from the higher-timeframe 4H/1H flow (${htfBias}). Then TIME the trade using the shorter frames: the 30m quick move, the 15m entry, and the 5m for what is about to happen right now. Keep the stop tight and the targets nearby — a typical scalp is a quick 30–150 pip move. Entry, stop and every take-profit must sit on the 15m structure.\n`
    : "";

  const system = `You are OM AI's signal engine for the 1 Mission trading community.
${methodLine}
${confLine}
${scalpDirective}
Build the play: 1) align with the ${sty.htfLabel} bias; 2) identify the draw on liquidity / next objective; 3) place entry at a valid point of interest confirmed by displacement/structure, in the correct premium/discount zone; 4) stop-loss just beyond the level that invalidates it; targets at liquidity / opposing range / next imbalance. Aim for clean R:R (≥1:2 when possible).

ALWAYS return a directional call — LONG or SHORT. Never return NEUTRAL. This is a WITH-TREND engine: you trade in the direction of the higher-timeframe flow, NEVER against it. Buying a downtrend or shorting an uptrend is prohibited.

DIRECTION IS ${leanDir}. ${trendLocked
  ? `The higher-timeframe flow is ${htfTrend.toUpperCase()}, so this MUST be a ${leanDir} — a with-trend continuation. ${strongTrend
      ? `This is a STRONG, aligned trend with momentum behind it, so you may enter EITHER of two ways — pick whichever the CURRENT price action actually offers, do not invent one that isn't there: (a) PULLBACK — ${leanDir === "SHORT" ? "sell a rally UP into a premium POI (bearish order block, unfilled bearish FVG, broken support now resistance, or the 0.62–0.79 retracement of the last down-leg)" : "buy a dip DOWN into a discount POI (bullish order block, unfilled bullish FVG, reclaimed resistance now support, or the 0.62–0.79 retracement of the last up-leg)"}; OR (b) BREAKOUT CONTINUATION — if price is breaking structure to a fresh ${leanDir === "SHORT" ? "low" : "high"} with displacement and NO clean pullback is on offer, enter the break itself at market, with the stop tucked just ${leanDir === "SHORT" ? "above the broken low (now resistance)" : "below the broken high (now support)"}. When a strong trend is running and not retracing, the break IS the entry — do not sit out the move waiting for a pullback that isn't coming.`
      : `${leanDir === "SHORT"
        ? "SELL a pullback/rally UP into a premium point of interest: a broken support now acting as resistance, a bearish order block, an unfilled bearish FVG, or the 0.62–0.79 retracement of the last down-leg. Do NOT buy the bounce, do NOT try to catch the falling knife, and do NOT sell the low — wait for price to rally into resistance and sell the continuation down."
        : "BUY a pullback/dip DOWN into a discount point of interest: a reclaimed resistance now acting as support, a bullish order block, an unfilled bullish FVG, or the 0.62–0.79 retracement of the last up-leg. Do NOT short the dip and do NOT chase the high — wait for price to pull back into support and buy the continuation up."}`} A counter-trend ${leanDir === "SHORT" ? "LONG" : "SHORT"} is NOT permitted no matter how oversold/overbought RSI looks or how far price has already run.`
  : `The higher timeframe is rangebound, so fade the range: ${leanDir} back toward equilibrium from the ${leanDir === "LONG" ? "discount (lower)" : "premium (upper)"} extreme. If price is mid-range with no clean edge, say so in the rationale and keep confidence Low.`}

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

  const scalpContext = isScalp
    ? `SCALP MULTI-TIMEFRAME:
Market flow (bigger picture) — 4H: ${flow?.t4}, 1H: ${flow?.t1} → ${flow?.aligned ? `aligned ${flow?.dir}` : flow?.dir ? `mixed, following the 1H (${flow?.dir})` : "no clear flow — trade the cleaner side"}
30m (near-term quick move): ${briefTf(m30)}
5m (immediate trigger / what's about to happen): ${briefTf(m5)}
Entry, stop and targets are anchored on the 15m candles below.\n`
    : "";

  const user = `Asset: ${found.asset.symbol} (${found.asset.name}) · ${orderType} · ${sty.label}
Current price: ${f(price)}${marketClosed ? " (market currently CLOSED — analyse last session)" : ""}
${isScalp ? scalpContext : `Higher-timeframe (${sty.htfLabel}) bias: ${htfBias}`}
Dealing range (last 40 bars, 15m): high(BSL) ${f(rangeHi)} | low(SSL) ${f(rangeLo)} | equilibrium ${f(eq)} → price is in ${zone}
Momentum (15m): RSI(14) ${rsi(closes)?.toFixed(1) ?? "n/a"} | SMA20 ${sma(closes, 20) ? f(sma(closes, 20)!) : "n/a"} | SMA50 ${sma(closes, 50) ? f(sma(closes, 50)!) : "n/a"}
Recent unfilled FVGs (15m) — bullish: ${fvg.bull.map(([a, b]) => `${f(a)}-${f(b)}`).join(", ") || "none"} | bearish: ${fvg.bear.map(([a, b]) => `${f(a)}-${f(b)}`).join(", ") || "none"}
Recent 40 candles (O,H,L,C, oldest→newest): ${series}
Return the JSON signal now.`;

  let ai: { content?: { type?: string; text?: string }[]; error?: { message?: string } };
  try {
    const r = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": aiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: 900, system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: user }] }),
    });
    ai = await r.json();
    if (!r.ok) return json({ error: "ai_error", detail: (ai?.error?.message || `status ${r.status}`).slice(0, 200) }, 502);
  } catch { return json({ error: "ai_unreachable" }, 502); }

  const raw = Array.isArray(ai.content) ? ai.content.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("") : "";
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return json({ error: "parse_error" }, 502);
  let signal: Record<string, unknown>;
  try { signal = JSON.parse(match[0]); } catch { return json({ error: "parse_error" }, 502); }

  // ── Hard-lock direction to the with-trend requirement ─────────────────────
  // The ENGINE, not the model, owns direction whenever the higher timeframe has
  // a clear trend. If the model still tried to fade the trend (e.g. a bounce
  // long in a downtrend), we flip it back to the with-trend side here. This is
  // the guard that stops BUY calls in a falling market from ever reaching a user.
  if (trendLocked && signal.direction !== requiredDir) {
    signal.direction = requiredDir;
    signal.confidence = "Low";                 // model disagreed with the trend → be cautious
    signal._directionCorrected = true;         // surfaced in logs / debugging
  }

  // ── Anchor & sanity-check the levels against the REAL price ───────────────
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

  // ── Price-extended heads-up (NON-BLOCKING) ────────────────────────────────
  // The play is ALWAYS produced. A retest/limit entry is valid even when price
  // has moved past it — price routinely runs, comes back to retest, and then
  // continues. We NEVER withhold the trade. We only ATTACH a soft heads-up when
  // live price has already travelled well past the ideal limit entry (≥1.5× the
  // planned stop), so the trader knows the retest may be shallow or may not fill.
  // Market entries (entry == live price) never trigger it.
  const asOfStamp = new Date().toISOString();
  const chaseRun = isLong ? price - entry : entry - price;   // distance live price ran past the ideal limit entry
  const chaseRunR = risk > 0 ? chaseRun / risk : 0;
  const priceExtended = orderType === "Limit" && chaseRunR >= 1.5;
  signal.chased = priceExtended;               // kept as `chased` for the UI's existing binding
  signal.live_price = rnd(price);
  signal.as_of = asOfStamp;
  if (priceExtended) {
    signal.ran_r = +chaseRunR.toFixed(1);
    signal.chase_note = `Heads up — price has already moved ${chaseRunR.toFixed(1)}× the planned stop past the ideal entry (${rnd(entry)} → now ${rnd(price)}) since this level formed. The retest may be shallow or may not fill; wait for price to come back to the level rather than chasing it here.`;
  }

  // ── Objective, multi-factor confirmation checklist ────────────────────────
  const dir: Dir = signal.direction === "SHORT" ? "SHORT" : "LONG";
  signal.direction = dir;
  const E = numOk(signal.entry) ? (signal.entry as number) : price;

  if (isScalp && flow) {
    // Run the full confirmation stack on EACH scalp frame (30m / 15m / 5m).
    const frames: { tf: string; rows: Row[] | null }[] = [
      { tf: "30m", rows: m30 },
      { tf: "15m", rows },
      { tf: "5m", rows: m5 },
    ];
    const tfOut = frames.map(({ tf, rows: fr }) => {
      if (!fr || fr.length < 20) return { tf, trend: "ranging" as Trend, confirmed: 0, total: 0, checklist: [] as Factor[], unavailable: true };
      const cl = buildChecklist(fr, dir, E, flow!.trend, confs);
      return { tf, trend: cl.tfTrend, confirmed: cl.confirmed, total: cl.total, checklist: cl.checklist, unavailable: false };
    });

    const totalConfirmed = tfOut.reduce((a, t) => a + t.confirmed, 0);
    const totalFactors = tfOut.reduce((a, t) => a + t.total, 0);
    const ratio = totalFactors ? totalConfirmed / totalFactors : 0;
    let level = ratio >= 0.7 ? 3 : ratio >= 0.45 ? 2 : 1;         // 3 High · 2 Medium · 1 Low
    if (flow.dir && dir !== flow.dir) level = Math.max(1, level - 1); // counter-flow trade → knock down a level
    if (!flow.aligned) level = Math.min(level, 2);                // mixed 4H/1H flow → cap at Medium
    const confidence = level >= 3 ? "High" : level >= 2 ? "Medium" : "Low";

    signal.confidence = confidence;
    signal.confirmed = totalConfirmed;
    signal.total = totalFactors;
    signal.checklist = tfOut[1].checklist;                        // 15m list for the compact card / back-compat
    signal.timeframes = tfOut;
    signal.flow = { h4: flow.t4, h1: flow.t1, dir: flow.dir ?? "—", aligned: flow.aligned };
    signal.verdict = confidence === "High"
      ? "High-probability — the 4H/1H flow and the 30/15/5 timing line up."
      : confidence === "Medium"
      ? "Reasonable setup — partial confluence; manage risk and size sensibly."
      : "Lower-probability — thin confirmation right now; wait for a cleaner trigger or size down.";
  } else {
    const cl = buildChecklist(rows, dir, E, htfTrend, confs);
    signal.checklist = cl.checklist;
    signal.confirmed = cl.confirmed;
    signal.total = cl.total;
    const ratio = cl.total ? cl.confirmed / cl.total : 0;
    signal.confidence = ratio >= 0.75 ? "High" : ratio >= 0.45 ? "Medium" : "Low";
  }

  // Work succeeded — now charge the credit (best-effort; never charged on failure above).
  const credits = await chargeCredit("signal");

  // Universal outcome logging (fire-and-safe: never blocks or breaks the signal).
  await logSignal({
    engine: "plays", userId: loggedUserId, instrument: td, symbol: found.asset.symbol,
    style: styleKey, method, direction: dir, orderType,
    entry: signal.entry as number, stop: signal.stopLoss as number, tps: signal.takeProfits as number[],
    confidence: signal.confidence as string, regime: htfTrend, atr, priceAtIssue: price, interval: sty.interval,
    meta: { directionCorrected: signal._directionCorrected ?? false, confirmed: signal.confirmed ?? null, total: signal.total ?? null },
  });

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
    as_of: asOfStamp,
    live_price: rnd(price),
    marketClosed,
    candles: recent.map((v) => ({ t: v.datetime, o: +v.open, h: +v.high, l: +v.low, c: +v.close })),
    signal,
  }, 200);
}

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
