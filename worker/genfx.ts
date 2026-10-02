/**
 * GEN FX LOOP — the always-on worker's part of GEN FX (EUR/USD and GBP/JPY).
 *
 * One process holds lock 6 of flow_manage_lock and does everything on a clock:
 *   • the fast watch, about once a second — page setups entered on touch, pending scanner setups
 *     confirmed (genfx/watch.ts)
 *   • the full scan, every five minutes on the candle — both pairs, three horizons (genfx/scan.ts)
 *   • the books, every twenty seconds — stale resting orders withdrawn, accepted orders followed
 *     through to a ledger row (genfx/watch.ts `genfxSweep`)
 *   • page reads graded, every five minutes (genfx/resolve.ts)
 *   • a history replay, whenever one is asked for through the control row (genfx/history.ts)
 *
 * If this process dies the lock expires in seconds and the Vercel cron (/api/cron/genfx-scan) takes
 * the same work over on its own minute. Its failure never touches the trade manager or the gold
 * watch: it runs outside the worker's fatal Promise.all.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { inWeekendCloseWindow, inScanQuietWindow } from "@/lib/flow/autoExec";
import { beat } from "@/lib/flow/health";
import { readControl } from "@/lib/genfx/control";
import { runGenfxScan } from "@/lib/genfx/scan";
import { genfxWatchPass, genfxSweep, acquireFxLock, extendFxLock, releaseFxLock } from "@/lib/genfx/watch";
import { resolveGenfxOpen } from "@/lib/genfx/resolve";
import { runRequestedReplay } from "@/lib/genfx/history";

const WATCH_MS = Math.max(750, Number(process.env.WORKER_GENFX_WATCH_MS || 1500));
const SCAN_MS = 5 * 60_000;
const SWEEP_MS = 20_000;
const REPLAY_POLL_MS = 30_000;
const LOCK_TTL_MS = 30_000;
const LOCK_RETRY_MS = 5_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function log(msg: string, extra?: unknown) {
  // eslint-disable-next-line no-console
  console.log(`[${new Date().toISOString()}] ${msg}`, extra ?? "");
}

export async function genfxLoop(isShuttingDown: () => boolean, holder: string): Promise<void> {
  if (process.env.WORKER_GENFX === "0") { log("genfx: disabled via WORKER_GENFX=0"); return; }
  const admin = createAdminClient();
  const mdKey = process.env.TWELVEDATA_API_KEY;
  if (!admin || !mdKey) { log("genfx: off (no admin client or market-data key)"); return; }

  let lastScanSlot = 0, lastSweep = 0, lastReplayPoll = 0, replaying = false;
  let lastScan: Record<string, unknown> = {};        // the last full scan's decisions, re-sent with every liveness beat
  let ctl = await readControl(admin), ctlAt = Date.now();
  for (;;) {
    if (isShuttingDown()) { await releaseFxLock(admin, holder).catch(() => {}); return; }
    const got = await acquireFxLock(admin, holder, LOCK_TTL_MS).catch(() => false);
    if (!got) { await sleep(LOCK_RETRY_MS); continue; }
    log(`genfx: lock acquired as ${holder} — watch every ${WATCH_MS}ms, scan every 5 min`);

    while (!isShuttingDown()) {
      const t0 = Date.now();
      let quiet = false;
      const keepAlive = setInterval(() => { extendFxLock(admin, holder, LOCK_TTL_MS).catch(() => {}); }, 8_000);
      try {
        if (t0 - ctlAt >= 5_000) { ctl = await readControl(admin); ctlAt = t0; }   // the switches, at most 5s stale

        // FULL SCAN — once per five-minute candle, a few seconds after it closes so the feed has it.
        const slot = Math.floor((t0 - 8_000) / SCAN_MS);
        if (slot !== lastScanSlot) {
          lastScanSlot = slot;
          const r = await runGenfxScan(admin, mdKey, { worker: true });
          if (r.detail) lastScan = r.detail;
          const acted = Object.entries(r.decisions).filter(([, d]) => d.result && !/^already|same_setup|pending|armed_waiting/.test(String(d.result)));
          if (r.skipped) log(`genfx: scan skipped (${r.skipped})`);
          else if (acted.length) log("genfx: scan", Object.fromEntries(acted.map(([k, d]) => [k, d.result])));
          try { const g = await resolveGenfxOpen(mdKey, 60); if (g.resolved) log(`genfx: graded ${g.resolved} page read(s)`); } catch { /* grading is best-effort */ }
        }

        // FAST WATCH — skipped while the market is in its quiet window, exactly as the gold watch is.
        quiet = inWeekendCloseWindow() || inScanQuietWindow();
        if (ctl.scan && !quiet) {
          const w = await genfxWatchPass(admin, mdKey, ctl);
          if (w.sent.length) log("genfx: watch", w.sent);
        }

        // THE BOOKS — runs in every window: a resting order has to be withdrawn whatever the hour.
        if (t0 - lastSweep >= SWEEP_MS) {
          lastSweep = t0;
          const s = await genfxSweep(admin);
          const c = s.cancel as { scanned: number }, f = s.settle as { adopted: number; stamped: number };
          if (c.scanned || f.adopted || f.stamped) log("genfx: books", s);
          await beat(admin, "genfx", { ...lastScan, worker: true, watchAt: new Date(t0).toISOString(), switches: { scan: ctl.scan, auto: ctl.auto, scope: ctl.scope, billing: ctl.billing, telegram: ctl.telegram } }).catch(() => {});
        }

        // REPLAY — on request. It yields constantly, so it is started and left to run beside the loop.
        if (!replaying && t0 - lastReplayPoll >= REPLAY_POLL_MS) {
          lastReplayPoll = t0;
          if (ctl.replayRequest) {
            replaying = true;
            void runRequestedReplay(admin, log, () => new Promise<void>((r) => setImmediate(r)))
              .catch((e) => log("genfx-replay: failed", e instanceof Error ? e.message.slice(0, 200) : e))
              .finally(() => { replaying = false; });
          }
        }
      } catch (e) {
        log("genfx: pass error (loop continues)", e instanceof Error ? e.message.slice(0, 200) : e);
      } finally { clearInterval(keepAlive); }

      let held = true;
      try { held = await extendFxLock(admin, holder, LOCK_TTL_MS); } catch { /* transient DB error: the next extend decides */ }
      if (!held) { log(`genfx: lock lost after a ${Date.now() - t0}ms pass — re-acquiring`); break; }
      // Nothing to watch over the weekend or around the daily close: idle at the books' pace.
      await sleep(quiet || !ctl.scan ? 10_000 : Math.max(150, WATCH_MS - (Date.now() - t0)));
    }
    await releaseFxLock(admin, holder).catch(() => {});
    if (isShuttingDown()) return;
  }
}
