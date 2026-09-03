import { createAdminClient } from "@/lib/supabase/admin";
import { connectionToken } from "@/lib/flow/connection";
import { matchInstrument } from "@/lib/flow/executor";
import { normalizeQuantity, getInstrument } from "@/lib/flow/instruments";
import { contractKey } from "@/lib/flow/sizing";
import { listInstruments, listPositions, getQuote, getConfig, modifyPosition, closePosition, listOrdersHistory, type TLEnv, type TLInstrument } from "@/lib/flow/tradelocker";
import { recoverOrphans } from "@/lib/flow/recover";
import { logTrade } from "@/lib/flow/tradeLog";
import { beat } from "@/lib/flow/health";

// Fallback price source. The broker's own quote endpoint is intermittently down for
// a symbol/account (we've observed a persistent "no_quote" on an open gold position
// while the broker still held it), which stalls break-even/partials indefinitely.
// When the broker quote is unavailable we fall back to the market-data feed so the
// manager keeps protecting the trade. Cached briefly so many positions on one symbol
// share a single upstream call.
const feedCache = new Map<string, { at: number; px: number }>();
const FEED_TTL_MS = 20_000;
async function feedPrice(symbol: string): Promise<number | null> {
  try {
    const td = getInstrument(contractKey(symbol))?.twelveDataSymbol;
    if (!td) return null;
    const hit = feedCache.get(td);
    if (hit && Date.now() - hit.at < FEED_TTL_MS) return hit.px;
    const key = process.env.TWELVEDATA_API_KEY;
    if (!key) return null;
    const r = await fetch(`https://api.twelvedata.com/price?symbol=${encodeURIComponent(td)}&apikey=${key}`, { cache: "no-store" });
    const j = (await r.json()) as { price?: unknown };
    const p = Number(j?.price);
    if (Number.isFinite(p) && p > 0) { feedCache.set(td, { at: Date.now(), px: p }); return p; }
  } catch { /* feed down → null */ }
  return null;
}

// Recent intra-minute EXTREMES from the market-data feed. The manager runs once a minute
// off the instantaneous bid/ask, so a spike that reverses inside the minute (common on
// gold around news) is invisible to the sample — break-even/partials never fire even though
// the trade clearly reached the level on the chart. We pull the last few 1-min candle
// highs/lows so the trigger sees the TRUE favorable excursion the trade reached. Cached per
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
    if (!entry || Date.now() - entry.at >= FEED_TTL_MS) {
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
    // Fold only bars printed since the row's entry (60s slack for the entry's own bar).
    const cut = typeof sinceMs === "number" && Number.isFinite(sinceMs) ? sinceMs - 60_000 : 0;
    let hi = 0, lo = Infinity;
    for (const b of entry.bars) { if (b.t >= cut) { hi = Math.max(hi, b.high); lo = Math.min(lo, b.low); } }
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
 *   1. BREAK-EVEN: when price reaches the break-even point (the halfway mark to take-profit,
 *      or an earlier per-account gold-pips setting if one is configured), move the STOP to
 *      the ENTRY. The trade can no longer lose.
 *   2. PARTIAL: only on a 1:2 (or wider) target — bank a 25% partial at that same halfway
 *      point. On a ~1:1 there is no partial; the stop just moves to entry.
 *   3. TRAIL (runner only): once break-even is set (and, on a 1:2, the partial is banked),
 *      ratchet the remaining runner's stop up behind the best price it reaches — anchored to
 *      the REAL fill and the true favorable excursion — so a winner that reverses keeps most
 *      of its gain. Ratchet only (a long's stop never drops), never below break-even, and
 *      never through the current market.
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
  cur_stop: number | null; best_price: number | null; be_done: boolean | null; partial_done: boolean | null; status: string;
  last_error?: string | null;
  created_at?: string | null;
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

// CROSS-PASS COLUMN-CONFIG CACHE — the broker's positionsConfig column layout is static
// per connection; refetching it every pass for 54 connections was pure waste.
const _colsCacheMod = new Map<string, { at: number; v: { avgIdx: number; uplIdx: number; slIdx: number; qtyIdx: number } }>();
const COLS_TTL_MS = 6 * 60 * 60 * 1000;

// A target counts as "1:2 or wider" (→ take the partial) at this reward:risk or above.
// Below it the trade is treated as ~1:1 (→ break-even only, no partial).
const DOUBLE_RR = 1.8;
// Fraction of the position banked at the partial-profit milestone (de-risk, let the
// runner run). Used for BOTH the close size AND the outcome-pips weighting so the two
// always agree. 0.25 = take 25% off, 75% runs.
const PARTIAL_FRACTION = 0.25;
// Never move the break-even stop on a scratch smaller than this (pips) — avoids nudging the
// stop for a spread-width blip on an ultra-tight stop.
const BE_MIN_PIPS = 8;

// GOLD default break-even trigger (pips) when an account has no per-account gold_be_pips
// override set. Gold moves the stop to entry once it's this many pips in profit — so every
// account protects a gold winner early, not only ones with the override configured.
const DEFAULT_GOLD_BE_PIPS = 35;

// PROTECTIVE TRAIL (after break-even). The runner's stop rides GIVEBACK_R behind the best
// price (loose enough to breathe toward target); once the move gets CLOSE — within NEAR_TP_R
// of take-profit, or NEAR_PARTIAL_R below the halfway/partial level — it tightens to
// GIVEBACK_NEAR_R so a run that gets "super close" and reverses locks in most of the gain.
const GIVEBACK_R = 0.6;
const GIVEBACK_NEAR_R = 0.25;
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
 *  row, so read-back is impossible — returns true to preserve the pre-existing behavior
 *  (trust the acknowledgement) rather than break break-even entirely. */
export function stopConfirmedFromPositions(
  positions: unknown[], positionId: string, slIdx: number, symbol: string, requested: number,
): boolean {
  if (slIdx < 0) return true;                       // SL not exposed on the position → can't verify; trust ack
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
  row: Pick<ManagedRow, "symbol" | "side" | "entry" | "init_stop" | "tp1" | "best_price" | "cur_stop" | "be_done" | "partial_done">,
  exitPrice?: number | null,
  reason?: CloseReason,
): FlowOutcome {
  const sym = contractKey(row.symbol);
  const pip = getInstrument(sym).pipSize || 0.0001;
  const long = row.side === "buy";
  const rPips = Math.round(Math.abs(row.entry - row.init_stop) / pip);
  const bankPips = Math.round(partialTriggerR(row.entry, row.init_stop, row.tp1) * rPips);
  const banked = !!row.partial_done;
  const tp1 = row.tp1;
  const best = row.best_price;
  const hitTarget = tp1 != null && best != null && (long ? best >= tp1 : best <= tp1);
  const signed = (px: number) => Math.round((long ? px - row.entry : row.entry - px) / pip);

  // MANUAL user close (broker order history says the position was closed by a market
  // order the user placed). It is neither a win nor a loss for streak purposes — it is
  // recorded as its own outcome and excluded from the conservative loss streak. Booked
  // at the real close fill when known, else at entry (0 pips) rather than a guessed level.
  if (reason === "manual") {
    const px = exitPrice != null && exitPrice > 0 ? exitPrice : row.entry;
    return { outcome: "manual", result_pips: signed(px), exit_price: px, partial_taken: banked };
  }

  if (row.be_done && hitTarget && tp1 != null) {
    const pips = banked ? Math.round(PARTIAL_FRACTION * bankPips + (1 - PARTIAL_FRACTION) * signed(tp1)) : signed(tp1);
    return { outcome: "target", result_pips: pips, exit_price: tp1, partial_taken: banked };
  }

  const exit = (exitPrice != null && exitPrice > 0)
    ? exitPrice
    : (row.be_done ? (row.cur_stop ?? row.entry) : row.init_stop);
  const exitPips = signed(exit);

  if (row.be_done) {
    const total = banked ? Math.round(PARTIAL_FRACTION * bankPips + (1 - PARTIAL_FRACTION) * exitPips) : exitPips;
    const isBE = Math.abs(exitPips) <= Math.max(1, 0.2 * rPips);
    return { outcome: isBE ? "breakeven" : (exitPips > 0 ? "trail" : "breakeven"), result_pips: total, exit_price: exit, partial_taken: banked };
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

// ── GOLD "CHOP / LEFT-MONEY-ON-THE-TABLE" REGIME ──────────────────────────────
// The reality the owner flagged: in chop, a gold trade often runs 15-30 pips into
// profit and then reverses. With the 35-pip break-even trigger, that green move never
// locks anything in — the stop never moves, price returns, and the trade takes the FULL
// stop. So a directionally-correct entry books as a real loss even though there was
// profit to take. When we SEE that pattern repeating on a side (recent trades that went
// green but ended flat/lost, and NO clean target win among them), we shift that side into
// "bank-early" mode: take the normal partial EARLY — at roughly the distance those trades
// were actually reaching — and pull break-even up to the same point, so the runner is
// protected at entry instead of giving the whole move back. Self-resets the moment a full
// target hits (that clears the regime — the full TP is reachable again).
const GOLD_CHOP_LOOKBACK_MS = 8 * 60 * 60 * 1000; // recent trades window
const GOLD_CHOP_WINDOW = 4;          // among the last N distinct trades on the side
const GOLD_CHOP_MIN_HITS = 2;        // ≥ this many "went green then didn't hold it"
const GOLD_CHOP_MIN_GREEN_PIPS = 15; // "there was profit to take" bar (best excursion)
const GOLD_EARLY_PARTIAL_MIN = 12;   // clamp for the early bank point (pips)
const GOLD_EARLY_PARTIAL_MAX = 22;
const GOLD_CHOP_SYMS = ["XAUUSD", "GOLD"];

export type ChopSide = { active: boolean; earlyPips: number };
/** Pure regime test on a side's recent DISTINCT trades. Exported for unit testing. */
export function computeChopSide(reps: { fav: number; outcome: string }[]): ChopSide {
  if (reps.length < GOLD_CHOP_MIN_HITS) return { active: false, earlyPips: 0 };
  const window = reps.slice(0, GOLD_CHOP_WINDOW);
  const cleanWin = window.some((x) => x.outcome === "target"); // full TP reachable → don't shrink
  const leftMoney = window.filter((x) => (x.outcome === "stop" || x.outcome === "breakeven") && x.fav >= GOLD_CHOP_MIN_GREEN_PIPS);
  if (cleanWin || leftMoney.length < GOLD_CHOP_MIN_HITS) return { active: false, earlyPips: 0 };
  const avgFav = leftMoney.reduce((s, x) => s + x.fav, 0) / leftMoney.length;
  // Bank at ~60% of how far they were actually reaching, clamped — comfortably BEFORE the
  // typical reversal point, and always below the 35-pip BE trigger so it fires first.
  const earlyPips = Math.min(GOLD_EARLY_PARTIAL_MAX, Math.max(GOLD_EARLY_PARTIAL_MIN, Math.round(avgFav * 0.6)));
  return { active: true, earlyPips };
}

/** Per-side gold chop regime from the ledger. Fan-out legs are collapsed by resolve-minute
 *  + entry so one signal counts once. Fails to an empty (all-off) map on any read error. */
async function goldChopRegime(admin: Admin): Promise<Map<"buy" | "sell", ChopSide>> {
  const out = new Map<"buy" | "sell", ChopSide>();
  try {
    const pip = getInstrument("XAUUSD").pipSize || 0.1;
    const sinceIso = new Date(Date.now() - GOLD_CHOP_LOOKBACK_MS).toISOString();
    const { data } = await admin
      .from("flow_managed_positions")
      .select("side, entry, best_price, outcome, resolved_at")
      .in("symbol", GOLD_CHOP_SYMS)
      .eq("status", "closed")
      .not("outcome", "is", null)
      .gte("resolved_at", sinceIso)
      .order("resolved_at", { ascending: false })
      .limit(80);
    const rows = (data ?? []) as { side: string; entry: number | null; best_price: number | null; outcome: string; resolved_at: string | null }[];
    for (const side of ["buy", "sell"] as const) {
      const seen = new Set<string>();
      const reps: { fav: number; outcome: string }[] = [];
      for (const r of rows) {
        if (r.side !== side) continue;
        const minute = r.resolved_at ? new Date(r.resolved_at).toISOString().slice(0, 16) : "";
        const key = `${minute}|${r.entry != null ? Math.round(r.entry) : ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const long = side === "buy";
        const fav = (r.entry != null && r.best_price != null)
          ? Math.max(0, Math.round((long ? r.best_price - r.entry : r.entry - r.best_price) / pip))
          : 0;
        reps.push({ fav, outcome: r.outcome });
        if (reps.length >= GOLD_CHOP_WINDOW) break;
      }
      out.set(side, computeChopSide(reps));
    }
  } catch { /* read error → empty map = regime off everywhere */ }
  return out;
}

/**
 * Manage every OPEN position FLOW is tracking, per THE RULES in the file header.
 * Safe to call blind — if the tracking table doesn't exist yet, it no-ops.
 */
export async function manageOpenPositions(): Promise<{ managed: number; actions: ManageAction[]; note?: string }> {
  const admin = createAdminClient();
  if (!admin) return { managed: 0, actions: [], note: "no_admin_client" };

  // ORPHAN RECOVERY: adopt any live broker position FLOW opened but failed to record
  // (entry timeout / crash / missed position-id poll) so it gets managed. Best-effort;
  // cheap when there's nothing to recover. Runs before the manage loop so an adopted
  // position is managed in this same tick.
  try { await recoverOrphans(admin); } catch { /* recovery is best-effort */ }

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

  // Per-account MANAGEMENT switch + optional GOLD break-even-pips override (moves BE earlier
  // than the halfway-to-target point, gold only). Loaded once for every account this tick.
  const manageOff = new Set<string>();
  const goldBePips = new Map<string, number>();
  try {
    const acctIds = [...new Set(rows.map((r) => String(r.account_id)))];
    if (acctIds.length) {
      type AcctCfg = { account_id: string; manage_trades?: boolean | null; gold_be_pips?: number | null; send_it?: boolean | null };
      let cfg: AcctCfg[] = [];
      const withGold = await admin.from("flow_broker_accounts").select("account_id, manage_trades, gold_be_pips, send_it").in("account_id", acctIds);
      if (!withGold.error) cfg = (withGold.data ?? []) as unknown as AcctCfg[];
      else {
        const fb = await admin.from("flow_broker_accounts").select("account_id, manage_trades").in("account_id", acctIds);
        cfg = (fb.data ?? []) as unknown as AcctCfg[];
      }
      for (const a of cfg) {
        // 🚀 SEND IT (owner feature 09-03): a Send It account's trades are HANDS-OFF — no
        // break-even move, no trail, no partials. The trade runs to its stop or target
        // exactly as placed; closes are still reconciled and outcomes recorded.
        if (a.manage_trades === false || a.send_it === true) manageOff.add(String(a.account_id));
        if (typeof a.gold_be_pips === "number" && a.gold_be_pips > 0) goldBePips.set(String(a.account_id), a.gold_be_pips);
      }
    }
  } catch { /* column missing / read blip → treat all as managed */ }

  // GOLD CHOP REGIME per side, computed ONCE for this tick (not per-position). When a side is
  // in "bank-early" mode, gold trades on that side take their partial early and move to
  // break-even early — so a 15-30 pip green run that keeps reversing books SOME profit instead
  // of giving the whole move back to the stop. Empty map when nothing qualifies.
  let goldChop = new Map<"buy" | "sell", ChopSide>();
  try { goldChop = await goldChopRegime(admin); } catch { /* regime off on read error */ }

  const tokenCache = new Map<string, { token: string; env: TLEnv } | null>();
  const colCache = new Map<string, { avgIdx: number; uplIdx: number; slIdx: number; qtyIdx: number }>();
  const histColCache = new Map<string, Record<string, number> | undefined>();
  const acctCache = new Map<string, { openIds: Set<string>; avgPx: Map<string, number>; upl: Map<string, number>; qty: Map<string, number>; sl: Map<string, number>; instruments: TLInstrument[] } | null>();
  const quoteCache = new Map<string, number | null>();

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
  async function colsFor(connId: string, tok: { token: string; env: TLEnv }, accNum: string): Promise<{ avgIdx: number; uplIdx: number; slIdx: number; qtyIdx: number }> {
    if (colCache.has(connId)) return colCache.get(connId)!;
    const modHit = _colsCacheMod.get(connId);
    if (modHit && Date.now() - modHit.at < COLS_TTL_MS) { colCache.set(connId, modHit.v); return modHit.v; }
    let v = { avgIdx: 5, uplIdx: -1, slIdx: -1, qtyIdx: -1 };
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
          if (ai >= 0) v = { avgIdx: ai, uplIdx: ui, slIdx: si, qtyIdx: qi };
          else v = { ...v, slIdx: si, qtyIdx: qi };
        }
      }
    } catch { /* keep defaults */ }
    colCache.set(connId, v);
    if (v.avgIdx !== 5 || v.uplIdx >= 0 || v.slIdx >= 0 || v.qtyIdx >= 0) _colsCacheMod.set(connId, { at: Date.now(), v }); // only cache a PARSED layout across passes, never the blind fallback
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

  async function acctState(tok: { token: string; env: TLEnv }, accNum: string, accountId: string, cols: { avgIdx: number; uplIdx: number; slIdx: number; qtyIdx: number }) {
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
    if (pos.ok) for (const p of pos.data) {
      const id = posIdOf(p);
      if (!id) continue;
      const a = numAt(p, cols.avgIdx, AVG_KEYS); if (a != null && a > 0) avgPx.set(id, a);
      const u = numAt(p, cols.uplIdx, UPL_KEYS); if (u != null) upl.set(id, u);
      const qn = numAt(p, cols.qtyIdx, QTY_KEYS); if (qn != null && qn > 0) qty.set(id, qn);
      const s = numAt(p, cols.slIdx, SL_KEYS); if (s != null && s > 0) sl.set(id, s);
    }
    const v = pos.ok && inst.ok
      ? { openIds: new Set(pos.data.map(posIdOf).filter(Boolean)), avgPx, upl, qty, sl, instruments: inst.data }
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
    // Keyed per ENV+symbol+side (not per account): 60+ gold positions used to each fetch
    // their own quote every pass even though it's the same instrument on the same broker
    // environment. One quote per env+symbol+side per tick now serves them all (cross-broker
    // spread differences are cents on gold vs. the $5+ BE trigger distances — immaterial,
    // and the conservative bid/ask side is preserved by keying on side).
    const key = `${tok.env}|${symbol}|${side}`;
    if (quoteCache.has(key)) return quoteCache.get(key)!;
    const q = await getQuote(tok.env, tok.token, accNum, inst.tradableInstrumentId, inst.infoRouteId || inst.routeId);
    let px: number | null = null;
    if (q.ok) {
      const bid = q.data.bid, ask = q.data.ask;
      px = side === "buy" ? (bid ?? ask) : (ask ?? bid);
    }
    if (px == null || !(px > 0)) px = await feedPrice(symbol);
    quoteCache.set(key, px);
    return px;
  }

  // Read the broker back after a stop modify and confirm it actually applied before we
  // record the move. ONE short settle wait + ONE fresh positions read — NOT a retry loop:
  // an unconfirmed modify is simply re-sent on the next ~4s tick (idempotent). When the
  // broker doesn't expose the SL on the position row (slIdx<0) this returns true, trusting
  // the acknowledgement, so break-even/trailing never breaks where read-back isn't possible.
  async function verifyStop(t: { token: string; env: TLEnv }, accNum: string, accountId: string, positionId: string, slIdx: number, symbol: string, requested: number): Promise<boolean> {
    if (slIdx < 0) return true;
    await new Promise((r) => setTimeout(r, 500));
    const pos = await listPositions(t.env, t.token, accNum, accountId);
    if (!pos.ok) return false;
    return stopConfirmedFromPositions(pos.data, positionId, slIdx, symbol, requested);
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

  // PARALLEL PREFETCH (owner 08-31: "taking way too long to move stops to break even").
  // The row loop below is fully serialized — correct, but it spent most of its time WAITING
  // on one-account-at-a-time broker reads, so with many accounts a single pass could take
  // 30s+ and a break-even landed that late. Warm the token + account-state caches for every
  // account this pass covers UP FRONT, in parallel — one lane per CONNECTION so a single
  // TradeLocker connection is never hit concurrently (token/rate-limit safety; matches the
  // executor's 8-wide account fan-out), up to 6 connections at once. The serial loop below
  // is UNCHANGED and now mostly hits warm caches, so a pass finishes in a few seconds and a
  // stop moves to break-even within one short tick of the trigger. Prefetch is best-effort:
  // any failure here just falls through to the loop's own fresh read + retry.
  try {
    const seenAcct = new Set<string>();
    const byConn = new Map<string, { accNum: string; accountId: string }[]>();
    for (const r of rows) {
      const aid = String(r.account_id);
      if (seenAcct.has(aid)) continue;
      seenAcct.add(aid);
      const k = String(r.connection_id);
      if (!byConn.has(k)) byConn.set(k, []);
      byConn.get(k)!.push({ accNum: r.acc_num, accountId: aid });
    }
    const lanes = [...byConn.entries()];
    let li = 0;
    const PREFETCH_LANES = 6;
    await Promise.all(Array.from({ length: Math.min(PREFETCH_LANES, lanes.length) }, async () => {
      for (;;) {
        const lane = lanes[li];
        li += 1;
        if (!lane) break;
        const [connId, accts] = lane;
        const tok = await tokenFor(connId);
        if (!tok) continue;
        for (const a of accts) {
          try {
            const cols = await colsFor(connId, tok, a.accNum);
            await acctState(tok, a.accNum, a.accountId, cols);
          } catch { /* per-account prefetch is best-effort — the row loop reads fresh */ }
        }
      }
    }));
  } catch { /* prefetch is an optimization only — the serial pass still does everything */ }

  let managed = 0;
  // LIVENESS DURING A LONG PASS: with many open positions, one full pass over the broker (each
  // position = several serial broker calls) can run past the watchdog's 120s "stale" threshold.
  // The route only beats AFTER a whole pass, so a slow-but-WORKING manager was being falsely
  // flagged "DOWN" and restarted. Beat mid-pass every ~15s so the watchdog sees it's alive —
  // this changes no trading logic, it only reports liveness while it works through the list.
  let lastBeatMs = Date.now();
  for (const row of rows) {
    if (Date.now() - lastBeatMs > 15_000) {
      try { await beat(admin, "manager", { inPass: true, managed }); } catch { /* liveness best-effort */ }
      lastBeatMs = Date.now();
    }
    try {
      const tok = await tokenFor(row.connection_id);
      if (!tok) { await admin.from("flow_managed_positions").update({ last_error: "token", updated_at: new Date().toISOString() }).eq("id", row.id); continue; }

      const cols = await colsFor(row.connection_id, tok, row.acc_num);
      const st = await acctState(tok, row.acc_num, row.account_id, cols);
      if (!st) {
        _invalidateConnToken(row.connection_id); // maybe an expired cached token — force a fresh mint next tick
        await admin.from("flow_managed_positions").update({ last_error: "account_read", updated_at: new Date().toISOString() }).eq("id", row.id); continue;
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
          continue;
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
        actions.push({ positionId: row.position_id, symbol: row.symbol, account: row.acc_num, action: "closed", detail: `${oc.outcome}[${rec.reason}] ${oc.result_pips>0?"+":""}${oc.result_pips}p` });
        await logTrade(admin, { position_id: row.position_id, account_id: row.account_id, user_id: row.user_id, symbol: row.symbol, phase: "closed", reason: `${oc.outcome}/${rec.reason}`, price: oc.exit_price, detail: { result_pips: oc.result_pips, partial_taken: oc.partial_taken } });
        continue;
      }

      const inst = matchInstrument(contractKey(row.symbol), st.instruments) ?? matchInstrument(row.symbol, st.instruments);
      if (!inst) { await admin.from("flow_managed_positions").update({ last_error: "no_instrument", updated_at: new Date().toISOString() }).eq("id", row.id); continue; }

      const price = await exitPrice(tok, row.acc_num, inst, row.symbol, row.side, row.account_id);
      if (price == null || !(price > 0)) { await admin.from("flow_managed_positions").update({ last_error: "no_quote", updated_at: new Date().toISOString() }).eq("id", row.id); continue; }

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
        if (recon.partialDone && !row.partial_done) { update.partial_done = true; row.partial_done = true; }
        if (recon.reconciled === "partial_detected") { actions.push({ positionId: row.position_id, symbol: row.symbol, account: row.acc_num, action: "partial_reconciled", detail: `broker qty ${recon.qty}` }); await logTrade(admin, { position_id: row.position_id, account_id: row.account_id, user_id: row.user_id, symbol: row.symbol, phase: "partial_reconciled", reason: "broker_qty_reduced", qty: recon.qty }); }
      }

      const R = row.r && row.r > 0 ? row.r : Math.abs(entry - row.init_stop);
      if (!(R > 0)) { await admin.from("flow_managed_positions").update({ last_error: "no_R", updated_at: new Date().toISOString() }).eq("id", row.id); continue; }

      // FAVORABLE EXCURSION: the best price the trade actually reached (current sample + recent
      // 1-min candle extremes), so a spike that reversed inside the once-a-minute window still
      // counts toward the triggers.
      const ext = await feedExtremes(row.symbol, row.created_at ? Date.parse(row.created_at) : null);
      const favRaw = long
        ? Math.max(price, ext?.high && ext.high > 0 ? ext.high : price)
        : Math.min(price, ext?.low && ext.low > 0 ? ext.low : price);
      const bestPrev = row.best_price ?? entry;
      const best = long ? Math.max(bestPrev, favRaw) : Math.min(bestPrev, favRaw);
      update.best_price = best;

      const manageOn = !manageOff.has(String(row.account_id));

      // ── THE LEVELS ──────────────────────────────────────────────────────────────────────
      const tp = row.tp1 != null && row.tp1 > 0 ? row.tp1 : null;
      const towardTp = tp != null && (long ? tp > entry : tp < entry);
      const rr = towardTp ? Math.abs(tp! - entry) / R : 1;
      const isDouble = rr >= DOUBLE_RR;                       // 1:2 or wider → take a partial
      const halfway = towardTp ? (entry + tp!) / 2 : null;    // the "break-even point"

      // GOLD pips override (if set) moves break-even EARLIER than halfway. The floor keeps a
      // no-TP trade sane. Partial always uses the halfway-to-target point (1:2+ only).
      // Gold uses a break-even-pips trigger: the account's own override if set, else the gold
      // default — so every gold trade protects early, not only accounts with a custom value.
      // GOLD CHOP "bank-early" mode for THIS side (computed once above). When active, gold
      // trades on this side pull BOTH the partial and break-even in to ~earlyPips, so the
      // 15-30 pip move that keeps reversing is banked + protected instead of round-tripping.
      const chop = contractKey(row.symbol) === "XAUUSD" ? goldChop.get(row.side as "buy" | "sell") : undefined;
      const chopOn = !!(chop && chop.active && chop.earlyPips > 0);

      const goldPipsBase = contractKey(row.symbol) === "XAUUSD"
        ? (goldBePips.get(String(row.account_id)) ?? DEFAULT_GOLD_BE_PIPS)
        : undefined;
      // In chop mode, move break-even in to the early point (never later than the base trigger).
      const goldPips = chopOn
        ? Math.min(goldPipsBase ?? DEFAULT_GOLD_BE_PIPS, chop!.earlyPips)
        : goldPipsBase;
      const beByPips = typeof goldPips === "number" && goldPips > 0
        ? (long ? entry + goldPips * pip : entry - goldPips * pip)
        : null;
      const beFloor = long ? entry + BE_MIN_PIPS * pip : entry - BE_MIN_PIPS * pip;
      // Break-even trigger price = earliest of {gold-pips, halfway, +1R-fallback}, but never
      // closer to entry than the small floor.
      const beCandidates = [beByPips, halfway, long ? entry + R : entry - R].filter((x): x is number => x != null);
      let beTriggerPx = long ? Math.min(...beCandidates) : Math.max(...beCandidates);
      beTriggerPx = long ? Math.max(beTriggerPx, beFloor) : Math.min(beTriggerPx, beFloor);
      // Early bank point in chop mode (pips from entry). Normal partial is the halfway point.
      const earlyPartialPx = chopOn ? (long ? entry + chop!.earlyPips * pip : entry - chop!.earlyPips * pip) : null;
      // Effective partial trigger = the CLOSER of {halfway, early} when chop is on; else halfway.
      const partialTriggerPx = earlyPartialPx != null
        ? (halfway != null ? (long ? Math.min(halfway, earlyPartialPx) : Math.max(halfway, earlyPartialPx)) : earlyPartialPx)
        : halfway;
      // Chop mode qualifies a partial even on a ~1:1 setup (which normally banks nothing).
      const partialAllowed = isDouble || chopOn;

      // Compare against BEST (the furthest the trade has EVER reached), not this tick's momentary
      // favRaw — otherwise a move that hit the trigger and ticked back before the once-a-minute
      // sample is missed and break-even never fires even though best_price recorded it.
      const favReachedBE = long ? best >= beTriggerPx : best <= beTriggerPx;
      const favReachedPartial = partialTriggerPx != null && (long ? best >= partialTriggerPx : best <= partialTriggerPx);

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
      const bePx = roundPx(row.symbol, entry);

      // ── STEP 0: ADOPT a break-even that already exists on the BROKER. The broker is the
      //    source of truth: if the live SL already sits at/beyond entry — the owner moved it
      //    manually, or a previous modify acked without a confirmed read-back — record BE as
      //    done instead of re-sending modifies forever ("Nothing to change") with the trail
      //    never engaging. (Owner case 08-28: manual BE moves left be_done=false in the
      //    ledger, so the manager fought the broker instead of continuing from it.) ──
      if (manageOn && !row.be_done) {
        const brokerSl = st.sl.get(String(row.position_id)) ?? null;
        const tol = pip * 2;
        const atOrBeyond = brokerSl != null && (long ? brokerSl >= entry - tol : brokerSl <= entry + tol);
        if (atOrBeyond) {
          update.be_done = true; update.cur_stop = brokerSl; row.be_done = true; row.cur_stop = brokerSl; didAction = true;
          actions.push({ positionId: row.position_id, symbol: row.symbol, account: row.acc_num, action: "be_adopted", detail: `broker SL already ${brokerSl}` });
          await logTrade(admin, { position_id: row.position_id, account_id: row.account_id, user_id: row.user_id, symbol: row.symbol, phase: "break_even", reason: "adopted_from_broker", price: brokerSl });
        }
      }

      // ── STEP 1: BREAK-EVEN — move the stop to the entry. Only while genuinely in profit and
      //    with the market still beyond entry (so the stop isn't rejected / isn't a loss). ──
      if (manageOn && !row.be_done && favReachedBE && inProfit && priceInProfit) {
        const mv = await modifyPosition(tok.env, tok.token, row.acc_num, row.position_id, { stopLoss: bePx });
        if (mv.ok) {
          // BROKER READ-BACK: only record break-even once the broker's live SL actually
          // shows the move. If it doesn't confirm, leave be_done=false so the next tick
          // re-sends (never a phantom break-even while the real stop sits at a loss).
          const confirmed = await verifyStop(tok, row.acc_num, row.account_id, row.position_id, cols.slIdx, row.symbol, bePx);
          if (confirmed) { update.be_done = true; update.cur_stop = bePx; didAction = true; actions.push({ positionId: row.position_id, symbol: row.symbol, account: row.acc_num, action: "breakeven", detail: `SL→entry ${bePx}${cols.slIdx >= 0 ? " ✓" : ""}` }); await logTrade(admin, { position_id: row.position_id, account_id: row.account_id, user_id: row.user_id, symbol: row.symbol, phase: "break_even", reason: cols.slIdx >= 0 ? "broker_confirmed" : "acked_no_readback", price: bePx }); }
          else { update.last_error = `be_unconfirmed: broker SL != ${bePx}`.slice(0, 120); actions.push({ positionId: row.position_id, symbol: row.symbol, account: row.acc_num, action: "be_unconfirmed", detail: "retry next tick" }); await logTrade(admin, { position_id: row.position_id, account_id: row.account_id, user_id: row.user_id, symbol: row.symbol, phase: "be_unconfirmed", reason: "readback_mismatch", price: bePx }); }
        }
        else { update.last_error = `be_err: ${mv.error}`.slice(0, 120); actions.push({ positionId: row.position_id, symbol: row.symbol, account: row.acc_num, action: "be_err", detail: mv.error.slice(0, 60) }); }
      }

      // ── STEP 2: PARTIAL — bank PARTIAL_FRACTION (25%) and let the runner run. Normally 1:2+
      //    only, at the halfway-to-target point. In GOLD chop mode it ALSO fires on ~1:1 setups,
      //    early (~earlyPips), so a repeatedly-reversing green run banks some profit instead of
      //    round-tripping to the stop. Gated on the same in-profit guard → only ever banks a WIN.
      const chopPartial = chopOn && !isDouble; // a partial we take ONLY because of chop mode
      if (manageOn && partialAllowed && !row.partial_done && favReachedPartial && inProfit && priceInProfit) {
        const part = normalizeQuantity(contractKey(row.symbol), row.qty * PARTIAL_FRACTION, { quantityStep: inst.quantityStep, minQuantity: inst.minQuantity });
        if (part.ok && part.qty > 0 && part.qty < row.qty) {
          const cl = await closePosition(tok.env, tok.token, row.acc_num, row.position_id, part.qty);
          if (cl.ok) {
            if (cols.qtyIdx >= 0) {
              // Read the broker back for the ACTUAL remaining qty (source of truth). Only mark
              // the partial done once the broker confirms the reduction; if it hasn't reflected
              // yet, leave it unmarked — next tick's reconcile detects the reduced position and
              // marks it, so the close can never fire twice.
              const remaining = await readBrokerQty(tok, row.acc_num, row.account_id, row.position_id, cols.qtyIdx);
              if (remaining != null && remaining > 0 && remaining <= row.qty - part.qty * 0.5) {
                const closedAmt = +(row.qty - remaining).toFixed(2);
                update.partial_done = true; update.qty = +remaining.toFixed(6); row.qty = remaining; didAction = true;
                actions.push({ positionId: row.position_id, symbol: row.symbol, account: row.acc_num, action: "partial", detail: `−${closedAmt}→${remaining} ${chopPartial ? `@${chop!.earlyPips}p chop-early` : `@${(rr).toFixed(1)}R`} ✓` });
                await logTrade(admin, { position_id: row.position_id, account_id: row.account_id, user_id: row.user_id, symbol: row.symbol, phase: "partial", reason: chopPartial ? "chop_early_bank" : "broker_confirmed", qty: closedAmt, detail: { remaining, rr: +rr.toFixed(2), chop: chopPartial ? chop!.earlyPips : undefined } });
              } else {
                update.last_error = `partial_unconfirmed`; actions.push({ positionId: row.position_id, symbol: row.symbol, account: row.acc_num, action: "partial_unconfirmed", detail: "retry next tick" });
              }
            } else {
              // Broker doesn't expose qty → pre-existing computed-remainder behavior.
              update.partial_done = true; update.qty = +(row.qty - part.qty).toFixed(6); didAction = true;
              actions.push({ positionId: row.position_id, symbol: row.symbol, account: row.acc_num, action: "partial", detail: `−${part.qty} ${chopPartial ? `@${chop!.earlyPips}p chop-early` : `@${(rr).toFixed(1)}R`}` });
            }
          }
          else { update.last_error = `partial_err: ${cl.error}`.slice(0, 120); actions.push({ positionId: row.position_id, symbol: row.symbol, account: row.acc_num, action: "partial_err", detail: cl.error.slice(0, 60) }); }
        }
      }

      // ── STEP 3: TRAIL — runner only. After break-even (and, on a 1:2, after the partial),
      //    ratchet the stop up behind the best price the trade has reached. Anchored to the
      //    real fill + the favorable excursion; tightens near the target; never below break-
      //    even and never through the current market. ──
      if (manageOn && row.be_done && (!isDouble || row.partial_done)) {
        const peakR = (long ? best - entry : entry - best) / R;
        const toTargetR = tp != null ? (long ? tp - best : best - tp) / R : 99;
        const partialR = halfway != null ? (long ? halfway - entry : entry - halfway) / R : 1;
        const near = toTargetR <= NEAR_TP_R || peakR >= partialR - NEAR_PARTIAL_R;
        const givebackR = near ? GIVEBACK_NEAR_R : GIVEBACK_R;
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
            // BROKER READ-BACK: only advance the recorded trail once the broker confirms the
            // new stop. Unconfirmed → leave cur_stop where it was so the next tick re-sends.
            const confirmed = await verifyStop(tok, row.acc_num, row.account_id, row.position_id, cols.slIdx, row.symbol, candidate);
            if (confirmed) { update.cur_stop = candidate; didAction = true; actions.push({ positionId: row.position_id, symbol: row.symbol, account: row.acc_num, action: "trail", detail: `SL→${candidate} gb${givebackR}R${cols.slIdx >= 0 ? " ✓" : ""}` }); await logTrade(admin, { position_id: row.position_id, account_id: row.account_id, user_id: row.user_id, symbol: row.symbol, phase: "trail", reason: cols.slIdx >= 0 ? "broker_confirmed" : "acked_no_readback", price: candidate }); }
            else { update.last_error = `trail_unconfirmed: broker SL != ${candidate}`.slice(0, 120); actions.push({ positionId: row.position_id, symbol: row.symbol, account: row.acc_num, action: "trail_unconfirmed", detail: "retry next tick" }); await logTrade(admin, { position_id: row.position_id, account_id: row.account_id, user_id: row.user_id, symbol: row.symbol, phase: "trail_unconfirmed", reason: "readback_mismatch", price: candidate }); }
          }
          else { update.last_error = `trail_err: ${mv.error}`.slice(0, 120); actions.push({ positionId: row.position_id, symbol: row.symbol, account: row.acc_num, action: "trail_err", detail: mv.error.slice(0, 60) }); }
        }
      }

      if (!didAction) {
        const profit = long ? price - entry : entry - price;
        actions.push({ positionId: row.position_id, symbol: row.symbol, account: row.acc_num, action: manageOn ? "watching" : "unmanaged", detail: `${(profit / R).toFixed(2)}R` });
      }

      await admin.from("flow_managed_positions").update(update).eq("id", row.id);
      if (didAction) managed += 1;
    } catch (e) {
      try { await admin.from("flow_managed_positions").update({ last_error: (e instanceof Error ? e.message : "error").slice(0, 120), updated_at: new Date().toISOString() }).eq("id", row.id); } catch { /* ignore */ }
    }
  }

  return { managed, actions };
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
export async function extendManageLock(admin: Admin, holder: string, ttlMs = 20000): Promise<void> {
  const exp = new Date(Date.now() + ttlMs).toISOString();
  await admin.from("flow_manage_lock").update({ expires_at: exp }).eq("id", 1).eq("holder", holder);
}
export async function releaseManageLock(admin: Admin, holder: string): Promise<void> {
  await admin.from("flow_manage_lock").update({ expires_at: new Date().toISOString() }).eq("id", 1).eq("holder", holder);
}
