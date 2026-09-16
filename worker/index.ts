/**
 * WE ARE 1 MISSION — ALWAYS-ON EXECUTION WORKER (owner 09-09: "We need execution to
 * speed up... all things firing faster... Price needs to be watched and acted on").
 *
 * A single long-lived Node process (Railway) that runs the SAME battle-tested code the
 * Vercel crons run — just continuously, with no cold starts and no once-a-minute
 * restarts:
 *
 *   • TRADE MANAGER  (~WORKER_MANAGE_MS, default 800ms): break-even, partials, trail,
 *     TP self-heal — the identical manageOpenPositions() the cron calls.
 *   • GENX FAST WATCH (~WORKER_WATCH_MS, default 1500ms): armed/forming setups checked
 *     against a fresh confirmation read — the identical watchPass() the cron calls.
 *
 * COORDINATION — the DB locks are the whole story:
 *   flow_manage_lock id=1 (manager) and id=2 (watch). The worker holds them while
 *   alive; the Vercel crons only act when they can take a lock. Worker dies → locks
 *   expire in seconds → the next minutely cron takes over automatically. Worker comes
 *   back → it re-takes the locks as soon as the cron's current pass releases them.
 *   Nothing ever double-manages or double-fires.
 *
 * PRICE FEED: fast broker polling — each manage tick pulls the live quote through the
 * same per-tick cache flowManage always used. The tick interval IS the sampling rate.
 *
 * Required env (same values as Vercel): NEXT_PUBLIC_SUPABASE_URL,
 * SUPABASE_SERVICE_ROLE_KEY, FLOW_ENC_KEY, TWELVEDATA_API_KEY, TELEGRAM_BOT_TOKEN,
 * TELEGRAM_CHANNEL_ID. Optional: WORKER_MANAGE_MS, WORKER_WATCH_MS.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { manageOpenPositions, acquireManageLock, extendManageLock, releaseManageLock, repairPhantomTargets } from "@/lib/flow/flowManage";
import { watchPass, beatKeepDecision, acquireWatchLock, extendWatchLock, releaseWatchLock } from "@/lib/genx/watchTick";
import { inWeekendCloseWindow } from "@/lib/flow/autoExec";
import { manageMattyPips } from "@/lib/matty-pips/manage";
import { runMattyScan } from "@/lib/matty-pips/scan";
import { beat } from "@/lib/flow/health";
import { archiveGoldCandles } from "@/lib/genx/candleArchive";
import { streamLoop } from "./priceStream";
import { genx31Tick } from "@/lib/genx3/v31/runtime";
import { hostname } from "node:os";

// OWNER 09-09 ("insane fast... trade manager instant"): defaults at the polling
// ceiling — manage passes run essentially back-to-back (a pass with open positions
// takes ~300ms+ anyway), the watch re-reads every armed setup each second.
const MANAGE_MS = Math.max(250, Number(process.env.WORKER_MANAGE_MS || 350));
const WATCH_MS = Math.max(750, Number(process.env.WORKER_WATCH_MS || 1000));
const LOCK_TTL_MS = 15_000;          // short TTL → fast cron takeover if this process dies
const LOCK_RETRY_MS = 3_000;         // while a cron pass holds the lock, retry every 3s
const REPAIR_EVERY_MS = 60_000;      // phantom-target ledger sweep, once a minute (as before)
// 15s, not 5s (owner 09-11 live incident): at 5s the Matty book's broker calls, stacked
// on FLOW manage + the 1s watch, blew past the broker edge's per-IP rate ceiling and a
// Cloudflare-1015 storm froze ALL management for minutes. 15s is still 4× the old cron
// and, with the host-wide cooloff in tradelocker.ts, keeps total load under the ceiling.
const MATTY_EVERY_MS = 15_000;       // Matty Pips manager cadence inside the worker
// Matty ENTRY scan cadence (owner 09-11 audit: "the trades needs to be executed
// immediately" — the minutely cron alone meant a TAKE_NOW could wait up to 60s).
// 20s = 3× the cron. The scan is market-data work (engine reads); it only touches
// the broker when a TAKE_NOW actually fires, and per-signal claims dedupe against
// the cron — so this adds no standing broker load and can never double-fill.
const MATTY_SCAN_EVERY_MS = 20_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const HOLDER = `worker-${hostname()}-${process.pid}`;
let shuttingDown = false;

function log(msg: string, extra?: unknown) {
  // eslint-disable-next-line no-console
  console.log(`[${new Date().toISOString()}] ${msg}`, extra ?? "");
}

/** TRADE-MANAGER LOOP — hold lock id=1, tick manageOpenPositions continuously. */
async function manageLoop(): Promise<never> {
  const admin = createAdminClient();
  if (!admin) throw new Error("no_admin_client — check NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  let lastRepair = 0;
  let lastMatty = 0;
  for (;;) {
    if (shuttingDown) { await releaseManageLock(admin, HOLDER); process.exit(0); }
    // Take (or keep) the lock. A cron invocation may hold it for up to ~112s right
    // after a worker restart — we just retry until its pass ends, then own it for good.
    const got = await acquireManageLock(admin, HOLDER, LOCK_TTL_MS).catch(() => false);
    if (!got) { await sleep(LOCK_RETRY_MS); continue; }
    log(`manage: lock acquired as ${HOLDER} — ticking every ${MANAGE_MS}ms`);
    await beat(admin, "manager", { worker: true, starting: true }).catch(() => {});
    let ticks = 0;
    while (!shuttingDown) {
      const t0 = Date.now();
      try {
        const r = await manageOpenPositions();
        ticks += 1;
        await beat(admin, "manager", { worker: true, ticks, lastManaged: r?.managed ?? null, passMs: Date.now() - t0 }).catch(() => {});
      } catch (e) {
        log("manage: tick error (loop continues)", e instanceof Error ? e.message.slice(0, 200) : e);
      }
      try { await extendManageLock(admin, HOLDER, LOCK_TTL_MS); } catch { /* next acquire re-takes */ }
      // MATTY PIPS management at worker speed (owner 09-11: "Matty pips AI is not
      // getting managed"): the same excursion-aware manager the cron runs, every ~5s
      // instead of once a minute. The cron stands down while our heartbeat is fresh.
      if (Date.now() - lastMatty > MATTY_EVERY_MS) {
        lastMatty = Date.now();
        try { await manageMattyPips(); } catch { /* best-effort — next tick retries */ }
      }
      if (Date.now() - lastRepair > REPAIR_EVERY_MS) {
        lastRepair = Date.now();
        try { await repairPhantomTargets(admin); } catch { /* sweep is best-effort */ }
      }
      const elapsed = Date.now() - t0;
      await sleep(Math.max(50, MANAGE_MS - elapsed));
    }
    await releaseManageLock(admin, HOLDER).catch(() => {});
    process.exit(0);
  }
}

/** GENX FAST-WATCH LOOP — hold lock id=2, tick watchPass continuously. */
async function watchLoop(): Promise<never> {
  const admin = createAdminClient();
  if (!admin) throw new Error("no_admin_client");
  const mdKey = process.env.TWELVEDATA_API_KEY;
  if (!mdKey) throw new Error("no TWELVEDATA_API_KEY");
  const tgReady = !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHANNEL_ID);
  for (;;) {
    if (shuttingDown) { await releaseWatchLock(admin, HOLDER); process.exit(0); }
    if (inWeekendCloseWindow()) { await sleep(30_000); continue; } // same blackout as the cron
    const got = await acquireWatchLock(admin, HOLDER, LOCK_TTL_MS).catch(() => false);
    if (!got) { await sleep(LOCK_RETRY_MS); continue; }
    log(`watch: lock acquired as ${HOLDER} — ticking every ${WATCH_MS}ms`);
    while (!shuttingDown) {
      const t0 = Date.now();
      try {
        if (inWeekendCloseWindow()) break; // release and idle through the blackout
        if (tgReady) { try { await beatKeepDecision(admin, { tier: "watch", worker: true }); } catch { /* liveness best-effort */ } }
        await watchPass(admin, mdKey, tgReady);
      } catch (e) {
        log("watch: pass error (loop continues)", e instanceof Error ? e.message.slice(0, 200) : e);
      }
      try { await extendWatchLock(admin, HOLDER, LOCK_TTL_MS); } catch { /* next acquire re-takes */ }
      const elapsed = Date.now() - t0;
      await sleep(Math.max(100, WATCH_MS - elapsed));
    }
    await releaseWatchLock(admin, HOLDER).catch(() => {});
    if (shuttingDown) process.exit(0);
  }
}

/** MATTY ENTRY-SCAN LOOP — the same runMattyScan the minutely cron calls, every ~20s,
 *  so a TAKE_NOW executes within seconds of forming instead of waiting for the next
 *  minute boundary. Claims (unique signal+account index) make the overlap with the
 *  cron harmless. Best-effort by design: any error just waits out the interval. */
async function mattyScanLoop(): Promise<never> {
  for (;;) {
    if (shuttingDown) process.exit(0);
    const t0 = Date.now();
    try { await runMattyScan(); } catch (e) {
      log("matty-scan: error (loop continues)", e instanceof Error ? e.message.slice(0, 200) : e);
    }
    const elapsed = Date.now() - t0;
    await sleep(Math.max(2_000, MATTY_SCAN_EVERY_MS - elapsed));
  }
}


/** GENX 3.0 LOOP — hold lock id=3 so exactly one process runs the engine. The engine
 *  itself decides at most once per closed 5m candle (unique DB row), so a tick every ~5s
 *  is cheap. Best-effort: its failure never kills the manager/watch loops. */
const GENX3_MS = 2_000;
async function genx3Loop(): Promise<never> {
  const admin = createAdminClient();
  if (!admin) throw new Error("no_admin_client");
  const lock = async (fn: "take" | "extend" | "release") => {
    const exp = new Date(Date.now() + (fn === "release" ? 0 : 30_000)).toISOString();
    let q = admin.from("flow_manage_lock").update(fn === "take" ? { holder: HOLDER, expires_at: exp } : { expires_at: exp }).eq("id", 3);
    q = fn === "take" ? q.lt("expires_at", new Date().toISOString()) : q.eq("holder", HOLDER);
    const { data } = await q.select("id");
    return Array.isArray(data) && data.length > 0;
  };
  for (;;) {
    if (shuttingDown) { await lock("release").catch(() => {}); process.exit(0); }
    const got = await lock("take").catch(() => false);
    if (!got) { await sleep(LOCK_RETRY_MS); continue; }
    log(`genx3: lock acquired as ${HOLDER}`);
    let lastReason = "";
    while (!shuttingDown) {
      const t0 = Date.now();
      try {
        const r = await genx31Tick(admin, HOLDER);
        const reason = r.ran ? (r.signal ? `SIGNAL ${r.signal}` : "decided") : r.reason ?? "";
        if (r.signal || reason !== lastReason) log(`genx3.1: ${reason}`, r.reasons?.slice(0, 5));
        lastReason = reason;
        await beat(admin, "genx3", { worker: true, ran: r.ran, reason: r.reason ?? null }).catch(() => {});
      } catch (e) {
        log("genx3: tick error (loop continues)", e instanceof Error ? e.message.slice(0, 200) : e);
      }
      if (!(await lock("extend").catch(() => false))) break;
      await sleep(Math.max(500, GENX3_MS - (Date.now() - t0)));
    }
  }
}

/** HISTORY BACKFILL — walks the XAU/USD 1m archive back to GENX_ARCHIVE_DAYS, one page
 *  (≤5000 bars, one data credit) every 20s, then stops. Read-only market data. */
async function backfillLoop(): Promise<void> {
  const admin = createAdminClient();
  if (!admin) return;
  let errors = 0;
  while (!shuttingDown) {
    const r = (await archiveGoldCandles(admin).catch((e) => ({ ran: false, reason: "exception", detail: String(e) }))) as Record<string, unknown>;
    if (r.reason === "covered" || r.reason === "exhausted") { log("backfill: done", r); return; }
    if (!r.ran) { errors += 1; log("backfill: skipped", r); if (errors > 30) return; await sleep(60_000); continue; }
    errors = 0;
    log("backfill: page", { from: r.from, to: r.to, rows: r.rows, mode: r.mode });
    await sleep(20_000);
  }
}

process.on("SIGTERM", () => { log("SIGTERM — releasing locks and exiting"); shuttingDown = true; });
process.on("SIGINT", () => { log("SIGINT — releasing locks and exiting"); shuttingDown = true; });
process.on("unhandledRejection", (e) => log("unhandledRejection", e));
process.on("uncaughtException", (e) => { log("uncaughtException — exiting for a clean restart", e); process.exit(1); });

log(`🚀 We Are 1 Mission worker starting as ${HOLDER} (manage ${MANAGE_MS}ms · watch ${WATCH_MS}ms)`);
// The price stream is best-effort by design: it feeds the in-memory tick store that the
// manage/watch loops read opportunistically. If it can't run (plan gate, feed outage,
// bad socket) the loops keep polling exactly as before — its failure must never kill
// the worker, so it lives OUTSIDE the fatal Promise.all.
void streamLoop(() => shuttingDown).catch((e) => log("stream: loop error (worker continues on polling)", e instanceof Error ? e.message : e));
// Matty entry scan is best-effort like the stream: its failure must never kill the
// worker (the minutely Vercel cron still covers entries), so it lives OUTSIDE the
// fatal Promise.all too.
void mattyScanLoop().catch((e) => log("matty-scan: loop died (cron still covers entries)", e instanceof Error ? e.message : e));
void backfillLoop().catch(() => {});
void genx3Loop().catch((e) => log("genx3: loop died", e instanceof Error ? e.message : e));
void Promise.all([manageLoop(), watchLoop()]).catch((e) => {
  log("fatal — exiting so the platform restarts the worker", e);
  process.exit(1);
});
