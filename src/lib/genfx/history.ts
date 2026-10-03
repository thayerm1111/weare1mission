import { createAdminClient } from "@/lib/supabase/admin";
import { PAIRS, PAIR_KEYS, type FxPair, type PairKey } from "@/lib/genfx/pairs";
import { configOf } from "@/lib/genfx/control";
import { replay, aggregate, zoneOffsetMs, type Bar, type ReplayOut } from "@/lib/genfx/replay";
import { type Mode } from "@/lib/genxCompute";

/**
 * GEN FX REPLAY RUNNER — fetches real 5-minute history and runs replay.ts over it.
 *
 * It is asked for through the control row: set genfx_control.replay_request to an object (even an
 * empty one) and the worker picks it up within half a minute, runs both pairs IN A PROCESS OF ITS OWN
 * (worker/genfxReplay.ts — a year of history is minutes of solid arithmetic, and the worker's main
 * process is the one running the trade manager), and writes the result to replay_result.
 *
 *   update genfx_control set replay_request = '{"weeks": 52}' where id = 1;
 *
 * Request fields, all optional:
 *   weeks        how many weeks to TEST (default 26, at most 104). Eleven more are fetched in front of
 *                them: Swing reads weekly candles and needs ten before its first decision.
 *   costPips     { "EURUSD": 1.0, "GBPJPY": 2.5 }   round-trip cost charged per trade
 *   minStopPips  { "EURUSD": 10,  "GBPJPY": 20 }    tightest stop taken (default: the live setting)
 *   modes        ["quick","intraday","swing"]
 *   trades       true to keep every simulated trade in the result (default: the last 40 per pair)
 *   zone         force the clock the higher timeframes are cut on (default: measured from the feed)
 *
 * While it runs, replay_result says so, with a heartbeat every few seconds and how far it has got;
 * a result that says "running" with an old heartbeat is a run that died.
 *
 * Read-only against the market and the broker: it places nothing and touches no account.
 */
type Admin = NonNullable<ReturnType<typeof createAdminClient>>;
const M5 = 5 * 60_000;
const PAGE = 5000;
const WARMUP_WEEKS = 11;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type FeedRow = { datetime?: string; open?: string; high?: string; low?: string; close?: string };
async function tdSeries(td: string, interval: string, size: number, key: string, extra = ""): Promise<FeedRow[] | null> {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30_000);
      let j: { status?: string; values?: FeedRow[]; code?: number };
      let status = 0;
      try {
        const r = await fetch(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(td)}&interval=${interval}&outputsize=${size}${extra}&apikey=${key}`, { cache: "no-store", signal: ctrl.signal });
        status = r.status;
        j = (await r.json()) as typeof j;
      } finally { clearTimeout(timer); }
      if (j.status === "error" || !Array.isArray(j.values)) {
        if (status === 429 || j.code === 429) { await sleep(20_000); continue; }   // per-minute credit limit: wait it out
        return null;
      }
      return j.values;
    } catch { await sleep(2_000); }
  }
  return null;
}

/** Real, CLOSED 5-minute candles for `weeks`, oldest → newest, timestamps in UTC. Null when the feed refuses. */
export async function fetchM5(pair: FxPair, weeks: number, key: string, nowMs = Date.now()): Promise<Bar[] | null> {
  const want = Math.ceil(weeks * 5 * 288 * 1.02);
  const byT = new Map<number, Bar>();
  let end: string | null = null;
  for (let page = 0; page < 80 && byT.size < want; page++) {
    const values = await tdSeries(pair.td, "5min", PAGE, key, `&timezone=UTC&order=DESC${end ? `&end_date=${encodeURIComponent(end)}` : ""}`);
    if (!values || !values.length) break;
    let oldest = Infinity;
    for (const v of values) {
      const t = Date.parse(String(v.datetime ?? "").replace(" ", "T") + "Z");
      const o = Number(v.open), h = Number(v.high), l = Number(v.low), c = Number(v.close);
      if (!Number.isFinite(t) || ![o, h, l, c].every((n) => Number.isFinite(n) && n > 0)) continue;
      byT.set(t, { t, o, h, l, c });
      oldest = Math.min(oldest, t);
    }
    if (!Number.isFinite(oldest) || values.length < PAGE) break;
    end = new Date(oldest - 1000).toISOString().slice(0, 19).replace("T", " ");
    await sleep(400);
  }
  if (byT.size < 2000) return null;
  // The newest candle the feed returns is the one still forming; a replay that read it as closed would be reading the future.
  return [...byT.values()].sort((a, b) => a.t - b.t).filter((b) => b.h >= b.l && b.t % M5 === 0 && b.t + M5 <= nowMs);
}

/* ── which clock does the feed cut its higher timeframes on? ──────────────────────────────────── */
/**
 * The clocks tried. Named zones keep daylight saving; the "Etc/GMT∓n" ones do not (the sign is the
 * standard's, and backwards: Etc/GMT-10 is ten hours AHEAD of UTC) — a feed that cuts its day at a
 * fixed offset matches one of those all year and a named zone for only half of it. "NY17" is the forex
 * day, 5pm New York.
 */
export const ZONE_CANDIDATES = ["UTC", "Australia/Sydney", "NY17", "America/New_York", "Europe/London", "Asia/Tokyo", "Etc/GMT-10", "Etc/GMT-11", "Etc/GMT-2", "Etc/GMT-3", "Etc/GMT+5", "Etc/GMT+4"];
export type ZoneFit = { zone: string; err: number; byTf: Record<string, number>; /** The same measure on the earlier windows — the worst of them; null when none could be taken. */ old?: number | null; /** …timeframe by timeframe. */ oldByTf?: Record<string, number> | null };
/** The candidate clocks ranked against the feed's candles from one earlier stretch of the year. */
export type ZoneWindow = { when: string; fits: ZoneFit[] };
const FIT = 0.02;

/**
 * How badly candles built from the 5-minute base on `zone`'s clock disagree with the feed's own
 * candles: the average gap between their highs and lows over the most recent `feed` candles, as a
 * share of the feed's average range (0 = identical). Only candles the base holds IN FULL are compared —
 * the one still forming where the base ends is half a candle, and would be matched against a whole one.
 * Matched from the newest candle backwards; where the two end is not known to the candle (they were
 * read minutes apart — or, for an older window, asked for by a date the feed reads on its own clock),
 * so the alignments either way are tried and the best kept: up to `maxShift` candles the base has and
 * the feed does not, and up to two the feed has and the base does not. Null when there is too little
 * to compare. Pure.
 */
const TF_SPAN: Record<string, number> = { "4h": 4 * 3600_000, "1day": 86_400_000, "1week": 7 * 86_400_000 };
export function zoneError(base: Bar[], feed: { h: number; l: number }[], tf: string, zone: string, maxShift = 2): number | null {
  const baseEnd = base.length ? base[base.length - 1].t + M5 : 0;
  // Only the end of the history is compared, so only the end of it is built: the candles to be matched,
  // the alignments to be tried, and half as much again for weekends. (The first candle built from a
  // history cut mid-candle is a part of one, and is left out.)
  const reach = TF_SPAN[tf] ? (Math.min(feed.length, 40) + maxShift + 8) * TF_SPAN[tf] * 1.5 : Infinity;
  let from = 0;
  if (Number.isFinite(reach) && base.length && base[0].t < baseEnd - reach) { let lo = 0, hi = base.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (base[mid].t < baseEnd - reach) lo = mid + 1; else hi = mid; } from = lo; }
  const built = aggregate(from ? base.slice(from) : base, tf, zone);
  const mine = built.bars.filter((_, i) => built.end[i] <= baseEnd && (from === 0 || i > 0));
  if (mine.length < 8 || feed.length < 6) return null;
  const span = feed.reduce((n, b) => n + (b.h - b.l), 0) / feed.length;
  if (!(span > 0)) return null;
  let best: number | null = null;
  for (let shift = -2; shift <= maxShift; shift++) {
    const skipMine = Math.max(shift, 0), skipFeed = Math.max(-shift, 0);
    const n = Math.min(feed.length - skipFeed, mine.length - skipMine, 40);
    if (n < 6) continue;
    let sum = 0;
    for (let j = 0; j < n; j++) {
      const f = feed[feed.length - 1 - j - skipFeed], m = mine[mine.length - 1 - j - skipMine];
      sum += Math.abs(f.h - m.h) + Math.abs(f.l - m.l);
    }
    const err = sum / (2 * n) / span;
    if (best == null || err < best) best = err;
  }
  return best;
}

/** Rank the candidate clocks by how well each reproduces the feed's own 4-hour, daily and weekly candles. Pure. */
export function rankZones(base: Bar[], feed: Record<string, { h: number; l: number }[]>, zones = ZONE_CANDIDATES, maxShift: Record<string, number> = {}): ZoneFit[] {
  const out: ZoneFit[] = [];
  for (const zone of zones) {
    const byTf: Record<string, number> = {};
    for (const tf of Object.keys(feed)) { const e = zoneError(base, feed[tf], tf, zone, maxShift[tf] ?? 2); if (e != null) byTf[tf] = Math.round(e * 10000) / 10000; }
    const vals = Object.values(byTf);
    if (vals.length) out.push({ zone, err: Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10000) / 10000, byTf });
  }
  return out.sort((a, b) => a.err - b.err);
}

/** Do two clocks cut every candle in the same place over this stretch of history? (Sydney and a fixed +10 do, in the southern winter.) Pure. */
export function sameClockOver(a: string, b: string, fromMs: number, toMs: number): boolean {
  for (let t = fromMs; t <= toMs; t += 3 * 86_400_000) if (zoneOffsetMs(a, t) !== zoneOffsetMs(b, t)) return false;
  return zoneOffsetMs(a, toMs) === zoneOffsetMs(b, toMs);
}

/**
 * Put the recent fit and the earlier ones together. The clock is the one that fits ALL of them best; it
 * is `verified` only when
 *   • it reproduces the feed's candles to within 2% of an average candle's range in every window, ON
 *     EVERY TIMEFRAME;
 *   • the earlier windows stand on BOTH SIDES OF THE YEAR — one in deep winter, one in high summer
 *     (`bothSides`); and
 *   • no other clock that also fits them all would cut the candles differently anywhere in the history
 *     being replayed.
 *
 * Why each. One window cannot tell a fixed offset from a daylight-saving clock: in October a feed on a
 * fixed ten hours ahead and one on Sydney time print identical candles, and differ by an hour for the
 * half of the year the replay also covers. "Six months earlier" does not settle it either — late March
 * and late September are BOTH summer time in New York and Chicago — so the windows are taken where every
 * daylight-saving clock in the world differs from itself: mid-January and mid-July. And an average
 * across timeframes hides a bad one: a clock an hour out can cut every 4-hour candle of a ten-day
 * window exactly right while its daily candles are visibly wrong, and the zero halved the miss to
 * "within 2%" — a feed on Chicago time was called verified as a fixed UTC−5 that way. Pure.
 */
export function chooseZone(recent: ZoneFit[], windows: ZoneWindow[] | null, span: { fromMs: number; toMs: number }, o: { bothSides?: boolean } = {}): { zone: string; verified: boolean; fits: ZoneFit[]; note: string } {
  if (!recent.length) return { zone: "UTC", verified: false, fits: [], note: "the feed's own candles could not be read; UTC assumed" };
  const olds = (windows ?? []).filter((w) => w.fits.length);
  /** The worst timeframe of a fit (the average, where no timeframes were kept). */
  const worst = (byTf: Record<string, number> | null | undefined, avg: number) => { const v = Object.values(byTf ?? {}); return v.length ? Math.max(...v) : avg; };
  const fits: ZoneFit[] = recent.map((f) => {
    if (!olds.length) return { ...f, old: null, oldByTf: null };
    // The worst this clock does in any earlier window, timeframe by timeframe. Missing from a window: it does not fit it.
    const oldByTf: Record<string, number> = {};
    let old = 0, missing = false;
    for (const w of olds) {
      const x = w.fits.find((y) => y.zone === f.zone);
      if (!x) { missing = true; continue; }
      old = Math.max(old, x.err);
      for (const [tf, e] of Object.entries(x.byTf)) oldByTf[tf] = Math.max(oldByTf[tf] ?? 0, e);
    }
    return missing ? { ...f, old: null, oldByTf: null } : { ...f, old, oldByTf };
  });
  const now = (f: ZoneFit) => worst(f.byTf, f.err);
  const then = (f: ZoneFit) => (f.old == null ? null : worst(f.oldByTf, f.old));
  fits.sort((a, b) => Math.max(now(a), then(a) ?? (olds.length ? Infinity : now(a))) - Math.max(now(b), then(b) ?? (olds.length ? Infinity : now(b))));
  const win = fits[0], top = fits.slice(0, 5);
  if (!olds.length) return { zone: win.zone, verified: false, fits: top, note: "checked against the feed's latest candles only — not across a daylight-saving change" };
  const when = olds.map((w) => w.when).join(" and ");
  const fitsAll = (f: ZoneFit) => { const t = then(f); return now(f) <= FIT && t != null && t <= FIT; };
  if (!fitsAll(win)) return { zone: win.zone, verified: false, fits: top, note: now(win) <= FIT ? `matches the feed's latest candles but not its candles from ${when}` : "no clock tried reproduces the feed's candles" };
  const rival = fits.find((f) => f !== win && fitsAll(f) && !sameClockOver(win.zone, f.zone, span.fromMs, span.toMs));
  if (rival) return { zone: win.zone, verified: false, fits: top, note: `${rival.zone} fits the feed as well and cuts some of this history differently` };
  if (!o.bothSides) return { zone: win.zone, verified: false, fits: top, note: `matches the feed's candles now and from ${when} — but not checked on both sides of the year (that takes a year of history)` };
  return { zone: win.zone, verified: true, fits: top, note: `matches the feed's candles now and from ${when}` };
}

const DAY = 86_400_000;
/**
 * Where the earlier windows end: the most recent 20 January and 20 July that the history can cover —
 * sixty days of it before the date (forty daily candles), and the date itself at least two weeks back,
 * so that it is not simply "now" again. Mid-January and mid-July are where every daylight-saving clock
 * is furthest from its changes, on opposite sides of them. Pure.
 */
export function seasonWindows(firstMs: number, lastMs: number): { when: string; endMs: number }[] {
  const out: { when: string; endMs: number }[] = [];
  const y = new Date(lastMs).getUTCFullYear();
  for (const [when, month] of [["January", 0], ["July", 6]] as const) {
    for (const year of [y, y - 1, y - 2]) {
      const endMs = Date.UTC(year, month, 20);
      if (endMs <= lastMs - 14 * DAY && endMs - 60 * DAY >= firstMs) { out.push({ when: `${when} ${year}`, endMs }); break; }
    }
  }
  return out;
}

/**
 * Measure the feed's clock. The live engine reads the feed's own 4-hour, daily and weekly candles —
 * asked for exactly as the scanner asks for them — and those are not cut at midnight UTC. Rather than
 * assume where they are cut, this fetches them, builds the same candles from the 5-minute history on
 * each candidate clock, and keeps the clock that reproduces the feed — on the latest candles, and on
 * the candles of last January and last July, either side of every daylight-saving change.
 */
export async function measureZone(pair: FxPair, base: Bar[], key: string): Promise<{ zone: string; verified: boolean; fits: ZoneFit[]; note: string }> {
  const read = async (tfs: readonly (readonly [string, number])[], extra: string, dropForming: boolean) => {
    const feed: Record<string, { h: number; l: number }[]> = {};
    for (const [tf, size] of tfs) {
      const rows = await tdSeries(pair.td, tf, size, key, extra);
      // Oldest → newest; the newest of the latest candles is still forming and is left out.
      const all = (rows ?? []).map((v) => ({ h: Number(v.high), l: Number(v.low) })).filter((b) => Number.isFinite(b.h) && Number.isFinite(b.l) && b.h >= b.l).reverse();
      const bars = dropForming ? all.slice(0, -1) : all;
      if (bars.length >= 6) feed[tf] = bars;
      await sleep(300);
    }
    return feed;
  };
  const recentFeed = await read([["4h", 60], ["1day", 40], ["1week", 14]], "", true);
  const recent = Object.keys(recentFeed).length ? rankZones(base, recentFeed) : [];

  const first = base[0]?.t ?? 0, last = base[base.length - 1]?.t ?? 0;
  const windows: ZoneWindow[] = [];
  const seasons = seasonWindows(first, last);
  for (const w of seasons) {
    const stamp = new Date(w.endMs).toISOString().slice(0, 19).replace("T", " ");
    const feed = await read([["4h", 60], ["1day", 40]], `&end_date=${encodeURIComponent(stamp)}`, false);
    // The feed reads that date on its own clock, so its last candle ends within about half a day either
    // side of it: the history is cut a little after, and enough alignments are tried to cover the gap.
    const cut = base.filter((b) => b.t <= w.endMs + 13 * 3600_000);
    if (Object.keys(feed).length === 2 && cut.length > 2000) windows.push({ when: w.when, fits: rankZones(cut, feed, ZONE_CANDIDATES, { "4h": 9, "1day": 3 }) });
  }
  return chooseZone(recent, windows.length ? windows : null, { fromMs: first, toMs: last }, { bothSides: windows.length === 2 && seasons.length === 2 });
}

const mapOf = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

/** If a replay has been asked for, run it and store the result. Returns whether one ran. */
export async function runRequestedReplay(admin: Admin, log: (m: string, x?: unknown) => void, yieldFn: () => Promise<void>): Promise<boolean> {
  const { data } = await admin.from("genfx_control").select("replay_request, config").eq("id", 1).maybeSingle();
  const row = data as { replay_request?: unknown; config?: unknown } | null;
  if (!row || !row.replay_request || typeof row.replay_request !== "object") return false;
  const req = row.replay_request as Record<string, unknown>;
  const startedAt = new Date().toISOString();
  // Claim it first: clearing the request is what stops a second worker (or the next tick) running it again.
  const { data: won } = await admin.from("genfx_control").update({ replay_request: null, replay_result: { status: "running", startedAt, heartbeatAt: startedAt, request: req } }).eq("id", 1).not("replay_request", "is", null).select("id");
  if (!won?.length) return false;

  const key = process.env.TWELVEDATA_API_KEY ?? "";
  const cfg = configOf(row.config);
  const weeks = Math.max(4, Math.min(104, Number(req.weeks) || 26));
  const modes = (Array.isArray(req.modes) ? req.modes : []).filter((m): m is Mode => m === "quick" || m === "intraday" || m === "swing");
  const keepAll = req.trades === true;
  const forcedZone = typeof req.zone === "string" && req.zone ? req.zone : null;
  const out: Record<string, unknown> = {};
  let progress: Record<string, unknown> = { stage: "starting" };
  // Writes go out one at a time, in the order they were asked for: a heartbeat still on its way when
  // the run finishes must not land after the result and turn "done" back into "running".
  let queue: Promise<boolean> = Promise.resolve(true);
  const write = (status: "running" | "done" | "failed", extra: Record<string, unknown> = {}): Promise<boolean> => {
    queue = queue.then(async () => {
      try {
        const { error } = await admin.from("genfx_control").update({ replay_result: { status, startedAt, heartbeatAt: new Date().toISOString(), request: req, weeks, progress, pairs: out, ...extra } }).eq("id", 1);
        return !error;
      } catch { return false; }
    });
    return queue;
  };
  // The heartbeat: a result that says "running" is believed only while this keeps arriving.
  const beat = setInterval(() => { void write("running"); }, 15_000);

  log(`genfx-replay: starting (${weeks} weeks tested, ${WARMUP_WEEKS} more in front)`);
  try {
    for (const k of PAIR_KEYS) {
      const pair = PAIRS[k as PairKey];
      try {
        progress = { pair: k, stage: "fetching history" };
        const bars = key ? await fetchM5(pair, weeks + WARMUP_WEEKS, key) : null;
        if (!bars) { out[k] = { error: "no_history (the market-data feed returned too little)" }; continue; }
        progress = { pair: k, stage: "measuring the feed's clock" };
        const clock = forcedZone ? { zone: forcedZone, verified: false, fits: [] as ZoneFit[], note: "set by hand" } : await measureZone(pair, bars, key);
        const cost = Number(mapOf(req.costPips)[k]);
        const minStop = Number(mapOf(req.minStopPips)[k]);
        // Every horizon starts from the same point — after Swing's ten weekly candles — so they are
        // compared over the same weeks. Never more than 45% of what was fetched.
        const warmup = Math.min(Math.floor(bars.length * 0.45), WARMUP_WEEKS * 5 * 288);
        const res: ReplayOut = await replay(pair, bars, {
          costPips: Number.isFinite(cost) && cost >= 0 ? cost : undefined,
          minStopPips: Number.isFinite(minStop) && minStop > 0 ? minStop : cfg.minStopPips[pair.key],
          modes: modes.length ? modes : undefined, warmupBars: warmup, zone: clock.zone, onYield: yieldFn,
          onProgress: (done, total) => { progress = { pair: k, stage: "replaying", done, total }; },
        });
        out[k] = { ...res, clock: { zone: clock.zone, verified: clock.verified, forced: !!forcedZone, fits: clock.fits, note: clock.note }, trades: keepAll ? res.trades : res.trades.slice(-40) };
        log(`genfx-replay: ${k} done`, { bars: res.bars, steps: res.steps, zone: clock.zone, verified: clock.verified, placed: res.placement.placed, managedR: res.managed.all.r, managedLowR: res.managedLow.all.r, rawR: res.raw.all.r });
      } catch (e) {
        out[k] = { error: e instanceof Error ? e.message.slice(0, 200) : "error" };
      }
      // Each pair is stored as it finishes, so a long run shows what it has while the next pair is still going.
      await write("running");
    }
  } catch (e) {
    // Said plainly, so the desk shows a run that failed rather than one that is "still running" forever.
    clearInterval(beat);
    await write("failed", { finishedAt: new Date().toISOString(), error: e instanceof Error ? e.message.slice(0, 300) : "error" });
    throw e;
  } finally { clearInterval(beat); }
  progress = { stage: "done" };
  // The result is the whole point of the run: if the write does not land, it is tried again before giving up.
  const finishedAt = new Date().toISOString();
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await write("done", { finishedAt })) return true;
    await sleep(2_000);
  }
  log("genfx-replay: the result could not be stored");
  return true;
}
