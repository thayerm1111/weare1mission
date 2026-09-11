import { type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { manageMattyPips, workerIsManaging } from "@/lib/matty-pips/manage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * MATTY PIPS AUTO — manager cron (key-gated, every minute). The actual logic lives in
 * src/lib/matty-pips/manage.ts and now ALSO runs inside the always-on worker every few
 * seconds with favorable-excursion memory (owner 09-11: "Matty pips AI is not getting
 * managed. It didn't move to breakeven" — the old once-a-minute point-sample missed a
 * +100-pip wick). While the worker's heartbeat is fresh this cron stands down; if the
 * worker dies, this cron takes over within a minute — same failover pattern as FLOW.
 */
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
function authorized(req: NextRequest): boolean {
  const key = process.env.GENX_CRON_KEY, secret = process.env.CRON_SECRET;
  const qp = new URL(req.url).searchParams.get("key") || "";
  const hdr = req.headers.get("authorization") || "";
  if (key && (qp === key || hdr === `Bearer ${key}`)) return true;
  if (secret && (qp === secret || hdr === `Bearer ${secret}`)) return true;
  return false;
}

async function run(): Promise<Response> {
  const admin = createAdminClient();
  if (!admin) return json({ ok: false, error: "not_configured" }, 500);
  if (await workerIsManaging(admin)) return json({ ok: true, skipped: "worker_active" });
  return json(await manageMattyPips());
}

export async function GET(req: NextRequest) { if (!authorized(req)) return json({ error: "unauthorized" }, 401); return run(); }
export async function POST(req: NextRequest) { if (!authorized(req)) return json({ error: "unauthorized" }, 401); return run(); }
