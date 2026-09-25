import { json, requireAccount, requireUser } from "../_shared";

export const dynamic = "force-dynamic";

/**
 * Close Rapid Position.
 *
 * A control of its own, deliberately separate from Automation OFF. Turning automation off stops new
 * entries; it does not close what is already open, and conflating the two would mean a member who
 * wanted to stop taking trades silently liquidated the one they were in.
 *
 * The request is QUEUED for the worker that holds the account lease rather than executed here. A web
 * request and a worker both sending closes for the same position is how a position gets closed twice.
 */
export async function POST(req: Request) {
  const auth = await requireUser();
  if ("error" in auth) return auth.error;
  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; } catch { return json({ error: "bad_request" }, 400); }

  const accountId = String(body.accountId ?? "");
  const positionId = String(body.positionId ?? "");
  if (!accountId || !positionId) return json({ error: "accountId and positionId are required" }, 400);

  const owned = await requireAccount(auth.user.id, accountId);
  if ("error" in owned) return owned.error;
  const { admin } = owned;

  const { data: pos } = await admin.from("rapid_positions").select("id, status, account_id").eq("id", positionId).maybeSingle();
  const p = pos as { id?: string; status?: string; account_id?: string } | null;
  if (!p || p.account_id !== accountId) return json({ error: "not_found" }, 404);
  if (p.status !== "open") return json({ error: "not_open", detail: `the position is ${p.status}` }, 409);

  await admin.from("rapid_position_actions").insert({
    position_id: positionId, action: "manual_close", requested: { by: auth.user.id },
    acknowledged: false, reason: "member pressed Close Rapid Position",
  });
  await admin.from("rapid_positions").update({ status: "closing", close_reason: "member requested a close", updated_at: new Date().toISOString() }).eq("id", positionId);
  await admin.from("rapid_journal").insert({
    account_id: accountId, user_id: auth.user.id, stage: "manual", code: "close_requested",
    decision: "queued", reason: "the worker holding this account's lease will send the close and confirm it",
  });

  return json({
    ok: true,
    queued: true,
    // Said plainly, because "closed" on screen while the broker still holds the position is the
    // single most misleading thing this product could say.
    note: "Close requested. It is not closed until the broker confirms it; the status will move from Closing to Closed when that happens.",
  });
}
