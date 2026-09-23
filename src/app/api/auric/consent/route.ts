import { CONSENT_TEXT, CONSENT_VERSION, ctx, json, ownedAccount } from "../_lib";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const r = await ctx(req); if (!r.ok) return r.res;
  return json({ ok: true, version: CONSENT_VERSION, text: CONSENT_TEXT });
}

/** POST { accountId, acknowledged:true, signedName, riskFraction?, allowShared? } | { accountId, action:"revoke" } */
export async function POST(req: Request) {
  const r = await ctx(req); if (!r.ok) return r.res; const c = r.c;
  let b: { accountId?: string; acknowledged?: boolean; signedName?: string; riskFraction?: number; allowShared?: boolean; action?: string };
  try { b = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const acct = await ownedAccount(c, String(b.accountId ?? "")); if (!acct) return json({ error: "account_not_found" }, 404);
  const now = new Date().toISOString();
  if (b.action === "revoke") {
    await c.admin.from("auric_accounts").update({ consent_at: null, updated_at: now }).eq("id", acct.id);
    await c.admin.from("auric_sessions").update({ paused_entries: true, pause_reason: "consent revoked" }).eq("account_id", acct.id).eq("status", "active");
    await c.admin.from("auric_events").insert({ account_id: acct.id, kind: "consent", message: "Consent revoked. New entries stopped; open AURIC positions stay protected and managed.", state: "PAUSED" });
    return json({ ok: true });
  }
  if (b.acknowledged !== true || !String(b.signedName ?? "").trim()) return json({ error: "acknowledgement_required" }, 400);
  const rf = b.riskFraction != null ? Math.min(0.01, Math.max(0.0025, Number(b.riskFraction))) : Number(acct.risk_fraction);
  const terms = { version: CONSENT_VERSION, textSha256: await sha(CONSENT_TEXT), signedName: String(b.signedName).trim(), ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null, userAgent: req.headers.get("user-agent"), riskFraction: rf, allowShared: b.allowShared === true, at: now };
  await c.admin.from("auric_accounts").update({ consent_at: now, consent_version: CONSENT_VERSION, consent_terms: terms, risk_fraction: rf, allow_shared_account: b.allowShared === true, updated_at: now }).eq("id", acct.id);
  await c.admin.from("auric_events").insert({ account_id: acct.id, kind: "consent", message: `Consent recorded (${CONSENT_VERSION}); risk ${(rf * 100).toFixed(2)}% per trade${b.allowShared ? "; shared account explicitly allowed" : ""}.`, state: "PAUSED" });
  return json({ ok: true, riskFraction: rf });
}

async function sha(s: string) { const { createHash } = await import("node:crypto"); return createHash("sha256").update(s).digest("hex"); }
