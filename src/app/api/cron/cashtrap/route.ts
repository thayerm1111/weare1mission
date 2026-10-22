import { type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { runLoop } from "@/lib/cashtrap/service";
import { SupabaseStore } from "@/lib/cashtrap/supabaseStore";
import { TwelveDataMarketData } from "@/lib/cashtrap/data";
import { runNextReplay } from "@/lib/cashtrap/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * CASHTRAP RUNNER (Vercel cron).
 *   /api/cron/cashtrap          every minute — one runner at a time on Cashtrap's own lock. A run lasts
 *                               at least until 4 s past the next minute (so an expiry on a minute
 *                               boundary is settled on time), then hands over as soon as the next run
 *                               is waiting (at most until 56 s past the next minute): one runner is
 *                               always alive, whenever the crons actually start. It decides each closed
 *                               5-minute candle once the feed has finished it (90 s after the close),
 *                               publishes and enters confirmed signals, settles them at their expiry,
 *                               and keeps the market cards fresh.
 *   /api/cron/cashtrap?jobs=1   every 5 minutes — runs the next queued replay/backtest.
 * Auth: Authorization: Bearer <CRON_SECRET> (sent by Vercel cron) or <CASHTRAP_CRON_KEY>.
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
  if (!db || !key) return json({ error: "not_configured", missing: [!db && "SUPABASE_SERVICE_ROLE_KEY", !key && "TWELVEDATA_API_KEY"].filter(Boolean) }, 503);
  if (new URL(req.url).searchParams.get("jobs") === "1") {
    const r = await runNextReplay(db, key);
    return json({ ok: true, replay: r });
  }
  const store = new SupabaseStore(db);
  const start = Date.now();
  const nextMinute = (Math.floor(start / 60_000) + 1) * 60_000;
  const result = await runLoop(
    { store, data: new TwelveDataMarketData(key), now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), log: (m) => console.log(`[cashtrap] ${m}`) },
    { holder: `cron-${randomUUID()}`, minRunMs: Math.max(10_000, nextMinute + 4_000 - start), budgetMs: Math.max(30_000, nextMinute + 56_000 - start), lockWaitMs: 60_000 },
  );
  return json({ ok: true, ...result });
}
