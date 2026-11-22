import { authedContext } from "@/lib/supabase/bearer";
import { readActiveTrades, ActiveTradeError } from "@/lib/floor/activeTrades";
import { validScope } from "@/lib/floor/activeTradeModel";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", "cache-control": "private, no-store" } });
export async function GET(req: Request) {
  const { user, configured } = await authedContext(req);
  if (!configured) return json({ ok: false, message: "Trading is unavailable right now." }, 503);
  if (!user) return json({ ok: false, message: "Sign in to see your active trades." }, 401);
  const scope = { accountId: req.headers.get("x-floor-account"), environment: req.headers.get("x-floor-env") };
  if (!validScope(scope)) return json({ ok: false, message: "Select an account and environment first." }, 400);
  try { return json(await readActiveTrades(user.id, scope)); }
  catch (error) { return json({ ok: false, message: error instanceof ActiveTradeError ? error.message : "Your active trades could not be verified." }, error instanceof ActiveTradeError ? error.status : 503); }
}
