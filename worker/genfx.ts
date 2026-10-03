/**
 * GEN FX LOOP — the always-on worker's part of GEN FX (EUR/USD and GBP/JPY).
 *
 * One process holds lock 6 of flow_manage_lock and does everything on a clock:
 *   • the fast watch, about once a second — page setups entered on touch, pending scanner setups
 *     confirmed (genfx/watch.ts)
 *   • the full scan, every five minutes on the candle — both pairs, three horizons (genfx/scan.ts) —
 *     and at once when the scanner is switched on. It runs ahead of the watch on the same loop, so it
 *     is bounded: a candle read gets eight seconds, and the first one to run out ends the scan
 *   • the books, at once after any entry and every twenty seconds otherwise (ten while an order is
 *     still being confirmed) — every order followed to a managed position or to nothing, stale resting
 *     orders withdrawn (genfx/settle.ts). They run BESIDE the watch, not in its way: a broker that
 *     takes fifteen seconds to answer must not be fifteen seconds in which nobody is looking at price
 *   • page reads graded, every five minutes (genfx/resolve.ts)
 *   • a history replay, whenever one is asked for through the control row — forked into a process of
 *     its own (worker/genfxReplay.ts), never run on this one's thread
 *
 * If this process dies the lock expires in seconds and the Vercel cron (/api/cron/genfx-scan) takes
 * the same work over on its own minute. Its failure never touches the trade manager or the gold
 * watch: it runs outside the worker's fatal Promise.all.
 *
 * WORKER_GENFX=0 stops THIS loop, not GEN FX: with the worker out of the way the cron fallback takes
 * the lock and carries on. What switches GEN FX off is the control row (genfx_control) — scan, auto.
 */
import { fork, type ChildProcess } from "node:child_process";
import path from "node:path";
import { createAdminClient } from "@/lib/supabase/admin";
import { beat } from "@/lib/flow/health";
import { readControl } from "@/lib/genfx/control";
import { runGenfxScan, isQuiet } from "@/lib/genfx/scan";
import { genfxWatchPass, genfxSweep, acquireFxLock, extendFxLock, releaseFxLock } from "@/lib/genfx/watch";
import { resolveGenfxOpen } from "@/lib/genfx/resolve";

const WATCH_MS = Math.max(750, Number(process.env.WORKER_GENFX_WATCH_MS || 1500));
const SCAN_MS = 5 * 60_000;
const SWEEP_MS = 20_000;
/** While any order is still being confirmed, the books are looked at this often instead. */
const SWEEP_SOON_MS = 10_500;
/** A books pass that has not come back in this long is treated as lost, and another may start. (Its writes are conditional; a late one cannot undo a newer one.) */
const BOOKS_STUCK_MS = 90_000;
const REPLAY_POLL_MS = 30_000;
const LOCK_TTL_MS = 30_000;
const LOCK_RETRY_MS = 5_000;
/** A pass that has run this long is stuck on something. The lock stops being renewed, so the fallback can take over. */
const PASS_STUCK_MS = 120_000;
/** A replay that has run this long is killed: a year of both pairs takes minutes, not hours. */
const REPLAY_MAX_MS = 90 * 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function log(msg: string, extra?: unknown) {
  // eslint-disable-next-line no-console
  console.log(`[${new Date().toISOString()}] ${msg}`, extra ?? "");
}

let replayChild: ChildProcess | null = null;
/** Start the replay in its own process, unless one is already running. */
function startReplay(): void {
  if (replayChild) return;
  try {
    // tsx passes its loader through execArgv, which fork inherits — so the child runs TypeScript and
    // resolves the same "@/..." paths this process does.
    const child = fork(path.join(process.cwd(), "worker", "genfxReplay.ts"), [], { stdio: "inherit" });
    replayChild = child;
    const kill = setTimeout(() => { log("genfx-replay: still running after 90 minutes — stopping it"); try { child.kill("SIGKILL"); } catch { /* already gone */ } }, REPLAY_MAX_MS);
    child.on("exit", (code, signal) => { clearTimeout(kill); if (replayChild === child) replayChild = null; log(`genfx-replay: process ended (${signal ?? code})`); });
    child.on("error", (e) => { clearTimeout(kill); if (replayChild === child) replayChild = null; log("genfx-replay: could not start", e.message.slice(0, 200)); });
    log("genfx-replay: started in its own process");
  } catch (e) {
    replayChild = null;
    log("genfx-replay: could not start", e instanceof Error ? e.message.slice(0, 200) : e);
  }
}

export async function genfxLoop(isShuttingDown: () => boolean, holder: string): Promise<void> {
  if (process.env.WORKER_GENFX === "0") { log("genfx: this loop is disabled via WORKER_GENFX=0 (the cron fallback still runs GEN FX; the control row is the off switch)"); return; }
  const admin = createAdminClient();
  const mdKey = process.env.TWELVEDATA_API_KEY ?? "";
  if (!admin) { log("genfx: off (no admin client)"); return; }
  // Without a market-data key this process can neither scan nor watch — and holding the GEN FX lock
  // would keep out the cron fallback, which may have one. So it stands aside entirely: the fallback
  // scans, watches and runs the books (and runs the books even where it has no key either).
  if (!mdKey) { log("genfx: this loop is off (no market-data key on the worker) — the cron fallback runs GEN FX, books included"); return; }

  let lastScanSlot = 0, nextBooksAt = 0, lastReplayPoll = 0;
  let lastScan: Record<string, unknown> = {};        // the last full scan's decisions, re-sent with every liveness beat
  let lastBooks: Record<string, unknown> = {};
  let booksBusy = false, booksAgain = false, booksGen = 0, booksStartedAt = 0;
  /** One books pass, off to the side. Never throws. */
  const runBooks = async (): Promise<void> => {
    const gen = ++booksGen;
    booksBusy = true; booksStartedAt = Date.now();
    try {
      const s = (await genfxSweep(admin)).settle;
      lastBooks = s;
      if (s.managed || s.voided || s.cancelled || s.held) log("genfx: books", s);
      // Something is still being confirmed with the broker: look again in ten seconds, not twenty.
      if (s.waiting || s.cancelled) nextBooksAt = Math.min(nextBooksAt, Date.now() + SWEEP_SOON_MS);
    } catch (e) {
      log("genfx: books error (loop continues)", e instanceof Error ? e.message.slice(0, 200) : e);
    } finally {
      if (gen === booksGen) {
        booksBusy = false;
        // An entry landed while this pass was running: its rows were not in it. Go again now.
        if (booksAgain) { booksAgain = false; void runBooks(); }
      }
    }
  };
  let ctl = await readControl(admin), ctlAt = Date.now();
  /** The scanner switch as it was last READ. A failed read answers "everything off", and is not the switch being turned. */
  let scanWas: boolean | null = ctl.readable ? ctl.scan : null;
  for (;;) {
    if (isShuttingDown()) { await releaseFxLock(admin, holder).catch(() => {}); try { replayChild?.kill(); } catch { /* gone */ } return; }
    const got = await acquireFxLock(admin, holder, LOCK_TTL_MS).catch(() => false);
    if (!got) { await sleep(LOCK_RETRY_MS); continue; }
    log(`genfx: lock acquired as ${holder} — watch every ${WATCH_MS}ms, scan every 5 min`);

    while (!isShuttingDown()) {
      const t0 = Date.now();
      let quiet = false;
      // The lock is renewed while a pass runs — but not for ever. A pass that is stuck must not keep
      // every other process out; past two minutes it stops renewing and the lock runs out on its own.
      const keepAlive = setInterval(() => { if (Date.now() - t0 < PASS_STUCK_MS) extendFxLock(admin, holder, LOCK_TTL_MS).catch(() => {}); }, 8_000);
      try {
        if (t0 - ctlAt >= 5_000) {                                                 // the switches, at most 5s stale
          ctl = await readControl(admin); ctlAt = t0;
          // THE SCANNER HAS JUST BEEN SWITCHED ON: scan now, before the watch looks at anything. While it
          // was off every five-minute slot was ticked off unscanned, housekeeping included — so what is
          // on record is from before, and the scan is what lets it go and reads the market as it is now.
          // (Judged between two reads that both succeeded: a read that failed is not "off".)
          if (ctl.readable) { if (ctl.scan && scanWas === false) lastScanSlot = 0; scanWas = ctl.scan; }
        }

        // FULL SCAN — once per five-minute candle, a few seconds after it closes so the feed has it.
        // It comes before the watch on purpose: on the first pass after the market reopens, page setups
        // are re-read from the market as it is now before anything can act on them.
        const slot = Math.floor((t0 - 8_000) / SCAN_MS);
        let entered = false;
        if (slot !== lastScanSlot) {
          lastScanSlot = slot;
          const r = await runGenfxScan(admin, mdKey, { worker: true });
          if (r.detail) lastScan = r.detail;
          const acted = Object.entries(r.decisions).filter(([, d]) => d.result && !/^already|same_setup|pending|armed_waiting|through_stop|not_yet/.test(String(d.result)));
          if (acted.some(([, d]) => /(^|\+)enter/.test(String(d.result)))) entered = true;
          if (r.skipped) log(`genfx: scan skipped (${r.skipped})`);
          else if (acted.length) log("genfx: scan", Object.fromEntries(acted.map(([k, d]) => [k, d.result])));
          // Page reads are graded from the same candle feed. If the scan found it not answering, it is not asked again now.
          if (r.feedDown) log("genfx: the candle feed did not answer in time — the rest of this scan and the page-read grading were skipped");
          else { try { const g = await resolveGenfxOpen(mdKey); if (g.resolved) log(`genfx: graded ${g.resolved} page read(s)`); } catch { /* grading is best-effort */ } }
        }

        // FAST WATCH — skipped while the market is in its quiet window, exactly as the gold watch is.
        quiet = isQuiet();
        if (ctl.scan && !quiet) {
          const w = await genfxWatchPass(admin, mdKey, ctl);
          if (w.sent.length) log("genfx: watch", w.sent);
          if (w.sent.some((x) => /ENTER/.test(x))) entered = true;
        }

        // THE BOOKS — in every window and whatever the switches say: an order that is out there has to
        // be followed to its end, and a resting one withdrawn, whatever the hour. Started, not awaited.
        // An entry brings them forward to NOW: the books pass is what hands a new position to the trade
        // manager, so it reads the broker's record of the order within the second.
        const now = Date.now();
        if (entered) { nextBooksAt = 0; if (booksBusy) booksAgain = true; }
        if (now >= nextBooksAt) {
          nextBooksAt = now + SWEEP_MS;
          const stuck = booksBusy && now - booksStartedAt > BOOKS_STUCK_MS;
          if (stuck) log("genfx: a books pass has not come back in 90s — starting another beside it");
          if (!booksBusy || stuck) void runBooks();
          // The liveness beat goes out on this clock whether or not a books pass could start.
          await beat(admin, "genfx", { ...lastScan, worker: true, watchAt: new Date(t0).toISOString(), books: lastBooks, booksRunningMs: booksBusy ? now - booksStartedAt : 0, switches: { scan: ctl.scan, auto: ctl.auto, scope: ctl.scope, billing: ctl.billing, telegram: ctl.telegram } }).catch(() => {});
        }

        // REPLAY — on request, in its own process.
        if (t0 - lastReplayPoll >= REPLAY_POLL_MS) {
          lastReplayPoll = t0;
          if (ctl.replayRequest) startReplay();
        }
      } catch (e) {
        log("genfx: pass error (loop continues)", e instanceof Error ? e.message.slice(0, 200) : e);
      } finally { clearInterval(keepAlive); }

      let held = true;
      try { held = await extendFxLock(admin, holder, LOCK_TTL_MS); } catch { /* transient DB error: the next extend decides */ }
      if (!held) { log(`genfx: lock lost after a ${Date.now() - t0}ms pass — re-acquiring`); break; }
      // Nothing to watch over the weekend or around the daily close: idle — but no longer than the books' next turn.
      await sleep(quiet || !ctl.scan ? Math.max(1_000, Math.min(10_000, nextBooksAt - Date.now())) : Math.max(150, WATCH_MS - (Date.now() - t0)));
    }
    await releaseFxLock(admin, holder).catch(() => {});
    if (isShuttingDown()) { try { replayChild?.kill(); } catch { /* gone */ } return; }
  }
}
