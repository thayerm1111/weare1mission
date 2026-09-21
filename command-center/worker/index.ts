/**
 * COMMAND CENTER XAUUSD — WORKER
 *
 * One job right now: watch gold, build a snapshot, persist it. It cannot place, modify or close anything —
 * the adapters that could are not imported here, and will not be until the Risk Engine and Execution
 * Validator are wired and tested. That is the point of building in this order.
 *
 * Runs on Railway as its own service (`npm run cc-worker`), independent of every other process.
 */
import { series, price as tdPrice, GOLD } from "../adapters/twelvedata";
import {
  pruneSnapshots, audit, saveSnapshotWithBars, saveChartBars, saveEvents, saveBrainState, saveThesis, saveStatement, loadRolling,
} from "../adapters/db";
import { buildSnapshot, tradeable } from "../engines/snapshot";
import { marketOpen } from "../core/sessions";
import { perceive } from "../brain";
import { emptyRolling, type Rolling } from "../brain/memory";
import type { Bar, FeedHealth, MarketSnapshot, Timeframe } from "../core/types";
import { applyFollowUps } from "../engines/grade";
import { sweep as sweepWatches } from "../engines/watch";
import { reapAbandoned } from "../engines/voice";
import { scoreMatured } from "../engines/record";
import { upcoming, LOCKOUT_BEFORE_MIN, LOCKOUT_AFTER_MIN } from "../adapters/calendar";
import { autopilotTick, autopilotMode } from "../engines/autopilot";
import { autoManageTick } from "../engines/autoManage";
import { reconcilePending } from "../engines/executor";
import { preflight } from "../engines/preflight";
import { heartbeat, booted, switchChanged } from "../engines/notify";
import { brainEnabled } from "../engines/killSwitch";

const KEY = process.env.TWELVEDATA_API_KEY ?? "";
const TICK_MS = Number(process.env.CC_TICK_MS || 20_000);
const PERSIST_MS = Number(process.env.CC_PERSIST_MS || 60_000);
const NEEDED: { tf: Timeframe; size: number }[] = [
  { tf: "5m", size: 200 }, { tf: "15m", size: 150 }, { tf: "1h", size: 150 }, { tf: "4h", size: 120 }, { tf: "1d", size: 60 },
];

/**
 * ATLAS's rolling memory. Held in the process so perception runs on every tick, and rebuilt from the
 * database at boot so a restart does not give it amnesia about the last hour of the market.
 */
let lastPrice: number | null = null;
let brain: Rolling = emptyRolling();
/** Null until the first reading, so a fresh boot does not announce a change that did not happen. */
let lastSwitchOn: boolean | null = null;
/** When a live quote last arrived. This, not a bar's open time, is what "fresh" means. */
let lastPriceAt: number | null = null;

/**
 * How many accounts have automatic entry switched on, for the heartbeat.
 *
 * Cached for a minute: it changes when a member flips a toggle, not every twenty seconds, and the
 * heartbeat is the only caller.
 */
let armedCache: { at: number; n: number } | null = null;
async function armedCount(): Promise<number> {
  if (armedCache && Date.now() - armedCache.at < 60_000) return armedCache.n;
  try {
    const { createClient } = await import("@supabase/supabase-js");
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) return 0;
    const c = createClient(url, key, { auth: { persistSession: false } });
    const { count } = await c.from("cc_broker_accounts")
      .select("id", { count: "exact", head: true }).eq("auto_trading", true);
    armedCache = { at: Date.now(), n: count ?? 0 };
    return armedCache.n;
  } catch { return armedCache?.n ?? 0; }
}

const log = (msg: string, extra?: unknown) => console.log(`[${new Date().toISOString()}] cc: ${msg}`, extra ?? "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let shuttingDown = false;

/** Higher timeframes move slowly — refetching a daily candle every 20 seconds is waste, not freshness. */
const REFRESH_MS: Record<Timeframe, number> = { "1m": 30_000, "5m": 30_000, "15m": 120_000, "1h": 300_000, "4h": 900_000, "1d": 3_600_000 };
const cache = new Map<Timeframe, { at: number; bars: Bar[] }>();

async function barsFor(tf: Timeframe, size: number): Promise<{ bars: Bar[]; fresh: boolean; error?: string }> {
  const hit = cache.get(tf);
  if (hit && Date.now() - hit.at < REFRESH_MS[tf]) return { bars: hit.bars, fresh: false };
  const r = await series(tf, size, KEY);
  if (!r.ok) {
    // Keep the last good series rather than pretending the market vanished; the snapshot will flag its age.
    return { bars: hit?.bars ?? [], fresh: false, error: `${r.error}: ${r.detail}` };
  }
  cache.set(tf, { at: Date.now(), bars: r.data });
  return { bars: r.data, fresh: true };
}

/**
 * A CLOSED MARKET IS NOT AN EMPTY ONE.
 *
 * This used to return immediately when gold shut, which meant no snapshot was written all weekend —
 * and because the screen is built from the newest snapshot, a member arriving on Saturday saw "no
 * candles to draw", "no reads recorded today", a blank thesis and blank weather. Nothing was broken;
 * there was simply nothing to show, which looks identical to broken and is worse, because the last
 * thing gold actually did is exactly what somebody wants to study while the market is shut.
 *
 * So the pass still runs when closed, slowly. It builds and persists the same snapshot from the last
 * bars the market produced, so the price map, the thesis and the weather keep showing Friday's close
 * until Sunday moves them. What it does NOT do while closed is look for trades or manage anything —
 * see the guards further down.
 */
const CLOSED_TICK_MS = Number(process.env.CC_CLOSED_TICK_MS || 15 * 60_000);
let lastClosedPassAt = 0;

async function pass(lastPersistAt: number): Promise<number> {
  const now = Date.now();
  const isOpen = marketOpen(now);
  if (!isOpen) {
    if (now - lastClosedPassAt < CLOSED_TICK_MS) return lastPersistAt;
    lastClosedPassAt = now;
    log("market closed — refreshing the last read");
  }

  const bars: Partial<Record<Timeframe, Bar[]>> = {};
  const errors: string[] = [];
  for (const n of NEEDED) {
    const r = await barsFor(n.tf, n.size);
    if (r.bars.length) bars[n.tf] = r.bars;
    if (r.error) errors.push(`${n.tf} ${r.error}`);
  }

  const p = await tdPrice(KEY);
  const m5 = bars["5m"];
  const fallback = m5?.length ? m5[m5.length - 1].c : null;
  const live = p.ok ? p.data : fallback;
  if (live == null) { log("no price and no bars — nothing to read", errors); return lastPersistAt; }

  /*
   * FEED FRESHNESS IS THE AGE OF THE LAST PRICE, NOT THE AGE OF THE LAST BAR.
   *
   * This used to report `now - lastBarAt`, where lastBarAt is the OPEN timestamp of the newest 5-minute
   * candle. A bar is stamped when it opens, so that number climbs from 0 to 300 seconds as the bar
   * lives out its five minutes — and the gate it feeds, MAX_TICK_AGE_MS, is ninety seconds.
   *
   * The result: the snapshot was declared stale, and every trade hard-blocked, for the last 210 seconds
   * of every 5-minute bar. Seventy percent of all market time, on a feed that was perfectly healthy.
   * The field is called `lastTickMs` and the constant `MAX_TICK_AGE_MS`; the gate was always about
   * quote freshness and was being handed a bar timestamp.
   *
   * So freshness now comes from the quote this loop already fetches every tick, and the bar series gets
   * its own, much looser check — bars legitimately arrive one per interval, so "late" means several
   * intervals, not ninety seconds.
   */
  if (p.ok) lastPriceAt = now;

  const lastBarAt = m5?.length ? m5[m5.length - 1].t : null;
  const barAgeMs = lastBarAt != null ? now - lastBarAt : null;
  // Three 5-minute bars. A gap that long is a feed genuinely falling behind, not a bar in progress.
  const BARS_STALE_MS = 3 * 5 * 60_000;
  const barsStale = barAgeMs != null && barAgeMs > BARS_STALE_MS;

  const priceAgeMs = lastPriceAt != null ? now - lastPriceAt : null;

  const feeds: FeedHealth[] = [{
    feed: "twelvedata",
    // "stale" blocks trading; "degraded" only warns. A quote we cannot get AND no recent bars is the
    // case where the engine genuinely cannot see the market.
    state: barsStale || (!p.ok && !errors.length) ? "stale" : (!p.ok || errors.length) ? "degraded" : "live",
    lastTickMs: lastPriceAt,
    ageMs: priceAgeMs,
  }];

  const prevNet = brain.snapshots.length ? brain.snapshots[brain.snapshots.length - 1].pressure.net : null;

  /*
   * THE NEWS WINDOW, FINALLY POPULATED.
   *
   * The snapshot has always carried a `news` field and nothing ever filled it, so the lockout that is
   * supposed to keep the system out of the market around a high-impact release has never once fired.
   * The calendar is cached for five minutes, so asking on every tick costs nothing.
   */
  const cal = await upcoming(now).catch(() => null);
  const news = cal && cal.next
    ? {
        nextEvent: { name: cal.next.name, at: cal.next.at, importance: cal.next.importance },
        minutesToNext: cal.minutesToNext,
        inLockout: cal.inLockout,
      }
    : undefined;

  const snap = buildSnapshot({ now, bars, price: live, feeds, prevPressureNet: prevNet, news });
  lastPrice = snap.price;          // what the second look measures a finished trade's aftermath against
  const gate = tradeable(snap);

  // ATLAS runs on EVERY tick, not only when a snapshot is persisted. Perception is cheap and
  // deterministic; what it costs is nothing, and what it buys is noticing a change within one tick
  // instead of within a minute.
  const previousSnapshot = brain.snapshots.length ? brain.snapshots[brain.snapshots.length - 1] : null;
  const pc = perceive({ rolling: brain, snapshot: snap });
  brain = pc.rolling;

  // Promises kept before anything else is persisted: a member who asked to be told about a level cares
  // about that far more than about this tick's snapshot row.
  await keepPromises(snap, previousSnapshot);

  if (pc.events.length) {
    await saveEvents(pc.events);
    for (const e of pc.events.filter((x) => x.channel === "urgent" || x.channel === "voice")) {
      log(`! ${e.code} (${e.significance.score}) ${e.detail}`);
    }
  }
  if (pc.thesisChange !== "none") {
    if (pc.closedThesis) await saveThesis(pc.closedThesis);
    await saveThesis(pc.thesis);
    log(`thesis ${pc.thesisChange}: ${pc.thesis.label} (${pc.thesis.confidence}) — ${pc.statement?.text ?? ""}`);
  }
  if (pc.statement) await saveStatement(pc.statement);

  /*
   * TRADING, ON THE SAME TICK AS THE READ.
   *
   * Managing what is already open comes FIRST, every time. A trade that has earned its break-even
   * should get it before anything goes looking for the next entry — a manager that prioritises new
   * business over open risk is how a good trade becomes a bad one while the engine was busy.
   *
   * Both of these no-op entirely unless CC_AUTOPILOT is set, so a deployment that has not opted in
   * runs exactly as it did before: read, narrate, and wait to be asked.
   */
  /*
   * THE HOURLY HEARTBEAT, AND THE SWITCH.
   *
   * Sent from the worker rather than the autopilot because the owner needs to see it is alive
   * especially on the ticks where the autopilot returns early and says nothing — a read it does not
   * trust, a market it will not trade, a switch somebody turned off. Those are exactly the silences
   * that look identical to a dead process.
   *
   * notify throttles to once an hour and only while the market is open; this just supplies the facts.
   */
  if (autopilotMode() !== "off") {
    try {
      const sw = await brainEnabled();
      if (lastSwitchOn !== null && lastSwitchOn !== sw.on) switchChanged(sw.on);
      lastSwitchOn = sw.on;

      heartbeat({
        snapshot: snap,
        marketOpen: isOpen,
        tradeable: gate.ok,
        switchOn: sw.on,
        armedAccounts: await armedCount(),
        thesis: { label: pc.thesis.label, confidence: pc.thesis.confidence ?? null },
      });
    } catch { /* a status message must never disturb the loop */ }
  }

  if (isOpen && autopilotMode() !== "off") {
    // Adopt any fill the order-time checks missed BEFORE managing or trading, so both see it.
    try {
      for (const line of await reconcilePending()) log(line);
    } catch (e) { log("reconcile sweep error", String(e).slice(0, 160)); }
    try {
      const managed = await autoManageTick(snap);
      if (managed) log(managed);
    } catch (e) { log("automanage error", String(e).slice(0, 160)); }
    try {
      const traded = await autopilotTick({
        snapshot: snap,
        marketOpen: isOpen,
        tradeable: gate.ok,
        thesis: { bias: pc.thesis.bias ?? null, confidence: pc.thesis.confidence ?? null },
      });
      if (traded) log(traded);
    } catch (e) { log("autopilot error", String(e).slice(0, 160)); }
  }

  if (now - lastPersistAt >= PERSIST_MS) {
    const id = await saveSnapshotWithBars(snap, m5 ?? []);
    // Display only: the chart's candles for every timeframe, from bars this pass already has. Not awaited.
    void saveChartBars(bars).catch(() => {});
    await saveBrainState(pc.state);
    if (pc.thesisChange === "none") await saveThesis(pc.thesis);   // keep the open thesis' confidence current
    const tfs = Object.entries(snap.timeframes).map(([tf, v]) => `${tf}:${v!.state}`).join(" ");
    log(`snapshot#${id ?? "?"} ${snap.price.toFixed(2)} ${snap.session} ${snap.regime} pressure ${snap.pressure.net > 0 ? "+" : ""}${snap.pressure.net} | ${tfs} | ${gate.ok ? "tradeable" : `blocked: ${gate.code}`} | brain:${pc.state.presence} i${pc.state.intensity} | ${pc.thesis.label}`);
    if (errors.length) log("feed notes", errors);
    return now;
  }
  return lastPersistAt;
}

/**
 * THE SECOND LOOK.
 *
 * "Did we close too early?" cannot be answered at the moment of the exit — only afterwards. The worker is
 * the only thing here with a reliable clock, so it is what comes back to a finished trade three quarters
 * of an hour later and records what gold actually did next. Without this, the grading system can ask the
 * most important question in trading and never answer it.
 */
async function secondLook(price: number): Promise<void> {
  try {
    const n = await applyFollowUps(price);
    if (n) log(`graded the aftermath of ${n} finished trade${n === 1 ? "" : "s"}`);
  } catch (e) {
    log("follow-up error (loop continues)", e instanceof Error ? e.message.slice(0, 160) : e);
  }

  /*
   * THE SAME QUESTION, ASKED OF WHAT IT SAID RATHER THAN WHAT IT DID.
   *
   * A trade can be graded because it has an exit. A spoken read has no exit, so it is judged against
   * the clock: a call given a one-hour horizon is scored one hour later, using the price this tick
   * already holds. Scoring here rather than on demand is what makes the record honest — nothing is
   * ever graded at the moment it happened to look good, and nothing is scored against a stale quote.
   */
  try {
    const n = await scoreMatured(price);
    if (n) log(`scored ${n} matured call${n === 1 ? "" : "s"} against what gold actually did`);
  } catch (e) {
    log("call-scoring error (loop continues)", e instanceof Error ? e.message.slice(0, 160) : e);
  }
}

/**
 * PERSISTENT MONITORING INSTRUCTIONS.
 *
 * Everything a member asked ATLAS to watch is checked here, against the same snapshot every other
 * decision uses, on every pass. This is what makes "watch the London high and tell me if the retest
 * fails" survive a closed browser — the promise lives in the database and is kept by a process the
 * member never sees.
 *
 * A fired watch becomes a BRAIN statement, so it reaches the stream and the voice through exactly the
 * same path as everything else ATLAS says. There is no second notification channel to get out of
 * sync with the first.
 */
async function keepPromises(snap: MarketSnapshot, previous: MarketSnapshot | null): Promise<void> {
  try {
    const fired = await sweepWatches(snap, previous);
    for (const f of fired) {
      await saveStatement({
        at: Date.now(),
        kind: "observation",
        text: f.detail,
        channel: f.watch.notify === "urgent" ? "urgent" : f.watch.notify === "stream" ? "text" : "voice",
        priceAt: snap.price,
        thesisId: null,
      });
      log(`watch fired · ${f.watch.kind} · ${f.detail}`);
    }
  } catch (e) {
    log("watch sweep error (loop continues)", e instanceof Error ? e.message.slice(0, 160) : e);
  }
}

async function main(): Promise<void> {
  if (!KEY) { log("no TWELVEDATA_API_KEY — the Command Center cannot see the market; exiting"); process.exit(1); }
  log(`starting · tick ${TICK_MS}ms · persist ${PERSIST_MS}ms · symbol ${GOLD}`);
  await audit({ actor: "cc-worker", action: "worker_start", reason: "Command Center observation loop started" });

  // Wake up remembering. The market kept moving while this process was not running.
  brain = await loadRolling();
  log(`memory restored · ${brain.snapshots.length} snapshots · ${brain.events.length} events · ${brain.theses.length} theses`);

  /*
   * THE PRE-FLIGHT, ONCE, BEFORE THE FIRST TICK.
   *
   * Only when automatic entry is switched on — an observation-only deployment has no broker chain to
   * check and should not be renewing broker sessions at boot for no reason. It never blocks the loop:
   * a failing check is reported loudly and the worker still watches the market, because perception is
   * useful even when execution is broken, and a crash-loop would take the screens down too.
   */
  if (autopilotMode() !== "off") {
    try {
      const lines = await preflight();
      const bad = lines.filter((l) => !l.ok).length;
      log(`pre-flight (${autopilotMode()}) — ${lines.length - bad} ok, ${bad} failing`);
      for (const l of lines) log(`  ${l.ok ? "ok  " : "FAIL"} ${l.text}`);
      booted({
        ok: lines.length - bad,
        failing: bad,
        detail: bad ? lines.filter((l) => !l.ok).map((l) => l.text).join(" · ") : null,
      });
      if (bad) {
        await audit({
          actor: "cc-worker",
          action: "preflight_failed",
          reason: lines.filter((l) => !l.ok).map((l) => l.text).join(" | ").slice(0, 500),
        });
      }
    } catch (e) {
      log("pre-flight could not run (the loop continues)", e instanceof Error ? e.message.slice(0, 200) : e);
    }
  }

  let lastPersist = 0;
  let lastPrune = 0;
  let lastFollowUp = 0;
  while (!shuttingDown) {
    try {
      lastPersist = await pass(lastPersist);
      if (Date.now() - lastFollowUp > 5 * 60_000) {
        lastFollowUp = Date.now();
        if (lastPrice != null) await secondLook(lastPrice);
        // A voice session is a meter. A closed laptop does not close it, so the server does.
        try {
          const reaped = await reapAbandoned();
          if (reaped) log(`closed ${reaped} abandoned voice session${reaped === 1 ? "" : "s"}`);
        } catch { /* billing hygiene must never stop the market loop */ }
      }
      if (Date.now() - lastPrune > 6 * 3600_000) { await pruneSnapshots(); lastPrune = Date.now(); }
    } catch (e) {
      log("pass error (loop continues)", e instanceof Error ? e.message.slice(0, 200) : e);
    }
    await sleep(TICK_MS);
  }
}

process.on("SIGTERM", () => { log("SIGTERM — stopping"); shuttingDown = true; });
process.on("SIGINT", () => { log("SIGINT — stopping"); shuttingDown = true; });
process.on("unhandledRejection", (e) => log("unhandledRejection", e));

void main().catch((e) => { log("fatal", e instanceof Error ? e.message : e); process.exit(1); });
