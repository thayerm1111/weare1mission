import { createAdminClient } from "@/lib/supabase/admin";
import { connectionToken } from "@/lib/flow/connection";
import { matchInstrument } from "@/lib/flow/executor";
import { normalizeQuantity, getInstrument, priceToPips } from "@/lib/flow/instruments";
import { contractKey } from "@/lib/flow/sizing";
import { listInstruments, listPositions, getQuote, modifyPosition, closePosition, type TLEnv, type TLInstrument } from "@/lib/flow/tradelocker";

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
    const td = getInstrument(symbol)?.twelveDataSymbol;
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

/**
 * FLOW AUTO TRADE-MANAGER (server-only).
 *
 * After a fill, a pro doesn't just set-and-forget — they protect the trade and
 * bank into strength. This runs that playbook automatically on every position
 * FLOW opened (recorded in flow_managed_positions by executor.placeOnActiveAccounts):
 *
 *   Phase 1 — at the de-risk trigger (FOREX +0.5R, gold/other +1R — forex TPs are
 *     tight ~1:1, so +1R would land past the target and never fire):
 *     • move the STOP to break-even (entry), so the trade can no longer lose, AND
 *     • take a 50% PARTIAL, banking profit and de-risking the position.
 *   Phase 2 — after break-even is done, TRAIL the runner's stop 1R behind the
 *     best price it has reached (ratchet only — a long's stop never drops, a
 *     short's never rises), letting a winner run while locking in more each push.
 *
 * It reads the live broker quote per position, and detects a position that has
 * closed (SL/TP hit or the member closed it) and marks it done. This is a
 * value-add safety layer — it is NOT gated by credits, and it never OPENS a new
 * position, only protects/scales ones already open. All broker writes go through
 * the confirmed TradeLocker modify/close endpoints.
 */

export type ManagedRow = {
  id: string; user_id: string; connection_id: string; account_id: string; acc_num: string; environment: string;
  position_id: string; symbol: string; side: "buy" | "sell";
  entry: number; init_stop: number; tp1: number | null; r: number; qty: number;
  cur_stop: number | null; best_price: number | null; be_done: boolean | null; partial_done: boolean | null; status: string;
  last_error?: string | null;
};

export type ManageAction = { positionId: string; symbol: string; account: string; action: string; detail?: string };
type Admin = NonNullable<ReturnType<typeof createAdminClient>>;

// Max positions to touch per tick (backstop; the manager runs every ~30s).
const MAX_PER_TICK = 300;

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

/** Round a stop price to the instrument's own precision so the broker accepts it. */
function roundPx(symbol: string, price: number): number {
  const prec = getInstrument(contractKey(symbol)).pricePrecision ?? 2;
  return +price.toFixed(prec);
}

/**
 * Where the 50% partial fires + the stop slides to break-even, as a fraction of R,
 * chosen by the signal's REWARD:RISK. A ~1:1 target (reward ≈ risk) banks halfway, at
 * +0.5R. A 1:2 / 1:3 (or wider) target has room for the runner, so it banks at +1R —
 * still comfortably before the take-profit. This is the single source of truth for
 * both the live manager and the outcome classifier, so banked pips always match where
 * the partial actually triggered.
 */
function partialTriggerR(entry: number, initStop: number, tp1: number | null): number {
  const risk = Math.abs(entry - initStop);
  const reward = tp1 != null && tp1 > 0 ? Math.abs(tp1 - entry) : risk;
  const rr = risk > 0 ? reward / risk : 1;
  return rr <= 1.5 ? 0.5 : 1; // ~1:1 → +0.5R ; 1:2 or wider → +1R
}

// BREAK-EVEN is DECOUPLED from the partial: the stop slides to entry as soon as the
// trade is up ~half its risk — so a trade that runs well into profit and reverses at
// least scratches at break-even instead of round-tripping to a loss (the partial can
// still be further out on a 1:2/1:3). Floored to a few pips so it never moves the stop
// at a spread-width scratch on an ultra-tight forex stop.
const BE_TRIGGER_R = 0.5;
const BE_MIN_PIPS = 8;

// PROTECTIVE TRAIL (beyond break-even): cap how much profit can be handed back from the
// PEAK. Normally the stop rides GIVEBACK_R behind the best price (loose enough to let a
// trade breathe toward its partial/target); but once the move gets CLOSE — within
// NEAR_TP_R of the take-profit, or within NEAR_PARTIAL_R below the partial level — it
// tightens to GIVEBACK_NEAR_R, so a run that gets "super close" and reverses locks in
// most of the gain instead of round-tripping.
const GIVEBACK_R = 0.6;          // normal: give back at most 0.6R from the peak
const GIVEBACK_NEAR_R = 0.25;    // near target/partial: tighten to 0.25R
const NEAR_TP_R = 0.4;           // "near target" = peak within 0.4R of tp1
const NEAR_PARTIAL_R = 0.2;      // "near partial" = peak within 0.2R below the partial level

export type FlowOutcomeKind = "stop" | "breakeven" | "trail" | "target";
export type FlowOutcome = { outcome: FlowOutcomeKind; result_pips: number; exit_price: number; partial_taken: boolean };

/**
 * Classify a CLOSED managed position into the track-record outcome, from the
 * lifecycle we recorded — no broker call needed. Logic mirrors what the manager
 * actually does to the trade:
 *   • Never reached +1R (be_done=false) → it stopped out → 'stop' (the only loss).
 *   • Reached +1R (partial banked) and price tagged the target (best crossed tp1)
 *     → 'target' (full winner: half at +1R, half at the target).
 *   • Reached +1R, ran past break-even and trailed out in profit below target
 *     → 'trail' (partial banked + the runner locked in extra via the trail).
 *   • Reached +1R but the runner came right back to break-even → 'breakeven'
 *     (partial banked, runner scratched — a small net win, no loss).
 * result_pips is POSITION-WEIGHTED: the partial is half the size, the runner the
 * other half (exiting at its trailing stop). 'stop' is the only negative outcome.
 * Note: a member who MANUALLY closes a trade before +1R is recorded as 'stop'
 * since we don't have their manual exit price — rare, and flagged in the UI copy.
 */
export function classifyOutcome(
  row: Pick<ManagedRow, "symbol" | "side" | "entry" | "init_stop" | "tp1" | "best_price" | "cur_stop" | "be_done" | "partial_done">,
  exitPrice?: number | null,
): FlowOutcome {
  const sym = contractKey(row.symbol);
  const pip = getInstrument(sym).pipSize || 0.0001;
  const long = row.side === "buy";
  const rPips = Math.round(Math.abs(row.entry - row.init_stop) / pip);
  // The half banked at the partial is locked in at the R:R-scaled trigger (1:1 → +0.5R,
  // 1:2/1:3 → +1R), so the banked pips must track that same trigger.
  const bankPips = Math.round(partialTriggerR(row.entry, row.init_stop, row.tp1) * rPips);
  // Did this trade actually bank a partial? If not, its whole position exits at one
  // price — don't apply the half-and-half weighting.
  const banked = !!row.partial_done;
  const tp1 = row.tp1;
  const best = row.best_price;
  const hitTarget = tp1 != null && best != null && (long ? best >= tp1 : best <= tp1);
  // Signed pips from entry to a price: POSITIVE in profit, NEGATIVE in loss.
  const signed = (px: number) => Math.round((long ? px - row.entry : row.entry - px) / pip);

  // Full target hit → 'target'. With a partial: half banked at the trigger, half at
  // target. Without (forex): the whole position rode to the target.
  if (row.be_done && hitTarget && tp1 != null) {
    const pips = banked ? Math.round(0.5 * bankPips + 0.5 * signed(tp1)) : signed(tp1);
    return { outcome: "target", result_pips: pips, exit_price: tp1, partial_taken: banked };
  }

  // Exit price: prefer the ACTUAL close price the broker gives us at close-detection;
  // otherwise fall back to the trailed stop (if +1R was reached) or the initial stop.
  const exit = (exitPrice != null && exitPrice > 0)
    ? exitPrice
    : (row.be_done ? (row.cur_stop ?? row.entry) : row.init_stop);
  const exitPips = signed(exit);

  if (row.be_done) {
    // With a partial: half banked at the trigger + the runner's exit. Without (forex,
    // break-even-only): the WHOLE position exited at `exit`.
    const total = banked ? Math.round(0.5 * bankPips + 0.5 * exitPips) : exitPips;
    const isBE = Math.abs(exitPips) <= Math.max(1, 0.2 * rPips);
    return { outcome: isBE ? "breakeven" : (exitPips > 0 ? "trail" : "breakeven"), result_pips: total, exit_price: exit, partial_taken: banked };
  }
  // Never reached +1R (no partial). Whole position exited at `exit`. Profit → a
  // (manually-closed) WIN booked as 'trail'; a loss/scratch → 'stop' (the only loss).
  if (exitPips > 0) return { outcome: "trail", result_pips: exitPips, exit_price: exit, partial_taken: false };
  return { outcome: "stop", result_pips: exitPips, exit_price: exit, partial_taken: false };
}

/**
 * Manage every OPEN position FLOW is tracking: break-even + 50% partial at +1R,
 * then trail the runner 1R behind its best price. Returns a per-position summary.
 * Safe to call blind — if the tracking table doesn't exist yet, it no-ops.
 */
export async function manageOpenPositions(): Promise<{ managed: number; actions: ManageAction[]; note?: string }> {
  const admin = createAdminClient();
  if (!admin) return { managed: 0, actions: [], note: "no_admin_client" };

  const { data, error } = await admin
    .from("flow_managed_positions")
    .select("*")
    .eq("status", "open")
    .order("updated_at", { ascending: true })
    .limit(MAX_PER_TICK);
  if (error) return { managed: 0, actions: [], note: `no_table: ${error.message}`.slice(0, 120) };
  const rows = (data ?? []) as ManagedRow[];
  if (!rows.length) return { managed: 0, actions: [] };

  // Per-account MANAGEMENT switch (breakeven + partials + trail). Default ON; a member
  // can turn an account OFF so its trades ride the raw SL/TP untouched. Loaded once for
  // every account that has an open position this tick. If the column doesn't exist yet,
  // the select fails and the set stays empty → every account is managed (prior behavior).
  const manageOff = new Set<string>();
  try {
    const acctIds = [...new Set(rows.map((r) => String(r.account_id)))];
    if (acctIds.length) {
      const res = await admin.from("flow_broker_accounts").select("account_id, manage_trades").in("account_id", acctIds);
      if (!res.error) for (const a of (res.data ?? []) as { account_id: string; manage_trades?: boolean | null }[]) {
        if (a.manage_trades === false) manageOff.add(String(a.account_id));
      }
    }
  } catch { /* column missing / read blip → treat all as managed */ }

  // One fresh token per connection; one instrument list + positions list + quote
  // cache per account — so N positions on one account cost one round-trip each.
  const tokenCache = new Map<string, { token: string; env: TLEnv } | null>();
  const acctCache = new Map<string, { openIds: Set<string>; instruments: TLInstrument[] } | null>();
  const quoteCache = new Map<string, number | null>(); // key: acctKey|symbol → exit price

  const actions: ManageAction[] = [];

  async function tokenFor(connId: string): Promise<{ token: string; env: TLEnv } | null> {
    if (tokenCache.has(connId)) return tokenCache.get(connId)!;
    const t = await connectionToken(connId);
    const v = t.ok ? { token: t.token, env: t.env } : null;
    tokenCache.set(connId, v);
    return v;
  }

  async function acctState(tok: { token: string; env: TLEnv }, accNum: string, accountId: string) {
    const key = `${accountId}`;
    if (acctCache.has(key)) return acctCache.get(key)!;
    const pos = await listPositions(tok.env, tok.token, accNum, accountId);
    const inst = await listInstruments(tok.env, tok.token, accNum, accountId);
    const v = pos.ok && inst.ok
      ? { openIds: new Set(pos.data.map(posIdOf).filter(Boolean)), instruments: inst.data }
      : null;
    acctCache.set(key, v);
    return v;
  }

  // Current EXIT price for a side (bid for a long you'd sell, ask for a short you'd
  // buy back) — conservative, so break-even/trail can't fire off a stale/one-sided
  // quote. Cached per account+symbol for the tick.
  async function exitPrice(tok: { token: string; env: TLEnv }, accNum: string, inst: TLInstrument, symbol: string, side: "buy" | "sell", accountId: string): Promise<number | null> {
    const key = `${accountId}|${symbol}`;
    if (quoteCache.has(key)) return quoteCache.get(key)!;
    const q = await getQuote(tok.env, tok.token, accNum, inst.tradableInstrumentId, inst.infoRouteId || inst.routeId);
    let px: number | null = null;
    if (q.ok) {
      const bid = q.data.bid, ask = q.data.ask;
      px = side === "buy" ? (bid ?? ask) : (ask ?? bid);
    }
    // Broker quote unavailable → market-data feed fallback (keeps BE/partials alive).
    if (px == null || !(px > 0)) px = await feedPrice(symbol);
    quoteCache.set(key, px);
    return px;
  }

  let managed = 0;
  for (const row of rows) {
    try {
      const tok = await tokenFor(row.connection_id);
      if (!tok) { await admin.from("flow_managed_positions").update({ last_error: "token", updated_at: new Date().toISOString() }).eq("id", row.id); continue; }

      const st = await acctState(tok, row.acc_num, row.account_id);
      if (!st) { await admin.from("flow_managed_positions").update({ last_error: "account_read", updated_at: new Date().toISOString() }).eq("id", row.id); continue; }

      // Position gone from the broker → it closed (SL/TP hit, or member closed it).
      // Grab the current price as the EXIT proxy (it closed within the last ~tick,
      // so this is close to the real fill). This is what stops a manual close in
      // PROFIT from being mis-booked as a stop; classifyOutcome falls back to the
      // recorded stop levels only if no quote is available.
      if (!st.openIds.has(String(row.position_id))) {
        // GUARD: don't abandon a live position on a single missing read. A freshly
        // filled position may not be queryable yet, and a multi-account / paginated
        // positions read can omit one that's actually still open (we saw a live gold
        // position wrongly booked 'closed' this way). Require 3 CONSECUTIVE misses
        // before closing; any tick that finds the position resets the counter (the
        // normal management path below writes last_error=null).
        const goneN = (typeof row.last_error === "string" && row.last_error.startsWith("gone_")) ? (parseInt(row.last_error.slice(5)) || 0) : 0;
        if (goneN < 2) {
          await admin.from("flow_managed_positions").update({ last_error: `gone_${goneN + 1}`, updated_at: new Date().toISOString() }).eq("id", row.id);
          actions.push({ positionId: row.position_id, symbol: row.symbol, account: row.acc_num, action: "gone_wait", detail: `${goneN + 1}/3` });
          continue;
        }
        let exitPx: number | null = null;
        const cinst = matchInstrument(contractKey(row.symbol), st.instruments) ?? matchInstrument(row.symbol, st.instruments);
        if (cinst) { try { exitPx = await exitPrice(tok, row.acc_num, cinst, row.symbol, row.side, row.account_id); } catch { /* fall back to recorded levels */ } }
        const oc = classifyOutcome(row, exitPx);
        await admin.from("flow_managed_positions").update({
          status: "closed", last_error: null,
          outcome: oc.outcome, result_pips: oc.result_pips, exit_price: oc.exit_price, partial_taken: oc.partial_taken,
          resolved_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        }).eq("id", row.id);
        actions.push({ positionId: row.position_id, symbol: row.symbol, account: row.acc_num, action: "closed", detail: `${oc.outcome} ${oc.result_pips>0?"+":""}${oc.result_pips}p` });
        continue;
      }

      const inst = matchInstrument(contractKey(row.symbol), st.instruments) ?? matchInstrument(row.symbol, st.instruments);
      if (!inst) { await admin.from("flow_managed_positions").update({ last_error: "no_instrument", updated_at: new Date().toISOString() }).eq("id", row.id); continue; }

      const price = await exitPrice(tok, row.acc_num, inst, row.symbol, row.side, row.account_id);
      if (price == null || !(price > 0)) { await admin.from("flow_managed_positions").update({ last_error: "no_quote", updated_at: new Date().toISOString() }).eq("id", row.id); continue; }

      const long = row.side === "buy";
      // Management OFF for this account → keep tracking (best price + close detection
      // above) but never touch the broker stop or take a partial; the trade rides raw.
      const manageOn = !manageOff.has(String(row.account_id));
      const R = row.r && row.r > 0 ? row.r : Math.abs(row.entry - row.init_stop);
      if (!(R > 0)) { await admin.from("flow_managed_positions").update({ last_error: "no_R", updated_at: new Date().toISOString() }).eq("id", row.id); continue; }

      const profit = long ? price - row.entry : row.entry - price;
      const bestPrev = row.best_price ?? row.entry;
      const best = long ? Math.max(bestPrev, price) : Math.min(bestPrev, price);
      const update: Record<string, unknown> = { best_price: best, last_error: null, updated_at: new Date().toISOString() };
      let didAction = false;

      // Profit distances are always positive, so nothing below fires while in drawdown.
      const pip = getInstrument(contractKey(row.symbol)).pipSize || 0.0001;
      const beTrigger = Math.max(BE_TRIGGER_R * R, BE_MIN_PIPS * pip);   // protect profit
      const partialTrigger = partialTriggerR(row.entry, row.init_stop, row.tp1) * R; // bank 50%
      const bePx = roundPx(row.symbol, row.entry);

      // ── STEP 1: BREAK-EVEN. As soon as we're up ~half the risk, slide the stop to the
      //    broker entry so the trade can no longer lose. Decoupled from the partial, so a
      //    big winner that reverses before the partial level still scratches at BE. ──
      if (manageOn && !row.be_done && profit >= beTrigger) {
        const mv = await modifyPosition(tok.env, tok.token, row.acc_num, row.position_id, { stopLoss: bePx });
        if (mv.ok) { update.be_done = true; update.cur_stop = bePx; didAction = true; actions.push({ positionId: row.position_id, symbol: row.symbol, account: row.acc_num, action: "breakeven", detail: `SL→BE @${(profit / R).toFixed(2)}R` }); }
        else { update.last_error = `be_err: ${mv.error}`.slice(0, 120); actions.push({ positionId: row.position_id, symbol: row.symbol, account: row.acc_num, action: "be_err", detail: mv.error.slice(0, 60) }); }
      }

      // ── STEP 2: PARTIAL. Bank 50% at the R:R-scaled trigger (1:1 → +0.5R, 1:2/1:3 → +1R).
      //    Guarded by partial_done so it can never repeat. ──
      if (manageOn && !row.partial_done && profit >= partialTrigger) {
        const half = normalizeQuantity(contractKey(row.symbol), row.qty * 0.5, { quantityStep: inst.quantityStep, minQuantity: inst.minQuantity });
        if (half.ok && half.qty > 0 && half.qty < row.qty) {
          const cl = await closePosition(tok.env, tok.token, row.acc_num, row.position_id, half.qty);
          if (cl.ok) { update.partial_done = true; update.qty = +(row.qty - half.qty).toFixed(6); didAction = true; actions.push({ positionId: row.position_id, symbol: row.symbol, account: row.acc_num, action: "partial", detail: `−${half.qty} @${(partialTrigger / R).toFixed(1)}R` }); }
          else { update.last_error = `partial_err: ${cl.error}`.slice(0, 120); actions.push({ positionId: row.position_id, symbol: row.symbol, account: row.acc_num, action: "partial_err", detail: cl.error.slice(0, 60) }); }
        }
      }

      // ── STEP 3: PROTECTIVE TRAIL. Once break-even is set, ratchet the stop up under the
      //    best price with a CAPPED giveback — tightening as the move nears the target — so
      //    a run that gets close and reverses keeps most of the gain. Never below BE. ──
      if (manageOn && row.be_done) {
        const peakR = (long ? best - row.entry : row.entry - best) / R;
        const partialR = partialTriggerR(row.entry, row.init_stop, row.tp1);
        const toTargetR = row.tp1 != null ? (long ? row.tp1 - best : best - row.tp1) / R : 99;
        // Close to the take-profit OR closing in on the partial level → tighten the trail.
        const near = toTargetR <= NEAR_TP_R || peakR >= partialR - NEAR_PARTIAL_R;
        const givebackR = near ? GIVEBACK_NEAR_R : GIVEBACK_R;
        let candidate = roundPx(row.symbol, long ? best - givebackR * R : best + givebackR * R);
        candidate = long ? Math.max(candidate, bePx) : Math.min(candidate, bePx); // never below BE
        const cur = row.cur_stop ?? bePx;
        const eps = R * 0.05; // don't spam the broker on sub-5%-of-R nudges
        const improved = long ? candidate > cur + eps : candidate < cur - eps;
        if (improved) {
          const mv = await modifyPosition(tok.env, tok.token, row.acc_num, row.position_id, { stopLoss: candidate });
          if (mv.ok) { update.cur_stop = candidate; didAction = true; actions.push({ positionId: row.position_id, symbol: row.symbol, account: row.acc_num, action: "trail", detail: `SL→${candidate} gb${givebackR}R` }); }
          else { update.last_error = `trail_err: ${mv.error}`.slice(0, 120); actions.push({ positionId: row.position_id, symbol: row.symbol, account: row.acc_num, action: "trail_err", detail: mv.error.slice(0, 60) }); }
        }
      }

      if (!didAction) {
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
