import { ctx, json, ownedAccount } from "../_lib";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/auric/control { accountId, action }
 *   pause_entries   — stop NEW entries; open positions stay managed (distinct from closing).
 *   resume_entries  — allowed unless a hard breaker is latched (DRAWDOWN needs admin review).
 *   close_auric     — close every AURIC-owned position on this account. Never any other trade.
 *   auto_renew_off / auto_renew_on — explicit opt-in with the price displayed by the client.
 *   set_risk { riskFraction }  — 0.25%–1.0%.
 */
export async function POST(req: Request) {
  const r = await ctx(req); if (!r.ok) return r.res; const c = r.c;
  let b: { accountId?: string; action?: string; riskFraction?: number; price?: number };
  try { b = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const acct = await ownedAccount(c, String(b.accountId ?? "")); if (!acct) return json({ error: "account_not_found" }, 404);
  const who = c.user.email ?? c.user.id.slice(0, 8);
  const { data: session } = await c.admin.from("auric_sessions").select("*").eq("account_id", acct.id).eq("status", "active").gt("expires_at", new Date().toISOString()).maybeSingle();
  const ev = (message: string, state?: string) => c.admin.from("auric_events").insert({ account_id: acct.id, session_id: session?.id ?? null, kind: "control", message, state: state ?? null });
  switch (b.action) {
    case "pause_entries": {
      if (!session) return json({ error: "no_active_session" }, 409);
      await c.admin.from("auric_sessions").update({ paused_entries: true, pause_reason: `paused by ${who}` }).eq("id", session.id);
      await ev("New entries paused by you. Open AURIC positions remain protected and managed.", "PAUSED");
      return json({ ok: true });
    }
    case "resume_entries": {
      if (!session) return json({ error: "no_active_session" }, 409);
      const { data: rs } = await c.admin.from("auric_risk_state").select("state").eq("account_id", acct.id).maybeSingle();
      const latched = (rs?.state as { latched?: { code: string; detail: string; needsReview: boolean } } | null)?.latched;
      if (latched && latched.needsReview && !c.isAdmin) return json({ error: "needs_review", detail: `${latched.code}: ${latched.detail}. Reactivation requires administrator review.` }, 409);
      if (latched && !latched.needsReview && latched.code !== "REJECTION_BURST") return json({ error: "latched", detail: `${latched.code}: ${latched.detail}. This limit resets at its documented boundary.` }, 409);
      if (latched && rs) await c.admin.from("auric_risk_state").update({ state: { ...(rs.state as object), latched: null, rejections: [] } }).eq("account_id", acct.id);
      await c.admin.from("auric_sessions").update({ paused_entries: false, pause_reason: null }).eq("id", session.id);
      await ev(`Entries resumed by ${who}${latched ? ` (cleared ${latched.code} after review)` : ""}. A fresh qualifying setup is required before any order.`, "OBSERVING");
      return json({ ok: true });
    }
    case "close_auric": {
      await c.admin.from("auric_commands").insert({ account_id: acct.id, command: "close_auric", requested_by: who });
      await ev("Close of all AURIC positions requested. Only AURIC-owned positions are affected; no other trade on the account is touched. Closure is confirmed only once the broker reports it.");
      return json({ ok: true, queued: true });
    }
    case "auto_renew_off": {
      if (session) await c.admin.from("auric_sessions").update({ auto_renew: false }).eq("id", session.id);
      await ev("Auto-renew disabled. The current session runs to its expiry; no further credits will be deducted.");
      return json({ ok: true });
    }
    case "auto_renew_on": {
      if (!session) return json({ error: "no_active_session" }, 409);
      const { data: p } = await c.admin.from("auric_settings").select("value").eq("key", "daily_price_credits").maybeSingle();
      const price = p?.value == null ? null : Number(p.value);
      if (price == null || Number(b.price) !== price) return json({ error: "price_confirmation_required", price }, 409);
      await c.admin.from("auric_sessions").update({ auto_renew: true, auto_renew_price: price }).eq("id", session.id);
      await ev(`Auto-renew enabled by ${who} at ${price} credits per session. Renewal stops automatically if the price changes or the balance is insufficient.`);
      return json({ ok: true });
    }
    case "set_risk": {
      const rf = Math.min(0.01, Math.max(0.0025, Number(b.riskFraction)));
      if (!Number.isFinite(rf)) return json({ error: "bad_risk" }, 400);
      await c.admin.from("auric_accounts").update({ risk_fraction: rf, updated_at: new Date().toISOString() }).eq("id", acct.id);
      await ev(`Risk per trade set to ${(rf * 100).toFixed(2)}% of equity (applies to new entries only).`);
      return json({ ok: true, riskFraction: rf });
    }
    default: return json({ error: "unknown_action" }, 400);
  }
}
