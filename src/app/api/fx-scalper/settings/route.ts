import { body, json, requireOwner } from "../_shared";
import { applySettingsPatch } from "@/lib/fxscalper/settings";
import { addEvent, readSettings, saveSettings } from "@/lib/fxscalper/store";

export const dynamic = "force-dynamic";

/**
 * Edit the settings. The edit is validated as a whole (an out-of-range value is refused with its reason,
 * never clamped) and saved only if nobody saved since the page loaded. Changes apply to the NEXT entry;
 * a trade already open keeps the stop, target and time exit it was opened with.
 */
export async function POST(req: Request) {
  const a = await requireOwner();
  if ("error" in a) return a.error;
  const b = await body(req);
  const current = await readSettings(a.db);
  const expect = Number(b.expectVersion);
  if (!Number.isFinite(expect)) return json({ error: "expectVersion is required" }, 400);
  if (expect !== current.version) return json({ error: "The settings changed since this page loaded — reload and try again." }, 409);
  const r = applySettingsPatch(current.settings, b.patch);
  if (!r.ok) return json({ error: "Some values were not accepted.", errors: r.errors }, 400);
  const saved = await saveSettings(a.db, r.settings, current.version, a.user.id);
  if (!saved.ok) return json({ error: saved.reason }, 409);
  await addEvent(a.db, { kind: "settings_changed", message: `Owner changed the settings (version ${saved.version}).`, data: { patch: b.patch as Record<string, unknown> } });
  return json({ ok: true, version: saved.version, settings: r.settings });
}
