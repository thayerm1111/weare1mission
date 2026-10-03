import { type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runGenfxScan } from "@/lib/genfx/scan";
import { genfxWatchPass, genfxSweep, acquireFxLock, extendFxLock, releaseFxLock } from "@/lib/genfx/watch";
import { resolveGenfxOpen } from "@/lib/genfx/resolve";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * GEN FX — THE FALLBACK. The always-on worker (worker/genfx.ts) normally does all of this, holding
 * lock 6. This route is what keeps GEN FX running if the worker is down:
 *
 *   /api/cron/genfx-scan?watch=1    every minute    — the books, the full scan when one is due, then
 *                                                     the fast watch, looping inside its budget; the
 *                                                     books again after anything that placed an order
 *   /api/cron/genfx-scan            every 5 minutes — the full scan on its own
 *
 * Both start by trying to take the lock. While the worker is alive they cannot, and return at once —
 * so there is never more than one process scanning, watching or placing for GEN FX.
 *
 * THE MINUTE RUN DOES THE SCAN TOO, and that is deliberate. Both crons fire together on every fifth
 * minute and only one can hold the lock: left to chance, either the scan or the watch would lose that
 * minute, every time. So the minute run scans whenever the five-minute candle has not been scanned
 * yet — exactly what the worker's loop does — and if the scan-only run got the lock first, the minute
 * run waits its turn instead of giving the minute up.
 *
 * THE BOOKS NEED NO MARKET DATA. An order that is out there is followed to its end whether or not this
 * deployment can read prices, so the minute run does the books before it asks for the market-data key.
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
/** Between passes. A touch needs two looks no more than eight seconds apart (watch.TOUCH_STALE_MS), and a pass itself can take a few seconds: at six seconds between passes the second look often came too late to count. */
const WATCH_INTERVAL_MS = 3_000;
const LOCK_TTL_MS = 30_000;
const SCAN_MS = 5 * 60_000;
/** Which five-minute candle a moment belongs to. A scan is DUE as soon as the clock is in a candle the last scan was not… */
const scanSlot = (ms: number) => Math.floor(ms / SCAN_MS);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/**
 * …and it RUNS eight seconds into that candle, so the feed has the one that just closed (the worker's
 * own offset). Deciding "due" eight seconds late instead — as this used to — made both crons, which
 * fire in the first second of the minute, call the candle "already scanned" and leave it a full minute.
 */
const untilFeedHasIt = async (): Promise<void> => { const wait = scanSlot(Date.now()) * SCAN_MS + 8_050 - Date.now(); if (wait > 0) await sleep(wait); };     // +50ms: a timer can fire a millisecond early

type Admin = NonNullable<ReturnType<typeof createAdminClient>>;

/** Who holds the GEN FX lock right now: "worker", "cron", or nobody. */
async function holderKind(admin: Admin): Promise<"worker" | "cron" | "none"> {
  try {
    const { data } = await admin.from("flow_manage_lock").select("holder, expires_at").eq("id", 6).maybeSingle();
    const row = data as { holder?: string | null; expires_at?: string | null } | null;
    if (!row?.holder || !row.expires_at || Date.parse(row.expires_at) <= Date.now()) return "none";
    return String(row.holder).startsWith("cron-") ? "cron" : "worker";
  } catch { return "worker"; }     // cannot tell → behave as if the worker has it, and step back
}

/** Has the five-minute candle that just closed been scanned? Read from the heartbeat the scan writes. */
async function scanDue(admin: Admin, nowMs: number): Promise<boolean> {
  try {
    const { data, error } = await admin.from("flow_heartbeat").select("detail").eq("component", "genfx").maybeSingle();
    if (error) return true;
    const at = Date.parse(String((data as { detail?: { at?: string } } | null)?.detail?.at ?? ""));
    return !Number.isFinite(at) || scanSlot(at) !== scanSlot(nowMs);
  } catch { return true; }
}

async function handle(req: NextRequest): Promise<Response> {
  if (!authorized(req)) return json({ error: "unauthorized" }, 401);
  const mdKey = process.env.TWELVEDATA_API_KEY;
  const admin = createAdminClient();
  if (!admin) return json({ error: "no_admin_client" }, 500);
  const watch = new URL(req.url).searchParams.get("watch") === "1";
  if (!mdKey && !watch) return json({ error: "no_market_data_key" }, 500);
  const start = Date.now();

  const holder = `cron-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;
  let got = await acquireFxLock(admin, holder, LOCK_TTL_MS);
  // The minute run waits out the scan-only run (seconds); it never waits on the worker.
  for (let i = 0; !got && watch && i < 6 && (await holderKind(admin)) === "cron"; i++) { await sleep(5_000); got = await acquireFxLock(admin, holder, LOCK_TTL_MS); }
  if (!got) return json({ ok: true, skipped: "locked (worker active)" });
  // The lock is renewed while this run works — until its own budget is spent, never beyond it.
  const keepAlive = setInterval(() => { if (Date.now() - start < 120_000) extendFxLock(admin, holder, LOCK_TTL_MS).catch(() => {}); }, 8_000);
  try {
    if (!watch) {
      if (!mdKey) return json({ error: "no_market_data_key" }, 500);
      if (!(await scanDue(admin, Date.now()))) return json({ ok: true, skipped: "already scanned this candle" });
      await untilFeedHasIt();
      const scan = await runGenfxScan(admin, mdKey);
      let graded = null;
      if (!scan.feedDown) { try { graded = await resolveGenfxOpen(mdKey); } catch { /* grading is best-effort */ } }
      return json({ ...scan, reads: graded });
    }
    const sent: string[] = [];
    let ticks = 0, scanned = false;
    let books = (await genfxSweep(admin)).settle;
    // No market-data key on this deployment: the books are all this run can do, and they are done.
    if (!mdKey) return json({ ok: true, watch: true, skipped: "no_market_data_key (books only)", books, asOf: new Date().toISOString() });
    if (await scanDue(admin, Date.now())) {
      scanned = true;
      await untilFeedHasIt();
      const scan = await runGenfxScan(admin, mdKey);
      // A call the scan entered has orders out: the books pass is what hands each fill to the trade manager.
      if (Object.values(scan.decisions).some((d) => /(^|\+)enter/.test(String(d.result ?? "")))) books = (await genfxSweep(admin)).settle;
      // Page reads are graded from the same candle feed: not asked again if the scan found it not answering.
      if (!scan.feedDown) { try { await resolveGenfxOpen(mdKey); } catch { /* grading is best-effort */ } }
    }
    // A books pass that left something waiting on the broker is repeated ten seconds on — the first one of this run included.
    let booksDueAt = books.waiting || books.cancelled ? Date.now() + 10_000 : 0;
    while (Date.now() - start < WATCH_BUDGET_MS) {
      ticks += 1;
      const pass = await genfxWatchPass(admin, mdKey);
      sent.push(...pass.sent);
      if (pass.sent.some((x) => /ENTER/.test(x)) || (booksDueAt && Date.now() >= booksDueAt)) {
        books = (await genfxSweep(admin)).settle;
        booksDueAt = books.waiting || books.cancelled ? Date.now() + 10_000 : 0;
      }
      if (!(await extendFxLock(admin, holder, LOCK_TTL_MS))) break;     // lost the lock: stop acting
      const remaining = WATCH_BUDGET_MS - (Date.now() - start);
      if (remaining <= 0) break;
      await sleep(Math.min(WATCH_INTERVAL_MS, remaining));
    }
    return json({ ok: true, watch: true, scanned, ticks, sent, books, asOf: new Date().toISOString() });
  } finally {
    clearInterval(keepAlive);
    await releaseFxLock(admin, holder).catch(() => {});
  }
}

export async function GET(req: NextRequest) { return handle(req); }
export async function POST(req: NextRequest) { return handle(req); }
