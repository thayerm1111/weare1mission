import { ctx, json } from "../_lib";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Administrator controls (profiles.role = admin only).
 *  { action:"set_price", credits:number|null }        — daily session price; null = not for sale
 *  { action:"engine", enabled:boolean }               — global worker flag
 *  { action:"live_orders", enabled:boolean }          — global live-order flag
 *  { action:"member_live_self_authorize", enabled }   — signed per-account consent also grants live authorization
 *  { action:"authorize_live", accountId, enabled }    — per-account live authorization
 *  { action:"review_drawdown", accountId }            — clears a DRAWDOWN latch after deliberate review
 *  { action:"block", accountId, reason } / { action:"unblock", accountId }
 */
export async function POST(req: Request) {
  const r = await ctx(req); if (!r.ok) return r.res; const c = r.c;
  if (!c.isAdmin) return json({ error: "forbidden" }, 403);
  let b: { action?: string; credits?: number | null; enabled?: boolean; accountId?: string; reason?: string };
  try { b = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const now = new Date().toISOString(); const by = c.user.id;
  const set = (key: string, value: unknown) => c.admin.from("auric_settings").upsert({ key, value, updated_at: now, updated_by: by });
  const acctEvent = (accountId: string, message: string) => c.admin.from("auric_events").insert({ account_id: accountId, kind: "admin", message });
  switch (b.action) {
    case "set_price": {
      const v = b.credits == null ? null : Math.max(1, Math.round(Number(b.credits)));
      if (b.credits != null && !Number.isFinite(v as number)) return json({ error: "bad_price" }, 400);
      await set("daily_price_credits", v); return json({ ok: true, price: v });
    }
    case "engine": await set("engine_enabled", b.enabled === true); return json({ ok: true });
    case "live_orders": await set("live_orders_enabled", b.enabled === true); return json({ ok: true });
    case "member_live_self_authorize": await set("member_live_self_authorize", b.enabled === true); return json({ ok: true });
    case "authorize_live": {
      const { data: a } = await c.admin.from("auric_accounts").select("id").eq("id", String(b.accountId)).maybeSingle(); if (!a) return json({ error: "account_not_found" }, 404);
      await c.admin.from("auric_accounts").update({ live_authorized_at: b.enabled ? now : null, live_authorized_by: b.enabled ? by : null, updated_at: now }).eq("id", a.id);
      await acctEvent(a.id, b.enabled ? "Live orders authorized for this account by an administrator." : "Live authorization withdrawn by an administrator; monitoring continues, orders will not be sent.");
      return json({ ok: true });
    }
    case "review_drawdown": {
      const { data: rs } = await c.admin.from("auric_risk_state").select("state").eq("account_id", String(b.accountId)).maybeSingle();
      if (!rs) return json({ error: "no_risk_state" }, 404);
      const st = rs.state as Record<string, unknown>;
      const eq = Number((await c.admin.from("auric_accounts").select("equity").eq("id", String(b.accountId)).maybeSingle()).data?.equity ?? st.peakEquity);
      await c.admin.from("auric_risk_state").update({ state: { ...st, latched: null, peakEquity: eq }, updated_at: now }).eq("account_id", String(b.accountId));
      await acctEvent(String(b.accountId), `Drawdown latch cleared after administrator review; peak equity rebased to $${eq.toFixed(2)}.`);
      return json({ ok: true });
    }
    case "block": {
      await c.admin.from("auric_accounts").update({ status: "blocked", block_reason: String(b.reason ?? "blocked by administrator"), updated_at: now }).eq("id", String(b.accountId));
      await c.admin.from("auric_sessions").update({ paused_entries: true, pause_reason: "account blocked by administrator" }).eq("account_id", String(b.accountId)).eq("status", "active");
      await acctEvent(String(b.accountId), `Account blocked: ${b.reason ?? "by administrator"}. Open AURIC positions remain managed.`); return json({ ok: true });
    }
    case "unblock": await c.admin.from("auric_accounts").update({ status: "linked", block_reason: null, updated_at: now }).eq("id", String(b.accountId)); return json({ ok: true });
    default: return json({ error: "unknown_action" }, 400);
  }
}

export async function GET(req: Request) {
  const r = await ctx(req); if (!r.ok) return r.res; const c = r.c;
  if (!c.isAdmin) return json({ error: "forbidden" }, 403);
  const [{ data: settings }, { data: accounts }, { data: sessions }, { data: hb }] = await Promise.all([
    c.admin.from("auric_settings").select("*"),
    c.admin.from("auric_accounts").select("id, user_id, broker_account_id, acc_num, name, currency, equity, status, consent_at, live_authorized_at, allow_shared_account, risk_fraction, spec_missing, created_at").order("created_at", { ascending: false }).limit(200),
    c.admin.from("auric_sessions").select("id, user_id, account_id, starts_at, expires_at, credits_charged, status, paused_entries, pause_reason, auto_renew").order("created_at", { ascending: false }).limit(100),
    c.admin.from("auric_worker_heartbeat").select("*").order("at", { ascending: false }).limit(5),
  ]);
  const connIds = [...new Set((accounts ?? []).map((a) => a.id))];
  void connIds;
  const { data: conns } = await c.admin.from("auric_broker_connections").select("id, user_id, env, server, status, last_error, imported_from");
  return json({ ok: true, settings, accounts, sessions, heartbeats: hb, connections: conns });
}
