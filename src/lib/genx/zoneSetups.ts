import { createAdminClient } from "@/lib/supabase/admin";
import { type Mode } from "@/lib/genxCompute";
import { livePrice } from "@/lib/marketData";
import { sendTelegram } from "@/lib/telegram";
import { placeGenxGold, placeGenxFollower } from "@/lib/flow/autoExec";

/**
 * GENX PAGE SETUPS → FLOW (owner 09-22: "I want flow to take those… I want to get those wins").
 *
 * The GENX page shows a setup even when the scanner's alert path does not fire: "wait for a sell trigger at
 * 4348.20, stop 4356.87, TP1 4319.29" (WAIT_FOR_*_TRIGGER) or a SELL_LIMIT / BUY_LIMIT at a level. Those reads
 * are logged in genx_signals and graded there. Re-graded correctly on the 1-minute archive (09-20 22:00 →
 * 09-22 13:00 UTC): 31 of 45 distinct setups reached their entry, 13 won / 18 lost, +1,479 pips net at TP1
 * (targets are far, stops are tight). The scanner's own calls lost over the same night.
 *
 * So this path takes them: every full scan REGISTERS the setup each horizon is showing (genx_alerts row,
 * state 'zone', key zone:<mode>:<side>:<entry>); a newer setup on the same horizon+side replaces the older
 * one. The fast watch (worker, ~2s) ENTERS when live price touches the entry — no confirmation candle, the
 * same rule the grade used — through the normal FLOW placement (risk-sized per account, one GENX gold trade
 * per account, break-even management, news/halt guards). A setup is dropped if price trades through its stop
 * first, and expires after 12 hours. Off switch: GENX_ZONE_SETUPS=off.
 */
type Admin = NonNullable<ReturnType<typeof createAdminClient>>;

export const ZONE_TOUCH_USD = 0.3;            // within 30 cents of the entry counts as a touch
export const ZONE_TTL_MS = 12 * 3600_000;     // same 12h arming window the regrade used
export const zoneSetupsOn = (): boolean => (process.env.GENX_ZONE_SETUPS ?? "").toLowerCase() !== "off";

type Read = { action?: unknown; entry?: unknown; stop_loss?: unknown; tp1?: unknown; tp2?: unknown; tp3?: unknown; confidence_score?: unknown; trigger_tf?: unknown };
const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Pure: the page setup a GENX read is showing, or null. */
export function zoneOf(g: Read): { side: "buy" | "sell"; entry: number; stop: number; tp1: number; tp2: number | null; tp3: number | null } | null {
  const a = String(g.action ?? "").toUpperCase();
  const side = /^WAIT_FOR_BUY_TRIGGER$|^BUY_LIMIT$/.test(a) ? "buy" : /^WAIT_FOR_SELL_TRIGGER$|^SELL_LIMIT$/.test(a) ? "sell" : null;
  const entry = n(g.entry), stop = n(g.stop_loss), tp1 = n(g.tp1);
  if (!side || entry == null || stop == null || tp1 == null) return null;
  if (side === "sell" ? !(stop > entry && entry > tp1) : !(stop < entry && entry < tp1)) return null;
  return { side, entry, stop, tp1, tp2: n(g.tp2), tp3: n(g.tp3) };
}

/** Pure: what to do with a registered setup at live price `lp`. */
export function zoneAction(side: "buy" | "sell", entry: number, stop: number, lp: number): "enter" | "invalidate" | "wait" {
  if (side === "sell") { if (lp >= stop) return "invalidate"; return lp >= entry - ZONE_TOUCH_USD ? "enter" : "wait"; }
  if (lp <= stop) return "invalidate";
  return lp <= entry + ZONE_TOUCH_USD ? "enter" : "wait";
}

/** Called once per horizon from the full scan. Never throws. */
export async function registerZone(admin: Admin, mode: Mode, g: Read, price: number | null): Promise<string> {
  try {
    if (!zoneSetupsOn()) return "off";
    const z = zoneOf(g);
    if (!z) return "no_setup";
    if (price != null && zoneAction(z.side, z.entry, z.stop, price) === "invalidate") return "beyond_stop";
    const key = `zone:${mode}:${z.side}:${z.entry.toFixed(1)}`;
    const nowIso = new Date().toISOString();
    // A newer setup on this horizon and side replaces the older one (GENX changed its mind).
    await admin.from("genx_alerts").update({ state: "replaced", updated_at: nowIso })
      .eq("state", "zone").eq("mode", mode).eq("side", z.side).neq("dedupe_key", key);
    const { error } = await admin.from("genx_alerts").insert({
      dedupe_key: key, mode, side: z.side, action: String(g.action),
      entry: z.entry, entry_low: +(z.entry - ZONE_TOUCH_USD).toFixed(2), entry_high: +(z.entry + ZONE_TOUCH_USD).toFixed(2),
      stop: z.stop, tp1: z.tp1, tp2: z.tp2, tp3: z.tp3, invalidation: z.stop, watch: z.entry,
      confidence: n(g.confidence_score), trigger_tf: g.trigger_tf != null ? String(g.trigger_tf) : null,
      state: "zone", last_checked_at: nowIso, quality_ok: true,
    });
    return error ? "already_registered" : "registered";
  } catch { return "error"; }
}

type ZoneRow = { id: string; dedupe_key: string; mode: Mode; side: "buy" | "sell"; entry: number; entry_low: number | null; entry_high: number | null; stop: number; tp1: number; tp2: number | null; tp3: number | null; confidence: number | null; created_at: string };

/** One pass of the fast watch. Enters a registered setup the moment price touches its entry. */
export async function zonePass(admin: Admin, mdKey: string, tgReady: boolean, enterMsg: (side: "buy" | "sell", mode: Mode, a: { entry_low: number | null; entry_high: number | null; stop: number | null; tp1: number | null; tp2: number | null; tp3: number | null }, atPrice: number | null, immediate: boolean) => string): Promise<string[]> {
  const sent: string[] = [];
  if (!zoneSetupsOn()) return sent;
  const { data } = await admin.from("genx_alerts").select("id,dedupe_key,mode,side,entry,entry_low,entry_high,stop,tp1,tp2,tp3,confidence,created_at").eq("state", "zone");
  const rows = (data ?? []) as ZoneRow[];
  if (!rows.length) return sent;
  const nowIso = new Date().toISOString();
  const lp = await livePrice("XAU/USD", mdKey, !process.env.VERCEL).catch(() => null);
  for (const r of rows) {
    try {
      if (Date.now() - Date.parse(r.created_at) > ZONE_TTL_MS) {
        await admin.from("genx_alerts").update({ state: "expired", updated_at: nowIso }).eq("id", r.id).eq("state", "zone");
        continue;
      }
      if (lp == null) continue;
      const act = zoneAction(r.side, Number(r.entry), Number(r.stop), lp);
      if (act === "invalidate") {
        await admin.from("genx_alerts").update({ state: "invalidated", last_checked_at: nowIso, updated_at: nowIso }).eq("id", r.id).eq("state", "zone");
        sent.push(`${r.mode}:ZONE_INVALID`);
        continue;
      }
      if (act !== "enter") continue;
      // Move the row forward FIRST, conditionally — two watchers can never both place it.
      const { data: won } = await admin.from("genx_alerts")
        .update({ state: "entered", enter_price: lp, enter_sent_at: nowIso, last_checked_at: nowIso, updated_at: nowIso })
        .eq("id", r.id).eq("state", "zone").select("id");
      if (!won || !(won as unknown[]).length) continue;
      const lvl = { entry_low: r.entry_low, entry_high: r.entry_high, stop: r.stop, tp1: r.tp1, tp2: r.tp2, tp3: r.tp3 };
      if (tgReady) { try { await sendTelegram(enterMsg(r.side, r.mode, lvl, lp, true)); } catch { /* note best-effort */ } }
      try { await placeGenxGold({ side: r.side, entryLow: r.entry_low, entryHigh: r.entry_high, stop: r.stop, tp: r.tp1, conservativeOk: true, confidence: r.confidence, mode: r.mode, setup: "genx_zone" }); } catch { /* placement best-effort */ }
      try { await placeGenxFollower({ signalKey: r.dedupe_key, side: r.side, entryLow: r.entry_low, entryHigh: r.entry_high, stop: r.stop, tp: r.tp1, conservativeOk: true, confidence: r.confidence, mode: r.mode, setup: "genx_zone" }); } catch { /* follower best-effort */ }
      sent.push(`${r.mode}:ZONE_ENTER`);
    } catch { /* per-row best effort */ }
  }
  return sent;
}
