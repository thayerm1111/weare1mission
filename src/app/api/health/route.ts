import { type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { computeHealth } from "@/lib/flow/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * PUBLIC HEALTH ENDPOINT — for external uptime monitors (e.g. UptimeRobot) and
 * quick eyeballing. Exposes ONLY non-sensitive operational status: which
 * background components are alive, how stale each is, and a few live-trade safety
 * counts. NO balances, member data, prices, or keys.
 *
 * HTTP status is the signal an external monitor watches:
 *   200  OK or DEGRADED (system is up; DEGRADED is logged in the body)
 *   503  DOWN — something is risking live trades or the manager is down while
 *        positions are open. A monitor set to alert on non-200 will page you.
 */
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" },
  });
}

async function handle(): Promise<Response> {
  const admin = createAdminClient();
  if (!admin) return json({ status: "DOWN", error: "no_admin_client" }, 503);
  try {
    const report = await computeHealth(admin);
    const httpStatus = report.status === "DOWN" ? 503 : 200;
    return json(report, httpStatus);
  } catch (e) {
    return json({ status: "DOWN", error: "health_check_failed", detail: String(e).slice(0, 160) }, 503);
  }
}

export async function GET(_req: NextRequest) { return handle(); }
export async function POST(_req: NextRequest) { return handle(); }
