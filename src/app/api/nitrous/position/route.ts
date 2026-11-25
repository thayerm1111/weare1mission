import { withNitrousDb } from "../../../../../rapid/db";
import { portForAccount, type PreparableAccount } from "../../../../../rapid/exec/prepare";
import { verifiedOwnedPosition } from "@/lib/nitrous/policy";
import { bodyOf, json, requireAccount, requireUser, unavailable } from "../_shared";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** A member request is queued. Only the leased worker sends a later broker close. */
export async function POST(req: Request) {
  try {
    const auth = await requireUser(req);
    if ("error" in auth) return auth.error;
    const body = await bodyOf(req);
    if (!body || body.action !== "close" || body.confirmed !== true) return json({ error: "Confirm closing this position before continuing." }, 400);
    const accountId = String(body.accountId ?? "");
    const positionId = String(body.positionId ?? "");
    const owned = await requireAccount(auth.admin, auth.user.id, accountId);
    if ("error" in owned) return owned.error;
    const result = await auth.admin.from("nitrous_positions").select("id,account_id,user_id,status,broker_position_id,broker_strategy_id,close_requested_at,close_request_state")
      .eq("id", positionId).eq("account_id", accountId).eq("user_id", auth.user.id).maybeSingle();
    if (result.error) return unavailable();
    const pos = result.data as Record<string, unknown> | null;
    if (!pos) return json({ error: "not_found" }, 404);
    if ((pos.close_requested_at || pos.status === "closing") && pos.close_request_state !== "rejected") {
      return json({ ok: true, queued: true, note: "A close has already been requested. Waiting for broker confirmation; no duplicate request was sent." });
    }
    if (pos.status !== "open" && !(pos.status === "closing" && pos.close_request_state === "rejected")) return json({ error: "position_not_open" }, 409);
    const port = await withNitrousDb(() => portForAccount(owned.account as PreparableAccount));
    if (!port.ok) return json({ error: "broker_unavailable", detail: "TradeLocker access must be restored before ownership can be verified." }, 409);
    const remote = await port.port.positions();
    if (!remote.ok) return json({ error: "broker_unavailable", detail: "TradeLocker could not verify this open position." }, 502);
    const broker = remote.rows.find((p) => p.positionId === pos.broker_position_id);
    if (!verifiedOwnedPosition(pos, broker)) return json({ error: "position_not_verified", detail: "This position could not be matched to a Nitrous execution. Manage it directly in TradeLocker while reconciliation completes." }, 409);
    const queued = await auth.admin.rpc("nitrous_request_close", {
      p_user: auth.user.id, p_account: accountId, p_position: positionId,
      p_broker_position: pos.broker_position_id, p_strategy: pos.broker_strategy_id,
    });
    if (queued.error) return unavailable();
    const out = Array.isArray(queued.data) ? queued.data[0] : queued.data;
    if (!out?.queued) return json({ error: "position_changed", detail: "The position changed during verification. Refresh its status." }, 409);
    return json({ ok: true, queued: true, note: "Close requested. It remains open until TradeLocker confirms the close. Auto trading remains at your selected setting." });
  } catch { return unavailable(); }
}
