import { createClient } from "@/lib/supabase/server";
import {
  RISK_DISCLOSURE, DISCLOSURE_VERSION, consentState, sign, revoke,
} from "../../../../../command-center/engines/consent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * THE RISK DISCLOSURE — served, signed and withdrawn.
 *
 * The text is served from here rather than baked into the interface so that what is displayed and
 * what is hashed into the signature are the same string. A disclosure the client holds its own copy
 * of is a disclosure that can drift from the one the record claims was agreed to.
 */
function json(o: unknown, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export async function GET() {
  const supabase = createClient();
  if (!supabase) return json({ error: "not_configured" }, 503);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  return json({
    ok: true,
    version: DISCLOSURE_VERSION,
    disclosure: RISK_DISCLOSURE,
    consent: await consentState(user.id),
  });
}

export async function POST(req: Request) {
  const supabase = createClient();
  if (!supabase) return json({ error: "not_configured" }, 503);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  let body: { action?: string; signedName?: string; acknowledged?: boolean; reason?: string };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }

  if (body.action === "revoke") {
    /*
     * Withdrawing is immediate and needs no approval — a member who wants out of an automated system
     * should never have to argue with it. It stops NEW activity; open positions remain theirs to
     * close, and the interface says so rather than implying everything has been unwound.
     */
    await revoke(user.id, String(body.reason ?? "withdrawn by the member"));
    return json({ ok: true, consent: await consentState(user.id) });
  }

  const r = await sign(user.id, {
    signedName: String(body.signedName ?? ""),
    acknowledged: body.acknowledged === true,
    // Recorded because a signature with no circumstances around it proves very little later.
    ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: req.headers.get("user-agent"),
  });
  if (!r.ok) return json({ ok: false, reason: r.reason }, 400);
  return json({ ok: true, consent: await consentState(user.id) });
}
