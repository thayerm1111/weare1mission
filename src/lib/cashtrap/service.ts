import { armedAlert, entryAlert, outcomeAlert, raise, signalAlert } from "./alerts";
import { closeOf, liveFreshness, M5, nextClose, slotOf, splitCompleted, type Candle } from "./candles";
import { effectiveConfig, type EffectiveConfig } from "./config";
import type { MarketData } from "./data";
import { dmiStatus } from "./dmi";
import { evaluateLast, initialState, step, trailingWindow, withBreaks, type Decision, type EngineEvent, type EngineState } from "./engine";
import { candleExpected, isOpen } from "./marketHours";
import type { SetupRecord } from "./replay";
import { acceptEntry, draftSignal, settle, type Quote, type SignalRecord } from "./signals";
import { armedWindowEnd, cardStatus, type Snapshot } from "./snapshot";
import type { CashtrapSettings, CashtrapStore } from "./store";
import { CASHTRAP_SYMBOLS, SYMBOL_SPECS, type CashtrapSymbol } from "./symbols";
import { atr as atrSeries } from "./indicators";
import { autoZonesAt } from "./zones";

/**
 * THE LIVE SERVICE — the same engine step as replay, driven by the market clock.
 *
 * Each pass, per symbol: fetch the recent 5-minute candles, store the completed ones (logging any
 * correction to a stored candle), decide every completed candle not yet decided — in order, once —
 * persist the decision, setups and engine state, publish confirmed signals and take their reference
 * entry at once, then rebuild the market card. Separately, signals are settled at their expiry time.
 *
 * Restarts: the engine state, decisions, setups and signals are all in the store, so a new process
 * continues exactly where the last one stopped. Duplicates: a candle is decided at most once (state +
 * the permanent decision key), a setup publishes at most one signal (unique key), an alert is raised
 * at most once per key. Lag: a confirmation decided more than `maxPublishLagMs` after its candle
 * closed (the runner was down) is recorded but NOT published — a late signal is never sent.
 */
export type ServiceDeps = {
  store: CashtrapStore;
  data: MarketData;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
};

const CATCH_UP_MAX = 24;          // candles decided in one pass after downtime; older ones are skipped (recorded)

/** How long after a candle's close it is decided: the feed's settle time, or the DMI grace period when events come from an outside feed. */
export function decisionDelayMs(settings: CashtrapSettings, cfg: EffectiveConfig): number {
  const D = cfg.assumptions.data;
  return settings.dmiMode === "event-feed" ? Math.max(D.feedSettleMs, D.dmiGraceMs) : D.feedSettleMs;
}

function setupRecordFrom(e: EngineEvent): SetupRecord {
  if (e.type === "armed") return { id: e.setup.id, symbol: e.setup.symbol, direction: e.setup.direction, exhaustionT: e.setup.exhaustionT, armedAt: e.setup.armedAt, status: "armed", reason: null, endedAt: null, confirmT: null, published: null, suppressedReason: null, setup: e.setup };
  if (e.type === "confirmed") {
    const s = e.confirmation.setup;
    return { id: s.id, symbol: s.symbol, direction: s.direction, exhaustionT: s.exhaustionT, armedAt: s.armedAt, status: "confirmed", reason: e.publish ? "confirmed by DMI" : `confirmed, not published: ${e.suppressedReason}`, endedAt: e.confirmation.decidedAt, confirmT: e.confirmation.confirmT, published: e.publish, suppressedReason: e.suppressedReason, setup: s };
  }
  return { id: e.setup.id, symbol: e.setup.symbol, direction: e.setup.direction, exhaustionT: e.setup.exhaustionT, armedAt: e.setup.armedAt, status: e.type, reason: e.reason, endedAt: e.at, confirmT: null, published: null, suppressedReason: null, setup: e.setup };
}

/** `upToDate`: every candle that should be decided by now is decided (or none is expected) — otherwise the runner tries again shortly. */
export type SymbolPass = { symbol: CashtrapSymbol; decided: number; published: number; corrections: number; snapshot: Snapshot | null; note: string | null; upToDate: boolean };

/** One pass for one symbol: candles → decisions → signals → card. */
export async function processSymbol(deps: ServiceDeps, symbol: CashtrapSymbol, settings: CashtrapSettings, cfg: EffectiveConfig, latestQuote: Quote | null): Promise<SymbolPass> {
  const { store, data } = deps;
  const A = cfg.assumptions;
  const keep = A.data.windowCandles + A.data.contiguityCandles + 50;
  const dmi = dmiStatus(settings.dmiMode, settings.dmiFeedVerified);
  const out: SymbolPass = { symbol, decided: 0, published: 0, corrections: 0, snapshot: null, note: null, upToDate: false };
  const hours = SYMBOL_SPECS[symbol].hours;

  const stored = await store.loadCandles(symbol, keep);
  // A closed market with enough history on hand is not asked again (no credits spent all weekend).
  const closedNow = !isOpen(hours, deps.now());
  // Ask for enough candles to cover any time the runner was away, so a gap is filled, not left behind.
  const lastStored = stored.length ? stored[stored.length - 1].t : null;
  const want = stored.length < A.data.minWarmupCandles || lastStored == null ? keep : Math.min(5000, Math.max(40, Math.ceil((deps.now() - closeOf(lastStored)) / M5) + 2));
  const f = closedNow && stored.length >= A.data.minWarmupCandles
    ? ({ ok: false, reason: "market closed", fetchedAt: deps.now() } as const)
    : await data.candles(symbol, want);
  let developing: Candle | null = null;
  if (f.ok) {
    if (f.issues.length) out.note = `feed issues: ${f.issues.slice(0, 3).join("; ")}`;
    const split = splitCompleted(f.candles, f.fetchedAt, A.data.feedSettleMs);
    developing = split.developing;
    const up = await store.upsertCandles(symbol, split.completed, data.name, deps.now());
    out.corrections = up.corrections.length;
    if (up.corrections.length) deps.log?.(`${symbol}: ${up.corrections.length} stored candle(s) corrected by the feed (logged; decisions are not rewritten)`);
  }
  const history = await store.loadCandles(symbol, keep);
  const now = deps.now();
  const latestT = history.length ? history[history.length - 1].t : null;
  const fresh = f.ok ? liveFreshness(symbol, latestT, now, A.data.feedSettleMs) : { open: isOpen(SYMBOL_SPECS[symbol].hours, now), ok: false, reason: f.reason, lagMs: null };

  // The engine state; a first start decides only the newest completed candle from here on.
  let state: EngineState = (await store.loadState(symbol)) ?? { ...initialState(symbol), lastT: history.length >= 2 ? history[history.length - 2].t : null };
  // With DMI events from an outside feed, a candle is decided only once its event has had the grace period to arrive.
  const decideAfter = decisionDelayMs(settings, cfg);
  let pending = history.filter((k) => (state.lastT == null || k.t > state.lastT) && closeOf(k.t) + decideAfter <= now);
  if (pending.length > CATCH_UP_MAX) {
    const skipTo = pending[pending.length - CATCH_UP_MAX - 1].t;
    out.note = `${pending.length - CATCH_UP_MAX} candle(s) skipped after downtime (not decided)`;
    if (state.armed) {
      const s = state.armed;
      await store.saveSetup({ id: s.id, symbol, direction: s.direction, exhaustionT: s.exhaustionT, armedAt: s.armedAt, status: "cancelled", reason: "the runner was down and candles were skipped, so the setup could not be followed", endedAt: now, confirmT: null, published: null, suppressedReason: null, setup: s }, cfg);
    }
    state = { ...state, lastT: skipTo, armed: null };
    pending = pending.slice(pending.length - CATCH_UP_MAX);
  }
  const manual = await store.manualZones(symbol);
  let lastDecision: Decision | null = null;

  for (const k of pending) {
    const idx = history.findIndex((x) => x.t === k.t);
    const upTo = history.slice(Math.max(0, idx + 1 - (A.data.windowCandles + A.data.contiguityCandles + 2)), idx + 1);
    const external = settings.dmiMode === "event-feed" ? await store.dmiEvents(symbol, k.t - 5 * M5, k.t) : undefined;
    const decidedAt = deps.now();
    const res = step(state, { candles: upTo, manualZones: manual, dmiMode: settings.dmiMode, dmiAvailable: dmi.available, externalEvents: external, decidedAt, config: cfg });
    await store.recordDecision(res.decision);
    lastDecision = res.decision;
    out.decided += 1;
    // A manual zone the engine has just seen broken is marked broken on the stored zone too (dashboard).
    for (const [id, b] of Object.entries(res.state.manualBroken ?? {})) if (!state.manualBroken?.[id]) await store.markManualZoneBroken(id, b.at, b.close);
    for (const e of res.events) {
      const rec = setupRecordFrom(e);
      await store.saveSetup(rec, cfg);
      if (e.type === "armed") await raise(store, armedAlert(e.setup), deps.now());
      if (e.type === "confirmed" && e.publish) {
        const sig = draftSignal(e.confirmation, deps.now(), cfg, "reference-feed");
        if (!(await store.insertSignal(sig))) continue;          // already published for this setup
        out.published += 1;
        // The reference entry first — the first quote asked for after publication — so no alert
        // delivery can delay it; then the alerts.
        const q = await data.quote(symbol);
        const entered = acceptEntry(sig, q, cfg);
        const took = await store.transitionSignal(entered, "published");
        await raise(store, signalAlert(sig), deps.now());
        if (took) await raise(store, entryAlert(entered), deps.now());
      }
    }
    state = res.state;
    await store.saveState(state, deps.now());
  }
  if (!pending.length && state.lastT != null && !(await store.loadState(symbol))) await store.saveState(state, now);
  const expectT = slotOf(now - decideAfter) - M5;            // the newest candle that should be decided by now
  out.upToDate = closedNow || !candleExpected(hours, expectT) || (state.lastT != null && state.lastT >= expectT);

  // A setup cannot wait on data that has stopped: past its window with no new candle, it is cancelled.
  if (!fresh.ok && fresh.open && state.armed && now > armedWindowEnd(state.armed, A.dmiWindowCandles) + A.data.feedSettleMs + 60_000) {
    const s = state.armed;
    await store.saveSetup({ id: s.id, symbol, direction: s.direction, exhaustionT: s.exhaustionT, armedAt: s.armedAt, status: "cancelled", reason: `data stale: ${fresh.reason}`, endedAt: now, confirmT: null, published: null, suppressedReason: null, setup: s }, cfg);
    state = { ...state, armed: null };
    await store.saveState(state, now);
  }

  // The candle still forming: provisional only.
  let dev: Snapshot["developing"] = null;
  const win = trailingWindow(history, A.data.windowCandles);
  // (Only when the forming candle directly follows the last completed one — while a closed candle is still settling, there is none.)
  if (developing && fresh.ok && !state.armed && win.length >= A.data.minWarmupCandles && developing.t === win[win.length - 1].t + M5) {
    const ev = evaluateLast(symbol, [...win.slice(1), developing], cfg, withBreaks(manual, state), { mode: "off", available: false, knownBy: now });
    const dir = ev.buy.exhaustion && !ev.sell.exhaustion ? "BUY" : ev.sell.exhaustion && !ev.buy.exhaustion ? "SELL" : null;
    if (dir) dev = { direction: dir, checklist: (dir === "BUY" ? ev.buy : ev.sell).checklist, values: ev.values, candleT: developing.t };
  }

  // Zones for the dashboard: everything known at the next candle's open.
  if (win.length >= A.data.minWarmupCandles) {
    const a = atrSeries(win.map((x) => x.h), win.map((x) => x.l), win.map((x) => x.c), A.zones.atrLength);
    const ghost = { t: win[win.length - 1].t + M5, o: 0, h: 0, l: 0, c: 0 };
    await store.saveAutoZones(symbol, autoZonesAt(symbol, [...win, ghost], [...a, null], win.length, A.zones));
  }

  const latest = await store.latestSignal(symbol);
  lastDecision = lastDecision ?? (await store.latestDecision(symbol));
  const armed = state.armed ? { ...state.armed, windowEndsAt: armedWindowEnd(state.armed, A.dmiWindowCandles) } : null;
  const feed = { open: fresh.open, ok: fresh.ok, reason: fresh.ok ? null : fresh.reason ?? null, lagMs: fresh.lagMs, latestCandleT: latestT };
  const card = cardStatus({ now, feed, lastDecision, armed, developing: dev, signal: latest, dmiAvailable: dmi.available });
  const snap: Snapshot = {
    symbol, updatedAt: now, price: latestQuote ? { px: latestQuote.px, at: latestQuote.at, source: latestQuote.source } : null, feed, ...card,
    nextCloseAt: nextClose(now), lastDecision, armed, developing: dev, signal: latest, dmi, strategyVersion: cfg.strategyVersion, configVersion: cfg.configVersion,
  };
  await store.saveSnapshot(snap);
  out.snapshot = snap;
  return out;
}

/** Finish one open signal if it is due: MISSED past its entry deadline, or settled at/after its expiry. */
export async function settleOne(deps: ServiceDeps, s: SignalRecord, cfg: EffectiveConfig): Promise<SignalRecord | null> {
  const now = deps.now();
  if (s.status === "published" && now > s.entryDeadline) {
    const missed = acceptEntry(s, null, cfg);
    missed.notes.push("the runner did not take the reference entry inside the window");
    if (!(await deps.store.transitionSignal(missed, "published"))) return null;   // another runner finished it
    await raise(deps.store, entryAlert(missed), now);
    return missed;
  }
  if (s.status === "active" && s.expiryAt != null && now >= s.expiryAt) {
    // A closed market at expiry has no settlement price (the feed would only repeat the last one): unresolved.
    const closed = !isOpen(SYMBOL_SPECS[s.symbol].hours, s.expiryAt);
    const q = closed ? null : await deps.data.quote(s.symbol);
    const settled = settle(s, q, cfg);
    if (closed) settled.notes = [...settled.notes.filter((n) => n !== "no settlement quote"), "the market was closed at expiry — no settlement price"];
    // Compare-and-set: a signal is settled once, by whichever runner gets there first — never overwritten.
    if (!(await deps.store.transitionSignal(settled, "active"))) return null;
    await raise(deps.store, outcomeAlert(settled), deps.now());
    return settled;
  }
  return null;
}

/** Settle everything that is due (the fallback sweep; exact-time settlement is scheduled in runLoop). */
export async function settleDue(deps: ServiceDeps, cfg: EffectiveConfig, busy: Set<string> = new Set()): Promise<SignalRecord[]> {
  const done: SignalRecord[] = [];
  for (const s of await deps.store.openSignals()) {
    if (busy.has(s.dedupeKey)) continue;
    busy.add(s.dedupeKey);
    try { const r = await settleOne(deps, s, cfg); if (r) done.push(r); } finally { busy.delete(s.dedupeKey); }
  }
  return done;
}

export type LoopResult = { ran: boolean; reason?: string; passes: number; decided: number; published: number; settled: number; notes: string[]; handedOver?: boolean; lostLock?: boolean };

/** How soon a market whose newest candle is not decided yet (feed late, failed or rate-limited) is tried again. */
export const RETRY_MS = 5_000;
/** The lock lapses this long after its last renewal, so a runner that died is replaced quickly. */
export const LOCK_TTL_MS = 30_000;
/** A runner hands over only when none of its own settlements is due within this window. */
export const HANDOVER_CLEAR_MS = 15_000;
/** May a runner hand over now, given when its pending settlements are due? */
export function clearToHandOver(dueAts: Iterable<number>, nowMs: number): boolean {
  for (const at of dueAts) if (at <= nowMs + HANDOVER_CLEAR_MS) return false;
  return true;
}

/**
 * The runner: holds the lock, decides each 5-minute candle `feedSettleMs` after it closes (trying a
 * market again every RETRY_MS until its candle is decided), keeps prices fresh every `quoteEveryMs`,
 * and wakes exactly at each signal's expiry.
 *
 * HAND-OVER: cron runs start late and at uneven times, so a run does not stop at a fixed moment.
 * From `minRunMs` on it hands over as soon as the next run is waiting for the lock (and none of its
 * own settlements is due within HANDOVER_CLEAR_MS); otherwise it carries on until `budgetMs`. A run
 * waiting for the lock marks itself every second, so there is no gap with nobody running.
 */
export async function runLoop(deps: ServiceDeps, opts: { holder: string; budgetMs: number; minRunMs?: number; quoteEveryMs?: number; lockWaitMs?: number }): Promise<LoopResult> {
  const { store } = deps;
  const res: LoopResult = { ran: false, passes: 0, decided: 0, published: 0, settled: 0, notes: [] };
  const start = deps.now();
  const end = start + opts.budgetMs;
  const minEnd = start + Math.min(opts.minRunMs ?? opts.budgetMs, opts.budgetMs);
  // Settings first: a run that cannot (or must not) run never asks the current runner to hand over.
  let settings: CashtrapSettings;
  try { settings = await store.getSettings(); }
  catch (e) { return { ...res, reason: `settings unavailable — nothing run: ${e instanceof Error ? e.message : String(e)}` }; }
  if (!settings.liveEnabled) return { ...res, reason: "Cashtrap live runner is switched off" };
  let got = await store.acquireLock(opts.holder, LOCK_TTL_MS, deps.now());
  while (!got && deps.now() - start < (opts.lockWaitMs ?? 0)) {
    await store.markWaiting(opts.holder, deps.now());
    await deps.sleep(1_000);
    got = await store.acquireLock(opts.holder, LOCK_TTL_MS, deps.now());
  }
  if (!got) return { ...res, reason: "another runner holds the lock" };
  res.ran = true;
  const busy = new Set<string>();
  const timers = new Map<string, Promise<void>>();
  const timerAt = new Map<string, number>();
  let stopping = false;
  try {
    // Now holding the lock: take the latest settings if they can be read (else keep the copy above).
    try { settings = await store.getSettings(); } catch { /* keep the earlier read */ }
    if (!settings.liveEnabled) return { ...res, reason: "Cashtrap live runner is switched off" };
    const cfg = effectiveConfig(settings.assumptions);
    const quotes = new Map<CashtrapSymbol, Quote>();
    const quoteEvery = opts.quoteEveryMs ?? 10_000;
    let lastQuotes = -Infinity;
    const doneSlot = new Map<CashtrapSymbol, number>();     // per market: the slot whose candles are all decided
    const lastTry = new Map<CashtrapSymbol, number>();
    const finished = async (rs: SignalRecord[]) => {
      res.settled += rs.length;
      for (const sym of new Set(rs.map((x) => x.symbol))) await refreshCard(deps, sym, settings, cfg, quotes.get(sym) ?? null);
    };
    // Exact-time settlement: one timer per open signal whose expiry (or entry deadline) falls inside this run.
    const schedule = async () => {
      for (const s of await store.openSignals()) {
        const at = s.status === "active" && s.expiryAt != null ? s.expiryAt : s.entryDeadline + 1;
        if (timers.has(s.dedupeKey) || at > end) continue;
        timerAt.set(s.dedupeKey, at);
        timers.set(s.dedupeKey, (async () => {
          try {
            const wait = at - deps.now();
            if (wait > 0) await deps.sleep(wait);
            if (stopping || busy.has(s.dedupeKey)) return;      // handed over: the next runner settles it
            // Still the runner? (A run whose lock lapsed must not settle what the new runner settles.)
            if (!(await store.acquireLock(opts.holder, LOCK_TTL_MS, deps.now()))) { stopping = true; res.lostLock = true; return; }
            busy.add(s.dedupeKey);
            try {
              const fresh = (await store.openSignals()).find((x) => x.dedupeKey === s.dedupeKey);
              const r = fresh ? await settleOne(deps, fresh, cfg) : null;
              if (r) await finished([r]);
            } catch (e) { res.notes.push(`settle ${s.dedupeKey}: ${e instanceof Error ? e.message : String(e)}`); }
            finally { busy.delete(s.dedupeKey); }
          } finally { timerAt.delete(s.dedupeKey); }
        })());
      }
    };
    while (deps.now() < end && !stopping) {
      await finished(await settleDue(deps, cfg, busy));
      await schedule();
      if (deps.now() - lastQuotes >= quoteEvery) {
        await Promise.all(CASHTRAP_SYMBOLS.map(async (s) => { if (!isOpen(SYMBOL_SPECS[s].hours, deps.now())) return; const q = await deps.data.quote(s); if (q) quotes.set(s, q); }));
        lastQuotes = deps.now();
      }
      // Decide candles once the feed shows them closed (at the start of a run: catch up). A market whose
      // newest candle could not be decided (feed late or failing) is tried again every RETRY_MS.
      const delay = decisionDelayMs(settings, cfg);
      const slot = slotOf(deps.now() - delay);
      const t0 = deps.now();
      const due = CASHTRAP_SYMBOLS.filter((s) => (doneSlot.get(s) ?? -Infinity) < slot && t0 - (lastTry.get(s) ?? -Infinity) >= RETRY_MS);
      if (due.length) {
        for (const s of due) lastTry.set(s, t0);
        const passes = await Promise.all(due.map((s) => processSymbol(deps, s, settings, cfg, quotes.get(s) ?? null).catch((e) => { res.notes.push(`${s}: ${e instanceof Error ? e.message : String(e)}`); return null; })));
        for (const p of passes) if (p) {
          res.decided += p.decided; res.published += p.published;
          if (p.note) res.notes.push(`${p.symbol}: ${p.note}`);
          if (p.upToDate) doneSlot.set(p.symbol, slot);
        }
        res.passes += 1;
        await schedule();
      } else if (deps.now() - lastQuotes < 1_000) {
        for (const s of CASHTRAP_SYMBOLS) await refreshCard(deps, s, settings, cfg, quotes.get(s) ?? null);
      }
      if (!(await store.acquireLock(opts.holder, LOCK_TTL_MS, deps.now()))) { res.lostLock = true; break; }   // renew; lost → stop at once
      // Hand over to a waiting runner once this run's minimum is over and nothing of ours is about to settle.
      if (deps.now() >= minEnd && (await store.successorWaiting(opts.holder, deps.now()))) {
        if (clearToHandOver(timerAt.values(), deps.now())) { res.handedOver = true; break; }
      }
      const retryAt = Math.min(...CASHTRAP_SYMBOLS.filter((s) => (doneSlot.get(s) ?? -Infinity) < slot).map((s) => (lastTry.get(s) ?? -Infinity) + RETRY_MS));
      const next = Math.min(slotOf(deps.now() - delay) + M5 + delay, lastQuotes + quoteEvery, retryAt, end, deps.now() >= minEnd ? deps.now() + 1_000 : Infinity);
      const wait = Math.max(50, next - deps.now());
      await deps.sleep(Math.min(wait, Math.max(0, end - deps.now())));
    }
    if (res.handedOver || res.lostLock) stopping = true;  // its later timers are the next runner's to settle
    else await Promise.all(timers.values());
  } finally {
    await store.releaseLock(opts.holder, deps.now());
  }
  return res;
}

/** Rebuild one card after a settlement without re-reading candles. */
async function refreshCard(deps: ServiceDeps, symbol: CashtrapSymbol, settings: CashtrapSettings, cfg: EffectiveConfig, q: Quote | null): Promise<void> {
  const prev = await deps.store.snapshot(symbol);
  if (!prev) return;
  const now = deps.now();
  const latest = await deps.store.latestSignal(symbol);
  const card = cardStatus({ now, feed: prev.feed, lastDecision: prev.lastDecision, armed: prev.armed, developing: prev.developing, signal: latest, dmiAvailable: dmiStatus(settings.dmiMode, settings.dmiFeedVerified).available });
  await deps.store.saveSnapshot({ ...prev, ...card, updatedAt: now, signal: latest, price: q ? { px: q.px, at: q.at, source: q.source } : prev.price, nextCloseAt: nextClose(now), configVersion: cfg.configVersion });
}

export { closeOf };
