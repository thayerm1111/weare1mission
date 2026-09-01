import { type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { manageOpenPositions, acquireManageLock, extendManageLock, releaseManageLock } from "@/lib/flow/flowManage";
import { beat } from "@/lib/flow/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Long-lived so one invocation can loop for most of the minute; the next minute's cron
// restarts it. Overlap is safe — only the lock-holder manages.
export const maxDuration = 120;

/**
 * CONTINUOUS TRADE-MANAGER (key-gated cron).
 *
 * Runs the break-even → partial → trail check every few seconds for the whole invocation,
 * so a stop moves to break-even (and partials/trails fire) within seconds of the trigger
 * being hit — not up to a minute later. A single DB lock guarantees exactly one run manages
 * at a time (this loop is the primary; the 1-min flow-exec tick is a fallback that only
 * manages when this loop isn't holding the lock), so a partial can never double-fire.
 *
 * Scheduled every minute by Vercel cron; each run loops ~112s then releases the lock so the
 * next minute's run takes over cleanly. A crashed run's lock simply expires (~20s TTL).
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

const BUDGET_MS = 112_000;  // loop for ~112s of the 120s function budget
const INTERVAL_MS = 2_500;  // re-check every ~2.5s — with the parallel account prefetch a
                            // pass is short, so BE/partials land seconds after the trigger

async function run(req: NextRequest): Promise<Response> {
  if (!keyAuthorized(req)) return json({ error: "unauthorized" }, 401);
  const admin = createAdminClient();
  if (!admin) return json({ error: "no_admin_client" }, 500);

  const holder = (globalThis.crypto?.randomUUID?.() ?? `h-${Date.now()}-${Math.round(Number(process.hrtime.bigint() % 1000000n))}`);
  const got = await acquireManageLock(admin, holder);
  if (!got) return json({ ok: true, scope: "fast-manage", skipped: "locked" }, 200);

  // Beat IMMEDIATELY on startup, before the first tick. A tick can run long (several
  // positions × serialized broker calls with retries), and a deploy swap kills the
  // previous invocation mid-loop — without this beat the heartbeat gap spans cron
  // latency PLUS the whole first tick, which is what tripped the 120s "manager
  // stalled" watchdog alarms even when nothing was actually wrong.
  await beat(admin, "manager", { ticks: 0, starting: true });

  const start = Date.now();
  let ticks = 0;
  let lastManaged = 0;
  try {
    while (Date.now() - start < BUDGET_MS) {
      const t0 = Date.now();
      try { const r = await manageOpenPositions(); lastManaged = r?.managed ?? lastManaged; }
      catch { /* one bad tick never stops the loop */ }
      ticks += 1;
      await beat(admin, "manager", { ticks, lastManaged, passMs: Date.now() - t0 }); // liveness + per-pass timing for the watchdog
      await extendManageLock(admin, holder);
      const remaining = BUDGET_MS - (Date.now() - start);
      if (remaining <= 500) break;
      await new Promise((r) => setTimeout(r, Math.min(INTERVAL_MS, remaining)));
    }
  } finally {
    await releaseManageLock(admin, holder);
  }
  return json({ ok: true, scope: "fast-manage", ticks, intervalMs: INTERVAL_MS, lastManaged, asOf: new Date().toISOString() }, 200);
}

export async function GET(req: NextRequest) { return run(req); }
export async function POST(req: NextRequest) { return run(req); }
