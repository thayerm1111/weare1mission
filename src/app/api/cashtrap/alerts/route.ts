import { type NextRequest } from "next/server";
import { cashtrapAccess, json } from "@/lib/cashtrap/access";
import { CHANNELS, DEFAULT_ALERT_PREFS } from "@/lib/cashtrap/alerts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * In-app alerts and this member's notification preferences. Alerts are created once per event by the
 * runner (unique key); here they are only read, marked seen, and filtered by the member's choices.
 */
const DEFAULT_PREFS = DEFAULT_ALERT_PREFS;

export async function GET() {
  const a = await cashtrapAccess();
  if (!a.ok) return json({ error: a.error }, a.status);
  const p = await a.db.from("cashtrap_notification_prefs").select("prefs, last_seen_alert_at").eq("user_id", a.userId).maybeSingle();
  const row = (p.data as { prefs?: typeof DEFAULT_PREFS; last_seen_alert_at?: string } | null) ?? null;
  const prefs = { ...DEFAULT_PREFS, ...(row?.prefs ?? {}), kinds: { ...DEFAULT_PREFS.kinds, ...(row?.prefs?.kinds ?? {}) } };
  const r = await a.db.from("cashtrap_alerts").select("id, kind, symbol, title, body, created_at").order("created_at", { ascending: false }).limit(60);
  const all = (r.data ?? []) as Array<{ id: number; kind: keyof typeof DEFAULT_PREFS.kinds; created_at: string }>;
  const seen = row?.last_seen_alert_at ? Date.parse(row.last_seen_alert_at) : 0;
  const shown = all.filter((x) => prefs.kinds[x.kind] !== false);
  return json({
    alerts: shown.map((x) => ({ ...x, unread: Date.parse(x.created_at) > seen })), unread: shown.filter((x) => Date.parse(x.created_at) > seen).length, prefs,
    channels: [{ name: "in-app", configured: true, active: true }, ...CHANNELS.map((c) => ({ name: c.name, configured: c.configured(), active: c.configured(), kinds: c.kinds() }))],
  });
}

export async function POST(req: NextRequest) {
  const a = await cashtrapAccess();
  if (!a.ok) return json({ error: a.error }, a.status);
  const b = (await req.json().catch(() => ({}))) as { seen?: boolean; prefs?: { kinds?: Record<string, boolean>; sound?: boolean } };
  const patch: Record<string, unknown> = { user_id: a.userId, updated_at: new Date().toISOString() };
  if (b.seen) patch.last_seen_alert_at = new Date().toISOString();
  if (b.prefs) {
    const kinds = Object.fromEntries(Object.entries(b.prefs.kinds ?? {}).filter(([k, v]) => k in DEFAULT_PREFS.kinds && typeof v === "boolean"));
    patch.prefs = { kinds: { ...DEFAULT_PREFS.kinds, ...kinds }, sound: b.prefs.sound !== false };
  }
  const r = await a.db.from("cashtrap_notification_prefs").upsert(patch, { onConflict: "user_id" });
  if (r.error) return json({ error: r.error.message }, 500);
  return json({ ok: true });
}
