import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { gateCredits, chargeCredit } from "@/lib/credits";
import { series, livePrice, isPriorityEmail } from "@/lib/marketData";
import { logSignal } from "@/lib/signalLog";
import { findAsset } from "@/data/signalAssets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.OM_AI_MODEL || "claude-sonnet-4-6";

/**
 * OM STRATEGY SCANNER — confirmations-as-strategies engine.
 *
 * The core idea (per the desk's spec): each confirmation is NOT a post-hoc
 * scorecard — it is a STRATEGY that scans the pair and proposes its own read:
 * "structure broke → continuation", "liquidity swept the low → reversal up",
 * "price tapped the 0.62 fib → sell the pullback", "broke a high → retest → buy".
 *
 * Every scout is deterministic code over real candles. The engine then combines
 * the scouts — the higher-timeframe TREND is the top filter (with-trend scouts
 * carry the most weight; a counter-trend call only qualifies on a genuine
 * structural flip: CHoCH + a liquidity sweep, never just an oversold RSI) — and
 * synthesises the best confluence into ONE trade, or an honest WAIT when the
 * reads are thin or conflicting. The LLM only narrates the finished, locked
 * result in plain English; it never invents a number or a level.
 *
 * Timeframe intent sets the scan frames and target sizing:
 *   scalp    → 5m / 15m / 30m execution, 1H/4H context, 30–100 pip objective
 *   intraday → 15m / 1H execution, 4H/Daily context, a bigger move
 *   swing    → 4H / Daily execution, Weekly context, the overall direction
 */

type Row = { datetime: string; open: string; high: string; low: string; close: string; volume?: string };
type Dir = "LONG" | "SHORT";
type Trend = "bullish" | "bearish" | "ranging";
const numOk = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

// -- Indicators --
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
function pivots(h: number[], l: number[], k = 2) {
  const sh: { i: number; p: number }[] = [], sl: { i: number; p: number }[] = [];
  for (let i = k; i < h.length - k; i++) {
    let isH = true, isL = true;
    for (let j = i - k; j <= i + k; j++) { if (j === i) continue; if (h[j] >= h[i]) isH = false; if (l[j] <= l[i]) isL = false; }
    if (isH) sh.push({ i, p: h[i] }); if (isL) sl.push({ i, p: l[i] });
  }
  return { sh, sl };
}
function trendOf(rows: Row[] | null): Trend {
  if (!rows || rows.length < 20) return "ranging";
  const c = rows.map((v) => +v.close), p = c[c.length - 1], s20 = sma(c, 20), s50 = sma(c, 50);
  if (!s20 || !s50) return "ranging";
  return p > s20 && s20 > s50 ? "bullish" : p < s20 && s20 < s50 ? "bearish" : "ranging";
}

// -- Data (candle series + live price come from the shared cached fetcher in @/lib/marketData) --

const pipSize = (s: string): number => {
  const u = (s || "").toUpperCase();
  if (u.includes("JPY")) return 0.01;
  if (u.includes("XAU") || u.includes("GOLD")) return 0.1;
  if (u.includes("XAG") || u.includes("SILVER")) return 0.01;
  if (u.includes("XPT") || u.includes("XPD") || u.includes("PLATIN") || u.includes("PALLAD")) return 0.1;
  if (u.includes("XCU") || u.includes("COPPER")) return 0.0005;
  if (/WTI|BRENT|CRUDE|OIL|NATGAS|\bNG\b/.test(u)) return 0.01;
  if (/(BTC|ETH|SOL|XRP|DOGE|ADA|BNB|LTC|US30|NAS|NDX|SPX|US100|US500|GER|UK100|DXY)/.test(u)) return 1;
  if (!u.includes("/")) return 0.01; // equities / index ETF proxies (SPY, QQQ, DIA, …)
  return 0.0001;
};

// Currency codes used to spot a forex pair typed without a slash (EURUSD → EUR/USD).
const FX_CODES = ["USD", "EUR", "GBP", "JPY", "AUD", "NZD", "CAD", "CHF", "SGD", "HKD", "SEK", "NOK", "DKK", "MXN", "ZAR", "TRY", "CNH", "HUF", "CZK", "PLN"];
const SYMBOL_ALIASES: Record<string, string> = {
  GOLD: "XAU/USD", SILVER: "XAG/USD", PLATINUM: "XPT/USD", PALLADIUM: "XPD/USD", COPPER: "XCU/USD",
  OIL: "WTI/USD", CRUDE: "WTI/USD", WTI: "WTI/USD",
  NASDAQ: "NAS100", NAS100: "NAS100", NAS: "NAS100", US100: "NAS100", USTEC: "NAS100", QQQ: "NAS100",
  SPX: "SPY", SP500: "SPY", US500: "SPY", SPX500: "SPY",
  DOW: "DIA", US30: "DIA", DJIA: "DIA", DJI: "DIA",
  RUSSELL: "IWM", US2000: "IWM", BITCOIN: "BTC/USD", ETHEREUM: "ETH/USD",
};

// Canonicalise whatever the trader typed into a symbol the data feed understands.
function normalizeSymbol(input: string): string {
  const s = (input || "").trim().toUpperCase().replace(/\s+/g, "");
  if (!s) return "";
  if (SYMBOL_ALIASES[s]) return SYMBOL_ALIASES[s];
  if (s.includes("/")) return s;
  if (/^(XAU|XAG|XPT|XPD|XCU)USD$/.test(s)) return s.slice(0, 3) + "/USD";
  if (/^[A-Z]{6}$/.test(s)) {
    const a = s.slice(0, 3), b = s.slice(3);
    if (FX_CODES.includes(a) && FX_CODES.includes(b)) return `${a}/${b}`;
  }
  if (/^(BTC|ETH|SOL|XRP|DOGE|ADA|BNB|LTC|DOT|AVAX|MATIC)USDT?$/.test(s)) return s.replace(/USDT?$/, "/USD");
  return s; // plain ticker (SPY, AAPL, …)
}

// Reasonable market bucket for a free-typed symbol (label + pip conventions).
function marketFor(sym: string): { id: "crypto" | "metal" | "forex" | "index"; name: string } {
  const u = sym.toUpperCase();
  if (/^(XAU|XAG|XPT|XPD|XCU)\/|WTI|BRENT|CRUDE|OIL|GOLD|SILVER|COPPER|NATGAS/.test(u)) return { id: "metal", name: "Commodities" };
  if (/^(BTC|ETH|SOL|XRP|DOGE|ADA|BNB|LTC|DOT|AVAX|MATIC)\//.test(u)) return { id: "crypto", name: "Crypto" };
  if (u.includes("/")) return { id: "forex", name: "Forex" };
  return { id: "index", name: "Index / Equity" };
}

// Accept a catalog asset OR any well-formed symbol; the feed is the final judge.
function resolveAsset(input: string): { market: { id: string; name: string; desc: string; assets: unknown[] }; asset: { symbol: string; name: string; td: string } } | null {
  const sym = normalizeSymbol(input);
  if (!sym || sym.length < 2) return null;
  const cataloged = findAsset(sym);
  if (cataloged) return cataloged as never;
  // Sanity gate: forex pair, spot metal, or a short alphabetic ticker.
  const ok = /^[A-Z]{2,5}\/[A-Z]{2,5}$/.test(sym) || /^[A-Z.]{1,6}$/.test(sym);
  if (!ok) return null;
  const m = marketFor(sym);
  return { market: { id: m.id, name: m.name, desc: "", assets: [] }, asset: { symbol: sym, name: sym, td: sym } };
}

// -- Scout result --
type Scout = {
  key: string; label: string; fired: boolean; dir: Dir | null;
  strength: number;            // 0–100 confidence this scout has in its read
  read: string;                // plain-English one-liner of what it saw
  level?: number;              // a price level of interest (entry anchor / trigger)
};

// Each scout scans the EXECUTION-frame candles (with the HTF trend for context)
// and returns its own independent trade read.
function scoutStructure(rows: Row[], htf: Trend): Scout {
  const h = rows.map((r) => +r.high), l = rows.map((r) => +r.low), c = rows.map((r) => +r.close);
  const { sh, sl } = pivots(h, l, 2);
  const price = c[c.length - 1];
  const lastSH = sh[sh.length - 1], prevSH = sh[sh.length - 2];
  const lastSL = sl[sl.length - 1], prevSL = sl[sl.length - 2];
  let dir: Dir | null = null, read = "No clean structure break yet.", strength = 40, level: number | undefined;
  // BOS: price closes beyond the last swing in the trend direction.
  if (lastSH && price > lastSH.p) { dir = "LONG"; level = lastSH.p; read = `Broke structure UP (BOS) above ${lastSH.p} — bullish continuation.`; strength = 72; }
  else if (lastSL && price < lastSL.p) { dir = "SHORT"; level = lastSL.p; read = `Broke structure DOWN (BOS) below ${lastSL.p} — bearish continuation.`; strength = 72; }
  // CHoCH: sequence flips (a genuine reversal signal).
  else if (prevSH && lastSH && prevSL && lastSL) {
    if (lastSH.p > prevSH.p && lastSL.p > prevSL.p) { dir = "LONG"; read = "Higher highs & higher lows — bullish structure."; strength = 64; level = lastSL.p; }
    else if (lastSH.p < prevSH.p && lastSL.p < prevSL.p) { dir = "SHORT"; read = "Lower highs & lower lows — bearish structure."; strength = 64; level = lastSH.p; }
  }
  // A break AGAINST the HTF trend is a CHoCH (potential reversal) — flag it strongly.
  if (dir && ((htf === "bearish" && dir === "LONG") || (htf === "bullish" && dir === "SHORT"))) {
    read = read.replace("BOS", "CHoCH") + " Counter-trend — treat as a possible reversal, needs a sweep to confirm.";
  }
  return { key: "structure", label: "Market Structure", fired: dir != null, dir, strength, read, level };
}

function scoutLiquidity(rows: Row[]): Scout {
  const h = rows.map((r) => +r.high), l = rows.map((r) => +r.low), c = rows.map((r) => +r.close);
  const { sh, sl } = pivots(h, l, 2);
  const last6 = rows.slice(-6);
  const lastSH = sh[sh.length - 1], lastSL = sl[sl.length - 1];
  // Sweep of sell-side (below a low) that closes back up = bullish; opposite = bearish.
  if (lastSL && last6.some((r) => +r.low < lastSL.p && +r.close > lastSL.p))
    return { key: "liquidity", label: "Liquidity Sweeps", fired: true, dir: "LONG", strength: 74, read: `Swept sell-side liquidity below ${lastSL.p} then reclaimed — bullish reversal.`, level: lastSL.p };
  if (lastSH && last6.some((r) => +r.high > lastSH.p && +r.close < lastSH.p))
    return { key: "liquidity", label: "Liquidity Sweeps", fired: true, dir: "SHORT", strength: 74, read: `Swept buy-side liquidity above ${lastSH.p} then rejected — bearish reversal.`, level: lastSH.p };
  return { key: "liquidity", label: "Liquidity Sweeps", fired: false, dir: null, strength: 35, read: "No recent stop-hunt / sweep.", level: undefined };
}

function scoutFib(rows: Row[], htf: Trend): Scout {
  const h = rows.map((r) => +r.high), l = rows.map((r) => +r.low), c = rows.map((r) => +r.close);
  const { sh, sl } = pivots(h, l, 2);
  const price = c[c.length - 1];
  const lastSH = sh[sh.length - 1], lastSL = sl[sl.length - 1];
  if (!lastSH || !lastSL) return { key: "fib", label: "Fib / OTE", fired: false, dir: null, strength: 35, read: "Not enough swings to measure a fib leg." };
  // With-trend pullback into the 0.62–0.79 OTE of the last impulse leg.
  if (htf !== "bearish" && lastSL.i < lastSH.i) {
    const span = lastSH.p - lastSL.p;
    const lo = lastSH.p - 0.79 * span, hi = lastSH.p - 0.62 * span;
    if (price >= lo && price <= hi) return { key: "fib", label: "Fib / OTE", fired: true, dir: "LONG", strength: 70, read: `In the 0.62–0.79 OTE (${lo.toFixed(4)}–${hi.toFixed(4)}) of the last up-leg — buy the pullback.`, level: hi };
  }
  if (htf !== "bullish" && lastSH.i < lastSL.i) {
    const span = lastSH.p - lastSL.p;
    const lo = lastSL.p + 0.62 * span, hi = lastSL.p + 0.79 * span;
    if (price >= lo && price <= hi) return { key: "fib", label: "Fib / OTE", fired: true, dir: "SHORT", strength: 70, read: `In the 0.62–0.79 OTE (${lo.toFixed(4)}–${hi.toFixed(4)}) of the last down-leg — sell the pullback.`, level: lo };
  }
  return { key: "fib", label: "Fib / OTE", fired: false, dir: null, strength: 40, read: "Price isn't in a fib OTE zone right now." };
}

function scoutBreakRetest(rows: Row[]): Scout {
  const h = rows.map((r) => +r.high), l = rows.map((r) => +r.low), c = rows.map((r) => +r.close);
  const { sh, sl } = pivots(h, l, 2);
  const price = c[c.length - 1];
  const atrv = atr(rows, 14) || (Math.max(...h.slice(-20)) - Math.min(...l.slice(-20))) * 0.1 || price * 0.002;
  const tol = atrv * 0.6;
  // Broke a prior swing high and is retesting it from above = buy; opposite = sell.
  for (const s of sh) { if (s.i < h.length - 3 && price > s.p && Math.abs(price - s.p) <= tol) return { key: "breakRetest", label: "Break & Retest", fired: true, dir: "LONG", strength: 68, read: `Reclaimed & retesting the broken high at ${s.p} from above — continuation long.`, level: s.p }; }
  for (const s of sl) { if (s.i < l.length - 3 && price < s.p && Math.abs(price - s.p) <= tol) return { key: "breakRetest", label: "Break & Retest", fired: true, dir: "SHORT", strength: 68, read: `Broke & retesting the low at ${s.p} from below — continuation short.`, level: s.p }; }
  return { key: "breakRetest", label: "Break & Retest", fired: false, dir: null, strength: 35, read: "No fresh break-and-retest at the current price." };
}

function scoutFVG(rows: Row[]): Scout {
  const price = +rows[rows.length - 1].close;
  const bull: [number, number][] = [], bear: [number, number][] = [];
  for (let i = 2; i < rows.length; i++) {
    const aH = +rows[i - 2].high, aL = +rows[i - 2].low, cH = +rows[i].high, cL = +rows[i].low;
    if (aH < cL) bull.push([aH, cL]); if (aL > cH) bear.push([cH, aL]);
  }
  const nb = bull[bull.length - 1], ne = bear[bear.length - 1];
  if (nb && price >= nb[0] && price <= nb[1]) return { key: "fvg", label: "Fair Value Gaps", fired: true, dir: "LONG", strength: 62, read: `Price is filling a bullish fair-value gap (${nb[0].toFixed(4)}–${nb[1].toFixed(4)}) — demand.`, level: nb[1] };
  if (ne && price >= ne[0] && price <= ne[1]) return { key: "fvg", label: "Fair Value Gaps", fired: true, dir: "SHORT", strength: 62, read: `Price is filling a bearish fair-value gap (${ne[0].toFixed(4)}–${ne[1].toFixed(4)}) — supply.`, level: ne[0] };
  return { key: "fvg", label: "Fair Value Gaps", fired: false, dir: null, strength: 40, read: "Price isn't inside an unfilled FVG." };
}

function scoutSR(rows: Row[]): Scout {
  const h = rows.map((r) => +r.high), l = rows.map((r) => +r.low), c = rows.map((r) => +r.close);
  const price = c[c.length - 1];
  const hi = Math.max(...h.slice(-40)), lo = Math.min(...l.slice(-40));
  const atrv = atr(rows, 14) || (hi - lo) * 0.1 || price * 0.002;
  if (Math.abs(price - lo) <= atrv * 0.8) return { key: "sr", label: "Support / Resistance", fired: true, dir: "LONG", strength: 58, read: `At range support ${lo.toFixed(4)} — buyers likely to defend.`, level: lo };
  if (Math.abs(price - hi) <= atrv * 0.8) return { key: "sr", label: "Support / Resistance", fired: true, dir: "SHORT", strength: 58, read: `At range resistance ${hi.toFixed(4)} — sellers likely to defend.`, level: hi };
  return { key: "sr", label: "Support / Resistance", fired: false, dir: null, strength: 40, read: "Price is mid-range, away from a key S/R level." };
}

function scoutTrend(rows: Row[], htf: Trend): Scout {
  const t = trendOf(rows);
  const dir: Dir | null = htf === "bullish" ? "LONG" : htf === "bearish" ? "SHORT" : t === "bullish" ? "LONG" : t === "bearish" ? "SHORT" : null;
  const aligned = t === htf && htf !== "ranging";
  return { key: "trend", label: "Trend (MAs)", fired: dir != null, dir, strength: aligned ? 80 : dir ? 60 : 35, read: dir ? `Higher-timeframe trend is ${htf}${aligned ? " and the execution frame agrees" : ""} — trade with it.` : "No clear trend — market is ranging." };
}

function scoutRSI(rows: Row[], htf: Trend): Scout {
  const c = rows.map((r) => +r.close);
  const r = rsi(c);
  if (r == null) return { key: "rsi", label: "RSI Momentum", fired: false, dir: null, strength: 35, read: "Not enough data for RSI." };
  // With-trend momentum only — oversold alone never calls a long into a downtrend.
  if (htf === "bullish" && r > 50) return { key: "rsi", label: "RSI Momentum", fired: true, dir: "LONG", strength: 60, read: `RSI ${r.toFixed(0)} — momentum supports the bullish trend.` };
  if (htf === "bearish" && r < 50) return { key: "rsi", label: "RSI Momentum", fired: true, dir: "SHORT", strength: 60, read: `RSI ${r.toFixed(0)} — momentum supports the bearish trend.` };
  if (htf === "ranging" && r < 30) return { key: "rsi", label: "RSI Momentum", fired: true, dir: "LONG", strength: 52, read: `RSI ${r.toFixed(0)} oversold in a range — fade toward the mean.` };
  if (htf === "ranging" && r > 70) return { key: "rsi", label: "RSI Momentum", fired: true, dir: "SHORT", strength: 52, read: `RSI ${r.toFixed(0)} overbought in a range — fade toward the mean.` };
  return { key: "rsi", label: "RSI Momentum", fired: false, dir: null, strength: 40, read: `RSI ${r.toFixed(0)} — momentum is neutral / against a with-trend entry.` };
}

const ALL_SCOUTS = ["structure", "liquidity", "fvg", "sr", "trend", "rsi", "fib", "breakRetest"];
const INTENT: Record<string, { exec: string; ctx: string; ctx2: string; label: string; note: string }> = {
  scalp: { exec: "5min", ctx: "1h", ctx2: "4h", label: "Scalp", note: "a quick 30–100 pip move in the next ~15–45 minutes" },
  intraday: { exec: "1h", ctx: "4h", ctx2: "1day", label: "Intraday", note: "a bigger intraday move" },
  swing: { exec: "1day", ctx: "1week", ctx2: "1week", label: "Swing", note: "the overall multi-day direction" },
};

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
  const mdKey = process.env.TWELVEDATA_API_KEY;
  const aiKey = process.env.ANTHROPIC_API_KEY;
  if (!mdKey) return json({ error: "notConfigured", reason: "Live market data isn't connected." }, 200);

  let body: { td?: unknown; style?: unknown; scouts?: unknown };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const rawTd = typeof body?.td === "string" ? body.td : "";
  const found = resolveAsset(rawTd);
  if (!found) return json({ error: "unknown_asset", reason: "Type a symbol like EUR/USD, XAU/USD, GBP/JPY, or SPY." }, 400);
  const td = found.asset.td; // canonical symbol used for every data fetch below
  const style = typeof body?.style === "string" && INTENT[body.style] ? (body.style as string) : "intraday";
  const intent = INTENT[style];
  const chosen: string[] = Array.isArray(body?.scouts) ? (body!.scouts as unknown[]).filter((s): s is string => typeof s === "string" && ALL_SCOUTS.includes(s)) : ALL_SCOUTS;
  const use = chosen.length ? chosen : ALL_SCOUTS;

  const gate = await gateCredits("signal");
  if (!gate.ok && gate.reason === "unauthorized") return json({ error: "unauthorized" }, 401);
  if (!gate.ok && gate.reason === "insufficient") return json({ error: "insufficient_credits", balance: gate.balance }, 402);
  const [execR, ctxR, ctx2R, price] = await Promise.all([
    series(td, intent.exec, 120, mdKey, fresh),
    series(td, intent.ctx, 60, mdKey, fresh),
    series(td, intent.ctx2, 60, mdKey, fresh),
    livePrice(td, mdKey, fresh),
  ]);
  if ([execR, ctxR, ctx2R].some((r) => r === "ratelimit")) return json({ error: "ratelimit", reason: "Hit the free market-data limit (8/min). Wait a minute and retry." }, 429);
  const rows = Array.isArray(execR) ? execR : null;
  if (!rows || rows.length < 30) return json({ error: "marketdata_error", reason: "Not enough candles to scan this instrument on this timeframe." }, 502);
  const ctx = Array.isArray(ctxR) ? ctxR : null;
  const ctx2 = Array.isArray(ctx2R) ? ctx2R : null;

  // Higher-timeframe trend = context frames (this is the top filter).
  const tCtx = trendOf(ctx), tCtx2 = trendOf(ctx2);
  const htf: Trend = tCtx !== "ranging" && tCtx === tCtx2 ? tCtx : tCtx !== "ranging" ? tCtx : tCtx2;

  // Regime read (surfaced to the trader so they can SEE what the engine decided).
  const regimeLabel = htf === "bullish" ? "Uptrend" : htf === "bearish" ? "Downtrend" : "Ranging — no clear trend";
  const regimeBasis = `${intent.ctx} ${tCtx} · ${intent.ctx2} ${tCtx2}`;

  const px = price != null && Math.abs(price - +rows[rows.length - 1].close) / +rows[rows.length - 1].close < 0.05 ? price : +rows[rows.length - 1].close;
  const asOf = new Date().toISOString();   // stamp: the exact moment this analysis was computed
  const priceIsLive = price != null && Math.abs(price - +rows[rows.length - 1].close) / +rows[rows.length - 1].close < 0.05;
  const pip = pipSize(found.asset.symbol);
  const dec = px >= 1000 ? 2 : px >= 1 ? 4 : 6;
  const f = (n: number) => +n.toFixed(dec);
  const atrv = atr(rows, 14) || (Math.max(...rows.map((r) => +r.high).slice(-20)) - Math.min(...rows.map((r) => +r.low).slice(-20))) * 0.1 || px * 0.002;

  // Run the selected scouts.
  const registry: Record<string, () => Scout> = {
    structure: () => scoutStructure(rows, htf),
    liquidity: () => scoutLiquidity(rows),
    fib: () => scoutFib(rows, htf),
    breakRetest: () => scoutBreakRetest(rows),
    fvg: () => scoutFVG(rows),
    sr: () => scoutSR(rows),
    trend: () => scoutTrend(rows, htf),
    rsi: () => scoutRSI(rows, htf),
  };
  const scouts = use.map((k) => registry[k]()).filter(Boolean);

  // Combine: weight each firing scout by its strength; with-trend votes get a
  // boost, counter-trend votes get damped UNLESS structure+liquidity both flip
  // (a genuine reversal). Structural scouts (structure, liquidity, breakRetest)
  // carry more authority than momentum/level scouts.
  const AUTH: Record<string, number> = { structure: 1.4, liquidity: 1.4, breakRetest: 1.2, fib: 1.1, fvg: 1.0, sr: 0.9, trend: 1.2, rsi: 0.7 };
  const reversalConfirmed = scouts.some((s) => s.key === "structure" && s.fired && s.dir && ((htf === "bearish" && s.dir === "LONG") || (htf === "bullish" && s.dir === "SHORT")))
    && scouts.some((s) => s.key === "liquidity" && s.fired);
  let longScore = 0, shortScore = 0;
  for (const s of scouts) {
    if (!s.fired || !s.dir) continue;
    const withTrend = (htf === "bullish" && s.dir === "LONG") || (htf === "bearish" && s.dir === "SHORT") || htf === "ranging";
    let w = (AUTH[s.key] ?? 1) * (s.strength / 100);
    if (withTrend) w *= 1.25; else w *= reversalConfirmed ? 0.9 : 0.35;   // counter-trend heavily damped unless confirmed
    if (s.dir === "LONG") longScore += w; else shortScore += w;
  }
  const total = longScore + shortScore;
  const dir: Dir | null = total < 0.6 ? null : longScore >= shortScore ? "LONG" : "SHORT";
  const dominant = Math.max(longScore, shortScore);
  const agreement = total ? dominant / total : 0;                          // 0.5 = split, 1.0 = unanimous
  const confluence = Math.min(100, Math.round(dominant * 22));             // rough 0–100 confluence meter

  // Not enough agreement, or the reads conflict → honest WAIT.
  if (!dir || agreement < 0.6 || confluence < 45) {
    const setup = {
      status: "wait" as const, symbol: found.asset.symbol, instrument: td, style: intent.label,
      price: f(px), live_price: f(px), as_of: asOf, price_is_live: priceIsLive, htf_trend: htf, confluence, agreement: +agreement.toFixed(2),
      regime_label: regimeLabel, regime_basis: regimeBasis,
      strategy: "Standing aside — waiting for confluence",
      strategy_why: htf === "ranging"
        ? "No clear trend to lean on and the range-fade reads don't line up yet — no side has an edge."
        : `The ${regimeLabel.toLowerCase()} is intact, but not enough strategies agree on an entry right now.`,
      headline: `${found.asset.symbol} · WAIT — no clean confluence`,
      reason: dir ? `The strategies are leaning ${dir} but agreement is only ${Math.round(agreement * 100)}% and confluence is thin (${confluence}/100). Better to wait for the reads to line up.` : `The strategies conflict / are mid-structure — no side has an edge right now.`,
      scouts: scouts.map((s) => ({ ...s, level: s.level != null ? f(s.level) : undefined })),
      educational: "Educational market analysis only — not financial advice. WAIT is a valid result: the scanner only calls a trade when enough strategies genuinely agree.",
    };
    await chargeCredit("signal");
    return json(setup, 200);
  }

  // Build the trade deterministically from the firing scouts on the winning side.
  const isLong = dir === "LONG";
  const firing = scouts.filter((s) => s.fired && s.dir === dir);
  const anchors = firing.map((s) => s.level).filter(numOk) as number[];
  const h = rows.map((r) => +r.high), l = rows.map((r) => +r.low);
  const { sh, sl } = pivots(h, l, 2);
  const lastSH = sh[sh.length - 1]?.p ?? Math.max(...h.slice(-20));
  const lastSL = sl[sl.length - 1]?.p ?? Math.min(...l.slice(-20));

  // Strong-trend breakout continuation: when BOTH higher-timeframe context frames
  // agree with the trend (a genuinely strong trend, not just a lean) AND the
  // structure scout just fired a break-of-structure in the trend direction with
  // price sitting right at the break (not already extended past it), join the break
  // at MARKET rather than anchoring a pullback limit that may never fill. The stop
  // tucks just back under the broken level, which now flips to support/resistance —
  // that tight structural stop is the whole edge of a breakout entry.
  const structScout = scouts.find((s) => s.key === "structure" && s.fired && s.dir === dir);
  const brk = structScout && numOk(structScout.level) ? (structScout.level as number) : null;
  const strongAligned = htf !== "ranging" && tCtx === tCtx2 && tCtx === htf;
  const isBreakout = strongAligned && brk != null &&
    (isLong ? px >= brk && px <= brk + atrv * 0.8 : px <= brk && px >= brk - atrv * 0.8);

  // Minimum stop in pips, scaled by style (scalp tightest). FX majors ~8/12/18 pips;
  // instruments quoted with a big pip (indices/crypto pip=1, metals pip>=0.1) get a
  // larger point floor.
  const basePips = style === "scalp" ? 8 : style === "swing" ? 18 : 12;
  const pipFloor = (pip >= 1 ? basePips * 2 : pip >= 0.1 ? basePips * 1.5 : basePips) * pip;
  const buffer = pip * 2; // clear spread + a wick beyond the swing

  const entry = isBreakout ? f(px) : anchors.length ? f(anchors.reduce((a, b) => a + b, 0) / anchors.length) : f(px);
  let rawRisk: number;
  if (isBreakout) {
    const breakoutStop = isLong ? (brk as number) - atrv * 0.6 : (brk as number) + atrv * 0.6;
    rawRisk = Math.max(Math.abs(entry - breakoutStop), atrv * 0.8, pipFloor);
  } else {
    // Pullback stop: beyond the nearest opposing swing, floored at 1.5x ATR + a pip minimum.
    const structRisk = isLong ? Math.max(0, entry - lastSL) + buffer : Math.max(0, lastSH - entry) + buffer;
    rawRisk = Math.max(structRisk, atrv * 1.5, pipFloor);
  }
  const stop = f(isLong ? entry - rawRisk : entry + rawRisk);
  const risk = Math.abs(entry - stop) || rawRisk;
  const targets = [1.5, 2.5, 4.0].map((m) => f(isLong ? entry + risk * m : entry - risk * m));
  const rr1 = +(Math.abs(targets[0] - entry) / risk).toFixed(1);
  const orderType = isLong ? (entry < px ? "limit" : "market") : (entry > px ? "limit" : "market");
  const confidence = confluence >= 78 ? "High" : confluence >= 60 ? "Medium" : "Low";

  // ── Chase guard ───────────────────────────────────────────────────────────
  // Default behaviour is UNCHANGED: a limit/retest entry is still called even
  // when live price currently sits above (long) / below (short) the entry —
  // price often blows past a level, comes back to retest, and then continues,
  // which is a perfectly good trade. We ONLY switch to a "missed" result when
  // price has TRULY left: it has travelled more than a full planned-risk
  // (1.2R) beyond the ideal entry. By then a retest that deep would put the
  // structure in doubt, price has already covered ~80%+ of the move to the
  // first target (reward gone), and the fixed stop would be far more exposed —
  // so there is genuinely no point entering even if it did come back.
  // Breakout / market entries (entry ≈ live price) can never trip this.
  const CHASE_R = 1.2;
  const runPast = isLong ? px - entry : entry - px;   // distance live price ran past the ideal entry, in trade direction
  const runR = risk > 0 ? runPast / risk : 0;
  if (orderType === "limit" && runR >= CHASE_R) {
    const missed = {
      status: "missed" as const, symbol: found.asset.symbol, instrument: td, market: found.market.name, style: intent.label,
      direction: dir, order_type: orderType, price: f(px), live_price: f(px), as_of: asOf, price_is_live: priceIsLive,
      htf_trend: htf, confluence, agreement: +agreement.toFixed(2), confidence,
      regime_label: regimeLabel, regime_basis: regimeBasis,
      ideal_entry: entry, missed_by_pips: +(runPast / pip).toFixed(1), ran_r: +runR.toFixed(1),
      strategy: `Missed — price already extended · ${dir}`,
      strategy_why: `The ${dir} read was valid — structure broke ${isLong ? "up" : "down"} in line with the ${regimeLabel.toLowerCase()} — but live price has already run ${runR.toFixed(1)}× the planned risk past the ideal entry (${entry} → now ${f(px)}, ~${Math.round(Math.abs(runPast) / pip)} pips away). A retest that deep would call the move into question, and even if price did come back, most of the move to the first target is already gone while the stop would be fully exposed. There's no good entry here right now — better to let this one go and take the next clean setup.`,
      scouts: scouts.map((s) => ({ ...s, level: s.level != null ? f(s.level) : undefined })),
      headline: `${found.asset.symbol} · ${dir} — MISSED (price already ran)`,
      educational: "Educational market analysis only — not financial advice. Missing a trade is normal and protects capital: chasing an already-extended move is how good setups turn into bad entries. WAIT / MISSED are valid, disciplined results.",
    };
    await chargeCredit("signal");
    return json(missed, 200);
  }

  // Name the strategy the engine actually chose, given the regime + which scouts fired.
  const isReversal = reversalConfirmed && ((htf === "bearish" && isLong) || (htf === "bullish" && !isLong));
  const winKeys = new Set(firing.map((s) => s.key));
  let strategy: string;
  let strategyWhy: string;
  if (isBreakout) {
    strategy = `Breakout continuation · ${dir}`;
    strategyWhy = `Strong ${regimeLabel.toLowerCase()} — both higher timeframes agree — and price just broke structure ${isLong ? "up" : "down"} at the break. Joining the momentum at market instead of waiting for a pullback that may not come, with a tight stop under the broken level.`;
  } else if (isReversal) {
    strategy = `Counter-trend reversal · ${dir}`;
    strategyWhy = `Structure flipped against the ${regimeLabel.toLowerCase()} AND liquidity was swept — a genuine reversal, not just a dip, so the engine is allowed to trade against the trend here.`;
  } else if (htf === "ranging") {
    strategy = `Range fade · ${dir}`;
    strategyWhy = isLong
      ? "No clear trend, so the engine is buying the low of the range back toward the middle."
      : "No clear trend, so the engine is selling the high of the range back toward the middle.";
  } else if (winKeys.has("breakRetest") || winKeys.has("structure")) {
    strategy = `With-trend continuation · ${dir}`;
    strategyWhy = `Price broke structure ${isLong ? "up" : "down"} in line with the ${regimeLabel.toLowerCase()} and is continuing — entering on the break & retest.`;
  } else {
    strategy = `With-trend pullback · ${dir}`;
    strategyWhy = `Trading with the ${regimeLabel.toLowerCase()}: waiting for a pullback into value (fib / FVG / support-resistance) to join the move rather than chasing.`;
  }

  const setup = {
    status: "setup" as const, symbol: found.asset.symbol, instrument: td, market: found.market.name, style: intent.label, note: intent.note,
    direction: dir, order_type: orderType, price: f(px), live_price: f(px), as_of: asOf, price_is_live: priceIsLive, htf_trend: htf, confluence, agreement: +agreement.toFixed(2), confidence,
    regime_label: regimeLabel, regime_basis: regimeBasis, strategy, strategy_why: strategyWhy,
    entry, stop_loss: stop, take_profits: targets, risk_reward: `1:${rr1}`, stop_pips: +(risk / pip).toFixed(1),
    reversal: reversalConfirmed && ((htf === "bearish" && isLong) || (htf === "bullish" && !isLong)),
    scouts: scouts.map((s) => ({ ...s, level: s.level != null ? f(s.level) : undefined })),
    headline: `${found.asset.symbol} · ${dir} — ${firing.length} strategies agree (${confluence}/100)`,
    reasoning: [] as string[],
    educational: "Educational market analysis & paper-trading decision support — not financial advice, and not a prediction. Trading involves substantial risk; manage your own exposure.",
  };
  setup.reasoning = await narrate(setup, aiKey).catch(() => deterministic(setup));
  await chargeCredit("signal");
  // Universal outcome logging (fire-and-safe: never blocks or breaks the signal).
  await logSignal({
    engine: "scanner", userId: loggedUserId, instrument: td, symbol: found.asset.symbol,
    style, method: strategy, direction: dir, orderType, entry, stop, tps: targets,
    confidence, score: confluence, regime: regimeLabel, atr: atrv, priceAtIssue: px,
    interval: intent.exec, meta: { agreement: +agreement.toFixed(2), firing: firing.map((s) => s.key), breakout: isBreakout },
  });
  return json(setup, 200);
}

function deterministic(s: Record<string, unknown>): string[] {
  const firing = (s.scouts as Scout[]).filter((x) => x.fired && x.dir === (s.direction as string === "LONG" ? "LONG" : "SHORT"));
  const out = [`Higher-timeframe trend is ${s.htf_trend}; ${firing.length} selected strategies agree on a ${s.direction}.`];
  for (const x of firing.slice(0, 4)) out.push(`${x.label}: ${x.read}`);
  out.push(`Entry ${s.entry}, stop ${s.stop_loss}, first target ${(s.take_profits as number[])[0]} (${s.risk_reward}).`);
  return out.slice(0, 6);
}

async function narrate(s: Record<string, unknown>, aiKey: string | undefined): Promise<string[]> {
  if (!aiKey) return deterministic(s);
  const sys = `You are OM Strategy Scanner's explainer. You are given a FINAL, LOCKED JSON result that a deterministic multi-strategy engine already produced: a list of trading strategies (market structure, liquidity sweeps, fair-value gaps, fib/OTE, break-&-retest, support/resistance, trend, RSI), each with its own read, plus the combined trade (direction, entry, stop, targets, confluence). Your ONLY job is to explain, in plain simple English a beginner can follow, WHY this trade was chosen — walk through the specific strategy chain that fired (e.g. "structure broke down, then price swept the highs and rejected, so we sell the pullback into the fib zone"). You MUST NOT invent or change any number, level, or direction, and MUST NOT invent news. Return ONLY a JSON array of 3-5 short plain-English sentences.`;
  const r = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": aiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: 500, system: sys, messages: [{ role: "user", content: `LOCKED RESULT:\n${JSON.stringify(s)}\n\nReturn the JSON array now.` }] }),
  });
  const j = await r.json();
  const raw = Array.isArray(j.content) ? j.content.filter((b: { type?: string }) => b?.type === "text").map((b: { text?: string }) => b.text ?? "").join("") : "";
  const m = raw.match(/\[[\s\S]*\]/);
  if (!m) return deterministic(s);
  try { const arr = JSON.parse(m[0]); return Array.isArray(arr) ? arr.map(String).slice(0, 6) : deterministic(s); } catch { return deterministic(s); }
}

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
