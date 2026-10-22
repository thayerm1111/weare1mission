import { type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runNextReplay } from "@/lib/cashtrap/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * CASHTRAP REPLAY JOBS (Vercel cron, every 5 minutes): runs the next queued replay/backtest run.
 * Its own path (not a query string on the runner's path) so the two crons can never be mistaken for
 * one another. Auth: Authorization: Bearer <CRON_SECRET> (Vercel cron) or <CASHTRAP_CRON_KEY>.
 * Touches only Cashtrap's tables; places no orders.
 */
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
function authorized(req: NextRequest): boolean {
  const hdr = req.headers.get("authorization") || "";
  return [process.env.CRON_SECRET, process.env.CASHTRAP_CRON_KEY].some((k) => !!k && hdr === `Bearer ${k}`);
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return json({ error: "unauthorized" }, 401);
  const db = createAdminClient();
  const key = process.env.TWELVEDATA_API_KEY;
  if (!db || !key) return json({ error: "not_configured" }, 503);
  const r = await runNextReplay(db, key);
  if (r) console.log(`[cashtrap-jobs] replay ${r.id}: ${r.status}`);
  return json({ ok: true, replay: r });
}
