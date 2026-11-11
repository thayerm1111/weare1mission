/**
 * THE FEED, HONESTLY (owner 11-11: "Clearly distinguish LIVE, DELAYED, RECONNECTING, STALE, MARKET CLOSED,
 * and DEMO states. Detect a connected socket that has stopped delivering data. Never display a green LIVE
 * indicator merely because an animation or socket connection is running.")
 *
 * One pure function — computeFeedState — decides what the price on screen is allowed to call itself. The
 * browser (hud/useLiveFeed.ts, every second), the API routes (/live, /tick) and ATLAS all ask it, so a price
 * can never be "live" in one place and "delayed" in another.
 *
 * WHERE A PRICE COMES FROM (FeedTransport)
 *   websocket_relay  the worker holds ONE Twelve Data WebSocket and upserts the newest XAU/USD tick into
 *                    market_live_ticks about once a second (worker/priceStream.ts). The browser hears that row
 *                    change through Supabase Realtime; the server reads the row at the moment of an answer.
 *   poll             the same row fetched on a timer (/api/command-center/tick every FEED_POLL_MS when Realtime
 *                    is not delivering), or a one-off provider quote for a spoken answer. Never LIVE.
 *   snapshot         the price inside the engine's persisted snapshot (written about once a minute).
 *   replay           recorded bars stepped through the engine. Always DEMO.
 *
 * FRESHNESS IS JUDGED ON RECEIVED TIME. Twelve Data stamps gold to the minute (observed: tick_at 04:09:00 on a
 * tick received at 04:09:57), so `providerTs` is shown beside the price and never used to decide whether it is
 * current. `receivedTs` is when our side (the worker) received it.
 *
 * THE RULES, in order — the first that matches decides:
 *
 *   1. DEMO           replay / fixtures (`replay`, or transport "replay"). Whatever else is true.
 *   2. MARKET CLOSED  core/sessions.ts says gold is shut (weekend, or the 17:00–18:00 New York break).
 *   3. STALE          a received time more than FEED_FUTURE_TOLERANCE_MS in the future: a clock fault.
 *   4. RECONNECTING   the push channel is connecting / errored / closed and no fallback price is carrying
 *                     the screen: a held price can no longer move. Past FEED_STALE_MS of nothing fresh, STALE.
 *                     (A polled or snapshot price within its window while the channel is down is DELAYED —
 *                     the fallback is working, and the reason says which one and how often.)
 *   5. LIVE           a STREAMED tick (websocket_relay) received within FEED_LIVE_MS. Nothing else is ever
 *                     LIVE: not a poll however fast, not a snapshot, not a subscribed channel with nothing on
 *                     it. A channel that is subscribed but silent ages its last tick like any other, so it
 *                     falls to DELAYED within FEED_LIVE_MS and says it is silent past FEED_SILENT_MS.
 *   6. DELAYED        a streamed tick older than FEED_LIVE_MS, or a polled price, within FEED_STALE_MS; a
 *                     snapshot price within FEED_SNAPSHOT_MAX_MS. The reason says the cadence.
 *   7. STALE          the market is open and nothing usable has arrived beyond those limits.
 *
 * Pure: no I/O, no clock — the caller passes `now` and `marketOpen` (computed with core/sessions.ts).
 */
import { ATLAS_READ_VERSION, type AnalysisMeta, type FeedState, type FeedStatus, type FeedTransport } from "./atlasContract";
import type { MarketSnapshot } from "./types";
import { tickVerdict, type LiveTick, type TickVerdict } from "./formingCandle";

/** A streamed tick received within this is LIVE. Gold ticks every second or two while it trades (measured
 *  0.46 ticks a second in a quiet Asian session) and the relay adds about a second. */
export const FEED_LIVE_MS = 5_000;
/** A subscribed channel that has delivered nothing for this long is SILENT: the browser starts polling to find
 *  out whether the row is moving, and the reason says so. Never LIVE either way. */
export const FEED_SILENT_MS = 15_000;
/** Nothing fresh for this long while the market is open → STALE (streamed or polled price). */
export const FEED_STALE_MS = 60_000;
/** The engine writes a snapshot about once a minute (measured 67 s apart, 88 s at worst), so its price is
 *  DELAYED up to two minutes old; past that the engine is behind and the price is STALE. */
export const FEED_SNAPSHOT_MAX_MS = 120_000;
/** How far in the future a received time may be before it is a clock fault rather than a fresh price. */
export const FEED_FUTURE_TOLERANCE_MS = 5_000;
/** How often the browser polls /api/command-center/tick while Realtime is not delivering. */
export const FEED_POLL_MS = 2_000;
/** How often the screen polls /api/command-center/live (CommandCenterHud). Used to describe a price that
 *  reached the browser that way. */
export const LIVE_ROUTE_POLL_MS = 5_000;

export const FEED_PROVIDER = "Twelve Data";
export const FEED_SYMBOL = "XAU/USD";
/** Twelve Data's XAU/USD is a composite spot price — a mid, not a broker's executable bid or ask. */
export const FEED_QUOTE_TYPE: FeedState["quoteType"] = "mid";

/** The browser's push channel (Supabase Realtime), in the words the status uses. Null: there is none (server). */
export type FeedChannel = "subscribed" | "connecting" | "error" | "closed";

export type FeedInput = {
  /** core/sessions.ts marketOpen(now). */
  marketOpen: boolean;
  /** How the freshest price reached us. */
  transport: FeedTransport;
  price: number | null;
  /** The provider's own timestamp, when it sent one. Shown, never used for freshness. */
  providerTs?: number | null;
  /** When our side received the price. Freshness is judged on this. */
  receivedTs: number | null;
  now: number;
  /** Recorded data (replay, fixtures). */
  replay: boolean;
  /** The push channel's state, browser only. */
  channel?: FeedChannel | null;
  /** When the channel entered that state — how long a connect has been going on, or how long it has been up. */
  channelSince?: number | null;
  /** Poll cadence to say in the reason. Null/absent on a "poll" transport = a one-off requested quote. */
  pollMs?: number | null;
  provider?: string;
  symbol?: string;
  quoteType?: FeedState["quoteType"];
};

/** A duration in the words the reasons use: "1.4 s", "34 s", "6 min", "5 h", "2 days". */
export const feedAgeWords = (ms: number): string => {
  const v = Math.max(0, ms);
  if (v < 10_000) return `${(v / 1000).toFixed(1)} s`;
  if (v < 120_000) return `${Math.round(v / 1000)} s`;
  if (v < 120 * 60_000) return `${Math.round(v / 60_000)} min`;
  if (v < 48 * 3_600_000) return `${Math.round(v / 3_600_000)} h`;
  return `${Math.round(v / 86_400_000)} days`;
};

/** A duration in the chart label's short form: "<1s", "4s", "3m", "2h", "2d". */
export const feedAgeShort = (ms: number): string => {
  const v = Math.max(0, ms);
  if (v < 1_000) return "<1s";
  if (v < 60_000) return `${Math.floor(v / 1000)}s`;
  if (v < 3_600_000) return `${Math.floor(v / 60_000)}m`;
  if (v < 48 * 3_600_000) return `${Math.floor(v / 3_600_000)}h`;
  return `${Math.floor(v / 86_400_000)}d`;
};

const cadence = (ms: number): string => {
  const s = ms / 1000;
  return `${Number.isInteger(s) ? s : s.toFixed(1)} s`;
};

const fin = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);

/** The honest state of the price feed. See the rules at the top of this file. */
export function computeFeedState(i: FeedInput): FeedState {
  const now = i.now;
  const price = fin(i.price) && i.price > 0 ? i.price : null;
  const receivedTs = price != null && fin(i.receivedTs) ? i.receivedTs : null;
  const providerTs = fin(i.providerTs) ? i.providerTs : null;
  const rawAge = receivedTs != null ? now - receivedTs : null;
  const clockFault = rawAge != null && rawAge < -FEED_FUTURE_TOLERANCE_MS;
  const ageMs = rawAge == null || clockFault ? null : Math.max(0, rawAge);
  const provider = i.provider ?? FEED_PROVIDER;
  const base = {
    provider,
    symbol: i.symbol ?? FEED_SYMBOL,
    quoteType: i.quoteType ?? FEED_QUOTE_TYPE,
    transport: i.transport,
    price,
    providerTs,
    receivedTs,
    ageMs,
    checkedAt: now,
  };
  const out = (status: FeedStatus, reason: string): FeedState => ({ ...base, status, reason });
  const held = price != null && ageMs != null ? ` Last price ${price.toFixed(2)}, received ${feedAgeWords(ageMs)} ago.` : "";
  const channel = i.channel ?? null;
  const channelFor = fin(i.channelSince) ? Math.max(0, now - i.channelSince) : null;

  /* 1 — recorded data is always DEMO */
  if (i.replay || i.transport === "replay") {
    return out("demo", "Demo — recorded XAU/USD replayed through the engine; not the live market.");
  }

  /* 2 — the calendar says shut */
  if (!i.marketOpen) {
    return out("closed", `Market closed — gold is shut for the weekend or the 17:00–18:00 New York break.${held}`);
  }

  /* 3 — a time from the future is a clock fault, not a fresh price */
  if (clockFault) {
    return out("stale", "The price's received time is ahead of this clock — a clock problem, not a fresh price.");
  }

  const usable = (t: FeedTransport, age: number | null): boolean =>
    age != null && (t === "snapshot" ? age <= FEED_SNAPSHOT_MAX_MS : age <= FEED_STALE_MS);

  /* 4 — the push channel is down or still connecting, and no fallback is carrying the screen */
  const down = channel === "connecting" || channel === "error" || channel === "closed";
  if (down && !((i.transport === "poll" || i.transport === "snapshot") && usable(i.transport, ageMs))) {
    const verb = channel === "connecting" ? "Connecting to" : "Reconnecting to";
    const silentFor = ageMs ?? channelFor;
    if (silentFor != null && silentFor > FEED_STALE_MS) {
      return out("stale", `No fresh price for ${feedAgeWords(silentFor)} while gold is open — ${verb.toLowerCase()} the stream.`);
    }
    return out("reconnecting", `${verb} the ${provider} stream…${held}`);
  }

  /* No price at all */
  if (price == null) {
    if (channel === "subscribed" && channelFor != null && channelFor <= FEED_STALE_MS) {
      return out("reconnecting", "Connected to the stream — waiting for the first tick.");
    }
    return out("stale", channel === "subscribed"
      ? `Connected to the stream, but no price has arrived${channelFor != null ? ` in ${feedAgeWords(channelFor)}` : ""} while gold is open.`
      : "No price has arrived while gold is open.");
  }
  if (ageMs == null) return out("stale", "A price arrived without a received time, so its age is unknown.");

  /* 5–7 — what the freshest price is, and how old */
  switch (i.transport) {
    case "websocket_relay":
      if (ageMs <= FEED_LIVE_MS) {
        return out("live", `Streaming — tick received ${feedAgeWords(ageMs)} ago through the ${provider} WebSocket relay.`);
      }
      if (ageMs <= FEED_STALE_MS) {
        return out("delayed", channel === "subscribed" && ageMs > FEED_SILENT_MS
          ? `Stream connected but silent for ${feedAgeWords(ageMs)} — gold may be quiet; checking by polling every ${cadence(i.pollMs ?? FEED_POLL_MS)}.`
          : `No new tick for ${feedAgeWords(ageMs)} — gold may be quiet.`);
      }
      return out("stale", `No new tick for ${feedAgeWords(ageMs)} while gold is open — the stream has stopped delivering.`);
    case "poll": {
      const how = fin(i.pollMs) && i.pollMs > 0 ? `Polled every ${cadence(i.pollMs)}` : "A requested quote";
      const why = channel === "subscribed" ? "the stream is connected but not delivering"
        : channel === "connecting" ? "the stream is still connecting"
        : channel === "error" || channel === "closed" ? "the stream is reconnecting"
        : "not streamed";
      if (ageMs <= FEED_STALE_MS) return out("delayed", `${how} — ${why}; price received ${feedAgeWords(ageMs)} ago.`);
      return out("stale", `No new price for ${feedAgeWords(ageMs)} while gold is open (${how.toLowerCase()}).`);
    }
    case "snapshot":
      if (ageMs <= FEED_SNAPSHOT_MAX_MS) {
        return out("delayed", `Not streamed — the engine's snapshot price (written about once a minute), ${feedAgeWords(ageMs)} old.`);
      }
      return out("stale", `The newest price is ${feedAgeWords(ageMs)} old — the engine's snapshot is behind while gold is open.`);
    default:
      return out("stale", "No usable price.");
  }
}

/* ── the server's view: a snapshot, with the fresher quote attached when there is one ─────────────────── */

/**
 * The feed state of a snapshot as the screen and ATLAS show it: the fresher quote attached to it when there is
 * one (engines/livePrice.ts — a streamed tick, or for a conversation one direct quote), else the snapshot's own
 * price. A direct quote is a request, not a stream: "poll", DELAYED, never LIVE.
 *
 * Same inputs as the price the screen shows (core/priceNow.ts), so the headline and its status cannot describe
 * two different numbers.
 */
export function feedOfSnapshot(
  s: Pick<MarketSnapshot, "price" | "at" | "live"> | null,
  o: { now: number; marketOpen: boolean; providerTs?: number | null; replay?: boolean },
): FeedState {
  const replay = !!o.replay;
  if (!s) {
    return computeFeedState({ marketOpen: o.marketOpen, transport: replay ? "replay" : "snapshot", price: null, receivedTs: null, now: o.now, replay });
  }
  const transport: FeedTransport = replay ? "replay" : s.live ? (s.live.source === "stream" ? "websocket_relay" : "poll") : "snapshot";
  return computeFeedState({
    marketOpen: o.marketOpen,
    transport,
    price: s.live?.price ?? s.price,
    // Only a streamed tick carries a provider timestamp; a direct quote and the snapshot's price do not.
    providerTs: s.live?.source === "stream" ? o.providerTs ?? null : null,
    receivedTs: s.live?.at ?? s.at,
    now: o.now,
    replay,
    channel: null,
    pollMs: null,
  });
}

/**
 * Which analysis this is: the snapshot it was computed from, the engine version that computed it, and how old
 * it is. A quote updates faster than an analysis conclusion — the screen shows both timestamps rather than
 * pretending they are simultaneous.
 */
export function analysisMeta(
  snapshot: Pick<MarketSnapshot, "snapshotVersion" | "at"> | null,
  snapshotId: number | null,
  now: number,
): AnalysisMeta {
  if (!snapshot || !fin(snapshot.at)) {
    return { snapshotId: snapshotId ?? null, analysisVersion: "none", analysisAt: null, analysisAgeMs: null, readVersion: ATLAS_READ_VERSION };
  }
  return {
    snapshotId: snapshotId ?? null,
    analysisVersion: snapshot.snapshotVersion,
    analysisAt: snapshot.at,
    analysisAgeMs: Math.max(0, now - snapshot.at),
    readVersion: ATLAS_READ_VERSION,
  };
}

/** What /api/command-center/tick answers: the newest relayed tick, the server's clock, and its feed state AS A
 *  POLL — which is what a caller of that route is doing. */
export function tickPayload(
  row: { price: number; tickAt: number | null; receivedAt: number; updatedAt?: number | null } | null,
  o: { now: number; marketOpen: boolean; symbol?: string },
) {
  const symbol = o.symbol ?? FEED_SYMBOL;
  const tickAt = row && fin(row.tickAt) ? row.tickAt : null;
  return {
    ok: true as const,
    symbol,
    tick: row ? { symbol, price: row.price, tickAt, receivedAt: row.receivedAt, updatedAt: fin(row.updatedAt) ? row.updatedAt : null } : null,
    serverTime: o.now,
    feed: computeFeedState({
      marketOpen: o.marketOpen, transport: "poll", pollMs: FEED_POLL_MS,
      price: row?.price ?? null, providerTs: tickAt, receivedTs: row?.receivedAt ?? null,
      now: o.now, replay: false, channel: null,
    }),
  };
}

/* ── the browser's view: ticks in, one feed state out ─────────────────────────────────────────────────── */

/** How far the server's clock is ahead of this one, from one request: the server's time minus the midpoint of
 *  the request. A browser clock a few seconds off would otherwise turn a fresh tick STALE (or a stale one LIVE). */
export function clockOffset(serverNow: number, sentAt: number, gotAt: number): number {
  return serverNow - (sentAt + gotAt) / 2;
}

export type TickVia = "realtime" | "poll";

/** Simple instrumentation, for the screen and for debugging the relay. */
export type FeedStats = {
  /** Ticks accepted (new, in order, believable). */
  ticksReceived: number;
  /** Realtime row events heard, accepted or not. */
  realtimeEvents: number;
  polls: number;
  pollErrors: number;
  duplicates: number;
  outOfOrder: number;
  /** Invalid, future-dated or bad-print ticks dropped. */
  rejected: number;
  /** Received-time gap between the last two accepted ticks, and the largest seen. */
  lastGapMs: number | null;
  maxGapMs: number | null;
  /** Times the push channel dropped (error, timeout or close). */
  disconnects: number;
  /** Received time of the newest accepted tick. */
  lastTickAt: number | null;
};

export const emptyFeedStats = (): FeedStats => ({
  ticksReceived: 0, realtimeEvents: 0, polls: 0, pollErrors: 0, duplicates: 0, outOfOrder: 0, rejected: 0,
  lastGapMs: null, maxGapMs: null, disconnects: 0, lastTickAt: null,
});

/** The ticks the browser has accepted, and which path delivered the newest. */
export type TickTape = { last: LiveTick | null; via: TickVia | null; ticks: LiveTick[]; stats: FeedStats };
export const emptyTape = (): TickTape => ({ last: null, via: null, ticks: [], stats: emptyFeedStats() });

/** Ticks kept for the chart's forming candles: the server's bars are the history, this is only the recent edge. */
export const TAPE_KEEP_MS = 4 * 3_600_000;
export const TAPE_MAX_TICKS = 15_000;

/**
 * Take one tick into the tape: the ONE intake rule for Realtime and the poll alike. The same row delivered by
 * both counts once (dedupe by received time), an older tick never overwrites a newer one (out of order is
 * dropped), and a future-dated or implausible one is refused. Pure: returns the same tape object's ticks when
 * nothing was accepted.
 */
export function ingestTick(
  tape: TickTape,
  tick: LiveTick | null,
  via: TickVia,
  o: { now: number; keepMs?: number; maxTicks?: number },
): { tape: TickTape; verdict: TickVerdict | "future" } {
  const stats = { ...tape.stats };
  if (tick && fin(tick.receivedTs) && tick.receivedTs > o.now + FEED_FUTURE_TOLERANCE_MS) {
    stats.rejected += 1;
    return { tape: { ...tape, stats }, verdict: "future" };
  }
  const verdict = tickVerdict(tape.last, tick);
  if (verdict === "duplicate") {
    stats.duplicates += 1;
    // The poll got there first; Realtime carrying the same tick means the stream is working.
    return { tape: { ...tape, via: via === "realtime" ? "realtime" : tape.via, stats }, verdict };
  }
  if (verdict === "out_of_order") { stats.outOfOrder += 1; return { tape: { ...tape, stats }, verdict }; }
  if (verdict !== "accept" || !tick) { stats.rejected += 1; return { tape: { ...tape, stats }, verdict }; }

  const t: LiveTick = { price: tick.price, receivedTs: tick.receivedTs, providerTs: fin(tick.providerTs) ? tick.providerTs : null };
  if (tape.last) {
    const gap = t.receivedTs - tape.last.receivedTs;
    stats.lastGapMs = gap;
    stats.maxGapMs = Math.max(stats.maxGapMs ?? 0, gap);
  }
  stats.ticksReceived += 1;
  stats.lastTickAt = t.receivedTs;
  const cutoff = t.receivedTs - (o.keepMs ?? TAPE_KEEP_MS);
  let start = 0;
  while (start < tape.ticks.length && tape.ticks[start].receivedTs < cutoff) start++;
  const ticks = tape.ticks.slice(start);
  ticks.push(t);
  const max = o.maxTicks ?? TAPE_MAX_TICKS;
  return { tape: { last: t, via, ticks: ticks.length > max ? ticks.slice(-max) : ticks, stats }, verdict };
}

/**
 * Should the browser poll /tick right now? Whenever the channel is not SUBSCRIBED, or it is but has gone silent
 * — and only while gold is open and the route has not refused this member.
 */
export function needsPolling(o: { channel: FeedChannel | null; marketOpen: boolean; quietForMs: number; refused?: boolean }): boolean {
  if (o.refused || !o.marketOpen) return false;
  if (o.channel !== "subscribed") return true;
  return o.quietForMs > FEED_SILENT_MS;
}

/**
 * THE FEED STATE THE SCREEN SHOWS, recomputed every second: the freshest of the browser's own newest tick and
 * the price the last /live answer carried, judged with computeFeedState against the push channel's state.
 *
 * The /live answer reached the browser by a poll, so a streamed price inside it is a POLLED price here
 * (cadence LIVE_ROUTE_POLL_MS); its snapshot price stays a snapshot price.
 */
export function screenFeedState(o: {
  now: number;
  marketOpen: boolean;
  demo: boolean;
  tape: Pick<TickTape, "last" | "via">;
  channel: FeedChannel | null;
  channelSince?: number | null;
  pollMs?: number;
  server?: FeedState | null;
  serverPollMs?: number;
}): FeedState {
  const tick = o.tape.last;
  const server = o.server && o.server.price != null && fin(o.server.receivedTs) ? o.server : null;
  const useServer = server != null && (tick == null || (server.receivedTs as number) > tick.receivedTs);
  // A replay answer is DEMO however it arrived; nothing from it can make the screen look live.
  const replay = o.demo || o.server?.status === "demo" || o.server?.transport === "replay";
  const common = { marketOpen: o.marketOpen, now: o.now, replay, channel: o.channel, channelSince: o.channelSince ?? null };
  if (useServer && server) {
    const transport: FeedTransport = server.transport === "snapshot" || server.transport === "replay" ? server.transport : "poll";
    return computeFeedState({
      ...common, transport, price: server.price, providerTs: server.providerTs, receivedTs: server.receivedTs,
      pollMs: o.serverPollMs ?? LIVE_ROUTE_POLL_MS,
    });
  }
  return computeFeedState({
    ...common,
    transport: tick ? (o.tape.via === "realtime" ? "websocket_relay" : "poll") : o.channel === "subscribed" ? "websocket_relay" : "poll",
    price: tick?.price ?? null,
    providerTs: tick?.providerTs ?? null,
    receivedTs: tick?.receivedTs ?? null,
    pollMs: o.pollMs ?? FEED_POLL_MS,
  });
}

/* ── words for the screen ─────────────────────────────────────────────────────────────────────────────── */

export const FEED_STATUS_WORD: Record<FeedStatus, string> = {
  live: "LIVE", delayed: "DELAYED", reconnecting: "RECONNECTING", stale: "STALE", closed: "MARKET CLOSED", demo: "DEMO",
};

/**
 * The chart's basis label: whose price, which instrument, what kind of quote, its status and age — e.g.
 * "Twelve Data · XAU/USD composite (mid) · LIVE · 1s". Without a feed state it claims no status at all.
 */
export function feedBasisLabel(f: FeedState | null | undefined): string {
  const head = `${f?.provider ?? FEED_PROVIDER} · ${f?.symbol ?? FEED_SYMBOL} composite (${f?.quoteType ?? FEED_QUOTE_TYPE})`;
  if (!f) return head;
  const aged = f.status === "live" || f.status === "delayed" || f.status === "reconnecting" || f.status === "stale";
  return `${head} · ${FEED_STATUS_WORD[f.status]}${aged && f.ageMs != null ? ` · ${feedAgeShort(f.ageMs)}` : ""}`;
}
