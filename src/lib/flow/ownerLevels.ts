import { createAdminClient } from "@/lib/supabase/admin";
import { livePrice } from "@/lib/marketData";
import { confirmEntry } from "@/lib/genxConfirm";
import { placeGenxGold } from "@/lib/flow/autoExec";
import { sendTelegram, esc } from "@/lib/telegram";

/**
 * MY LEVELS — the owner's own support/resistance lines, traded by GENX (owner 09-07:
 * "I wish the AI knew how I actually trade — I would have taken that buy at the support
 * and caught the whole move").
 *
 * The owner draws a level (one price) in the admin panel. The scanner watches it:
 *   • Which way it trades is decided by WHERE PRICE IS — price above the level makes it
 *     support (a bounce is a BUY); price below makes it resistance (a rejection is a SELL).
 *     The same line flips roles automatically after it breaks, exactly like it does on a chart.
 *   • Entry style per the owner's pick: REJECTION FIRST — price must reach the level and a
 *     5-minute candle must CLOSE rejecting it (zone rejection or sweep-and-reclaim; the
 *     momentum-breakout shortcut is disabled for level plays). No blind limit at the line,
 *     so a level that simply breaks is never bought on the way through.
 *   • Stop goes BEYOND the level (invalidation ~ $2.6 past it; the executor's structural-stop
 *     pad still applies), target = the owner's next level in the profit direction when one
 *     exists, else 1.6R. Sizing, credit metering, one-open-gold, kill switch, halts — all the
 *     normal placement rules apply; the play fans out to members like any GENX signal.
 *   • One shot per approach: firing claims the level atomically (no double-fire across
 *     overlapping scans) and puts it on a 4-hour cooldown.
 */

const LEVEL_ZONE_PAD = 1.0;      // zone = level ± $1.00 (10 pips)
const LEVEL_INVALIDATION = 2.6;  // invalidation $2.60 beyond the level
const LEVEL_NEAR = 5.0;          // only work levels within $5 of live price
const LEVEL_COOLDOWN_H = 4;      // hours before the same level may fire again
const LEVEL_MIN_TP_DIST = 6.0;   // a target level must be at least $6 away to count
const FALLBACK_TP_R = 1.6;       // no next level → 1.6R synthetic target

type Admin = NonNullable<ReturnType<typeof createAdminClient>>;
export type OwnerLevel = { id: string; price: number; label: string | null; active: boolean; triggered_at: string | null };

/** Pure helpers, exported for unit tests. */
export function levelSide(live: number, level: number): "buy" | "sell" {
  return live >= level ? "buy" : "sell"; // above → support (buy the bounce); below → resistance (sell it)
}
export function levelTarget(side: "buy" | "sell", entry: number, stop: number, others: number[]): number {
  const risk = Math.abs(entry - stop);
  const candidates = others
    .filter((p) => (side === "buy" ? p > entry + LEVEL_MIN_TP_DIST : p < entry - LEVEL_MIN_TP_DIST))
    .sort((a, b) => (side === "buy" ? a - b : b - a));
  if (candidates.length) return +candidates[0].toFixed(2);
  return +(side === "buy" ? entry + FALLBACK_TP_R * risk : entry - FALLBACK_TP_R * risk).toFixed(2);
}

/**
 * One pass: look at every active owner level near the live price; if a 5-minute close has
 * confirmed a rejection at one, claim it and fire the GENX placement + a Telegram note.
 * Best-effort by design — any failure just means "not this tick".
 */
export async function checkOwnerLevels(admin: Admin, mdKey: string): Promise<{ checked: number; fired: number }> {
  try {
    const { data } = await admin
      .from("genx_owner_levels")
      .select("id, price, label, active, triggered_at")
      .eq("active", true)
      .order("price", { ascending: true })
      .limit(40);
    const levels = (data ?? []) as OwnerLevel[];
    if (!levels.length) return { checked: 0, fired: 0 };

    const live = await livePrice("XAU/USD", mdKey, false);
    if (typeof live !== "number" || !Number.isFinite(live)) return { checked: 0, fired: 0 };

    const cooldownMs = LEVEL_COOLDOWN_H * 3600_000;
    const near = levels.filter((l) =>
      Number.isFinite(l.price) && Math.abs(live - l.price) <= LEVEL_NEAR &&
      (!l.triggered_at || Date.now() - Date.parse(l.triggered_at) > cooldownMs),
    );
    let fired = 0;

    for (const lv of near) {
      const side = levelSide(live, lv.price);
      const zoneLo = +(lv.price - LEVEL_ZONE_PAD).toFixed(2);
      const zoneHi = +(lv.price + LEVEL_ZONE_PAD).toFixed(2);
      const inv = +(side === "buy" ? lv.price - LEVEL_INVALIDATION : lv.price + LEVEL_INVALIDATION).toFixed(2);

      const res = await confirmEntry({
        side, entryLow: zoneLo, entryHigh: zoneHi, watch: lv.price, invalidation: inv,
        mode: "quick", mdKey, fresh: false, noMomentum: true,
      });
      if (res.state !== "CONFIRMED" || res.enter == null) continue;

      // ATOMIC CLAIM — one fire per approach even with overlapping scan invocations.
      const cutoffIso = new Date(Date.now() - cooldownMs).toISOString();
      const { data: claimed } = await admin
        .from("genx_owner_levels")
        .update({ triggered_at: new Date().toISOString() })
        .eq("id", lv.id)
        .or(`triggered_at.is.null,triggered_at.lt.${cutoffIso}`)
        .select("id");
      if (!claimed || !claimed.length) continue; // another invocation beat us to it

      const entry = res.enter;
      const tp = levelTarget(side, entry, inv, levels.filter((o) => o.id !== lv.id).map((o) => o.price));
      try {
        await placeGenxGold({ side, entryLow: zoneLo, entryHigh: zoneHi, stop: inv, tp, conservativeOk: true, confidence: 70 });
        fired += 1;
        const name = lv.label ? `${lv.label} (${lv.price})` : String(lv.price);
        await sendTelegram(
          `🎯 <b>GENX — OWNER LEVEL · ${side === "buy" ? "BUY" : "SELL"}</b>\n` +
          `${esc(side === "buy" ? "Support" : "Resistance")} at <b>${esc(name)}</b> held — ${esc(res.detail)}\n` +
          `Entry ~${entry.toFixed(2)} · Stop ${inv.toFixed(2)} · TP ${tp.toFixed(2)}\n` +
          `<i>Educational, not financial advice.</i>`,
        );
      } catch { /* placement/telegram best-effort — the claim stands so it can't machine-gun */ }
    }
    return { checked: near.length, fired };
  } catch {
    return { checked: 0, fired: 0 }; // table missing / read error → quiet no-op
  }
}
