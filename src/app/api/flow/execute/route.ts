import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { placeMarketOrder, probeBroker } from "@/lib/flow/executor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * FLOW order placement — MEMBER-INITIATED only. Requires the member's own
 * authenticated session; a member can only ever act on their own connected
 * account. The "test" source is a one-tap validation that places the smallest
 * possible market order (0.01 lot, hard-capped here) so the member can prove the
 * broker order path fills correctly before enabling anything automatic.
 */
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export async function POST(req: NextRequest) {
  const supabase = createClient();
  if (!supabase) return json({ error: "unauthorized" }, 401);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  let body: { symbol?: unknown; side?: unknown; source?: unknown } = {};
  try { body = await req.json(); } catch { /* */ }
  const symbol = typeof body.symbol === "string" ? body.symbol : "XAUUSD";
  const side: "buy" | "sell" = body.side === "sell" ? "sell" : "buy";
  const source = body.source === "test" ? "test" : body.source === "probe" ? "probe" : "manual";

  if (source === "probe") {
    // Read-only diagnostics — places no order.
    const probe = await probeBroker(user.id, symbol);
    return json({ ok: probe.ok === true, probe }, 200);
  }

  if (source === "test") {
    // Hard-capped tiny order — this path is only for proving the broker pipe.
    const out = await placeMarketOrder({ userId: user.id, symbol, side, qty: 0.01, source: "test" });
    return json({ ok: out.status === "placed", outcome: out }, 200);
  }

  return json({ error: "not_enabled", detail: "Automatic order placement isn't switched on yet." }, 200);
}
