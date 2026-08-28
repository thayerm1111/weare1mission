/**
 * Deterministic fixture checks for the OM/GENX entry engine (pure, no network).
 *
 * Run locally:  npx tsx scripts/engineChecks.ts
 * Exit code 0 = all checks pass. Each check prints PASS/FAIL with detail.
 *
 * These are chronological, closed-candle fixtures — no future data is ever
 * visible to the engine (runEngine itself drops the forming bar via closedBars).
 */
import { runEngine, type Row, type EngineCfg } from "../src/lib/omEngine";
import { genxConservativeGate } from "../src/lib/genxCompute";
import { closedBars } from "../src/lib/mtf";

const GOLD_CFG: EngineCfg = {
  symbol: "XAU/USD", label: "Gold", cat: "gold", pip: 0.1, dec: 2,
  minStopAtr: 0.25, maxStopAtr: 3.0, rrFloor: 1.0,
  bands: { ready: 74, develop: 62, watch: 52 },
};

// ── candle builders ──────────────────────────────────────────────────────────
let t0 = Date.parse("2026-08-01T00:00:00Z");
function bar(o: number, h: number, l: number, c: number, i: number, stepMin: number): Row {
  const t = new Date(t0 + i * stepMin * 60_000).toISOString().slice(0, 19).replace("T", " ");
  return { datetime: t, open: o.toFixed(2), high: h.toFixed(2), low: l.toFixed(2), close: c.toFixed(2) };
}
/** Uptrend series: steady drift up with small pullbacks (HH/HL swing structure). */
function uptrend(n: number, start: number, drift: number, stepMin: number): Row[] {
  const rows: Row[] = []; let p = start;
  for (let i = 0; i < n; i++) {
    const wave = Math.sin(i / 3) * drift * 1.2;           // pullback texture
    const o = p, c = p + drift + wave * 0.3;
    rows.push(bar(o, Math.max(o, c) + drift * 0.4, Math.min(o, c) - drift * 0.4, c, i, stepMin));
    p = c;
  }
  return rows;
}
/** Tight sideways series oscillating lo..hi (compression / range). */
function sideways(n: number, lo: number, hi: number, stepMin: number, endAt?: number): Row[] {
  const rows: Row[] = []; const mid = (lo + hi) / 2, amp = (hi - lo) / 2;
  for (let i = 0; i < n; i++) {
    const c = i === n - 1 && endAt != null ? endAt : mid + Math.sin(i / 2.1) * amp * 0.92;
    const o = mid + Math.sin((i - 1) / 2.1) * amp * 0.92;
    rows.push(bar(o, Math.max(o, c) + amp * 0.06, Math.min(o, c) - amp * 0.06, c, i, stepMin));
  }
  return rows;
}

// ── harness ──────────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail: string) {
  if (ok) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name} — ${detail}`); }
}
const S = (r: Record<string, unknown>) => `state=${r.state} strategy=${String(r.strategy)} profile=${String(r.entry_profile)} regime=${String(r.market_regime ?? "-")}`;

// 1) STRONG TREND PULLBACK — core family, both modes.
{
  const h1 = uptrend(80, 4500, 3.5, 60);
  const px = +h1[h1.length - 1].close - 2; // slight dip off the high = pullback area
  const r = runEngine(GOLD_CFG, { d1: uptrend(20, 4300, 12, 1440), h1, m30: uptrend(60, 4560, 1.6, 30), m15: uptrend(60, 4580, 0.9, 15), m5: uptrend(40, 4590, 0.5, 5), price: px, nowMs: Date.now(), session: "London" });
  check("trend-pullback detected (buy, core)", r.state !== "NO_TRADE" && (r as { direction?: string }).direction === "buy" && String(r.strategy).toLowerCase().includes("trend") && r.entry_profile === "core", S(r));
}

// 2) COMPRESSION AT RANGE EDGE — previously impossible; now an aggressive-only fade.
//    Genuine CONTRACTION: a wide early box narrowing into a tight late box, so the
//    recent ATR sits in a low percentile of its own history (the engine's
//    compression definition) with price pinned at the tight box's top edge.
{
  const wide = sideways(45, 4570, 4602, 60);                 // phase A: wide chop
  const tight = sideways(45, 4585, 4591, 60, 4590.6).map((r, i) => ({ ...r, datetime: new Date(Date.parse(wide[wide.length - 1].datetime.replace(" ", "T") + "Z") + (i + 1) * 3_600_000).toISOString().slice(0, 19).replace("T", " ") }));
  const h1 = [...wide, ...tight];
  const px = 4590.7; // at the tight box's upper edge
  const r = runEngine(GOLD_CFG, { d1: sideways(20, 4560, 4610, 1440), h1, m30: sideways(60, 4585, 4591, 30), m15: sideways(60, 4585, 4591, 15), m5: sideways(40, 4585, 4591, 5), price: px, nowMs: Date.now(), session: "New York" });
  const dirSet = (r as { direction?: string | null }).direction === "sell";
  const isCompression = String(r.market_regime ?? "").startsWith("Volatility compression");
  check("compression edge → aggressive-only fade (sell)", dirSet && isCompression && r.entry_profile === "aggressive_only" && String(r.strategy).includes("fade"), S(r));
}

// 3) COMPRESSION MID-RANGE — must STAY no-direction (middle-of-range rejection preserved).
{
  const lo = 4580, hi = 4592, mid = (lo + hi) / 2;
  const h1 = sideways(80, lo, hi, 60, mid);
  const r = runEngine(GOLD_CFG, { d1: sideways(20, 4560, 4610, 1440), h1, m30: sideways(60, lo, hi, 30), m15: sideways(60, lo, hi, 15), m5: sideways(40, lo, hi, 5), price: mid, nowMs: Date.now(), session: "New York" });
  check("compression mid-range stays WATCHLIST (no dir)", (r as { direction?: string | null }).direction == null && r.state === "WATCHLIST", S(r));
}

// 4) CONSERVATIVE GATE rejects aggressive-only families outright.
{
  const g = genxConservativeGate({ confidence_score: 95, momentum: "strong", market_structure: "Range", entry: 4590, stop_loss: 4596, tp1: 4570, side: "sell", session: "New York", entry_profile: "aggressive_only" });
  check("conservative gate rejects aggressive-only family", !g.ok && /aggressive/i.test(g.reason), JSON.stringify(g));
}

// 5) CONSERVATIVE GATE still accepts a strong core setup.
{
  const g = genxConservativeGate({ confidence_score: 70, momentum: "strong", market_structure: "Bullish", entry: 4590, stop_loss: 4584, tp1: 4602, side: "buy", session: "London", entry_profile: "core" });
  check("conservative gate accepts strong core setup", g.ok, JSON.stringify(g));
}

// 6) HARD VETO preserved — stop wider than maxStopAtr still refuses the trade.
{
  const h1 = uptrend(80, 4500, 3.5, 60);
  const cfg: EngineCfg = { ...GOLD_CFG, maxStopAtr: 0.05 }; // force the veto for the fixture
  const r = runEngine(cfg, { d1: uptrend(20, 4300, 12, 1440), h1, m30: uptrend(60, 4560, 1.6, 30), m15: uptrend(60, 4580, 0.9, 15), m5: uptrend(40, 4590, 0.5, 5), price: +h1[h1.length - 1].close, nowMs: Date.now(), session: "London" });
  check("hard veto: stop-too-wide still blocks", r.state === "NO_TRADE" && String((r as { headline?: string }).headline || "").includes("STOP TOO WIDE"), S(r));
}

// 7) NO LOOK-AHEAD — closedBars drops the newest (forming) bar.
{
  const rows = uptrend(50, 4500, 2, 60);
  const closed = closedBars(rows, 20)!;
  check("closedBars drops the forming candle", closed.length === rows.length - 1 && closed[closed.length - 1].datetime === rows[rows.length - 2].datetime, `len ${rows.length}→${closed.length}`);
}

// 8) DETERMINISM — identical snapshot in, identical decision out.
{
  const h1 = uptrend(80, 4500, 3.5, 60);
  const input = { d1: uptrend(20, 4300, 12, 1440), h1, m30: uptrend(60, 4560, 1.6, 30), m15: uptrend(60, 4580, 0.9, 15), m5: uptrend(40, 4590, 0.5, 5), price: +h1[h1.length - 1].close - 2, nowMs: 1756350000000, session: "London" };
  const a = runEngine(GOLD_CFG, input), b = runEngine(GOLD_CFG, input);
  const key = (r: Record<string, unknown>) => JSON.stringify({ s: r.state, st: r.strategy, sc: (r.scores as Record<string, number> | undefined)?.overall, p: r.entry_profile });
  check("deterministic for the same snapshot", key(a) === key(b), `${key(a)} vs ${key(b)}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
