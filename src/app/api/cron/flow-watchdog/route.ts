import { type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { computeHealth, stalledComponents, logIncident, type ComponentName } from "@/lib/flow/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * SELF-HEALING WATCHDOG (key-gated cron, every minute on Vercel + GitHub Actions).
 *
 * Reads the health report; if any component's heartbeat has gone stale, it
 * re-kicks that component's endpoint (safe — the manager is lock-guarded, scans
 * are idempotent) and records an incident. This is what keeps the system running
 * unattended: a stalled piece is restarted within ~a minute, before the slower
 * phone-alert cadence would even notice. Returns what it found and did.
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

function cronKey(): string | null {
  return process.env.FLOW_CRON_KEY || process.env.GENX_CRON_KEY || process.env.CRON_SECRET || null;
}

// Each component maps to the endpoint that restarts it.
const HEAL_PATH: Record<ComponentName, string> = {
  manager: "/api/cron/flow-manage",
  exec: "/api/cron/flow-exec",
  genx: "/api/cron/genx-scan",
};

// Fire the restart without blocking on its (possibly long-running) work. We just
// need the target invocation to START; a short timeout is enough for that.
async function kick(origin: string, path: string, key: string): Promise<boolean> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 3500);
  try {
    await fetch(`${origin}${path}?key=${encodeURIComponent(key)}`, { method: "POST", signal: ctrl.signal, cache: "no-store" });
    return true;
  } catch {
    return true; // abort/timeout is expected — the target keeps running server-side
  } finally {
    clearTimeout(t);
  }
}

async function run(req: NextRequest): Promise<Response> {
  if (!keyAuthorized(req)) return json({ error: "unauthorized" }, 401);
  const admin = createAdminClient();
  if (!admin) return json({ error: "no_admin_client" }, 500);

  const report = await computeHealth(admin);
  const stalled = stalledComponents(report);
  const origin = new URL(req.url).origin;
  const key = cronKey();

  const healed: string[] = [];
  if (stalled.length && key) {
    for (const c of stalled) {
      await kick(origin, HEAL_PATH[c], key);
      healed.push(c);
      await logIncident(admin, c, "self_heal_kick", { ageSec: report.components.find((x) => x.component === c)?.ageSec ?? null });
    }
  }

  // Record any DOWN state even if it isn't a stale-component case (e.g. a BE stop
  // parked at a loss), so the phone-alert task and the history have a trail.
  if (report.status === "DOWN") {
    await logIncident(admin, "system", "down", { reasons: report.reasons, checks: report.checks });
  }

  return json({
    ok: true,
    status: report.status,
    healed,
    stalled,
    reasons: report.reasons,
    checks: report.checks,
    asOf: report.generatedAt,
  }, 200);
}

export async function GET(req: NextRequest) { return run(req); }
export async function POST(req: NextRequest) { return run(req); }
