import { type NextRequest } from "next/server";
import { authedContext } from "@/lib/supabase/bearer";
import { gateCredits, chargeCredit } from "@/lib/credits";
import { series, isPriorityEmail } from "@/lib/marketData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Market Pulse scanner — runs the same objective, multi-factor read as OM AI
 * Plays across a universe of assets, but computed purely from the candles (no
 * per-asset AI call), so it's fast and cheap. Returns each asset's highest-
 * probability direction and how many professional confirmations line up right
 * now, ranked best-first. The member taps one to generate the full AI play.
 */

type Row = { datetime: string; open: string; high: string; low: string; close: string };

// Focused universe: main FX majors, gold, the two headline indices, and the
// two lead crypto — 8 assets, which stays within the free rate limit (8/min)
// and keeps Market Pulse precise. Widen this once on a paid data plan.
const UNIVERSE: { symbol: string; name: string; td: string }[] = [
  { symbol: "EUR/USD", name: "Euro", td: "EUR/USD" },
  { symbol: "GBP/USD", name: "Pound", td: "GBP/USD" },
  { symbol: "USD/JPY", name: "Yen", td: "USD/JPY" },
  { symbol: "XAU/USD", name: "Gold", td: "XAU/USD" },
  { symbol: "DIA", name: "Dow Jones (US30)", td: "DIA" },
  { symbol: "NAS100", name: "Nasdaq 100 (NAS100)", td: "NAS100" },
  { symbol: "BTC/USD", name: "Bitcoin", td: "BTC/USD" },
  { symbol: "ETH/USD", name: "Ethereum", td: "ETH/USD" },
];

const numOk = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
function sma(v: number[], n: number) { if (v.length < n) return null; let s = 0; for (let i = v.length - n; i < v.length; i++) s += v[i]; return s / n; }
function rsi(c: number[], p = 14) { if (c.length < p + 1) return null; let g = 0, l = 0; for (let i = c.length - p; i < c.length; i++) { const d = c[i] - c[i - 1]; if (d >= 0) g += d; else l -= d; } const ag = g / p, al = l / p; if (al === 0) return 100; return 100 - 100 / (1 + ag / al); }
function findFVGs(rows: Row[]) { const bull: [number, number][] = [], bear: [number, number][] = []; for (let i = 2; i < rows.length; i++) { const aH = +rows[i - 2].high, aL = +rows[i - 2].low, cH = +rows[i].high, cL = +rows[i].low; if (cL > aH) bull.push([aH, cL]); if (cH < aL) bear.push([cH, aL]); } return { bull, bear }; }
function pivots(highs: number[], lows: number[], k = 2) { const sh: { i: number; p: number }[] = [], sl: { i: number; p: number }[] = []; for (let i = k; i < highs.length - k; i++) { let isH = true, isL = true; for (let j = i - k; j <= i + k; j++) { if (j === i) continue; if (highs[j] >= highs[i]) isH = false; if (lows[j] <= lows[i]) isL = false; } if (isH) sh.push({ i, p: highs[i] }); if (isL) sl.push({ i, p: lows[i] }); } return { sh, sl }; }

// Community-cached 1H pull via the shared fetcher (skips API + budget on a cache hit).
async function fetchSeries(td: string, key: string, fresh: boolean): Promise<Row[] | null> {
  const r = await series(td, "1h", 80, key, fresh);
  return Array.isArray(r) ? r : null;
}

function analyze(rows: Row[]) {
  const closes = rows.map((v) => +v.close), highs = rows.map((v) => +v.high), lows = rows.map((v) => +v.low);
  const price = closes[closes.length - 1];
  const rangeHi = Math.max(...highs.slice(-40)), rangeLo = Math.min(...lows.slice(-40));
  const eq = (rangeHi + rangeLo) / 2, span = (rangeHi - rangeLo) || 1, tol = span * 0.06;
  const s20 = sma(closes, 20), s50 = sma(closes, 50), rv = rsi(closes);
  const trend: "bullish" | "bearish" | "ranging" = s20 && s50 ? (price > s20 && s20 > s50 ? "bullish" : price < s20 && s20 < s50 ? "bearish" : "ranging") : "ranging";

  // Lean → the higher-probability side right now
  let lean = 0;
  if (trend === "bullish") lean += 2; else if (trend === "bearish") lean -= 2;
  lean += price <= eq ? 1 : -1;
  if (rv != null) { if (rv < 40) lean += 1; else if (rv > 60) lean -= 1; }
  const dir: "LONG" | "SHORT" = lean >= 0 ? "LONG" : "SHORT";

  const piv = pivots(highs, lows, 2);
  const shs = piv.sh, sls = piv.sl;
  const lastSH = shs.length ? shs[shs.length - 1] : null, lastSL = sls.length ? sls[sls.length - 1] : null;
  const prevSH = shs.length > 1 ? shs[shs.length - 2] : null, prevSL = sls.length > 1 ? sls[sls.length - 2] : null;
  let structureDir: "LONG" | "SHORT" | "none" = "none";
  if (lastSH && price > lastSH.p) structureDir = "LONG";
  else if (lastSL && price < lastSL.p) structureDir = "SHORT";
  else if (prevSH && lastSH && prevSL && lastSL) { if (lastSH.p > prevSH.p && lastSL.p > prevSL.p) structureDir = "LONG"; else if (lastSH.p < prevSH.p && lastSL.p < prevSL.p) structureDir = "SHORT"; }

  const legHi = lastSH ? lastSH.p : rangeHi, legLo = lastSL ? lastSL.p : rangeLo, legSpan = (legHi - legLo) || 1;
  const E = price;
  const inOTE = dir === "LONG" ? E >= legHi - 0.79 * legSpan && E <= legHi - 0.62 * legSpan : E >= legLo + 0.62 * legSpan && E <= legLo + 0.79 * legSpan;
  const fvg = findFVGs(rows.slice(-30));
  const fvgEdges = [...fvg.bull.flat(), ...fvg.bear.flat()].filter(numOk) as number[];
  const srLevels = [...shs.map((s) => s.p), ...sls.map((s) => s.p), rangeHi, rangeLo, eq].filter(numOk);
  const last6 = rows.slice(-6);
  const swept = dir === "LONG" ? !!lastSL && last6.some((c) => +c.low < lastSL!.p && +c.close > lastSL!.p) : !!lastSH && last6.some((c) => +c.high > lastSH!.p && +c.close < lastSH!.p);
  const brOk = dir === "LONG" ? shs.some((s) => price > s.p && Math.abs(E - s.p) <= tol * 1.5 && s.i < highs.length - 2) : sls.some((s) => price < s.p && Math.abs(E - s.p) <= tol * 1.5 && s.i < lows.length - 2);
  const momentumOk = rv == null ? false : dir === "LONG" ? (rv >= 45 && rv <= 72) || rv < 32 : (rv <= 55 && rv >= 28) || rv > 68;

  const checklist = [
    { label: "Trend aligned", ok: dir === "LONG" ? trend !== "bearish" : trend !== "bullish" },
    { label: "Market structure", ok: structureDir === dir },
    { label: "Fair value gap", ok: fvgEdges.some((L) => Math.abs(E - L) <= tol) },
    { label: "Liquidity swept", ok: swept },
    { label: "Support / resistance", ok: srLevels.some((L) => Math.abs(E - L) <= tol) },
    { label: "Fib OTE", ok: inOTE },
    { label: "Break & retest", ok: brOk },
    { label: "Momentum", ok: momentumOk },
  ];
  const confirmed = checklist.filter((c) => c.ok).length;

  // ── Trade levels, from Market Pulse's OWN read ────────────────────────────
  // Same candles, same direction, same structure the scan already used — so the
  // entry / stop / targets ARE Market Pulse (never a second engine that could
  // disagree). Entry is the live price (a "take it now" read); the stop sits
  // beyond the swing that invalidates the idea (or an ATR floor), and the
  // targets are a clean R ladder off that risk.
  const dec = price >= 1000 ? 2 : price >= 1 ? 4 : 6;
  const rnd = (n: number) => +n.toFixed(dec);
  const trs: number[] = [];
  for (let i = Math.max(1, rows.length - 14); i < rows.length; i++) {
    const h = +rows[i].high, l = +rows[i].low, pc = +rows[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const atr = trs.length ? trs.reduce((a, b) => a + b, 0) / trs.length : span * 0.05 || price * 0.002;
  const atrDist = Math.max(atr * 1.2, price * 0.0012);
  const isLong = dir === "LONG";
  const swing = isLong ? (lastSL ? lastSL.p : null) : (lastSH ? lastSH.p : null);
  let stop = isLong ? price - atrDist : price + atrDist;
  if (swing != null) {
    const onSide = isLong ? swing < price : swing > price;
    const sdist = Math.abs(price - swing);
    if (onSide && sdist >= atrDist * 0.6 && sdist <= atrDist * 2.2) {
      stop = isLong ? swing - atrDist * 0.15 : swing + atrDist * 0.15; // just beyond the swing
    }
  }
  const riskDist = Math.abs(price - stop) || atrDist;
  const takeProfits = [1.5, 2.5, 4.0].map((m) => rnd(isLong ? price + riskDist * m : price - riskDist * m));

  return {
    dir, price, confirmed, total: checklist.length, checklist,
    zone: price <= eq ? "discount" : "premium", rsi: rv == null ? null : Math.round(rv),
    entry: rnd(price), stopLoss: rnd(stop), takeProfits, riskReward: "1:2.5",
  };
}

// ── Result cache (the biggest CPU saver on the platform) ────────────────────
// Market Pulse is IDENTICAL for every member — same universe, same candles, same
// math. So a freshly-computed scan is reused for a short window instead of
// re-fetching and re-crunching indicators for 8 instruments on every request.
// Warm Fluid instances keep this in memory across requests; admins (fresh) always
// bypass it, and the credit is still charged (the member asked for a scan). 1H
// candles barely move inside the TTL, so the read is effectively unchanged.
type Setup = { symbol: string; name: string; td: string } & ReturnType<typeof analyze>;
const SCAN_TTL_MS = Number(process.env.SCAN_CACHE_TTL || 60) * 1000;
let scanCache: { at: number; asOf: string; setups: Setup[] } | null = null;

export async function POST(req: NextRequest) {
  // Accept EITHER the web's cookie session OR the native app's Bearer token — the
  // app has no cookie jar, so a cookie-only check 401s every Market Pulse scan
  // from the app. authedContext tries the cookie first (web is unchanged), then
  // falls back to the Authorization: Bearer token (the app).
  const { supabase, user, configured } = await authedContext(req);
  let fresh = false; // owner/admin: always fresh data, never throttled
  if (configured) { if (!user) return json({ error: "unauthorized" }, 401); fresh = isPriorityEmail(user.email); }
  const mdKey = process.env.TWELVEDATA_API_KEY;
  if (!mdKey) return json({ notConfigured: "marketdata" }, 200);

  const gate = await gateCredits("scan", supabase);
  if (!gate.ok && gate.reason === "unauthorized") return json({ error: "unauthorized" }, 401);
  if (!gate.ok && gate.reason === "insufficient") return json({ error: "insufficient_credits", balance: gate.balance }, 402);

  // Serve a recent cached scan when one exists — skips 8 fetches + all indicator
  // math. Admins bypass so they can always force a fresh read.
  if (!fresh && scanCache && Date.now() - scanCache.at < SCAN_TTL_MS && scanCache.setups.length > 0) {
    const credits = await chargeCredit("scan", supabase);
    return json({ asOf: scanCache.asOf, setups: scanCache.setups, credits, cached: true }, 200);
  }

  const results = await Promise.all(UNIVERSE.map(async (a) => {
    const rows = await fetchSeries(a.td, mdKey, fresh);
    if (!rows || rows.length < 30) return null;
    const r = analyze(rows);
    return { ...a, ...r };
  }));

  const setups = (results.filter(Boolean) as Setup[]).sort((x, y) => (y.confirmed - x.confirmed));
  const asOf = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
  // Cache the computed result for the next members' scans in this window.
  if (setups.length > 0 && !fresh) scanCache = { at: Date.now(), asOf, setups };
  // Only charge if the scan actually produced setups (don't bill a fully rate-limited scan).
  const credits = setups.length > 0 ? await chargeCredit("scan", supabase) : null;
  return json({ asOf, setups, credits }, 200);
}

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
