import { cashtrapAccess, json } from "@/lib/cashtrap/access";
import { ASSUMPTION_NOTES, effectiveConfig, SCREENSHOT_SETTINGS } from "@/lib/cashtrap/config";
import { DMI_SOURCE, dmiStatus } from "@/lib/cashtrap/dmi";
import { CASHTRAP_SYMBOLS, FEED_NAME, SYMBOL_SPECS } from "@/lib/cashtrap/symbols";
import { mutedKinds } from "@/lib/cashtrap/alerts";
import { nextClose } from "@/lib/cashtrap/candles";
import type { Snapshot } from "@/lib/cashtrap/snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The four market cards, the DMI status, and the rules/assumptions in force. */
export async function GET() {
  const a = await cashtrapAccess();
  if (!a.ok) return json({ error: a.error }, a.status);
  const r = await a.db.from("cashtrap_snapshots").select("symbol, snapshot, updated_at");
  const bySym = new Map(((r.data ?? []) as Array<{ symbol: string; snapshot: Snapshot }>).map((x) => [x.symbol, x.snapshot]));
  const now = Date.now();
  const cfg = effectiveConfig(a.settings.assumptions);
  const cards = CASHTRAP_SYMBOLS.map((s) => bySym.get(s) ?? null).map((snap, i) => ({
    symbol: CASHTRAP_SYMBOLS[i], spec: SYMBOL_SPECS[CASHTRAP_SYMBOLS[i]], snapshot: snap,
    stale: snap ? now - snap.updatedAt > 3 * 60_000 : true,
  }));
  const prefs = await a.db.from("cashtrap_notification_prefs").select("prefs, last_seen_alert_at").eq("user_id", a.userId).maybeSingle();
  const pr = prefs.data as { prefs?: { kinds?: Record<string, boolean> }; last_seen_alert_at?: string } | null;
  const seen = pr?.last_seen_alert_at ?? "1970-01-01T00:00:00Z";
  const muted = mutedKinds(pr?.prefs);
  let uq = a.db.from("cashtrap_alerts").select("id", { count: "exact", head: true }).gt("created_at", seen);
  if (muted.length) uq = uq.not("kind", "in", `(${muted.join(",")})`);
  const unread = await uq;
  return json({
    serverNow: now, nextCloseAt: nextClose(now), feed: FEED_NAME, cards,
    dmi: { ...dmiStatus(a.settings.dmiMode, a.settings.dmiFeedVerified), source: DMI_SOURCE },
    config: { strategyVersion: cfg.strategyVersion, configVersion: cfg.configVersion, screenshot: SCREENSHOT_SETTINGS, assumptions: cfg.assumptions, notes: ASSUMPTION_NOTES },
    settings: { visibility: a.settings.visibility, dmiMode: a.settings.dmiMode, liveEnabled: a.settings.liveEnabled },
    isAdmin: a.isAdmin, unreadAlerts: unread.count ?? 0,
  });
}
