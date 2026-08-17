import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { gateCredits, chargeCredit } from "@/lib/credits";
import { series, livePrice, livePriceSane, isPriorityEmail } from "@/lib/marketData";
import { runEngine, type EngineCfg } from "@/lib/omEngine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GENX — flagship XAUUSD / Gold decision engine.
 *
 * Layers (spec §6): 1 market data → 2 quantitative analysis → 3 AI reasoning
 * (narrative only) → 4 decision → 5 the front-end draws the projection.
 *
 * Every price, level, stop, target, pip and score is computed in code by the
 * shared deterministic engine (runEngine). The AI writes ONLY the "market story"
 * and can never invent or move a number (spec §2, §40, §45).
 *
 * The three modes reuse the SAME proven engine via timeframe remapping: faster
 * candles are fed into the engine's trigger/context slots for QUICK, slower for
 * SWING. This gives each mode a genuine horizon without forking the engine.
 */

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.OM_AI_MODEL || "claude-sonnet-4-6";
const ENGINE_VERSION = "genx-1.0";
const PROMPT_VERSION = "genx-story-1.0";

const GOLD_PERSONALITY =
  "Gold (XAU/USD) has wide volatility, aggressive stop-hunts, large wicks and fake breakouts; Asian accumulation, London expansion, New York reversals. It reacts to USD macro (Fed/FOMC, CPI/PCE, NFP), Treasury yields and safe-haven flows.";

type Mode = "quick" | "intraday" | "swing";
type ModeCfg = {
  eng: Omit<EngineCfg, "symbol" | "label" | "cat" | "pip" | "dec">;
  tf: { d1: string; h4: string; h1: string; m30: string; m15: string; m5: string };
  hold: [number, number]; // expected hold in minutes [low, high]
  triggerTf: string; contextTf: string;
};

// Gold base — pip 0.1, 2 decimals (spec §5 pip normalization).
const GOLD = { symbol: "XAU/USD", label: "Gold (XAU/USD)", cat: "gold" as const, pip: 0.1, dec: 2 };

const MODES: Record<Mode, ModeCfg> = {
  // QUICK — the heart of GENX (spec §3). 30–80 pip target, 50–100 pip max stop.
  // Engine trigger slot fed 5min, confirm 1min, context 15min/1h.
  quick: {
    eng: { minStopAtr: 0.4, maxStopAtr: 1.6, rrFloor: 1.5, bands: { ready: 74, develop: 62, watch: 52 } },
    tf: { d1: "1h", h4: "30min", h1: "15min", m30: "15min", m15: "5min", m5: "1min" },
    hold: [20, 90], triggerTf: "5-minute", contextTf: "15-minute / 1-hour",
  },
  // INTRADAY (spec §24) — 15m trigger, 1h/4h context, 2–6h holds.
  intraday: {
    eng: { minStopAtr: 0.6, maxStopAtr: 2.6, rrFloor: 1.8, bands: { ready: 76, develop: 64, watch: 54 } },
    tf: { d1: "1day", h4: "4h", h1: "1h", m30: "30min", m15: "15min", m5: "5min" },
    hold: [120, 360], triggerTf: "15-minute", contextTf: "1-hour / 4-hour",
  },
  // SWING (spec §25) — 1h trigger, 4h/day context, hours to days.
  swing: {
    eng: { minStopAtr: 1.0, maxStopAtr: 3.5, rrFloor: 2.0, bands: { ready: 78, develop: 66, watch: 56 } },
    tf: { d1: "1week", h4: "1day", h1: "4h", m30: "4h", m15: "1h", m5: "1h" },
    hold: [240, 2880], triggerTf: "1-hour", contextTf: "4-hour / daily",
  },
};

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
type Row = { datetime: string; open: string; high: string; low: string; close: string; volume?: string };
const arr = (x: unknown): Row[] | null => (Array.isArray(x) ? (x as Row[]) : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function londonHour(d: Date): number {
  try { const s = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", hour12: false }).format(d); const h = parseInt(s, 10); return Number.isFinite(h) ? (h === 24 ? 0 : h) : d.getUTCHours(); } catch { return d.getUTCHours(); }
}
function nyHour(d: Date): number {
  try { const s = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false }).format(d); const h = parseInt(s, 10); return Number.isFinite(h) ? (h === 24 ? 0 : h) : d.getUTCHours() - 5; } catch { return d.getUTCHours() - 5; }
}
function sessionNow(d: Date): string {
  const lh = londonHour(d), nh = nyHour(d);
  const londonOpen = lh >= 7 && lh < 16, nyOpen = nh >= 8 && nh < 17;
  if (londonOpen && nyOpen) return "London/NY overlap";
  if (londonOpen) return "London"; if (nyOpen) return "New York";
  if (lh >= 0 && lh < 7) return "Asian"; return "Off-session";
}

// Volatility bucket from the trigger-frame ATR relative to price.
function volBucket(rows: Row[] | null, price: number): { label: string; atr: number | null } {
  if (!rows || rows.length < 15 || !price) return { label: "Normal", atr: null };
  const tr: number[] = [];
  for (let i = 1; i < rows.length; i++) { const h = +rows[i].high, l = +rows[i].low, pc = +rows[i - 1].close; tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc))); }
  const atr = tr.slice(-14).reduce((a, b) => a + b, 0) / 14;
  const pct = atr / price;
  const label = pct >= 0.0018 ? "High" : pct <= 0.0007 ? "Low" : "Normal";
  return { label, atr };
}

export async function POST(req: NextRequest) {
  // ── Auth ──
  const supabase = createClient();
  let fresh = false; let userId: string | null = null; let userEmail: string | null = null;
  if (supabase) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
    userId = user.id; userEmail = user.email ?? null;
    fresh = isPriorityEmail(user.email);
  }
  const aiKey = process.env.ANTHROPIC_API_KEY;
  const mdKey = process.env.TWELVEDATA_API_KEY;
  if (!mdKey) return json({ notConfigured: "marketdata" }, 200);

  // ── Mode ──
  let body: { mode?: unknown } = {};
  try { body = await req.json(); } catch { /* default quick */ }
  const mode: Mode = body.mode === "intraday" || body.mode === "swing" ? body.mode : "quick";
  const m = MODES[mode];
  const cfg: EngineCfg = { ...GOLD, ...m.eng };
  const TD = GOLD.symbol;

  // ── Credits (gate before spending data) ──
  const gate = await gateCredits("genx");
  if (!gate.ok && gate.reason === "unauthorized") return json({ error: "unauthorized" }, 401);
  if (!gate.ok && gate.reason === "insufficient") return json({ error: "insufficient_credits", balance: gate.balance }, 402);

  // ── Layer 1: market data (mode-mapped timeframes) ──
  const [d1, h4, h1, m30, m15, m5] = await Promise.all([
    series(TD, m.tf.d1, 90, mdKey, fresh),
    series(TD, m.tf.h4, 90, mdKey, fresh),
    series(TD, m.tf.h1, 120, mdKey, fresh),
    series(TD, m.tf.m30, 120, mdKey, fresh),
    series(TD, m.tf.m15, 150, mdKey, fresh),
    series(TD, m.tf.m5, 150, mdKey, fresh),
  ]);
  if ([d1, h4, h1, m30, m15, m5].some((x) => x === "ratelimit")) {
    return json({ error: "ratelimit", detail: "Gold market-data limit hit for a moment — give it a minute and run again." }, 429);
  }
  if (!arr(m15) || arr(m15)!.length < 20) {
    return json({ error: "insufficient_data", detail: "Not enough recent Gold candles to analyze right now — try again shortly." }, 200);
  }

  // ── Live price + STALE detection (spec §37 — never pretend live) ──
  const live = await livePrice(TD, mdKey, fresh);
  const refRows = arr(m5) && arr(m5)!.length >= 3 ? arr(m5) : arr(m15);
  const liveOk = livePriceSane(live, refRows as never);
  const fallback = arr(m5)?.length ? +arr(m5)![arr(m5)!.length - 1].close : arr(m15)?.length ? +arr(m15)![arr(m15)!.length - 1].close : null;
  const price = (live != null && liveOk.ok) ? live : (liveOk.reference ?? fallback);
  if (price == null) return json({ error: "marketdata_error", detail: "Couldn't read a live Gold price right now — try again shortly." }, 502);
  const dataStatus = (live != null && liveOk.ok) ? "live" : "reference";

  const now = new Date();
  const nowMs = now.getTime();
  const session = sessionNow(now);

  // ── Layer 2 + 4: deterministic engine owns every number ──
  const read = runEngine(cfg, { d1: arr(d1), h4: arr(h4), h1: arr(h1), m30: arr(m30), m15: arr(m15), m5: arr(m5), price, nowMs, session }) as Record<string, unknown>;

  // ── Layer 3: AI writes the MARKET STORY only (numbers locked) ──
  let marketStory: string[] = [];
  if (aiKey && read.state !== "INSUFFICIENT_DATA" && read.state !== "DATA_UNAVAILABLE") {
    try {
      const sys = `You are GENX, an elite XAUUSD (Gold) desk narrator. You are handed a FINAL, LOCKED analysis object a deterministic engine already produced. Your ONLY job: write "WHAT GOLD IS DOING RIGHT NOW" as 3–6 short, plain-English sentences a beginner understands. You MUST NOT change, recompute, invent or add any number, price, level, score, direction or target. Never claim to have checked news. Describe: what Gold has been doing, what it is doing now, whether buyers or sellers have the edge, how much room there is before the next level, and the most likely next move. Gold character: ${GOLD_PERSONALITY}. Educational only — no guarantees. Return ONLY a JSON array of strings.`;
      const r = await fetch(ANTHROPIC_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": aiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: MODEL, max_tokens: 500, system: sys, messages: [{ role: "user", content: `LOCKED ANALYSIS JSON:\n${JSON.stringify(read)}\n\nReturn the JSON array of sentences now.` }] }),
      });
      const j = await r.json();
      const rawTxt = Array.isArray(j?.content) ? j.content.filter((b: { type?: string }) => b?.type === "text").map((b: { text?: string }) => b.text ?? "").join("") : "";
      const mm = rawTxt.match(/\[[\s\S]*\]/);
      if (mm) { const a = JSON.parse(mm[0]); if (Array.isArray(a)) marketStory = a.map(String).slice(0, 6); }
    } catch { /* fall back to engine reason below */ }
  }
  if (!marketStory.length) {
    marketStory = [String(read.reason ?? ""), String(read.headline ?? "")].filter(Boolean);
  }

  // ── Decision mapping → GENX result (all numbers from the engine) ──
  const vol = volBucket(arr(m15), price);
  const genx = mapGenx(read, { mode, price, session, dataStatus, hold: m.hold, triggerTf: m.triggerTf, contextTf: m.contextTf, pip: GOLD.pip, dec: GOLD.dec, marketStory, volatility: vol.label, atr: vol.atr });

  // Charge only when GENX produces an actionable read (spec: watchlist/no-data free-ish).
  const chargeable = read.state === "TRADE_READY" || read.state === "DEVELOPING_SETUP" || read.state === "WATCHLIST";
  if (chargeable) await chargeCredit("genx");

  // ── Immutable signal recording (spec §27). Non-blocking. ──
  let signalId: string | null = null;
  try {
    const admin = createAdminClient();
    if (admin) {
      const rec = {
        user_id: userId,
        symbol: TD,
        mode,
        action: genx.action,
        direction: genx.directional_bias,
        entry: genx.entry, entry_low: genx.entry_low, entry_high: genx.entry_high,
        stop_loss: genx.stop_loss, tp1: genx.tp1, tp2: genx.tp2, tp3: genx.tp3,
        stop_pips: genx.stop_pips, tp1_pips: genx.tp1_pips, tp2_pips: genx.tp2_pips, tp3_pips: genx.tp3_pips,
        confidence: genx.confidence_score,
        market_regime: genx.market_regime,
        market_structure: genx.market_structure,
        momentum: genx.momentum,
        closest_support: genx.closest_support,
        closest_resistance: genx.closest_resistance,
        setup_type: genx.setup_type,
        status: genx.lifecycle,
        reasoning: genx,
        market_snapshot: { price, session, data_status: dataStatus, asOf: now.toISOString(), candles_tf: m.tf.m15 },
        model_version: MODEL, prompt_version: PROMPT_VERSION, engine_version: ENGINE_VERSION,
      };
      const { data, error } = await admin.from("genx_signals").insert(rec).select("id").single();
      if (!error && data) signalId = (data as { id: string }).id;
    }
  } catch { /* recording is best-effort; never block the read */ }

  return json({
    ok: true, signal_id: signalId, asOf: now.toISOString(), session, symbol: TD, mode,
    price, data_status: dataStatus, engine_version: ENGINE_VERSION,
    genx, candles: (read.candles as unknown[]) ?? [],
    // Full locked engine object for the admin post-trade review / audit trail.
    engine: read,
  }, 200);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function mapGenx(read: Record<string, unknown>, ctx: { mode: Mode; price: number; session: string; dataStatus: string; hold: [number, number]; triggerTf: string; contextTf: string; pip: number; dec: number; marketStory: string[]; volatility: string; atr: number | null }) {
  const r = read as any;
  const { pip, dec, price } = ctx;
  const pips = (a: number | null, b: number | null): number | null => (num(a) != null && num(b) != null ? Math.round(Math.abs((a as number) - (b as number)) / pip) : null);
  const round = (n: number | null) => (num(n) != null ? +(n as number).toFixed(dec) : null);

  const engineDir: "buy" | "sell" | null = r.direction === "buy" ? "buy" : r.direction === "sell" ? "sell" : null;
  const state: string = String(r.state ?? "NO_TRADE");

  const eObj = r.entry ?? r.provisional_trade?.entry ?? {};
  const slObj = r.stop_loss ?? r.provisional_trade?.stop_loss ?? {};
  const tpsRaw: any[] = (r.take_profits ?? r.provisional_trade?.take_profits ?? []) as any[];
  let entry = round(eObj.price ?? null);
  let entryLow = round(eObj.zone_low ?? null);
  let entryHigh = round(eObj.zone_high ?? null);
  let stop = round(slObj.price ?? null);
  let tp1 = round(tpsRaw[0]?.price ?? null);
  let tp2 = round(tpsRaw[1]?.price ?? null);
  let tp3 = round(tpsRaw[2]?.price ?? null);

  const levels = r.levels ?? {};
  const support = round(levels.support ?? null);
  const resistance = round(levels.resistance ?? null);
  const scores = r.scores ?? {};
  let confidence = num(r.confidence_breakdown?.overall) ?? num(scores.overall) ?? 0;

  const proxStatus = String(r.proximity?.status ?? "");
  const insideZone = /Inside Setup Zone|Confirmation Pending|Trade Ready/i.test(proxStatus);

  // ── GENX always forms a directional thesis (spec §2/§19/§20). When the engine
  //    is flat or has a lean but no executable plan, synthesize a LOCATION play
  //    from the REAL support/resistance levels — buy near support / sell near
  //    resistance — so GENX is never "neutral / no plan". ──
  let dir: "buy" | "sell" = engineDir ?? "buy";
  let synth = false;
  if (!engineDir || entry == null || stop == null) {
    if (support != null && resistance != null && resistance > support) {
      const mid = round((support + resistance) / 2)!;
      if (!engineDir) dir = ctx.price <= mid ? "buy" : "sell";
      const range = resistance - support;
      const buf = Math.max((ctx.atr ?? 0) * 0.4, range * 0.15, pip * 15);
      if (dir === "buy") { entry = support; entryLow = round(support - pip * 5); entryHigh = round(support + pip * 8); stop = round(support - buf); tp1 = mid; tp2 = resistance; tp3 = null; }
      else { entry = resistance; entryLow = round(resistance - pip * 8); entryHigh = round(resistance + pip * 5); stop = round(resistance + buf); tp1 = mid; tp2 = support; tp3 = null; }
      synth = true;
      // A location play in a thin market is a low-conviction WAIT — floor the score honestly.
      confidence = Math.max(45, Math.min(58, confidence || 45));
    }
  }
  const bias = dir === "buy" ? "bullish" : "bearish";

  // ── Action type (spec §20). Never a bare "no trade"; a WAIT still carries a plan. ──
  let action: string;
  let lifecycle: string;
  if (state === "TRADE_READY" && !synth) {
    action = dir === "buy" ? "BUY_NOW" : "SELL_NOW";
    lifecycle = "active";
  } else if ((state === "DEVELOPING_SETUP" || state === "WATCHLIST") && engineDir && !synth) {
    action = dir === "buy" ? "BUY_LIMIT" : "SELL_LIMIT";
    lifecycle = "waiting_for_entry";
  } else {
    action = dir === "buy" ? "WAIT_FOR_BUY_TRIGGER" : "WAIT_FOR_SELL_TRIGGER";
    lifecycle = "waiting_for_trigger";
  }

  // Momentum + structure + regime, in simple terms.
  const dirScore = num(scores.directional) ?? confidence;
  const momentum = dirScore >= 72 ? "Strong" : dirScore >= 55 ? "Moderate" : "Weak";
  const regime = String(r.market_regime ?? "");
  const structure = synth ? "Range" : (/bull/i.test(regime) ? "Bullish" : /bear/i.test(regime) ? "Bearish" : /range|chop|consol/i.test(regime) ? "Range" : (bias === "bullish" ? "Bullish" : "Bearish"));

  // Buyer/seller dominance — a relative GENX score, NOT a win probability (spec §23).
  const lean = dir === "buy" ? 1 : dir === "sell" ? -1 : 0;
  const edge = Math.round(Math.max(0, Math.min(40, (confidence - 50) * 0.8)));
  const buyers = lean === 1 ? 50 + edge : lean === -1 ? 50 - edge : 50;
  const sellers = 100 - buyers;
  const bullCase = dir === "buy" ? confidence : Math.max(0, 100 - confidence - 10);
  const bearCase = dir === "sell" ? confidence : Math.max(0, 100 - confidence - 10);

  // Room to target (spec §8 — how much room does the trade actually have).
  const nextObstacle = dir === "buy" ? resistance : support;
  const roomPips = pips(entry ?? price, nextObstacle);

  // ── WHY GENX LIKES IT (3–5 short bullets, from computed facts) ──
  const why: string[] = synth ? [dir === "buy" ? "Range-bound — buy the support hold toward resistance." : "Range-bound — sell the resistance rejection toward support."] : [];
  if (regime) why.push(`Market regime: ${regime}.`);
  why.push(`${structure} structure with ${momentum.toLowerCase()} momentum.`);
  if (entry != null && stop != null) why.push(`Stop sits behind structure at ${stop} (${pips(entry, stop)} pips risk).`);
  if (tp1 != null && entry != null) why.push(`First target ${tp1} = ${pips(entry, tp1)} pips (${tpsRaw[0]?.risk_reward ?? "?"}R).`);
  if (roomPips != null) why.push(`~${roomPips} pips of room before the next ${dir === "buy" ? "resistance" : "support"}.`);
  const trade_reasoning = why.slice(0, 5);

  // Risk factors (what could go wrong / what must happen).
  const risk_factors: string[] = [];
  const whatNext = Array.isArray(r.what_next) ? r.what_next.map(String) : [];
  if (proxStatus) risk_factors.push(`Location: ${proxStatus}.`);
  if (!insideZone && action.includes("LIMIT")) risk_factors.push(`Do not chase — wait for the pullback into the entry zone.`);
  whatNext.slice(0, 2).forEach((w: string) => risk_factors.push(w));

  const trigger_condition = synth ? ("Wait for price to reach " + entry + " (" + (dir === "buy" ? "support" : "resistance") + ") and show a " + (dir === "buy" ? "bullish" : "bearish") + " reaction, then enter " + (dir === "buy" ? "BUY" : "SELL") + ". Invalid on a close beyond " + stop + ".") : String(r.trigger?.recheckInstruction ?? r.setup_zone?.confirmation ?? "");
  const invalidation_reason = String(slObj.reason ?? r.setup_zone?.invalidation ?? (stop != null ? `A decisive close beyond ${stop}.` : ""));

  // ── Projected path for the visual (spec §22). Primary = to targets;
  //    a needed pullback shows Now → Entry first; invalidation = the stop. ──
  const needsPullback = action.includes("LIMIT") || action.includes("WAIT");
  const path: { label: string; price: number | null; kind: string }[] = [{ label: "Now", price: round(price), kind: "now" }];
  if (needsPullback && entry != null) path.push({ label: "Entry", price: entry, kind: "entry" });
  if (tp1 != null) path.push({ label: "TP1", price: tp1, kind: "target" });
  if (tp2 != null) path.push({ label: "TP2", price: tp2, kind: "target" });
  if (tp3 != null) path.push({ label: "TP3", price: tp3, kind: "target" });

  // ── "Enter now at market" (spec: actionable NOW). GENX's best entry — the
  //    value/pullback level that drives its accuracy — is left UNTOUCHED. This
  //    only computes the honest reward:risk of taking the SAME trade (same stop,
  //    same targets) immediately at the current price, so the member can act now
  //    instead of waiting for a pullback that may not come. It never moves the
  //    engine's decision; if entering now has no room, it says so plainly. ──
  let market_now: {
    price: number | null; risk_pips: number | null; target: number | null; target_pips: number | null;
    rr: number | null; final_target: number | null; final_rr: number | null; ok: boolean; note: string;
  } | null = null;
  {
    const now = round(price);
    const st = stop;
    const stopOnSide = st != null && now != null && (dir === "buy" ? st < now : st > now);
    const ahead = [tp1, tp2, tp3].filter((t): t is number => t != null && (dir === "buy" ? t > (now as number) + pip * 2 : t < (now as number) - pip * 2));
    if (now != null && stopOnSide && ahead.length) {
      const riskPrice = Math.abs(now - (st as number));
      const first = ahead[0], last = ahead[ahead.length - 1];
      const rr = riskPrice ? +(Math.abs(first - now) / riskPrice).toFixed(2) : null;
      const finalRr = riskPrice ? +(Math.abs(last - now) / riskPrice).toFixed(2) : null;
      const fr = finalRr ?? 0;
      const note = fr >= 2 ? "Solid room from here." : fr >= 1.2 ? "Workable — a bit tighter than waiting for the pullback." : "Chasing — poor reward:risk if you enter here now.";
      market_now = { price: now, risk_pips: pips(now, st), target: round(first), target_pips: pips(now, first), rr, final_target: round(last), final_rr: finalRr, ok: fr >= 1.5, note };
    } else if (now != null && stopOnSide) {
      market_now = { price: now, risk_pips: pips(now, st), target: null, target_pips: null, rr: null, final_target: null, final_rr: null, ok: false, note: "Price has already run to the targets — no room to enter now; wait for the next setup." };
    }
  }

  const [holdLow, holdHigh] = ctx.hold;

  return {
    symbol: "XAUUSD", mode: ctx.mode, market_regime: regime,
    directional_bias: bias, action, lifecycle,
    confidence_score: Math.round(confidence),
    entry, entry_low: entryLow, entry_high: entryHigh,
    stop_loss: stop, tp1, tp2, tp3,
    stop_pips: pips(entry, stop), tp1_pips: pips(entry, tp1), tp2_pips: pips(entry, tp2), tp3_pips: pips(entry, tp3),
    // price distances too (spec §5 — show both for verification)
    stop_distance: entry != null && stop != null ? round(Math.abs(entry - stop)) : null,
    closest_support: support, closest_resistance: resistance, room_to_target_pips: roomPips,
    market_structure: structure, momentum, volatility: ctx.volatility,
    buyer_control: buyers, seller_control: sellers,
    bull_case_score: Math.round(bullCase), bear_case_score: Math.round(bearCase),
    expected_hold_minutes: [holdLow, holdHigh],
    session: ctx.session, data_status: ctx.dataStatus,
    trigger_tf: ctx.triggerTf, context_tf: ctx.contextTf,
    market_story: ctx.marketStory,
    trade_reasoning, risk_factors,
    invalidation_reason, trigger_condition,
    setup_type: String(r.strategy ?? ""), engine_state: state,
    projected_path: path, invalidation_price: stop,
    market_now,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
