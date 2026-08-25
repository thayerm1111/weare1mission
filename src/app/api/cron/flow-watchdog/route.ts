import { type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { computeHealth, stalledComponents, logIncident, type ComponentName } from "@/lib/flow/health";
import { sendTelegram, esc } from "@/lib/telegram";

// How long to wait between outage pings so a sustained DOWN state alerts ONCE, not every minute.
const ALERT_COOLDOWN_MIN = 15;

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

    // SERVER-SIDE OUTAGE ALERT. The app notifies the owner itself — no external Claude routine
    // (which can't WebFetch unattended) needed. Cooldown via the incident log so a sustained
    // outage pings once every ALERT_COOLDOWN_MIN. Prefers a private admin chat if configured,
    // else the main channel. Fails CLOSED (skips sending) on any read error so it can't spam.
    let alertedRecently = true;
    try {
      const since = new Date(Date.now() - ALERT_COOLDOWN_MIN * 60_000).toISOString();
      const { data: recent } = await admin.from("flow_incidents")
        .select("id").eq("kind", "down_alert").gte("created_at", since).limit(1);
      alertedRecently = !!(recent && recent.length);
    } catch { alertedRecently = true; }

    if (!alertedRecently) {
      const adminChat = process.env.TELEGRAM_ADMIN_CHAT_ID;
      const lines = [
        "🚨 <b>Auto-trading system DOWN</b>",
        ...report.reasons.slice(0, 6).map((r) => "• " + esc(r)),
        healed.length ? `Auto-recovery restarted: ${esc(healed.join(", "))}.` : "No stalled component to auto-restart.",
        "The watchdog will keep trying to self-heal; check the health page if this repeats.",
      ];
      try {
        await sendTelegram(lines.join("\n"), adminChat ? { chatId: adminChat } : undefined);
        await logIncident(admin, "system", "down_alert", { reasons: report.reasons });
      } catch { /* alerting is best-effort */ }
    }
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
