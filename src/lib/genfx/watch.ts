import { createAdminClient } from "@/lib/supabase/admin";
import { connectionToken } from "@/lib/flow/connection";
import { cancelOrder, listOrdersHistory } from "@/lib/flow/tradelocker";
import { brokerConfig, columnMap, positionForOrder } from "@/lib/flow/brokerEvidence";
import { markReservation, releaseGold } from "@/lib/genx2/reservation";
import { afterCancel } from "@/lib/genx2/cancelReconcile";
import { genx2CancelOnInvalidation, genx2OrderValiditySec } from "@/lib/genx2/flags";
import { goldResvKey } from "@/lib/genx/hedge";
import { inWeekendCloseWindow, inScanQuietWindow } from "@/lib/flow/autoExec";
import { PAIRS, PAIR_KEYS, type PairKey } from "@/lib/genfx/pairs";
import { zoneAction, ZONE_TTL_MS } from "@/lib/genfx/decide";
import { readControl, GENFX_VERSION, type GenfxControl } from "@/lib/genfx/control";
import { pairPrice } from "@/lib/genfx/market";
import { enterMsg } from "@/lib/genfx/messages";
import { placeGenfx } from "@/lib/genfx/place";
import { findSameSetup, stepForming, type FxAlert } from "@/lib/genfx/scan";
import { sendTelegram } from "@/lib/telegram";

/**
 * GEN FX FAST WATCH — GENX's watchTick, for the two pairs.
 *
 * Between full scans, something has to be looking at the market: a page setup is entered the moment
 * price touches its level, and a pending scanner setup is entered the moment its candle closes right.
 * One pass does both. The always-on worker runs a pass about once a second; the Vercel cron runs the
 * same pass as a fallback when the worker is not holding the lock.
 *
 * THE LOCK is row 6 of flow_manage_lock (1 is the trade manager, 2 the gold watch, 3–5 other loops).
 * Exactly one process watches GEN FX at a time; a crashed holder's lock simply expires.
 *
 * It also keeps GEN FX's own books straight, on a slower beat (`sweep`):
 *   • an entry order that is still resting after its bounded validity is withdrawn — price moved away,
 *     and filling there later would be the chase the limit exists to refuse;
 *   • an order the broker accepted without yet naming the position is followed up until it has a
 *     ledger row marked as GEN FX's, so the trade manager runs it and the result is booked here.
 */
type Admin = NonNullable<ReturnType<typeof createAdminClient>>;
const LOCK_ID = 6;

export async function acquireFxLock(admin: Admin, holder: string, ttlMs = 15_000): Promise<boolean> {
  const { data } = await admin.from("flow_manage_lock").update({ holder, expires_at: new Date(Date.now() + ttlMs).toISOString() })
    .eq("id", LOCK_ID).lt("expires_at", new Date().toISOString()).select("id");
  return Array.isArray(data) && data.length > 0;
}
/** Extends the lock and reports whether `holder` still owns it. False: stop acting and re-acquire. */
export async function extendFxLock(admin: Admin, holder: string, ttlMs = 15_000): Promise<boolean> {
  const { data } = await admin.from("flow_manage_lock").update({ expires_at: new Date(Date.now() + ttlMs).toISOString() }).eq("id", LOCK_ID).eq("holder", holder).select("id");
  return Array.isArray(data) && data.length > 0;
}
export async function releaseFxLock(admin: Admin, holder: string): Promise<void> {
  await admin.from("flow_manage_lock").update({ expires_at: new Date().toISOString() }).eq("id", LOCK_ID).eq("holder", holder);
}

/** A pending setup's confirmation only changes when a candle closes; re-reading it every second buys nothing. */
const CONFIRM_EVERY_MS = 10_000;
const lastConfirm = new Map<string, number>();

/** One pass: page setups on touch, then pending scanner setups. Never throws. */
export async function genfxWatchPass(admin: Admin, mdKey: string, ctlIn?: GenfxControl): Promise<{ zones: number; forming: number; sent: string[] }> {
  const sent: string[] = [];
  const ctl = ctlIn ?? (await readControl(admin));
  if (!ctl.readable || !ctl.scan) return { zones: 0, forming: 0, sent };
  if (inWeekendCloseWindow() || inScanQuietWindow()) return { zones: 0, forming: 0, sent };
  const nowIso = new Date().toISOString();
  const tg = ctl.telegram && !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHANNEL_ID);

  const { data } = await admin.from("genfx_alerts").select("*").in("state", ["zone", "forming"]);
  const rows = ((data ?? []) as FxAlert[]).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const zones = rows.filter((r) => r.state === "zone");
  const forming = rows.filter((r) => r.state === "forming");

  // ── PAGE SETUPS: enter the moment price touches the entry the page is showing ──
  const live = new Map<PairKey, number | null>();
  for (const r of zones) {
    try {
      const pair = PAIRS[r.pair];
      if (!pair) continue;
      if (Date.now() - Date.parse(r.created_at) > ZONE_TTL_MS) {
        await admin.from("genfx_alerts").update({ state: "expired", updated_at: nowIso }).eq("id", r.id).eq("state", "zone");
        continue;
      }
      if (!live.has(r.pair)) live.set(r.pair, await pairPrice(pair).catch(() => null));
      const lp = live.get(r.pair) ?? null;
      if (lp == null) continue;
      const act = zoneAction(pair, r.side, Number(r.entry), Number(r.stop), lp);
      if (act === "invalidate") {
        await admin.from("genfx_alerts").update({ state: "invalidated", last_checked_at: nowIso, updated_at: nowIso }).eq("id", r.id).eq("state", "zone");
        sent.push(`${r.pair}:${r.mode}:ZONE_INVALID`);
        continue;
      }
      if (act !== "enter") continue;
      // Move the row forward FIRST, conditionally — two watchers can never both place it.
      const { data: won } = await admin.from("genfx_alerts")
        .update({ state: "entered", enter_price: lp, enter_sent_at: nowIso, last_checked_at: nowIso, updated_at: nowIso })
        .eq("id", r.id).eq("state", "zone").select("id");
      if (!won?.length) continue;
      if (tg) { try { await sendTelegram(enterMsg(pair, r.side, r.mode, { entry_low: r.entry_low, entry_high: r.entry_high, stop: r.stop, tp1: r.tp1, tp2: r.tp2, tp3: r.tp3 }, lp, true)); } catch { /* note best-effort */ } }
      try { await placeGenfx({ pair: r.pair, signalKey: r.dedupe_key, side: r.side, mode: r.mode, entryLow: r.entry_low, entryHigh: r.entry_high, stop: r.stop, tp: r.tp1, setup: "zone", confidence: r.confidence, alertId: r.id }); } catch { /* placement best-effort */ }
      sent.push(`${r.pair}:${r.mode}:ZONE_ENTER`);
    } catch { /* per-row best effort */ }
  }

  // ── PENDING SCANNER SETUPS: enter, arm, invalidate or keep waiting ──
  for (const row of forming) {
    try {
      const pair = PAIRS[row.pair];
      if (!pair) continue;
      const last = lastConfirm.get(row.id) ?? 0;
      if (Date.now() - last < CONFIRM_EVERY_MS) continue;
      lastConfirm.set(row.id, Date.now());
      if (lastConfirm.size > 500) lastConfirm.clear();
      // A later pending alert that duplicates an earlier open one (the zone drifted) is retired quietly.
      if (row.dedupe_key.startsWith(`${row.pair}:quick:`)) {
        const twin = await findSameSetup(admin, pair, row, row.id);
        if (twin && Date.parse(twin.created_at) <= Date.parse(row.created_at)) {
          await admin.from("genfx_alerts").update({ state: "invalidated", last_checked_at: nowIso, updated_at: nowIso }).eq("id", row.id).eq("state", "forming");
          sent.push(`${row.pair}:${row.mode}:MERGED`);
          continue;
        }
      }
      const res = await stepForming(admin, ctl, pair, row, mdKey);
      if (res && /^(enter|arm|invalid)/.test(res)) sent.push(`${row.pair}:${row.mode}:${res.toUpperCase()}`);
    } catch { /* per-row best effort */ }
  }
  return { zones: zones.length, forming: forming.length, sent };
}

/* ── the slower beat: GEN FX's own books ────────────────────────────────────────────────────────── */

const FX_RESV_KEYS = PAIR_KEYS.flatMap((k) => [k, goldResvKey(k, "buy"), goldResvKey(k, "sell"), `${k}:BUY`, `${k}:SELL`]).filter((v, i, a) => a.indexOf(v) === i);
const baseOf = (resvSymbol: string): string => String(resvSymbol).split(":")[0];

/**
 * Withdraw GEN FX entry orders that are still resting past their bounded validity (the desk's own
 * setting, 180s by default). The account is freed only on a broker-confirmed cancel: a filled order
 * cannot be cancelled, so the race can never free an account that actually holds a position.
 * The same rule as genx2/cancelReconcile, which only looks at gold.
 */
export async function cancelStaleFxEntries(admin: Admin): Promise<{ scanned: number; released: number; filled: number; held: number }> {
  const out = { scanned: 0, released: 0, filled: 0, held: 0 };
  if (!genx2CancelOnInvalidation()) return out;
  const cutoff = new Date(Date.now() - genx2OrderValiditySec() * 1000).toISOString();
  try {
    const { data } = await admin.from("flow_account_reservations").select("account_id, order_id, reserved_at, symbol")
      .eq("state", "active").in("symbol", FX_RESV_KEYS).not("order_id", "is", null).lt("reserved_at", cutoff).limit(200);
    for (const r of (data ?? []) as { account_id: string; order_id: string | null; symbol: string }[]) {
      if (!r.order_id) continue;
      out.scanned++;
      const { data: acct } = await admin.from("flow_broker_accounts").select("connection_id, acc_num").eq("account_id", r.account_id).limit(1).maybeSingle();
      const connId = (acct as { connection_id?: string } | null)?.connection_id;
      const accNum = (acct as { acc_num?: string | number } | null)?.acc_num;
      if (!connId || accNum == null) { out.held++; continue; }
      const tok = await connectionToken(connId);
      if (!tok.ok) { out.held++; continue; }
      const c = await cancelOrder(tok.env, tok.token, String(accNum), r.order_id);
      let hasPos = false;
      if (!c.ok) {
        const { data: pos } = await admin.from("flow_managed_positions").select("id").eq("account_id", r.account_id).eq("symbol", baseOf(r.symbol)).eq("status", "open").limit(1).maybeSingle();
        hasPos = !!pos;
      }
      const decision = afterCancel({ canceled: c.ok, hasOpenPosition: hasPos });
      if (decision === "release") {
        await releaseGold(admin, r.account_id, r.symbol);
        // A fill the pending-fill sweep already matched to a position stays as it is; anything else was never filled.
        try { await admin.from("genfx_fills").update({ status: "cancelled", updated_at: new Date().toISOString() }).eq("account_id", r.account_id).eq("order_id", r.order_id).eq("status", "placed"); } catch { /* best-effort */ }
        out.released++;
      } else if (decision === "filled") { await markReservation(admin, r.account_id, r.symbol, "filled"); out.filled++; }
      else out.held++;
    }
  } catch { /* best-effort; the SQL stale-reconcile and the open-position check remain the safety net */ }
  return out;
}

type FillRow = {
  signal_key: string; account_id: string; user_id: string; connection_id: string; acc_num: string | null; environment: string | null;
  pair: PairKey; side: "buy" | "sell"; mode: string | null; setup: string | null; qty: number | null;
  entry: number | null; stop: number | null; tp: number | null; order_id: string | null; position_id: string | null; status: string; created_at: string;
};

/** How long the trade manager's own orphan recovery gets to adopt a fill before this sweep writes the row itself. */
const ADOPT_AFTER_MS = 60_000;

/**
 * Follow up orders the broker accepted without yet naming the position. TradeLocker answers a limit
 * order with an order id; the position appears a moment later. The fill has its stop and target at
 * the broker either way — this is what makes sure it also has a ledger row, so the trade manager runs
 * it (break-even, trail) and its result is booked as GEN FX's.
 *
 * The manager's orphan recovery (flow/recover.ts) normally adopts such a fill within ~20 seconds from
 * the placement event; this sweep then only marks that row as GEN FX's. If a minute passes with the
 * position known and no row, it writes the row itself. A fill marked "cancelled" by the stale-order
 * sweep is re-checked too: the broker answers "order not found" both for an order it cancelled and for
 * one that had already filled, and only the order history tells them apart.
 */
export async function settlePendingFills(admin: Admin): Promise<{ checked: number; adopted: number; stamped: number }> {
  const out = { checked: 0, adopted: 0, stamped: 0 };
  try {
    const since = new Date(Date.now() - 30 * 60_000).toISOString();
    const { data } = await admin.from("genfx_fills").select("*").in("status", ["placed", "uncertain", "cancelled"]).gte("created_at", since).limit(100);
    for (const f of (data ?? []) as FillRow[]) {
      out.checked++;
      const stamp = { strategy_version: GENFX_VERSION, mode: f.mode, signal_id: f.signal_key, setup_family: f.setup };
      const done = async (positionId: string | null) => {
        await admin.from("genfx_fills").update({ status: "managed", position_id: positionId, updated_at: new Date().toISOString() }).eq("signal_key", f.signal_key).eq("account_id", f.account_id);
        try { await markReservation(admin, f.account_id, goldResvKey(f.pair, f.side), "filled", f.order_id, positionId); } catch { /* best-effort */ }
      };
      let positionId: string | null = f.position_id;

      if (!positionId && f.order_id && f.acc_num) {
        const tok = await connectionToken(String(f.connection_id));
        if (tok.ok) {
          try {
            const cfg = await brokerConfig(tok.env, tok.token, String(f.acc_num), f.account_id);
            const hist = await listOrdersHistory(tok.env, tok.token, String(f.acc_num), f.account_id);
            if (hist.ok) positionId = positionForOrder(hist.data, columnMap(cfg, "ordersHistoryConfig"), String(f.order_id));
          } catch { /* next pass */ }
        }
      }

      if (positionId) {
        const { data: have } = await admin.from("flow_managed_positions").select("id, strategy_version").eq("account_id", f.account_id).eq("position_id", positionId).limit(1);
        const row = ((have ?? []) as { id: string; strategy_version: string | null }[])[0];
        if (row) {
          if (!row.strategy_version) { await admin.from("flow_managed_positions").update(stamp).eq("id", row.id); out.stamped++; }
          await done(positionId);
        } else if (Date.now() - Date.parse(f.created_at) >= ADOPT_AFTER_MS && f.entry != null && f.stop != null && f.qty != null) {
          const ins = await admin.from("flow_managed_positions").insert({
            user_id: f.user_id, connection_id: f.connection_id, account_id: f.account_id, acc_num: f.acc_num, environment: f.environment,
            position_id: positionId, symbol: f.pair, side: f.side, entry: f.entry, init_stop: f.stop, tp1: f.tp,
            r: Math.abs(Number(f.entry) - Number(f.stop)), qty: f.qty, cur_stop: f.stop, best_price: f.entry, ...stamp,
          });
          if (!ins.error) { out.adopted++; await done(positionId); }
        }
        continue;
      }
      if (f.status === "cancelled") continue;   // withdrawn and never filled, as far as the broker's history says

      // No position id to be had (an order that threw, or a history this broker does not expose): the
      // manager's orphan recovery adopts the live position from the placement event. Find that row.
      const t = Date.parse(f.created_at);
      const { data: near } = await admin.from("flow_managed_positions").select("id, position_id")
        .eq("account_id", f.account_id).eq("symbol", f.pair).eq("side", f.side).is("strategy_version", null)
        .gte("created_at", new Date(t - 60_000).toISOString()).lte("created_at", new Date(t + 25 * 60_000).toISOString()).limit(2);
      const cands = (near ?? []) as { id: string; position_id: string | null }[];
      if (cands.length === 1) {
        await admin.from("flow_managed_positions").update(stamp).eq("id", cands[0].id);
        await done(cands[0].position_id);
        out.stamped++;
      }
    }
  } catch { /* best-effort */ }
  return out;
}

/** The slower beat, run every ~20 seconds by whoever holds the lock. */
export async function genfxSweep(admin: Admin): Promise<Record<string, unknown>> {
  const cancel = await cancelStaleFxEntries(admin);
  const settle = await settlePendingFills(admin);
  return { cancel, settle };
}
