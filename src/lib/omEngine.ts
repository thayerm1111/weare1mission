/**
 * OM deterministic setup engine — the SHARED core used by MFX Ghost and OM
 * Strategy Scanner (Market Command keeps its own in-file copy). Every number is
 * computed here in code from validated candles; the calling route uses the AI
 * ONLY to explain the finished result.
 *
 * Design rules baked in:
 *  • Timeframe alignment is NEVER a gate. It is a low-weight score input; a
 *    NEUTRAL higher timeframe is treated as neutral, only a materially OPPOSED
 *    one lowers the score. A valid lower-timeframe setup can be TRADE_READY.
 *  • Strategy quality dominates the score (structure/confirmation/RR/location).
 *  • Non-ready results always return an actionable SETUP ZONE + PROXIMITY +
 *    measurable event-based recheck — never "wait / check later".
 *  • News is NOT checked here; we return the currencies the user must verify.
 *
 * This module is PURE (no fetch/auth/db) so it can be unit-tested with fixtures.
 */
import { closedBars, mtfAlign } from "./mtf";

export type Row = { datetime: string; open: string; high: string; low: string; close: string; volume?: string };
export type Dir = "buy" | "sell";
export type State = "TRADE_READY" | "DEVELOPING_SETUP" | "WATCHLIST" | "NO_TRADE" | "DATA_UNAVAILABLE" | "INSUFFICIENT_DATA";

export type EngineCfg = {
  symbol: string; label: string; cat: "gold" | "forex" | "index" | "crypto" | "commodity" | "stock";
  pip: number; dec: number;
  minStopAtr: number; maxStopAtr: number; rrFloor: number;
  bands: { ready: number; develop: number; watch: number };
};

export type EngineInput = {
  d1: Row[] | null; h4?: Row[] | null; h1: Row[] | null; m30: Row[] | null; m15: Row[] | null; m5: Row[] | null;
  price: number; nowMs: number; session: string;
};

const numOk = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const clampN = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

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
function adx(rows: Row[], p = 14): number {
  if (rows.length < p * 2) return 0;
  const plus: number[] = [], minus: number[] = [], tr: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    const h = +rows[i].high, l = +rows[i].low, ph = +rows[i - 1].high, pl = +rows[i - 1].low, pc = +rows[i - 1].close;
    const up = h - ph, dn = pl - l;
    plus.push(up > dn && up > 0 ? up : 0); minus.push(dn > up && dn > 0 ? dn : 0);
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const smooth = (a: number[]) => { let s = a.slice(0, p).reduce((x, y) => x + y, 0); const o = [s]; for (let i = p; i < a.length; i++) { s = s - s / p + a[i]; o.push(s); } return o; };
  const trS = smooth(tr), plusS = smooth(plus), minusS = smooth(minus);
  const dx: number[] = [];
  for (let i = 0; i < trS.length; i++) {
    const pdi = trS[i] ? (100 * plusS[i]) / trS[i] : 0, mdi = trS[i] ? (100 * minusS[i]) / trS[i] : 0;
    dx.push(pdi + mdi ? (100 * Math.abs(pdi - mdi)) / (pdi + mdi) : 0);
  }
  return (dx.length >= p ? sma(dx.slice(-p), p) : sma(dx, dx.length)) ?? 0;
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
// A closed, structural confirmation read on the trigger frame.
function confirmRead(rows: Row[], dir: Dir): { closedWithTrend: boolean; momentumTurned: boolean; pullbackComplete: boolean } {
  if (rows.length < 6) return { closedWithTrend: false, momentumTurned: false, pullbackComplete: false };
  const last = rows[rows.length - 1], o = +last.open, c = +last.close, h = +last.high, l = +last.low;
  const body = Math.abs(c - o), range = (h - l) || 1;
  const bull = c > o, bodyOk = body / range >= 0.45;
  const closedWithTrend = dir === "buy" ? bull && bodyOk : !bull && bodyOk;
  const closes = rows.map((r) => +r.close);
  const r0 = rsi(closes, 14) ?? 50, r1 = rsi(closes.slice(0, -1), 14) ?? 50;
  const momentumTurned = dir === "buy" ? r0 > r1 : r0 < r1;
  // a prior opposing candle then a with-trend candle = a completed pullback
  const prev = rows[rows.length - 2], pBull = +prev.close > +prev.open;
  const pullbackComplete = dir === "buy" ? (!pBull && bull) : (pBull && !bull);
  return { closedWithTrend, momentumTurned, pullbackComplete };
}

export type Trigger = {
  state: State; asset: string; direction: "BUY" | "SELL" | null; strategy: string;
  monitorTimeframe: string; triggerType: string; triggerLevel: number | null;
  retestZoneLow: number | null; retestZoneHigh: number | null;
  confirmationRequired: string; invalidationLevel: number | null; expirationCondition: string;
  recheckInstruction: string; generatedAt: string; dataCandleClose: string | null;
};

// News is NOT checked — return the currencies/macro the user must verify.
export function newsCheck(symbol: string): { status: string; warning: string; currencies: string[]; note: string } {
  const s = symbol.toUpperCase();
  const warning = "News is not checked by this tool. Before entering, verify the economic calendar for high-impact events affecting this instrument.";
  const status = "Not checked — user verification required.";
  if (s === "XAU/USD" || s.includes("GOLD")) return { status, warning, currencies: ["USD"], note: "Verify major USD macro: Fed / FOMC, CPI & PCE inflation, NFP / employment, and Treasury-yield-moving releases." };
  const m = s.match(/^([A-Z]{3})\/([A-Z]{3})$/);
  if (m) return { status, warning, currencies: [m[1], m[2]], note: `Verify high-impact ${m[1]} and ${m[2]} events (rate decisions, inflation, employment, GDP).` };
  if (/(BTC|ETH|SOL|XRP|DOGE)/.test(s)) return { status, warning, currencies: ["USD", "Crypto"], note: "Verify USD macro (Fed, CPI) plus crypto-specific catalysts." };
  return { status, warning, currencies: ["USD"], note: "Verify the relevant high-impact macro releases for this instrument." };
}

export type EngineResult = Record<string, unknown> & { state: State; status: string };

/** The pure deterministic analysis. Returns the full v3 result object minus AI narrative. */
export function runEngine(cfg: EngineCfg, input: EngineInput): EngineResult {
  const { price: px, nowMs, session } = input;
  const dec = cfg.dec;
  const f = (n: number) => +n.toFixed(dec);
  const genAt = new Date(nowMs).toISOString();
  const nc = newsCheck(cfg.symbol);
  const statusMap: Record<State, string> = {
    TRADE_READY: "qualified_setup", DEVELOPING_SETUP: "developing_setup", WATCHLIST: "watchlist",
    NO_TRADE: "no_trade", DATA_UNAVAILABLE: "data_unavailable", INSUFFICIENT_DATA: "insufficient_data",
  };
  const base = (extra: Record<string, unknown>): EngineResult => ({
    state: extra.state as State, status: statusMap[extra.state as State],
    instrument: cfg.symbol, label: cfg.label, market_category: cfg.cat, timestamp: genAt, data_provider: "Twelve Data",
    strategy_version: "engine-v1",
    news_status: nc.status, news_warning: nc.warning, news_check_currencies: nc.currencies, news_check_note: nc.note,
    educational_disclaimer: "Educational market analysis only — not financial advice, and not a prediction. States: TRADE READY, DEVELOPING, WATCHLIST, NO TRADE. There is no guarantee a level is reached.",
    ...extra,
  });

  // ── Data validation → distinct DATA states (never "No Trade") ──
  const R1raw = input.h1, R15raw = input.m15, R5 = input.m5, RD = input.d1;
  if (!R1raw || R1raw.length < 40 || !R15raw || R15raw.length < 40 || !R5 || R5.length < 30 || !RD || RD.length < 10) {
    return base({ state: "INSUFFICIENT_DATA", headline: "INSUFFICIENT DATA", direction: null, strategy: "None",
      reason: `Not enough validated candles to analyse ${cfg.label}.`, what_next: ["Retry in ~1 minute (provider may be rate-limited).", "Confirm the instrument symbol is supported."], candles: [] });
  }
  const dataClose = R5.length ? new Date((R5[R5.length - 1].datetime || "").replace(" ", "T") + "Z").toISOString() : null;

  const R1 = (closedBars(R1raw, 40) ?? R1raw) as Row[];
  const R15 = (closedBars(R15raw, 40) ?? R15raw) as Row[];
  const R30c = closedBars(input.m30 ?? null, 20);
  const mtf = mtfAlign([{ tf: "1H", rows: R1 }, { tf: "30m", rows: R30c }, { tf: "15m", rows: R15 }]);
  const candleOut = R15raw.slice(-48).map((v) => ({ t: v.datetime, o: +v.open, h: +v.high, l: +v.low, c: +v.close }));

  const closes1 = R1.map((r) => +r.close), highs1 = R1.map((r) => +r.high), lows1 = R1.map((r) => +r.low);
  const a1 = atr(R1, 14) || (Math.max(...highs1.slice(-20)) - Math.min(...lows1.slice(-20))) * 0.1 || px * 0.002;
  const atrSeries: number[] = [];
  for (let i = 20; i < R1.length; i++) { const w = atr(R1.slice(0, i + 1), 14); if (w) atrSeries.push(w); }
  const atrPct = atrSeries.length ? Math.round((atrSeries.filter((v) => v <= a1).length / atrSeries.length) * 100) : 50;
  const s20 = sma(closes1, 20), s50 = sma(closes1, 50), adxV = adx(R1, 14);
  const trendUp = s20 != null && s50 != null && px > s20 && s20 > s50;
  const trendDn = s20 != null && s50 != null && px < s20 && s20 < s50;
  const strongTrend = adxV >= 40;

  let regime = "Unclear / conflicting", regimeDir: Dir | null = null, regimeScore = 40;
  if (adxV >= 25 && trendUp) { regime = strongTrend ? "Strong bullish trend" : "Weak bullish trend"; regimeDir = "buy"; regimeScore = strongTrend ? 90 : 68; }
  else if (adxV >= 25 && trendDn) { regime = strongTrend ? "Strong bearish trend" : "Weak bearish trend"; regimeDir = "sell"; regimeScore = strongTrend ? 90 : 68; }
  else if (adxV < 18 && atrPct < 35) { regime = "Volatility compression"; regimeScore = 45; }
  else if (adxV < 20) { regime = "Range / mean-reversion"; regimeScore = 55; }
  else if (atrPct > 80) { regime = "Volatility expansion"; regimeScore = 50; }

  const piv = pivots(highs1, lows1, 2);
  const rangeHi = Math.max(...highs1.slice(-40)), rangeLo = Math.min(...lows1.slice(-40)), eq = (rangeHi + rangeLo) / 2;
  const prevDayHi = RD.length >= 2 ? +RD[RD.length - 2].high : rangeHi;
  const prevDayLo = RD.length >= 2 ? +RD[RD.length - 2].low : rangeLo;
  const lastSH = piv.sh.length ? piv.sh[piv.sh.length - 1].p : rangeHi;
  const lastSL = piv.sl.length ? piv.sl[piv.sl.length - 1].p : rangeLo;
  const levels: Record<string, number> = {
    support: f(Math.min(lastSL, rangeLo)), resistance: f(Math.max(lastSH, rangeHi)),
    liquidity_above: f(Math.max(prevDayHi, rangeHi)), liquidity_below: f(Math.min(prevDayLo, rangeLo)), equilibrium: f(eq),
  };

  // ── Strategy selection (regime-appropriate) → direction, entry, stop ──
  let strategy = "", dir: Dir | null = null, entry = px, stop = px, invalidation = "", entryQ = 40, structureQ = 40;
  let orderType: "market" | "limit" = "limit";
  if (regimeDir === "buy") {
    dir = "buy";
    const freshBreak = strongTrend && px >= lastSH && px <= lastSH + a1 * 0.8;
    if (freshBreak) { strategy = "Trend breakout (long)"; entry = f(px); orderType = "market"; stop = f(lastSH - a1 * 0.6); invalidation = `close back below the broken high (${f(lastSH)})`; structureQ = 82; entryQ = 74; }
    else { strategy = "Trend pullback (long)"; entry = f(Math.max(s20 ?? px - a1 * 0.5, px - a1 * 0.6)); orderType = entry < px ? "limit" : "market"; stop = f(Math.min(lastSL, entry - a1 * 1.0)); invalidation = `close below the last swing low / SMA20 (${f(lastSL)})`; structureQ = trendUp ? 78 : 60; entryQ = px > eq ? 55 : 72; }
  } else if (regimeDir === "sell") {
    dir = "sell";
    const freshBreak = strongTrend && px <= lastSL && px >= lastSL - a1 * 0.8;
    if (freshBreak) { strategy = "Trend breakout (short)"; entry = f(px); orderType = "market"; stop = f(lastSL + a1 * 0.6); invalidation = `close back above the broken low (${f(lastSL)})`; structureQ = 82; entryQ = 74; }
    else { strategy = "Trend pullback (short)"; entry = f(Math.min(s20 ?? px + a1 * 0.5, px + a1 * 0.6)); orderType = entry > px ? "limit" : "market"; stop = f(Math.max(lastSH, entry + a1 * 1.0)); invalidation = `close above the last swing high / SMA20 (${f(lastSH)})`; structureQ = trendDn ? 78 : 60; entryQ = px < eq ? 55 : 72; }
  } else if (regime.startsWith("Range")) {
    const nearHi = Math.abs(px - rangeHi) < Math.abs(px - rangeLo);
    if (nearHi && px >= rangeHi - a1 * 0.6) { strategy = "Range rejection (fade high)"; dir = "sell"; entry = f(px); orderType = "market"; stop = f(rangeHi + a1 * 0.8); invalidation = `close above the range high (${f(rangeHi)})`; structureQ = 62; entryQ = 66; }
    else if (!nearHi && px <= rangeLo + a1 * 0.6) { strategy = "Range rejection (fade low)"; dir = "buy"; entry = f(px); orderType = "market"; stop = f(rangeLo - a1 * 0.8); invalidation = `close below the range low (${f(rangeLo)})`; structureQ = 62; entryQ = 66; }
  }

  const trig = (over: Partial<Trigger>): Trigger => ({
    state: "NO_TRADE", asset: cfg.symbol, direction: dir === "buy" ? "BUY" : dir === "sell" ? "SELL" : null, strategy: strategy || "None",
    monitorTimeframe: "15min", triggerType: "AWAIT", triggerLevel: null, retestZoneLow: null, retestZoneHigh: null,
    confirmationRequired: "", invalidationLevel: dir ? f(stop) : null, expirationCondition: `15min close beyond ${dir ? f(stop) : "the invalidation level"}`,
    recheckInstruction: "", generatedAt: genAt, dataCandleClose: dataClose, ...over,
  });

  // No directional edge → WATCHLIST with levels (never a bare No-Trade).
  if (!dir) {
    const near = Math.abs(px - rangeHi) < Math.abs(px - rangeLo);
    const lvl = near ? levels.resistance : levels.support;
    return base({
      state: "WATCHLIST", headline: `WATCHLIST — ${regime}`, direction: null, strategy: "None (mid-structure)",
      current_bias: `Neutral / mid-range near ${f(px)} (equilibrium ${levels.equilibrium})`,
      reason: `${cfg.label} is in a "${regime}" state with price mid-structure. No strategy has a defined edge until price reaches a range extreme.`,
      trigger: trig({ state: "WATCHLIST", direction: null, monitorTimeframe: "1H", triggerType: "PRICE_REACHES_LEVEL", triggerLevel: lvl, confirmationRequired: `a rejection or sweep-and-reclaim at the ${near ? "range high" : "range low"} (${lvl})`, recheckInstruction: `Come back when price reaches the ${near ? "resistance/liquidity" : "support/liquidity"} at ${lvl} and shows a reaction there.` }),
      what_next: [`Wait for price to reach the ${near ? "resistance" : "support"} at ${lvl}.`, `Preferred: fade a rejection there back toward ${levels.equilibrium}.`, `Alternative: a decisive 1H close beyond ${lvl} flips to a breakout — reanalyze then.`, `Press Analyze again to recompute on fresh candles.`],
      levels, market_regime: regime, session, mtf: mtf.byTf,
      scores: { data_quality: 100, regime: regimeScore }, confidence: { data: 100, directional: 40, entry: 20, overall: 34 },
      candles: candleOut, reasoning: [], setup_zone: null, proximity: null, alternative_scenario: null, provisional_trade: null,
    });
  }

  // ── Targets: structural-or-omit ──
  const risk = Math.abs(entry - stop) || a1;
  const objSrc = dir === "buy"
    ? [rangeHi, prevDayHi, lastSH, ...piv.sh.map((s) => s.p)].filter((v) => v > entry + risk * 0.6)
    : [rangeLo, prevDayLo, lastSL, ...piv.sl.map((s) => s.p)].filter((v) => v < entry - risk * 0.6);
  const objs = Array.from(new Set(objSrc.map(f))).sort((x, y) => dir === "buy" ? x - y : y - x);
  const tpMeta: { price: number; structural: boolean }[] = [];
  const firstStruct = objs.find((v) => Math.abs(v - entry) >= risk * cfg.rrFloor);
  tpMeta.push(firstStruct != null ? { price: firstStruct, structural: true } : { price: f(dir === "buy" ? entry + risk * cfg.rrFloor : entry - risk * cfg.rrFloor), structural: false });
  for (const v of objs) { if (tpMeta.length >= 3) break; if (Math.abs(v - entry) > Math.abs(tpMeta[tpMeta.length - 1].price - entry) + risk * 0.4) tpMeta.push({ price: v, structural: true }); }
  const targets = tpMeta.map((t) => t.price);
  const rr1 = risk ? Math.abs(targets[0] - entry) / risk : 0;
  const stopAtr = risk / (a1 || 1);

  // Hard vetoes — genuine risk failures only.
  const hardVeto = (headline: string, reason: string, whatNext: string[], over: Partial<Trigger>): EngineResult => base({
    state: "NO_TRADE", headline, direction: dir, strategy, reason, trigger: trig({ state: "NO_TRADE", ...over }),
    what_next: whatNext, levels, market_regime: regime, session, mtf: mtf.byTf,
    scores: { data_quality: 100, regime: regimeScore }, confidence: { data: 100, directional: 45, entry: 20, overall: 30 },
    candles: candleOut, reasoning: [], setup_zone: null, proximity: null, alternative_scenario: null, provisional_trade: null,
    current_bias: `${dir === "buy" ? "Bullish" : "Bearish"} bias, but no valid entry`,
  });
  if (stopAtr > cfg.maxStopAtr) return hardVeto("NO TRADE — STOP TOO WIDE", `The only structural stop is ${stopAtr.toFixed(1)}× ATR (max ${cfg.maxStopAtr}×). Risk per unit is too large right now.`, [`Wait for a tighter ${dir === "buy" ? "higher-low" : "lower-high"} so the invalidation sits closer.`, `Reanalyze after that structure forms.`], { triggerType: "TIGHTER_STRUCTURE", recheckInstruction: `Come back after price forms a tighter ${dir === "buy" ? "higher-low" : "lower-high"}.` });
  if (stopAtr < cfg.minStopAtr) return hardVeto("NO TRADE — STOP TOO TIGHT", `The stop is only ${stopAtr.toFixed(2)}× ATR — normal noise would stop this out.`, [`Wait for a structure that supports a slightly wider, safer stop.`, `Reanalyze shortly.`], { triggerType: "VOLATILITY_NORMALIZE", recheckInstruction: `Come back once a valid stop is ≥ ${cfg.minStopAtr}× ATR away.` });
  if (!(rr1 > 0) || !Number.isFinite(rr1)) return hardVeto("NO TRADE — INVALID REWARD:RISK", `Could not resolve a valid reward-to-risk for ${cfg.label}.`, [`Press Analyze again to recompute.`], { triggerType: "RECOMPUTE", recheckInstruction: "Press Analyze again to recompute." });

  // ── Confirmation, entry status, obstacle, alignment (context only) ──
  const cs = confirmRead(R15, dir);
  const confirmed = cs.closedWithTrend && cs.momentumTurned;
  const wantDir = dir === "buy" ? "LONG" : "SHORT";
  const mtfAligned = regimeDir ? mtf.dir === wantDir : true;
  const chaseTol = a1 * 0.9;
  let entryStatus: "available" | "approaching" | "far";
  if (orderType === "market") entryStatus = "available";
  else if (dir === "buy") entryStatus = px <= entry + a1 * 0.05 ? "available" : (px - entry <= chaseTol ? "approaching" : "far");
  else entryStatus = px >= entry - a1 * 0.05 ? "available" : (entry - px <= chaseTol ? "approaching" : "far");
  const betw = dir === "buy"
    ? [rangeHi, prevDayHi, lastSH, ...piv.sh.map((s) => s.p)].filter((v) => v > entry + risk * 0.15 && v < targets[0] - risk * 0.1)
    : [rangeLo, prevDayLo, lastSL, ...piv.sl.map((s) => s.p)].filter((v) => v < entry - risk * 0.15 && v > targets[0] + risk * 0.1);
  const obstacle = betw.length ? f(dir === "buy" ? Math.min(...betw) : Math.max(...betw)) : null;

  // ── Single strategy-dominant score (0-100). Alignment is minor context. ──
  const rrScore = Math.min(100, Math.round((rr1 / 3) * 100));
  const momoRaw = rsi(closes1) ?? 50;
  const momoScore = dir === "buy" ? clampN(momoRaw, 40, 75) : clampN(100 - momoRaw, 40, 75);
  const volScore = atrPct >= 30 && atrPct <= 85 ? 75 : 45;
  const sessionScore = session === "Off-session" ? 45 : 72;
  const confirmScore = (cs.closedWithTrend ? 40 : 0) + (cs.momentumTurned ? 35 : 0) + (cs.pullbackComplete ? 25 : 0);
  const alignScore = mtfAligned ? 90 : (mtf.dir == null ? 75 : 40);
  const scores: Record<string, number> = {
    overall: 0, regime: regimeScore, structure: structureQ, entry: entryQ, risk_reward: rrScore,
    confirmation: confirmScore, alignment: alignScore, momentum: Math.round(momoScore),
    volatility: volScore, session: sessionScore, news: 65, data_quality: 100,
  };
  let overall = Math.round(
    scores.structure * 0.16 + scores.entry * 0.12 + scores.confirmation * 0.15 + scores.risk_reward * 0.15 +
    scores.regime * 0.12 + scores.momentum * 0.07 + scores.volatility * 0.05 + scores.session * 0.04 +
    scores.data_quality * 0.08 + scores.alignment * 0.03 + scores.news * 0.03,
  );
  if (obstacle != null) overall -= 6;
  overall = clampN(overall, 0, 100);
  scores.overall = overall;

  // ── Outstanding measurable triggers (alignment is NOT one of them) ──
  const zoneLowE = dir === "buy" ? f(entry - a1 * 0.15) : entry;
  const zoneHighE = dir === "buy" ? entry : f(entry + a1 * 0.15);
  const blockers: { key: string; short: string; trigger: Trigger }[] = [];
  if (!confirmed) blockers.push({ key: "confirmation", short: `a 15m close ${dir === "buy" ? "up" : "down"} through ${f(entry)} with momentum turning.`, trigger: trig({ state: "DEVELOPING_SETUP", monitorTimeframe: "15min", triggerType: dir === "buy" ? "CANDLE_CLOSE_ABOVE" : "CANDLE_CLOSE_BELOW", triggerLevel: f(entry), confirmationRequired: `a 15m candle closing ${dir === "buy" ? "back up through" : "back down through"} ${f(entry)} with momentum turning ${dir === "buy" ? "up" : "down"}`, recheckInstruction: `Come back after the next 15-minute candle closes ${dir === "buy" ? "above" : "below"} ${f(entry)}.` }) });
  if (entryStatus === "approaching" || entryStatus === "far") blockers.push({ key: "entry", short: `price retraces into the ${zoneLowE}–${zoneHighE} entry zone.`, trigger: trig({ state: "DEVELOPING_SETUP", monitorTimeframe: "15min", triggerType: "PRICE_TOUCH", triggerLevel: f(entry), retestZoneLow: zoneLowE, retestZoneHigh: zoneHighE, confirmationRequired: `price retraces into the ${zoneLowE}–${zoneHighE} entry zone`, recheckInstruction: `Come back if price ${dir === "buy" ? "pulls back down" : "rallies up"} into ${zoneLowE}–${zoneHighE}.` }) });
  if (obstacle != null) blockers.push({ key: "clearance", short: `price clears the opposing level at ${obstacle} before TP1.`, trigger: trig({ state: "DEVELOPING_SETUP", triggerType: "LEVEL_CLEAR", triggerLevel: obstacle, confirmationRequired: `price clears ${obstacle} (opposing structure before TP1)`, recheckInstruction: `Come back once price ${dir === "buy" ? "breaks and holds above" : "breaks and holds below"} ${obstacle}.` }) });
  if (rr1 < cfg.rrFloor) blockers.push({ key: "rr", short: `a deeper ${dir === "buy" ? "pullback" : "rally"} improves reward:risk (now ${rr1.toFixed(1)}R, need ${cfg.rrFloor}R).`, trigger: trig({ state: "DEVELOPING_SETUP", triggerType: "BETTER_LOCATION", triggerLevel: f(entry), confirmationRequired: `a deeper ${dir === "buy" ? "pullback" : "rally"} that puts entry ≥${cfg.rrFloor}R from ${targets[0]}`, recheckInstruction: `Come back on a deeper ${dir === "buy" ? "dip" : "bounce"} — nearest objective is only ${rr1.toFixed(1)}R (need ${cfg.rrFloor}R).` }) });

  let state: State;
  if (overall >= cfg.bands.ready && blockers.length === 0) state = "TRADE_READY";
  else if (overall >= cfg.bands.develop && blockers.length >= 1) state = "DEVELOPING_SETUP";
  else if (overall >= cfg.bands.watch) state = "WATCHLIST";
  else state = "NO_TRADE";

  const confBreak = {
    data: 100, directional: Math.round((scores.regime + scores.alignment) / 2),
    entry: Math.round((scores.entry + scores.confirmation) / 2),
    risk: Math.round((scores.risk_reward + Math.max(0, 100 - (stopAtr / cfg.maxStopAtr) * 100)) / 2), overall,
  };
  const takeProfits = tpMeta.map((t, i) => ({ label: `TP${i + 1}`, price: t.price, structural: t.structural, risk_reward: +(Math.abs(t.price - entry) / risk).toFixed(2), suggested_close_percent: i === 0 ? 50 : i === 1 ? 30 : 20 }));

  // Actionable Fib SETUP ZONE + proximity + alternative (for every state).
  const legHi = piv.sh.length ? piv.sh[piv.sh.length - 1].p : rangeHi;
  const legLo = piv.sl.length ? piv.sl[piv.sl.length - 1].p : rangeLo;
  const legRange = Math.abs(legHi - legLo) || a1;
  const fibA = dir === "buy" ? legHi - 0.618 * legRange : legLo + 0.618 * legRange;
  const fibB = dir === "buy" ? legHi - 0.786 * legRange : legLo + 0.786 * legRange;
  const zLow = f(Math.min(fibA, fibB)), zHigh = f(Math.max(fibA, fibB));
  const overlapLevel = dir === "buy" ? levels.support : levels.resistance;
  const setup_zone = {
    direction: dir === "buy" ? "BUY" : "SELL", setup_type: strategy, zone_low: zLow, zone_high: zHigh,
    zone_source: `61.8%–78.6% Fibonacci retracement of the last 1H ${dir === "buy" ? "up" : "down"}-impulse (${f(legLo)}→${f(legHi)})`,
    setup_timeframe: "1H context → 15m trigger",
    why: [`${dir === "buy" ? "Discount" : "Premium"} pullback into the 61.8–78.6% Fib zone`, `Overlaps ${dir === "buy" ? "support" : "resistance"} near ${overlapLevel}`, obstacle == null ? `Clean room toward ${targets[0]}` : `First objective ${targets[0]} (opposing level at ${obstacle} en route)`],
    what_price_must_do: [`Trade into ${zLow}–${zHigh}`, `Form a 5-minute ${dir === "buy" ? "bullish" : "bearish"} rejection in the zone`, `Close back ${dir === "buy" ? "above" : "below"} ${dir === "buy" ? zHigh : zLow}`, `Then print a ${dir === "buy" ? "higher high" : "lower low"} to confirm`],
    confirmation: `15m ${dir === "buy" ? "bullish" : "bearish"} rejection + close ${dir === "buy" ? "above" : "below"} ${dir === "buy" ? zHigh : zLow}`,
    invalidation: `A close ${dir === "buy" ? "below" : "above"} ${f(stop)}`, first_target: targets[0], second_target: targets[1] ?? null,
    cancels: `A decisive close ${dir === "buy" ? "below" : "above"} ${f(stop)}`,
  };
  const insideZone = px >= zLow && px <= zHigh;
  const distToZone = insideZone ? 0 : (px < zLow ? zLow - px : px - zHigh);
  const distAtr = a1 ? distToZone / a1 : 0;
  const proximityStatus = state === "TRADE_READY" ? "Trade Ready"
    : insideZone && confirmed ? "Confirmation Pending" : insideZone ? "Inside Setup Zone"
    : distAtr <= 1.5 ? "Approaching Setup Zone" : distAtr > 3 ? "Setup Too Far Away" : "Approaching Setup Zone";
  const proximity = { status: proximityStatus, current_price: f(px), zone_low: zLow, zone_high: zHigh, distance: +distToZone.toFixed(dec), distance_atr: +distAtr.toFixed(2), candles_away: +distAtr.toFixed(1), reachable_this_session: distAtr <= 4 && session !== "Off-session", note: `≈ ${distAtr.toFixed(2)}× ATR from the zone. Any time estimate is an estimate only, not a promise.` };
  const alternative_scenario = { direction: dir === "buy" ? "SELL" : "BUY", trigger: `A close ${dir === "buy" ? "below" : "above"} ${f(stop)} then a retest from the ${dir === "buy" ? "underside" : "topside"}`, activation_zone: `${f(stop)} area (broken ${dir === "buy" ? "support → resistance" : "resistance → support"})`, invalidates_current: `${dir === "buy" ? "Below" : "Above"} ${f(stop)} the ${wantDir} idea is cancelled` };
  const current_bias = `${dir === "buy" ? "Bullish" : "Bearish"} while ${dir === "buy" ? "above" : "below"} ${f(stop)}`;

  const diagnostics = { tool: "engine", asset: cfg.symbol, regime, session, mtf: mtf.label, scores, blockers: blockers.map((b) => b.key), entry_status: entryStatus, band: cfg.bands, state, strategy, rr1: +rr1.toFixed(2), mtf_aligned: mtfAligned };

  if (state === "TRADE_READY") {
    const confidence = overall >= 82 ? "High" : overall >= 74 ? "Medium" : "Qualified";
    const grade = overall >= 85 ? "A+" : overall >= 78 ? "A" : "B+";
    return base({
      state: "TRADE_READY", headline: `TRADE READY — ${strategy}`, direction: dir, order_type: orderType, current_bias,
      entry: { price: entry, zone_low: zoneLowE, zone_high: zoneHighE }, stop_loss: { price: f(stop), reason: invalidation },
      take_profits: takeProfits, market_regime: regime, session, mtf: mtf.byTf, mtf_label: mtf.label,
      grade, confidence, confidence_breakdown: confBreak, entry_status: entryStatus,
      trigger: trig({ state: "TRADE_READY", triggerType: "ENTRY_AVAILABLE", triggerLevel: entry, retestZoneLow: zoneLowE, retestZoneHigh: zoneHighE, confirmationRequired: "confirmed — entry is live", recheckInstruction: `Entry available now at ${entry}. Stop ${f(stop)}; TP1 ${targets[0]} (${rr1.toFixed(1)}R). Reanalyze if price moves first.` }),
      what_next: [`Entry available at ${entry}; stop ${f(stop)}; first target ${targets[0]} (${rr1.toFixed(1)}R).`, `Size to your risk % — never widen the stop.`, `Reanalyze if price runs before you enter.`],
      setup_zone, proximity, alternative_scenario, levels, scores, reason: `A ${strategy} qualifies now (score ${overall}/100). ${mtfAligned ? "The execution stack agrees." : mtf.dir == null ? "The higher timeframe is neutral — the setup stands on its own structure." : "The higher timeframe is opposed — a lower-confidence, location-based trade."}`,
      risk_warnings: [`Position sizing is your responsibility — risk a fixed % and confirm contract specs with your broker.`],
      candles: candleOut, reasoning: [], strategy, rr_tp1: +rr1.toFixed(2), diagnostics,
    });
  }

  // DEVELOPING / WATCHLIST / NO_TRADE
  const primary = blockers[0]?.trigger ?? trig({ state, recheckInstruction: "Press Analyze again to recompute on fresh candles." });
  primary.state = state;
  const provisional = { direction: dir, strategy, order_type: orderType, entry: { price: entry, zone_low: zoneLowE, zone_high: zoneHighE }, stop_loss: { price: f(stop), reason: invalidation }, take_profits: takeProfits, risk_reward_tp1: +rr1.toFixed(2), entry_status: entryStatus };
  const headlineMap: Record<string, string> = { DEVELOPING_SETUP: `DEVELOPING — ${strategy}`, WATCHLIST: `WATCHLIST — ${dir === "buy" ? "bullish" : "bearish"} bias`, NO_TRADE: `NO TRADE — ${regime}` };
  const whatNext = [
    ...(blockers.length ? blockers.map((b, i) => `${i === 0 ? "First: " : "Then: "}${b.short}`) : [`Watch ${levels.support} (support) and ${levels.resistance} (resistance).`]),
    `Invalidation: a close ${dir === "buy" ? "below" : "above"} ${f(stop)}.`, `Press Analyze again to recompute on fresh candles.`,
  ];
  const reason = state === "DEVELOPING_SETUP"
    ? `A ${dir === "buy" ? "long" : "short"} ${strategy} is forming (score ${overall}/100), but ${blockers.length} condition${blockers.length > 1 ? "s" : ""} must confirm — starting with: ${blockers[0].short}`
    : state === "WATCHLIST"
    ? `${cfg.label} has a ${dir === "buy" ? "bullish" : "bearish"} lean (score ${overall}/100) but price is too far from a valid entry. Watching ${setup_zone.zone_low}–${setup_zone.zone_high}.`
    : `${cfg.label} scored ${overall}/100 — below the ${cfg.bands.watch} watchlist floor. The lean is ${dir.toUpperCase()} but confluence is thin right now.`;
  return base({
    state, headline: headlineMap[state], direction: dir, current_bias, strategy, reason, trigger: primary, what_next: whatNext,
    levels, provisional_trade: state === "NO_TRADE" ? null : provisional, setup_zone, proximity, alternative_scenario,
    market_regime: regime, session, mtf: mtf.byTf, scores, confidence: confBreak,
    risk_warnings: [`Position sizing is your responsibility — risk a fixed % and confirm contract specs with your broker.`],
    candles: candleOut, reasoning: [], diagnostics,
  });
}
