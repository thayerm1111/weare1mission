import { type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runGenfxScan } from "@/lib/genfx/scan";
import { genfxWatchPass, genfxSweep, acquireFxLock, extendFxLock, releaseFxLock } from "@/lib/genfx/watch";
import { resolveGenfxOpen } from "@/lib/genfx/resolve";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * GEN FX SCANNER — THE FALLBACK. The always-on worker (worker/genfx.ts) normally does all of this,
 * holding lock 6. This route is what keeps GEN FX running if the worker is down:
 *
 *   /api/cron/genfx-scan            every 5 minutes — the full scan of both pairs
 *   /api/cron/genfx-scan?watch=1    every minute    — the fast watch, looping inside its budget
 *
 * Both start by trying to take the lock. While the worker is alive they cannot, and return at once —
 * so there is never more than one process scanning, watching or placing for GEN FX.
 *
 * Same auth as the gold scanner: ?key=<GENX_CRON_KEY> or Authorization: Bearer <GENX_CRON_KEY>, and
 * the platform-wide CRON_SECRET is accepted too.
 */
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
function authorized(req: NextRequest): boolean {
  const key = process.env.GENX_CRON_KEY;
  const secret = process.env.CRON_SECRET;
  const qp = new URL(req.url).searchParams.get("key") || "";
  const hdr = req.headers.get("authorization") || "";
  if (key && (qp === key || hdr === `Bearer ${key}`)) return true;
  if (secret && (qp === secret || hdr === `Bearer ${secret}`)) return true;
  return false;
}

const WATCH_BUDGET_MS = 52_000;
const WATCH_INTERVAL_MS = 6_000;
const LOCK_TTL_MS = 30_000;

async function handle(req: NextRequest): Promise<Response> {
  if (!authorized(req)) return json({ error: "unauthorized" }, 401);
  const mdKey = process.env.TWELVEDATA_API_KEY;
  if (!mdKey) return json({ error: "no_market_data_key" }, 500);
  const admin = createAdminClient();
  if (!admin) return json({ error: "no_admin_client" }, 500);
  const watch = new URL(req.url).searchParams.get("watch") === "1";

  const holder = `cron-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;
  if (!(await acquireFxLock(admin, holder, LOCK_TTL_MS))) return json({ ok: true, skipped: "locked (worker active)" });
  const keepAlive = setInterval(() => { extendFxLock(admin, holder, LOCK_TTL_MS).catch(() => {}); }, 8_000);
  try {
    if (!watch) {
      const scan = await runGenfxScan(admin, mdKey);
      let graded = null;
      try { graded = await resolveGenfxOpen(mdKey, 60); } catch { /* grading is best-effort */ }
      return json({ ...scan, reads: graded });
    }
    const start = Date.now();
    const sent: string[] = [];
    let ticks = 0;
    const books = await genfxSweep(admin);
    while (Date.now() - start < WATCH_BUDGET_MS) {
      ticks += 1;
      const pass = await genfxWatchPass(admin, mdKey);
      sent.push(...pass.sent);
      if (!(await extendFxLock(admin, holder, LOCK_TTL_MS))) break;     // lost the lock: stop acting
      const remaining = WATCH_BUDGET_MS - (Date.now() - start);
      if (remaining <= 0) break;
      await new Promise((r) => setTimeout(r, Math.min(WATCH_INTERVAL_MS, remaining)));
    }
    return json({ ok: true, watch: true, ticks, sent, books, asOf: new Date().toISOString() });
  } finally {
    clearInterval(keepAlive);
    await releaseFxLock(admin, holder).catch(() => {});
  }
}

export async function GET(req: NextRequest) { return handle(req); }
export async function POST(req: NextRequest) { return handle(req); }
