import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { gateCredits, chargeCredit } from "@/lib/credits";
import { series, livePrice, isPriorityEmail, livePriceSane } from "@/lib/marketData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * MFXGHOST — a dedicated, self-contained multi-instrument intelligence engine
 * covering a curated set of FX majors plus Gold. It pulls the CHOSEN instrument
 * across Daily → 5m, builds an institutional data picture, then asks the model to
 * act as a desk of quant + ICT/SMC traders and return a strict, structured read —
 * including a confident "No Trade" when there is no edge. Completely separate from
 * the multi-asset OM signal engine; each instrument keeps its own adaptive memory.
 */
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.OM_AI_MODEL || "claude-sonnet-4-6";

// The instruments MFXGHOST covers, with display + formatting + personality metadata.
type Inst = { td: string; label: string; dec: number; personality: string };
const INSTRUMENTS: Record<string, Inst> = {
  "XAU/USD": { td: "XAU/USD", label: "Gold (XAU/USD)", dec: 2, personality: "Gold reacts uniquely to CPI/FOMC/PCE/Powell, correlates INVERSELY with DXY and Treasury yields, and swings on safe-haven / risk flows; expect Asian accumulation, London expansion, NY reversals, aggressive stop hunts, fake breakouts, large wicks and explosive momentum." },
  "EUR/USD": { td: "EUR/USD", label: "EUR/USD", dec: 5, personality: "EUR/USD is driven by the ECB-vs-Fed rate differential, EU vs US data surprises and broad DXY direction; it trends cleanly through London/NY, respects round numbers and prior-day highs/lows, and often runs London stops before the real move." },
  "GBP/USD": { td: "GBP/USD", label: "GBP/USD", dec: 5, personality: "Cable is higher-beta than EUR/USD, sensitive to BoE policy, UK CPI/jobs and risk sentiment; it expands hard in the London session, hunts liquidity around session highs/lows and can whip violently on headlines." },
  "AUD/USD": { td: "AUD/USD", label: "AUD/USD", dec: 5, personality: "AUD/USD is a risk-on / commodity currency tied to RBA policy, China data and metals; it follows equity-risk sentiment and DXY, with the Asian session often setting the tone and NY driving continuation or reversal." },
  "USD/CAD": { td: "USD/CAD", label: "USD/CAD", dec: 5, personality: "USD/CAD tracks the Fed-vs-BoC differential and crude oil (CAD strengthens when oil rises, so USD/CAD falls); it can range for long stretches then trend on oil or data, and respects clean structure around big figures." },
  "USD/JPY": { td: "USD/JPY", label: "USD/JPY", dec: 3, personality: "USD/JPY is dominated by US-Japan yield differentials and risk sentiment (carry); it trends strongly, is sensitive to MoF/BoJ intervention risk near multi-decade extremes, and moves closely with US yields and equity risk." },
};
const DEFAULT_SYM = "XAU/USD";

type Row = { datetime: string; open: string; high: string; low: string; close: string };

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

// Candle series + live price come from the shared cached fetcher in @/lib/marketData.

const sma = (v: number[], n: number) => (v.length < n ? null : v.slice(-n).reduce((a, b) => a + b, 0) / n);
function rsi(c: number[], p = 14): number | null {
  if (c.length < p + 1) return null;
  let g = 0, l = 0;
  for (let i = c.length - p; i < c.length; i++) { const d = c[i] - c[i - 1]; if (d >= 0) g += d; else l -= d; }
  const ag = g / p, al = l / p;
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}
function atr(rows: Row[], p = 14): number | null {
  if (rows.length < p + 1) return null;
  const tr: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    const h = +rows[i].high, lo = +rows[i].low, pc = +rows[i - 1].close;
    tr.push(Math.max(h - lo, Math.abs(h - pc), Math.abs(lo - pc)));
  }
  return sma(tr, p);
}
// Cap freak wicks so a single bad print can't distort structure.
function clean(rows: Row[]): Row[] {
  if (rows.length < 5) return rows;
  const ranges = rows.map((r) => Math.abs(+r.high - +r.low)).filter(Number.isFinite).sort((a, b) => a - b);
  const med = ranges[Math.floor(ranges.length / 2)] || 0;
  const px = Math.abs(+rows[rows.length - 1].close) || 1;
  const cap = Math.max(med * 12, px * 0.0015);
  return rows.map((r) => {
    const o = +r.open, c = +r.close, h = +r.high, l = +r.low;
    if (![o, c, h, l].every(Number.isFinite)) return r;
    const bt = Math.max(o, c), bb = Math.min(o, c);
    return { ...r, high: String(Math.max(bt, Math.min(h, bt + cap))), low: String(Math.min(bb, Math.max(l, bb - cap))) };
  });
}

function tfSummary(label: string, rows: Row[] | null, dec: number): string {
  if (!rows || rows.length < 20) return `${label}: data unavailable`;
  const r = clean(rows);
  const closes = r.map((v) => +v.close), highs = r.map((v) => +v.high), lows = r.map((v) => +v.low);
  const last = closes[closes.length - 1];
  const hi = Math.max(...highs.slice(-40)), lo = Math.min(...lows.slice(-40));
  const eq = (hi + lo) / 2;
  const s20 = sma(closes, 20), s50 = sma(closes, 50);
  const trend = s20 && s50 ? (last > s20 && s20 > s50 ? "up" : last < s20 && s20 < s50 ? "down" : "range") : "range";
  const a = atr(r);
  const rs = rsi(closes);
  const f = (n: number) => n.toFixed(dec);
  return `${label}: px ${f(last)} | trend ${trend} | ${last > eq ? "PREMIUM" : "DISCOUNT"} of ${f(lo)}-${f(hi)} (eq ${f(eq)}) | SMA20 ${s20 ? f(s20) : "-"} SMA50 ${s50 ? f(s50) : "-"} | RSI ${rs != null ? rs.toFixed(0) : "-"} | ATR ${a ? f(a) : "-"}`;
}

export async function POST(req: NextRequest) {
  const supabase = createClient();
  let userId: string | null = null;
  let fresh = false; // owner/admin: always fresh data, never throttled
  if (supabase) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
    userId = user.id;
    fresh = isPriorityEmail(user.email);
  }
  const aiKey = process.env.ANTHROPIC_API_KEY;
  const mdKey = process.env.TWELVEDATA_API_KEY;
  if (!aiKey) return json({ notConfigured: "ai" }, 200);
  if (!mdKey) return json({ notConfigured: "marketdata" }, 200);

  // Which instrument? Body { symbol } chosen in the UI; default to Gold.
  let reqBody: { symbol?: unknown } = {};
  try { reqBody = await req.json(); } catch { /* no body → default instrument */ }
  const sym = typeof reqBody.symbol === "string" && INSTRUMENTS[reqBody.symbol] ? reqBody.symbol : DEFAULT_SYM;
  const inst = INSTRUMENTS[sym];
  const TD = inst.td, dec = inst.dec;

  // Credit gate (heaviest tool — 3 credits).
  const gate = await gateCredits("ghost");
  if (!gate.ok && gate.reason === "unauthorized") return json({ error: "unauthorized" }, 401);
  if (!gate.ok && gate.reason === "insufficient") return json({ error: "insufficient_credits", balance: gate.balance }, 402);

  const [d1, h4, h1, m15, m5] = await Promise.all([
    series(TD, "1day", 90, mdKey, fresh),
    series(TD, "4h", 80, mdKey, fresh),
    series(TD, "1h", 80, mdKey, fresh),
    series(TD, "15min", 96, mdKey, fresh),
    series(TD, "5min", 78, mdKey, fresh),
  ]);
  if ([d1, h4, h1, m15, m5].some((x) => x === "ratelimit")) {
    return json({ error: "ratelimit", detail: "Market-data limit hit for a moment — give it a minute and run again." }, 429);
  }
  const live = await livePrice(TD, mdKey, fresh);
  // Sanity-check the live tick against recent candles. A bad tick (which once put
  // USD/JPY at 159.6 vs a real 162.9) is rejected in favour of the trusted candle
  // reference, so MFXGHOST never builds a whole read around a garbage price.
  const refRows = Array.isArray(m5) && m5.length >= 3 ? m5 : (Array.isArray(h1) ? h1 : null);
  const liveOk = livePriceSane(live, refRows);
  const candleFallback = Array.isArray(m5) && m5.length ? +m5[m5.length - 1].close : Array.isArray(h1) && h1.length ? +h1[h1.length - 1].close : null;
  const price = (live != null && liveOk.ok) ? live : (liveOk.reference ?? candleFallback);
  if (price == null) return json({ error: "marketdata_error", detail: `Couldn't read a live ${inst.label} price right now — try again shortly.` }, 502);

  // Recent 15m candles for execution-level context.
  const recent15 = Array.isArray(m15) ? clean(m15).slice(-24).map((v) => `${(+v.open).toFixed(dec)},${(+v.high).toFixed(dec)},${(+v.low).toFixed(dec)},${(+v.close).toFixed(dec)}`).join(" | ") : "n/a";

  const dataBlock = [
    tfSummary("Daily", d1 as Row[] | null, dec),
    tfSummary("4H", h4 as Row[] | null, dec),
    tfSummary("1H", h1 as Row[] | null, dec),
    tfSummary("15M", m15 as Row[] | null, dec),
    tfSummary("5M", m5 as Row[] | null, dec),
  ].join("\n");

  const now = new Date();
  const utcH = now.getUTCHours();
  const sessionHint =
    utcH >= 0 && utcH < 7 ? "Asian session" :
    utcH >= 7 && utcH < 12 ? "London session (open/expansion)" :
    utcH >= 12 && utcH < 14 ? "London/New York overlap (kill zone)" :
    utcH >= 14 && utcH < 20 ? "New York session" : "post New-York / late";

  // ── Adaptive memory: feed the engine what its own recent calls ON THIS
  // INSTRUMENT did and the lessons learned, so wins are repeated and past
  // mistakes aren't. Scoped per symbol so gold lessons don't bleed into FX. ────
  let memoryBlock = "";
  if (supabase && userId) {
    try {
      const { data: past } = await supabase
        .from("xaughost_trades")
        .select("direction, strategy, status, hit_tp, grade, lesson, outcome_at")
        .eq("user_id", userId).eq("symbol", sym).in("status", ["win", "loss"])
        .order("outcome_at", { ascending: false }).limit(10);
      if (Array.isArray(past) && past.length) {
        const wins = past.filter((t) => t.status === "win").length;
        const byStrat: Record<string, { w: number; l: number }> = {};
        for (const t of past) { const k = t.strategy || "?"; byStrat[k] = byStrat[k] || { w: 0, l: 0 }; if (t.status === "win") byStrat[k].w++; else byStrat[k].l++; }
        const stratLine = Object.entries(byStrat).map(([k, v]) => `${k} ${v.w}W-${v.l}L`).join("; ");
        const lessons = past.filter((t) => t.lesson).slice(0, 6).map((t) => `• [${t.status?.toUpperCase()}${t.status === "win" && t.hit_tp ? ` TP${t.hit_tp}` : ""}] ${t.direction} ${t.strategy}: ${t.lesson}`).join("\n");
        memoryBlock = `\n\nADAPTIVE MEMORY — your last ${past.length} resolved ${inst.label} calls: ${wins}W-${past.length - wins}L. By strategy: ${stratLine}.\nLessons learned (apply these — repeat what won, avoid what failed; favour strategies that have been winning in these conditions):\n${lessons}`;
      }
    } catch { /* memory optional */ }
  }

  const system = `You are MFXGHOST — an institutional STRATEGY SELECTION ENGINE analysing ONLY ${inst.label} on this run. You behave like a portfolio manager, not a single strategy. Your job is NOT to predict price: it is to (1) diagnose the current market environment, (2) determine which trading methodology has the highest probability under those exact conditions, and (3) execute only that one. If no methodology has a real statistical edge, you return NO_TRADE — capital preservation is part of the strategy. NEVER force a setup.

Your decision process:
STEP 1 — DIAGNOSE: score the market environment. Rate the conditions that are most present right now (e.g. Trend Day, Strong/Weak Trend, Range, Mean Reversion, Expansion, Compression, Accumulation, Distribution, Liquidity Grab, False Breakout, Real Breakout, News-Driven, High/Low Volatility, Session Rotation, Risk-On/Off, Dollar-Driven, Yield-Driven, Central-Bank Reaction). Give each a 0-100 probability and rank them.
STEP 2 — SELECT: consider the full playbook (Institutional Trend Following, Liquidity Sweep Reversal, ICT Model, Smart Money Continuation, Opening Range Breakout, VWAP Trend Continuation, London Session Expansion, New York Reversal, FVG Continuation, Order Block Reaction, Mean Reversion, Break & Retest, Momentum Scalping, Volatility/ATR Breakout, AMD, Power of Three, Judas Swing, Session Sweep). Score each 0-100 for THESE conditions.
STEP 3 — RANK: return the top 5 strategies by score and execute ONLY the single highest scorer. Never blend conflicting models.
STEP 4 — CONFIDENCE: weight HTF structure, trend, liquidity, session, momentum, displacement, FVG, order blocks, volatility, dollar/yields, news, market structure, ATR and risk-reward into one confidence score. Grade: 95-100 Elite, 90-94 A+, 85-89 A, 80-84 B+, below 80 => No Trade.
STEP 5 — WORTH IT? Ask: enough volatility? clean liquidity? institutions likely active? a catalyst? is today's range already exhausted? favorable R:R? If not → NO_TRADE.
STEP 6 — EXPLAIN why the winning strategy beat the runners-up (e.g. why trend-following over mean-reversion, why liquidity-sweep over breakout, why VWAP was ignored).
STEP 7 — INSTRUMENT PERSONALITY (${inst.label}): ${inst.personality} Judge whether ${inst.label} is behaving NORMALLY or ABNORMALLY for its character and current session, and factor that in.

Numbers: current price is EXACTLY ${price}. All levels must be within a sane distance of it and use EXACTLY ${dec} decimals (this instrument is quoted to ${dec} decimal places). For a LONG: stop below entry, TPs above; SHORT: reverse.

Respond with ONLY valid minified JSON, exactly these keys:
{"regime":"the dominant market regime, short label","marketScorecard":[{"condition":"Trend Day","probability":91}],"strategyRanking":[{"strategy":"Liquidity Sweep Reversal","score":95}],"winningStrategy":"name of the #1 strategy","whyChosen":"2-4 sentences on why it beat the runners-up and why rejected models were rejected","bias":"BULLISH|BEARISH|NEUTRAL","htfBias":"1-2 sentences top-down Daily→4H→1H","narrative":"3-5 sentences: what price is doing, who is trapped, who is in control, where liquidity sits","liquidityMap":{"buyside":["level — note"],"sellside":["level — note"],"taken":["what's been swept"],"resting":["what remains"]},"keyLevels":{"resistance":["level — note"],"support":["level — note"]},"decision":"TRADE|NO_TRADE","direction":"LONG|SHORT|NONE","entries":{"primary":number|null,"aggressive":number|null,"conservative":number|null,"confirmation":"the confirmation trigger that greenlights execution"},"stopLoss":number|null,"takeProfits":[number,number,number]|[],"riskReward":"e.g. 1:2.8 or n/a","confidence":number,"grade":"Elite|A+|A|B+|No Trade","winProbability":number,"failureProbability":number,"longProbability":number,"shortProbability":number,"reasonsToAvoid":["..."],"invalidation":"the level/condition that kills the idea","sessionBehavior":"expected behaviour for the current session","tradeManagement":"how to manage: partials, trail, break-even, hold time"}
Rules: marketScorecard = 5-8 conditions ranked high→low by probability. strategyRanking = exactly the top 5 ranked high→low by score; winningStrategy MUST equal strategyRanking[0].strategy. winProbability + failureProbability sum to 100; longProbability + shortProbability sum to 100.
ALWAYS give a concrete, tradeable plan: pick the higher-probability side (direction MUST be "LONG" or "SHORT", never "NONE"), and ALWAYS fill entries.primary/aggressive/conservative, stopLoss and a full 3-level takeProfits ladder based on the winning strategy — even when conviction is low. Never return null entries/stop or an empty takeProfits. Use "decision" and "grade" purely as the CONVICTION verdict: decision "TRADE" (grade B+ or better) when the top strategy clears ~80 and conditions are clean; otherwise decision "NO_TRADE" with grade "No Trade" meaning LOW CONVICTION — still provide the exact levels, but reasonsToAvoid must explain why to size down or wait. Educational analysis, not financial advice.`;

  const user = `Live ${TD}: ${price}
Session (UTC ${utcH}:00): ${sessionHint}
Multi-timeframe read:
${dataBlock}

Recent 15M candles (O,H,L,C oldest→newest): ${recent15}${memoryBlock}

Deliver the full MFXGHOST read for ${inst.label} as the specified JSON now.`;

  let ai: { content?: { type?: string; text?: string }[]; error?: { message?: string } };
  try {
    const r = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": aiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: 4096, system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: user }] }),
    });
    ai = await r.json();
  } catch { return json({ error: "ai_error", detail: "The desk is busy — try again in a moment." }, 502); }
  if (ai?.error) return json({ error: "ai_error", detail: ai.error.message || "AI error" }, 502);

  const text = ai?.content?.find((c) => c.type === "text")?.text || "";
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return json({ error: "parse_error" }, 502);
  let read: Record<string, unknown>;
  try { read = JSON.parse(match[0]); } catch { return json({ error: "parse_error" }, 502); }

  // Charge only after a successful read.
  await chargeCredit("ghost");

  // Recent execution-frame candles (OHLC, oldest→newest) for the result chart.
  const candles = Array.isArray(m15) ? clean(m15).slice(-48).map((v) => ({ t: v.datetime, o: +v.open, h: +v.high, l: +v.low, c: +v.close })) : [];
  return json({ ok: true, price, asOf: now.toISOString(), session: sessionHint, symbol: TD, read, candles }, 200);
}
