import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runAutoExecAll, runAutoExecForUser, type AutoSettings } from "@/lib/flow/autoExec";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * FLOW AUTO-EXECUTOR endpoint.
 *
 *  • Scheduled (GitHub Actions) with a shared key → runs for EVERY armed member:
 *      POST /api/cron/flow-exec?key=<FLOW_CRON_KEY | GENX_CRON_KEY | CRON_SECRET>
 *  • Member-authenticated (no key) → runs once for THAT member only, so a member
 *    (or support) can prove their own auto-exec path on demand.
 *
 * Placing orders is gated by flow_auto_settings.enabled — a member who hasn't
 * armed FLOW is a no-op. All real order placement flows through executor.ts.
 */
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });

function keyAuthorized(req: NextRequest): boolean {
  const url = new URL(req.url);
  const qp = url.searchParams.get("key") || "";
  const hdr = req.headers.get("authorization") || "";
  for (const k of [process.env.FLOW_CRON_KEY, process.env.GENX_CRON_KEY, process.env.CRON_SECRET]) {
    if (k && (qp === k || hdr === `Bearer ${k}`)) return true;
  }
  return false;
}

async function run(req: NextRequest): Promise<Response> {
  const mdKey = process.env.TWELVEDATA_API_KEY;
  if (!mdKey) return json({ error: "no_market_data_key" }, 500);

  // 1) Cron / key path → every armed member.
  if (keyAuthorized(req)) {
    const out = await runAutoExecAll(mdKey);
    return json({ ok: true, scope: "all", asOf: new Date().toISOString(), ...out }, 200);
  }

  // 2) Member path → just this member (must be signed in AND armed).
  const supabase = createClient();
  const { data: { user } } = supabase ? await supabase.auth.getUser() : { data: { user: null } };
  if (!user) return json({ error: "unauthorized" }, 401);

  const admin = createAdminClient();
  if (!admin) return json({ error: "no_admin_client" }, 500);
  const { data: row } = await admin.from("flow_auto_settings").select("*").eq("user_id", user.id).maybeSingle();
  if (!row) return json({ ok: true, scope: "self", armed: false, detail: "Auto-execute isn't set up for this account." }, 200);
  const settings = { ...(row as AutoSettings), email: user.email };
  if (!settings.enabled) return json({ ok: true, scope: "self", armed: false, detail: "Auto-execute is switched off." }, 200);

  const res = await runAutoExecForUser(settings, mdKey);
  return json({ ok: true, scope: "self", armed: true, asOf: new Date().toISOString(), ...res }, 200);
}

export async function GET(req: NextRequest) { return run(req); }
export async function POST(req: NextRequest) { return run(req); }
