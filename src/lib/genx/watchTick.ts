import { createAdminClient } from "@/lib/supabase/admin";
import { type Mode } from "@/lib/genxCompute";
import { confirmEntry } from "@/lib/genxConfirm";
import { sendTelegram, esc } from "@/lib/telegram";
import { placeGenxGold, placeGenxFollower, rewardRisk } from "@/lib/flow/autoExec";
import { beat } from "@/lib/flow/health";

/**
 * GENX FAST-WATCH TICK — shared by the Vercel cron loop AND the always-on worker
 * (owner 09-09: "We need execution to speed up... all things firing faster").
 * One watchPass() checks every forming setup against a fresh confirmation read and
 * fires ENTER NOW / arm / invalidate exactly like before — extracted from the
 * genx-scan route so the worker can run it continuously at ~1-2s cadence.
 *
 * THE WATCH LOCK (flow_manage_lock id=2) guarantees exactly one watcher runs at a
 * time: the worker holds it while alive; the Vercel cron only watches when it can
 * take the lock (worker down → lock expires in seconds → cron takes over). Same
 * proven pattern as the trade-manager's lock (id=1).
 */
type Admin = NonNullable<ReturnType<typeof createAdminClient>>;

// ── GOLD ENTRY PREFERENCE (owner directive): get IN when the trade is working; only wait
// for a pull-back when the fill is genuinely too rich. See genx-scan route history.
const GOLD_ENTRY_FLOOR_RR = 0.75;      // owner floor (09-03): never enter below 1:0.75; below it, wait for a pullback
const GOLD_ARM_MAX_MS = 5 * 60_000;    // owner rule 2: wait only 5 min for the pullback, then abandon

/** Pure decision for a gold entry: enter now, arm-and-wait, abandon, or keep waiting.
 *  `armed` = we already fired ENTER NOW once and are holding for a pull-back fill. */
export function decideGoldEntry(o: {
  armed: boolean; confState: string; lp: number | null;
  entryLow: number | null; entryHigh: number | null; stop: number | null; tp1: number | null;
  armedAtMs: number; nowMs: number;
}): { do: "enter" | "arm" | "invalidate" | "wait"; reason: string } {
  if (o.confState === "INVALIDATED") return { do: "invalidate", reason: "invalidated" };
  const rr = rewardRisk(o.lp, o.stop, o.tp1);
  const zLo = Math.min(Number(o.entryLow), Number(o.entryHigh));
  const zHi = Math.max(Number(o.entryLow), Number(o.entryHigh));
  const buf = Number.isFinite(zHi - zLo) ? Math.max(0.2, (zHi - zLo) * 0.15) : 0.2;
  const inZone = o.lp != null && Number.isFinite(zLo) && o.lp >= zLo - buf && o.lp <= zHi + buf;
  const takeable = inZone || (rr != null && rr >= GOLD_ENTRY_FLOOR_RR);
  const elapsed = o.nowMs - o.armedAtMs;
  if (!o.armed) {
    if (o.confState !== "CONFIRMED") return { do: "wait", reason: "pending:" + o.confState };
    if (takeable) return { do: "enter", reason: "confirmed_rr_ok" };
    return { do: "arm", reason: "chased_below_floor" };
  }
  if (takeable) return { do: "enter", reason: "pullback_to_entry" };
  if (elapsed > GOLD_ARM_MAX_MS) return { do: "invalidate", reason: "arm_expired_5min" };
  return { do: "wait", reason: "armed_waiting" };
}

export const MODE_LABEL: Record<Mode, string> = { quick: "Quick", intraday: "Intraday", swing: "Swing" };
export const r1 = (n: number) => Math.round(n);
export const fmt = (n: number | null | undefined) => (typeof n === "number" && Number.isFinite(n) ? n.toFixed(2) : "—");

export type AlertRow = {
  id: string; dedupe_key: string; mode: Mode; side: "buy" | "sell"; action: string;
  entry: number | null; entry_low: number | null; entry_high: number | null;
  stop: number | null; tp1: number | null; tp2: number | null; tp3: number | null;
  invalidation: number | null; watch: number | null; confidence: number | null;
  trigger_tf: string | null; state: string; created_at: string;
  quality_ok: boolean | null; enter_sent_at: string | null;
};

export function headsUpMsg(side: "buy" | "sell", mode: Mode, a: { entry_low: number | null; entry_high: number | null; stop: number | null; tp1: number | null; tp2: number | null; confidence: number | null }): string {
  const dir = side === "sell" ? "SELL" : "BUY";
  const zone = a.entry_low != null && a.entry_high != null ? `${fmt(a.entry_low)}–${fmt(a.entry_high)}` : "—";
  const tps = [a.tp1 != null ? `TP1 ${fmt(a.tp1)}` : null, a.tp2 != null ? `TP2 ${fmt(a.tp2)}` : null].filter(Boolean).join(" · ");
  return [
    `⏳ <b>GENX — ${dir} setup forming · ${MODE_LABEL[mode]}</b>`,
    `Gold (XAU/USD)`,
    `Zone: <b>${esc(zone)}</b>`,
    `Stop: ${fmt(a.stop)}${tps ? " · " + esc(tps) : ""}`,
    a.confidence != null ? `Confidence ${a.confidence}/100` : "",
    `Waiting for price to reach the zone and confirm. You'll get an <b>ENTER NOW</b> the moment it triggers.`,
    `<i>Educational, not financial advice.</i>`,
  ].filter(Boolean).join("\n");
}

export function enterMsg(side: "buy" | "sell", mode: Mode, a: { entry_low: number | null; entry_high: number | null; stop: number | null; tp1: number | null; tp2: number | null; tp3: number | null }, atPrice: number | null, immediate: boolean): string {
  const dir = side === "sell" ? "SELL" : "BUY";
  const zone = a.entry_low != null && a.entry_high != null ? `${fmt(a.entry_low)}–${fmt(a.entry_high)}` : "—";
  const tps = [a.tp1 != null ? `TP1 ${fmt(a.tp1)}` : null, a.tp2 != null ? `TP2 ${fmt(a.tp2)}` : null, a.tp3 != null ? `TP3 ${fmt(a.tp3)}` : null].filter(Boolean).join(" · ");
  const confirmLine = immediate
    ? `Live setup — Gold is at the zone now.`
    : `${side === "sell" ? "Sellers" : "Buyers"} confirmed on the ${MODE_LABEL[mode] === "Quick" ? "5-minute" : MODE_LABEL[mode] === "Intraday" ? "15-minute" : "1-hour"} close.`;
  return [
    `✅ <b>GENX — ENTER NOW · ${dir} · ${MODE_LABEL[mode]}</b>`,
    `Gold @ ~${fmt(atPrice)}`,
    `Entry ${esc(zone)} · Stop ${fmt(a.stop)}`,
    tps ? esc(tps) : "",
    confirmLine,
    `<i>Educational, not financial advice.</i>`,
  ].filter(Boolean).join("\n");
}

export function invalidMsg(side: "buy" | "sell", mode: Mode, a: { entry_low: number | null; entry_high: number | null; invalidation: number | null }): string {
  const dir = side === "sell" ? "SELL" : "BUY";
  const zone = a.entry_low != null && a.entry_high != null ? `${fmt(a.entry_low)}–${fmt(a.entry_high)}` : "the zone";
  return [
    `❌ <b>GENX — Setup invalidated · ${dir} · ${MODE_LABEL[mode]}</b>`,
    `The ${esc(zone)} ${dir.toLowerCase()} is off — price closed beyond ${fmt(a.invalidation)}. Don't take it.`,
  ].join("\n");
}

/** Heartbeat that PRESERVES the last recorded decision detail (watchdog reads it). */
export async function beatKeepDecision(admin: Admin, extra: Record<string, unknown>): Promise<void> {
  try {
    const { data } = await admin.from("flow_heartbeat").select("detail").eq("component", "genx").maybeSingle();
    const last = (data as { detail?: { last_decision?: unknown } } | null)?.detail?.last_decision;
    await beat(admin, "genx", { ...extra, ...(last !== undefined ? { last_decision: last } : {}) });
  } catch { try { await beat(admin, "genx", extra); } catch { /* liveness best-effort */ } }
}

// ── THE WATCH LOCK — row id=2 of flow_manage_lock (id=1 is the trade-manager's).
// Same acquire-if-expired UPDATE pattern: exactly one watcher at a time, a crashed
// holder's lock simply expires.
export async function acquireWatchLock(admin: Admin, holder: string, ttlMs = 15000): Promise<boolean> {
  const nowIso = new Date().toISOString();
  const exp = new Date(Date.now() + ttlMs).toISOString();
  const { data } = await admin.from("flow_manage_lock")
    .update({ holder, expires_at: exp })
    .eq("id", 2).lt("expires_at", nowIso).select("id");
  return Array.isArray(data) && data.length > 0;
}
export async function extendWatchLock(admin: Admin, holder: string, ttlMs = 15000): Promise<void> {
  const exp = new Date(Date.now() + ttlMs).toISOString();
  await admin.from("flow_manage_lock").update({ expires_at: exp }).eq("id", 2).eq("holder", holder);
}
export async function releaseWatchLock(admin: Admin, holder: string): Promise<void> {
  await admin.from("flow_manage_lock").update({ expires_at: new Date().toISOString() }).eq("id", 2).eq("holder", holder);
}

/**
 * ONE pass over every forming setup: fresh confirmation read → enter / arm /
 * invalidate / wait, with Telegram + desk placement side effects. Idempotent per
 * state transition (DB state moves forward before the next pass sees the row).
 */
export async function watchPass(admin: Admin, mdKey: string, tgReady: boolean): Promise<{ checked: number; sent: string[] }> {
  const nowIso = new Date().toISOString();
  const { data } = await admin.from("genx_alerts").select("*").eq("state", "forming");
  const rows = (data ?? []) as AlertRow[];
  const sent: string[] = [];
  for (const row of rows) {
    try {
      const side = row.side;
      const conf = await confirmEntry({
        side, entryLow: (row.entry_low ?? 0) as number, entryHigh: (row.entry_high ?? 0) as number,
        watch: (row.watch ?? row.entry_low ?? 0) as number, invalidation: (row.invalidation ?? row.stop ?? 0) as number,
        mode: row.mode, mdKey, fresh: true, interval: "1min",
      });
      const cOk = row.quality_ok !== false; // stored at arm time; null (old rows) → allowed
      const armedNow = !!row.enter_sent_at;
      const lp = conf.price ?? conf.enter;
      const armedAtMs = row.enter_sent_at ? new Date(row.enter_sent_at).getTime() : Date.now();
      const tgMsg = { entry_low: row.entry_low, entry_high: row.entry_high, stop: row.stop, tp1: row.tp1, tp2: row.tp2, tp3: row.tp3 };
      const act = decideGoldEntry({ armed: armedNow, confState: conf.state, lp, entryLow: row.entry_low, entryHigh: row.entry_high, stop: row.stop, tp1: row.tp1, armedAtMs, nowMs: Date.now() });
      if (act.do === "arm") {
        if (tgReady) await sendTelegram(enterMsg(side, row.mode, tgMsg, lp, false));
        await admin.from("genx_alerts").update({ enter_sent_at: nowIso, last_checked_at: nowIso, updated_at: nowIso }).eq("id", row.id);
        // 🚀 SEND IT (owner 09-04): chased signal arms for everyone else — Send It accounts fill at market now.
        try { await placeGenxGold({ side, entryLow: row.entry_low, entryHigh: row.entry_high, stop: row.stop, tp: row.tp1, conservativeOk: cOk, confidence: row.confidence, sendItOnly: true }); } catch { /* best-effort */ }
        try {
          const fKey = (row.entry_low != null && row.entry_high != null) ? `${row.mode}:${side}:${r1(row.entry_low)}:${r1(row.entry_high)}` : `id:${row.id}`;
          await placeGenxFollower({ signalKey: fKey, side, entryLow: row.entry_low, entryHigh: row.entry_high, stop: row.stop, tp: row.tp1, conservativeOk: cOk, confidence: row.confidence, sendItOnly: true });
        } catch { /* best-effort */ }
        sent.push(`${row.mode}:ARM`);
      } else if (act.do === "enter") {
        if (!armedNow && tgReady) await sendTelegram(enterMsg(side, row.mode, tgMsg, lp, false));
        await admin.from("genx_alerts").update({ state: "entered", enter_price: conf.enter ?? conf.price, enter_sent_at: nowIso, last_checked_at: nowIso, updated_at: nowIso }).eq("id", row.id);
        try { await placeGenxGold({ side, entryLow: row.entry_low, entryHigh: row.entry_high, stop: row.stop, tp: row.tp1, conservativeOk: cOk, confidence: row.confidence }); } catch { /* placement is best-effort */ }
        try {
          const fKey = (row.entry_low != null && row.entry_high != null) ? `${row.mode}:${side}:${r1(row.entry_low)}:${r1(row.entry_high)}` : `id:${row.id}`;
          await placeGenxFollower({ signalKey: fKey, side, entryLow: row.entry_low, entryHigh: row.entry_high, stop: row.stop, tp: row.tp1, conservativeOk: cOk, confidence: row.confidence });
        } catch { /* follower is best-effort */ }
        sent.push(`${row.mode}:ENTER`);
      } else if (act.do === "invalidate") {
        if (tgReady) await sendTelegram(invalidMsg(side, row.mode, { entry_low: row.entry_low, entry_high: row.entry_high, invalidation: row.invalidation }));
        await admin.from("genx_alerts").update({ state: "invalidated", last_checked_at: nowIso, updated_at: nowIso }).eq("id", row.id);
        sent.push(`${row.mode}:INVALID`);
      } else {
        await admin.from("genx_alerts").update({ last_checked_at: nowIso, updated_at: nowIso }).eq("id", row.id);
      }
    } catch { /* per-row best effort */ }
  }
  return { checked: rows.length, sent };
}
