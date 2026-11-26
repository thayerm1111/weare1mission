import { authedContext } from "@/lib/supabase/bearer";
import { readFlowPositionChart, ActiveTradeError } from "@/lib/floor/activeTrades";
import { validScope } from "@/lib/floor/activeTradeModel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store" } });

export async function GET(req: Request) {
  const { user, configured } = await authedContext(req);
  if (!configured) return json({ ok: false, message: "Position data is unavailable." }, 503);
  if (!user) return json({ ok: false, message: "Sign in to see your position." }, 401);
  const scope = { accountId: req.headers.get("x-floor-account"), environment: req.headers.get("x-floor-env") };
  const positionId = req.headers.get("x-flow-position");
  if (!validScope(scope) || !positionId || !/^[\w.-]{1,100}$/.test(positionId)) return json({ ok: false, message: "Select an account and its open position." }, 400);
  try {
    return json(await readFlowPositionChart(user.id, scope, positionId));
  } catch (error) {
    if (error instanceof ActiveTradeError) return json({ ok: false, message: error.message }, error.status);
    return json({ ok: false, message: "Your broker’s position could not be read." }, 503);
  }
}
