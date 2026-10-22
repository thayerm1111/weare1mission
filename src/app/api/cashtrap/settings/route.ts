import { type NextRequest } from "next/server";
import { cashtrapAccess, json } from "@/lib/cashtrap/access";
import { ASSUMPTION_NOTES, effectiveConfig, resolveAssumptions, SCREENSHOT_SETTINGS } from "@/lib/cashtrap/config";
import { CHANNELS } from "@/lib/cashtrap/alerts";
import { revalidateTag } from "next/cache";
import { CASHTRAP_VISIBILITY_TAG } from "@/lib/cashtrap/visibility";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Cashtrap settings (admin). Screenshot settings are fixed in code; only the V1 assumptions and switches change here, and every change is logged. */
export async function GET() {
  const a = await cashtrapAccess({ admin: true });
  if (!a.ok) return json({ error: a.error }, a.status);
  const cfg = effectiveConfig(a.settings.assumptions);
  return json({
    settings: a.settings, screenshot: SCREENSHOT_SETTINGS, notes: ASSUMPTION_NOTES, configVersion: cfg.configVersion, strategyVersion: cfg.strategyVersion,
    channels: CHANNELS.map((c) => ({ name: c.name, configured: c.configured(), kinds: c.kinds() })),
    env: { dmiFeedSecret: !!process.env.CASHTRAP_DMI_FEED_SECRET },
  });
}

export async function POST(req: NextRequest) {
  const a = await cashtrapAccess({ admin: true });
  if (!a.ok) return json({ error: a.error }, a.status);
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  if (b.assumptions !== undefined) {
    const r = resolveAssumptions({ ...a.settings.assumptions, ...(b.assumptions as object) });
    if (!r.ok) return json({ error: "invalid assumptions", details: r.errors }, 400);
    patch.assumptions = r.value;
  }
  if (b.visibility !== undefined) {
    if (b.visibility !== "admin" && b.visibility !== "members") return json({ error: "visibility: admin or members" }, 400);
    patch.visibility = b.visibility;
  }
  if (b.dmiMode !== undefined) {
    if (!["calculation", "event-feed", "off"].includes(String(b.dmiMode))) return json({ error: "dmiMode: calculation, event-feed or off" }, 400);
    patch.dmi_mode = b.dmiMode;
  }
  if (b.dmiFeedVerified !== undefined) patch.dmi_feed_verified = b.dmiFeedVerified === true;
  if (b.liveEnabled !== undefined) patch.live_enabled = b.liveEnabled === true;
  if (!Object.keys(patch).length) return json({ error: "nothing to change" }, 400);
  const before = await a.db.from("cashtrap_settings").select("*").eq("id", 1).maybeSingle();
  const up = await a.db.from("cashtrap_settings").update({ ...patch, updated_at: new Date().toISOString(), updated_by: a.userId }).eq("id", 1).select("*");
  if (up.error) return json({ error: up.error.message }, 500);
  await a.db.from("cashtrap_settings_log").insert({ changed_by: a.userId, before_value: before.data ?? null, after_value: (up.data ?? [])[0] ?? null });
  if (patch.visibility !== undefined) { try { revalidateTag(CASHTRAP_VISIBILITY_TAG); } catch { /* the menu link catches up within a minute */ } }
  return json({ ok: true, settings: (up.data ?? [])[0] });
}
