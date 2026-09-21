import { createAdminClient } from "@/lib/supabase/admin";
import { genx2Active } from "@/lib/genx3/engineSelect";
import { type Mode } from "@/lib/genxCompute";
import { confirmEntry } from "@/lib/genxConfirm";
import { sendTelegram, esc } from "@/lib/telegram";
import { genxLabel } from "@/lib/genx/brand";
import { warmGoldFleet } from "@/lib/flow/warmFleet";
import { placeGenxGold, placeGenxFollower, rewardRisk } from "@/lib/flow/autoExec";
import { beat } from "@/lib/flow/health";
import { genx2FlagsSnapshot } from "@/lib/genx2/flags";

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
    // ── FAST ZONE FILL (owner 09-13: "fill me at the zone, this needs to be faster") ──
    // Price being IN the entry zone with a takeable reward:risk IS the entry — take it at
    // market RIGHT NOW, instead of waiting for the interval CLOSE to "confirm". That close
    // is exactly what lagged fast moves: gold ran ~40 pips through a 1.8:1 sell zone before
    // the 5-min close confirmed, so the desk only ever saw the chased 0.63 price and skipped
    // it. This is the resting-limit behavior the owner asked for — fill ~at the called zone;
    // the break-even + stop handle the minority of fills that keep going. Guards intact:
    //   • R:R floor still applies (a zone whose target is too close is NOT taken here),
    //   • if price has already run PAST the zone (not inZone) it falls through to the old
    //     confirm/arm path and placeGenxGold's chase guard still owns the chased price,
    //   • two-strike / news / post-win / send-it gates all live downstream in placeGenxGold.
    // The fast-watch runs ~1s on the worker, so a descent through the ~10-pip zone lands a
    // pass while price is in it; only a >10-pip/sec spike outruns it (a true broker limit
    // order would be the next step for that, but this fixes the lag for the common case).
    // OFF since 09-21 (owner: "this exact strategy" — the GENX page's rule is wait for the zone, then a
    // candle CLOSE that confirms). The touch-fill entered on contact with no confirmation; since it went in
    // on 09-11 the calls that waited for a zone won 11 and lost 22. GENX_ZONE_TOUCH_FILL=on restores it.
    if ((process.env.GENX_ZONE_TOUCH_FILL ?? "").toLowerCase() === "on" && inZone && rr != null && rr >= GOLD_ENTRY_FLOOR_RR) return { do: "enter", reason: "in_zone_fill" };
    if (o.confState !== "CONFIRMED") return { do: "wait", reason: "pending:" + o.confState };
    if (takeable) return { do: "enter", reason: "confirmed_rr_ok" };
    return { do: "arm", reason: "chased_below_floor" };
  }
  if (takeable) return { do: "enter", reason: "pullback_to_entry" };
  if (elapsed > GOLD_ARM_MAX_MS) return { do: "invalidate", reason: "arm_expired_5min" };
  return { do: "wait", reason: "armed_waiting" };
}

export const MODE_LABEL: Record<Mode, string> = { quick: "Quick", intraday: "Intraday", swing: "Swing" };
/**
 * The trade TYPE, in the words members use — so every GENX call says which of the three it is in the
 * first line: "GENX 1.0 SCALP", "GENX 1.0 NORMAL", "GENX 1.0 SWING". Before 09-20 the type sat at the
 * end of the line as "Quick" / "Intraday" and the calls read as identical.
 */
export const TYPE_LABEL: Record<Mode, string> = { quick: "QUICK", intraday: "INTRADAY", swing: "SWING" };
// Owner 09-21: the three GENX horizons, named as on the GENX page — QUICK, INTRADAY, SWING.
export const genxTyped = (mode: Mode): string => `${genxLabel()} ${TYPE_LABEL[mode] ?? ""}`.trim();
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
    `⏳ <b>${genxTyped(mode)} — ${dir} setup forming</b>`,
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
    `✅ <b>${genxTyped(mode)} — ENTER NOW · ${dir}</b>`,
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
    `❌ <b>${genxTyped(mode)} — Setup invalidated · ${dir}</b>`,
    `The ${esc(zone)} ${dir.toLowerCase()} is off — price closed beyond ${fmt(a.invalidation)}. Don't take it.`,
  ].join("\n");
}

/** Heartbeat that PRESERVES the last recorded decision detail (watchdog reads it).
 *  Also stamps the LIVE GENX 2.0 flag state. The flags are read from env at call time
 *  and were previously recorded nowhere, so "are the new families actually on?" could
 *  only be inferred from the shape of a decision — and only when the market happened to
 *  produce a setup in the band where v1 and v2 disagree. Stamping them here answers it
 *  directly, per process: the worker and the Vercel cron each write their own view, and
 *  `worker` in the same detail says which one you are looking at. */
export async function beatKeepDecision(admin: Admin, extra: Record<string, unknown>): Promise<void> {
  const flags = genx2FlagsSnapshot();
  try {
    const { data } = await admin.from("flow_heartbeat").select("detail").eq("component", "genx").maybeSingle();
    const last = (data as { detail?: { last_decision?: unknown } } | null)?.detail?.last_decision;
    await beat(admin, "genx", { ...extra, flags, ...(last !== undefined ? { last_decision: last } : {}) });
  } catch { try { await beat(admin, "genx", { ...extra, flags }); } catch { /* liveness best-effort */ } }
}

// ── SAME-SETUP DEDUPE (owner 09-16: the same SELL posted 5+ times with slightly different zones) ──
// The engine re-derives the entry zone on every scan, so it drifts a dollar or two and the exact-zone
// dedupe key changes — each drift used to become a "new" setup with its own heads-up, ENTER NOW and
// later "invalidated" note. A setup on the same side whose zone is within SAME_SETUP_USD (or 1.5× the
// zone width) of a still-open alert (forming/entered, not yet graded, last 4h) IS that setup.
export const SAME_SETUP_USD = 6;
export const SAME_SETUP_WINDOW_MS = 4 * 3600_000;
type ZoneLike = { side: "buy" | "sell"; entry_low: number | null; entry_high: number | null };
export function sameSetupZone(a: ZoneLike, b: ZoneLike): boolean {
  if (a.side !== b.side || a.entry_low == null || a.entry_high == null || b.entry_low == null || b.entry_high == null) return false;
  const mid = (z: ZoneLike) => (Number(z.entry_low) + Number(z.entry_high)) / 2;
  const width = Math.max(Math.abs(Number(a.entry_high) - Number(a.entry_low)), Math.abs(Number(b.entry_high) - Number(b.entry_low)));
  return Math.abs(mid(a) - mid(b)) <= Math.max(SAME_SETUP_USD, 1.5 * width);
}
/** Open GENX 1.0 scanner alerts (not the PDH/PDL module's) that are the same setup as this zone. */
export async function findSameSetup(admin: Admin, z: ZoneLike, excludeId?: string): Promise<AlertRow | null> {
  const since = new Date(Date.now() - SAME_SETUP_WINDOW_MS).toISOString();
  const { data } = await admin.from("genx_alerts").select("*").eq("side", z.side).in("state", ["forming", "entered"]).is("outcome", null)
    .like("dedupe_key", "quick:%").gte("created_at", since).order("created_at", { ascending: true }).limit(50);
  for (const r of (data ?? []) as AlertRow[]) if (r.id !== excludeId && sameSetupZone(r, z)) return r;
  return null;
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
  if (!genx2Active()) return { checked: 0, sent: [] }; // GENX 2.0 retired while GENX 3.0 is active (owner 09-16)
  const nowIso = new Date().toISOString();
  const { data } = await admin.from("genx_alerts").select("*").eq("state", "forming");
  const rows = ((data ?? []) as AlertRow[]).sort((x, y) => Date.parse(x.created_at) - Date.parse(y.created_at));
  // Entry speed: a setup is forming and could confirm any second — keep every member's broker login warm (worker only).
  if (rows.length && process.env.WORKER_WARM_FLEET !== "off" && typeof process !== "undefined" && !process.env.VERCEL) warmGoldFleet(`${rows.length} forming GENX setup(s)`);
  const sent: string[] = [];
  for (const row of rows) {
    try {
      const side = row.side;
      // SAME-SETUP DEDUPE: a later forming alert that duplicates an earlier open alert (zone drift) is
      // retired SILENTLY — no second ENTER NOW, no extra "invalidated" note.
      if (row.dedupe_key.startsWith("quick:")) {
        const twin = await findSameSetup(admin, row, row.id);
        if (twin && Date.parse(twin.created_at) <= Date.parse(row.created_at)) {
          await admin.from("genx_alerts").update({ state: "invalidated", last_checked_at: nowIso, updated_at: nowIso }).eq("id", row.id).eq("state", "forming");
          sent.push(`${row.mode}:MERGED`);
          continue;
        }
      }
      const conf = await confirmEntry({
        side, entryLow: (row.entry_low ?? 0) as number, entryHigh: (row.entry_high ?? 0) as number,
        watch: (row.watch ?? row.entry_low ?? 0) as number, invalidation: (row.invalidation ?? row.stop ?? 0) as number,
        // Confirmation on the horizon's OWN closed candle, as the GENX page reads it (owner 09-21: "this exact
        // strategy"): quick 5-minute, intraday 15-minute, swing 1-hour. Was a 1-minute close for every horizon.
        mode: row.mode, mdKey, fresh: true,
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
        try { await placeGenxGold({ side, entryLow: row.entry_low, entryHigh: row.entry_high, stop: row.stop, tp: row.tp1, conservativeOk: cOk, confidence: row.confidence, sendItOnly: true, mode: row.mode }); } catch { /* best-effort */ }
        try {
          const fKey = (row.entry_low != null && row.entry_high != null) ? `${row.mode}:${side}:${r1(row.entry_low)}:${r1(row.entry_high)}` : `id:${row.id}`;
          await placeGenxFollower({ signalKey: fKey, side, entryLow: row.entry_low, entryHigh: row.entry_high, stop: row.stop, tp: row.tp1, conservativeOk: cOk, confidence: row.confidence, sendItOnly: true, mode: row.mode });
        } catch { /* best-effort */ }
        sent.push(`${row.mode}:ARM`);
      } else if (act.do === "enter") {
        if (!armedNow && tgReady) await sendTelegram(enterMsg(side, row.mode, tgMsg, lp, false));
        await admin.from("genx_alerts").update({ state: "entered", enter_price: conf.enter ?? conf.price, enter_sent_at: nowIso, last_checked_at: nowIso, updated_at: nowIso }).eq("id", row.id);
        try { await placeGenxGold({ side, entryLow: row.entry_low, entryHigh: row.entry_high, stop: row.stop, tp: row.tp1, conservativeOk: cOk, confidence: row.confidence, mode: row.mode }); } catch { /* placement is best-effort */ }
        try {
          const fKey = (row.entry_low != null && row.entry_high != null) ? `${row.mode}:${side}:${r1(row.entry_low)}:${r1(row.entry_high)}` : `id:${row.id}`;
          await placeGenxFollower({ signalKey: fKey, side, entryLow: row.entry_low, entryHigh: row.entry_high, stop: row.stop, tp: row.tp1, conservativeOk: cOk, confidence: row.confidence, mode: row.mode });
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
