import { createClient } from "@/lib/supabase/server";
import { readBalance } from "@/lib/credits";
import { DAILY_FREE, CREDIT_COST, PACKS } from "@/lib/creditConfig";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Current member's credit balance + the pricing config the UI needs. */
export async function GET() {
  const supabase = createClient();
  if (supabase) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
  }
  const balance = await readBalance();
  return json({
    balance: balance || { dailyLeft: DAILY_FREE, purchased: 0, dailyAllowance: DAILY_FREE },
    costs: CREDIT_COST,
    packs: PACKS,
  }, 200);
}

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
