import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { gateCredits, chargeCredit } from "@/lib/credits";
import { lookAtSetupAccess, forgetSetupAccess, OPEN_UNMETERED, CLOSED, READ_FEATURE } from "@/lib/setupAccess";
import { openSetups, oneAtATime, type PassAnswer } from "@/lib/setupPass";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "SEE THE PLAY" (owner 10-05: "Make them use credits to view").
 *
 *   GET   is my window open, until when, and what does opening it cost?
 *   POST  open it: one read's worth of credits, for 30 minutes of every live setup on the site.
 *
 * The charge is the ordinary one for a GENX read — the same gate, the same spend, the same ledger
 * line — because that is what is being bought: the read, without the story. Nothing here keeps a
 * record of its own: the spend is the pass (setupAccess.ts). What is charged when, and what is
 * answered, is setupPass.ts; this file hands it the member and the ledger.
 */
function json(o: unknown, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

async function who() {
  const supabase = createClient();
  if (!supabase) return { supabase: null, userId: null as string | null, dev: true };
  const { data: { user } } = await supabase.auth.getUser();
  return { supabase, userId: user?.id ?? null, dev: false };
}

export async function GET() {
  const w = await who();
  if (w.dev) return json(OPEN_UNMETERED);
  if (!w.userId) return json({ error: "unauthorized" }, 401);
  return json((await lookAtSetupAccess(createAdminClient(), w.userId, { fresh: true })).gate);
}

export async function POST() {
  const w = await who();
  if (w.dev || !w.supabase) return json({ ...OPEN_UNMETERED, charged: false });
  if (!w.userId) return json({ error: "unauthorized" }, 401);
  const userId = w.userId, supabase = w.supabase;
  const admin = createAdminClient();
  const busy = (): PassAnswer => ({ status: 409, body: { ...CLOSED, charged: false, error: "busy" } });
  const out = await oneAtATime(userId, busy, () => openSetups({
    // Never from memory: this look decides whether credits are taken.
    look: () => lookAtSetupAccess(admin, userId, { fresh: true }),
    gate: async () => {
      const g = await gateCredits(READ_FEATURE, supabase);
      return g.ok ? { ok: true } : g.reason === "unauthorized" ? { ok: false, reason: "unauthorized" } : { ok: false, reason: "insufficient", balance: g.balance.dailyLeft + g.balance.purchased };
    },
    charge: async () => { const b = await chargeCredit(READ_FEATURE, supabase); return b ? b.dailyLeft + b.purchased : null; },
    forget: () => forgetSetupAccess(userId),
    now: () => Date.now(),
  }));
  return json(out.body, out.status);
}
