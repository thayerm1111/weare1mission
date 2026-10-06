import { createAdminClient } from "@/lib/supabase/admin";
import { PAIRS, px, type PairKey } from "@/lib/genfx/pairs";
import { zoneAction, decideFxEntry, lastReopenMs, ZONE_TTL_MS, ARM_MAX_MS, FORMING_TTL_MS } from "@/lib/genfx/decide";
import { readControl, type GenfxControl } from "@/lib/genfx/control";
import { pairQuote, fxSeries, withTimeout, candleFloorMs, type Quote } from "@/lib/genfx/market";
import { livePriceSane } from "@/lib/marketData";
import { type Row } from "@/lib/genxCompute";
import { enterMsg } from "@/lib/genfx/messages";
import { placeGenfx } from "@/lib/genfx/place";
import { confirmFxEntry } from "@/lib/genfx/confirm";
import { findSameSetup, actOnForming, isQuiet, isOlder, type FxAlert } from "@/lib/genfx/scan";
import { settleFills, type SettleOut } from "@/lib/genfx/settle";
import { sendTelegram } from "@/lib/telegram";

/**
 * GEN FX FAST WATCH — GENX's watchTick, for the two pairs.
 *
 * Between full scans, something has to be looking at the market: a page setup is entered when price
 * touches its level, and a pending scanner setup is entered when its candle closes right. One pass
 * does both. The always-on worker runs a pass about once a second; the Vercel cron runs the same pass
 * as a fallback when the worker is not holding the lock.
 *
 * THE LOCK is row 6 of flow_manage_lock (1 is the trade manager, 2 the gold watch, 3–5 other loops).
 * Exactly one process watches GEN FX at a time; a crashed holder's lock simply expires.
 *
 * ONE PRICE DECIDES NOTHING. A setup is entered — and orders go out — on the strength of a number
 * from the feed, and a feed prints a bad number now and then. So a touch, a break of the stop, an
 * armed setup's "it has come back", and a pending setup's "confirmed, and worth taking here" (or
 * "confirmed, but chased") each have to be seen on TWO OBSERVATIONS at least a second apart: two
 * different ticks, or two different quotes. Asking twice is not seeing twice — the same streamed tick
 * is handed back for as long as it is the newest, and a quote is reused for a few seconds — so the rule
 * compares when each price was observed, not when it was asked for. A price more than 1.5% from the
 * recent closes is not believed at all — and neither is any price while there are no recent closes to
 * hold it against. Every price the watch acts on is its own: a pending setup's confirmation is given
 * the watch's quote to read with, it does not fetch one of its own.
 *
 * A CONFIRMATION IS A FACT ABOUT CLOSED CANDLES, with one exception: the "momentum" entry also asks
 * whether price has run too far, and that changes with every tick. Asked every ten seconds it would
 * let a setup in half-way through a candle on wherever price happened to be — which the replay, asking
 * once per close, never does. So momentum is asked once per five-minute candle: on the first read after
 * the close — the scan's, normally, eight seconds in — and not again until the next. "Already read in
 * this candle" is taken from the row itself (when it was last checked), so it holds across a restart and
 * in the fallback, where every minute is a new process.
 *
 * THE WATCH DOES NOT WAIT ON CANDLES TO LOOK AT PRICE. Those recent closes are a reference kept on hand
 * and refreshed in the background; a pass uses whatever it has. A candle request that hangs for twelve
 * seconds must not be twelve seconds in which nobody looks at price — and one that fails must not switch
 * the rule off. The pending setups' own confirmations ARE read from candles, so a pass gives all of them
 * together three seconds; what has not come back by then is read again on the next pass, and everything
 * that is decided on price alone — a touch, an armed setup's pull-back, its five minutes — goes ahead.
 *
 * NOTHING LEFT OVER FROM BEFORE THE MARKET LAST REOPENED IS ACTED ON. A setup registered before the
 * daily close (or before the weekend) describes a market that has since shut and reopened, possibly
 * with a gap. It lapses; if the page still shows it after the reopen, the first scan brings it back
 * with levels read from the market as it is now. An armed setup's five minutes run through the close
 * like any other five minutes: it is let go, not entered at the reopen.
 *
 * AN ARMED SETUP IS LOOKED AT ON EVERY PASS. Once a scanner setup has confirmed but been judged too
 * far gone, it has five minutes to come back to a price worth taking, and "come back" is a matter of
 * price, not of candles — so that is checked on the live price every pass, while its candles (which
 * can only invalidate it) are still read every ten seconds.
 */
type Admin = NonNullable<ReturnType<typeof createAdminClient>>;
const LOCK_ID = 6;

export async function acquireFxLock(admin: Admin, holder: string, ttlMs = 15_000): Promise<boolean> {
  const { data } = await admin.from("flow_manage_lock").update({ holder, expires_at: new Date(Date.now() + ttlMs).toISOString() })
    .eq("id", LOCK_ID).lt("expires_at", new Date().toISOString()).select("id");
  return Array.isArray(data) && data.length > 0;
}
/** Extends the lock and reports whether `holder` still owns it. False: stop acting and re-acquire. */
export async function extendFxLock(admin: Admin, holder: string, ttlMs = 15_000): Promise<boolean> {
  const { data } = await admin.from("flow_manage_lock").update({ expires_at: new Date(Date.now() + ttlMs).toISOString() }).eq("id", LOCK_ID).eq("holder", holder).select("id");
  return Array.isArray(data) && data.length > 0;
}
export async function releaseFxLock(admin: Admin, holder: string): Promise<void> {
  await admin.from("flow_manage_lock").update({ expires_at: new Date().toISOString() }).eq("id", LOCK_ID).eq("holder", holder);
}

/** A pending setup's confirmation changes when a candle closes; re-reading it every second buys nothing. (A read that says "enter" or "arm" is the exception: it is looked at again on the next pass, for its second observation.) */
const CONFIRM_EVERY_MS = 10_000;
/** All the candle reads of one pass together may hold it up this long, and no longer. */
const CONFIRM_BUDGET_MS = 3_000;
const lastConfirm = new Map<string, number>();
/** A candle read that ran a pass's allowance out: the feed is not answering, and no pass asks it again before this. */
const confirmHold = { until: 0 };

/** How long an entry waits for its Telegram note before the order goes out without it. */
export const NOTE_WAIT_MS = 4_000;
/** The second observation must be at least this much later than the first… */
export const TOUCH_CONFIRM_MS = 1_000;
/** …and a first observation older than this is not "the look before" any more: the second look has to follow the first, not turn up half a minute later. */
export const TOUCH_STALE_MS = 8_000;
const touchSeen = new Map<string, number>();

/**
 * Has this now been seen on two observations? `observedAt` is when the PRICE was observed (market.Quote),
 * not when this was called: the first sighting is recorded and answers false; the same observation
 * asked about again answers false; a later observation — a second or more after the first, and inside
 * the window — answers true. `seeing: false` forgets it. Pure given the map.
 */
export function touchConfirmed(seen: Map<string, number>, id: string, seeing: boolean, observedAt: number): boolean {
  if (!seeing) { seen.delete(id); return false; }
  const first = seen.get(id);
  if (first == null || observedAt - first > TOUCH_STALE_MS) { seen.set(id, observedAt); return false; }
  if (observedAt - first < TOUCH_CONFIRM_MS) return false;
  seen.delete(id);
  return true;
}

let reopenMemo: { slot: number; at: number } | null = null;
/** When entries last reopened, worked out once per five-minute slot. */
function reopenedAt(nowMs: number): number {
  const slot = Math.floor(nowMs / 300_000);
  if (!reopenMemo || reopenMemo.slot !== slot) reopenMemo = { slot, at: lastReopenMs(nowMs, isQuiet) };
  return reopenMemo.at;
}

/** What a pass asks of the market, and what it does with a call. The desk's own are the defaults; the tests hand in theirs. */
export type WatchDeps = {
  /** The pair's price with its observation time, already sanity-checked; null when there is none to believe. */
  quote?: (pair: PairKey) => Promise<Quote | null>;
  confirm?: typeof confirmFxEntry;
  place?: typeof placeGenfx;
  quiet?: (d: Date) => boolean;
  now?: () => number;
  /** How long all of a pass's candle reads together may hold it up (default three seconds). */
  confirmBudgetMs?: number;
};

/** The recent five-minute closes a price is held against, per pair: the last good read, and when it was made. */
const sanityRef = new Map<PairKey, { rows: Row[]; at: number }>();
const sanityTried = new Map<PairKey, number>();
/** A reference this old is refreshed (in the background)… */
const REF_REFRESH_MS = 60_000;
/** …a refresh that failed is not tried again sooner than this… */
const REF_RETRY_MS = 10_000;
/** …and with no good reference for this long there is nothing to believe a price against: the watch decides nothing. */
export const REF_MAX_AGE_MS = 10 * 60_000;

/** Start a refresh of a pair's reference if one is due. Never awaited by a pass; never throws. */
function refreshSanityRef(k: PairKey, nowMs: number, read: (k: PairKey) => Promise<Row[] | "ratelimit" | null>): void {
  const have = sanityRef.get(k);
  if (have && nowMs - have.at < REF_REFRESH_MS) return;
  if (nowMs - (sanityTried.get(k) ?? 0) < REF_RETRY_MS) return;          // a miss is remembered: one request every ten seconds, not one a pass
  sanityTried.set(k, nowMs);
  const started = Date.now();
  // Stamped with when it ARRIVED, on the caller's clock: a read that took eight seconds is eight seconds newer than its request.
  void read(k).then((rows) => { if (Array.isArray(rows) && rows.length >= 3) sanityRef.set(k, { rows, at: nowMs + (Date.now() - started) }); }).catch(() => { /* the old reference stands until it is too old */ });
}

/**
 * Is this quote to be believed? Only against a reference: within 1.5% of the median of the recent closes
 * (the scanner's own sanity rule). No reference, or one too old to mean anything: no. Pure given the map.
 */
export function believable(q: Quote | null, ref: { rows: Row[]; at: number } | undefined, nowMs: number): Quote | null {
  if (!q || !ref || nowMs - ref.at > REF_MAX_AGE_MS) return null;
  const s = livePriceSane(q.px, ref.rows);
  return s.ok && s.deviationPct != null ? q : null;
}

/** The desk's price for the watch: the newest quote, believed only if it is in sight of the recent five-minute closes. It waits for the quote and for nothing else. */
async function deskQuote(k: PairKey): Promise<Quote | null> {
  const now = Date.now();
  // (A copy the scanner fetched in the last few seconds is shared; a request still hanging from the last try is not joined, and is given up on before the next one.)
  refreshSanityRef(k, now, (key) => fxSeries(PAIRS[key].td, "5min", 150, { maxAgeMs: 5_000, timeoutMs: 8_000 }));
  return believable(await pairQuote(PAIRS[k]), sanityRef.get(k), now);
}
/** For the tests: the reference bookkeeping, driven by hand — and the pass's own memory, to start from nothing. */
export const _sanity = { ref: sanityRef, tried: sanityTried, refresh: refreshSanityRef, hold: confirmHold, forget: () => { touchSeen.clear(); lastConfirm.clear(); confirmHold.until = 0; } };

/** One pass: page setups on touch, then pending scanner setups. Never throws. */
export async function genfxWatchPass(admin: Admin, mdKey: string, ctlIn?: GenfxControl, deps: WatchDeps = {}): Promise<{ zones: number; forming: number; sent: string[] }> {
  const sent: string[] = [];
  const ctl = ctlIn ?? (await readControl(admin));
  if (!ctl.readable || !ctl.scan) return { zones: 0, forming: 0, sent };
  const quiet = deps.quiet ?? isQuiet;
  const nowMs = (deps.now ?? Date.now)();
  if (quiet(new Date(nowMs))) return { zones: 0, forming: 0, sent };
  const confirm = deps.confirm ?? confirmFxEntry;
  const place = deps.place ?? placeGenfx;
  const nowIso = new Date(nowMs).toISOString();
  const tg = ctl.telegram && !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHANNEL_ID);

  let rows: FxAlert[] = [];
  try {
    const { data, error } = await admin.from("genfx_alerts").select("*").in("state", ["zone", "forming"]).limit(500);
    if (error) return { zones: 0, forming: 0, sent };
    rows = ((data ?? []) as FxAlert[]).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  } catch { return { zones: 0, forming: 0, sent }; }
  const zones = rows.filter((r) => r.state === "zone");
  const forming = rows.filter((r) => r.state === "forming");
  if (touchSeen.size > 1500) touchSeen.clear();
  if (lastConfirm.size > 500) lastConfirm.clear();

  // One price per pair per pass, with when it was observed.
  const live = new Map<PairKey, Promise<Quote | null>>();
  const quoteOf = (k: PairKey): Promise<Quote | null> => {
    let p = live.get(k);
    if (!p) { p = (deps.quote ?? deskQuote)(k).catch(() => null); live.set(k, p); }
    return p;
  };

  // ── PAGE SETUPS: entered when price touches the entry the page is showing ──
  const reopened = deps.quiet ? lastReopenMs(nowMs, quiet) : reopenedAt(nowMs);
  for (const r of zones) {
    try {
      const pair = PAIRS[r.pair];
      if (!pair) continue;
      const shown = Date.parse(r.last_checked_at ?? r.created_at);
      if (nowMs - shown > ZONE_TTL_MS || shown < reopened) {
        await admin.from("genfx_alerts").update({ state: "expired", updated_at: nowIso }).eq("id", r.id).eq("state", "zone");
        touchSeen.delete(r.id);
        continue;
      }
      const q = await quoteOf(r.pair);
      if (!q) continue;
      const lp = q.px;
      const act = zoneAction(pair, r.side, Number(r.entry), Number(r.stop), lp);
      // Through the stop — on two observations. One bad print must not retire a setup for the day.
      if (touchConfirmed(touchSeen, `break:${r.id}`, act === "invalidate", q.at)) {
        touchSeen.delete(r.id);
        await admin.from("genfx_alerts").update({ state: "invalidated", last_checked_at: nowIso, updated_at: nowIso }).eq("id", r.id).eq("state", "zone");
        sent.push(`${r.pair}:${r.mode}:ZONE_INVALID`);
        continue;
      }
      if (!touchConfirmed(touchSeen, r.id, act === "enter", q.at)) continue;
      // Move the row forward FIRST, conditionally — two watchers can never both place it.
      const { data: won } = await admin.from("genfx_alerts")
        .update({ state: "entered", enter_price: lp, enter_sent_at: nowIso, last_checked_at: nowIso, updated_at: nowIso })
        .eq("id", r.id).eq("state", "zone").select("id");
      if (!won?.length) continue;
      // The note is not waited on for long: the order is next, and a messaging service that hangs must not hold it.
      if (tg) { try { await withTimeout(sendTelegram(enterMsg(pair, r.side, r.mode, { entry_low: r.entry_low, entry_high: r.entry_high, stop: r.stop, tp1: r.tp1, tp2: r.tp2, tp3: r.tp3 }, lp, true)), NOTE_WAIT_MS); } catch { /* note best-effort */ } }
      try { await place({ pair: r.pair, signalKey: r.dedupe_key, side: r.side, mode: r.mode, entryLow: r.entry_low, entryHigh: r.entry_high, stop: r.stop, tp: r.tp1, setup: "zone", confidence: r.confidence, alertId: r.id }); } catch { /* placement best-effort */ }
      sent.push(`${r.pair}:${r.mode}:ZONE_ENTER`);
    } catch { /* per-row best effort */ }
  }

  // ── PENDING SCANNER SETUPS: enter, arm, invalidate or keep waiting ──
  // A confirmation is a read of candles. The pass waits for them inside one shared allowance; a read
  // that has not come back is simply not acted on (nothing is done late, behind the pass's back).
  const confirmBudget = deps.confirmBudgetMs ?? CONFIRM_BUDGET_MS;
  let confirmLeft = confirmBudget;
  type Conf = Awaited<ReturnType<typeof confirmFxEntry>>;
  /** `live`: the price the confirmation reads with — the watch's own, or null for none (an armed setup's candles are read only to see whether they end it). */
  const readConfirm = async (row: FxAlert, pair: (typeof PAIRS)[PairKey], o: { live: number | null; noMomentum: boolean }): Promise<Conf | null> => {
    if (confirmLeft <= 0 || nowMs < confirmHold.until) return null;
    const t = Date.now();
    try {
      const got = await withTimeout(confirm({
        pair, side: row.side, entryLow: (row.entry_low ?? 0) as number, entryHigh: (row.entry_high ?? 0) as number,
        watch: (row.watch ?? row.entry_low ?? 0) as number, invalidation: (row.invalidation ?? row.stop ?? 0) as number,
        mode: row.mode, mdKey, fresh: true, desk: true, live: o.live, noMomentum: o.noMomentum,
      }), confirmLeft);
      // It ran the allowance out: no other read is started this pass. And if this ONE read took (all but)
      // a whole allowance by itself, the feed is not answering: no pass asks again for ten seconds — it
      // would otherwise cost every pass its three seconds, and passes that far apart cannot see a touch
      // twice. A read that was merely the one running when several slowish reads had used the allowance
      // up says nothing of the kind: the rows it did not reach are read first on the next pass.
      if (!got) { confirmLeft = 0; if (Date.now() - t >= 0.8 * confirmBudget) confirmHold.until = nowMs + CONFIRM_EVERY_MS; }
      return got;
    } catch { return null; } finally { confirmLeft -= Date.now() - t; }
  };
  const floor = candleFloorMs(nowMs);
  for (const row of forming) {
    try {
      const pair = PAIRS[row.pair];
      if (!pair) continue;
      // A PENDING SETUP THAT HAS WAITED PAST ITS TIME IS LET GO HERE TOO. The scan's housekeeping does
      // that every five minutes — but not while the scanner is switched off, and the first passes after
      // it is switched back on come before the first scan. What was left pending days ago is not acted on.
      // (A time nobody can read counts as past.)
      if (!(nowMs - Date.parse(row.created_at) <= (FORMING_TTL_MS[row.mode] ?? FORMING_TTL_MS.quick))) {
        await admin.from("genfx_alerts").update({ state: "expired", updated_at: nowIso }).eq("id", row.id).eq("state", "forming");
        for (const k of [`arm:${row.id}`, `conf:enter:${row.id}`, `conf:arm:${row.id}`]) touchSeen.delete(k);
        sent.push(`${row.pair}:${row.mode}:EXPIRED`);
        continue;
      }
      const due = nowMs - (lastConfirm.get(row.id) ?? 0) >= CONFIRM_EVERY_MS;

      // ARMED: its candles can only end it; whether to take it is a matter of price, asked every pass.
      if (row.enter_sent_at) {
        const armedAtMs = Date.parse(row.enter_sent_at);
        // Its five minutes are asked first, and need neither a price nor a candle: a setup whose time has
        // run out is let go whatever the feed is doing (and one whose arming time cannot be read has no time left).
        if (!(nowMs - armedAtMs <= ARM_MAX_MS)) {
          touchSeen.delete(`arm:${row.id}`);
          const res = await actOnForming(admin, ctl, pair, row, "ARMED", null, null, { place, nowMs });
          if (res && /^invalid/.test(res)) sent.push(`${row.pair}:${row.mode}:${res.toUpperCase()}`);
          continue;
        }
        if (due) {
          const conf = await readConfirm(row, pair, { live: null, noMomentum: true });
          if (conf) lastConfirm.set(row.id, nowMs);
          if (conf?.state === "INVALIDATED") {
            touchSeen.delete(`arm:${row.id}`);
            const res = await actOnForming(admin, ctl, pair, row, "INVALIDATED", conf.price, conf.price, { place, nowMs });
            if (res) sent.push(`${row.pair}:${row.mode}:${res.toUpperCase()}`);
            continue;
          }
        }
        const q = await quoteOf(row.pair);
        if (!q) continue;
        const d = decideFxEntry(pair, { armed: true, confState: "ARMED", lp: q.px, entryLow: row.entry_low, entryHigh: row.entry_high, stop: row.stop, tp1: row.tp1, armedAtMs, nowMs });
        // "It has come back" is entered on two observations, like a touch.
        if (d.do === "wait" || (d.do === "enter" && !touchConfirmed(touchSeen, `arm:${row.id}`, true, q.at))) { if (d.do === "wait") touchSeen.delete(`arm:${row.id}`); continue; }
        const res = await actOnForming(admin, ctl, pair, row, "ARMED", q.px, q.px, { place, nowMs });
        if (res && /^(enter|invalid)/.test(res)) sent.push(`${row.pair}:${row.mode}:${res.toUpperCase()}`);
        continue;
      }
      if (!due) continue;

      // A later pending alert that duplicates an earlier open one (the zone drifted) is retired quietly.
      let twin: FxAlert | null = null;
      try { twin = await findSameSetup(admin, pair, row.mode, row, row.id); } catch { /* cannot check → leave it */ }
      if (twin && isOlder(twin, row)) {
        lastConfirm.set(row.id, nowMs);
        await admin.from("genfx_alerts").update({ state: "invalidated", last_checked_at: nowIso, updated_at: nowIso }).eq("id", row.id).eq("state", "forming");
        sent.push(`${row.pair}:${row.mode}:MERGED`);
        continue;
      }
      // The confirmation is read with the watch's own price (or none: the forming candle's close stands
      // in, and nothing can be entered on it). Momentum is asked once per candle: not again once this
      // setup's confirmation has been read — by the scan or by a pass — since the candle's close was in.
      const q = await quoteOf(row.pair);
      const readAt = Date.parse(String(row.last_checked_at ?? ""));
      const conf = await readConfirm(row, pair, { live: q ? q.px : null, noMomentum: Number.isFinite(readAt) && readAt >= floor });
      if (!conf) continue;                                   // not back in time: read again when the feed is
      const lp = q ? px(pair, q.px) : null;
      const seen = (what: string) => `conf:${what}:${row.id}`;
      const d = decideFxEntry(pair, { armed: false, confState: conf.state, lp, entryLow: row.entry_low, entryHigh: row.entry_high, stop: row.stop, tp1: row.tp1, armedAtMs: nowMs, nowMs });
      if (d.do === "enter" || d.do === "arm") {
        // What the candles say is settled; whether price is worth taking HERE is one number, and one
        // number decides nothing. Seen once: the row is read again on the next pass, not in ten seconds —
        // the second look has to follow the first. No price to believe: nothing is entered or armed.
        touchSeen.delete(seen(d.do === "enter" ? "arm" : "enter"));
        if (!q || !touchConfirmed(touchSeen, seen(d.do), true, q.at)) continue;
      } else { touchSeen.delete(seen("enter")); touchSeen.delete(seen("arm")); }
      lastConfirm.set(row.id, nowMs);
      const res = await actOnForming(admin, ctl, pair, row, conf.state, lp, lp, { place, nowMs });
      // (A read that could not be made — no candles, a busy feed — is not a read: the row's "last checked" stays where it was.)
      if (res && !/^(enter|arm|invalid)/.test(res) && conf.state !== "NO_DATA" && conf.state !== "BUSY") await admin.from("genfx_alerts").update({ last_checked_at: nowIso, updated_at: nowIso }).eq("id", row.id).eq("state", "forming");
      if (res && /^(enter|arm|invalid)/.test(res)) sent.push(`${row.pair}:${row.mode}:${res.toUpperCase()}`);
    } catch { /* per-row best effort */ }
  }
  return { zones: zones.length, forming: forming.length, sent };
}

/** The slower beat, run every ~20 seconds by whoever holds the lock: GEN FX's own books (settle.ts). */
export async function genfxSweep(admin: Admin): Promise<{ settle: SettleOut }> {
  return { settle: await settleFills(admin) };
}
