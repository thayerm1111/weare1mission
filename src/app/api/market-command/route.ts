import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { gateCredits, chargeCredit } from "@/lib/credits";
import { reserveMarketData, resolveTd, livePriceSane } from "@/lib/marketData";
import { getProfile } from "@/lib/auth";
import { logSignal } from "@/lib/signalLog";
import { assessNews } from "@/lib/econCalendar";
import { evaluateSetup, confirmationSignals } from "@/lib/confirmation";
import { getAdjustmentPenalty } from "@/lib/learningStore";
import { mtfAlign, closedBars } from "@/lib/mtf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * OM AI MARKET COMMAND — deterministic setup-qualification engine.
 *
 * The most important property of this route: it will return NO TRADE far more
 * often than a setup. EVERY price, level, stop, target, score and regime is
 * computed here in code from validated Twelve Data candles — the LLM is used
 * ONLY to turn the finished, locked JSON into a plain-English explanation and
 * never to invent or change a number.
 *
 * Pipeline: verify data → data-quality gate → classify regime → pick strategy →
 * compute entry/stop/targets → independent risk engine (can veto) → score →
 * news gate (mock until ECON_CALENDAR_API_KEY is set) → qualified setup OR
 * NO TRADE with an explicit reason. Educational analysis, not financial advice.
 */
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.OM_AI_MODEL || "claude-sonnet-4-6";

// ── Config (these become admin-editable settings in a later phase) ───────────
const CFG = {
  minRR: 1.8,               // minimum reward-to-risk to qualify (TP1)
  minScore: 62,             // minimum overall score (0-100) to qualify
  maxStopAtr: 3.0,          // reject if the structural stop is wider than N×ATR
  minStopAtr: 0.4,          // reject if the stop is unrealistically tight
  staleMult: 3.0,           // data is stale if the last candle is older than N intervals
  defaultBalance: 10000,    // used for position sizing when the caller sends none
  defaultRiskPct: 1.0,      // % of balance risked per trade
  setupTtlMin: { "5min": 45, "15min": 120, "1h": 360 } as Record<string, number>,
};

type Row = { datetime: string; open: string; high: string; low: string; close: string; volume?: string };
type Cat = "forex" | "gold" | "commodity" | "index" | "crypto" | "stock";
type Dir = "buy" | "sell";
const numOk = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

// ── Instrument specifications ────────────────────────────────────────────────
// Never one generic pip formula. Each instrument declares its pip size, the USD
// value of one pip per 1.0 standard lot/unit, lot stepping and the sizing unit.
type Spec = { cat: Cat; pip: number; pipValuePerLot: number; lotStep: number; minLot: number; maxLot: number; unit: string; quote: string };
function specFor(td: string): Spec {
  const s = td.toUpperCase();
  if (s === "XAU/USD" || s.includes("GOLD")) return { cat: "gold", pip: 0.1, pipValuePerLot: 10, lotStep: 0.01, minLot: 0.01, maxLot: 50, unit: "lots (100oz)", quote: "USD" };
  if (s === "XAG/USD" || s.includes("SILVER")) return { cat: "commodity", pip: 0.01, pipValuePerLot: 50, lotStep: 0.01, minLot: 0.01, maxLot: 50, unit: "lots (5000oz)", quote: "USD" };
  if (s === "WTI/USD" || s === "USOIL" || s === "UKOIL" || s.includes("OIL")) return { cat: "commodity", pip: 0.01, pipValuePerLot: 10, lotStep: 0.01, minLot: 0.01, maxLot: 100, unit: "lots (1000bbl)", quote: "USD" };
  if (/(SPY|QQQ|DIA|NAS100|US30|SPX500|GER40|UK100|NDX|US100|US500)/.test(s)) return { cat: "index", pip: 1, pipValuePerLot: 1, lotStep: 1, minLot: 1, maxLot: 10000, unit: "units", quote: "USD" };
  if (/(BTC|ETH|SOL|XRP|DOGE)\/?USD/.test(s)) return { cat: "crypto", pip: 1, pipValuePerLot: 1, lotStep: 0.001, minLot: 0.001, maxLot: 1000, unit: "coins", quote: "USD" };
  if (/^[A-Z]{3}\/[A-Z]{3}$/.test(s)) {
    const jpy = s.endsWith("/JPY");
    return { cat: "forex", pip: jpy ? 0.01 : 0.0001, pipValuePerLot: jpy ? 6.7 : 10, lotStep: 0.01, minLot: 0.01, maxLot: 100, unit: "lots (100k)", quote: s.split("/")[1] };
  }
  // Equities / everything else: size in shares, $0.01 pip.
  return { cat: "stock", pip: 0.01, pipValuePerLot: 0.01, lotStep: 1, minLot: 1, maxLot: 100000, unit: "shares", quote: "USD" };
}

// ── Indicators (all deterministic) ───────────────────────────────────────────
function sma(v: number[], n: number): number | null { return v.length < n ? null : v.slice(-n).reduce((a, b) => a + b, 0) / n; }
function rsi(c: number[], p = 14): number | null {
  if (c.length < p + 1) return null;
  let g = 0, l = 0;
  for (let i = c.length - p; i < c.length; i++) { const d = c[i] - c[i - 1]; if (d >= 0) g += d; else l -= d; }
  const ag = g / p, al = l / p; if (al === 0) return 100; return 100 - 100 / (1 + ag / al);
}
function atr(rows: Row[], p = 14): number | null {
  if (rows.length < p + 1) return null;
  const tr: number[] = [];
  for (let i = 1; i < rows.length; i++) { const h = +rows[i].high, l = +rows[i].low, pc = +rows[i - 1].close; tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc))); }
  return sma(tr, p);
}
// Wilder ADX + directional movement.
function adx(rows: Row[], p = 14): { adx: number | null; pdi: number | null; mdi: number | null } {
  if (rows.length < p * 2) return { adx: null, pdi: null, mdi: null };
  const plus: number[] = [], minus: number[] = [], tr: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    const h = +rows[i].high, l = +rows[i].low, ph = +rows[i - 1].high, pl = +rows[i - 1].low, pc = +rows[i - 1].close;
    const up = h - ph, dn = pl - l;
    plus.push(up > dn && up > 0 ? up : 0);
    minus.push(dn > up && dn > 0 ? dn : 0);
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const smooth = (arr: number[]) => { let s = arr.slice(0, p).reduce((a, b) => a + b, 0); const out = [s]; for (let i = p; i < arr.length; i++) { s = s - s / p + arr[i]; out.push(s); } return out; };
  const trS = smooth(tr), plusS = smooth(plus), minusS = smooth(minus);
  const dx: number[] = [];
  for (let i = 0; i < trS.length; i++) {
    const pdi = trS[i] ? (100 * plusS[i]) / trS[i] : 0;
    const mdi = trS[i] ? (100 * minusS[i]) / trS[i] : 0;
    dx.push(pdi + mdi ? (100 * Math.abs(pdi - mdi)) / (pdi + mdi) : 0);
  }
  const adxVal = dx.length >= p ? sma(dx.slice(-p), p) : sma(dx, dx.length);
  const lastTr = trS[trS.length - 1] || 1;
  return { adx: adxVal, pdi: (100 * plusS[plusS.length - 1]) / lastTr, mdi: (100 * minusS[minusS.length - 1]) / lastTr };
}
function pivots(h: number[], l: number[], k = 2) {
  const sh: { i: number; p: number }[] = [], sl: { i: number; p: number }[] = [];
  for (let i = k; i < h.length - k; i++) {
    let isH = true, isL = true;
    for (let j = i - k; j <= i + k; j++) { if (j === i) continue; if (h[j] >= h[i]) isH = false; if (l[j] <= l[i]) isL = false; }
    if (isH) sh.push({ i, p: h[i] }); if (isL) sl.push({ i, p: l[i] });
  }
  return { sh, sl };
}

// ── Data fetch ───────────────────────────────────────────────────────────────
async function series(td: string, interval: string, size: number, key: string): Promise<Row[] | "ratelimit" | null> {
  const { fetchTd, scale } = resolveTd(td);
  try {
    const r = await fetch(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(fetchTd)}&interval=${interval}&outputsize=${size}&apikey=${key}`, { cache: "no-store" });
    const j = await r.json();
    if (j.status === "error" || !Array.isArray(j.values)) {
      const msg = String(j?.message || "");
      if (r.status === 429 || j?.code === 429 || /credit|limit|per minute/i.test(msg)) return "ratelimit";
      return null;
    }
    const rows = [...(j.values as Row[])].reverse();
    if (scale === 1) return rows;
    const m = (x: string) => String(Number(x) * scale);
    return rows.map((v) => ({ ...v, open: m(v.open), high: m(v.high), low: m(v.low), close: m(v.close) }));
  } catch { return null; }
}
async function livePrice(td: string, key: string): Promise<number | null> {
  const { fetchTd, scale } = resolveTd(td);
  try { const r = await fetch(`https://api.twelvedata.com/price?symbol=${encodeURIComponent(fetchTd)}&apikey=${key}`, { cache: "no-store" }); const j = await r.json(); const p = Number(j?.price); return Number.isFinite(p) ? p * scale : null; } catch { return null; }
}

const INTERVAL_MS: Record<string, number> = { "5min": 300000, "15min": 900000, "1h": 3600000, "1day": 86400000 };

// Session by UTC hour (rough): Asia / London / New York / off-hours.
function sessionNow(d: Date): string {
  const h = d.getUTCHours();
  if (h >= 0 && h < 7) return "Asian";
  if (h >= 7 && h < 12) return "London";
  if (h >= 12 && h < 16) return "London/NY overlap";
  if (h >= 16 && h < 21) return "New York";
  return "Off-session";
}

export async function POST(req: NextRequest) {
  // Auth + admin gate (this feature is admin-only during the beta phase).
  const supabase = createClient();
  let loggedUserId: string | null = null;
  if (supabase) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ status: "error", error: "unauthorized" }, 401);
    loggedUserId = user.id;
  }
  const profile = await getProfile().catch(() => null);
  if (!profile || profile.role !== "admin") return json({ status: "error", error: "forbidden", reason: "OM AI Market Command is in admin-only beta." }, 403);

  const aiKey = process.env.ANTHROPIC_API_KEY;
  const mdKey = process.env.TWELVEDATA_API_KEY;
  if (!mdKey) return json({ status: "error", error: "notConfigured", reason: "Live market data isn't connected (TWELVEDATA_API_KEY missing)." }, 200);

  let body: { td?: unknown; balance?: unknown; riskPct?: unknown; mode?: unknown };
  try { body = await req.json(); } catch { return json({ status: "error", error: "bad_request" }, 400); }
  const td = (typeof body?.td === "string" ? body.td : "").trim().toUpperCase();
  if (!/^[A-Z0-9]{2,7}(\/[A-Z0-9]{2,7})?$/.test(td)) return json({ status: "error", error: "invalid_symbol", reason: "That instrument symbol isn't recognised." }, 400);
  const balance = numOk(Number(body?.balance)) && Number(body?.balance) > 0 ? Number(body?.balance) : CFG.defaultBalance;
  const riskPct = numOk(Number(body?.riskPct)) && Number(body?.riskPct) > 0 && Number(body?.riskPct) <= 10 ? Number(body?.riskPct) : CFG.defaultRiskPct;
  // Trading personality: accelerator (aggressive, 1.8R floor, releases ≥75) or
  // the default institutional (strict, 2.5R floor, A+/A only).
  const tradeMode: "institutional" | "accelerator" = body?.mode === "accelerator" ? "accelerator" : "institutional";
  const isAccel = tradeMode === "accelerator";
  const profileFloor = isAccel ? 1.8 : 2.5;

  const gate = await gateCredits("command");
  if (!gate.ok && gate.reason === "unauthorized") return json({ status: "error", error: "unauthorized" }, 401);
  if (!gate.ok && gate.reason === "insufficient") return json({ status: "error", error: "insufficient_credits" }, 402);

  const md = await reserveMarketData(6);
  if (!md.ok) return json({ status: "error", error: "system_busy", reason: "The data desk is at capacity for a moment — try again shortly." }, 429);

  const spec = specFor(td);
  const nowMs = Date.now();

  const [d1, h1, m30, m15, m5, price] = await Promise.all([
    series(td, "1day", 60, mdKey),
    series(td, "1h", 120, mdKey),
    series(td, "30min", 120, mdKey),
    series(td, "15min", 120, mdKey),
    series(td, "5min", 120, mdKey),
    livePrice(td, mdKey),
  ]);
  if ([d1, h1, m15, m5].some((r) => r === "ratelimit")) return json({ status: "error", error: "ratelimit", reason: "Hit the free market-data limit (8 req/min). Wait a minute and retry." }, 429);

  // ── Data-quality gate ──────────────────────────────────────────────────────
  const dq: string[] = [];
  let dqScore = 100;
  const need = (rows: Row[] | "ratelimit" | null, label: string, min: number) => {
    if (!Array.isArray(rows) || rows.length < min) { dq.push(`${label} candles incomplete`); dqScore -= 40; return null; }
    return rows;
  };
  const R1raw = need(h1, "1H", 40), R15raw = need(m15, "15m", 40), R5 = need(m5, "5m", 30), RD = need(d1, "Daily", 10);
  if (!R1raw || !R15raw || !R5 || !RD) {
    return noTrade(td, spec, "MARKET DATA UNAVAILABLE OR STALE", `Not enough validated candles to analyse ${td}. ${dq.join("; ")}.`, dqScore);
  }
  // Recent execution-frame candles (OHLC, oldest→newest) for the result chart.
  const candleOut = R15raw.slice(-48).map((v) => ({ t: v.datetime, o: +v.open, h: +v.high, l: +v.low, c: +v.close }));
  // Staleness: last candle must be within N intervals of now (skip on daily/crypto weekend leniency).
  const lastTs = Date.parse((R5[R5.length - 1].datetime || "").replace(" ", "T") + "Z");
  const staleBy = Number.isFinite(lastTs) ? (nowMs - lastTs) / INTERVAL_MS["5min"] : 0;
  const marketClosed = isClosed(spec.cat, new Date(nowMs));
  if (Number.isFinite(lastTs) && staleBy > CFG.staleMult && !marketClosed && spec.cat !== "crypto") {
    dqScore -= 30;
    return noTrade(td, spec, "MARKET DATA UNAVAILABLE OR STALE", `The latest ${td} candle is ~${Math.round(staleBy)} intervals old while the market appears open — refusing to analyse stale data.`, dqScore);
  }

  // Trust the live tick only when it agrees with recent 5m closes; a bad tick
  // (which once put USD/JPY at 159.6 vs a real 162.9) is rejected in favour of
  // the trusted candle reference. (Candle-age staleness is already gated above.)
  const pxSane = livePriceSane(price, R5);
  const px = (price != null && pxSane.ok) ? price : (pxSane.reference ?? +R5[R5.length - 1].close);
  // Look-ahead fix: trend / structure / confirmation run on CLOSED candles only
  // (the newest feed bar is the current, still-forming one). Live price (px) is
  // handled separately above, so entries still anchor to the real tick.
  const R1 = (closedBars(R1raw, 25) ?? R1raw) as Row[];
  const R15 = (closedBars(R15raw, 25) ?? R15raw) as Row[];
  const R30c = closedBars(Array.isArray(m30) ? m30 : null, 20);
  // Execution-stack alignment (1H / 30m / 15m), closed bars only.
  const mtf = mtfAlign([{ tf: "1H", rows: R1 }, { tf: "30m", rows: R30c }, { tf: "15m", rows: R15 }]);
  const closes1 = R1.map((r) => +r.close), highs1 = R1.map((r) => +r.high), lows1 = R1.map((r) => +r.low);
  const dec = px >= 1000 ? 2 : px >= 1 ? 4 : 6;
  const f = (n: number) => +n.toFixed(dec);

  // ── Regime engine (on the 1H) ──────────────────────────────────────────────
  const a = adx(R1, 14);
  const s20 = sma(closes1, 20), s50 = sma(closes1, 50);
  const atr1 = atr(R1, 14) || (Math.max(...highs1.slice(-20)) - Math.min(...lows1.slice(-20))) * 0.1 || px * 0.002;
  // ATR percentile over the window (volatility context).
  const atrSeries: number[] = [];
  for (let i = 20; i < R1.length; i++) { const w = atr(R1.slice(0, i + 1), 14); if (w) atrSeries.push(w); }
  const atrPct = atrSeries.length ? Math.round((atrSeries.filter((v) => v <= atr1).length / atrSeries.length) * 100) : 50;

  let regime = "Unclear / conflicting";
  let regimeDir: Dir | null = null;
  let regimeScore = 40;
  const adxV = a.adx ?? 0;
  const strongTrend = adxV >= 40; // only a genuinely strong trend unlocks breakout-continuation entries
  const trendUp = s20 != null && s50 != null && px > s20 && s20 > s50;
  const trendDn = s20 != null && s50 != null && px < s20 && s20 < s50;
  if (adxV >= 25 && trendUp) { regime = adxV >= 40 ? "Strong bullish trend" : "Weak bullish trend"; regimeDir = "buy"; regimeScore = adxV >= 40 ? 90 : 68; }
  else if (adxV >= 25 && trendDn) { regime = adxV >= 40 ? "Strong bearish trend" : "Weak bearish trend"; regimeDir = "sell"; regimeScore = adxV >= 40 ? 90 : 68; }
  else if (adxV < 18 && atrPct < 35) { regime = "Volatility compression"; regimeScore = 45; }
  else if (adxV < 20) { regime = "Range / mean-reversion"; regimeScore = 55; }
  else if (atrPct > 80) { regime = "Volatility expansion"; regimeScore = 50; }

  const session = sessionNow(new Date(nowMs));

  // ── Strategy selection + entry/stop/target (all code) ──────────────────────
  const piv = pivots(highs1, lows1, 2);
  const rangeHi = Math.max(...highs1.slice(-40)), rangeLo = Math.min(...lows1.slice(-40)), eq = (rangeHi + rangeLo) / 2;
  const prevDayHi = RD.length >= 2 ? +RD[RD.length - 2].high : rangeHi;
  const prevDayLo = RD.length >= 2 ? +RD[RD.length - 2].low : rangeLo;
  const lastSH = piv.sh.length ? piv.sh[piv.sh.length - 1].p : rangeHi;
  const lastSL = piv.sl.length ? piv.sl[piv.sl.length - 1].p : rangeLo;

  let strategy = "", dir: Dir | null = null, entry = px, stop = px, targets: number[] = [], invalidation = "", entryQ = 40, structureQ = 40;
  let orderType: "market" | "limit" | "stop" = "limit";

  if (regimeDir === "buy") {
    dir = "buy";
    // Breakout continuation: in a STRONG trend, if price is freshly breaking the
    // last swing high (at/just above it — not already extended past it), join the
    // break instead of waiting for a pullback that may never come. Stop tucks back
    // under the broken high, which now acts as support.
    const freshBreakUp = strongTrend && px >= lastSH && px <= lastSH + atr1 * 0.8;
    if (freshBreakUp) {
      strategy = "Trend breakout (long)";
      entry = f(px); orderType = "market";
      stop = f(lastSH - atr1 * 0.6);
      invalidation = `1H close back below the broken high (${f(lastSH)})`;
      structureQ = 82; entryQ = 74;
    } else {
      strategy = "Trend pullback (long)";
      entry = f(Math.max(s20 ?? px - atr1 * 0.5, px - atr1 * 0.6)); orderType = entry < px ? "limit" : "market";
      stop = f(Math.min(lastSL, entry - atr1 * 1.0));
      invalidation = `1H close below the last swing low / SMA20 zone (${f(lastSL)})`;
      structureQ = trendUp ? 78 : 60; entryQ = px > eq ? 55 : 72;
    }
  } else if (regimeDir === "sell") {
    dir = "sell";
    const freshBreakDn = strongTrend && px <= lastSL && px >= lastSL - atr1 * 0.8;
    if (freshBreakDn) {
      strategy = "Trend breakout (short)";
      entry = f(px); orderType = "market";
      stop = f(lastSL + atr1 * 0.6);
      invalidation = `1H close back above the broken low (${f(lastSL)})`;
      structureQ = 82; entryQ = 74;
    } else {
      strategy = "Trend pullback (short)";
      entry = f(Math.min(s20 ?? px + atr1 * 0.5, px + atr1 * 0.6)); orderType = entry > px ? "limit" : "market";
      stop = f(Math.max(lastSH, entry + atr1 * 1.0));
      invalidation = `1H close above the last swing high / SMA20 zone (${f(lastSH)})`;
      structureQ = trendDn ? 78 : 60; entryQ = px < eq ? 55 : 72;
    }
  } else if (regime.startsWith("Range")) {
    // Mean-revert from the range extreme the price is nearest.
    const nearHi = Math.abs(px - rangeHi) < Math.abs(px - rangeLo);
    if (nearHi && px >= rangeHi - atr1 * 0.6) {
      strategy = "Range mean-reversion (fade high)"; dir = "sell"; entry = f(px); orderType = "market";
      stop = f(rangeHi + atr1 * 0.8); invalidation = `1H close above the range high (${f(rangeHi)})`; structureQ = 62; entryQ = 66;
    } else if (!nearHi && px <= rangeLo + atr1 * 0.6) {
      strategy = "Range mean-reversion (fade low)"; dir = "buy"; entry = f(px); orderType = "market";
      stop = f(rangeLo - atr1 * 0.8); invalidation = `1H close below the range low (${f(rangeLo)})`; structureQ = 62; entryQ = 66;
    }
  }

  // Nothing actionable → NO TRADE (price mid-range / unclear regime).
  if (!dir) {
    return noTrade(td, spec, "NO QUALIFIED SETUP", `${td} is in a "${regime}" state with price mid-structure — no strategy has a defined edge here right now.`, dqScore, { regime, session, candles: candleOut, mtf: mtf.byTf });
  }

  // Execution-stack alignment gate for TREND trades only. Range mean-reversion is
  // deliberately counter to the short-term push, so it is exempt. A trend entry
  // fires only when 1H, 30m and 15m all agree — this removes the "trade the higher
  // -timeframe trend into a lower-timeframe pullback" losses.
  if (regimeDir && mtf.dir !== (dir === "buy" ? "LONG" : "SHORT")) {
    return noTrade(td, spec, "NO TRADE — 1H/30m/15m NOT ALIGNED", `The ${regime.toLowerCase()} points ${dir === "buy" ? "long" : "short"}, but the execution timeframes don't line up (${mtf.label}). A trend trade only fires when 1H, 30m and 15m all trend the same way — otherwise it's an entry into a lower-timeframe pullback, the main cause of stop-outs.`, dqScore, { regime, session, candles: candleOut, mtf: mtf.byTf });
  }

  // Targets from real objectives: opposing range / prev-day level / swing, then R-ladder fill.
  const risk = Math.abs(entry - stop) || atr1;
  // TP1 must clear the profile's reward:risk floor (2.5R institutional, 1.8R
  // accelerator): take the nearest structural objective beyond the floor, else a
  // clean profile ladder off the floor.
  if (dir === "buy") {
    const obj = [rangeHi, prevDayHi, lastSH].filter((v) => v > entry + risk * profileFloor).sort((x, y) => x - y);
    targets = [obj[0] ?? entry + risk * profileFloor, entry + risk * (profileFloor + 1.0), entry + risk * (profileFloor + 2.2)].map(f);
  } else {
    const obj = [rangeLo, prevDayLo, lastSL].filter((v) => v < entry - risk * profileFloor).sort((x, y) => y - x);
    targets = [obj[0] ?? entry - risk * profileFloor, entry - risk * (profileFloor + 1.0), entry - risk * (profileFloor + 2.2)].map(f);
  }
  targets = Array.from(new Set(targets)).slice(0, 3);
  const rr1 = risk ? Math.abs(targets[0] - entry) / risk : 0;

  // ── Independent risk engine (authority to veto) ────────────────────────────
  const stopAtr = risk / (atr1 || 1);
  const riskWarnings: string[] = [];
  if (stopAtr > CFG.maxStopAtr) return noTrade(td, spec, "NO TRADE — STOP TOO WIDE", `The structural stop is ${stopAtr.toFixed(1)}× ATR (max ${CFG.maxStopAtr}×). Risk per unit is too large for a clean intraday setup.`, dqScore, { regime, session });
  if (stopAtr < CFG.minStopAtr) return noTrade(td, spec, "NO TRADE — STOP TOO TIGHT", `The stop is only ${stopAtr.toFixed(2)}× ATR — noise would stop this out. Waiting for a cleaner structure.`, dqScore, { regime, session });
  if (rr1 < profileFloor) return noTrade(td, spec, "NO TRADE — REWARD:RISK TOO LOW", `Nearest objective gives only ${rr1.toFixed(1)}R (min ${profileFloor}R for ${profile}). The move on offer doesn't justify the risk.`, dqScore, { regime, session });

  // Position sizing (per-instrument spec — never a generic pip formula).
  const stopPips = risk / spec.pip;
  const pipValue = fxPipValue(td, spec, px);
  const riskAmount = balance * (riskPct / 100);
  const posRaw = pipValue > 0 && stopPips > 0 ? riskAmount / (stopPips * pipValue) : 0;
  const posSize = Math.max(spec.minLot, Math.min(spec.maxLot, Math.floor(posRaw / spec.lotStep) * spec.lotStep));
  if (posSize <= 0) riskWarnings.push("Computed position size rounded to zero at this risk % — increase balance or risk to trade this instrument.");
  riskWarnings.push(`Position size uses standard CFD contract specs for ${spec.cat}; confirm pip value and lot step against your own broker before trading.`);

  // ── News gate (economic-calendar blackout via FMP) ──────────────────────────
  const news = await assessNews(td, nowMs);
  if (news.blackout) {
    return noTrade(td, spec, "NO TRADE — NEWS BLACKOUT", news.note, dqScore, { regime, session });
  }
  const newsScore = news.level === "clear" ? 80 : news.level === "low" ? 68 : news.level === "medium" ? 50 : news.screened ? 70 : 55;

  // ── Scoring ────────────────────────────────────────────────────────────────
  const rrScore = Math.min(100, Math.round((rr1 / 3) * 100));
  const momo = rsi(closes1) ?? 50;
  const momoScore = dir === "buy" ? clamp(momo, 40, 75) : clamp(100 - momo, 40, 75);
  const volScore = atrPct >= 30 && atrPct <= 85 ? 75 : 45;
  const sessionScore = session === "Off-session" ? 45 : 72;
  const scores = {
    overall: 0,
    regime: regimeScore,
    structure: structureQ,
    entry: entryQ,
    risk_reward: rrScore,
    momentum: Math.round(momoScore),
    volatility: volScore,
    session: sessionScore,
    news: newsScore,
    data_quality: Math.max(0, dqScore),
  };
  scores.overall = Math.round(
    (scores.regime * 0.2 + scores.structure * 0.15 + scores.entry * 0.13 + scores.risk_reward * 0.17 +
     scores.momentum * 0.08 + scores.volatility * 0.07 + scores.session * 0.05 + scores.news * 0.05 + scores.data_quality * 0.1)
  );

  if (scores.overall < CFG.minScore) {
    return noTrade(td, spec, "NO TRADE — BELOW QUALIFICATION THRESHOLD", `The setup scored ${scores.overall}/100 (threshold ${CFG.minScore}). Direction is ${dir.toUpperCase()} but confluence is too thin to qualify.`, dqScore, { regime, session, scores, candles: candleOut });
  }

  // ── Confirmation gate (profile-aware) ─────────────────────────────────────
  // React, never anticipate. Even after the quant engine qualifies a setup, the
  // gate demands the market has PROVEN itself: the trigger candle CLOSED back
  // with the trend on the execution frame, momentum turned, and TP1 clears the
  // profile's RR floor. Institutional also requires Daily+1H agreement and a
  // completed pullback (2.5R, A+/A); accelerator relaxes those and drops to 1.8R,
  // releasing anything scoring ≥75. Otherwise → NO TRADE, waiting.
  const trigRows = (spec.cat === "index" || spec.cat === "stock") ? R5 : R15;
  const gDir: "long" | "short" = dir === "buy" ? "long" : "short";
  const cs = confirmationSignals(trigRows as { open: string; high: string; low: string; close: string }[], gDir);
  const closesD = RD.map((r) => +r.close);
  const dSma = sma(closesD, Math.min(20, closesD.length));
  const dailyTrend: "up" | "down" | "range" = dSma == null ? "range" : px > dSma ? "up" : px < dSma ? "down" : "range";
  const h1Trend: "up" | "down" | "range" = regimeDir === "buy" ? "up" : regimeDir === "sell" ? "down" : "range";
  const trendStrengthScore = Math.round(Math.max(0, Math.min(100, adxV * 2.5)));
  const v15 = R15.map((r) => +(r.volume ?? 0)).filter((v) => v > 0);
  const volumeScore = v15.length >= 12
    ? Math.round(Math.max(0, Math.min(100, 50 + ((v15.slice(-3).reduce((a, b) => a + b, 0) / 3) / ((v15.reduce((a, b) => a + b, 0) / v15.length) || 1) - 1) * 60)))
    : 60;
  // Continuous-learning context + learned penalty for this setup's buckets.
  const wantTrendC = gDir === "long" ? "up" : "down";
  const htfAlignC: "with" | "against" | "range" = h1Trend === "range" ? "range" : (h1Trend === wantTrendC ? "with" : "against");
  const bosC = (dir === "buy" && trendUp) || (dir === "sell" && trendDn);
  const learned = await getAdjustmentPenalty({ instrument: td, mode: tradeMode, regime, setup: strategy, session });
  const gateDecision = evaluateSetup({
    direction: gDir,
    htf: [dailyTrend, h1Trend],
    htfLabel: "Daily/1H",
    structure: {
      bosWithTrend: (dir === "buy" && trendUp) || (dir === "sell" && trendDn),
      pullbackComplete: cs.pullbackComplete,
      atInstitutionalLevel: true, // entries are anchored to swing / range / prev-day / SMA levels
      score: structureQ,
    },
    momentum: { turnedWithTrend: cs.momentumTurned, strongAgainst: cs.strongAgainst, score: cs.momentumScore },
    trigger: { closed: cs.closed, closedWithTrend: cs.closedWithTrend },
    liquidityScore: Math.round((scores.structure + scores.regime) / 2),
    entry, stop, tps: targets,
    sessionScore: scores.session,
    volatilityScore: scores.volatility,
    volumeScore,
    trendStrength: trendStrengthScore,
    newsRisk: false, // a news blackout already returned NO TRADE above
    scorePenalty: learned.penalty, penaltyReasons: learned.reasons,
  }, tradeMode);
  if (gateDecision.decision === "NO_TRADE") {
    return noTrade(td, spec, `NO TRADE — ${isAccel ? "NO CONFIRMED MOMENTUM" : "WAITING FOR CONFIRMATION"}`, gateDecision.noTradeReason ?? "The market hasn't confirmed the setup yet.", dqScore, { regime, session, scores, mode: tradeMode, candles: candleOut });
  }

  const interval = spec.cat === "index" || spec.cat === "stock" ? "5min" : "15min";
  const ttlMin = CFG.setupTtlMin[interval] ?? 120;
  const expiresAt = new Date(nowMs + ttlMin * 60000).toISOString();
  const confidence = scores.overall >= 80 ? "High" : scores.overall >= 70 ? "Medium" : "Qualified (low)";

  const setup = {
    status: "qualified_setup" as const,
    instrument: td,
    market_category: spec.cat,
    timestamp: new Date(nowMs).toISOString(),
    data_provider: "Twelve Data",
    data_age_seconds: Number.isFinite(lastTs) ? Math.round((nowMs - lastTs) / 1000) : null,
    market_status: marketClosed ? "closed" : "open",
    direction: dir,
    order_type: orderType,
    entry: { price: entry, zone_low: dir === "buy" ? f(entry - atr1 * 0.15) : entry, zone_high: dir === "buy" ? entry : f(entry + atr1 * 0.15) },
    stop_loss: { price: stop, reason: invalidation },
    take_profits: targets.map((p, i) => ({
      label: `TP${i + 1}`, price: p, risk_reward: +(Math.abs(p - entry) / risk).toFixed(2),
      reason: i === 0 ? "Nearest structural objective (range / prev-day level / swing)" : `Extension at ${(Math.abs(p - entry) / risk).toFixed(1)}R`,
      suggested_close_percent: i === 0 ? 50 : i === 1 ? 30 : 20,
    })),
    market_regime: regime,
    spark: closes1.slice(-24),
    candles: candleOut,
    mtf: mtf.byTf, mtf_label: mtf.label, strategy_version: "v2-mtf-closedbar",
    mode: tradeMode,
    grade: gateDecision.grade,
    gate_score: gateDecision.score,
    gate_reasons: gateDecision.reasons,
    momentum_rating: gateDecision.momentumRating,
    trend_rating: gateDecision.trendRating,
    strategy,
    timeframes: ["1day", "1h", "15min", "5min"],
    session,
    setup_expiration: expiresAt,
    invalidation,
    news_risk: news,
    scores,
    confidence,
    position_sizing: { account_balance: balance, risk_percent: riskPct, risk_amount: +riskAmount.toFixed(2), position_size: +posSize.toFixed(spec.lotStep < 1 ? 2 : 0), unit: spec.unit, pip_value_per_lot: +pipValue.toFixed(2), stop_pips: +stopPips.toFixed(1) },
    reasoning: [] as string[],
    risk_warnings: riskWarnings,
    educational_disclaimer: "Educational market analysis and paper-trading decision support only — not financial advice, and not a prediction. Trading CFDs, forex, indices and commodities carries substantial risk; you may lose some or all of your capital. There is no guarantee a target is reached before the stop.",
  };

  // ── Claude: plain-English narrative ONLY (numbers are locked) ───────────────
  setup.reasoning = await narrate(setup, aiKey).catch(() => deterministicReasoning(setup));

  await chargeCredit("command");
  // Universal outcome logging (fire-and-safe: never blocks or breaks the signal).
  await logSignal({
    engine: "command", userId: loggedUserId, instrument: td, symbol: td, style: "intraday",
    method: strategy, direction: dir, orderType, entry, stop, tps: targets,
    confidence, score: scores.overall, regime, session, atr: atr1, priceAtIssue: px, interval: "15min",
    meta: {
      version: "v2-mtf-closedbar", mtf: mtf.byTf, mtf_dir: mtf.dir,
      scores, news_level: news?.level ?? null, grade: gateDecision.grade, gate_score: gateDecision.score, mode: tradeMode,
      penalty_applied: learned.penalty, penalty_reasons: learned.reasons,
      ctx: { mode: tradeMode, setup: strategy, htf_align: htfAlignC, momentum: cs.momentumScore, trend: trendStrengthScore, had_sweep: true, bos: bosC, pullback: cs.pullbackComplete, session_score: scores.session, vol_score: scores.volatility },
    },
  });
  return json(setup, 200);
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function clamp(n: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, n)); }

function fxPipValue(td: string, spec: Spec, price: number): number {
  // Per-instrument pip value in USD per 1.0 lot/unit. FX where USD is the base
  // (USD/XXX) needs a price adjustment; everything else uses the declared value.
  if (spec.cat === "forex" && td.startsWith("USD/")) { const contract = td.endsWith("/JPY") ? 100000 : 100000; return (spec.pip * contract) / (price || 1); }
  return spec.pipValuePerLot;
}

function isClosed(cat: Cat, now: Date): boolean {
  if (cat === "crypto") return false;
  const dow = now.getUTCDay(), hr = now.getUTCHours();
  const fxWeekend = dow === 6 || (dow === 0 && hr < 21) || (dow === 5 && hr >= 21);
  if (cat === "forex" || cat === "gold" || cat === "commodity") return fxWeekend;
  // index / stock — rough US cash session 13:30–20:00 UTC weekdays.
  const mins = hr * 60 + now.getUTCMinutes();
  return dow === 0 || dow === 6 || mins < 13 * 60 + 30 || mins >= 20 * 60;
}

function noTrade(td: string, spec: Spec, headline: string, reason: string, dqScore: number, extra?: { regime?: string; session?: string; scores?: unknown; mode?: string; candles?: { t: string; o: number; h: number; l: number; c: number }[]; mtf?: { tf: string; trend: string }[] }) {
  return json({
    status: "no_trade",
    instrument: td,
    market_category: spec.cat,
    timestamp: new Date().toISOString(),
    data_provider: "Twelve Data",
    mode: extra?.mode ?? "institutional",
    candles: extra?.candles ?? [],
    mtf: extra?.mtf ?? [],
    strategy_version: "v2-mtf-closedbar",
    headline,
    reason,
    recheck: "Re-run after conditions change — a cleaner regime, tighter structure, or a better reward-to-risk.",
    market_regime: extra?.regime ?? "unavailable",
    session: extra?.session ?? "",
    scores: extra?.scores ?? { data_quality: Math.max(0, dqScore) },
    educational_disclaimer: "Educational market analysis only — not financial advice. NO TRADE is a feature: the engine returns it whenever conditions don't meet the qualification threshold.",
  }, 200);
  // aiKey intentionally unused for NO TRADE — the reason is fully deterministic.
}

function deterministicReasoning(s: Record<string, unknown>): string[] {
  const dir = String(s.direction).toUpperCase();
  return [
    `Regime classified as "${s.market_regime}" on the 1H; strategy selected: ${s.strategy}.`,
    `${dir} entry ${JSON.stringify((s.entry as Record<string, unknown>).price)} with stop ${JSON.stringify((s.stop_loss as Record<string, unknown>).price)} — ${(s.stop_loss as Record<string, string>).reason}.`,
    `Passed the independent risk engine: reward-to-risk and stop distance are within limits.`,
    `Overall score ${(s.scores as Record<string, number>).overall}/100.`,
  ];
}

async function narrate(setup: Record<string, unknown>, aiKey: string | undefined): Promise<string[]> {
  if (!aiKey) return deterministicReasoning(setup);
  const sys = `You are OM AI Market Command's explanation layer. You are given a FINAL, LOCKED trade-setup JSON that a deterministic quant engine already produced. Your ONLY job is to explain it clearly. You MUST NOT change, recompute, or invent any number, level, direction, or score. Do not add price levels that aren't in the JSON. Return ONLY a JSON array of 3-5 short plain-English strings (no markdown), each one sentence, explaining: the regime + why this strategy fits, the entry/stop logic, why the targets are where they are, and the main risk. Educational only.`;
  const r = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": aiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: 500, system: sys, messages: [{ role: "user", content: `LOCKED SETUP JSON:\n${JSON.stringify(setup)}\n\nReturn the JSON array of explanation strings now.` }] }),
  });
  const j = await r.json();
  const raw = Array.isArray(j.content) ? j.content.filter((b: { type?: string }) => b?.type === "text").map((b: { text?: string }) => b.text ?? "").join("") : "";
  const m = raw.match(/\[[\s\S]*\]/);
  if (!m) return deterministicReasoning(setup);
  try { const arr = JSON.parse(m[0]); return Array.isArray(arr) ? arr.map(String).slice(0, 6) : deterministicReasoning(setup); } catch { return deterministicReasoning(setup); }
}

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
