"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { FeedState } from "../../../../command-center/core/atlasContract";
import {
  clockOffset, emptyTape, ingestTick, needsPolling, screenFeedState,
  FEED_POLL_MS, LIVE_ROUTE_POLL_MS,
  type FeedChannel, type FeedStats, type TickTape, type TickVia,
} from "../../../../command-center/core/feed";
import { normPrice, type LiveTick } from "../../../../command-center/core/formingCandle";
import { marketOpen } from "../../../../command-center/core/sessions";

export type { LiveTick };

/**
 * THE LIVE GOLD FEED, IN THE BROWSER (owner 11-11: "Implement actual streaming quotes when supported … If only
 * polling is available, accurately show its cadence and limitations … Detect a connected socket that has
 * stopped delivering data … subscription cleanup and connection recovery").
 *
 * How a price gets here:
 *   1. Once, on open: GET /api/command-center/tick — the newest tick, the server's clock (so a browser clock a
 *      few seconds off cannot make a fresh tick look stale) and the access check /api/command-center/live makes.
 *      Refused (no session, no pass): nothing is subscribed or polled; it asks again once a minute.
 *   2. Supabase Realtime: postgres_changes INSERT/UPDATE on public.market_live_ticks, filter symbol=eq.XAU/USD.
 *      The worker's single Twelve Data WebSocket upserts that row about once a second, so this is the stream
 *      (transport "websocket_relay"): one provider connection, fanned out to every viewer.
 *   3. Whenever the channel is not SUBSCRIBED (connecting, errored, closed) or is subscribed but silent for
 *      FEED_SILENT_MS while gold is open, it polls /tick every FEED_POLL_MS — transport "poll": DELAYED, never
 *      LIVE, and the reason says the cadence. Polling stops as soon as Realtime delivers again. A dropped channel
 *      is re-subscribed with backoff (1 s → 30 s).
 *
 * Every tick passes one intake rule (core/feed.ts ingestTick): the same row from Realtime and a poll counts once
 * (by received time), an older tick never overwrites a newer one, and a future-dated or bad print is dropped. A
 * watchdog re-derives the status every second (core/feed.ts screenFeedState → computeFeedState), so a channel
 * that stays connected but goes quiet turns DELAYED, then STALE, on its own: a running connection is never
 * enough for LIVE. `serverFeed` (the /live answer's `feed`) is folded in when it carries a fresher price than the
 * stream — e.g. the engine's snapshot while the stream is down — so the screen shows ONE price and ONE status.
 *
 * Unmount tears everything down: the channel (removeChannel), every timer, any request in flight.
 */

const SYMBOL = "XAU/USD";
const TABLE = "market_live_ticks";
const RESUB_MIN_MS = 1_000;
const RESUB_MAX_MS = 30_000;
/** After the route refuses (no session / no pass / not configured), ask again this often. */
const REFUSED_RETRY_MS = 60_000;
const WATCHDOG_MS = 1_000;
/** The best clock sample is re-taken this often, so a drifting clock is followed. */
const OFFSET_TTL_MS = 5 * 60_000;

export type LiveFeed = {
  /** The newest accepted tick (streamed or polled). */
  tick: LiveTick | null;
  /** The honest state of the price the screen shows, recomputed every second. */
  feed: FeedState;
  /** Accepted ticks, oldest first, deduplicated — what GoldChart's `ticks` prop takes. */
  recentTicks: LiveTick[];
  /** Instrumentation: ticks received, gaps, disconnects, polls … */
  stats: FeedStats;
  /** The Realtime channel's state (null: none — disabled, demo, refused or Supabase not configured). */
  channel: FeedChannel | null;
  /** Whether the /tick poll fallback is running right now. */
  polling: boolean;
  /** How far the server clock is ahead of this browser's, as last measured. */
  clockOffsetMs: number;
  /** Be told about each accepted tick. Returns the unsubscribe. */
  onTick: (cb: (t: LiveTick) => void) => () => void;
};

export type UseLiveFeedOptions = {
  /** False: nothing is fetched or subscribed. Default true. */
  enabled?: boolean;
  /** The replay: status DEMO, nothing fetched or subscribed. */
  demo?: boolean;
  /** The last /api/command-center/live answer's `feed`, folded in when its price is fresher than the stream's. */
  serverFeed?: FeedState | null;
  /** How often the screen polls /live (for the reason text when its price is the one shown). */
  serverPollMs?: number;
  pollMs?: number;
  endpoint?: string;
};

/** A market_live_ticks row as Realtime delivers it. */
type Row = { symbol?: string | null; price?: number | string | null; tick_at?: string | null; received_at?: string | null };

function rowTick(r: Row | null | undefined): LiveTick | null {
  if (!r || (r.symbol != null && r.symbol !== SYMBOL)) return null;
  const price = Number(r.price);
  const receivedTs = Date.parse(String(r.received_at ?? ""));
  const providerTs = Date.parse(String(r.tick_at ?? ""));
  if (!Number.isFinite(price) || !(price > 0) || !Number.isFinite(receivedTs)) return null;
  return { price: normPrice(price), receivedTs, providerTs: Number.isFinite(providerTs) ? providerTs : null };
}

/** The tick as /api/command-center/tick returns it. */
function apiTick(t: unknown): LiveTick | null {
  if (!t || typeof t !== "object") return null;
  const r = t as { symbol?: unknown; price?: unknown; tickAt?: unknown; receivedAt?: unknown };
  if (r.symbol != null && r.symbol !== SYMBOL) return null;
  const price = Number(r.price), receivedTs = Number(r.receivedAt), providerTs = r.tickAt == null ? NaN : Number(r.tickAt);
  if (!Number.isFinite(price) || !(price > 0) || !Number.isFinite(receivedTs)) return null;
  return { price: normPrice(price), receivedTs, providerTs: Number.isFinite(providerTs) ? providerTs : null };
}

export function useLiveFeed(opts: UseLiveFeedOptions = {}): LiveFeed {
  const {
    enabled = true, demo = false, serverFeed = null, serverPollMs = LIVE_ROUTE_POLL_MS,
    pollMs = FEED_POLL_MS, endpoint = "/api/command-center/tick",
  } = opts;
  const active = enabled && !demo;

  const tapeRef = useRef<TickTape>(emptyTape());
  /** `since` on the SERVER clock (what core/feed.ts reads); `sinceLocal` on this one (for the watchdog). */
  const channelRef = useRef<{ state: FeedChannel | null; since: number; sinceLocal: number }>({
    state: active ? "connecting" : null, since: Date.now(), sinceLocal: Date.now(),
  });
  const offsetRef = useRef<{ ms: number; rtt: number; at: number }>({ ms: 0, rtt: Infinity, at: 0 });
  /** An access or configuration problem, said instead of the generic reason. */
  const noteRef = useRef<string | null>(null);
  const serverRef = useRef<FeedState | null>(serverFeed);
  serverRef.current = serverFeed;
  const listeners = useRef(new Set<(t: LiveTick) => void>());

  const compute = (): FeedState => {
    const now = Date.now() + offsetRef.current.ms;
    const ch = channelRef.current;
    const f = screenFeedState({
      now, marketOpen: marketOpen(now), demo,
      tape: tapeRef.current, channel: active ? ch.state : null, channelSince: ch.since,
      pollMs, server: serverRef.current, serverPollMs,
    });
    const note = noteRef.current;
    return note && f.status !== "closed" && f.status !== "demo" && f.status !== "live" ? { ...f, reason: note } : f;
  };
  const computeRef = useRef(compute);
  computeRef.current = compute;

  const [feed, setFeed] = useState<FeedState>(() => compute());
  const [recentTicks, setRecentTicks] = useState<LiveTick[]>([]);
  const [stats, setStats] = useState<FeedStats>(() => ({ ...tapeRef.current.stats }));
  const [channel, setChannel] = useState<FeedChannel | null>(channelRef.current.state);
  const [polling, setPolling] = useState(false);
  const [clockOffsetMs, setClockOffsetMs] = useState(0);

  // A new /live answer (every few seconds) may carry a fresher price than the stream.
  useEffect(() => { setFeed(computeRef.current()); }, [serverFeed]);

  useEffect(() => {
    const refreshOnly = () => { setFeed(computeRef.current()); setStats({ ...tapeRef.current.stats }); };
    if (!active) {
      channelRef.current = { state: null, since: Date.now() + offsetRef.current.ms, sinceLocal: Date.now() };
      setChannel(null);
      setPolling(false);
      refreshOnly();
      const id = setInterval(refreshOnly, WATCHDOG_MS);   // the status still ages honestly
      return () => clearInterval(id);
    }

    let alive = true;
    let refused = false;                       // the route said no: nothing more until a retry succeeds
    const sb = createClient();
    type Channel = ReturnType<NonNullable<typeof sb>["channel"]>;
    let rt: Channel | null = null;
    let resubTimer: ReturnType<typeof setTimeout> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let inflight: AbortController | null = null;
    let fails = 0;
    let lastEventLocal = 0;                    // this browser's clock when Realtime last delivered the row

    const serverNow = () => Date.now() + offsetRef.current.ms;
    const refresh = () => { if (alive) refreshOnly(); };
    const bump = (k: "realtimeEvents" | "polls" | "pollErrors" | "disconnects") => {
      const t = tapeRef.current;
      tapeRef.current = { ...t, stats: { ...t.stats, [k]: t.stats[k] + 1 } };
    };
    const setCh = (state: FeedChannel | null) => {
      const cur = channelRef.current;
      if (cur.state === state) return;
      if (cur.state === "subscribed" && (state === "error" || state === "closed")) bump("disconnects");
      channelRef.current = { state, since: serverNow(), sinceLocal: Date.now() };
      if (alive) setChannel(state);
    };
    noteRef.current = null;
    channelRef.current = { state: "connecting", since: serverNow(), sinceLocal: Date.now() };
    setChannel("connecting");

    const accept = (t: LiveTick | null, via: TickVia) => {
      if (!alive) return;
      const { tape, verdict } = ingestTick(tapeRef.current, t, via, { now: serverNow() });
      tapeRef.current = tape;
      if (verdict === "accept" && tape.last) {
        setRecentTicks(tape.ticks);
        const last = tape.last;
        for (const cb of listeners.current) { try { cb(last); } catch { /* a listener's fault is its own */ } }
      }
      refresh();
    };

    function stopPolling() {
      if (!pollTimer) return;
      clearInterval(pollTimer);
      pollTimer = null;
      if (alive) setPolling(false);
    }
    function startPolling() {
      if (pollTimer || refused || !alive) return;
      setPolling(true);
      void pollOnce();
      pollTimer = setInterval(() => { void pollOnce(); }, pollMs);
    }

    function scheduleRetry() {
      if (retryTimer || !alive) return;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (!alive) return;
        refused = false;                       // let the probe through
        void pollOnce().then((res) => {
          if (!alive) return;
          if (res === "ok") { noteRef.current = null; subscribe(); evaluate(); }
          else if (res !== "refused") { refused = true; scheduleRetry(); }
          // "refused": refuse() has already scheduled the next attempt
        });
      }, REFUSED_RETRY_MS);
    }

    function refuse(status: number) {
      refused = true;
      noteRef.current = status === 503
        ? "The live feed is not configured on this server."
        : "The live feed needs a signed-in session with an open Command Center pass.";
      stopPolling();
      if (resubTimer) { clearTimeout(resubTimer); resubTimer = null; }
      if (rt && sb) { const old = rt; rt = null; void sb.removeChannel(old); }
      setCh(null);
      scheduleRetry();
      refresh();
    }

    async function pollOnce(): Promise<"ok" | "refused" | "error" | "skipped"> {
      if (!alive || refused || inflight) return "skipped";
      const ctrl = new AbortController();
      inflight = ctrl;
      const sentAt = Date.now();
      bump("polls");
      try {
        const r = await fetch(endpoint, { cache: "no-store", signal: ctrl.signal });
        const gotAt = Date.now();
        if (!alive) return "skipped";
        if (r.status === 401 || r.status === 402 || r.status === 403 || r.status === 503) { refuse(r.status); return "refused"; }
        if (!r.ok) { bump("pollErrors"); refresh(); return "error"; }
        const j = (await r.json()) as { serverTime?: unknown; tick?: unknown };
        if (!alive) return "skipped";
        const serverTime = Number(j.serverTime);
        const rtt = gotAt - sentAt;
        // The lowest-latency sample is the most accurate; re-taken every few minutes so drift is followed.
        if (Number.isFinite(serverTime) && (rtt <= offsetRef.current.rtt || gotAt - offsetRef.current.at > OFFSET_TTL_MS)) {
          offsetRef.current = { ms: clockOffset(serverTime, sentAt, gotAt), rtt, at: gotAt };
          setClockOffsetMs(Math.round(offsetRef.current.ms));
        }
        accept(apiTick(j.tick), "poll");
        return "ok";
      } catch {
        if (alive) { bump("pollErrors"); refresh(); }   // the watchdog keeps the status honest as the price ages
        return "error";
      } finally {
        if (inflight === ctrl) inflight = null;
      }
    }

    function scheduleResubscribe() {
      if (resubTimer || !alive || refused) return;
      const wait = Math.min(RESUB_MAX_MS, RESUB_MIN_MS * 2 ** Math.max(0, fails - 1));
      resubTimer = setTimeout(() => { resubTimer = null; subscribe(); }, wait);
    }

    function subscribe() {
      if (!alive || refused) return;
      if (!sb) { setCh(null); evaluate(); return; }            // no Realtime here: the poll carries the feed
      if (rt) { const old = rt; rt = null; void sb.removeChannel(old); }
      setCh("connecting");
      const filter = `symbol=eq.${SYMBOL}`;
      const ch: Channel = sb.channel(`cc-gold-tick-${Math.random().toString(36).slice(2, 10)}`);
      const onRow = (payload: { new?: unknown }) => {
        if (!alive || rt !== ch) return;
        lastEventLocal = Date.now();
        bump("realtimeEvents");
        accept(rowTick(payload.new as Row), "realtime");
      };
      ch.on("postgres_changes", { event: "INSERT", schema: "public", table: TABLE, filter }, onRow)
        .on("postgres_changes", { event: "UPDATE", schema: "public", table: TABLE, filter }, onRow);
      rt = ch;
      ch.subscribe((status) => {
        if (!alive || rt !== ch) return;                       // an old channel's last words
        if (status === "SUBSCRIBED") { fails = 0; setCh("subscribed"); evaluate(); return; }
        // CHANNEL_ERROR, TIMED_OUT, CLOSED: the push link is down. Poll meanwhile; re-subscribe with backoff.
        fails += 1;
        setCh(status === "CLOSED" ? "closed" : "error");
        evaluate();
        scheduleResubscribe();
      });
    }

    /* The watchdog: whether the poll fallback runs, and the status, re-derived every second. */
    function evaluate() {
      if (!alive) return;
      const ch = channelRef.current;
      const quietForMs = ch.state === "subscribed" ? Date.now() - Math.max(lastEventLocal, ch.sinceLocal) : 0;
      if (needsPolling({ channel: ch.state, marketOpen: marketOpen(serverNow()), quietForMs, refused })) startPolling();
      else stopPolling();
      refresh();
    }
    const watchdog = setInterval(evaluate, WATCHDOG_MS);

    const onVisible = () => {
      if (document.visibilityState !== "visible" || refused) return;
      // A hidden tab may have been throttled: take one fresh reading straight away.
      void pollOnce();
      evaluate();
    };
    document.addEventListener("visibilitychange", onVisible);

    // Seed the price, the clock and the access check first; then subscribe.
    void pollOnce().then((res) => {
      if (!alive) return;
      if (res !== "refused") subscribe();
      evaluate();
    });

    return () => {
      alive = false;
      clearInterval(watchdog);
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      if (resubTimer) { clearTimeout(resubTimer); resubTimer = null; }
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      inflight?.abort();
      inflight = null;
      if (rt && sb) void sb.removeChannel(rt);
      rt = null;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [active, pollMs, endpoint]);

  const onTick = useCallback((cb: (t: LiveTick) => void) => {
    listeners.current.add(cb);
    return () => { listeners.current.delete(cb); };
  }, []);

  return {
    tick: recentTicks.length ? recentTicks[recentTicks.length - 1] : null,
    feed,
    recentTicks,
    stats,
    channel,
    polling,
    clockOffsetMs,
    onTick,
  };
}
