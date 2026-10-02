import { createAdminClient } from "@/lib/supabase/admin";
import { type Mode } from "@/lib/genxCompute";
import { PAIRS, px, type FxPair, type PairKey } from "@/lib/genfx/pairs";
import { readControl, inScope, minStopPips, OWNER_USER_ID, GENFX_VERSION, type GenfxControl } from "@/lib/genfx/control";
import { sizeFx } from "@/lib/genfx/sizing";
import { judgeSignal, noiseRoom, slopeFrom15m, fxChoch, fxBreaker, stopWideEnough, chasedAt, BREAKER_WINDOW_MS, type StopRow } from "@/lib/genfx/guards";
import { pairPrice, usdJpyRate, closedSeries } from "@/lib/genfx/market";
import { fxFireGate, chargeFxFire, type FxFireGate } from "@/lib/genfx/billing";
import { inWeekendCloseWindow, inScanQuietWindow, consecutiveLossStreak } from "@/lib/flow/autoExec";
import { connectionToken } from "@/lib/flow/connection";
import { can } from "@/lib/flow/permissions";
import { listAccounts, listPositions, withBrokerPriority, type TLEnv } from "@/lib/flow/tradelocker";
import { placeFixedLotFollower, instrumentIdFor, warmInstruments, entryQuoteFor } from "@/lib/flow/executor";
import { workingEntrySides, workingBlocks } from "@/lib/flow/workingOrders";
import { reserveGold, markReservation, releaseGold } from "@/lib/genx2/reservation";
import { goldResvKey, blocksEntry } from "@/lib/genx/hedge";
import { filterAccountsByStyle } from "@/lib/flow/tradeStyles";
import { newsHold } from "@/lib/news/calendar";

/**
 * GEN FX PLACEMENT — a call becomes orders on the accounts that asked for it.
 *
 * The shape is GENX's follower path (autoExec.placeGenxFollower): one pass over the opted-in accounts,
 * each risk-sized to its own equity and its own risk %, one order per call per account, and every
 * account that sits a call out leaves a reason in flow_auto_events. The order itself goes through the
 * desk's one order function (executor.placeFixedLotFollower): a limit at the worst price that still
 * pays 0.8 to 1, stop and target attached, brackets verified. A fill is written to the same ledger
 * gold uses (flow_managed_positions), so the trade manager — break-even, trail, the booked result —
 * runs it with no code of its own for this.
 *
 * WHO IT REACHES. Only an account whose own GEN FX switch for THIS pair is on
 * (flow_broker_accounts.genfx_eurusd / genfx_gbpjpy — off for everybody until they turn it on;
 * nobody's gold settings carry over), and only inside the owner's scope (control.ts).
 *
 * WHAT STOPS A CALL FOR EVERYONE, in order: GEN FX auto-trade is off · the market is in its closed or
 * quiet window · the guards in guards.judgeSignal (quality, breaker, change of character, a sane and
 * wide-enough stop, not chased) · for GBP/JPY, no USD/JPY rate to size with.
 *
 * WHAT STOPS IT FOR ONE ACCOUNT: its kill switch or "open new trades" permission · its horizon
 * switches · the conservative two-losses cool-down · already in a GEN FX trade on this pair the same
 * way (ledger, then the broker's word; a resting order counts) · a broker that cannot be read (it
 * fails closed — a missed entry is recoverable, a stacked position is not) · an account not in
 * dollars · this broker's own price already through the stop, too close to it, or past the 0.8-to-1
 * floor · a size the rules in sizing.ts refuse.
 *
 * THE SIZE IS CUT FROM THE BROKER'S PRICE. The call is judged once, for everyone, on the market-data
 * feed. Each account's lots are then worked out from that account's own broker quote, read a moment
 * before its order goes: the ask for a buy, the bid for a sell. That is the price the order fills at,
 * so the stop distance being risked — spread included — is the real one, not the feed's.
 */
type Admin = NonNullable<ReturnType<typeof createAdminClient>>;

export type FxSignal = {
  pair: PairKey; signalKey: string; side: "buy" | "sell"; mode: Mode;
  entryLow: number | null; entryHigh: number | null; stop: number | null; tp: number | null;
  setup: "zone" | "scanner"; confidence?: number | null; alertId?: string | null;
};
export type PlaceReport = { pair: PairKey; ran: boolean; reason: string; eligible: number; placed: number; skipped: Record<string, number> };

const FANOUT = 20;
const MEMBER_STREAK = 2;
const MEMBER_COOLDOWN_MS = 2 * 3600_000;

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, async () => {
    for (;;) { const i = cursor++; if (i >= items.length) break; out[i] = await fn(items[i]); }
  }));
  return out;
}

type AcctRow = {
  user_id: string; account_id: string; acc_num: string | null; connection_id: string; currency: string | null;
  risk_pct: number | null; risk_mode: string | null; permissions: Record<string, unknown> | null; kill_switch_at: string | null;
  style_quick: boolean | null; style_hold: boolean | null; style_swing: boolean | null;
};

/** The accounts with this pair switched on, inside the owner's scope, with each connection's environment. */
export async function armedAccounts(admin: Admin, pair: FxPair, ctl: GenfxControl): Promise<(AcctRow & { env: string | null })[]> {
  const { data, error } = await admin.from("flow_broker_accounts")
    .select("user_id, account_id, acc_num, connection_id, currency, risk_pct, risk_mode, permissions, kill_switch_at, style_quick, style_hold, style_swing")
    .eq(pair.column, true);
  if (error) return [];
  const rows = (data ?? []) as unknown as AcctRow[];
  if (!rows.length) return [];
  const connIds = [...new Set(rows.map((r) => String(r.connection_id)))];
  const { data: conns } = await admin.from("flow_broker_connections").select("id, environment").in("id", connIds);
  const envOf = new Map(((conns ?? []) as { id: string; environment: string | null }[]).map((c) => [String(c.id), c.environment]));
  return rows
    .map((r) => ({ ...r, env: envOf.get(String(r.connection_id)) ?? null }))
    .filter((r) => inScope(ctl.scope, { userId: String(r.user_id), environment: r.env }, OWNER_USER_ID));
}

/** Read the live numbers judgeSignal needs for one pair. Each read fails soft to the value that blocks least — except the breaker, which fails closed. */
async function marketFor(admin: Admin, pair: FxPair, ctl: GenfxControl, needSlope: boolean) {
  const [live, m5, m15] = await Promise.all([
    pairPrice(pair),
    closedSeries(pair, "5min", 60),
    needSlope ? closedSeries(pair, "15min", 100) : Promise.resolve(null),
  ]);
  const room = noiseRoom(pair, (m5 ?? []).slice(-12));
  const choch = m5 && m5.length >= 8 ? fxChoch(pair, m5.slice(-30)) : null;
  const slope = m15 ? slopeFrom15m(m15.map((b) => b.c)) : null;

  // DESK BREAKER — the one read that must succeed. Not knowing whether GEN FX is on a losing streak on
  // this pair is not permission to add to it.
  let breakerPaused = false; let breakerNote = "";
  try {
    const since = new Date(Date.now() - BREAKER_WINDOW_MS).toISOString();
    const { data, error } = await admin.from("flow_managed_positions")
      .select("side, init_stop, resolved_at, result_pips, partial_taken")
      .eq("symbol", pair.key).eq("strategy_version", GENFX_VERSION).eq("status", "closed").eq("outcome", "stop")
      .gte("resolved_at", since).order("resolved_at", { ascending: false }).limit(500);
    if (error) throw error;
    breakerPaused = fxBreaker(pair, (data ?? []) as StopRow[]).paused;
  } catch { breakerPaused = true; breakerNote = " (the loss record could not be read)"; }

  return { live, room, slope, choch, breakerPaused, breakerNote, minStopPips: minStopPips(ctl, pair) };
}

export async function placeGenfx(sig: FxSignal): Promise<PlaceReport> {
  const pair = PAIRS[sig.pair];
  const report = (ran: boolean, reason: string, eligible = 0, placed = 0, skipped: Record<string, number> = {}): PlaceReport => ({ pair: sig.pair, ran, reason, eligible, placed, skipped });
  const admin = createAdminClient();
  if (!admin || !pair) return report(false, "no_admin_client");

  const ctl = await readControl(admin);
  if (!ctl.readable || !ctl.auto) return report(false, ctl.readable ? "auto_off" : "control_unreadable");

  // Nothing desk-wide is ever silent: a call that reaches nobody leaves the reason under the owner's id.
  const desk = async (reason: string, status = "skipped") => {
    try { await admin.from("flow_auto_events").insert({ user_id: OWNER_USER_ID, symbol: pair.key, side: sig.side, status, reason: `genfx: ${reason}`.slice(0, 200) }); } catch { /* breadcrumb best-effort */ }
  };

  if (inWeekendCloseWindow() || inScanQuietWindow()) { await desk("quiet_window (no new entries around the daily close or over the weekend)"); return report(false, "quiet_window"); }
  if (ctl.config.newsBlackout) {
    try { if ((await newsHold(pair.key)).hold) { await desk("news_blackout (high-impact news for this pair inside the window)"); return report(false, "news_blackout"); } } catch { /* calendar down → don't block */ }
  }

  const mkt = await marketFor(admin, pair, ctl, sig.setup === "scanner");
  const v = judgeSignal(pair, { side: sig.side, mode: sig.mode, entryLow: sig.entryLow, entryHigh: sig.entryHigh, stop: sig.stop, tp: sig.tp, setup: sig.setup }, mkt);
  if (!v.ok) { await desk(`${v.code} — ${v.reason}${v.code === "desk_breaker" ? mkt.breakerNote : ""}`); return report(false, v.code); }

  // GBP/JPY is sized in yen and paid in dollars: no USD/JPY rate, no trade.
  const usdJpy = pair.quote === "JPY" ? await usdJpyRate() : null;
  if (pair.quote === "JPY" && usdJpy == null) { await desk("no_usdjpy_rate (cannot size a yen pair without it)"); return report(false, "no_usdjpy_rate"); }

  let accts = await armedAccounts(admin, pair, ctl);
  const loaded = accts.length;
  if (!loaded) { await desk(`fanout 0 accounts (nobody in scope "${ctl.scope}" has ${pair.name} switched on)`, "fanout"); return report(true, "no_armed_accounts"); }
  // The member's own horizon switches decide here exactly as they do for gold (and are a no-op when
  // GENX_TRADE_STYLES is off, as it is for gold).
  accts = filterAccountsByStyle(accts.map((a) => ({ ...a, styleQuick: a.style_quick, styleHold: a.style_hold, styleSwing: a.style_swing })), sig.mode);

  const gate: FxFireGate = ctl.billing ? await fxFireGate(admin, accts.map((a) => String(a.user_id))) : { eligible: new Set(), billable: new Set() };

  const tokens = new Map<string, Promise<{ token: string; env: TLEnv } | null>>();
  const tokenFor = (connId: string) => {
    let p = tokens.get(connId);
    if (!p) { p = connectionToken(connId).then((t) => (t.ok ? { token: t.token, env: t.env } : null)).catch(() => null); tokens.set(connId, p); }
    return p;
  };
  type Live = { equity: number | null; currency: string | null };
  const lives = new Map<string, Promise<Map<string, Live>>>();
  const liveFor = (connId: string, tok: { token: string; env: TLEnv }) => {
    let p = lives.get(connId);
    if (!p) {
      p = listAccounts(tok.env, tok.token).then((res) => {
        const m = new Map<string, Live>();
        if (res.ok) for (const x of res.data) m.set(String(x.accountId), { equity: typeof x.equity === "number" ? x.equity : typeof x.balance === "number" ? x.balance : null, currency: x.currency ?? null });
        return m;
      }).catch(() => new Map<string, Live>());
      lives.set(connId, p);
    }
    return p;
  };
  const defaultRisk = new Map<string, Promise<number>>();
  const riskFor = (userId: string) => {
    let p = defaultRisk.get(userId);
    if (!p) {
      p = (async () => {
        try {
          const { data } = await admin.from("flow_trade_prefs").select("risk_pct").eq("user_id", userId).maybeSingle();
          const r = (data as { risk_pct?: number | null } | null)?.risk_pct;
          return typeof r === "number" && r > 0 ? r : 1;
        } catch { return 1; }
      })();
      defaultRisk.set(userId, p);
    }
    return p;
  };

  const skipped: Record<string, number> = {};
  const resvKey = goldResvKey(pair.key, sig.side);       // side-keyed while hedging is on, as gold's is
  const signalKey = String(sig.signalKey).slice(0, 200);
  const stop = v.stop, tp = v.tp, sizeEntry = v.sizeEntry;

  const one = async (a: AcctRow & { env: string | null }): Promise<number> => {
    const uid = String(a.user_id), aid = String(a.account_id);
    const skip = async (code: string, reason: string): Promise<number> => {
      skipped[code] = (skipped[code] ?? 0) + 1;
      try { await admin.from("flow_auto_events").insert({ user_id: uid, symbol: pair.key, side: sig.side, status: "skipped", reason: `genfx: ${reason}`.slice(0, 200), account_id: aid }); } catch { /* log best-effort */ }
      return 0;
    };
    let claimed = false;      // a genfx_fills row exists for this call on this account
    let reserved = false;     // the account's reservation for this pair and side is ours
    let fillRef = sizeEntry;  // the price this account's order is expected to fill at
    const undo = async () => {
      if (claimed) { try { await admin.from("genfx_fills").delete().eq("signal_key", signalKey).eq("account_id", aid); } catch { /* best-effort */ } }
      if (reserved) { try { await releaseGold(admin, aid, resvKey); } catch { /* best-effort */ } }
    };
    try {
      if (!a.acc_num) return skip("no_broker_account", "no_broker_account (this account has no broker number)");
      const perm = can({ account_id: aid, autotrade_enabled: true, permissions: a.permissions, kill_switch_at: a.kill_switch_at }, "allow_entries");
      if (!perm.allowed) return skip("permission", `permission (${perm.reason})`);
      if (ctl.billing && !gate.eligible.has(uid)) return skip("credits", "credits (not enough credits for this trade)");

      // CONSERVATIVE: two GEN FX losses in a row on this pair rest this account for two hours.
      if (String(a.risk_mode ?? "conservative").toLowerCase() !== "aggressive") {
        try {
          const { data } = await admin.from("flow_managed_positions")
            .select("symbol, side, outcome, created_at, resolved_at")
            .eq("account_id", aid).eq("symbol", pair.key).eq("strategy_version", GENFX_VERSION).eq("status", "closed").not("outcome", "is", null)
            .gte("resolved_at", new Date(Date.now() - 12 * 3600_000).toISOString()).order("resolved_at", { ascending: false }).limit(200);
          const s = consecutiveLossStreak((data ?? []) as never);
          if (s.streak >= MEMBER_STREAK && Date.now() < s.lastClosedAt + MEMBER_COOLDOWN_MS) return skip("conservative_cooldown", `conservative_cooldown (${s.streak} ${pair.name} losses in a row — 2h)`);
        } catch { /* read error → don't block */ }
      }

      const tok = await tokenFor(String(a.connection_id));
      if (!tok) return skip("no_broker_token", "no_broker_token (reconnect your broker)");
      const ref = { env: tok.env, token: tok.token, accNum: String(a.acc_num), accountId: aid, connId: String(a.connection_id) };

      // ONE GEN FX TRADE PER PAIR, PER SIDE, PER ACCOUNT. The ledger says whether one is open; the
      // broker confirms it. Ledger-open and broker-unreadable is a skip, never a guess.
      const { data: openRows } = await admin.from("flow_managed_positions").select("position_id, side").eq("account_id", aid).eq("symbol", pair.key).eq("status", "open");
      const blocking = ((openRows ?? []) as { position_id: string | null; side: string | null }[]).filter((r) => blocksEntry(r.side, sig.side)).map((r) => String(r.position_id ?? "")).filter(Boolean);
      if (blocking.length) {
        let brokerOpen: Set<string> | null = null;
        try {
          const pos = await listPositions(tok.env, tok.token, ref.accNum, aid);
          if (pos.ok) brokerOpen = new Set((pos.data as unknown[]).map((p) => Array.isArray(p) ? String(p[0] ?? "") : String((p as Record<string, unknown>)?.id ?? (p as Record<string, unknown>)?.positionId ?? "")).filter(Boolean));
        } catch { brokerOpen = null; }
        if (brokerOpen === null) return skip("broker_unreadable", `broker_unreadable (can't confirm the open ${pair.name} trade closed)`);
        if (blocking.some((pid) => brokerOpen!.has(pid))) return skip("one_open", `one_open (already in a GEN FX ${pair.name} ${sig.side})`);
      }

      // A resting entry is exposure too. The check is scoped to THIS instrument: passing no instrument
      // would let a resting gold order block a currency trade.
      const instId = await instrumentIdFor(ref, pair.key);
      if (instId == null) {
        const listed = await warmInstruments(ref);
        return listed
          ? skip("instrument_not_found", `instrument_not_found (this broker does not list ${pair.key})`)
          : skip("broker_unreadable", "broker_unreadable (couldn't load the broker's instruments — the broker may have API trading switched off for this account)");
      }
      const wsides = await workingEntrySides(ref, instId);
      if (workingBlocks(wsides, sig.side)) return skip(wsides === null ? "broker_unreadable" : "one_open", wsides === null ? "broker_unreadable (couldn't read your orders)" : `one_open (resting ${pair.name} order)`);

      const resv = await reserveGold(admin, aid, pair.key, signalKey, 60, sig.side);
      if (!resv.reserved) return skip("one_open", `one_open (${resv.reason})`);
      reserved = true;

      // One fill per call per account. A duplicate row means another pass already handled this call here.
      const { error: dup } = await admin.from("genfx_fills").insert({
        signal_key: signalKey, account_id: aid, user_id: uid, connection_id: a.connection_id, acc_num: ref.accNum, environment: tok.env,
        pair: pair.key, side: sig.side, mode: sig.mode, setup: sig.setup, alert_id: sig.alertId ?? null, status: "reserved",
      });
      if (dup) { reserved = false; await releaseGold(admin, aid, resvKey); return 0; }
      claimed = true;

      const live = (await liveFor(String(a.connection_id), tok)).get(aid);
      const equity = live?.equity ?? null;
      if (equity == null || !(equity > 0)) { await undo(); return skip("no_equity", "no_equity (broker did not return this account's size)"); }
      const ccy = String(live?.currency ?? a.currency ?? "").toUpperCase();
      if (ccy && ccy !== "USD") { await undo(); return skip("non_usd_account", `non_usd_account (GEN FX sizes in dollars; this account is in ${ccy})`); }

      // THIS BROKER'S PRICE, NOW. If it cannot be read the feed's stands in — as it does inside the
      // order function — moved by the pair's usual cost so that the size errs small, never large.
      let brokerPx: number | null = null;
      try { brokerPx = await withBrokerPriority("critical", () => entryQuoteFor(ref, pair.key, sig.side)); } catch { brokerPx = null; }
      fillRef = brokerPx != null && brokerPx > 0 ? brokerPx : px(pair, sig.side === "buy" ? sizeEntry + pair.costPips * pair.pip : sizeEntry - pair.costPips * pair.pip);
      // The call passed these three on the feed's price; an account whose own price fails them sits out.
      if (sig.side === "buy" ? fillRef <= stop : fillRef >= stop) { await undo(); return skip("through_stop", "through_stop (this broker's price is already through the stop)"); }
      const wide = stopWideEnough(pair, fillRef, stop, mkt.minStopPips);
      if (!wide.ok) { await undo(); return skip("stop_too_tight", `stop_too_tight (the stop is ${wide.pips} pips from this broker's price — under the ${mkt.minStopPips}-pip minimum)`); }
      if (chasedAt(sig.side, stop, tp, fillRef)) { await undo(); return skip("chased", "chased (this broker's price is past the 0.8-to-1 floor)"); }

      const riskPct = typeof a.risk_pct === "number" && a.risk_pct > 0 ? a.risk_pct : await riskFor(uid);
      const s = sizeFx(pair, { entry: fillRef, stop, equity, riskPct, usdJpy, limits: ctl.config });
      if (!s.ok) {
        await undo();
        return skip(`size_${s.reason}`, s.reason === "min_lot_over_risk"
          ? `min_lot_over_risk (the smallest ${pair.name} order would risk $${s.estLossAtStop} on this stop — over ${ctl.config.maxMinLotRiskPct}% of this account)`
          : `size_${s.reason}`);
      }

      const send = (qty: number) => placeFixedLotFollower({
        userId: uid, env: tok.env, token: tok.token, connId: String(a.connection_id), accountId: aid, accNum: ref.accNum,
        symbol: pair.key, side: sig.side, qty, stop, tp, source: "genfx", maxEntry: null,
      });
      let qty = s.lots;
      let r = await send(qty);
      // The broker refused the size for margin: take the minimum instead of sitting out (the desk's own rule).
      if (!r.ok && !r.deferred && /margin/i.test(r.reason) && qty > 0.011) { qty = 0.01; r = await send(qty); }
      if (!r.ok) {
        await undo();
        skipped[r.deferred ? "session_closed" : "broker_rejected"] = (skipped[r.deferred ? "session_closed" : "broker_rejected"] ?? 0) + 1;
        return 0;   // placeFixedLotFollower already logged the broker's words on this account
      }

      await markReservation(admin, aid, resvKey, r.positionId ? "filled" : "active", r.orderId, r.positionId);
      await admin.from("genfx_fills").update({
        status: r.positionId ? "managed" : "placed", order_id: r.orderId, position_id: r.positionId, qty: r.qty,
        entry: fillRef, stop, tp, risk_pct: s.riskPct, est_loss: +(r.qty * (s.estLossAtStop / s.lots)).toFixed(2), updated_at: new Date().toISOString(),
      }).eq("signal_key", signalKey).eq("account_id", aid);
      if (ctl.billing) { try { await chargeFxFire(admin, uid, signalKey, gate); } catch { /* billing never undoes a fill */ } }
      if (r.positionId) {
        try {
          await admin.from("flow_managed_positions").insert({
            user_id: uid, connection_id: a.connection_id, account_id: aid, acc_num: ref.accNum, environment: tok.env,
            position_id: r.positionId, symbol: pair.key, side: sig.side,
            entry: fillRef, init_stop: stop, tp1: tp, r: Math.abs(fillRef - stop), qty: r.qty, cur_stop: stop, best_price: fillRef,
            strategy_version: GENFX_VERSION, mode: sig.mode, signal_id: signalKey, setup_family: sig.setup,
          });
        } catch { /* the fill stands; the pending-fill sweep writes the ledger row on its next pass */ }
      } else {
        // The broker accepted the order without naming the position yet. The order function's own
        // "placed" event carries no levels, and the manager's orphan recovery needs them to adopt the
        // fill on a broker that does not show the stop on the position row — so leave them for it.
        try { await admin.from("flow_auto_events").insert({ user_id: uid, symbol: pair.key, side: sig.side, qty: r.qty, entry: fillRef, stop, tp, status: "placed", reason: "genfx: accepted — position id pending", order_id: r.orderId, account_id: aid }); } catch { /* best-effort */ }
      }
      return 1;
    } catch (e) {
      // An order that THREW may have filled. Hold the reservation as unknown, keep the fill row so the
      // same call cannot fire again onto a possibly-live position, and leave the levels where the
      // manager's orphan recovery reads them.
      if (reserved) { try { await markReservation(admin, aid, resvKey, "unknown"); } catch { /* best-effort */ } }
      if (claimed) { try { await admin.from("genfx_fills").update({ status: "uncertain", entry: fillRef, stop, tp, updated_at: new Date().toISOString() }).eq("signal_key", signalKey).eq("account_id", aid); } catch { /* best-effort */ } }
      try { await admin.from("flow_auto_events").insert({ user_id: uid, symbol: pair.key, side: sig.side, status: "uncertain", reason: `genfx: ${(e instanceof Error ? e.message : "order_threw")}`.slice(0, 200), account_id: aid, entry: fillRef, stop, tp }); } catch { /* log best-effort */ }
      skipped.uncertain = (skipped.uncertain ?? 0) + 1;
      return 0;
    }
  };

  const results = await mapPool(accts, FANOUT, one);
  const placed = results.reduce((n, x) => n + (x || 0), 0);
  const parts = Object.entries(skipped).map(([k, n]) => `${k} ${n}`).join(", ");
  await desk(`fanout ${loaded} armed → ${placed} placed${parts ? ` (${parts})` : ""} · ${sig.mode} ${sig.setup} · stop ${v.stopPips}p`, "fanout");
  return report(true, "ok", accts.length, placed, skipped);
}
