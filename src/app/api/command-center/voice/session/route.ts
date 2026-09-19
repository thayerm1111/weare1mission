import { createClient } from "@/lib/supabase/server";
import { selectedAccount } from "../../../../../../command-center/engines/broker";
import { callbackUrl } from "../../../../../../command-center/engines/voice";
import {
  availability, budgetFor, closeSession, ensureAgent, openSession, signedUrl, touch,
  MONTHLY_MINUTE_BUDGET,
} from "../../../../../../command-center/engines/voice";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * OPENING A VOICE SESSION.
 *
 * Admin only, today, and the gate is here rather than in the interface because a gate in a component is
 * a suggestion. Speech is billed per minute; until there is a way for a member to pay for their own
 * minutes, this is the owner's line and nobody else's.
 *
 * The provider's API key never leaves this process. What the browser gets back is a signed URL with a
 * short-lived token in it, plus a separate callback token that lets the provider's servers reach our
 * reasoning endpoint and be told which member they are talking about.
 */
function json(o: unknown, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

/** The one place that decides who may speak. */
async function admin(): Promise<{ ok: true; userId: string } | { ok: false; res: Response }> {
  const supabase = createClient();
  if (!supabase) return { ok: false, res: json({ error: "not_configured" }, 503) };
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, res: json({ error: "unauthorized" }, 401) };
  const { data } = await supabase.from("profiles").select("role").eq("id", user.id).maybeSingle();
  if ((data as { role?: string } | null)?.role !== "admin") {
    // Deliberately not a 403 with an explanation of what exists. A member who cannot use voice does not
    // need to learn that voice exists and costs money.
    return { ok: false, res: json({ ok: false, enabled: false, reason: "Voice sessions are not enabled on this account." }, 200) };
  }
  return { ok: true, userId: user.id };
}

export async function GET() {
  const gate = await admin();
  if (!gate.ok) return gate.res;

  const avail = availability();
  const budget = await budgetFor(gate.userId);
  return json({
    ok: true,
    enabled: true,
    configured: avail.ok,
    reason: avail.ok ? null : avail.reason,
    missing: avail.ok ? [] : avail.missing,
    budget,
    monthlyMinutes: MONTHLY_MINUTE_BUDGET,
    // Reading the state must never have the side effect of creating an agent — that happens when
    // somebody actually asks for a line, not when a panel renders.
    callback: avail.ok ? callbackUrl() : null,
  });
}

export async function POST(req: Request) {
  const gate = await admin();
  if (!gate.ok) return gate.res;

  let body: { action?: string; turns?: number };
  try { body = await req.json(); } catch { body = {}; }
  const action = String(body.action ?? "start");

  if (action === "end") {
    await closeSession(gate.userId, "ended by user");
    return json({ ok: true, ended: true });
  }

  if (action === "heartbeat") {
    // The browser says it is still listening; the meter agrees or the worker reaps it later.
    const c = createClient();
    const { data } = c
      ? await c.from("cc_voice_sessions").select("id").eq("user_id", gate.userId).is("ended_at", null).maybeSingle()
      : { data: null };
    const id = (data as { id?: string } | null)?.id;
    if (id) await touch(id, Number(body.turns) || 0);
    return json({ ok: true });
  }

  const avail = availability();
  if (!avail.ok) return json({ ok: false, configured: false, reason: avail.reason, missing: avail.missing }, 200);

  // The meter is checked BEFORE the line is opened, not after it has run.
  const budget = await budgetFor(gate.userId);
  if (budget.exhausted) {
    return json({
      ok: false,
      configured: true,
      reason: `This month's voice budget is used up — ${budget.usedMinutes} of ${budget.budgetMinutes} minutes. The text console still works.`,
      budget,
    }, 200);
  }

  /*
   * The agent is created on first use rather than configured by hand. Everything the provider needs to
   * know — where to call us, what secret to present, what it is and is not — is derivable from what the
   * server already has, so making a person assemble it in a dashboard would be busywork.
   */
  const agent = await ensureAgent();
  if (!agent.ok) return json({ ok: false, configured: true, reason: agent.reason }, 200);

  const account = await selectedAccount(gate.userId);
  const session = await openSession(gate.userId, account?.id ?? null, agent.agentId);
  if (!session) return json({ ok: false, reason: "Could not open a voice session." }, 200);

  const signed = await signedUrl(agent.agentId);
  if (!signed.ok) {
    await closeSession(gate.userId, "provider refused");
    return json({ ok: false, configured: true, reason: signed.reason }, 200);
  }

  return json({
    ok: true,
    configured: true,
    url: signed.url,
    /*
     * The callback token travels to the provider as a conversation variable and comes back to our
     * reasoning endpoint on every turn. It is how a request arriving from their infrastructure — with no
     * cookie on it — is known to be about this member's account.
     */
    voiceToken: session.token,
    sessionId: session.id,
    expiresAt: session.expiresAt,
    budget,
  });
}
