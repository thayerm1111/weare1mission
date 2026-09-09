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
import { beat } from "@/lib/flow/health";
import { hostname } from "node:os";

// OWNER 09-09 ("insane fast... trade manager instant"): defaults at the polling
// ceiling — manage passes run essentially back-to-back (a pass with open positions
// takes ~300ms+ anyway), the watch re-reads every armed setup each second.
const MANAGE_MS = Math.max(250, Number(process.env.WORKER_MANAGE_MS || 350));
const WATCH_MS = Math.max(750, Number(process.env.WORKER_WATCH_MS || 1000));
const LOCK_TTL_MS = 15_000;          // short TTL → fast cron takeover if this process dies
const LOCK_RETRY_MS = 3_000;         // while a cron pass holds the lock, retry every 3s
const REPAIR_EVERY_MS = 60_000;      // phantom-target ledger sweep, once a minute (as before)

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

process.on("SIGTERM", () => { log("SIGTERM — releasing locks and exiting"); shuttingDown = true; });
process.on("SIGINT", () => { log("SIGINT — releasing locks and exiting"); shuttingDown = true; });
process.on("unhandledRejection", (e) => log("unhandledRejection", e));
process.on("uncaughtException", (e) => { log("uncaughtException — exiting for a clean restart", e); process.exit(1); });

log(`🚀 We Are 1 Mission worker starting as ${HOLDER} (manage ${MANAGE_MS}ms · watch ${WATCH_MS}ms)`);
void Promise.all([manageLoop(), watchLoop()]).catch((e) => {
  log("fatal — exiting so the platform restarts the worker", e);
  process.exit(1);
});
