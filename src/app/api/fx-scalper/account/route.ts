import { body, json, requireOwner } from "../_shared";
import { addEvent, readControl, updateControl } from "@/lib/fxscalper/store";

export const dynamic = "force-dynamic";

/**
 * Choose which account on a connected login the bot trades — only while the bot is STOPPED, and only an
 * account the broker listed for that login at sign-in (a client-sent id is a request, not a claim).
 * Disconnecting (accountId null) clears the selection and revokes the connection's stored credentials.
 */
export async function POST(req: Request) {
  const a = await requireOwner();
  if ("error" in a) return a.error;
  const b = await body(req);
  const control = await readControl(a.db);
  if (control.mode !== "stopped") return json({ error: "Stop the bot before changing its account." }, 409);
  const live = await a.db.from("fx_scalper_trades").select("id").in("state", ["reserved", "sending", "acknowledged", "uncertain", "open", "closing"]).limit(1);
  if ((live.data ?? []).length) return json({ error: "Bot trades are still open or being confirmed; wait until they are closed." }, 409);

  if (b.disconnect === true) {
    const id = control.connection_id;
    const r = await updateControl(a.db, { connection_id: null, account_id: null, acc_num: null, account_label: null, account_currency: null }, a.user.id);
    if (!r.ok) return json({ error: r.reason }, 409);
    if (id) await a.db.from("fx_scalper_connections").update({ status: "revoked", enc_email: null, enc_password: null, enc_access: null, enc_refresh: "revoked", updated_at: new Date().toISOString() }).eq("id", id);
    await addEvent(a.db, { kind: "disconnected", message: "Owner disconnected the broker account; its stored credentials were erased." });
    return json({ ok: true });
  }

  const connectionId = String(b.connectionId ?? "");
  const accountId = String(b.accountId ?? "");
  const accNum = String(b.accNum ?? "");
  const { data: conn } = await a.db.from("fx_scalper_connections").select("id, status, server, accounts").eq("id", connectionId).maybeSingle();
  const row = conn as { id: string; status: string; server: string; accounts: Array<{ accountId: string; accNum: string; name: string | null; currency: string | null }> } | null;
  if (!row || row.status === "revoked") return json({ error: "That connection does not exist." }, 404);
  const acct = (row.accounts ?? []).find((x) => x.accountId === accountId && x.accNum === accNum);
  if (!acct) return json({ error: "That account was not listed for this login." }, 400);
  const label = `${row.server} · ${acct.name ?? `#${acct.accNum}`}`;
  const r = await updateControl(a.db, { connection_id: row.id, account_id: acct.accountId, acc_num: acct.accNum, account_label: label, account_currency: acct.currency }, a.user.id, Number(b.expectVersion ?? control.version));
  if (!r.ok) return json({ error: r.reason }, 409);
  await addEvent(a.db, { kind: "account_selected", message: `Owner selected ${label} (accNum ${acct.accNum}, ${acct.currency ?? "currency unknown"}). The bot stays stopped.` });
  return json({ ok: true, version: r.version });
}
