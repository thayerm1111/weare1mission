import { body, json, requireOwner } from "../_shared";
import { addEvent, readControl, readSettings, updateControl } from "@/lib/fxscalper/store";
import { settingsBlockers } from "@/lib/fxscalper/settings";

export const dynamic = "force-dynamic";

/**
 * The owner's controls.
 *   start       START LIVE — confirms the settings version the owner was shown; the worker still has to
 *               be connected, reconciled and holding the lease before any order can leave.
 *   pause       stop NEW entries; open bot positions are still managed (stop, target, time exit).
 *   resume      allow new entries again.
 *   stop        mode stopped (no new entries); open bot positions are still managed until closed.
 *   close_bot   close every BOT position (and pause new entries). The owner's own positions are untouched.
 *   emergency   stop, close every bot position, cancel the bot's working orders.
 *   close_account_all   close EVERY position on the account — the owner's own and other tools' included.
 *               Requires typing CLOSE ALL.
 */
export async function POST(req: Request) {
  const a = await requireOwner();
  if ("error" in a) return a.error;
  const b = await body(req);
  const action = String(b.action ?? "");
  const control = await readControl(a.db);
  const now = new Date().toISOString();
  const expect = b.expectVersion == null ? null : Number(b.expectVersion);
  if (expect != null && !Number.isFinite(expect)) return json({ error: "expectVersion must be a number" }, 400);
  if (["start", "pause", "resume", "stop"].includes(action) && expect == null) return json({ error: "expectVersion is required" }, 400);

  const command = async (kind: "close_bot" | "emergency" | "close_account_all", note: string) => {
    const { error } = await a.db.from("fx_scalper_commands").insert({ kind, created_by: a.user.id });
    if (error) return json({ error: error.message }, 500);
    await addEvent(a.db, { level: kind === "close_bot" ? "warn" : "error", kind: `owner_${kind}`, message: note });
    return json({ ok: true });
  };

  // While the worker is closing every bot position (owner close-all, emergency stop or the daily loss
  // limit), nothing may reopen entries: START and Resume wait until it has finished.
  const closingAll = control.close_all_reason
    ? `Every bot position is being closed (${String(control.close_all_reason).replace(/_/g, " ")}). Wait until that has finished.`
    : null;

  switch (action) {
    case "start": {
      if (closingAll) return json({ error: closingAll }, 409);
      const settings = await readSettings(a.db);
      if (Number(b.settingsVersion) !== settings.version) return json({ error: "The settings changed since you reviewed them — review them again before starting." }, 409);
      const blockers = settingsBlockers(settings.settings);
      if (blockers.length) return json({ error: blockers.join(" ") }, 400);
      if (!control.connection_id || !control.account_id) return json({ error: "Connect and select the live account first." }, 400);
      const { data: st } = await a.db.from("fx_scalper_status").select("at").eq("id", 1).maybeSingle();
      const at = (st as { at: string | null } | null)?.at;
      if (!at || Date.now() - Date.parse(at) > 20_000) return json({ error: "The worker is not running (no heartbeat in the last 20 seconds). Start the worker service first." }, 409);
      const r = await updateControl(a.db, {
        mode: "live", entries_paused: false, pause_reason: null, pause_until: null, started_at: now, started_by: a.user.id,
        start_settings_version: settings.version, stop_reason: null,
      }, a.user.id, expect);
      if (!r.ok) return json({ error: r.reason }, 409);
      await addEvent(a.db, { level: "warn", kind: "start_live", message: `Owner pressed START LIVE on ${control.account_label ?? control.acc_num} with settings version ${settings.version}. Qualifying signals will now be traded automatically.` });
      return json({ ok: true, version: r.version });
    }
    case "pause": {
      const r = await updateControl(a.db, { entries_paused: true, pause_reason: "paused by the owner", pause_until: null }, a.user.id, expect);
      if (!r.ok) return json({ error: r.reason }, 409);
      await addEvent(a.db, { kind: "owner_pause", message: "Owner paused new entries. Open bot positions are still managed." });
      return json({ ok: true, version: r.version });
    }
    case "resume": {
      if (closingAll) return json({ error: closingAll }, 409);
      if (control.mode !== "live") return json({ error: "The bot is stopped; use START LIVE." }, 409);
      const r = await updateControl(a.db, { entries_paused: false, pause_reason: null, pause_until: null }, a.user.id, expect);
      if (!r.ok) return json({ error: r.reason }, 409);
      await addEvent(a.db, { kind: "owner_resume", message: "Owner resumed new entries." });
      return json({ ok: true, version: r.version });
    }
    case "stop": {
      const r = await updateControl(a.db, { mode: "stopped", stopped_at: now, stop_reason: "stopped by the owner" }, a.user.id, expect);
      if (!r.ok) return json({ error: r.reason }, 409);
      await addEvent(a.db, { level: "warn", kind: "owner_stop", message: "Owner stopped the bot. No new entries; open bot positions are still managed until they close." });
      return json({ ok: true, version: r.version });
    }
    case "close_bot":
      return command("close_bot", "Owner: close all bot-managed positions (new entries paused).");
    case "emergency": {
      const r = await updateControl(a.db, { mode: "stopped", entries_paused: true, pause_reason: "emergency stop (owner)", stopped_at: now, stop_reason: "emergency stop (owner)" }, a.user.id);
      if (!r.ok) return json({ error: r.reason }, 409);
      return command("emergency", "Owner: EMERGENCY STOP — bot stopped, closing every bot position, cancelling the bot's working orders.");
    }
    case "close_account_all": {
      if (String(b.confirm ?? "") !== "CLOSE ALL") return json({ error: 'Type CLOSE ALL to confirm closing every position on the account.' }, 400);
      return command("close_account_all", "Owner: close EVERY position on the account (including positions the bot did not open).");
    }
    default:
      return json({ error: "unknown action" }, 400);
  }
}
