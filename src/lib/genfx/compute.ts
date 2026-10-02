import { series, livePrice, livePriceSane } from "@/lib/marketData";
import { runEngine, type EngineCfg } from "@/lib/omEngine";
import { MODES, sessionNow, arr, num, type Mode, type ModeCfg, type Row } from "@/lib/genxCompute";
import { type FxPair, U, units } from "@/lib/genfx/pairs";

/**
 * GEN FX SHARED COMPUTE — one read, used by the page (/api/genfx), the scanner and the replay, so the
 * setup a member sees on the page is byte-for-byte the setup the scanner acts on.
 *
 * THE ENGINE IS GENX'S, UNCHANGED. `runEngine` is called with the same three horizons, the same
 * timeframes, the same stop and reward limits and the same score bands that gold uses — `MODES` is
 * imported from genxCompute, not copied, so the two can never drift apart. Only the instrument differs.
 *
 * `buildGenfx` IS a copy, of `buildGenx`, and it has to be: that function writes "XAUUSD" into its
 * result and measures three of its distances in gold pips. Here those three are measured in the pair's
 * units (pairs.ts) and the result carries the pair's own symbol. tests/genfx-compute.test.ts feeds both
 * functions the same read with gold's own numbers and requires identical output, so a change to GENX's
 * mapping that is not carried across fails a test rather than quietly separating the two tools.
 *
 * Not carried across: the "right-now scalp" block. It is a gold product (30–80 gold pips on the leg
 * toward the entry) tuned on gold's spread; on a pair where the spread is a tenth of that move it is
 * not a trade. `scalp` is always null here.
 *
 * ENGINE VERSION. GEN FX follows engine v1 — what gold runs live. GENX 2.0's optional setup families
 * carry a spread proxy written in gold dollars inside the engine; if that flag is ever switched on for
 * gold, the families need a unit before they are trusted on a currency pair.
 */

export type GenfxReadOk = {
  ok: true;
  read: Record<string, unknown>;
  price: number;
  session: string;
  dataStatus: string;
  candles: unknown[];
  m: ModeCfg;
  volatility: string;
  atr: number | null;
  nowIso: string;
  nowMs: number;
};
export type GenfxReadErr = { ok: false; error: string; detail?: string; status?: number };

export const engineCfg = (pair: FxPair, mode: Mode): EngineCfg =>
  ({ symbol: pair.td, label: pair.label, cat: "forex", pip: pair.pip, dec: pair.dec, ...MODES[mode].eng });

/**
 * "High / Normal / Low" volatility for the card. GENX judges this as ATR ÷ price against two fixed
 * percentages chosen on gold; a currency pair moves a third as far for its price and would read "Low"
 * forever. Same two thresholds, converted: gold's 0.18% and 0.07% of a ~$4,270 price are $7.7 and $3.0,
 * so here it is 7.7 and 3.0 units. Display only — nothing decides on it.
 */
export function volLabel(pair: FxPair, rows: Row[] | null): { label: string; atr: number | null } {
  if (!rows || rows.length < 15) return { label: "Normal", atr: null };
  const tr: number[] = [];
  for (let i = 1; i < rows.length; i++) { const h = +rows[i].high, l = +rows[i].low, pc = +rows[i - 1].close; tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc))); }
  const atr = tr.slice(-14).reduce((a, b) => a + b, 0) / 14;
  const u = atr / pair.unit;
  return { label: u >= 7.7 ? "High" : u <= 3.0 ? "Low" : "Normal", atr };
}

/** Pure: run the engine over candles already in hand. The replay calls this directly. */
export function readFromSeries(pair: FxPair, mode: Mode, s: { d1: Row[] | null; h1: Row[] | null; m30: Row[] | null; m15: Row[] | null; m5: Row[] | null }, price: number, nowMs: number): { read: Record<string, unknown>; session: string; volatility: string; atr: number | null } {
  const session = sessionNow(new Date(nowMs));
  const read = runEngine(engineCfg(pair, mode), { d1: s.d1, h1: s.h1, m30: s.m30, m15: s.m15, m5: s.m5, price, nowMs, session }) as Record<string, unknown>;
  const vol = volLabel(pair, s.m15);
  return { read, session, volatility: vol.label, atr: vol.atr };
}

/** Fetch the horizon's candles, read a live price, run the engine. Mirrors computeGenxRead. */
export async function computeGenfxRead(opts: { pair: FxPair; mode: Mode; mdKey: string; fresh: boolean }): Promise<GenfxReadOk | GenfxReadErr> {
  const { pair, mode, mdKey, fresh } = opts;
  const m = MODES[mode];
  const TD = pair.td;

  // The same five frames GENX reads, at the same lengths. (GENX also fetches a sixth, `h4`, that the
  // engine never opens; it is not fetched here.) Two frames of a horizon are often the same request —
  // Quick reads 15-minute bars as both its "h1" and its "m30", Swing reads 4-hour and 1-hour bars twice
  // each — so identical requests are made once and shared.
  const asked = new Map<string, ReturnType<typeof series>>();
  const get = (interval: string, size: number) => {
    const k = `${interval}:${size}`;
    let p = asked.get(k);
    if (!p) { p = series(TD, interval, size, mdKey, fresh); asked.set(k, p); }
    return p;
  };
  const [d1, h1, m30, m15, m5] = await Promise.all([
    get(m.tf.d1, 90), get(m.tf.h1, 120), get(m.tf.m30, 120), get(m.tf.m15, 150), get(m.tf.m5, 150),
  ]);
  if ([d1, h1, m30, m15, m5].some((x) => x === "ratelimit")) return { ok: false, error: "ratelimit", status: 429 };
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
  const r = readFromSeries(pair, mode, { d1: arr(d1), h1: arr(h1), m30: arr(m30), m15: arr(m15), m5: arr(m5) }, price, nowMs);

  return {
    ok: true, read: r.read, price, session: r.session, dataStatus,
    candles: (r.read.candles as unknown[]) ?? [],
    m, volatility: r.volatility, atr: r.atr,
    nowIso: now.toISOString(), nowMs,
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export type GenfxCtx = {
  mode: Mode; price: number; session: string; dataStatus: string;
  hold: [number, number]; triggerTf: string; contextTf: string;
  marketStory: string[]; volatility: string; atr: number | null;
};

/**
 * Turn the engine's locked object into the GEN FX result. A copy of buildGenx (see the header) with
 * three gold-pip distances converted: the range entry zone (0.5 / 0.8 units either side of the level)
 * and the smallest range stop buffer (1.5 units). `symbol` and `unit` are the only inputs that are not
 * in GENX's signature; passing gold's ({ pip: 0.1, dec: 2, unit: 1 }) reproduces buildGenx exactly.
 */
export function buildGenfx(read: Record<string, unknown>, ctx: GenfxCtx, inst: { symbol: string; pip: number; dec: number; unit: number }) {
  const r = read as any;
  const { pip, dec, unit } = inst;
  const { price } = ctx;
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
      // GENX: max(ATR × 0.4, range × 0.15, 15 gold pips) and a zone 5 pips one side, 8 the other.
      // 15 / 5 / 8 gold pips are $1.50 / $0.50 / $0.80 — 1.5, 0.5 and 0.8 units.
      const buf = Math.max((ctx.atr ?? 0) * 0.4, range * 0.15, unit * 1.5);
      if (dir === "buy") { entry = support; entryLow = round(support - unit * 0.5); entryHigh = round(support + unit * 0.8); stop = round(support - buf); tp1 = mid; tp2 = resistance; tp3 = null; }
      else { entry = resistance; entryLow = round(resistance - unit * 0.8); entryHigh = round(resistance + unit * 0.5); stop = round(resistance + buf); tp1 = mid; tp2 = support; tp3 = null; }
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

  const [holdLow, holdHigh] = ctx.hold;

  return {
    symbol: inst.symbol, mode: ctx.mode, market_regime: regime,
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
    expected_hold_minutes: [holdLow, holdHigh] as [number, number],
    session: ctx.session, data_status: ctx.dataStatus,
    trigger_tf: ctx.triggerTf, context_tf: ctx.contextTf,
    market_story: ctx.marketStory,
    trade_reasoning, risk_factors,
    invalidation_reason, trigger_condition,
    setup_type: String(r.strategy ?? ""), engine_state: state,
    entry_profile: (r.entry_profile === "aggressive_only" ? "aggressive_only" : "core") as "core" | "aggressive_only",
    projected_path: path, invalidation_price: stop,
    scalp: null,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export type Genfx = ReturnType<typeof buildGenfx>;

/** The GEN FX result for one pair, with the pair's own symbol and pip. */
export function genfxOf(pair: FxPair, read: Record<string, unknown>, ctx: GenfxCtx): Genfx {
  return buildGenfx(read, ctx, { symbol: pair.key, pip: pair.pip, dec: pair.dec, unit: pair.unit });
}

/** Is this setup's stop wide enough for auto-trade on this pair? The page says so; placement enforces it. */
export function stopRoom(pair: FxPair, entry: number | null, stop: number | null, minStopPips = pair.minStopPips): { ok: boolean; pips: number | null; min: number } {
  if (entry == null || stop == null) return { ok: false, pips: null, min: minStopPips };
  const p = Math.abs(entry - stop) / pair.pip;
  // A hair of tolerance: 1.0843 − 1.0833 is 9.999999999 pips in floating point, and that is ten.
  return { ok: p >= minStopPips - 1e-6, pips: Math.round(p * 10) / 10, min: minStopPips };
}

/** Kept for the page's "touch" explanation and the zone registration, so both name one number. */
export const zoneTouch = (pair: FxPair): number => units(pair, U.zoneTouch);
