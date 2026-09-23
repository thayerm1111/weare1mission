import { ctx, json, ownedAccount } from "../_lib";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/auric/events?accountId=&before=<iso>&limit=  — the decision timeline.
 * GET /api/auric/events?accountId=&replay=<positionId>   — a trade replay: only what was recorded from
 *     30 minutes before the entry until the close (events + the intent's frozen candidate). Nothing is recomputed.
 */
export async function GET(req: Request) {
  const r = await ctx(req); if (!r.ok) return r.res; const c = r.c;
  const u = new URL(req.url);
  const acct = await ownedAccount(c, u.searchParams.get("accountId") ?? ""); if (!acct) return json({ error: "account_not_found" }, 404);
  const replay = u.searchParams.get("replay");
  if (replay) {
    const { data: pos } = await c.admin.from("auric_positions").select("*").eq("id", replay).eq("account_id", acct.id).maybeSingle();
    if (!pos) return json({ error: "position_not_found" }, 404);
    const from = new Date(Date.parse(pos.opened_at) - 30 * 60_000).toISOString(), to = pos.closed_at ?? new Date().toISOString();
    const [{ data: events }, { data: intent }] = await Promise.all([
      c.admin.from("auric_events").select("id, at, kind, state, message, payload").eq("account_id", acct.id).gte("at", from).lte("at", to).order("at"),
      pos.intent_id ? c.admin.from("auric_intents").select("candidate, sizing, entry_ref, ack_latency_ms, fill_price, submitted_at, ack_at, status").eq("id", pos.intent_id).maybeSingle() : Promise.resolve({ data: null }),
    ]);
    return json({ ok: true, position: pos, intent: intent ?? null, events: events ?? [], note: "Replay shows only information recorded at decision time; nothing is recomputed with later data." });
  }
  const before = u.searchParams.get("before"); const limit = Math.min(200, Number(u.searchParams.get("limit") ?? 80));
  let q = c.admin.from("auric_events").select("id, at, kind, state, message, payload").eq("account_id", acct.id).order("at", { ascending: false }).limit(limit);
  if (before) q = q.lt("at", before);
  const { data } = await q;
  return json({ ok: true, events: data ?? [] });
}
