import { executablePrice } from "./executionQuote";
import { readProtectiveStop } from "./brokerEvidence";
import { partialOnce } from "./partialOperation";
import { nearTargetPrice, nearTargetApplies } from "@/lib/flow/nearTarget";
import { feedPrice } from "./feedPrice";
import { createAdminClient } from "@/lib/supabase/admin";
import { connectionToken } from "@/lib/flow/connection";
import { matchInstrument } from "@/lib/flow/executor";
import { normalizeQuantity, getInstrument } from "@/lib/flow/instruments";
import { contractKey } from "@/lib/flow/sizing";
import { listInstruments, listPositions, getQuote, getConfig, modifyPosition, closePosition, listOrdersHistory, type TLEnv, type TLInstrument } from "@/lib/flow/tradelocker";
import { releaseGold } from "@/lib/genx2/reservation";
import { goldResvKey } from "@/lib/genx/hedge";
import { genx2TrailAckGate } from "@/lib/genx2/flags";
import { reconcileStaleGoldEntries } from "@/lib/genx2/cancelReconcile";
import { recoverOrphans } from "@/lib/flow/recover";
import { logTrade } from "@/lib/flow/tradeLog";
import { beat } from "@/lib/flow/health";
import { liveTickExtremes, liveTick } from "@/lib/flow/liveTicks";
import { profitGuardPlan } from "@/lib/flow/profitGuard";
import { goldChangeOfCharacter } from "@/lib/genx/choch";
import { mergeMgmt, followGivebackR, targetInForce, partialTriggerPrice, missingColumn, type Mgmt, type MgmtRow } from "./manageSettings";

// Recent intra-minute EXTREMES from the market-data feed. The manager runs once a minute
// off the instantaneous bid/ask, so a spike that reverses inside the minute (common on
// gold around news) is invisible to the sample. We pull the last few 1-min candle
// highs/lows so best_price records the TRUE favorable excursion for PARTIALS, grading, and
// stats. NOTE (owner 09-07): BREAK-EVEN deliberately does NOT use this history — it fires
// only when the LIVE price is at the trigger, so a wick that already reversed can never
// move the stop after the fact. Cached per
// symbol for the tick. Feed down / no key → null (caller falls back to the sampled price).
// 15-minute lookback (was 3): a row that goes several minutes without a manage tick — a slow
// pass over many positions, an invocation gap, a deploy swap — used to permanently LOSE any
// spike older than 3 minutes, so its best_price never learned the extreme and break-even never
// fired even though the chart clearly reached it (live case 08-28: same signal, the rows ticked
// near the spike got break-even, the rows ticked late sat at full risk). Bars are cached with
// their timestamps and each ROW folds in only the extremes printed since ITS OWN entry, so a
// pre-entry spike can never count as favorable excursion.
const EXT_LOOKBACK_BARS = 15;
const extCache = new Map<string, { at: number; bars: Array<{ t: number; high: number; low: number }> }>();
async function feedExtremes(symbol: string, sinceMs?: number | null): Promise<{ high: number; low: number } | null> {
  try {
    const td = getInstrument(contractKey(symbol))?.twelveDataSymbol;
    if (!td) return null;
    let entry = extCache.get(td);
    if (!entry || Date.now() - entry.at >= 20_000) {
      const key = process.env.TWELVEDATA_API_KEY;
      if (!key) return null;
      const r = await fetch(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(td)}&interval=1min&outputsize=${EXT_LOOKBACK_BARS}&apikey=${key}`, { cache: "no-store" });
      const j = (await r.json()) as { values?: Array<{ datetime?: unknown; high?: unknown; low?: unknown }> };
      const vals = Array.isArray(j?.values) ? j.values : [];
      const bars: Array<{ t: number; high: number; low: number }> = [];
      for (const v of vals) {
        const h = Number(v.high), l = Number(v.low);
        const t = Date.parse(String(v.datetime ?? "").replace(" ", "T") + "Z");
        if (Number.isFinite(h) && h > 0 && Number.isFinite(l) && l > 0 && Number.isFinite(t)) bars.push({ t, high: h, low: l });
      }
      if (!bars.length) return null;
      entry = { at: Date.now(), bars };
      extCache.set(td, entry);
    }
    // Fold only bars that STARTED at/after the row's entry. The old 60s backward slack let the
    // minute BEFORE the fill count as the trade's own excursion — a trade entered right after a
    // +30-pip spike instantly "reached" its BE trigger, parked the stop at entry, and the next
    // wiggle tagged it out minutes after opening (owner case 09-03: 2–7-min scratches).
    const cut = typeof sinceMs === "number" && Number.isFinite(sinceMs) ? sinceMs : 0;
    let hi = 0, lo = Infinity;
    for (const b of entry.bars) { if (b.t >= cut) { hi = Math.max(hi, b.high); lo = Math.min(lo, b.low); } }
    // STREAMED TICK EXTREMES (owner 09-10): when the worker's WebSocket feed is live,
    // fold in the tick-level highs/lows since the same cutoff — a wick that prints and
    // reverses between 1-min bar updates is visible to break-even/trail logic the
    // moment it happens. Empty store on Vercel → no-op there. The caller's extSane
    // guard still applies downstream, so a junk tick can never fake an excursion.
    const lt = liveTickExtremes(td, cut);
    if (lt) { hi = Math.max(hi, lt.high); lo = Math.min(lo === Infinity ? lt.low : lo, lt.low); }
    if (hi > 0 && Number.isFinite(lo)) return { high: hi, low: lo };
  } catch { /* feed down → null */ }
  return null;
}

/**
 * FLOW AUTO TRADE-MANAGER (server-only). Runs the member's playbook on every position
 * FLOW opened (recorded in flow_managed_positions by executor.placeOnActiveAccounts).
 *
 * THE RULES (simple, and anchored to the broker's OWN numbers so it can never act on a
 * phantom profit):
 *   0. Start with the entry, stop and take-profit exactly as placed — untouched.
 *   1. BREAK-EVEN: when price reaches the break-even point (gold: the account's chosen pips;
 *      currency pairs: the halfway mark to take-profit), move the STOP just into profit. The
 *      trade can no longer lose.
 *   2. PARTIAL (when the member picked 25% or 50%): bank that share halfway to the target the
 *      trade will actually close at; the rest rides on.
 *   3. FOLLOW PRICE (when the member picked Tight, Normal or Loose, and break-even is on): once
 *      break-even is set, ratchet the stop up behind the best price it reaches — anchored to
 *      the REAL fill and the true favorable excursion — so a winner that reverses keeps most
 *      of its gain. Ratchet only (a long's stop never drops), never below break-even, and
 *      never through the current market.
 * Each account's three choices are read from manageSettings.ts (owner 10-08); an account that
 * had "AI Pips" on runs exactly as before — break-even at its own pips, follow price Normal,
 * no partials — and one that had it off is left alone.
 *
 * HARD SAFETY: every stop-to-entry and every partial is gated on the broker itself showing
 * the position IN PROFIT (its unrealized P&L, or price beyond the real fill). We NEVER close
 * a "partial" or set a "break-even" at a price that is actually a loss. The entry we measure
 * from is the account's REAL average fill read back from the broker — not the shared signal
 * price, which differs per account and was the cause of losers being banked as wins.
 *
 * It also detects a position that has closed (SL/TP hit or member-closed) and books the
 * outcome. It never OPENS a position, and all broker writes go through the confirmed
 * TradeLocker modify/close endpoints.
 */

export type ManagedRow = {
  id: string; user_id: string; connection_id: string; account_id: string; acc_num: string; environment: string;
  position_id: string; symbol: string; side: "buy" | "sell";
  entry: number; init_stop: number; tp1: number | null; r: number; qty: number;
  cur_stop: number | null; best_price: number | null; worst_price: number | null; be_done: boolean | null; partial_done: boolean | null; status: string;
  last_error?: string | null;
  created_at?: string | null;
  /** Where the manager banked a partial, and what share of the position it was (10-08). Null on a
   *  position from before, or when the reduction was the member's own — those grade as they always did. */
  partial_px?: number | null;
  partial_frac?: number | null;
};

export type ManageAction = { positionId: string; symbol: string; account: string; action: string; detail?: string };
type Admin = NonNullable<ReturnType<typeof createAdminClient>>;

// Positions per tick — a ROTATING BATCH, not a cap. Rows are selected oldest-touched
// first and stamped on selection, so each ~2.5s tick takes the 24 positions that have
// waited longest and the next tick automatically takes the others: the whole fleet is
// covered every 2-3 ticks with BOUNDED tick time. (Owner 08-31: one pass tried to read
// ALL 65+ accounts and could not finish inside the function budget at real broker
// latency — the manager restarted every minute with zero completed ticks and stops
// never moved to break-even. Batching makes tick time independent of fleet size.)
const MAX_PER_TICK = 24;

// CROSS-PASS INSTRUMENT CACHE (owner 08-31: BE latency). An account's instrument list is
// effectively static, yet every pass refetched it for EVERY account — at 65+ managed
// accounts that alone was half the broker calls of a pass. Cache it per account for 45
// minutes (module scope: survives ticks and invocations on a warm instance; a cold start
// simply refetches). Positions are ALWAYS read fresh — only the static metadata is cached.
const _instCache = new Map<string, { at: number; data: TLInstrument[] }>();
const INSTRUMENT_TTL_MS = 45 * 60 * 1000;
// BROKER-CALL DIET (owner 09-17 "speed up entry"): TradeLocker rate-limits our single IP, and the manager's
// per-account broker quote on every pass was its biggest consumer. For gold, the exit price now comes from the
// worker's live price stream, calibrated to THIS account's broker: every QUOTE_CALIBRATE_MS the broker quote is
// read once and we store its basis (broker mid − stream price) and spread. Between calibrations:
//   exit = stream + basis ∓ spread/2  (bid for a long, ask for a short — the same conservative side as before).
// No fresh stream tick, or no fresh calibration → the broker quote is read exactly as before.
const QUOTE_CALIBRATE_MS = 20_000;
const STREAM_MAX_AGE_MS = 1_500;
const brokerBasis = new Map<string, { at: number; basis: number; spread: number }>();
/** Pure: stream-derived executable exit price (unit-tested). */
export function streamExitPrice(side: "buy" | "sell", streamPx: number, basis: number, spread: number): number {
  const mid = streamPx + basis;
  return side === "buy" ? mid - spread / 2 : mid + spread / 2;
}

// CROSS-PASS TOKEN CACHE — the ROOT of the manager's slowness at 54 connections:
// connectionToken() does a FULL auth refresh round-trip (a POST, on the single-file
// write lane) EVERY call, so every pass spent 30-90s just re-minting the same tokens
// before reading a single position. A freshly-minted TradeLocker access token is valid
// far longer than 5 minutes, so reuse it for 5; a failed account read invalidates the
// connection's cached token immediately (see the row loop), so a genuinely expired
// token costs at most one tick before a fresh mint.
const _connTokCache = new Map<string, { at: number; v: { token: string; env: TLEnv } }>();
const CONN_TOKEN_TTL_MS = 5 * 60 * 1000;
export function _invalidateConnToken(connId: string) { _connTokCache.delete(connId); }

// A partial whose close was sent but whose smaller size the broker has not shown yet is asked about
// again after this long, not on every pass (see STEP 2). Module scope, like the caches above.
const PARTIAL_RECHECK_MS = 60_000;
const partialRecheckAt = new Map<string, number>();

// Each account's trade settings as last read, standing in when a read fails (see "A READ THAT FAILS"). Kept
// for as long as reads keep failing — only a read that succeeds replaces them.
const lastMgmt = new Map<string, { at: number; rows: MgmtRow[] }>();
/** An account whose settings could not be read: nothing is done to its trade this pass. */
const SETTINGS_UNREAD: Mgmt = { manage: false, breakEven: false, goldBePips: 30, follow: "off", followChoice: "off", partialPct: 0 };

// CROSS-PASS COLUMN-CONFIG CACHE — the broker's positionsConfig column layout is static
// per connection; refetching it every pass for 54 connections was pure waste.
const _colsCacheMod = new Map<string, { at: number; v: { avgIdx: number; uplIdx: number; slIdx: number; qtyIdx: number; tpIdx: number } }>();
const COLS_TTL_MS = 6 * 60 * 60 * 1000;

// The share a partial banked before 10-08, when every partial was 25% at the halfway point of a
// 1:2. Grading still uses it for a reduction the manager did not record itself (a position from
// before, or a member closing part by hand); a partial the manager takes now records its own
// share and price (partial_frac / partial_px) and is graded from those.
const PARTIAL_FRACTION = 0.25;
// Never move the break-even stop on a scratch smaller than this (pips) — avoids nudging the
// stop for a spread-width blip on an ultra-tight stop.
const BE_MIN_PIPS = 8;
// BREAK-EVEN PROFIT OFFSET (owner rule 09-03): the BE stop sits this many pips INTO PROFIT,
// never exactly at entry — a stop parked at entry exits with the spread/commission as a small
// LOSS (the −1…−8 pip "break-evens" that bled accounts). 5 pips covers fees so a scratched
// trade closes green.
const BE_PROFIT_PIPS = 5;

// GOLD break-even trigger: the account's own pips, 30 when it never picked (owner 09-07: "move
// when the market goes 30-35 pips into profit"). Lives in manageSettings.ts with the choices.

// FOLLOW PRICE (after break-even). The stop rides a share of R behind the best price, set by the
// member's choice (manageSettings.ts: Normal is 0.6R, tightening to 0.25R; Tight and Loose are
// closer and wider). "Near" — within NEAR_TP_R of take-profit, or NEAR_PARTIAL_R below the
// halfway level — is decided here exactly as it always was, so a run that gets "super close"
// and reverses locks in most of the gain.
const NEAR_TP_R = 0.4;
const NEAR_PARTIAL_R = 0.2;

/** Extract a position id from a TradeLocker position entry (object OR column array). */
function posIdOf(p: unknown): string {
  if (Array.isArray(p)) return p.length ? String(p[0]) : "";
  if (p && typeof p === "object") {
    const o = p as Record<string, unknown>;
    const v = o.id ?? o.positionId ?? o.positionID;
    return v == null ? "" : String(v);
  }
  return "";
}

/** Read a numeric field from a TradeLocker position, whether it comes back as a columnar
 *  array (use the config-derived index) or an object (use one of the known field names). */
function numAt(p: unknown, idx: number, keys: string[]): number | null {
  let v: number = NaN;
  if (Array.isArray(p)) { if (idx >= 0 && idx < p.length) v = Number(p[idx]); }
  else if (p && typeof p === "object") {
    const o = p as Record<string, unknown>;
    for (const k of keys) { const n = Number(o[k]); if (Number.isFinite(n)) { v = n; break; } }
  }
  return Number.isFinite(v) ? v : null;
}

const AVG_KEYS = ["avgPrice", "openPrice", "avg_price", "price"];
const UPL_KEYS = ["unrealizedPl", "unrealizedPnl", "unrealizedPnL", "upl", "rpl"];
const SL_KEYS = ["stopLoss", "stopLossPrice", "sl", "stop_loss"];
const TP_KEYS = ["takeProfit", "takeProfitPrice", "tp", "take_profit"];
const QTY_KEYS = ["qty", "quantity", "volume", "size", "lots", "positionQty"];

/** True when the broker's actual stop-loss price matches what we asked for, within a
 *  small per-instrument tolerance (half a pip, floored at the price rounding unit). Used
 *  to CONFIRM a break-even / trailing modify actually applied at the broker before we
 *  record it — a stop that "didn't move" differs by ~R (many pips) and fails this. */
export function slWithinTolerance(symbol: string, requested: number, actual: number): boolean {
  if (!(requested > 0) || !(actual > 0)) return false;
  const inst = getInstrument(contractKey(symbol));
  const pip = inst.pipSize || 0.0001;
  const unit = Math.pow(10, -(inst.pricePrecision ?? 2));
  const tol = Math.max(pip * 0.5, unit * 1.5);
  return Math.abs(requested - actual) <= tol;
}

/** CONFIRM a stop modify from a fresh broker positions read: find this position and
 *  check its live stop-loss equals `requested` within tolerance. Returns false when the
 *  position isn't found or its SL can't be read (→ caller does NOT record the move and
 *  re-sends next tick). If `slIdx < 0` the broker doesn't expose the SL on the position
 *  row, this helper returns false; the caller can read linked stop orders instead. */
/** Classify a break-even modify for the be_done gate.
 *  'acked'    — broker accepted the modify; the stop is at break-even.
 *  'already'  — broker REJECTED it as a no-op ("nothing to change"), which is the broker
 *               telling us the stop is ALREADY exactly the price we asked for. Before this
 *               was handled, such a position could never record break-even: the first
 *               attempt moved the stop, the read-back failed to confirm it, be_done stayed
 *               false, and every later attempt was rejected as redundant forever — which
 *               also kept trailing (gated on be_done) permanently off.
 *  'failed'   — a real rejection. Never record break-even; leave the stop and retry. */
export function breakEvenOutcome(ok: boolean, error?: string): 'acked' | 'already' | 'failed' {
  if (ok) return 'acked';
  return /nothing\s+to\s+change/i.test(error ?? '') ? 'already' : 'failed';
}

export function stopConfirmedFromPositions(
  positions: unknown[], positionId: string, slIdx: number, symbol: string, requested: number,
): boolean {
  if (slIdx < 0) return false;                       // absent SL is not confirmation
  for (const p of positions) {
    if (posIdOf(p) === String(positionId)) {
      const sl = numAt(p, slIdx, SL_KEYS);
      return sl != null && slWithinTolerance(symbol, requested, sl);
    }
  }
  return false;                                     // position not found on read-back → not confirmed
}

/**
 * PARTIAL-CLOSE IDEMPOTENCY via broker truth. Each tick, reconcile the recorded position
 * quantity against what the broker ACTUALLY holds, so a partial that executed at the broker
 * but wasn't durably recorded (API timeout / crash / lost DB write) is DETECTED and never
 * fired again:
 *   • broker qty meaningfully below the recorded full size, and we haven't recorded a partial
 *     → a partial (auto or manual) already happened → mark it done and adopt the real qty.
 *   • broker qty merely drifted (partial fill / rounding) → sync the recorded qty to truth.
 *   • broker qty implausibly ABOVE recorded (× >1.05, e.g. a mis-mapped column) → ignore, to
 *     never corrupt the qty from a bad read.
 * Pure + unit-tested. `brokerQty == null` (broker doesn't expose qty) → no change.
 */
export function reconcilePartialQty(
  recordedQty: number, partialDone: boolean, brokerQty: number | null, partialFraction = PARTIAL_FRACTION,
): { partialDone: boolean; qty: number; reconciled: "none" | "partial_detected" | "synced" } {
  if (brokerQty == null || !(brokerQty > 0) || !(recordedQty > 0)) return { partialDone, qty: recordedQty, reconciled: "none" };
  if (brokerQty > recordedQty * 1.05) return { partialDone, qty: recordedQty, reconciled: "none" }; // implausible read → ignore
  const eps = Math.max(recordedQty * 0.01, 1e-9);
  if (!partialDone && brokerQty < recordedQty * (1 - 0.5 * partialFraction)) {
    return { partialDone: true, qty: brokerQty, reconciled: "partial_detected" };
  }
  if (Math.abs(brokerQty - recordedQty) > eps) {
    return { partialDone, qty: brokerQty, reconciled: "synced" };
  }
  return { partialDone, qty: recordedQty, reconciled: "none" };
}

/** Round a stop price to the instrument's own precision so the broker accepts it. */
function roundPx(symbol: string, price: number): number {
  const prec = getInstrument(contractKey(symbol)).pricePrecision ?? 2;
  return +price.toFixed(prec);
}

/**
 * Where the partial fires, as a fraction of R, from the signal's REWARD:RISK — used by
 * the outcome classifier to weight banked pips. ~1:1 banks at +0.5R (halfway to a 1R target),
 * 1:2/1:3 banks at +1R (halfway to a 2R target) — i.e. always the halfway-to-target point.
 */
function partialTriggerR(entry: number, initStop: number, tp1: number | null): number {
  const risk = Math.abs(entry - initStop);
  const reward = tp1 != null && tp1 > 0 ? Math.abs(tp1 - entry) : risk;
  const rr = risk > 0 ? reward / risk : 1;
  return rr <= 1.5 ? 0.5 : 1;
}

export type FlowOutcomeKind = "stop" | "breakeven" | "trail" | "target" | "manual";
export type FlowOutcome = { outcome: FlowOutcomeKind; result_pips: number; exit_price: number; partial_taken: boolean };
// WHY a position closed, read from the broker's own order history. Only "stop" is a
// losing outcome that feeds the conservative loss streak; "manual" is a hand-close
// and is deliberately excluded from win/loss streak logic.
export type CloseReason = "stop" | "target" | "manual" | "unknown";

/**
 * Classify a CLOSED managed position into the track-record outcome, from the lifecycle we
 * recorded — measured from the REAL entry (re-anchored while the trade was live). 'stop' is
 * the only negative outcome; a trade that reached break-even can at worst scratch.
 */
export function classifyOutcome(
  row: Pick<ManagedRow, "symbol" | "side" | "entry" | "init_stop" | "tp1" | "best_price" | "cur_stop" | "be_done" | "partial_done"> & Partial<Pick<ManagedRow, "partial_px" | "partial_frac">>,
  exitPrice?: number | null,
  reason?: CloseReason,
): FlowOutcome {
  const sym = contractKey(row.symbol);
  const pip = getInstrument(sym).pipSize || 0.0001;
  const long = row.side === "buy";
  const rPips = Math.round(Math.abs(row.entry - row.init_stop) / pip);
  const signed = (px: number) => Math.round((long ? px - row.entry : row.entry - px) / pip);
  const banked = !!row.partial_done;
  // A partial the manager took and recorded (10-08 on) is graded at its own price and share, in every
  // branch below — with break-even off, a trade can bank half and then stop out, and the half it banked
  // is part of its result. Any other reduction keeps the old reckoning exactly: 25% at the halfway mark
  // of the plan, counted only where it always was.
  const ownPx = row.partial_px != null ? Number(row.partial_px) : NaN, ownFrac = row.partial_frac != null ? Number(row.partial_frac) : NaN;
  const own = banked && ownPx > 0 && ownFrac > 0 && ownFrac < 1;
  const frac = own ? ownFrac : PARTIAL_FRACTION;
  const bankPips = own ? signed(ownPx) : Math.round(partialTriggerR(row.entry, row.init_stop, row.tp1) * rPips);
  const blend = (p: number) => (banked ? Math.round(frac * bankPips + (1 - frac) * p) : p);
  const tp1 = row.tp1;
  const best = row.best_price;
  const hitTarget = tp1 != null && best != null && (long ? best >= tp1 : best <= tp1);

  // MANUAL user close (broker order history says the position was closed by a market
  // order the user placed). It is neither a win nor a loss for streak purposes — it is
  // recorded as its own outcome and excluded from the conservative loss streak. Booked
  // at the real close fill when known, else at entry (0 pips) rather than a guessed level.
  if (reason === "manual") {
    const px = exitPrice != null && exitPrice > 0 ? exitPrice : row.entry;
    return { outcome: "manual", result_pips: own ? blend(signed(px)) : signed(px), exit_price: px, partial_taken: banked };
  }

  // A TARGET is only booked when the EXIT itself says so (owner 09-07): the broker closed it
  // as a take-profit, or the realized exit landed at/through TP1. best_price merely touching
  // TP1 is NOT proof — the 03:14 rows closed at their break-even locks (+~19 pips) but were
  // graded full targets off a polluted best_price, and that fake "banked win" put the desk
  // into post-win pause + protect-profits mode and held every account out of the real move.
  // The best-touched-TP inference survives ONLY when we have no broker exit at all.
  const exitKnown = exitPrice != null && exitPrice > 0;
  // "Landed at the target" allows for slippage on the take-profit fill: five gold pips (50 cents).
  // Five PIPS on a currency pair is another matter — a sixth of a typical target — and it booked a
  // trail exit a few pips short of the target as the full target, at the target's price rather than
  // the exit's (GEN FX review, 10-02). A take-profit is a limit: it fills at its price or better, so
  // currency pairs get half a pip. Gold and every other instrument are exactly as they were.
  const tpTol = (getInstrument(sym).assetClass === "forex" ? 0.5 : 5) * pip;
  const exitConfirmsTarget = tp1 != null && (
    reason === "target" ||
    (exitKnown && (long ? exitPrice! >= tp1 - tpTol : exitPrice! <= tp1 + tpTol))
  );
  const targetHit = exitKnown || reason === "target" ? exitConfirmsTarget : hitTarget;
  if (row.be_done && targetHit && tp1 != null) {
    return { outcome: "target", result_pips: blend(signed(tp1)), exit_price: tp1, partial_taken: banked };
  }

  const exit = (exitPrice != null && exitPrice > 0)
    ? exitPrice
    : (row.be_done ? (row.cur_stop ?? row.entry) : row.init_stop);
  const exitPips = signed(exit);

  if (row.be_done) {
    const total = blend(exitPips);
    const isBE = Math.abs(exitPips) <= Math.max(1, 0.2 * rPips);
    return { outcome: isBE ? "breakeven" : (exitPips > 0 ? "trail" : "breakeven"), result_pips: total, exit_price: exit, partial_taken: banked };
  }
  if (own) {
    // Never protected, but part of it was banked: a loss only if the whole trade lost.
    const total = blend(exitPips);
    return { outcome: total > 0 ? "trail" : "stop", result_pips: total, exit_price: exit, partial_taken: true };
  }
  if (exitPips > 0) return { outcome: "trail", result_pips: exitPips, exit_price: exit, partial_taken: false };
  return { outcome: "stop", result_pips: exitPips, exit_price: exit, partial_taken: false };
}

/** Read a field from a broker order-history row that may be an OBJECT (by key) or a
 *  columnar ARRAY (by config-derived index in `cols`). Returns undefined if absent. */
function histGet(rowu: unknown, cols: Record<string, number> | undefined, keys: string[]): unknown {
  if (Array.isArray(rowu)) {
    if (!cols) return undefined;
    for (const k of keys) { const i = cols[k]; if (typeof i === "number" && i >= 0 && i < rowu.length) return rowu[i]; }
    return undefined;
  }
  if (rowu && typeof rowu === "object") {
    const o = rowu as Record<string, unknown>;
    for (const k of keys) { if (o[k] !== undefined && o[k] !== null) return o[k]; }
  }
  return undefined;
}

/**
 * Reconcile a CLOSED position against the broker's OWN order history — the source of
 * truth for how a trade actually ended. Returns the real closing fill price and WHY it
 * closed (stop / target / manual), so:
 *   • a stop-out that later rebounds is still booked as the loss the broker realized
 *     (we never classify from a live quote fetched after the position is gone), and
 *   • a hand-close is identified so it can be excluded from the conservative loss streak.
 *
 * The closing execution is a FILLED order on the side OPPOSITE the open (you sell to
 * close a long), matched by positionId when the broker provides it. The order TYPE tells
 * us why: a STOP order = stop-loss, a LIMIT order = take-profit, a MARKET order = a manual
 * user close. SAFE BY DESIGN: if history can't be parsed it returns
 * {exitPrice:null, reason:"unknown"} and the caller falls back to the recorded stop/entry
 * levels (which correctly book a stopped-out trade as a loss) — never to a live quote.
 */
export function reconcileClosedTrade(
  row: Pick<ManagedRow, "position_id" | "side">,
  history: unknown[],
  cols?: Record<string, number>,
): { exitPrice: number | null; reason: CloseReason } {
  const pid = String(row.position_id).toLowerCase();
  const closeSide = row.side === "buy" ? "sell" : "buy";
  const num = (v: unknown) => { const n = typeof v === "string" ? parseFloat(v) : Number(v); return Number.isFinite(n) ? n : null; };
  const str = (v: unknown) => (v == null ? "" : String(v)).toLowerCase();

  const candidates: Array<{ price: number | null; type: string; ts: number }> = [];
  for (const h of history) {
    const hpid = str(histGet(h, cols, ["positionId", "positionID", "posId"]));
    if (hpid && hpid !== pid) continue;                                   // different position
    const status = str(histGet(h, cols, ["status", "orderStatus"]));
    if (status && !/fill|closed|done|executed/.test(status)) continue;    // only realized fills
    const side = str(histGet(h, cols, ["side"]));
    if (side && side !== closeSide) continue;                             // drop the OPEN fill
    const price = num(histGet(h, cols, ["avgPrice", "avgFillPrice", "filledPrice", "fillPrice", "price", "executionPrice"]));
    const type = str(histGet(h, cols, ["type", "orderType"]));
    const tsRaw = histGet(h, cols, ["lastModified", "createdDateTime", "createdDate", "closeTime", "timestamp", "date"]);
    let ts = num(tsRaw);
    if (ts == null) { const p = Date.parse(String(tsRaw ?? "")); ts = Number.isFinite(p) ? p : 0; }
    candidates.push({ price, type, ts });
  }
  if (!candidates.length) return { exitPrice: null, reason: "unknown" };
  candidates.sort((a, b) => b.ts - a.ts);   // the closing execution is the latest matching fill
  const close = candidates[0];
  let reason: CloseReason = "unknown";
  if (/stop/.test(close.type)) reason = "stop";
  else if (/limit/.test(close.type)) reason = "target";
  else if (/market/.test(close.type)) reason = "manual";
  return { exitPrice: close.price != null && close.price > 0 ? close.price : null, reason };
}

/**
 * LEDGER SELF-REPAIR (owner 09-07: "just fix the problem"). Re-grades closed rows whose
 * 'target' outcome was manufactured by a data-insane best_price — the 1038.67 junk tick
 * made the old grader book full-TP wins on positions the broker actually closed at their
 * protective locks (broker screens verified −5/+6/−21 pips on the owner's own accounts,
 * not +160). A best_price more than 20% away from entry is nothing gold ever printed
 * inside one trade — a REAL target only needs price to travel a percent or two — so any
 * 'target' row wearing one is a phantom. It is re-booked at its lock (cur_stop), the
 * repair is logged (phase 'regrade'), and repaired rows stop matching, so this sweep is
 * idempotent and free once clean. 'trail'/'breakeven'/'stop' rows are untouched — their
 * exits came from the broker. New corruption can't recur: live ticks are sanity-bounded
 * at read (extSane) and the grader now requires the exit itself to confirm a target.
 */
export async function repairPhantomTargets(admin: Admin): Promise<number> {
  try {
    const { data } = await admin
      .from("flow_managed_positions")
      .select("id, position_id, account_id, user_id, symbol, side, entry, cur_stop, best_price")
      .eq("status", "closed")
      .eq("outcome", "target")
      .in("symbol", GOLD_CHOP_SYMS)
      .gt("entry", 0)
      // SQL-side candidate prefilter so the 50-row window is spent on corrupted rows, not
      // on legitimate historical wins (the first deploy repaired only 3/pass because the
      // unordered scan window filled with sane rows). Gold has lived nowhere near these
      // bounds; the exact >20%-from-entry check below remains the decider.
      .or("best_price.lt.3000,best_price.gt.7000")
      .limit(50);
    const rows = (data ?? []) as Array<{ id: string; position_id: string; account_id: string | null; user_id: string | null; symbol: string; side: string; entry: number; cur_stop: number | null; best_price: number | null }>;
    let repaired = 0;
    for (const r of rows) {
      const insane = r.best_price != null && r.best_price > 0 && Math.abs(r.best_price - r.entry) / r.entry > 0.2;
      if (!insane) continue; // sane excursion → a real target win; leave it alone
      const pip = getInstrument(contractKey(r.symbol)).pipSize || 0.1;
      const exit = r.cur_stop != null && r.cur_stop > 0 ? r.cur_stop : r.entry;
      const pips = Math.round((r.side === "buy" ? exit - r.entry : r.entry - exit) / pip);
      const { error } = await admin
        .from("flow_managed_positions")
        .update({ outcome: "breakeven", exit_price: exit, result_pips: pips, best_price: exit })
        .eq("id", r.id)
        .eq("outcome", "target"); // guard: never double-repair a row another pass just fixed
      if (error) continue;
      repaired += 1;
      await logTrade(admin, { position_id: r.position_id, account_id: r.account_id ?? "", user_id: r.user_id, symbol: r.symbol, phase: "regrade", reason: "phantom_target_bad_tick", price: exit, detail: { was: "target", now: "breakeven", result_pips: pips } });
    }
    return repaired;
  } catch {
    return 0; // repair is best-effort — never let it disturb live management
  }
}

// The gold symbols the ledger repair above sweeps.
//
// (Until 10-08 this block also held a "chop" regime that pulled the gold PARTIAL in early — 12-22
// pips — when recent trades on a side had gone green and given it back. Partials were off for every
// account from 09-22, so it had stopped doing anything, and now that a member picks a partial it
// banks where they picked it — halfway to the target — not wherever the regime decided. Break-even
// never used it.)
const GOLD_CHOP_SYMS = ["XAUUSD", "GOLD"];

/**
 * Manage every OPEN position FLOW is tracking, per THE RULES in the file header.
 * Safe to call blind — if the tracking table doesn't exist yet, it no-ops.
 */
// Orphan-scan throttle (see below): module-level so the worker's long-lived process
// carries the cadence across passes; on Vercel each invocation starts at 0 and scans
// once — exactly the old cron behavior.
const ORPHAN_SCAN_EVERY_MS = 20_000;
let lastOrphanScanMs = 0;

export async function manageOpenPositions(): Promise<{ managed: number; actions: ManageAction[]; note?: string; settingsUnread?: number }> {
  const admin = createAdminClient();
  if (!admin) return { managed: 0, actions: [], note: "no_admin_client" };

  // ORPHAN RECOVERY: adopt any live broker position FLOW opened but failed to record
  // (entry timeout / crash / missed position-id poll) so it gets managed. Best-effort.
  // THROTTLED to every 20s (worker live 09-10): under the cron this ran once a minute,
  // but the worker calls this function ~3×/sec — and when recent placement events give
  // the scan real broker work, running it EVERY pass stretched each pass to ~8s and
  // starved the actual manage sweep. 20s keeps adoption faster than the old cron ever
  // was while the sweep itself runs at full tick speed.
  if (Date.now() - lastOrphanScanMs > ORPHAN_SCAN_EVERY_MS) {
    lastOrphanScanMs = Date.now();
    try { await recoverOrphans(admin); } catch { /* recovery is best-effort */ }
    // GENX 2.0 bounded validity: sweep stale account reservations — released rows and
    // expired 'active' rows (a dead submit attempt; the open-position backstop still guards
    // a silently-filled order). 'filled'/'unknown' are only cleared once no open position
    // remains for that account+symbol. Best-effort, throttled with orphan recovery.
    try { await admin.rpc("genx_reconcile_stale_reservations", { p_max_age_secs: 900 }); } catch { /* best-effort */ }
    // GENX 2.0 cancel-on-invalidation: withdraw resting GTC gold entries that have out-stayed
    // their bounded validity (price moved away from the cap, so the entry would now chase),
    // with fill-vs-cancel race handling — a filled order can't be cancelled, so the account is
    // freed only on a broker-confirmed cancel. Best-effort, throttled with orphan recovery.
    try { await reconcileStaleGoldEntries(); } catch { /* best-effort */ }
  }

  const { data, error } = await admin
    .from("flow_managed_positions")
    .select("*")
    .eq("status", "open")
    .order("updated_at", { ascending: true })
    .limit(MAX_PER_TICK);
  if (error) return { managed: 0, actions: [], note: `no_table: ${error.message}`.slice(0, 120) };
  const rows = (data ?? []) as ManagedRow[];
  if (!rows.length) return { managed: 0, actions: [] };

  // PASS-START TOUCH — stamp every row this pass will cover, in ONE write. Rows used to be
  // touched only as each FINISHED, so with many open positions + serialized broker calls the
  // tail of the list went "stale" (>160s) while the manager was actively working the list —
  // firing false "system DOWN — N open position(s) not managed" alarms (live 08-28: 11:43 PM
  // and 11:59 PM with 13/12 open, manager healthy both times per the watchdog's own "no
  // stalled component"). Staleness now measures "no pass is covering this position" — a
  // genuine outage still alarms, a long pass never does.
  try { await admin.from("flow_managed_positions").update({ updated_at: new Date().toISOString() }).in("id", rows.map((r) => r.id)); } catch { /* liveness stamp best-effort */ }

  // EACH ACCOUNT'S THREE CHOICES — break-even, follow price, partials (manageSettings.ts, owner 10-08) —
  // loaded once for every account this pass. They replaced the one "AI Pips" switch (09-22), and an
  // account that had it on reads as break-even at its own pips + follow price Normal + no partials,
  // which is exactly what AI Pips ran; off reads as all three off. Rows for one broker account combine
  // the way they always did: off on any row wins (mergeMgmt).
  //
  // A READ THAT FAILS IS NOT "AI PIPS ON" (review, 10-08). Only a database that lacks the new columns is
  // read with fewer of them. A timeout or a server error is something else: the account's settings as
  // last read stand in (for as long as the reads keep failing), and an account never read since this
  // process started is left alone until one succeeds — counted in the manager's health beat. A member
  // who switched break-even off must never have a stop moved by a blip.
  const acctIds = [...new Set(rows.map((r) => String(r.account_id)))];
  const mgmtRows = new Map<string, MgmtRow[]>();
  let mgmtRead = false;
  try {
    if (acctIds.length) {
      for (const cols of [
        "account_id, manage_trades, gold_be_pips, be_enabled, trail_mode, partial_pct",
        "account_id, manage_trades, gold_be_pips",
        "account_id, manage_trades",
      ]) {
        const got = await admin.from("flow_broker_accounts").select(cols).in("account_id", acctIds);
        if (got.error) { if (missingColumn(got.error)) continue; break; }
        for (const a of (got.data ?? []) as unknown as Array<MgmtRow & { account_id: string }>) {
          const id = String(a.account_id);
          if (!mgmtRows.has(id)) mgmtRows.set(id, []);
          mgmtRows.get(id)!.push(a);
        }
        mgmtRead = true;
        break;
      }
    }
  } catch { /* unread — see mgmtOf */ }
  if (mgmtRead) {
    if (lastMgmt.size > 20_000) lastMgmt.clear();
    for (const id of acctIds) lastMgmt.set(id, { at: Date.now(), rows: mgmtRows.get(id) ?? [] });
  }
  const mgmtCache = new Map<string, Mgmt | null>();
  /** This account's settings, or null when they could not be read and none were read recently. */
  const mgmtOf = (accountId: string): Mgmt | null => {
    if (mgmtCache.has(accountId)) return mgmtCache.get(accountId)!;
    let m: Mgmt | null = null;
    if (mgmtRead) m = mergeMgmt(mgmtRows.get(accountId) ?? []);
    else { const last = lastMgmt.get(accountId); if (last) m = mergeMgmt(last.rows); }
    mgmtCache.set(accountId, m);
    return m;
  };

  // PROFIT GUARD — the reversal snap that is part of follow price. Gold's structure flip, read ONCE per
  // pass, and only when an account in it has follow price on, so the feed call costs nothing otherwise.
  let guardChoch: "bullish" | "bearish" | null = null;
  if (rows.some((r) => (mgmtOf(String(r.account_id))?.follow ?? "off") !== "off")) { try { guardChoch = await goldChangeOfCharacter(); } catch { /* no flip on read error */ } }

  const tokenCache = new Map<string, { token: string; env: TLEnv } | null>();
  const colCache = new Map<string, { avgIdx: number; uplIdx: number; slIdx: number; qtyIdx: number; tpIdx: number }>();
  const histColCache = new Map<string, Record<string, number> | undefined>();
  const acctCache = new Map<string, { openIds: Set<string>; avgPx: Map<string, number>; upl: Map<string, number>; qty: Map<string, number>; sl: Map<string, number>; tp: Map<string, number>; instruments: TLInstrument[] } | null>();
  const quoteCache = new Map<string, { at: number; price: number }>();
  // Live bid/ask spread per env+symbol this tick — the BE lock must clear it (owner 09-07:
  // a Sunday-night $2.9 gold spread filled a +5-pip lock $2.9 through the stop → -30 pips).
  const spreadCache = new Map<string, number>();

  const actions: ManageAction[] = [];

  async function tokenFor(connId: string): Promise<{ token: string; env: TLEnv } | null> {
    if (tokenCache.has(connId)) return tokenCache.get(connId)!;
    const hit = _connTokCache.get(connId);
    if (hit && Date.now() - hit.at < CONN_TOKEN_TTL_MS) { tokenCache.set(connId, hit.v); return hit.v; }
    const t = await connectionToken(connId);
    const v = t.ok ? { token: t.token, env: t.env } : null;
    tokenCache.set(connId, v);
    if (v) _connTokCache.set(connId, { at: Date.now(), v });
    return v;
  }

  // The broker returns positions as columnar arrays; the column ORDER comes from the account
  // config's positionsConfig. Read it once per connection to find the avgPrice (real fill)
  // and unrealizedPl columns — so we never hardcode a fragile index. Falls back to the
  // documented TradeLocker layout (avgPrice at index 5) if the config can't be parsed.
  async function colsFor(connId: string, tok: { token: string; env: TLEnv }, accNum: string): Promise<{ avgIdx: number; uplIdx: number; slIdx: number; qtyIdx: number; tpIdx: number }> {
    if (colCache.has(connId)) return colCache.get(connId)!;
    const modHit = _colsCacheMod.get(connId);
    if (modHit && Date.now() - modHit.at < COLS_TTL_MS) { colCache.set(connId, modHit.v); return modHit.v; }
    let v = { avgIdx: 5, uplIdx: -1, slIdx: -1, qtyIdx: -1, tpIdx: -1 };
    try {
      const cfg = await getConfig(tok.env, tok.token, accNum);
      if (cfg.ok) {
        const d = ((cfg.data as Record<string, unknown>)?.d ?? cfg.data) as Record<string, unknown>;
        const raw = d?.positionsConfig as unknown;
        const cols = (Array.isArray(raw) ? raw : (raw as Record<string, unknown>)?.columns) as unknown[] | undefined;
        if (Array.isArray(cols) && cols.length) {
          const idOf = (c: unknown) => String((c as Record<string, unknown>)?.id ?? (c as Record<string, unknown>)?.key ?? (c as Record<string, unknown>)?.name ?? "");
          const ai = cols.findIndex((c) => idOf(c) === "avgPrice");
          const ui = cols.findIndex((c) => UPL_KEYS.includes(idOf(c)));
          // stopLoss price column (for read-back verification). -1 if the broker doesn't
          // carry the SL on the position row → verification falls back to trusting the ack.
          const si = cols.findIndex((c) => { const id = idOf(c).toLowerCase(); return id === "stoploss" || id === "stoplossprice" || id === "sl"; });
          // qty column (for partial-close idempotency / broker-truth reconciliation).
          const qi = cols.findIndex((c) => { const id = idOf(c).toLowerCase(); return id === "qty" || id === "quantity" || id === "volume" || id === "positionqty"; });
          // takeProfit price column (for the missing-TP self-heal). -1 → self-heal is skipped
          // for this connection (we never re-attach blind, only against a broker read-back).
          const ti = cols.findIndex((c) => { const id = idOf(c).toLowerCase(); return id === "takeprofit" || id === "takeprofitprice" || id === "tp"; });
          if (ai >= 0) v = { avgIdx: ai, uplIdx: ui, slIdx: si, qtyIdx: qi, tpIdx: ti };
          else v = { ...v, slIdx: si, qtyIdx: qi, tpIdx: ti };
        }
      }
    } catch { /* keep defaults */ }
    colCache.set(connId, v);
    if (v.avgIdx !== 5 || v.uplIdx >= 0 || v.slIdx >= 0 || v.qtyIdx >= 0 || v.tpIdx >= 0) _colsCacheMod.set(connId, { at: Date.now(), v }); // only cache a PARSED layout across passes, never the blind fallback
    return v;
  }

  // ordersHistory rows come back columnar too; the column ORDER is in the account
  // config's ordersHistoryConfig. Build a fieldName→index map once per connection so the
  // outcome reconciler can read positionId/side/type/status/price from an array row.
  // undefined (config missing/unparseable) → reconciler treats array rows as unparseable
  // and the caller falls back to the recorded levels — never a live quote.
  async function histColsFor(connId: string, tok: { token: string; env: TLEnv }, accNum: string): Promise<Record<string, number> | undefined> {
    if (histColCache.has(connId)) return histColCache.get(connId);
    let map: Record<string, number> | undefined;
    try {
      const cfg = await getConfig(tok.env, tok.token, accNum);
      if (cfg.ok) {
        const d = ((cfg.data as Record<string, unknown>)?.d ?? cfg.data) as Record<string, unknown>;
        const raw = d?.ordersHistoryConfig as unknown;
        const cols = (Array.isArray(raw) ? raw : (raw as Record<string, unknown>)?.columns) as unknown[] | undefined;
        if (Array.isArray(cols) && cols.length) {
          const idOf = (c: unknown) => String((c as Record<string, unknown>)?.id ?? (c as Record<string, unknown>)?.key ?? (c as Record<string, unknown>)?.name ?? "");
          map = {};
          cols.forEach((c, i) => { const id = idOf(c); if (id) map![id] = i; });
        }
      }
    } catch { /* keep undefined */ }
    histColCache.set(connId, map);
    return map;
  }

  async function acctState(tok: { token: string; env: TLEnv }, accNum: string, accountId: string, cols: { avgIdx: number; uplIdx: number; slIdx: number; qtyIdx: number; tpIdx: number }) {
    const key = `${accountId}`;
    if (acctCache.has(key)) return acctCache.get(key)!;
    let pos = await listPositions(tok.env, tok.token, accNum, accountId);
    const instHit = _instCache.get(String(accountId));
    let inst = (instHit && Date.now() - instHit.at < INSTRUMENT_TTL_MS)
      ? { ok: true as const, data: instHit.data }
      : await listInstruments(tok.env, tok.token, accNum, accountId);
    // ONE in-tick retry on a failed read (owner incident 08-31: intermittent account reads on
    // one connection left its positions unmanaged — break-even never fired and the member had
    // to move his stop by hand). A short settle + retry rides out the transient blips that a
    // concurrent app login / token rotation causes on TradeLocker.
    if (!pos.ok || !inst.ok) {
      await new Promise((r) => setTimeout(r, 400));
      if (!pos.ok) pos = await listPositions(tok.env, tok.token, accNum, accountId);
      if (!inst.ok) inst = await listInstruments(tok.env, tok.token, accNum, accountId);
    }
    const avgPx = new Map<string, number>();
    const upl = new Map<string, number>();
    const qty = new Map<string, number>();
    const sl = new Map<string, number>();
    const tpm = new Map<string, number>();
    if (pos.ok) for (const p of pos.data) {
      const id = posIdOf(p);
      if (!id) continue;
      const a = numAt(p, cols.avgIdx, AVG_KEYS); if (a != null && a > 0) avgPx.set(id, a);
      const u = numAt(p, cols.uplIdx, UPL_KEYS); if (u != null) upl.set(id, u);
      const qn = numAt(p, cols.qtyIdx, QTY_KEYS); if (qn != null && qn > 0) qty.set(id, qn);
      const s = numAt(p, cols.slIdx, SL_KEYS); if (s != null && s > 0) sl.set(id, s);
      const t = numAt(p, cols.tpIdx, TP_KEYS); if (t != null && t > 0) tpm.set(id, t);
    }
    const v = pos.ok && inst.ok
      ? { openIds: new Set(pos.data.map(posIdOf).filter(Boolean)), avgPx, upl, qty, sl, tp: tpm, instruments: inst.data }
      : null;
    // NEVER cache a failed read: a null in the cache would black out EVERY position on this
    // account for the rest of the tick. Failures fall through so the next row retries fresh.
    if (v) acctCache.set(key, v);
    if (inst.ok && (!instHit || Date.now() - instHit.at >= INSTRUMENT_TTL_MS)) _instCache.set(String(accountId), { at: Date.now(), data: inst.data });
    return v;
  }

  // Current EXIT price for a side (bid for a long you'd sell, ask for a short you'd buy back)
  // — conservative, so break-even/partials can't fire off a stale/one-sided quote. Cached
  // per account+symbol for the tick.
  async function exitPrice(tok: { token: string; env: TLEnv }, accNum: string, inst: TLInstrument, symbol: string, side: "buy" | "sell", accountId: string): Promise<number | null> {
    const key = `${tok.env}|${accountId}|${inst.tradableInstrumentId}|${inst.infoRouteId || inst.routeId}|${side}`;
    const cached = quoteCache.get(key);
    if (cached && Date.now() - cached.at < 1000) return cached.price;
    const bKey = `${tok.env}|${accountId}|${symbol}`;
    if (contractKey(symbol) === "XAUUSD") {
      const cal = brokerBasis.get(bKey), tick = liveTick("XAU/USD", STREAM_MAX_AGE_MS);
      if (cal && tick != null && Date.now() - cal.at < QUOTE_CALIBRATE_MS) {
        const px = +streamExitPrice(side, tick, cal.basis, cal.spread).toFixed(3);
        if (px > 0) { spreadCache.set(bKey, cal.spread); quoteCache.set(key, { at: Date.now(), price: px }); return px; }
      }
    }
    const q = await getQuote(tok.env, tok.token, accNum, inst.tradableInstrumentId, inst.infoRouteId || inst.routeId);
    if (!q.ok) {
      const fb = await feedPrice(symbol);
      if (fb == null || !(fb > 0)) return null;
      quoteCache.set(key, { at: Date.now(), price: fb });
      return fb;
    }
    const { bid, ask } = q.data;
    if (bid != null && ask != null && ask < bid) return null;
    if (bid != null && ask != null) {
      spreadCache.set(`${tok.env}|${accountId}|${symbol}`, ask - bid);
      const tick = liveTick("XAU/USD", STREAM_MAX_AGE_MS);
      if (contractKey(symbol) === "XAUUSD" && tick != null) { brokerBasis.set(bKey, { at: Date.now(), basis: (bid + ask) / 2 - tick, spread: ask - bid }); if (brokerBasis.size > 5000) brokerBasis.clear(); }
    }
    const price = executablePrice(q.data, side, "exit");
    if (price == null || !Number.isFinite(price) || price <= 0) {
      // Broker quote unusable → fall back to the market-data feed rather than
      // abandoning the position for this tick. A missing quote must never stall
      // break-even/trailing on a live trade (owner: trade safety first).
      const fb = await feedPrice(symbol);
      if (fb == null || !(fb > 0)) return null;
      quoteCache.set(key, { at: Date.now(), price: fb });
      return fb;
    }
    quoteCache.set(key, { at: Date.now(), price });
    return price;
  }

  // An acknowledgement alone is never proof of protection. Some brokers expose
  // stops only as linked orders, so read both supported representations.
  async function verifyStop(t: { token: string; env: TLEnv }, accNum: string, accountId: string, positionId: string, slIdx: number, symbol: string, requested: number): Promise<boolean> {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const actual = await readProtectiveStop(t.env, t.token, accNum, accountId, positionId);
      return actual != null && slWithinTolerance(symbol, requested, actual);
    } catch { return false; }
  }

  // After a partial close, read the broker back to learn the ACTUAL remaining quantity
  // (source of truth) rather than trusting a computed remainder. Returns null if the broker
  // doesn't expose qty or the read fails (caller then keeps the pre-existing computed path).
  async function readBrokerQty(t: { token: string; env: TLEnv }, accNum: string, accountId: string, positionId: string, qtyIdx: number): Promise<number | null> {
    if (qtyIdx < 0) return null;
    await new Promise((r) => setTimeout(r, 500));
    const pos = await listPositions(t.env, t.token, accNum, accountId);
    if (!pos.ok) return null;
    for (const p of pos.data) { if (posIdOf(p) === String(positionId)) return numAt(p, qtyIdx, QTY_KEYS); }
    return null;
  }

  // The connection lanes below fetch their own state. Avoid a book-wide
  // prefetch barrier that makes ready accounts wait for the slowest broker.
  let managed = 0;
  let settingsUnread = 0;   // positions left alone this pass because their account's settings could not be read
  let lastBeatMs = Date.now();
  const processRow = async (row: ManagedRow): Promise<void> => {
    if (Date.now() - lastBeatMs > 15_000) {
      try { await beat(admin, "manager", { inPass: true, managed }); } catch { /* liveness best-effort */ }
      lastBeatMs = Date.now();
    }
    try {
      const tok = await tokenFor(row.connection_id);
      if (!tok) { await admin.from("flow_managed_positions").update({ last_error: "token", updated_at: new Date().toISOString() }).eq("id", row.id); return; }

      const cols = await colsFor(row.connection_id, tok, row.acc_num);
      const st = await acctState(tok, row.acc_num, row.account_id, cols);
      if (!st) {
        _invalidateConnToken(row.connection_id); // maybe an expired cached token — force a fresh mint next tick
        await admin.from("flow_managed_positions").update({ last_error: "account_read", updated_at: new Date().toISOString() }).eq("id", row.id); return;
      }
      // Read succeeded → clear a stale read/token error so diagnostics reflect reality.
      if (row.last_error === "account_read" || row.last_error === "token") {
        try { await admin.from("flow_managed_positions").update({ last_error: null }).eq("id", row.id); } catch { /* cosmetic */ }
        row.last_error = null;
      }

      // Position gone from the broker → it closed (SL/TP hit, or member closed it). Require
      // BOTH ≥3 consecutive misses AND ≥45s elapsed before booking closed — a fresh fill or a
      // transiently-incomplete (but ok) positions read can omit a position for a few ticks, and
      // at the 4s loop cadence a pure tick-count of 3 would abandon a still-open position after
      // only ~12s. Wall-clock gating keeps ~45s of tolerance regardless of loop speed, so an
      // in-profit position is never booked closed (as a loss) and left unmanaged.
      if (!st.openIds.has(String(row.position_id))) {
        const gm = /^gone_(\d+)(?:_(\d+))?$/.exec(typeof row.last_error === "string" ? row.last_error : "");
        const goneN = gm ? (parseInt(gm[1]) || 0) : 0;
        const firstMs = gm && gm[2] ? (parseInt(gm[2]) || Date.now()) : Date.now();
        const elapsed = Date.now() - firstMs;
        if (goneN < 2 || elapsed < 45_000) {
          await admin.from("flow_managed_positions").update({ last_error: `gone_${goneN + 1}_${firstMs}`, updated_at: new Date().toISOString() }).eq("id", row.id);
          actions.push({ positionId: row.position_id, symbol: row.symbol, account: row.acc_num, action: "gone_wait", detail: `${goneN + 1} · ${Math.round(elapsed / 1000)}s` });
          return;
        }
        // SOURCE OF TRUTH = the broker's OWN order history, not a live quote fetched after
        // the position is already gone. A stop-out that rebounds within the reconciliation
        // window must still book the loss the broker realized; a hand-close must be tagged
        // 'manual' so it is excluded from the conservative loss streak. If history can't be
        // read/parsed we fall back to the recorded stop/entry levels (which correctly book a
        // stopped-out trade as a loss) — the post-close live quote is never used to classify.
        let rec: { exitPrice: number | null; reason: CloseReason } = { exitPrice: null, reason: "unknown" };
        try {
          const hist = await listOrdersHistory(tok.env, tok.token, row.acc_num, row.account_id);
          if (hist.ok) {
            const hcols = await histColsFor(row.connection_id, tok, row.acc_num);
            rec = reconcileClosedTrade(row, hist.data, hcols);
          }
        } catch { /* history unavailable → safe fallback below */ }
        const oc = classifyOutcome(row, rec.exitPrice, rec.reason);
        await admin.from("flow_managed_positions").update({
          status: "closed", last_error: null,
          outcome: oc.outcome, result_pips: oc.result_pips, exit_price: oc.exit_price, partial_taken: oc.partial_taken,
          resolved_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        }).eq("id", row.id);
        // RULE #1: the position is broker-confirmed CLOSED, so the account is free for the
        // next automated gold entry — release the reservation (reconciled-before-release).
        // 09-22: releases the side-keyed reservation this trade holds AND the legacy plain-symbol one,
        // so a desk mid-way through the switch never leaves an account locked by the key it is not using.
        if (contractKey(row.symbol) === "XAUUSD") {
          try { await releaseGold(admin, row.account_id, goldResvKey("XAUUSD", row.side)); } catch { /* best-effort */ }
          try { await releaseGold(admin, row.account_id, "XAUUSD"); } catch { /* best-effort */ }
        }
        actions.push({ positionId: row.position_id, symbol: row.symbol, account: row.acc_num, action: "closed", detail: `${oc.outcome}[${rec.reason}] ${oc.result_pips>0?"+":""}${oc.result_pips}p` });
        await logTrade(admin, { position_id: row.position_id, account_id: row.account_id, user_id: row.user_id, symbol: row.symbol, phase: "closed", reason: `${oc.outcome}/${rec.reason}`, price: oc.exit_price, detail: { result_pips: oc.result_pips, partial_taken: oc.partial_taken } });
        return;
      }

      const inst = matchInstrument(contractKey(row.symbol), st.instruments) ?? matchInstrument(row.symbol, st.instruments);
      if (!inst) { await admin.from("flow_managed_positions").update({ last_error: "no_instrument", updated_at: new Date().toISOString() }).eq("id", row.id); return; }

      const price = await exitPrice(tok, row.acc_num, inst, row.symbol, row.side, row.account_id);
      if (price == null || !(price > 0)) { await admin.from("flow_managed_positions").update({ last_error: "no_quote", updated_at: new Date().toISOString() }).eq("id", row.id); return; }

      const long = row.side === "buy";
      const pip = getInstrument(contractKey(row.symbol)).pipSize || 0.0001;
      const update: Record<string, unknown> = { last_error: null, updated_at: new Date().toISOString() };
      let didAction = false;

      // ── RE-ANCHOR TO THE REAL FILL. The row was recorded with the SIGNAL's entry, which is
      //    identical for every account — but each account fills at its OWN price. Anchoring
      //    break-even/partials to the signal price makes "break-even" a real loss and banks
      //    losers as wins. Trust the broker's average open price whenever it's available and
      //    within a sane band of the recorded entry; persist the correction so the math and the
      //    track record use the true entry. ──
      const brokerAvg = st.avgPx.get(String(row.position_id)) ?? null;
      let entry = row.entry;
      if (brokerAvg != null) {
        const band = Math.max(row.entry * 0.02, Math.abs(row.entry - row.init_stop) * 6);
        if (Math.abs(brokerAvg - row.entry) <= band) entry = brokerAvg;
      }
      if (Math.abs(entry - row.entry) > pip * 2) {
        const newR = Math.abs(entry - row.init_stop);
        const slipPips = Math.round((entry - row.entry) / pip);
        update.entry = entry; update.r = newR;
        actions.push({ positionId: row.position_id, symbol: row.symbol, account: row.acc_num, action: "reanchor", detail: `entry ${row.entry.toFixed(2)}→${entry.toFixed(2)}` });
        await logTrade(admin, { position_id: row.position_id, account_id: row.account_id, user_id: row.user_id, symbol: row.symbol, phase: "fill_reconciled", reason: "reanchor_to_broker_fill", price: entry, detail: { signalEntry: row.entry, brokerFill: entry, slippagePips: slipPips } });
        row.entry = entry; row.r = newR;
      }

      // ── PARTIAL IDEMPOTENCY: reconcile the recorded qty against BROKER TRUTH before any
      //    partial decision. If a partial executed at the broker but wasn't recorded (API
      //    timeout / crash / lost DB write), the broker now holds less than the recorded full
      //    size — detect that here, mark the partial done, and adopt the real qty, so the
      //    partial block below can NEVER fire a second time. ──
      const brokerQty = cols.qtyIdx >= 0 ? (st.qty.get(String(row.position_id)) ?? null) : null;
      const recon = reconcilePartialQty(row.qty, !!row.partial_done, brokerQty);
      if (recon.reconciled !== "none") {
        update.qty = recon.qty; row.qty = recon.qty;
        if (recon.partialDone && !row.partial_done) { update.partial_done = true; row.partial_done = true; partialRecheckAt.delete(`${tok.env}|${row.account_id}|${row.position_id}`); }
        if (recon.reconciled === "partial_detected") { actions.push({ positionId: row.position_id, symbol: row.symbol, account: row.acc_num, action: "partial_reconciled", detail: `broker qty ${recon.qty}` }); await logTrade(admin, { position_id: row.position_id, account_id: row.account_id, user_id: row.user_id, symbol: row.symbol, phase: "partial_reconciled", reason: "broker_qty_reduced", qty: recon.qty }); }
      }

      const R = row.r && row.r > 0 ? row.r : Math.abs(entry - row.init_stop);
      if (!(R > 0)) { await admin.from("flow_managed_positions").update({ last_error: "no_R", updated_at: new Date().toISOString() }).eq("id", row.id); return; }

      // FAVORABLE EXCURSION: the best price the trade actually reached (current sample + recent
      // 1-min candle extremes), so a spike that reversed inside the once-a-minute window still
      // counts toward the triggers.
      // BAD-TICK GUARD (owner 09-07): the 03:14 batch recorded best_price 1038.67 on live gold
      // trading at ~4407 — one junk candle in the feed instantly "reached" every trigger and
      // graded two positions as fake targets. An extreme more than 2% away from the live price
      // is data, not market — ignore it. (A real $17 Asia spike is ~0.4%; 2% of gold ≈ $88.)
      const extSane = (x: number | null | undefined): number | null =>
        x != null && x > 0 && Math.abs(x - price) / price <= 0.02 ? x : null;
      const ext = await feedExtremes(row.symbol, row.created_at ? Date.parse(row.created_at) : null);
      const favRaw = long
        ? Math.max(price, extSane(ext?.high) ?? price)
        : Math.min(price, extSane(ext?.low) ?? price);
      const bestPrev = row.best_price ?? entry;
      const best = long ? Math.max(bestPrev, favRaw) : Math.min(bestPrev, favRaw);
      update.best_price = best;

      /*
       * ADVERSE EXCURSION (owner 09-25: "the stops, do they need to be that large? Can they maybe
       * be smaller?").
       *
       * The honest answer today is that nobody can know, because we only ever recorded the
       * favourable side. Whether a 110-pip stop can safely become 70 depends entirely on how deep a
       * WINNING trade dips before it turns — and that number exists nowhere in the system. Tightening
       * a stop against the favourable-excursion data alone is the classic way to build a backtest
       * that looks wonderful and loses money live: it counts every loser you would have cut smaller
       * and none of the winners you would have cut out.
       *
       * So record it, with the same bad-tick guard and the same ratchet as best_price, and the
       * question becomes answerable from real fills in a couple of weeks instead of arguable forever.
       */
      const advRaw = long
        ? Math.min(price, extSane(ext?.low) ?? price)
        : Math.max(price, extSane(ext?.high) ?? price);
      const worstPrev = row.worst_price ?? entry;
      update.worst_price = long ? Math.min(worstPrev, advRaw) : Math.max(worstPrev, advRaw);

      // This account's choices (manageSettings.ts). `follow` is already "off" when break-even is off.
      const m = mgmtOf(String(row.account_id)) ?? SETTINGS_UNREAD;
      if (m === SETTINGS_UNREAD) { update.last_error = "settings_unread"; settingsUnread += 1; }
      const manageOn = m.manage;
      const beOn = m.breakEven;
      const follow = m.follow;
      const partialFrac = m.partialPct / 100;
      const partialOn = partialFrac > 0;

      // ── THE LEVELS ──────────────────────────────────────────────────────────────────────
      const tp = row.tp1 != null && row.tp1 > 0 ? row.tp1 : null;
      const towardTp = tp != null && (long ? tp > entry : tp < entry);
      const halfway = towardTp ? (entry + tp!) / 2 : null;    // halfway to the plan's own target

      // GOLD BREAK-EVEN RULE (owner 09-07, after the 03:07-03:18 batch): the trigger is the
      // gold-pips distance FROM THE REAL FILL — the pips the account picked (20/30/40/50, or an
      // older number of its own), 30 if it never picked — and NOTHING ELSE. No halfway-to-TP
      // shortcut, no +1R shortcut, nothing that pulls it in ("it NEVER went 30+ pips in profit so
      // why are you closing it"). That batch fired BE at 14-22 pips because a regime had shrunk the
      // trigger; every one of those locks then filled slightly negative in the thin market.
      const goldPips = contractKey(row.symbol) === "XAUUSD" ? m.goldBePips : undefined;
      const beByPips = typeof goldPips === "number" && goldPips > 0
        ? (long ? entry + goldPips * pip : entry - goldPips * pip)
        : null;
      const beFloor = long ? entry + BE_MIN_PIPS * pip : entry - BE_MIN_PIPS * pip;
      // GOLD: the gold-pips trigger stands alone. NON-GOLD (no pips trigger): earliest of
      // {halfway, +1R}, floored so it can never sit closer than BE_MIN_PIPS to entry.
      const beCandidates = beByPips != null
        ? [beByPips]
        : [halfway, long ? entry + R : entry - R].filter((x): x is number => x != null);
      let beTriggerPx = long ? Math.min(...beCandidates) : Math.max(...beCandidates);
      beTriggerPx = long ? Math.max(beTriggerPx, beFloor) : Math.min(beTriggerPx, beFloor);

      // THE PARTIAL POINT (owner 10-08: "bank 25% or 50% halfway to target"): halfway to the target
      // the trade will actually close at — the broker's own take-profit when the account shows it,
      // else the near target FLOW parks for gold (nearTarget.ts), else the plan's target. Halfway to
      // GENX's far 1.9R plan would sit past the gold take-profit, and the partial would never come.
      const nearPx = nearTargetApplies(row.symbol) ? nearTargetPrice(row.side as "buy" | "sell", entry, row.init_stop, pip, tp) : null;
      const targetPx = targetInForce(row.side, entry, [st.tp.get(String(row.position_id)) ?? null, nearPx, tp]);
      const partialTriggerPx = partialTriggerPrice(entry, targetPx);

      // BREAK-EVEN TRIGGERS ON THE LIVE MARKET, NOT ON HISTORY (owner 09-07): "I want it to
      // move when the market goes 30-35 pips into profit and move immediately." The manage
      // loop samples the live price every ~2.5s — when a sample sees the market AT the
      // trigger, the stop moves right then. What it must NOT do is fire off a candle wick
      // that already reversed ("it just saw that a candle went that far") — moving the stop
      // a minute after a spike that's gone locks a pullback into a scratch-out on a trade
      // that's still working. So BE compares the CURRENT price only; best_price still tracks
      // the full excursion for grading and stats.
      const favReachedBE = long ? price >= beTriggerPx : price <= beTriggerPx;
      // WICK-ASSISTED BE (owner 09-09: entry 4400.81, wick to 4396.43 = 44 pips in favor,
      // yet 4 of 5 legs never locked BE because no live SAMPLE caught the spike). If the
      // tracked extreme (bad-tick-guarded, monotonic best) shows the trigger was REACHED,
      // BE may fire even though this tick's sample missed it — but ONLY through the same
      // beSafe gate below, which requires the LIVE price to still sit safely beyond the
      // profit lock. That guard is what makes this different from the 09-07 candle-trigger
      // bug: a spike that fully reversed fails beSafe and locks nothing, so a working trade
      // can never be scratched out by a dead wick.
      const wickReachedBE = long ? best >= beTriggerPx : best <= beTriggerPx;
      // A PARTIAL banks on the LIVE price only (10-08). It closes part of the trade at the market, so a
      // wick that touched the halfway mark and came back would bank that share wherever price has fallen
      // to — "halfway to target" would quietly become "a few pips up". Until 09-22 this read the wick,
      // when the manager ran once a minute and could miss the touch; it now samples several times a second.
      const partialReached = partialTriggerPx != null && (long ? price >= partialTriggerPx : price <= partialTriggerPx);

      // HARD PROFIT GUARD — broker's own truth. Prefer the position's unrealized P&L; else fall
      // back to price beyond the real fill. We NEVER move to break-even or bank a partial unless
      // this is satisfied, so a "partial" can never execute at a loss.
      const brokerUpl = st.upl.get(String(row.position_id)) ?? null;
      const priceInProfit = long ? price > entry : price < entry;
      // In profit if the market is beyond the REAL fill (priceInProfit, the ground truth once
      // entry is re-anchored) OR the broker's unrealized P&L is positive. Using OR — not "trust
      // upl only" — so a mis-read/zero upl can't block a genuinely-profitable trade from moving
      // to break-even. Every BE + partial also separately requires priceInProfit, so this can
      // still never bank a partial at a loss.
      const inProfit = priceInProfit || (brokerUpl != null && brokerUpl > 0);
      // BE stop = entry pushed BE_PROFIT_PIPS into profit (owner 09-03) so fees never turn a
      // protected trade into a loss. Only moved when the market is safely beyond it (beSafe),
      // so the modify can't be rejected or instantly close the position.
      // SPREAD-AWARE LOCK (owner 09-07): the +5-pip lock is meaningless if the broker's
      // spread is wider — the 09-06 Sunday-night close triggered a 4421.91 lock and FILLED
      // at 4424.82 (-30 pips) because the feed's spread was ~$2.9. Push the lock deeper
      // into profit by the live spread (clamped to 40 pips so a bad quote can't distort it),
      // so a fill one spread through the stop still lands at or better than the +5-pip lock.
      // THIN-HOURS SLIPPAGE FLOOR (owner 09-07: "stop closing in negative"). The live spread
      // at SET time is not enough — the lock has to survive the FILL, and 09-07 03:18 proved
      // a vertical Asia-session spike fills ~10 pips through a stop that was quoted at a
      // 2-pip spread minutes earlier. During the thin window (21:00–07:00 UTC: rollover +
      // Asia) the cushion floors at 20 pips; in liquid hours at 5 pips; the live spread
      // still wins when it is wider. Capped at 40 pips so a junk quote can't distort it.
      // BE trigger is 30 pips, so even the deep thin-hours lock stays inside the trigger.
      const utcH = new Date().getUTCHours();
      const thinHours = utcH >= 21 || utcH < 7;
      // LIQUID-HOURS FLOOR RAISED 5→12 (owner 09-08: "positions ending not in profit after
      // doing break even"): the 09-08 17:54 UTC spike filled a lock that sat 14 pips in
      // profit 25 pips through it (−$138 on 1.08 lots). A stop becomes a market order when
      // touched — no cushion can beat every vertical candle — but at 12 pips + live spread
      // the lock sits ~15+ pips into profit (still inside the 30-pip trigger), so ordinary
      // 5-10 pip spike slippage keeps printing green instead of small red scratches.
      // The 12/20-pip cushion floors were derived from GOLD's live slippage history
      // (pip = $0.10 → 12 pips = $1.20 of spike room). Applied to FOREX they were ~10×
      // too big relative to real spreads (~0.5-2 pips on EURUSD): the lock sat so deep
      // that break-even couldn't fire until ~19 pips of profit even when the trigger said
      // 8-12 (09-11 audit finding). Non-gold floors at 3 pips; the LIVE spread still wins
      // whenever it's wider, and the 40-pip cap guards junk quotes on every symbol.
      const padFloor = (contractKey(row.symbol) === "XAUUSD" ? (thinHours ? 20 : 12) : 3) * pip;
      const spreadPad = Math.min(Math.max(spreadCache.get(`${tok.env}|${row.account_id}|${row.symbol}`) ?? 0, padFloor), 40 * pip);
      const bePx = roundPx(row.symbol, long ? entry + BE_PROFIT_PIPS * pip + spreadPad : entry - BE_PROFIT_PIPS * pip - spreadPad);
      const beSafe = long ? price > bePx + 2 * pip : price < bePx - 2 * pip;

      // ── STEP 0: ADOPT a break-even that already exists on the BROKER. The broker is the
      //    source of truth: if the live SL already sits at/beyond entry — the owner moved it
      //    manually, or a previous modify acked without a confirmed read-back — record BE as
      //    done instead of re-sending modifies forever ("Nothing to change") with the trail
      //    never engaging. (Owner case 08-28: manual BE moves left be_done=false in the
      //    ledger, so the manager fought the broker instead of continuing from it.) ──
      if (beOn && !row.be_done) {
        const brokerSl = st.sl.get(String(row.position_id)) ?? null;
        const tol = pip * 2;
        const atOrBeyond = brokerSl != null && (long ? brokerSl >= entry - tol : brokerSl <= entry + tol);
        if (atOrBeyond) {
          update.be_done = true; update.cur_stop = brokerSl; row.be_done = true; row.cur_stop = brokerSl; didAction = true;
          actions.push({ positionId: row.position_id, symbol: row.symbol, account: row.acc_num, action: "be_adopted", detail: `broker SL already ${brokerSl}` });
          await logTrade(admin, { position_id: row.position_id, account_id: row.account_id, user_id: row.user_id, symbol: row.symbol, phase: "break_even", reason: "adopted_from_broker", price: brokerSl });
        }
      }

      // ── STEP 0.4: STOP-LOSS SELF-HEAL (owner 09-15: fan-out speed — the per-account bracket
      //    verify was moved OFF the entry hot path to make GENX entries fire faster, so the
      //    manager is now the guarantor that every managed fill carries its stop. Mirrors the
      //    TP self-heal below: the broker position row is the truth — if the ledger has a stop
      //    but the broker shows NONE (a route silently dropped the SL leg on the fill), re-attach
      //    it immediately, on EVERY pass and regardless of profit (an unprotected position is the
      //    catastrophic case, unlike a missing TP). Guards: only when the broker actually exposes
      //    the SL column (slIdx >= 0 — never re-attach blind) and only when the stop is genuinely
      //    absent (a stop the member moved by hand is a non-null value → untouched). Keep the TP
      //    alongside so a bracket-replace modify can never clear it. ──
      if (manageOn && cols.slIdx >= 0) {
        const brokerSl = st.sl.get(String(row.position_id)) ?? null;
        const slKeep = row.cur_stop ?? row.init_stop;
        if ((brokerSl == null || brokerSl <= 0) && slKeep != null && slKeep > 0) {
          const slPx = roundPx(row.symbol, slKeep);
          const tpKeep = st.tp.get(String(row.position_id)) ?? (tp != null ? roundPx(row.symbol, tp) : null);
          const fix = await modifyPosition(tok.env, tok.token, row.acc_num, row.position_id, {
            stopLoss: slPx,
            ...(tpKeep != null && tpKeep > 0 ? { takeProfit: tpKeep } : {}),
          });
          if (fix.ok) {
            didAction = true;
            actions.push({ positionId: row.position_id, symbol: row.symbol, account: row.acc_num, action: "sl_reattached", detail: `SL→${slPx}` });
            await logTrade(admin, { position_id: row.position_id, account_id: row.account_id, user_id: row.user_id, symbol: row.symbol, phase: "sl_reattached", reason: "broker_dropped_sl", price: slPx, detail: { tpKept: tpKeep ?? null } });
          } else {
            actions.push({ positionId: row.position_id, symbol: row.symbol, account: row.acc_num, action: "sl_reattach_err", detail: fix.error.slice(0, 60) });
            await logTrade(admin, { position_id: row.position_id, account_id: row.account_id, user_id: row.user_id, symbol: row.symbol, phase: "sl_reattach_err", reason: "broker_dropped_sl", price: slPx, detail: { error: fix.error.slice(0, 120) } });
          }
        }
      }

      // ── STEP 0.5: TAKE-PROFIT SELF-HEAL (owner 09-08: "WHY IS THERE NO TAKE PROFIT???").
      //    Every platform entry is SUBMITTED with its TP, but some TradeLocker routes silently
      //    drop the TP leg while still filling the order (live case 09-08 23:02 UTC: genx sell
      //    13.05 @ 4353.69 submitted with tp 4347.51 — filled with the SL only). The broker's
      //    own position row is the truth: if the ledger carries a target but the broker shows
      //    NO take-profit at all, re-attach it. Guards: only when the TP column is actually
      //    readable (never re-attach blind), only a fully-MISSING TP is repaired (a TP the
      //    member set or changed by hand is any non-null value → untouched), and never a TP
      //    the market has already passed (the broker would close the position instantly). ──
      if (manageOn && tp != null && towardTp && cols.tpIdx >= 0) {
        const brokerTp = st.tp.get(String(row.position_id)) ?? null;
        /*
         * Re-attach the NEAR target, not GENX's (owner 09-25). The ledger's tp1 is still the GENX
         * plan at ~1.9R — that is what the desk published — but the take-profit ORDER belongs at
         * ~0.5R, where the data says price actually trades. If this healed to tp1 it would quietly
         * undo the change on any position whose bracket the broker dropped.
         */
        const nearPx = nearTargetApplies(row.symbol)
          ? nearTargetPrice(row.side as "buy" | "sell", entry, row.init_stop, pip, tp)
          : null;
        const tpPx = roundPx(row.symbol, nearPx ?? tp);
        const notPassed = long ? price < tpPx - 2 * pip : price > tpPx + 2 * pip;
        if ((brokerTp == null || brokerTp <= 0) && notPassed) {
          // Send the CURRENT stop alongside the TP — broker truth first, ledger fallback — so
          // a modify that replaces the whole bracket set can never clear the stop-loss.
          const slKeep = st.sl.get(String(row.position_id)) ?? row.cur_stop ?? row.init_stop;
          const fix = await modifyPosition(tok.env, tok.token, row.acc_num, row.position_id, {
            ...(slKeep != null && slKeep > 0 ? { stopLoss: slKeep } : {}),
            takeProfit: tpPx,
          });
          if (fix.ok) {
            didAction = true;
            actions.push({ positionId: row.position_id, symbol: row.symbol, account: row.acc_num, action: "tp_reattached", detail: `TP→${tpPx}` });
            await logTrade(admin, { position_id: row.position_id, account_id: row.account_id, user_id: row.user_id, symbol: row.symbol, phase: "tp_reattached", reason: "broker_dropped_tp", price: tpPx, detail: { slKept: slKeep ?? null } });
          } else {
            actions.push({ positionId: row.position_id, symbol: row.symbol, account: row.acc_num, action: "tp_reattach_err", detail: fix.error.slice(0, 60) });
          }
        }
      }

      // ── STEP 1: BREAK-EVEN — move the stop to the entry. Only while genuinely in profit and
      //    with the market still beyond entry (so the stop isn't rejected / isn't a loss). ──
      if (beOn && !row.be_done && (favReachedBE || wickReachedBE) && inProfit && priceInProfit && beSafe) {
        const mv = await modifyPosition(tok.env, tok.token, row.acc_num, row.position_id, { stopLoss: bePx });
        const mvErr = mv.ok ? "" : mv.error;
        const outcome = breakEvenOutcome(mv.ok, mvErr);
        if (outcome !== "failed") {
          // THE BROKER'S ANSWER IS THE GATE, NOT THE READ-BACK (owner 09-14). An accepted
          // modify means the stop IS at break-even, so record it. The read-back still runs
          // and is still logged, but purely as observability: when it cannot confirm a stop
          // the broker already accepted, that is a parser gap to fix later, not a reason to
          // withhold break-even. Gating on it left be_done false, which also held trailing
          // off, and the redundant re-sends were then rejected forever as no-ops.
          // Safety is unchanged: this only ever runs after the broker accepted (or reported
          // it had already applied) a move of the stop TOWARD break-even. A real rejection
          // still falls through to the else and records nothing.
          update.be_done = true; row.be_done = true; update.cur_stop = bePx; row.cur_stop = bePx; didAction = true;
          const confirmed = await verifyStop(tok, row.acc_num, row.account_id, row.position_id, cols.slIdx, row.symbol, bePx);
          const reason = confirmed ? "broker_confirmed" : outcome === "already" ? "already_at_be" : "acked_no_readback";
          actions.push({ positionId: row.position_id, symbol: row.symbol, account: row.acc_num, action: "breakeven", detail: `SL→entry ${bePx}${confirmed ? " ✓" : " (unverified)"}` });
          await logTrade(admin, { position_id: row.position_id, account_id: row.account_id, user_id: row.user_id, symbol: row.symbol, phase: "break_even", reason, price: bePx });
          // Keep the mismatch visible so the read-back parser can be fixed.
          if (!confirmed) await logTrade(admin, { position_id: row.position_id, account_id: row.account_id, user_id: row.user_id, symbol: row.symbol, phase: "be_unconfirmed", reason: "readback_mismatch", price: bePx });
        }
        else { update.last_error = `be_err: ${mvErr}`.slice(0, 120); actions.push({ positionId: row.position_id, symbol: row.symbol, account: row.acc_num, action: "be_err", detail: mvErr.slice(0, 60) }); }
      }

      // ── STEP 2: PARTIAL — when the member picked one (25% or 50%), bank that share halfway to the
      //    target in force and let the rest ride. Gated on the same in-profit guard → only ever banks a
      //    WIN. One close per position, ever (partialOperation.ts). If the broker has not shown the
      //    smaller size yet, the quantity check at the top of every pass picks it up when it does, and
      //    the broker is asked again at most once a minute — not on every pass, each of which would
      //    otherwise spend a positions read and half a second on a close that was already sent.
      const part = partialOn ? normalizeQuantity(contractKey(row.symbol), row.qty * partialFrac, { quantityStep: inst.quantityStep, minQuantity: inst.minQuantity }) : null;
      const canSplit = !!part && part.ok && part.qty > 0 && part.qty < row.qty;
      const partialKey = `${tok.env}|${row.account_id}|${row.position_id}`;
      if (partialOn && part && canSplit && !row.partial_done && partialReached && inProfit && priceInProfit && Date.now() >= (partialRecheckAt.get(partialKey) ?? 0)) {
        if (brokerQty == null) {
          update.last_error = "partial_waiting_for_broker_quantity";
        } else {
          const identity = { environment: tok.env, account_id: String(row.account_id), position_id: String(row.position_id) };
          let sentNow = false;
          const before = row.qty;
          const result = await partialOnce({
            async reserve(intent) {
              const inserted = await admin.from("flow_partial_operations").insert({ ...identity, ...intent });
              if (!inserted.error) { sentNow = true; return { created: true, intent }; }
              if (inserted.error.code !== "23505") throw new Error("partial_reservation_unavailable");
              const existing = await admin.from("flow_partial_operations").select("before_qty,requested_qty")
                .match(identity).single();
              if (existing.error || !existing.data) throw new Error("partial_reservation_unavailable");
              return { created: false, intent: { before_qty: Number(existing.data.before_qty), requested_qty: Number(existing.data.requested_qty) } };
            },
          }, { before_qty: brokerQty, requested_qty: part.qty },
          // A close the broker may or may not have carried out (a timeout, a 5xx) is an unknown outcome, not a refusal.
          async () => { const c = await closePosition(tok.env, tok.token, row.acc_num, row.position_id, part.qty); if (!c.ok && c.uncertain) throw new Error("partial_outcome_unknown"); return c; },
          () => readBrokerQty(tok, row.acc_num, row.account_id, row.position_id, cols.qtyIdx));
          // Where, and how much: recorded the moment the close goes out, so the trade is graded on what
          // it banked even when the broker shows the smaller size a pass later.
          // (Not when the broker said no: that close never happened, and a later hand-close must not be graded on it.)
          const refused = result.state === "pending" && !!result.error && result.error !== "partial_outcome_unknown";
          if (sentNow && !refused) { update.partial_px = price; update.partial_frac = +(part.qty / brokerQty).toFixed(4); }
          if (result.state === "confirmed") {
            partialRecheckAt.delete(partialKey);
            const closedAmt = +(before - result.remaining).toFixed(6);
            if (before > 0 && closedAmt > 0) update.partial_frac = +(closedAmt / before).toFixed(4);
            update.partial_done = true; row.partial_done = true;
            update.qty = result.remaining; row.qty = result.remaining; didAction = true;
            actions.push({ positionId: row.position_id, symbol: row.symbol, account: row.acc_num, action: "partial", detail: `${m.partialPct}% · broker remaining ${result.remaining} ✓` });
            await logTrade(admin, { position_id: row.position_id, account_id: row.account_id, user_id: row.user_id, symbol: row.symbol, phase: "partial", reason: "broker_confirmed", qty: closedAmt, price, detail: { remaining: result.remaining, pct: m.partialPct, trigger: partialTriggerPx, target: targetPx } });
          } else {
            if (partialRecheckAt.size > 5000) partialRecheckAt.clear();
            partialRecheckAt.set(partialKey, Date.now() + PARTIAL_RECHECK_MS);
            update.last_error = result.error ?? "partial_pending_reconciliation";
            actions.push({ positionId: row.position_id, symbol: row.symbol, account: row.acc_num, action: "partial_pending", detail: "reserved; waiting for broker reconciliation" });
          }
        }
      }

      // ── STEP 2.5: PROFIT GUARD (part of follow price; gold) — the market just flipped against a trade
      //    that is already a real winner: snap the stop to just behind the market so most of the move is
      //    banked if the reversal is real, and the runner still runs if it isn't. Only ever tightens. ──
      if (manageOn && follow !== "off" && contractKey(row.symbol) === "XAUUSD") {
        const plan = profitGuardPlan({
          side: row.side, entry, price, R, pip, curStop: row.cur_stop ?? null, bePx, best,
          choch: guardChoch, spread: spreadCache.get(`${tok.env}|${row.account_id}|${row.symbol}`) ?? null,
        });
        if (plan) {
          const mv = await modifyPosition(tok.env, tok.token, row.acc_num, row.position_id, { stopLoss: plan.stop });
          if (mv.ok || /nothing\s+to\s+change/i.test(mv.ok ? "" : mv.error)) {
            update.cur_stop = plan.stop; row.cur_stop = plan.stop;
            if (!row.be_done) { update.be_done = true; row.be_done = true; }
            didAction = true;
            actions.push({ positionId: row.position_id, symbol: row.symbol, account: row.acc_num, action: "profit_guard", detail: `SL→${plan.stop} (+${plan.profitPips}p now, peak +${plan.peakPips}p, ${plan.why === "flip" ? `${guardChoch} flip` : "peak lock"})` });
            await logTrade(admin, { position_id: row.position_id, account_id: row.account_id, user_id: row.user_id, symbol: row.symbol, phase: "profit_guard", reason: plan.why === "flip" ? `choch_${guardChoch}` : "peak_lock", price: plan.stop, detail: { profitPips: plan.profitPips, peakPips: plan.peakPips } });
          } else {
            update.last_error = `guard_err: ${mv.ok ? "" : mv.error}`.slice(0, 120);
            actions.push({ positionId: row.position_id, symbol: row.symbol, account: row.acc_num, action: "guard_err", detail: (mv.ok ? "" : mv.error).slice(0, 60) });
          }
        }
      }

      // ── STEP 3: FOLLOW PRICE — after break-even, ratchet the stop up behind the best price the
      //    trade has reached, as close as the member chose (Tight / Normal / Loose). Anchored to the
      //    real fill + the favorable excursion; tightens near the target; never below break-even and
      //    never through the current market. It no longer waits for a partial: a partial that the
      //    broker refused is never sent again, and the stop must not stay parked behind it. ──
      if (follow !== "off" && row.be_done) {
        const peakR = (long ? best - entry : entry - best) / R;
        const toTargetR = tp != null ? (long ? tp - best : best - tp) / R : 99;
        const partialR = halfway != null ? (long ? halfway - entry : entry - halfway) / R : 1;
        const near = toTargetR <= NEAR_TP_R || peakR >= partialR - NEAR_PARTIAL_R;
        // Normal: 0.6R, 0.25R near — as it always was. "Off" has no distance, and an infinite one never moves a stop.
        const givebackR = followGivebackR(follow, near) ?? Infinity;
        let candidate = roundPx(row.symbol, long ? best - givebackR * R : best + givebackR * R);
        // Never through the current market (broker rejects it, and `best` may be a spike the
        // price has pulled back from) — cap a small buffer inside the current price.
        const trailBuf = Math.max(R * 0.1, pip * 2);
        candidate = long ? Math.min(candidate, roundPx(row.symbol, price - trailBuf)) : Math.max(candidate, roundPx(row.symbol, price + trailBuf));
        candidate = long ? Math.max(candidate, bePx) : Math.min(candidate, bePx); // never below BE
        const cur = row.cur_stop ?? bePx;
        const eps = R * 0.05; // don't spam the broker on sub-5%-of-R nudges
        const improved = long ? candidate > cur + eps : candidate < cur - eps;
        if (improved) {
          const mv = await modifyPosition(tok.env, tok.token, row.acc_num, row.position_id, { stopLoss: candidate });
          if (mv.ok) {
            // THE BROKER'S ACK IS THE GATE, NOT THE READ-BACK — consistent with break-even
            // (8620e8d). The old code advanced the recorded trail ONLY when verifyStop could
            // re-read the stop; on accounts/routes where the broker doesn't expose the SL on the
            // position row (slIdx < 0), that read-back never confirmed, so the trail stalled at
            // cur_stop forever and re-sent the same modify every tick. Now an accepted modify
            // records the trail; the read-back still runs, but only to annotate confirmed vs
            // acked-no-readback. (Flag GENX2_TRAIL_ACK_GATE, default on, restores the old
            // read-back-gated behavior when off.)
            const confirmed = await verifyStop(tok, row.acc_num, row.account_id, row.position_id, cols.slIdx, row.symbol, candidate);
            if (genx2TrailAckGate()) {
              update.cur_stop = candidate; didAction = true;
              actions.push({ positionId: row.position_id, symbol: row.symbol, account: row.acc_num, action: "trail", detail: `SL→${candidate} gb${givebackR}R${confirmed ? " ✓" : " (acked)"}` });
              await logTrade(admin, { position_id: row.position_id, account_id: row.account_id, user_id: row.user_id, symbol: row.symbol, phase: "trail", reason: confirmed ? "broker_confirmed" : "acked_no_readback", price: candidate });
              if (!confirmed) { await logTrade(admin, { position_id: row.position_id, account_id: row.account_id, user_id: row.user_id, symbol: row.symbol, phase: "trail_unconfirmed", reason: "readback_mismatch", price: candidate }); }
            } else if (confirmed) { update.cur_stop = candidate; didAction = true; actions.push({ positionId: row.position_id, symbol: row.symbol, account: row.acc_num, action: "trail", detail: `SL→${candidate} gb${givebackR}R${cols.slIdx >= 0 ? " ✓" : ""}` }); await logTrade(admin, { position_id: row.position_id, account_id: row.account_id, user_id: row.user_id, symbol: row.symbol, phase: "trail", reason: "broker_confirmed", price: candidate }); }
            else { update.last_error = `trail_unconfirmed: broker SL != ${candidate}`.slice(0, 120); actions.push({ positionId: row.position_id, symbol: row.symbol, account: row.acc_num, action: "trail_unconfirmed", detail: "retry next tick" }); await logTrade(admin, { position_id: row.position_id, account_id: row.account_id, user_id: row.user_id, symbol: row.symbol, phase: "trail_unconfirmed", reason: "readback_mismatch", price: candidate }); }
          }
          else { update.last_error = `trail_err: ${mv.error}`.slice(0, 120); actions.push({ positionId: row.position_id, symbol: row.symbol, account: row.acc_num, action: "trail_err", detail: mv.error.slice(0, 60) }); }
        }
      }

      if (!didAction) {
        const profit = long ? price - entry : entry - price;
        actions.push({ positionId: row.position_id, symbol: row.symbol, account: row.acc_num, action: manageOn ? "watching" : m === SETTINGS_UNREAD ? "settings_unread" : "unmanaged", detail: `${(profit / R).toFixed(2)}R` });
      }

      // ── WRITE THINNING (owner 09-10 "how do i cut usage on supabase" → approved): at
      //    worker speed (~3 passes/sec) re-saving every quiet row every pass is thousands of
      //    no-op UPDATEs a minute. Persist only when something MATERIAL happened: a broker
      //    action this pass, a state key beyond the routine trio (entry/r reanchor, qty,
      //    be_done, partial_done, cur_stop...), a best_price extreme that actually moved
      //    (>2 pips — sub-pip jitter isn't a new excursion; the in-memory `best` still uses
      //    the fresh value within the pass), or an error to record/clear. The rotation
      //    bulk-stamp at selection already refreshes updated_at, so skipped rows keep
      //    rotating fairly and no row ever starves. Zero behavior change on real events. ──
      const materialWrite =
        didAction ||
        Object.keys(update).some((k) => !["last_error", "updated_at", "best_price"].includes(k)) ||
        Math.abs(best - bestPrev) > 2 * pip ||
        update.last_error != null ||
        row.last_error != null; // a previously recorded error must be cleared on disk
      if (materialWrite) {
        const saved = await admin.from("flow_managed_positions").update(update).eq("id", row.id);
        if (saved.error) throw new Error("management_state_write_failed");
      }
      if (didAction) managed += 1;
    } catch (e) {
      try { await admin.from("flow_managed_positions").update({ last_error: (e instanceof Error ? e.message : "error").slice(0, 120), updated_at: new Date().toISOString() }).eq("id", row.id); } catch { /* ignore */ }
    }
  };

  // ── PARALLEL BOOK SWEEP (owner 09-09, live case: 119 open sells made a full serial
  // sweep take ~19s, so a seconds-long 44-pip wick was seen by only the rows being
  // visited at that instant — their sibling legs missed break-even). Rows are grouped
  // by CONNECTION (per-credential rate limits stay respected: serial within a login)
  // and the groups run concurrently, so the WHOLE book samples the market within a
  // couple of seconds. Caches (token/cols/acct/quote/spread) are shared per tick and
  // JS is single-threaded, so the maps stay coherent. ──
  const connGroups = new Map<string, ManagedRow[]>();
  for (const row of rows) {
    const k = String(row.connection_id ?? row.account_id ?? row.id);
    if (!connGroups.has(k)) connGroups.set(k, []);
    connGroups.get(k)!.push(row);
  }
  const groupList = [...connGroups.values()];
  const SWEEP_CONCURRENCY = 8;
  let nextGroup = 0; // single-threaded JS: the increment below is atomic between awaits
  await Promise.all(Array.from({ length: Math.min(SWEEP_CONCURRENCY, Math.max(groupList.length, 1)) }, async () => {
    for (;;) {
      const i = nextGroup++;
      if (i >= groupList.length) return;
      for (const row of groupList[i]) await processRow(row);
    }
  }));

  return { managed, actions, ...(settingsUnread ? { settingsUnread } : {}) };
}

// ── CONTINUOUS-MANAGER LOCK ──────────────────────────────────────────────────
// The high-frequency manager loop (/api/cron/flow-manage) runs the break-even →
// partial → trail check every few seconds. This DB lock guarantees only ONE run
// manages at a time, so overlapping invocations (the loop + the 1-min fallback)
// can never double-fire a partial. The loop extends the lock every ~4s, so a short
// 20s TTL is safe (5x headroom) and bounds the window in which a hard-killed holder
// leaves positions unmanaged to ~20s (was 90s), keeping the "always managing" guarantee tight.
export async function acquireManageLock(admin: Admin, holder: string, ttlMs = 20000): Promise<boolean> {
  const nowIso = new Date().toISOString();
  const exp = new Date(Date.now() + ttlMs).toISOString();
  const { data } = await admin.from("flow_manage_lock")
    .update({ holder, expires_at: exp })
    .eq("id", 1).lt("expires_at", nowIso).select("id");
  return Array.isArray(data) && data.length > 0;
}
/** Extends the lock and reports whether `holder` still owns it. False means it expired mid-pass and another
 *  process (a cron invocation) took it: the caller must stop acting and re-acquire, never keep going blind. */
export async function extendManageLock(admin: Admin, holder: string, ttlMs = 20000): Promise<boolean> {
  const exp = new Date(Date.now() + ttlMs).toISOString();
  const { data } = await admin.from("flow_manage_lock").update({ expires_at: exp }).eq("id", 1).eq("holder", holder).select("id");
  return Array.isArray(data) && data.length > 0;
}
export async function releaseManageLock(admin: Admin, holder: string): Promise<void> {
  await admin.from("flow_manage_lock").update({ expires_at: new Date().toISOString() }).eq("id", 1).eq("holder", holder);
}
