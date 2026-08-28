import { series, livePrice, livePriceSane } from "@/lib/marketData";
import { runEngine, type EngineCfg } from "@/lib/omEngine";

/**
 * GENX shared compute — the single source of truth for a GENX read.
 *
 * Both the on-demand read (`/api/genx`) and the automated scanner
 * (`/api/cron/genx-scan`) call `computeGenxRead` + `buildGenx` here, so a signal
 * a member sees in the app is byte-for-byte the same signal the alert bot calls
 * out. Every price/level/score is produced by the deterministic engine; the AI
 * market story (added only by the on-demand route) never changes a number.
 */

export type Mode = "quick" | "intraday" | "swing";
export type ModeCfg = {
  eng: Omit<EngineCfg, "symbol" | "label" | "cat" | "pip" | "dec">;
  tf: { d1: string; h4: string; h1: string; m30: string; m15: string; m5: string };
  hold: [number, number];
  triggerTf: string; contextTf: string;
};

// Gold base — pip 0.1, 2 decimals (spec §5 pip normalization).
export const GOLD = { symbol: "XAU/USD", label: "Gold (XAU/USD)", cat: "gold" as const, pip: 0.1, dec: 2 };

export const MODES: Record<Mode, ModeCfg> = {
  quick: {
    eng: { minStopAtr: 0.4, maxStopAtr: 1.6, rrFloor: 1.5, bands: { ready: 74, develop: 62, watch: 52 } },
    tf: { d1: "1h", h4: "30min", h1: "15min", m30: "15min", m15: "5min", m5: "1min" },
    hold: [20, 90], triggerTf: "5-minute", contextTf: "15-minute / 1-hour",
  },
  intraday: {
    eng: { minStopAtr: 0.6, maxStopAtr: 2.6, rrFloor: 1.8, bands: { ready: 76, develop: 64, watch: 54 } },
    tf: { d1: "1day", h4: "4h", h1: "1h", m30: "30min", m15: "15min", m5: "5min" },
    hold: [120, 360], triggerTf: "15-minute", contextTf: "1-hour / 4-hour",
  },
  swing: {
    eng: { minStopAtr: 1.0, maxStopAtr: 3.5, rrFloor: 2.0, bands: { ready: 78, develop: 66, watch: 56 } },
    tf: { d1: "1week", h4: "1day", h1: "4h", m30: "4h", m15: "1h", m5: "1h" },
    hold: [240, 2880], triggerTf: "1-hour", contextTf: "4-hour / daily",
  },
};

export type Row = { datetime: string; open: string; high: string; low: string; close: string; volume?: string };
export const arr = (x: unknown): Row[] | null => (Array.isArray(x) ? (x as Row[]) : null);
export const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function londonHour(d: Date): number {
  try { const s = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", hour12: false }).format(d); const h = parseInt(s, 10); return Number.isFinite(h) ? (h === 24 ? 0 : h) : d.getUTCHours(); } catch { return d.getUTCHours(); }
}
function nyHour(d: Date): number {
  try { const s = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false }).format(d); const h = parseInt(s, 10); return Number.isFinite(h) ? (h === 24 ? 0 : h) : d.getUTCHours() - 5; } catch { return d.getUTCHours() - 5; }
}
export function sessionNow(d: Date): string {
  const lh = londonHour(d), nh = nyHour(d);
  const londonOpen = lh >= 7 && lh < 16, nyOpen = nh >= 8 && nh < 17;
  if (londonOpen && nyOpen) return "London/NY overlap";
  if (londonOpen) return "London"; if (nyOpen) return "New York";
  if (lh >= 0 && lh < 7) return "Asian"; return "Off-session";
}

function volBucket(rows: Row[] | null, price: number): { label: string; atr: number | null } {
  if (!rows || rows.length < 15 || !price) return { label: "Normal", atr: null };
  const tr: number[] = [];
  for (let i = 1; i < rows.length; i++) { const h = +rows[i].high, l = +rows[i].low, pc = +rows[i - 1].close; tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc))); }
  const atr = tr.slice(-14).reduce((a, b) => a + b, 0) / 14;
  const pct = atr / price;
  const label = pct >= 0.0018 ? "High" : pct <= 0.0007 ? "Low" : "Normal";
  return { label, atr };
}

export type GenxReadOk = {
  ok: true;
  read: Record<string, unknown>;
  price: number;
  session: string;
  dataStatus: string;
  candles: unknown[];
  m: ModeCfg;
  volatility: string;
  atr: number | null;
  m15: Row[] | null;
  nowIso: string;
  nowMs: number;
};
export type GenxReadErr = { ok: false; error: string; detail?: string; status?: number };

/** Layers 1+2+4: fetch mode-mapped candles, read a live price, run the engine. */
export async function computeGenxRead(opts: { mode: Mode; mdKey: string; fresh: boolean }): Promise<GenxReadOk | GenxReadErr> {
  const m = MODES[opts.mode];
  const cfg: EngineCfg = { ...GOLD, ...m.eng };
  const TD = GOLD.symbol;
  const fresh = opts.fresh;
  const mdKey = opts.mdKey;

  const [d1, h4, h1, m30, m15, m5] = await Promise.all([
    series(TD, m.tf.d1, 90, mdKey, fresh),
    series(TD, m.tf.h4, 90, mdKey, fresh),
    series(TD, m.tf.h1, 120, mdKey, fresh),
    series(TD, m.tf.m30, 120, mdKey, fresh),
    series(TD, m.tf.m15, 150, mdKey, fresh),
    series(TD, m.tf.m5, 150, mdKey, fresh),
  ]);
  if ([d1, h4, h1, m30, m15, m5].some((x) => x === "ratelimit")) return { ok: false, error: "ratelimit", status: 429 };
  if (!arr(m15) || arr(m15)!.length < 20) return { ok: false, error: "insufficient_data", status: 200 };

  const live = await livePrice(TD, mdKey, fresh);
  const refRows = arr(m5) && arr(m5)!.length >= 3 ? arr(m5) : arr(m15);
  const liveOk = livePriceSane(live, refRows as never);
  const fallback = arr(m5)?.length ? +arr(m5)![arr(m5)!.length - 1].close : arr(m15)?.length ? +arr(m15)![arr(m15)!.length - 1].close : null;
  const price = (live != null && liveOk.ok) ? live : (liveOk.reference ?? fallback);
  if (price == null) return { ok: false, error: "marketdata_error", status: 502 };
  const dataStatus = (live != null && liveOk.ok) ? "live" : "reference";

  const now = new Date();
  const nowMs = now.getTime();
  const session = sessionNow(now);

  const read = runEngine(cfg, { d1: arr(d1), h4: arr(h4), h1: arr(h1), m30: arr(m30), m15: arr(m15), m5: arr(m5), price, nowMs, session }) as Record<string, unknown>;
  const vol = volBucket(arr(m15), price);

  return {
    ok: true, read, price, session, dataStatus,
    candles: (read.candles as unknown[]) ?? [],
    m, volatility: vol.label, atr: vol.atr, m15: arr(m15),
    nowIso: now.toISOString(), nowMs,
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Layer 4 mapping — turn the locked engine object into the GENX result shape. */
export function buildGenx(read: Record<string, unknown>, ctx: { mode: Mode; price: number; session: string; dataStatus: string; hold: [number, number]; triggerTf: string; contextTf: string; pip: number; dec: number; marketStory: string[]; volatility: string; atr: number | null; m15: Row[] | null }) {
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
      confidence = Math.max(45, Math.min(58, confidence || 45));
    }
  }
  const bias = dir === "buy" ? "bullish" : "bearish";

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

  const dirScore = num(scores.directional) ?? confidence;
  const momentum = dirScore >= 72 ? "Strong" : dirScore >= 55 ? "Moderate" : "Weak";
  const regime = String(r.market_regime ?? "");
  const structure = synth ? "Range" : (/bull/i.test(regime) ? "Bullish" : /bear/i.test(regime) ? "Bearish" : /range|chop|consol/i.test(regime) ? "Range" : (bias === "bullish" ? "Bullish" : "Bearish"));

  const lean = dir === "buy" ? 1 : dir === "sell" ? -1 : 0;
  const edge = Math.round(Math.max(0, Math.min(40, (confidence - 50) * 0.8)));
  const buyers = lean === 1 ? 50 + edge : lean === -1 ? 50 - edge : 50;
  const sellers = 100 - buyers;
  const bullCase = dir === "buy" ? confidence : Math.max(0, 100 - confidence - 10);
  const bearCase = dir === "sell" ? confidence : Math.max(0, 100 - confidence - 10);

  const nextObstacle = dir === "buy" ? resistance : support;
  const roomPips = pips(entry ?? price, nextObstacle);

  const why: string[] = synth ? [dir === "buy" ? "Range-bound — buy the support hold toward resistance." : "Range-bound — sell the resistance rejection toward support."] : [];
  if (regime) why.push(`Market regime: ${regime}.`);
  why.push(`${structure} structure with ${momentum.toLowerCase()} momentum.`);
  if (entry != null && stop != null) why.push(`Stop sits behind structure at ${stop} (${pips(entry, stop)} pips risk).`);
  if (tp1 != null && entry != null) why.push(`First target ${tp1} = ${pips(entry, tp1)} pips (${tpsRaw[0]?.risk_reward ?? "?"}R).`);
  if (roomPips != null) why.push(`~${roomPips} pips of room before the next ${dir === "buy" ? "resistance" : "support"}.`);
  const trade_reasoning = why.slice(0, 5);

  const risk_factors: string[] = [];
  const whatNext = Array.isArray(r.what_next) ? r.what_next.map(String) : [];
  if (proxStatus) risk_factors.push(`Location: ${proxStatus}.`);
  if (!insideZone && action.includes("LIMIT")) risk_factors.push(`Do not chase — wait for the pullback into the entry zone.`);
  whatNext.slice(0, 2).forEach((w: string) => risk_factors.push(w));

  const trigger_condition = synth ? ("Wait for price to reach " + entry + " (" + (dir === "buy" ? "support" : "resistance") + ") and show a " + (dir === "buy" ? "bullish" : "bearish") + " reaction, then enter " + (dir === "buy" ? "BUY" : "SELL") + ". Invalid on a close beyond " + stop + ".") : String(r.trigger?.recheckInstruction ?? r.setup_zone?.confirmation ?? "");
  const invalidation_reason = String(slObj.reason ?? r.setup_zone?.invalidation ?? (stop != null ? `A decisive close beyond ${stop}.` : ""));

  const needsPullback = action.includes("LIMIT") || action.includes("WAIT");
  const path: { label: string; price: number | null; kind: string }[] = [{ label: "Now", price: round(price), kind: "now" }];
  if (needsPullback && entry != null) path.push({ label: "Entry", price: entry, kind: "entry" });
  if (tp1 != null) path.push({ label: "TP1", price: tp1, kind: "target" });
  if (tp2 != null) path.push({ label: "TP2", price: tp2, kind: "target" });
  if (tp3 != null) path.push({ label: "TP3", price: tp3, kind: "target" });

  let scalp: {
    side: "buy" | "sell"; entry: number | null; stop: number | null; target: number | null;
    target_pips: number | null; risk_pips: number | null; rr: number | null; reason: string;
  } | null = null;
  {
    const rows: Row[] = (ctx.m15 ?? []) as Row[];
    const isWait = action.includes("WAIT") || action.includes("LIMIT");
    const nowP = round(price);
    const a = ctx.atr;
    if (isWait && entry != null && nowP != null && rows.length >= 6 && a) {
      const distPips = pips(nowP, dir === "buy" ? (entryHigh ?? entry) : (entryLow ?? entry)) ?? 0;
      const side: "buy" | "sell" = entry < nowP ? "sell" : "buy";
      const c = rows.map((x) => ({ o: +x.open, h: +x.high, l: +x.low, c: +x.close, v: x.volume != null ? +x.volume : null }));
      const last = c[c.length - 1];
      const mom = last.c - c[Math.max(0, c.length - 4)].c;
      const bodyAbs = Math.abs(last.c - last.o) || pip;
      const bearRej = (last.h - Math.max(last.o, last.c)) > bodyAbs * 1.1;
      const bullRej = (Math.min(last.o, last.c) - last.l) > bodyAbs * 1.1;
      const strongUp = mom > a * 0.8, strongDown = mom < -a * 0.8;
      const vols = c.map((x) => x.v).filter((v): v is number => v != null && v > 0);
      const volRising = vols.length >= 6 ? (vols.slice(-3).reduce((s, v) => s + v, 0) / 3) > (vols.slice(-6, -3).reduce((s, v) => s + v, 0) / 3) : null;
      const worthwhile = distPips >= 25;
      const flowOk = side === "sell" ? !strongUp : !strongDown;
      if (worthwhile && flowOk) {
        const tgtPips = Math.max(30, Math.min(80, distPips));
        const target = round(side === "sell" ? nowP - tgtPips * pip : nowP + tgtPips * pip);
        const look = c.slice(-8);
        const swingHi = Math.max(...look.map((x) => x.h)), swingLo = Math.min(...look.map((x) => x.l));
        const rawStop = side === "sell" ? Math.max(swingHi, nowP + a * 0.6) : Math.min(swingLo, nowP - a * 0.6);
        const cappedStop = side === "sell" ? Math.min(rawStop, nowP + a * 1.2) : Math.max(rawStop, nowP - a * 1.2);
        const stopP = round(cappedStop);
        const riskP = pips(nowP, stopP);
        const rr = riskP && tgtPips ? +(tgtPips / riskP).toFixed(2) : null;
        const bits: string[] = [];
        if (side === "sell") bits.push(strongDown ? "15m momentum is pushing down" : bearRej ? "the last 15m candle rejected off the highs" : "15m momentum is soft and rolling over");
        else bits.push(strongUp ? "15m momentum is pushing up" : bullRej ? "the last 15m candle rejected off the lows" : "15m momentum is firming up");
        if (volRising === true) bits.push("volume is rising into the move");
        const zoneName = dir === "buy" ? "buy zone" : "sell zone";
        const reason = `${bits.join(" and ")} — GENX expects a drift toward the ${entry} ${zoneName} first. Scalp ${side.toUpperCase()} for ~${tgtPips} pips into ${target}, then look for the main ${dir === "buy" ? "BUY" : "SELL"} at ${entry}.`;
        if ((rr ?? 0) >= 0.9) scalp = { side, entry: nowP, stop: stopP, target, target_pips: tgtPips, risk_pips: riskP, rr, reason };
      }
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
    // "core" families are eligible for both modes; "aggressive_only" families
    // (moderate trend, compression edge-fade) are earlier tiers conservative
    // accounts never take — enforced by genxConservativeGate below.
    entry_profile: (r.entry_profile === "aggressive_only" ? "aggressive_only" : "core") as "core" | "aggressive_only",
    projected_path: path, invalidation_price: stop,
    scalp,
  };
}

// ── CONSERVATIVE QUALITY GATE (per-account, opt-in) ──────────────────────────
// Extra confluence checks that apply ONLY to CONSERVATIVE accounts. AGGRESSIVE
// accounts ignore this entirely and take EVERY gold ENTER NOW exactly as before —
// nothing in the signal, the engine, or aggressive placement changes. This is a
// pure, unit-tested verdict computed at arm time and carried on the alert row so
// the confirm/fast-watch paths (which only have the stored row) grade identically.
//
// A conservative account SKIPS a setup that fails any factor:
//   1. Momentum must not be "Weak" (a weak/fading push is the classic chop loser).
//   2. Confidence must clear a floor.
//   3. Reward:risk (entry→tp1 vs entry→stop) must clear a floor.
//   4. Structure alignment — don't SELL a clearly Bullish structure / BUY a clearly
//      Bearish one. "Range"/neutral is allowed (a range fade is legitimate).
//   5. Skip the thin Off-session window (illiquid gold chop).
export const CONSERVATIVE_MIN_CONFIDENCE = 62;
export const CONSERVATIVE_MIN_RR = 1.5;

export function genxConservativeGate(g: {
  confidence_score?: number | null;
  momentum?: string | null;
  market_structure?: string | null;
  action?: string | null;
  side?: "buy" | "sell" | null;
  entry?: number | null;
  stop_loss?: number | null;
  tp1?: number | null;
  session?: string | null;
  entry_profile?: string | null;
}): { ok: boolean; reason: string } {
  const side: "buy" | "sell" =
    g.side === "sell" || String(g.action ?? "").toUpperCase().includes("SELL") ? "sell" : "buy";

  // 0) Setup-family eligibility: aggressive-only families (moderate trend,
  //    compression edge-fade) are earlier/opportunistic tiers — conservative
  //    accounts never take them regardless of score.
  if (g.entry_profile === "aggressive_only") return { ok: false, reason: "aggressive-only setup family" };

  // 1) Momentum must not be weak.
  if (String(g.momentum ?? "").toLowerCase().includes("weak")) return { ok: false, reason: "weak momentum" };

  // 2) Confidence floor.
  const conf = typeof g.confidence_score === "number" ? g.confidence_score : 0;
  if (conf < CONSERVATIVE_MIN_CONFIDENCE) return { ok: false, reason: `confidence ${conf} < ${CONSERVATIVE_MIN_CONFIDENCE}` };

  // 3) Reward:risk floor (only when we have the three levels to measure it).
  const entry = g.entry, stop = g.stop_loss, tp1 = g.tp1;
  if (entry != null && stop != null && tp1 != null) {
    const risk = Math.abs(entry - stop);
    const reward = Math.abs(tp1 - entry);
    const rr = risk > 0 ? reward / risk : 0;
    if (rr < CONSERVATIVE_MIN_RR) return { ok: false, reason: `R:R ${rr.toFixed(2)} < ${CONSERVATIVE_MIN_RR}` };
  }

  // 4) Structure alignment (Range/neutral passes).
  const struct = String(g.market_structure ?? "").toLowerCase();
  const bullish = struct.includes("bull");
  const bearish = struct.includes("bear");
  if (side === "sell" && bullish) return { ok: false, reason: "sell vs bullish structure" };
  if (side === "buy" && bearish) return { ok: false, reason: "buy vs bearish structure" };

  // 5) Thin session.
  if (String(g.session ?? "").toLowerCase().includes("off-session")) return { ok: false, reason: "off-session (thin)" };

  return { ok: true, reason: "ok" };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
