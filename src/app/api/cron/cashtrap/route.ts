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
 *   Replay/backtest runs: after its live work (lock already handed over), a run that has time left picks
 *   up the next queued replay (also reachable at /api/cron/cashtrap-jobs). The replay yields to the event
 *   loop as it goes, so it cannot hold up a live runner sharing the instance.
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
  // An old "?jobs=1" call (replay jobs now have their own route) must not start a second runner.
  if (new URL(req.url).searchParams.has("jobs")) return json({ ok: true, moved: "/api/cron/cashtrap-jobs" });
  const store = new SupabaseStore(db);
  const start = Date.now();
  const nextMinute = (Math.floor(start / 60_000) + 1) * 60_000;
  const result = await runLoop(
    { store, data: new TwelveDataMarketData(key), now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), log: (m) => console.log(`[cashtrap] ${m}`) },
    { holder: `cron-${randomUUID()}`, minRunMs: Math.max(10_000, nextMinute + 4_000 - start), budgetMs: Math.max(30_000, nextMinute + 56_000 - start), lockWaitMs: 60_000 },
  );
  console.log(`[cashtrap] run: ${result.ran ? `${result.passes} pass(es), ${result.decided} decided, ${result.published} published, ${result.settled} settled${result.handedOver ? ", handed over" : ""}` : result.reason}${result.notes.length ? ` · ${result.notes.slice(0, 4).join(" | ")}` : ""}`);
  // Time left (the function may run 300 s; a replay takes about a minute): take the next queued replay.
  let replay: Awaited<ReturnType<typeof runNextReplay>> | { id: string; status: string } = null;
  if (result.ran && Date.now() - start < 150_000) {
    replay = await runNextReplay(db, key).catch((e) => ({ id: "-", status: `error: ${e instanceof Error ? e.message : String(e)}` }));
    if (replay) console.log(`[cashtrap] replay ${replay.id}: ${replay.status}`);
  }
  return json({ ok: true, ...result, replay });
}
