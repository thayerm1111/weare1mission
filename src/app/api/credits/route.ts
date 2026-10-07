import { createClient } from "@/lib/supabase/server";
import { readBalance } from "@/lib/credits";
import { ensurePromoRichCredits } from "@/lib/promo";
import { DAILY_FREE, CREDIT_COST, PACKS } from "@/lib/creditConfig";
import { hasFlowPass } from "@/lib/subscription";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Current member's credit balance + the pricing config the UI needs. */
export async function GET() {
  const supabase = createClient();
  let pass = false;
  if (supabase) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
    // Promo "rich" one-time 100-credit grant — self-healing, before readBalance
    // so a first-time 'rich' member sees the credits on this same load. No-op
    // for non-'rich' members and for anyone already granted.
    await ensurePromoRichCredits(user.id);
    // An active FLOW Pass: the page does not stop this member for a low balance (lib/lowBalance.ts).
    // Not confirmed is "no" — the pop-up then behaves as it does for everyone else.
    pass = await hasFlowPass(user.id);
  }
  const balance = await readBalance();
  return json({
    balance: balance || { dailyLeft: DAILY_FREE, purchased: 0, dailyAllowance: DAILY_FREE },
    costs: CREDIT_COST,
    packs: PACKS,
    pass,
  }, 200);
}

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
