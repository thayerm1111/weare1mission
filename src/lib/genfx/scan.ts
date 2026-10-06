import { createAdminClient } from "@/lib/supabase/admin";
import { MODES, genxConservativeGate, type Mode } from "@/lib/genxCompute";
import { sendTelegram } from "@/lib/telegram";
import { beat } from "@/lib/flow/health";
import { inWeekendCloseWindow, inScanQuietWindow } from "@/lib/flow/autoExec";
import { PAIRS, PAIR_KEYS, type FxPair, type PairKey } from "@/lib/genfx/pairs";
import { computeGenfxRead, genfxOf, stopRoom } from "@/lib/genfx/compute";
import { confirmFxEntry } from "@/lib/genfx/confirm";
import { decideFxEntry, sameSetupZone, scanKey, zoneKey, zoneOf, zoneAction, zoneBand, gradeCall, lastReopenMs, ZONE_TTL_MS, FORMING_TTL_MS, GRADE_EXPIRY_MS, type GradeCandle } from "@/lib/genfx/decide";
import { readControl, minStopPips, type GenfxControl } from "@/lib/genfx/control";
import { headsUpMsg, enterMsg, invalidMsg, winMsg } from "@/lib/genfx/messages";
import { placeGenfx, armedAccounts } from "@/lib/genfx/place";
import { billFxSetup } from "@/lib/genfx/billing";
import { fxSeries, pairPrice, utcMs, candleFloorMs, settledCloseMs, withTimeout, type SeriesOut } from "@/lib/genfx/market";
import { can } from "@/lib/flow/permissions";

/**
 * GEN FX SCANNER — GENX's automated scanner (api/cron/genx-scan), for two pairs.
 *
 * Every five minutes it runs the same engine the GEN FX page runs, across both pairs and all three
 * horizons, and for each read:
 *   1. registers the setup the page is showing as a "zone" (entered on touch by the fast watch),
 *   2. records a brand-new scanner setup — ENTER NOW if the engine says trade-ready, otherwise a
 *      heads-up that then waits for a closed-candle confirmation,
 *   3. re-checks its own pending setups: enter, arm for a pullback, invalidate, or keep waiting,
 *   4. grades the calls it has already made against the candles that printed afterwards.
 *
 * State lives in public.genfx_alerts. A row is written BEFORE anything is announced or placed, under
 * a unique key, and every change of state is a conditional update that reports whether THIS process
 * won it — so the scan and the fast watch can overlap and a call is still announced once and placed
 * once.
 *
 * ONE SETUP, ONE CALL. The engine re-derives every zone every five minutes and it drifts by a pip or
 * two, which changes its key. While a call on a pair, horizon and side is still open — pending, or
 * entered and not yet graded — a zone that is the same setup (decide.sameSetupZone) is that call, not
 * a new one. GENX applies this to Quick only, inside four hours; here it holds for every horizon for
 * as long as the earlier call is open, because a record that counts one idea three times says more
 * about the rounding than about the idea. The same goes for PAGE setups: a level a fraction of a pip
 * from one that has been entered and is still running is that trade, not a second one.
 *
 * A SETUP THAT IS ALREADY DEAD IS NOT A CALL. A new setup's confirmation is read before anything is
 * recorded; if a candle has already closed through its invalidation, nothing is written, announced or
 * billed — it is read again next scan. One that is recorded is acted on at once, on the candle that
 * has just closed, rather than waiting for the watch to come round.
 *
 * A SETUP THAT COMES STRAIGHT BACK IS NOT A NEW HEADS-UP. A setup let go — its five minutes ran out, a
 * candle closed through it — is often read again a scan or two later, a pip away, and may then be a
 * perfectly good trade; it is recorded and traded like any other. But it is the same idea the members
 * were told about minutes ago: it is not announced as forming a second time, and it carries the first
 * one's fee key, so a member who paid for that heads-up does not pay for it again (RECALL_WINDOW_MS).
 *
 * AN ARMED SETUP IS THE WATCH'S. Once a setup has confirmed and is waiting for price to come back,
 * taking it is a decision about a price, and the watch makes it on two observations. The scan only
 * ends such a setup — a candle closed through it, or its five minutes are up — and never enters it.
 *
 * What is not here, because it is not GENX's core but gold-only strategies bolted beside it, each
 * tuned on gold history alone: the sideways-market range fade, the PDH/PDL break-and-retest, the
 * breakdown retest and the owner's hand-drawn levels.
 */
type Admin = NonNullable<ReturnType<typeof createAdminClient>>;

export type FxAlert = {
  id: string; pair: PairKey; dedupe_key: string; mode: Mode; side: "buy" | "sell"; action: string;
  entry: number | null; entry_low: number | null; entry_high: number | null;
  stop: number | null; tp1: number | null; tp2: number | null; tp3: number | null;
  invalidation: number | null; watch: number | null; confidence: number | null;
  trigger_tf: string | null; state: string; created_at: string; last_checked_at: string | null;
  quality_ok: boolean | null; enter_sent_at: string | null; enter_price: number | null;
  /** The key its setup fee is billed under: its own, or the key of the setup it is a return of. */
  fee_key?: string | null; updated_at?: string;
};

const MODES_ORDER: Mode[] = ["quick", "intraday", "swing"];
const tgEnv = () => !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHANNEL_ID);
/** A note is waited on for four seconds and no longer: where one comes before an order, a messaging service that hangs must not hold the order. */
const say = async (ctl: GenfxControl, html: string) => { if (ctl.telegram && tgEnv()) { try { await withTimeout(sendTelegram(html), 4_000); } catch { /* a note never blocks a call */ } } };
export const isQuiet = (d: Date = new Date()): boolean => inWeekendCloseWindow(d) || inScanQuietWindow(d);
/** Was `a` recorded before `b`? Of two rows that are the same setup, the earlier is the call and the later is retired. */
export const isOlder = (a: { id: string; created_at: string }, b: { id: string; created_at: string }): boolean => {
  const ta = Date.parse(a.created_at), tb = Date.parse(b.created_at);
  return ta < tb || (ta === tb && a.id < b.id);
};

/**
 * An open scanner call on this pair, horizon and side that is the same setup as this zone — still
 * pending, or entered and not yet graded. THROWS when the table cannot be read: the caller must not
 * take "could not check" for "there is none".
 */
export async function findSameSetup(admin: Admin, pair: FxPair, mode: Mode, z: { side: "buy" | "sell"; entry_low: number | null; entry_high: number | null }, excludeId?: string): Promise<FxAlert | null> {
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const { data, error } = await admin.from("genfx_alerts").select("*").eq("pair", pair.key).eq("mode", mode).eq("side", z.side)
    .in("state", ["forming", "entered"]).is("outcome", null).not("dedupe_key", "like", "zone:%")
    .gte("created_at", since).order("created_at", { ascending: true }).limit(200);
  if (error) throw new Error("alerts_unreadable");
  for (const r of (data ?? []) as FxAlert[]) if (r.id !== excludeId && sameSetupZone(pair, r, z)) return r;
  return null;
}

/** A scanner setup let go no longer ago than this, and read again as the same setup, is that setup come back — not a new heads-up. */
export const RECALL_WINDOW_MS = 30 * 60_000;

/**
 * The scanner setup on this pair, horizon and side that was LET GO in the last half hour and is the same
 * setup as this zone, if there is one — the newest. Null when there is none, or the table cannot be read
 * (then the setup is simply treated as new: a heads-up too many, never a call missed).
 */
export async function findRecall(admin: Admin, pair: FxPair, mode: Mode, z: { side: "buy" | "sell"; entry_low: number | null; entry_high: number | null }, nowMs = Date.now()): Promise<FxAlert | null> {
  try {
    const { data, error } = await admin.from("genfx_alerts").select("*").eq("pair", pair.key).eq("mode", mode).eq("side", z.side)
      .in("state", ["invalidated", "expired"]).not("dedupe_key", "like", "zone:%")
      .gte("updated_at", new Date(nowMs - RECALL_WINDOW_MS).toISOString()).order("updated_at", { ascending: false }).limit(50);
    if (error) return null;
    return ((data ?? []) as FxAlert[]).find((r) => sameSetupZone(pair, r, z)) ?? null;
  } catch { return null; }
}

/**
 * Register the page setup this horizon is showing. A newer one on the same pair, horizon and side
 * replaces the older (GENX's rule). Beyond that, a setup's row follows what the page shows:
 *
 *   • still showing            → its levels and its "last shown" time are refreshed;
 *   • shown again the same day → a row that was replaced or timed out comes back, with today's levels
 *                                (the key is unique, so without this a setup the page returns to
 *                                could never be watched again that day);
 *   • entered or broken today  → it stays used. Not offered twice at one level in a day — and not
 *                                again just because the date rolled over a few hours later.
 * Never throws.
 */
export async function registerZone(admin: Admin, pair: FxPair, mode: Mode, g: { action?: unknown; entry?: unknown; stop_loss?: unknown; tp1?: unknown; tp2?: unknown; tp3?: unknown; confidence_score?: unknown; trigger_tf?: unknown }, price: number | null, nowMs = Date.now()): Promise<string> {
  try {
    const z = zoneOf(g);
    if (!z) return "no_setup";
    if (price != null && zoneAction(pair, z.side, z.entry, z.stop, price) === "invalidate") return "beyond_stop";
    const key = zoneKey(pair, mode, z.side, z.entry, nowMs);
    const nowIso = new Date(nowMs).toISOString();
    await admin.from("genfx_alerts").update({ state: "replaced", updated_at: nowIso })
      .eq("state", "zone").eq("pair", pair.key).eq("mode", mode).eq("side", z.side).neq("dedupe_key", key);
    const band = zoneBand(pair, z.entry);
    const conf = typeof g.confidence_score === "number" && Number.isFinite(g.confidence_score) ? g.confidence_score : null;
    const levels = {
      action: String(g.action), entry: z.entry, entry_low: band.low, entry_high: band.high,
      stop: z.stop, tp1: z.tp1, tp2: z.tp2, tp3: z.tp3, invalidation: z.stop, watch: z.entry,
      confidence: conf, trigger_tf: g.trigger_tf != null ? String(g.trigger_tf) : null,
    };

    // The same setup as a page setup that has been entered and is still running: it is that call.
    const running = await admin.from("genfx_alerts").select("dedupe_key, side, entry_low, entry_high")
      .eq("pair", pair.key).eq("mode", mode).eq("side", z.side).eq("state", "entered").is("outcome", null).like("dedupe_key", "zone:%")
      .order("created_at", { ascending: false }).limit(50);
    if (running.error) return "error";
    const twin = ((running.data ?? []) as { dedupe_key: string; side: "buy" | "sell"; entry_low: number | null; entry_high: number | null }[])
      .find((r) => r.dedupe_key !== key && sameSetupZone(pair, r, { side: z.side, entry_low: band.low, entry_high: band.high }));
    if (twin) return `used:running:${twin.dedupe_key}`;

    const have = await admin.from("genfx_alerts").select("id, state").eq("dedupe_key", key).maybeSingle();
    if (have.error) return "error";
    const row = have.data as { id: string; state: string } | null;
    if (row) {
      if (row.state === "zone") {
        const { error } = await admin.from("genfx_alerts").update({ ...levels, last_checked_at: nowIso, updated_at: nowIso }).eq("id", row.id).eq("state", "zone");
        return error ? "error" : "refreshed";
      }
      if (row.state === "replaced" || row.state === "expired") {
        const { data: won, error } = await admin.from("genfx_alerts").update({ ...levels, state: "zone", last_checked_at: nowIso, updated_at: nowIso })
          .eq("id", row.id).in("state", ["replaced", "expired"]).select("id");
        return error ? "error" : won?.length ? "revived" : "handled_elsewhere";
      }
      return `used:${row.state}`;
    }

    // The same level under yesterday's key, entered or broken within the last twelve hours — counted
    // from when it was ENTERED (grading the call later rewrites the row and must not restart the clock).
    const prev = await admin.from("genfx_alerts").select("state, updated_at, enter_sent_at").eq("dedupe_key", zoneKey(pair, mode, z.side, z.entry, nowMs - 86_400_000)).maybeSingle();
    if (prev.error) return "error";
    const p = prev.data as { state: string; updated_at: string; enter_sent_at: string | null } | null;
    const usedAt = p ? Date.parse(p.state === "entered" ? p.enter_sent_at ?? p.updated_at : p.updated_at) : NaN;
    if (p && (p.state === "entered" || p.state === "invalidated") && nowMs - usedAt < ZONE_TTL_MS) return `used_yesterday:${p.state}`;

    const { error } = await admin.from("genfx_alerts").insert({ pair: pair.key, dedupe_key: key, mode, side: z.side, ...levels, state: "zone", last_checked_at: nowIso, quality_ok: true });
    return error ? "already_registered" : "registered";
  } catch { return "error"; }
}

/**
 * Members a forming setup is billed to when billing is on: armed for this pair, in scope — and with at
 * least one account an order could actually be placed on (not kill-switched, entries allowed).
 */
async function armedUserIds(admin: Admin, pair: FxPair, ctl: GenfxControl): Promise<string[]> {
  const reachable = ((await armedAccounts(admin, pair, ctl)) ?? []).filter((a) => !!a.acc_num &&
    can({ account_id: String(a.account_id), autotrade_enabled: true, permissions: a.permissions, kill_switch_at: a.kill_switch_at }, "allow_entries").allowed);
  return [...new Set(reachable.map((a) => String(a.user_id)))];
}

/**
 * Act on a pending (forming) alert given what its confirmation says and where price is. Shared by the
 * scan, the fast watch's candle read, and the fast watch's price-only look at an armed setup.
 * Returns what happened, or null when another process got there first.
 */
export async function actOnForming(admin: Admin, ctl: GenfxControl, pair: FxPair, row: FxAlert, confState: string, lp: number | null, enterPx: number | null, deps: { place?: typeof placeGenfx; nowMs?: number } = {}): Promise<string | null> {
  const nowMs = deps.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const armedNow = !!row.enter_sent_at;
  const armedAtMs = row.enter_sent_at ? new Date(row.enter_sent_at).getTime() : nowMs;
  const act = decideFxEntry(pair, { armed: armedNow, confState, lp, entryLow: row.entry_low, entryHigh: row.entry_high, stop: row.stop, tp1: row.tp1, armedAtMs, nowMs });

  if (act.do === "arm") {
    // Chased on the first confirmation: announce once, stay pending, wait five minutes for the pullback.
    const { data: won } = await admin.from("genfx_alerts").update({ enter_sent_at: nowIso, last_checked_at: nowIso, updated_at: nowIso })
      .eq("id", row.id).eq("state", "forming").is("enter_sent_at", null).select("id");
    if (!won?.length) return null;
    await say(ctl, enterMsg(pair, row.mode));
    return `arm:${act.reason}`;
  }
  if (act.do === "enter") {
    const { data: won } = await admin.from("genfx_alerts").update({ state: "entered", enter_price: enterPx ?? lp, enter_sent_at: nowIso, last_checked_at: nowIso, updated_at: nowIso })
      .eq("id", row.id).eq("state", "forming").select("id");
    if (!won?.length) return null;
    if (!armedNow) await say(ctl, enterMsg(pair, row.mode));
    try { await (deps.place ?? placeGenfx)({ pair: pair.key, signalKey: row.dedupe_key, side: row.side, mode: row.mode, entryLow: row.entry_low, entryHigh: row.entry_high, stop: row.stop, tp: row.tp1, setup: "scanner", confidence: row.confidence, alertId: row.id }); } catch { /* placement is best-effort */ }
    return `enter:${act.reason}`;
  }
  if (act.do === "invalidate") {
    const { data: won } = await admin.from("genfx_alerts").update({ state: "invalidated", last_checked_at: nowIso, updated_at: nowIso })
      .eq("id", row.id).eq("state", "forming").select("id");
    if (!won?.length) return null;
    await say(ctl, invalidMsg(pair, row.mode));
    return `invalid:${act.reason}`;
  }
  return act.reason;
}

/** Read a pending alert's confirmation fresh, then act on it. */
export async function stepForming(admin: Admin, ctl: GenfxControl, pair: FxPair, row: FxAlert, mdKey: string, deps: { place?: typeof placeGenfx; confirm?: typeof confirmFxEntry; nowMs?: number } = {}): Promise<string | null> {
  const conf = await (deps.confirm ?? confirmFxEntry)({
    pair, side: row.side, entryLow: (row.entry_low ?? 0) as number, entryHigh: (row.entry_high ?? 0) as number,
    watch: (row.watch ?? row.entry_low ?? 0) as number, invalidation: (row.invalidation ?? row.stop ?? 0) as number,
    mode: row.mode, mdKey, fresh: true, desk: true,
  });
  const res = await actOnForming(admin, ctl, pair, row, conf.state, conf.price ?? conf.enter, conf.enter ?? conf.price, deps);
  // "Last checked" is when its confirmation was last READ — the watch takes from it whether this candle's
  // momentum question has been asked (watch.ts). A read that could not be made is not one.
  if (res && !/^(enter|arm|invalid)/.test(res) && conf.state !== "NO_DATA" && conf.state !== "BUSY") {
    const nowIso = new Date(deps.nowMs ?? Date.now()).toISOString();
    await admin.from("genfx_alerts").update({ last_checked_at: nowIso, updated_at: nowIso }).eq("id", row.id).eq("state", "forming");
  }
  return res;
}

type Entered = { id: string; pair: PairKey; mode: Mode; side: "buy" | "sell"; entry: number | null; entry_low: number | null; entry_high: number | null; stop: number | null; tp1: number | null; enter_price: number | null; enter_sent_at: string | null };
const GRADE_IV_MS = 5 * 60_000;

/**
 * Grade calls already entered against the 5-minute candles since (decide.gradeCall). The candles are
 * asked for in UTC and matched to the entry by TIME — never by counting back from the newest one,
 * which over a weekend reaches candles from before the call was made. One request per pair, whatever
 * the horizon: five-minute candles keep the "entry candle" doubt to five minutes for a Swing call too.
 */
export async function gradeEntered(admin: Admin, ctl: GenfxControl, deps: { nowMs?: number; candles?: (pair: FxPair, nowMs: number) => Promise<{ datetime: string; high: string; low: string }[] | "ratelimit" | null> } = {}): Promise<number> {
  let graded = 0;
  const nowMs = deps.nowMs ?? Date.now(), nowIso = new Date(nowMs).toISOString();
  // Only candles the feed has had time to finish are read as closed (the last close, as it stood eight seconds ago).
  const closedBy = settledCloseMs(nowMs);
  const { data: openRows, error } = await admin.from("genfx_alerts")
    .select("id, pair, mode, side, entry, entry_low, entry_high, stop, tp1, enter_price, enter_sent_at")
    .eq("state", "entered").is("outcome", null).order("enter_sent_at", { ascending: true }).limit(200);
  if (error) return 0;
  const rows = (openRows ?? []) as Entered[];
  for (const key of PAIR_KEYS) {
    const mine = rows.filter((r) => r.pair === key);
    if (!mine.length) continue;
    const pair = PAIRS[key];
    // Fetched after the last close the feed has had time to finish — never a copy from before it.
    const raw = deps.candles ? await deps.candles(pair, nowMs) : await fxSeries(pair.td, "5min", 1500, { utc: true, maxAgeMs: 30_000, notBeforeMs: candleFloorMs(nowMs) });
    if (!Array.isArray(raw) || raw.length < 2) continue;
    const candles: GradeCandle[] = raw.map((c) => ({ t: utcMs(c.datetime), h: +c.high, l: +c.low })).filter((c) => Number.isFinite(c.t) && Number.isFinite(c.h) && Number.isFinite(c.l));
    if (!candles.length) continue;
    const oldest = Math.min(...candles.map((c) => c.t));
    const newest = Math.max(...candles.map((c) => c.t));
    for (const a of mine) {
      const tp1 = Number(a.tp1), stop = Number(a.stop);
      const enterMs = a.enter_sent_at ? Date.parse(a.enter_sent_at) : NaN;
      // A call with no target, no stop or no entry time cannot be graded, now or ever. It is closed with
      // no result rather than left open — an open call is what the one-setup-one-call rule looks for.
      if (a.tp1 == null || a.stop == null || !Number.isFinite(tp1) || !Number.isFinite(stop) || !Number.isFinite(enterMs)) {
        await admin.from("genfx_alerts").update({ outcome: "expired", resolved_at: nowIso, updated_at: nowIso }).eq("id", a.id).is("outcome", null);
        continue;
      }
      // The candles on hand must reach back to the entry, or the first of them might already be past the result.
      const covered = oldest <= enterMs;
      const expiry = GRADE_EXPIRY_MS[a.mode] ?? GRADE_EXPIRY_MS.quick;
      // Closed candles only, and only those inside the call's own window: a target that printed after
      // the call had run out of time is not a win just because nobody graded it sooner.
      const g = covered ? gradeCall({ side: a.side, stop, tp1, enterMs }, candles, GRADE_IV_MS, { closedByMs: closedBy, untilMs: enterMs + expiry }) : null;
      if (!g) {
        // Out of time — but only once the LAST candle of its window has closed and been read. The window's
        // last candle starts before the deadline and closes up to five minutes after it; a scan that runs
        // in between would call "expired" a call whose target is being hit as it looks. (Where the candles
        // no longer reach back to the entry there is nothing more to wait for.)
        const lastStart = Math.floor((enterMs + expiry - 1) / GRADE_IV_MS) * GRADE_IV_MS;
        const windowRead = closedBy >= lastStart + GRADE_IV_MS && newest >= lastStart;
        if (nowMs - enterMs > expiry && (!covered || windowRead)) await admin.from("genfx_alerts").update({ outcome: "expired", resolved_at: nowIso, updated_at: nowIso }).eq("id", a.id).is("outcome", null);
        continue;
      }
      const ref = Number(a.enter_price ?? a.entry ?? ((Number(a.entry_low) + Number(a.entry_high)) / 2));
      const pips = Math.round(Math.abs(ref - (g.result === "win" ? tp1 : stop)) / pair.pip) * (g.result === "win" ? 1 : -1);
      const { data: won } = await admin.from("genfx_alerts").update({ outcome: g.result, result_pips: pips, resolved_at: nowIso, updated_at: nowIso, win_posted_at: g.result === "win" ? nowIso : null })
        .eq("id", a.id).is("outcome", null).select("id");
      if (!won?.length) continue;
      graded += 1;
      if (g.result === "win") await say(ctl, winMsg(pair, a.side, a.mode, { entry_low: a.entry_low, entry_high: a.entry_high, tp1: a.tp1 }, pips));
    }
  }
  return graded;
}

/** What the scanner made of one read: why it was passed over, or what became of its setup. */
export type StepOut = { skip?: string; dedupe?: string; quality_ok?: boolean; result?: string; placed?: unknown; billed?: unknown };

/**
 * ONE READ, ACTED ON. Given what the engine says about a pair and a horizon right now: record a new
 * scanner setup (entered at once when the engine says trade-ready; otherwise a heads-up, stepped on the
 * spot), or take the next step with the one already on record. The page setup the same read shows is
 * registered before this is called. The scan's loop is this, once per pair and horizon; it is its own
 * function so that it can be run on a read a test wrote.
 */
export async function scannerStep(admin: Admin, ctl: GenfxControl, pair: FxPair, mode: Mode, g: ReturnType<typeof genfxOf>, price: number | null, mdKey: string, o: { nowMs?: number; confirm?: typeof confirmFxEntry; place?: typeof placeGenfx } = {}): Promise<StepOut> {
  const nowMs = o.nowMs ?? Date.now(), nowIso = new Date(nowMs).toISOString();
  const confirm = o.confirm ?? confirmFxEntry, place = o.place ?? placeGenfx;
  const out: StepOut = {};
  const done = (result: string): StepOut => { out.result = result; return out; };
  const engineState = String(g.engine_state || "");
  const actionable = engineState === "TRADE_READY" || engineState === "DEVELOPING_SETUP";
  if (!actionable || g.entry_low == null || g.entry_high == null || g.stop_loss == null) { return { skip: "not_actionable" }; }

  const side: "buy" | "sell" = String(g.action).includes("SELL") ? "sell" : "buy";
  const watch = side === "sell" ? (g.closest_resistance ?? g.entry) : (g.closest_support ?? g.entry);
  const invalidation = g.invalidation_price ?? g.stop_loss;
  const dedupeKey = scanKey(pair, mode, side, g.entry_low, g.entry_high, nowMs);
  out.dedupe = dedupeKey;

  // The conservative confluence verdict is stored with the call, as gold stores it. Since 09-22 it
  // gates nobody (conservative differs by its loss cool-down alone); it is kept as a record.
  const q = genxConservativeGate({ confidence_score: g.confidence_score, momentum: g.momentum, market_structure: g.market_structure, action: g.action, side, entry: g.entry, stop_loss: g.stop_loss, tp1: g.tp1, session: g.session, entry_profile: g.entry_profile });
  out.quality_ok = q.ok;

  const existing = await admin.from("genfx_alerts").select("*").eq("dedupe_key", dedupeKey).maybeSingle();
  if (existing.error) return done("alerts_unreadable");
  const row = existing.data as FxAlert | null;

  if (!row) {
    // Not knowing whether this setup has already been called is not grounds to call it again.
    let twin: FxAlert | null;
    try { twin = await findSameSetup(admin, pair, mode, { side, entry_low: g.entry_low, entry_high: g.entry_high }); } catch { return done("alerts_unreadable"); }
    if (twin) return done(`same_setup:${twin.dedupe_key}:${twin.state}`);
    const levels = { entry: g.entry, entry_low: g.entry_low, entry_high: g.entry_high, stop: g.stop_loss, tp1: g.tp1, tp2: g.tp2, tp3: g.tp3, invalidation, watch, confidence: g.confidence_score, trigger_tf: g.trigger_tf };
    if (engineState === "TRADE_READY") {
      const { data: ins, error } = await admin.from("genfx_alerts").insert({
        pair: pair.key, dedupe_key: dedupeKey, mode, side, action: g.action, ...levels,
        state: "entered", enter_price: price, heads_up_sent_at: nowIso, enter_sent_at: nowIso, last_checked_at: nowIso, quality_ok: q.ok,
      }).select("id").single();
      if (error) return done("already_recorded");
      await say(ctl, enterMsg(pair, mode));
      try { out.placed = await place({ pair: pair.key, signalKey: dedupeKey, side, mode, entryLow: g.entry_low, entryHigh: g.entry_high, stop: g.stop_loss, tp: g.tp1, setup: "scanner", confidence: g.confidence_score, alertId: (ins as { id: string } | null)?.id ?? null }); } catch { /* placement is best-effort */ }
      out.result = "enter_immediate";
    } else {
      // Its confirmation, read once before anything is recorded. Already invalid: not a call.
      let conf: Awaited<ReturnType<typeof confirmFxEntry>> | null = null;
      try {
        conf = await confirm({ pair, side, entryLow: g.entry_low, entryHigh: g.entry_high, watch: (watch ?? g.entry_low) as number, invalidation: (invalidation ?? g.stop_loss) as number, mode, mdKey, fresh: true, desk: true });
      } catch { conf = null; }
      if (conf?.state === "INVALIDATED") return done("not_yet:invalidated");
      // The same setup, let go within the last half hour, come back: recorded and traded like any
      // other — but under the first one's fee key, and without a second heads-up.
      const recall = await findRecall(admin, pair, mode, { side, entry_low: g.entry_low, entry_high: g.entry_high }, nowMs);
      const feeKey = recall ? (recall.fee_key ?? recall.dedupe_key) : dedupeKey;
      const { data: made, error } = await admin.from("genfx_alerts").insert({
        pair: pair.key, dedupe_key: dedupeKey, mode, side, action: g.action, ...levels,
        // "Last checked" is when its confirmation was last READ (the watch asks a candle's momentum
        // question only if it has not been). One that could not be read has not been checked.
        state: "forming", heads_up_sent_at: nowIso, last_checked_at: conf && conf.state !== "NO_DATA" && conf.state !== "BUSY" ? nowIso : null, quality_ok: q.ok, fee_key: feeKey,
      }).select("*").single();
      if (error) return done("already_recorded");
      out.result = recall ? `back:${recall.dedupe_key}` : "headsup";
      // It is stepped at once, on the candle that has just closed and the price that came with it —
      // before anything slower (billing, a message) can make that price old.
      let res: string | null = null;
      if (made && conf && conf.state !== "NO_DATA" && conf.state !== "BUSY") {
        res = await actOnForming(admin, ctl, pair, made as FxAlert, conf.state, conf.price ?? conf.enter, conf.enter ?? conf.price, { place, nowMs });
        if (res && /^(enter|arm|invalid)/.test(res)) out.result = `${out.result}+${res}`;
      }
      if (ctl.billing) {
        // Only a setup auto-trade would actually place is billed, and only to members it can reach.
        const room = stopRoom(pair, g.entry, g.stop_loss, minStopPips(ctl, pair));
        const tradeable = !ctl.auto ? { ok: false, why: "auto_off" } : !room.ok ? { ok: false, why: "stop_under_minimum" } : { ok: true };
        try { out.billed = await billFxSetup(admin, feeKey, tradeable.ok ? await armedUserIds(admin, pair, ctl) : [], tradeable); } catch { /* billing never blocks a call */ }
      }
      // A setup that entered or armed on the spot has announced itself; one that came back was announced the first time.
      if (!recall && !(res && /^(enter|arm)/.test(res))) await say(ctl, headsUpMsg(pair, mode));
    }
    return out;
  }

  if (row.state === "forming") {
    let twin: FxAlert | null = null;
    try { twin = await findSameSetup(admin, pair, mode, row, row.id); } catch { /* cannot check → leave the row as it is */ }
    if (twin && isOlder(twin, row)) {
      await admin.from("genfx_alerts").update({ state: "invalidated", last_checked_at: nowIso, updated_at: nowIso }).eq("id", row.id).eq("state", "forming");
      return done(`merged_into:${twin.dedupe_key}`);
    }
    if (row.enter_sent_at) {
      // ARMED. Whether to take it is a question about a price, and the watch asks it on two
      // observations. Here its candles — or its clock — can only end it: no price is handed over,
      // so nothing can be entered from this read.
      let ended = "ARMED";
      try { const c = await confirm({ pair, side: row.side, entryLow: (row.entry_low ?? 0) as number, entryHigh: (row.entry_high ?? 0) as number, watch: (row.watch ?? row.entry_low ?? 0) as number, invalidation: (row.invalidation ?? row.stop ?? 0) as number, mode: row.mode, mdKey, fresh: true, desk: true }); if (c.state === "INVALIDATED") ended = "INVALIDATED"; } catch { /* unreadable: its clock still runs */ }
      out.result = (await actOnForming(admin, ctl, pair, row, ended, null, null, { place, nowMs })) ?? "handled_elsewhere";
    } else {
      out.result = (await stepForming(admin, ctl, pair, row, mdKey, { place, confirm, nowMs })) ?? "handled_elsewhere";
    }
  } else {
    out.result = `already:${row.state}`;
  }
  return out;
}

export type ScanOut = { ok: boolean; skipped?: string; asOf: string; graded?: number; decisions: Record<string, Record<string, unknown>>; /** What was written to the heartbeat — the worker re-sends it with its liveness beats so they never erase it. */ detail?: Record<string, unknown>; /** A candle read timed out: the rest of the scan asked the feed for nothing more. */ feedDown?: boolean };

/** A candle read in the scan is given this long. One that takes it all is a feed that is not answering. */
export const SCAN_READ_MS = 8_000;

/**
 * THE SCAN'S CANDLE READER. Whoever runs the scan runs the watch after it, on the same loop, and a scan
 * of two pairs and three horizons is some thirty candle reads: with the candle endpoint hanging, each
 * horizon would wait out its own timeout — over a minute in which nobody is looking at price, every
 * five minutes. So the scan asks a feed that is not answering ONCE: the first read to run out of time
 * is the last one made, every read after it answers "no data" at once, and the next scan asks again.
 * A read that fails quickly (an error, a busy feed) is an answer, and stops nothing.
 * Candles are never ones fetched before the candle that has just closed could be in them.
 */
export function scanReader(nowMs: number, series: typeof fxSeries = fxSeries, readMs = SCAN_READ_MS) {
  const feed = { down: false };
  const read = async (pair: FxPair, interval: string, size: number, o: { utc?: boolean; maxAgeMs: number }): Promise<SeriesOut> => {
    if (feed.down) return null;
    const t = Date.now();
    const rows = await series(pair.td, interval, size, { ...o, notBeforeMs: candleFloorMs(nowMs), timeoutMs: readMs });
    if (rows == null && Date.now() - t >= readMs * 0.9) feed.down = true;       // it took (all but) the whole allowance: that was the timeout
    return rows;
  };
  return { read, feed };
}

/** One full scan of both pairs across all three horizons. */
export async function runGenfxScan(admin: Admin, mdKey: string, opts: { worker?: boolean } = {}): Promise<ScanOut> {
  const nowMs = Date.now(), nowIso = new Date(nowMs).toISOString();
  const decisions: Record<string, Record<string, unknown>> = {};
  const ctl = await readControl(admin);
  if (!ctl.readable || !ctl.scan) {
    await beat(admin, "genfx", { tier: "full", worker: !!opts.worker, skipped: ctl.readable ? "scan_off" : "control_unreadable" });
    return { ok: true, skipped: ctl.readable ? "scan_off" : "control_unreadable", asOf: nowIso, decisions };
  }

  // Housekeeping. Pending setups that have waited too long are let go (gold's windows); a page setup
  // lapses twelve hours after it was last shown, and at once if it has not been shown since the
  // market last reopened (decide.lastReopenMs).
  try {
    await admin.from("genfx_alerts").update({ state: "expired", updated_at: nowIso })
      .eq("state", "forming").in("mode", ["quick", "intraday"]).lt("created_at", new Date(nowMs - FORMING_TTL_MS.quick).toISOString());
    await admin.from("genfx_alerts").update({ state: "expired", updated_at: nowIso })
      .eq("state", "forming").eq("mode", "swing").lt("created_at", new Date(nowMs - FORMING_TTL_MS.swing).toISOString());
    const stale = new Date(Math.max(nowMs - ZONE_TTL_MS, lastReopenMs(nowMs, isQuiet))).toISOString();
    await admin.from("genfx_alerts").update({ state: "expired", updated_at: nowIso }).eq("state", "zone").lt("last_checked_at", stale);
  } catch { /* best effort */ }

  // One reader for the horizons, that stops asking a feed that is not answering. Grading has its own:
  // it runs first (a call that has just finished must be out of the way before its setup can be called
  // again, as in the replay) and asks for one long request per pair — which being slow says nothing about
  // the thirty short ones the horizons make.
  const { read, feed } = scanReader(nowMs);
  const grading = scanReader(nowMs);

  let graded = 0;
  try { graded = await gradeEntered(admin, ctl, { candles: (pair) => grading.read(pair, "5min", 1500, { utc: true, maxAgeMs: 30_000 }) }); } catch { /* grading is best effort */ }

  const quiet = isQuiet();

  for (const key of PAIR_KEYS) {
    const pair = PAIRS[key];
    // One reader per pair for the whole scan: the three horizons share every timeframe they have in common.
    // …and never on candles fetched before the candle that has just closed could be in them.
    const source = { series: (interval: string, size: number) => read(pair, interval, size, { maxAgeMs: 20_000 }), price: () => pairPrice(pair) };
    for (const mode of MODES_ORDER) {
      const out: Record<string, unknown> = { at: nowIso };
      decisions[`${key}:${mode}`] = out;
      // Around the daily close and over the weekend nothing is registered and nothing is called, so
      // there is nothing to read the market for — and no reason to spend thirty data requests finding out.
      if (quiet) { out.skip = "scan_quiet_window"; continue; }
      if (feed.down) { out.skip = "feed_not_answering"; continue; }
      try {
        const rr = await computeGenfxRead({ pair, mode, mdKey, fresh: true, source });
        if (!rr.ok) { out.skip = rr.error; continue; }
        const g = genfxOf(pair, rr.read, { mode, price: rr.price, session: rr.session, dataStatus: rr.dataStatus, hold: MODES[mode].hold, triggerTf: MODES[mode].triggerTf, contextTf: MODES[mode].contextTf, marketStory: [], volatility: rr.volatility, atr: rr.atr });
        const engineState = String(g.engine_state || "");
        out.action = g.action; out.state = engineState; out.conf = g.confidence_score; out.price = rr.price;
        out.zone = await registerZone(admin, pair, mode, g, rr.price);

        Object.assign(out, await scannerStep(admin, ctl, pair, mode, g, rr.price, mdKey));
      } catch (e) {
        out.error = e instanceof Error ? e.message.slice(0, 160) : "error";
      }
    }
  }

  // Every decision of the scan, kept in one upserted row: "why didn't it trade?" is answerable afterwards.
  // Either reader timing out is the candle feed not answering: the caller does not grade page reads from it now.
  const feedDown = feed.down || grading.feed.down;
  const detail = { tier: "full", worker: !!opts.worker, at: nowIso, quiet, graded, ...(feedDown ? { feedDown: true } : {}), switches: { scan: ctl.scan, auto: ctl.auto, scope: ctl.scope, billing: ctl.billing, telegram: ctl.telegram }, decisions };
  await beat(admin, "genfx", detail);
  return { ok: true, asOf: nowIso, graded, decisions, detail, ...(feedDown ? { feedDown: true } : {}) };
}
