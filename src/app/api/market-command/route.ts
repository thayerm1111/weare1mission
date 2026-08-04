import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { gateCredits, chargeCredit } from "@/lib/credits";
import { reserveMarketData, resolveTd, livePriceSane } from "@/lib/marketData";
import { getProfile } from "@/lib/auth";
import { logSignal } from "@/lib/signalLog";
import { confirmationSignals } from "@/lib/confirmation";
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
  minScore: 62,             // legacy floor (kept for back-compat logging)
  maxStopAtr: 3.0,          // HARD VETO: reject if the structural stop is wider than N×ATR
  minStopAtr: 0.4,          // HARD VETO: reject if the stop is unrealistically tight
  staleMult: 3.0,           // data is stale if the last candle is older than N intervals
  defaultBalance: 10000,    // used for position sizing when the caller sends none
  defaultRiskPct: 1.0,      // % of balance risked per trade
  setupTtlMin: { "5min": 45, "15min": 120, "1h": 360 } as Record<string, number>,
  // Standardized-state score bands (0-100). These are CONFIGURABLE and still need
  // historical calibration (see the calibration deliverable) — do not treat as final.
  // A setup that clears `ready` AND has no outstanding measurable trigger is TRADE_READY;
  // a real directional setup with one unmet, measurable trigger is DEVELOPING; a
  // directional bias too far from entry is WATCHLIST; below `watch` (or no bias) is NO_TRADE.
  bands: {
    institutional: { ready: 76, develop: 64, watch: 54 },
    accelerator: { ready: 70, develop: 60, watch: 52 },
  } as Record<string, { ready: number; develop: number; watch: number }>,
};

// Standardized output states shared by all three tools.
type State = "TRADE_READY" | "DEVELOPING_SETUP" | "WATCHLIST" | "NO_TRADE" | "DATA_UNAVAILABLE" | "INSUFFICIENT_DATA";

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

// Session, DST-safe. We derive London wall-clock via Intl (handles BST/GMT) and
// map the FX day off it, so the London/NY windows don't drift by an hour across
// the DST changeover the way a fixed-UTC-hour split does.
function londonHour(d: Date): number {
  try {
    const s = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", hour12: false }).format(d);
    const h = parseInt(s, 10);
    return Number.isFinite(h) ? (h === 24 ? 0 : h) : d.getUTCHours();
  } catch { return d.getUTCHours(); }
}
function nyHour(d: Date): number {
  try {
    const s = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false }).format(d);
    const h = parseInt(s, 10);
    return Number.isFinite(h) ? (h === 24 ? 0 : h) : d.getUTCHours() - 5;
  } catch { return d.getUTCHours() - 5; }
}
function sessionNow(d: Date): string {
  const lh = londonHour(d), nh = nyHour(d);
  const londonOpen = lh >= 7 && lh < 16;      // ~08:00–16:00 London
  const nyOpen = nh >= 8 && nh < 17;          // ~08:00–17:00 New York
  if (londonOpen && nyOpen) return "London/NY overlap";
  if (londonOpen) return "London";
  if (nyOpen) return "New York";
  if (lh >= 0 && lh < 7) return "Asian";
  return "Off-session";
}

// A distinct DATA state — bad/insufficient data must NOT read as "No Trade".
function dataUnavailable(td: string, spec: Spec, insufficient: boolean, reason: string, dqScore: number, extra?: { session?: string }): Response {
  return json({
    status: insufficient ? "insufficient_data" : "data_unavailable",
    state: insufficient ? "INSUFFICIENT_DATA" : "DATA_UNAVAILABLE",
    instrument: td, market_category: spec.cat, timestamp: new Date().toISOString(), data_provider: "Twelve Data",
    strategy_version: STRAT_VERSION, headline: insufficient ? "INSUFFICIENT DATA" : "DATA UNAVAILABLE",
    reason,
    recheck: "This is a data issue, not a market read — retry shortly; if it persists the provider or symbol needs checking.",
    what_next: ["Retry in ~1 minute (provider may be rate-limited).", "Confirm the instrument symbol is supported by the data provider."],
    session: extra?.session ?? "", candles: [], mtf: [],
    scores: { data_quality: Math.max(0, dqScore) },
    educational_disclaimer: "Educational market analysis only — not financial advice.",
  }, 200);
}

// Deterministic trigger object (identical schema across all three tools).
type Trigger = {
  state: State; asset: string; direction: "BUY" | "SELL" | null; strategy: string;
  monitorTimeframe: string; triggerType: string; triggerLevel: number | null;
  retestZoneLow: number | null; retestZoneHigh: number | null;
  confirmationRequired: string; invalidationLevel: number | null; expirationCondition: string;
  recheckInstruction: string; generatedAt: string; dataCandleClose: string | null;
};
const STRAT_VERSION = "v3-command-states";

// News is NOT checked by this tool — no live calendar. We hand the user the exact
// currencies/macro events to verify, and NEVER imply the market is safe.
function newsCheck(td: string): { status: string; warning: string; currencies: string[]; note: string } {
  const s = td.toUpperCase();
  const warning = "News is not checked by this tool. Before entering, verify the economic calendar for high-impact events affecting this instrument.";
  const status = "Not checked — user verification required.";
  if (s === "XAU/USD" || s.includes("GOLD")) return { status, warning, currencies: ["USD"], note: "Verify major USD macro: Fed / FOMC, CPI & PCE inflation, NFP / employment, and Treasury-yield-moving releases." };
  const m = s.match(/^([A-Z]{3})\/([A-Z]{3})$/);
  if (m) return { status, warning, currencies: [m[1], m[2]], note: `Verify high-impact ${m[1]} and ${m[2]} events (rate decisions, inflation, employment, GDP).` };
  if (/(BTC|ETH|SOL|XRP|DOGE)/.test(s)) return { status, warning, currencies: ["USD", "Crypto"], note: "Verify USD macro (Fed, CPI) plus crypto-specific catalysts (ETF flows, regulation, major protocol events)." };
  if (/(SPY|QQQ|DIA|NAS100|US30|SPX500|NDX|US100|US500)/.test(s)) return { status, warning, currencies: ["USD"], note: "Verify USD macro: Fed / FOMC, CPI & PCE, NFP, and major earnings that move the index." };
  return { status, warning, currencies: ["USD"], note: "Verify the relevant high-impact macro releases for this instrument." };
}

function stateJson(state: State, td: string, spec: Spec, p: {
  headline: string; direction: Dir | null; strategy: string; reason: string;
  trigger: Trigger; what_next: string[]; levels?: Record<string, number> | null;
  provisional_trade?: unknown; regime?: string; session?: string; scores?: Record<string, number>;
  candles?: { t: string; o: number; h: number; l: number; c: number }[]; mtf?: { tf: string; trend: string }[];
  confidence?: Record<string, number>; reasoning?: string[]; risk_warnings?: string[];
  setup_zone?: unknown; proximity?: unknown; alternative_scenario?: unknown; current_bias?: string;
}): Response {
  const statusMap: Record<State, string> = {
    TRADE_READY: "qualified_setup", DEVELOPING_SETUP: "developing_setup", WATCHLIST: "watchlist",
    NO_TRADE: "no_trade", DATA_UNAVAILABLE: "data_unavailable", INSUFFICIENT_DATA: "insufficient_data",
  };
  const nc = newsCheck(td);
  return json({
    status: statusMap[state], state,
    instrument: td, market_category: spec.cat, timestamp: new Date().toISOString(), data_provider: "Twelve Data",
    strategy_version: STRAT_VERSION,
    headline: p.headline, direction: p.direction ?? null, current_bias: p.current_bias ?? null, strategy: p.strategy, reason: p.reason,
    no_trade_reason: state === "NO_TRADE" ? p.reason : undefined, // legacy app field (NO TRADE view)
    trigger: p.trigger, what_next: p.what_next, levels: p.levels ?? null, provisional_trade: p.provisional_trade ?? null,
    setup_zone: p.setup_zone ?? null, proximity: p.proximity ?? null, alternative_scenario: p.alternative_scenario ?? null,
    market_regime: p.regime ?? "", session: p.session ?? "",
    scores: p.scores ?? {}, confidence: p.confidence ?? {},
    candles: p.candles ?? [], mtf: p.mtf ?? [], recheck: p.trigger.recheckInstruction,
    reasoning: p.reasoning ?? [], risk_warnings: p.risk_warnings ?? [],
    news_status: nc.status, news_warning: nc.warning, news_check_currencies: nc.currencies, news_check_note: nc.note,
    educational_disclaimer: "Educational market analysis only — not financial advice, and not a prediction. States: TRADE READY, DEVELOPING, WATCHLIST, NO TRADE. There is no guarantee a level is reached.",
  }, 200);
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
    return dataUnavailable(td, spec, true, `Not enough validated candles to analyse ${td}. ${dq.join("; ")}.`, dqScore);
  }
  // Recent execution-frame candles (OHLC, oldest→newest) for the result chart.
  const candleOut = R15raw.slice(-48).map((v) => ({ t: v.datetime, o: +v.open, h: +v.high, l: +v.low, c: +v.close }));
  // Staleness: last candle must be within N intervals of now (skip on daily/crypto weekend leniency).
  const lastTs = Date.parse((R5[R5.length - 1].datetime || "").replace(" ", "T") + "Z");
  const staleBy = Number.isFinite(lastTs) ? (nowMs - lastTs) / INTERVAL_MS["5min"] : 0;
  const marketClosed = isClosed(spec.cat, new Date(nowMs));
  if (Number.isFinite(lastTs) && staleBy > CFG.staleMult && !marketClosed && spec.cat !== "crypto") {
    dqScore -= 30;
    return dataUnavailable(td, spec, false, `The latest ${td} candle is ~${Math.round(staleBy)} intervals old while the market appears open — refusing to analyse stale data.`, dqScore);
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

  const wantDir: "LONG" | "SHORT" | null = dir === "buy" ? "LONG" : dir === "sell" ? "SHORT" : null;
  const interval = spec.cat === "index" || spec.cat === "stock" ? "5min" : "15min";
  const dataClose = R5.length ? new Date((R5[R5.length - 1].datetime || "").replace(" ", "T") + "Z").toISOString() : null;
  const genAt = new Date(nowMs).toISOString();
  const band = CFG.bands[tradeMode] ?? CFG.bands.institutional;
  const levels: Record<string, number> = {
    support: f(Math.min(lastSL, rangeLo)), resistance: f(Math.max(lastSH, rangeHi)),
    liquidity_above: f(Math.max(prevDayHi, rangeHi)), liquidity_below: f(Math.min(prevDayLo, rangeLo)), equilibrium: f(eq),
  };
  const baseTrig = (over: Partial<Trigger>): Trigger => ({
    state: "NO_TRADE", asset: td, direction: dir === "buy" ? "BUY" : dir === "sell" ? "SELL" : null, strategy: strategy || "None",
    monitorTimeframe: interval, triggerType: "AWAIT", triggerLevel: null,
    retestZoneLow: null, retestZoneHigh: null, confirmationRequired: "",
    invalidationLevel: dir ? f(stop) : null, expirationCondition: `${interval} close beyond ${dir ? f(stop) : "the invalidation level"}`,
    recheckInstruction: "", generatedAt: genAt, dataCandleClose: dataClose, ...over,
  });

  // ── No directional edge → WATCHLIST with real levels (never a bare No-Trade) ──
  if (!dir) {
    const near = Math.abs(px - rangeHi) < Math.abs(px - rangeLo);
    const lvl = near ? levels.resistance : levels.support;
    const trig = baseTrig({
      state: "WATCHLIST", direction: null, strategy: "Awaiting a setup at a range extreme", monitorTimeframe: "1H",
      triggerType: "PRICE_REACHES_LEVEL", triggerLevel: lvl,
      confirmationRequired: `a rejection or sweep-and-reclaim at the ${near ? "range high" : "range low"} (${lvl})`,
      recheckInstruction: `Come back when price reaches the ${near ? "resistance/liquidity" : "support/liquidity"} at ${lvl} and shows a reaction there.`,
    });
    return stateJson("WATCHLIST", td, spec, {
      headline: `WATCHLIST — ${regime}`, direction: null, strategy: "None (mid-structure)",
      reason: `${td} is in a "${regime}" state with price mid-structure (${f(px)}; equilibrium ${levels.equilibrium}). No strategy has a defined edge until price reaches a range extreme.`,
      trigger: trig, levels, regime, session, candles: candleOut, mtf: mtf.byTf,
      scores: { data_quality: Math.max(0, dqScore), regime: regimeScore },
      confidence: { data: Math.max(0, dqScore), directional: 40, entry: 20, overall: 34 },
      what_next: [
        `Wait for price to reach the ${near ? "resistance" : "support"} at ${lvl}.`,
        `Preferred: fade a rejection there back toward equilibrium ${levels.equilibrium}.`,
        `Alternative: a decisive 1H close beyond ${lvl} flips the bias to a breakout — reanalyze then.`,
        `Press Analyze again to recompute on fresh candles.`,
      ],
    });
  }

  // ── Targets: structural objectives first; an R-based level only as an explicit fallback ──
  const risk = Math.abs(entry - stop) || atr1;
  const objSrc = dir === "buy"
    ? [rangeHi, prevDayHi, lastSH, ...piv.sh.map((s) => s.p)].filter((v) => v > entry + risk * 0.6)
    : [rangeLo, prevDayLo, lastSL, ...piv.sl.map((s) => s.p)].filter((v) => v < entry - risk * 0.6);
  const objs = Array.from(new Set(objSrc.map(f))).sort((x, y) => dir === "buy" ? x - y : y - x);
  const tpMeta: { price: number; structural: boolean }[] = [];
  const firstStruct = objs.find((v) => Math.abs(v - entry) >= risk * profileFloor);
  if (firstStruct != null) tpMeta.push({ price: firstStruct, structural: true });
  else tpMeta.push({ price: f(dir === "buy" ? entry + risk * profileFloor : entry - risk * profileFloor), structural: false });
  for (const v of objs) {
    if (tpMeta.length >= 3) break;
    if (Math.abs(v - entry) > Math.abs(tpMeta[tpMeta.length - 1].price - entry) + risk * 0.4) tpMeta.push({ price: v, structural: true });
  }
  targets = tpMeta.map((t) => t.price);
  const rr1 = risk ? Math.abs(targets[0] - entry) / risk : 0;

  // ── TRUE hard vetoes (genuine risk/data failures only) → NO TRADE with a measurable recheck ──
  const stopAtr = risk / (atr1 || 1);
  const riskWarnings: string[] = [];
  const hardVeto = (headline: string, reason: string, whatNext: string[], trigOver: Partial<Trigger>) =>
    stateJson("NO_TRADE", td, spec, {
      headline, direction: dir, strategy, reason, trigger: baseTrig({ state: "NO_TRADE", ...trigOver }),
      what_next: whatNext, levels, regime, session, candles: candleOut, mtf: mtf.byTf,
      scores: { data_quality: Math.max(0, dqScore), regime: regimeScore },
      confidence: { data: Math.max(0, dqScore), directional: 45, entry: 20, overall: 30 },
    });
  if (stopAtr > CFG.maxStopAtr) return hardVeto("NO TRADE — STOP TOO WIDE",
    `The only structural stop is ${stopAtr.toFixed(1)}× ATR (max ${CFG.maxStopAtr}×). Risk per unit is too large for a clean setup right now.`,
    [`Wait for a tighter structure — a nearer swing ${dir === "buy" ? "low" : "high"} — so the invalidation sits closer.`, `Reanalyze after a ${dir === "buy" ? "higher-low" : "lower-high"} forms.`],
    { triggerType: "TIGHTER_STRUCTURE", confirmationRequired: "a nearer structural invalidation forms", recheckInstruction: `Come back after price forms a tighter ${dir === "buy" ? "higher-low" : "lower-high"} so the stop is within ${CFG.maxStopAtr}× ATR.` });
  if (stopAtr < CFG.minStopAtr) return hardVeto("NO TRADE — STOP TOO TIGHT",
    `The stop is only ${stopAtr.toFixed(2)}× ATR — normal noise would stop this out.`,
    [`Wait for a structure that supports a slightly wider, safer stop.`, `Reanalyze shortly.`],
    { triggerType: "VOLATILITY_NORMALIZE", confirmationRequired: "an ATR-appropriate stop distance", recheckInstruction: "Come back once a structurally valid stop is at least 0.4× ATR away." });
  if (!(rr1 > 0) || !Number.isFinite(rr1)) return hardVeto("NO TRADE — INVALID REWARD:RISK",
    `Could not resolve a valid reward-to-risk for ${td}.`, [`Press Analyze again to recompute.`],
    { triggerType: "RECOMPUTE", recheckInstruction: "Press Analyze again to recompute on fresh candles." });

  // Position sizing (per-instrument spec — never a generic pip formula).
  const stopPips = risk / spec.pip;
  const pipValue = fxPipValue(td, spec, px);
  const riskAmount = balance * (riskPct / 100);
  const posRaw = pipValue > 0 && stopPips > 0 ? riskAmount / (stopPips * pipValue) : 0;
  const posSize = Math.max(spec.minLot, Math.min(spec.maxLot, Math.floor(posRaw / spec.lotStep) * spec.lotStep));
  if (posSize <= 0) riskWarnings.push("Computed position size rounded to zero at this risk % — increase balance or risk to trade this instrument.");
  riskWarnings.push(`Position size uses standard CFD contract specs for ${spec.cat}; confirm pip value and lot step against your own broker before trading.`);

  // ── News: NOT checked by this tool. There is no live calendar integration, so we
  // NEVER block a trade, never imply it's "clear", and never fabricate a calendar.
  // We hand the user the exact currencies/macro events to verify themselves. ──
  const newsInfo = newsCheck(td);
  const newsScore = 65; // neutral — news neither gates nor biases the score

  // ── Confirmation reads (from the shared PURE helper — read-only, no gate) ──
  const trigRows = (spec.cat === "index" || spec.cat === "stock") ? R5 : R15;
  const gDir: "long" | "short" = dir === "buy" ? "long" : "short";
  const cs = confirmationSignals(trigRows as { open: string; high: string; low: string; close: string }[], gDir);
  const confirmed = cs.closedWithTrend && cs.momentumTurned;
  const mtfAligned = regimeDir ? mtf.dir === wantDir : true;   // range trades don't require alignment

  // Entry-quality / stale-entry status (never re-offer a missed entry without recompute).
  const chaseTol = atr1 * (isAccel ? 1.2 : 0.8);
  let entryStatus: "available" | "approaching" | "far";
  if (orderType === "market") entryStatus = "available";
  else if (dir === "buy") entryStatus = px <= entry + atr1 * 0.05 ? "available" : (px - entry <= chaseTol ? "approaching" : "far");
  else entryStatus = px >= entry - atr1 * 0.05 ? "available" : (entry - px <= chaseTol ? "approaching" : "far");

  // Distance-to-obstacle: opposing structure between entry and TP1 (soft penalty).
  const betw = dir === "buy"
    ? [rangeHi, prevDayHi, lastSH, ...piv.sh.map((s) => s.p)].filter((v) => v > entry + risk * 0.15 && v < targets[0] - risk * 0.1)
    : [rangeLo, prevDayLo, lastSL, ...piv.sl.map((s) => s.p)].filter((v) => v < entry - risk * 0.15 && v > targets[0] + risk * 0.1);
  const obstacle = betw.length ? f(dir === "buy" ? Math.min(...betw) : Math.max(...betw)) : null;

  // ── Single transparent score (0-100). Redundant gates are now soft penalties. ──
  const rrScore = Math.min(100, Math.round((rr1 / 3) * 100));
  const momo = rsi(closes1) ?? 50;
  const momoScore = dir === "buy" ? clamp(momo, 40, 75) : clamp(100 - momo, 40, 75);
  const volScore = atrPct >= 30 && atrPct <= 85 ? 75 : 45;
  const sessionScore = session === "Off-session" ? 45 : 72;
  const confirmScore = (cs.closedWithTrend ? 40 : 0) + (cs.momentumTurned ? 35 : 0) + (cs.pullbackComplete ? 25 : 0);
  // Alignment is CONTEXT, weighted low. A NEUTRAL higher timeframe is treated as
  // genuinely neutral (75), not a penalty — only a materially OPPOSED HTF (40)
  // drags the score, and even then by score, never as a gate.
  const alignScore = mtfAligned ? 90 : (mtf.dir == null ? 75 : 40);
  const learned = await getAdjustmentPenalty({ instrument: td, mode: tradeMode, regime, setup: strategy, session });
  const scores: Record<string, number> = {
    overall: 0, regime: regimeScore, structure: structureQ, entry: entryQ, risk_reward: rrScore,
    confirmation: confirmScore, alignment: alignScore, momentum: Math.round(momoScore),
    volatility: volScore, session: sessionScore, news: newsScore, data_quality: Math.max(0, dqScore),
  };
  // Strategy quality DOMINATES; alignment/news are minor context (weights sum to 1.0).
  let overall = Math.round(
    scores.structure * 0.16 + scores.entry * 0.12 + scores.confirmation * 0.15 + scores.risk_reward * 0.15 +
    scores.regime * 0.12 + scores.momentum * 0.07 + scores.volatility * 0.05 + scores.session * 0.04 +
    scores.data_quality * 0.08 + scores.alignment * 0.03 + scores.news * 0.03,
  );
  if (obstacle != null) overall -= 6;                       // soft penalty: not enough clean room to TP1
  overall = Math.max(0, Math.min(100, overall - (learned.penalty || 0)));
  scores.overall = overall;

  // ── Outstanding measurable triggers (each blocks TRADE_READY but not the read) ──
  // NOTE: timeframe alignment is deliberately NOT a blocker. A valid setup can be
  // TRADE_READY even when 1H/30m/15m disagree — misalignment only lowers `alignment`
  // in the score above (context), and a strongly-opposed HTF drags the score toward
  // WATCHLIST/NO_TRADE on its own. Alignment is never the universal gatekeeper.
  const zoneLow = dir === "buy" ? f(entry - atr1 * 0.15) : entry;
  const zoneHigh = dir === "buy" ? entry : f(entry + atr1 * 0.15);
  const blockers: { key: string; short: string; trigger: Trigger }[] = [];
  if (!confirmed) blockers.push({
    key: "confirmation", short: `a ${interval} close ${dir === "buy" ? "up" : "down"} through ${f(entry)} with momentum turning.`,
    trigger: baseTrig({ state: "DEVELOPING_SETUP", monitorTimeframe: interval,
      triggerType: dir === "buy" ? "CANDLE_CLOSE_ABOVE" : "CANDLE_CLOSE_BELOW", triggerLevel: f(entry),
      confirmationRequired: `a ${interval} candle closing ${dir === "buy" ? "back up through" : "back down through"} ${f(entry)} with momentum turning ${dir === "buy" ? "up" : "down"}`,
      recheckInstruction: `Come back after the next ${interval} candle closes ${dir === "buy" ? "above" : "below"} ${f(entry)}.` }),
  });
  if (entryStatus === "approaching" || entryStatus === "far") blockers.push({
    key: "entry", short: `price retraces into the ${zoneLow}–${zoneHigh} entry zone.`,
    trigger: baseTrig({ state: "DEVELOPING_SETUP", monitorTimeframe: interval, triggerType: "PRICE_TOUCH",
      triggerLevel: f(entry), retestZoneLow: zoneLow, retestZoneHigh: zoneHigh,
      confirmationRequired: `price retraces into the ${zoneLow}–${zoneHigh} entry zone`,
      recheckInstruction: `Come back if price ${dir === "buy" ? "pulls back down" : "rallies up"} into ${zoneLow}–${zoneHigh}.` }),
  });
  if (obstacle != null) blockers.push({
    key: "clearance", short: `price clears the opposing level at ${obstacle} before TP1.`,
    trigger: baseTrig({ state: "DEVELOPING_SETUP", triggerType: "LEVEL_CLEAR", triggerLevel: obstacle,
      confirmationRequired: `price clears ${obstacle} (opposing structure between entry and TP1)`,
      recheckInstruction: `Come back once price ${dir === "buy" ? "breaks and holds above" : "breaks and holds below"} ${obstacle}.` }),
  });
  if (rr1 < profileFloor) blockers.push({
    key: "rr", short: `a deeper ${dir === "buy" ? "pullback" : "rally"} improves reward:risk (now ${rr1.toFixed(1)}R, need ${profileFloor}R).`,
    trigger: baseTrig({ state: "DEVELOPING_SETUP", triggerType: "BETTER_LOCATION", triggerLevel: f(entry),
      confirmationRequired: `a deeper ${dir === "buy" ? "pullback" : "rally"} that puts entry ≥${profileFloor}R from ${targets[0]}`,
      recheckInstruction: `Come back on a deeper ${dir === "buy" ? "dip" : "bounce"} — the nearest objective is only ${rr1.toFixed(1)}R (need ${profileFloor}R).` }),
  });

  // ── Decide the standardized state (single authority: the score + outstanding triggers) ──
  let state: State;
  if (overall >= band.ready && blockers.length === 0) state = "TRADE_READY";
  else if (overall >= band.develop && blockers.length >= 1) state = "DEVELOPING_SETUP";
  else if (overall >= band.watch) state = "WATCHLIST";
  else state = "NO_TRADE";

  const confBreak = {
    data: Math.max(0, dqScore),
    directional: Math.round((scores.regime + scores.alignment) / 2),
    entry: Math.round((scores.entry + scores.confirmation) / 2),
    risk: Math.round((scores.risk_reward + Math.max(0, 100 - (stopAtr / CFG.maxStopAtr) * 100)) / 2),
    overall,
  };

  // Diagnostics (observability — never exposes secrets/prompts).
  const diagnostics = {
    tool: "market-command", asset: td, resolved_symbol: resolveTd(td).fetchTd,
    timeframes: ["1day", "1h", "30min", "15min", "5min"], last_candle: dataClose,
    regime, session, mtf: mtf.label, scores, penalties: { obstacle: obstacle != null ? 6 : 0, learned: learned.penalty || 0 },
    blockers: blockers.map((b) => b.key), entry_status: entryStatus, band: { ready: band.ready, develop: band.develop, watch: band.watch },
    state, strategy, rr1: +rr1.toFixed(2),
  };

  const ttlMin = CFG.setupTtlMin[interval] ?? 120;

  // ── TRADE READY ────────────────────────────────────────────────────────────
  if (state === "TRADE_READY") {
    const expiresAt = new Date(nowMs + ttlMin * 60000).toISOString();
    const confidence = overall >= 82 ? "High" : overall >= 74 ? "Medium" : "Qualified";
    const grade = overall >= 85 ? "A+" : overall >= 78 ? "A" : "B+";
    const readyTrig = baseTrig({ state: "TRADE_READY", triggerType: "ENTRY_AVAILABLE", triggerLevel: entry,
      retestZoneLow: zoneLow, retestZoneHigh: zoneHigh, confirmationRequired: "confirmed — entry is live",
      recheckInstruction: `Entry available now at ${entry}. Stop ${f(stop)}; TP1 ${targets[0]} (${rr1.toFixed(1)}R). Reanalyze if price moves before you act.` });
    const setup = {
      status: "qualified_setup" as const, state: "TRADE_READY" as const,
      instrument: td, market_category: spec.cat, timestamp: genAt, data_provider: "Twelve Data",
      data_age_seconds: Number.isFinite(lastTs) ? Math.round((nowMs - lastTs) / 1000) : null,
      market_status: marketClosed ? "closed" : "open",
      direction: dir, order_type: orderType,
      entry: { price: entry, zone_low: zoneLow, zone_high: zoneHigh }, stop_loss: { price: f(stop), reason: invalidation },
      take_profits: tpMeta.map((t, i) => ({
        label: `TP${i + 1}`, price: t.price, risk_reward: +(Math.abs(t.price - entry) / risk).toFixed(2),
        structural: t.structural,
        reason: t.structural ? "Structural objective (range / prev-day level / swing)" : `Measured ${(Math.abs(t.price - entry) / risk).toFixed(1)}R extension (no nearer structural level)`,
        suggested_close_percent: i === 0 ? 50 : i === 1 ? 30 : 20,
      })),
      market_regime: regime, spark: closes1.slice(-24), candles: candleOut,
      mtf: mtf.byTf, mtf_label: mtf.label, strategy_version: STRAT_VERSION, mode: tradeMode,
      grade, entry_status: entryStatus, trigger: readyTrig,
      what_next: [`Entry available at ${entry}; stop ${f(stop)}; first target ${targets[0]} (${rr1.toFixed(1)}R).`, `Size to your risk % — never widen the stop to stay in the trade.`, `Reanalyze if price runs before you enter — the setup is recomputed on fresh candles.`],
      strategy, timeframes: ["1day", "1h", "15min", "5min"], session, setup_expiration: expiresAt, invalidation,
      news_status: newsInfo.status, news_warning: newsInfo.warning, news_check_currencies: newsInfo.currencies, news_check_note: newsInfo.note,
      scores, confidence, confidence_breakdown: confBreak,
      position_sizing: { account_balance: balance, risk_percent: riskPct, risk_amount: +riskAmount.toFixed(2), position_size: +posSize.toFixed(spec.lotStep < 1 ? 2 : 0), unit: spec.unit, pip_value_per_lot: +pipValue.toFixed(2), stop_pips: +stopPips.toFixed(1) },
      reasoning: [] as string[], risk_warnings: riskWarnings, diagnostics,
      educational_disclaimer: "Educational market analysis and paper-trading decision support only — not financial advice, and not a prediction. Trading carries substantial risk; you may lose some or all of your capital. There is no guarantee a target is reached before the stop.",
    };
    setup.reasoning = await narrate(setup, aiKey).catch(() => deterministicReasoning(setup));
    await chargeCredit("command");
    await logSignal({
      engine: "command", userId: loggedUserId, instrument: td, symbol: td, style: "intraday",
      method: strategy, direction: dir, orderType, entry, stop, tps: targets,
      confidence, score: overall, regime, session, atr: atr1, priceAtIssue: px, interval: "15min",
      meta: { version: STRAT_VERSION, mtf: mtf.byTf, mtf_dir: mtf.dir, scores, news_level: null, grade, mode: tradeMode, penalty_applied: learned.penalty, penalty_reasons: learned.reasons,
        ctx: { mode: tradeMode, setup: strategy, htf_align: mtfAligned ? "with" : (mtf.dir == null ? "range" : "against"), momentum: cs.momentumScore, trend: Math.round(Math.max(0, Math.min(100, adxV * 2.5))), had_sweep: true, bos: (dir === "buy" && trendUp) || (dir === "sell" && trendDn), pullback: cs.pullbackComplete, session_score: scores.session, vol_score: scores.volatility } },
    });
    return json(setup, 200);
  }

  // ── DEVELOPING / WATCHLIST / NO TRADE (with a measurable trigger + provisional levels) ──
  const primary = blockers[0]?.trigger ?? baseTrig({ state, recheckInstruction: "Press Analyze again to recompute on fresh candles." });
  primary.state = state;
  const provisional = {
    direction: dir, strategy, order_type: orderType,
    entry: { price: entry, zone_low: zoneLow, zone_high: zoneHigh }, stop_loss: { price: f(stop), reason: invalidation },
    take_profits: tpMeta.map((t, i) => ({ label: `TP${i + 1}`, price: t.price, structural: t.structural, risk_reward: +(Math.abs(t.price - entry) / risk).toFixed(2) })),
    risk_reward_tp1: +rr1.toFixed(2), entry_status: entryStatus,
  };
  const headlineMap: Record<string, string> = {
    DEVELOPING_SETUP: `DEVELOPING — ${strategy}`,
    WATCHLIST: `WATCHLIST — ${dir === "buy" ? "bullish" : "bearish"} bias`,
    NO_TRADE: `NO TRADE — ${regime}`,
  };
  const whatNext = [
    ...(blockers.length ? blockers.map((b, i) => `${i === 0 ? "First: " : "Then: "}${b.short}`) : [`No qualifying trigger is close; watch ${levels.support} (support) and ${levels.resistance} (resistance).`]),
    `Invalidation: a close ${dir === "buy" ? "below" : "above"} ${f(stop)}.`,
    `Press Analyze again to recompute on fresh candles.`,
  ];
  const reason = state === "DEVELOPING_SETUP"
    ? `A ${dir === "buy" ? "long" : "short"} ${strategy} is forming (score ${overall}/100), but ${blockers.length} condition${blockers.length > 1 ? "s" : ""} must confirm first — starting with: ${blockers[0].short}`
    : state === "WATCHLIST"
    ? `${td} has a ${dir === "buy" ? "bullish" : "bearish"} lean (score ${overall}/100) but price is too far from a valid entry. Watching ${levels.support}–${levels.resistance}.`
    : `${td} scored ${overall}/100 — below the ${band.watch} watchlist floor. The lean is ${dir.toUpperCase()} but confluence is too thin for an edge right now.`;
  // ── Actionable future SETUP ZONE (never "wait/check later") ──
  // A deterministic Fibonacci-continuation zone from the last 1H impulse leg,
  // overlapping structure. This is the "best developing idea" the trader should
  // watch even when nothing is ready now.
  const legHi = piv.sh.length ? piv.sh[piv.sh.length - 1].p : rangeHi;
  const legLo = piv.sl.length ? piv.sl[piv.sl.length - 1].p : rangeLo;
  const legRange = Math.abs(legHi - legLo) || atr1;
  const fibA = dir === "buy" ? legHi - 0.618 * legRange : legLo + 0.618 * legRange;
  const fibB = dir === "buy" ? legHi - 0.786 * legRange : legLo + 0.786 * legRange;
  const zLow = f(Math.min(fibA, fibB)), zHigh = f(Math.max(fibA, fibB));
  const overlapLevel = dir === "buy" ? levels.support : levels.resistance;
  const setup_zone = {
    direction: dir === "buy" ? "BUY" : "SELL", setup_type: strategy,
    zone_low: zLow, zone_high: zHigh,
    zone_source: `61.8%–78.6% Fibonacci retracement of the last 1H ${dir === "buy" ? "up" : "down"}-impulse (${f(legLo)}→${f(legHi)})`,
    setup_timeframe: `1H context → ${interval} trigger`,
    why: [
      `${dir === "buy" ? "Discount" : "Premium"} pullback into the 61.8–78.6% Fib zone of the latest impulse`,
      `Overlaps ${dir === "buy" ? "support" : "resistance"} near ${overlapLevel}`,
      obstacle == null ? `Clean room toward the first objective ${targets[0]}` : `First objective ${targets[0]} (an opposing level at ${obstacle} sits en route)`,
    ],
    what_price_must_do: [
      `Trade into ${zLow}–${zHigh}`,
      `Form a ${interval === "5min" ? "5-minute" : interval} ${dir === "buy" ? "bullish" : "bearish"} rejection inside the zone`,
      `Close back ${dir === "buy" ? "above" : "below"} ${dir === "buy" ? zHigh : zLow}`,
      `Then print a ${dir === "buy" ? "higher high" : "lower low"} to confirm continuation`,
    ],
    confirmation: `${interval} ${dir === "buy" ? "bullish" : "bearish"} rejection + close ${dir === "buy" ? "above" : "below"} ${dir === "buy" ? zHigh : zLow}`,
    invalidation: `A close ${dir === "buy" ? "below" : "above"} ${f(stop)}`,
    first_target: targets[0], second_target: targets[1] ?? null,
    cancels: `A decisive close ${dir === "buy" ? "below" : "above"} ${f(stop)} (structure break against the idea)`,
  };
  // Proximity: how close price is to the actionable zone.
  const insideZone = px >= zLow && px <= zHigh;
  const distToZone = insideZone ? 0 : (px < zLow ? zLow - px : px - zHigh);
  const distAtr = atr1 ? distToZone / atr1 : 0;
  const candlesAway = atr1 ? distToZone / atr1 : 0;
  const proximityStatus = insideZone && confirmed ? "Confirmation Pending"
    : insideZone ? "Inside Setup Zone"
    : distAtr <= 1.5 ? "Approaching Setup Zone"
    : distAtr > 3 ? "Setup Too Far Away" : "Approaching Setup Zone";
  const proximity = {
    status: proximityStatus, current_price: f(px), zone_low: zLow, zone_high: zHigh,
    distance: +distToZone.toFixed(dec), distance_atr: +distAtr.toFixed(2), candles_away: +candlesAway.toFixed(1),
    reachable_this_session: distAtr <= 4 && session !== "Off-session",
    note: `≈ ${distAtr.toFixed(2)}× ATR from the zone (~${candlesAway.toFixed(1)} average candles). Estimated review window is an estimate only, not a promise.`,
  };
  const alternative_scenario = {
    direction: dir === "buy" ? "SELL" : "BUY",
    trigger: `A close ${dir === "buy" ? "below" : "above"} ${f(stop)} then a retest of it from the ${dir === "buy" ? "underside" : "topside"}`,
    activation_zone: `${f(stop)} area (broken ${dir === "buy" ? "support → resistance" : "resistance → support"})`,
    invalidates_current: `${dir === "buy" ? "Below" : "Above"} ${f(stop)}, the ${gDir} idea is cancelled`,
  };
  const current_bias = `${dir === "buy" ? "Bullish" : "Bearish"} while ${dir === "buy" ? "above" : "below"} ${f(stop)}`;

  if (state === "DEVELOPING_SETUP") await chargeCredit("command");   // actionable → charge; WATCHLIST/NO_TRADE are free
  return stateJson(state, td, spec, {
    headline: headlineMap[state], direction: dir, current_bias, strategy, reason, trigger: primary, what_next: whatNext,
    levels, provisional_trade: state === "NO_TRADE" ? null : provisional,
    setup_zone, proximity, alternative_scenario,
    regime, session, candles: candleOut, mtf: mtf.byTf, scores, confidence: confBreak, risk_warnings: riskWarnings,
    reasoning: [`Regime "${regime}" on the 1H; nearest strategy: ${strategy} (score ${overall}/100).`, `Setup zone ${zLow}–${zHigh} (${proximityStatus}); entry ${entryStatus}.`],
  });
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
