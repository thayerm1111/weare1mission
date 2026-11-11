/**
 * ATLAS COMMENTARY — what ATLAS volunteers, and when it keeps quiet (owner 11-11: "responsive voice and
 * proactive commentary that feels like JARVIS — calm, situationally aware").
 *
 * A copilot that narrates every tick is a radio left on in the next room. This module is the editor. It reads
 * successive live payloads, notices the handful of things a trader would want said, and decides which of them
 * are still worth saying by the time there is a gap to say them in.
 *
 *   DETECT    a material lean change (read.lean / read.since), scenario status changes, confirmed structure
 *             breaks and watched-level interactions (perception events), scheduled high-impact news inside
 *             15 minutes, and the feed going stale / reconnecting — and coming back.
 *   EDIT      dedupe (the same key inside its window adds nothing), obsolescence (a newer state replaces a
 *             queued older one; a change that reverses before it was said cancels out; anything no longer
 *             true is dropped), expiry, and a cap on the queue.
 *   PACE      per-mode cooldowns. QUIET volunteers nothing. WATCH speaks on the selected meaningful events.
 *             SESSION COPILOT adds a concise running interpretation, never more often than its cooldown.
 *   HONESTY   while the feed is stale (or the analysis has stopped updating), market commentary is held and
 *             ATLAS says the feed is stale instead. Nothing is narrated as current from a picture that is not.
 *
 * Coded against core/atlasContract.ts. `read`, `scenarios` and `feed` arrive from other parts of the upgrade
 * and may be missing or partial at runtime — every one of them is optional here and checked before use; the
 * legacy fields (`connected`, `marketOpen`, `reason`) stand in for `feed` until it exists.
 *
 * Pure: no I/O, no clock (the caller passes `now`), no React. Used by the browser (VoiceSession) and, for the
 * volunteered-turn marker at the bottom, by the voice reasoning endpoint (brain/voiceLlm.ts).
 */
import { LEAN_LABEL, type AtlasRead, type FeedState, type FeedStatus, type Lean, type Scenario, type ScenarioStatus } from "./atlasContract";

/* ── modes and pacing ──────────────────────────────────────────────────────────────────────────────── */

export type CommentaryMode = "quiet" | "watch" | "copilot";

export const COMMENTARY_MODES: readonly { id: CommentaryMode; label: string; hint: string }[] = [
  { id: "quiet", label: "Quiet", hint: "ATLAS volunteers nothing. It answers when you ask." },
  {
    id: "watch", label: "Watch",
    hint: "Speaks up on meaningful events only: a lean change, a scenario confirmed or invalidated, a confirmed structure break, a watched level, high-impact news inside 15 minutes, or a feed problem.",
  },
  {
    id: "copilot", label: "Session copilot",
    hint: "Everything Watch says, plus developing scenarios, level approaches and a short status line — never more often than the cooldown you set.",
  },
];

export const DEFAULT_COMMENTARY_MODE: CommentaryMode = "watch";
/** Watch speaks rarely by design; this only stops two meaningful events landing back to back. */
export const WATCH_COOLDOWN_MS = 45_000;
/** The commentary-frequency setting for Session copilot. */
export const COPILOT_COOLDOWNS_MS: readonly number[] = [30_000, 60_000, 90_000, 120_000, 300_000];
export const DEFAULT_COPILOT_COOLDOWN_MS = 90_000;

export type CommentarySettings = { mode: CommentaryMode; copilotCooldownMs: number };
export const DEFAULT_COMMENTARY_SETTINGS: CommentarySettings = { mode: DEFAULT_COMMENTARY_MODE, copilotCooldownMs: DEFAULT_COPILOT_COOLDOWN_MS };

/** At or above this priority an item is urgent: it may jump a mode's cooldown, down to URGENT_FLOOR_MS. */
export const URGENT_PRIORITY = 90;
export const URGENT_FLOOR_MS = 15_000;
/** Queue cap. When full, the least important item goes. */
export const MAX_QUEUE = 6;
/** "Scheduled high-impact news approaching" means inside this many minutes. */
export const NEWS_WINDOW_MIN = 15;
/** A feed state must hold this long before it is announced — one bad poll is not an outage. */
export const FEED_DEBOUNCE_MS = 10_000;
/** No new payload for this long and market items are held: the picture they describe can't be confirmed. */
export const INPUT_STALE_MS = 45_000;
/** An analysis older than this is not current, whatever the price is doing. */
export const ANALYSIS_STALE_MS = 6 * 60_000;
/** A perception event older than this when first seen is history, not news. */
export const EVENT_FRESH_MS = 4 * 60_000;
/** A lean or scenario change older than this when first seen is not announced (we were not watching). */
export const CHANGE_FRESH_MS = 15 * 60_000;
/** The read must be at least this recent for a copilot status line or a "current read" tail. */
export const READ_FRESH_MS = 3 * 60_000;

export function clampCooldown(ms: number): number {
  return Number.isFinite(ms) ? Math.min(600_000, Math.max(15_000, Math.round(ms))) : DEFAULT_COPILOT_COOLDOWN_MS;
}

/** The minimum gap between two volunteered lines in this mode. Quiet never speaks. */
export function commentaryCooldownMs(s: CommentarySettings): number {
  if (s.mode === "watch") return WATCH_COOLDOWN_MS;
  if (s.mode === "copilot") return clampCooldown(s.copilotCooldownMs);
  return Number.POSITIVE_INFINITY;
}

/** How long Session copilot lets the desk go without a word before a short status line. */
export function statusEveryMs(s: CommentarySettings): number {
  return Math.max(4 * 60_000, 4 * clampCooldown(s.copilotCooldownMs));
}

/* ── what comes in ─────────────────────────────────────────────────────────────────────────────────── */

/** A perception event as the live payload carries it (brain/types.ts PerceptionEvent), loosely. */
export type CommentaryEventInput = {
  key?: string | null;
  at?: number | null;
  code?: string | null;
  detail?: string | null;
  channel?: string | null;
  lean?: string | null;
  level?: { price?: number | null; label?: string | null } | null;
  data?: Record<string, unknown> | null;
};

/**
 * The slice of /api/command-center/live this reads. Structural and all-optional on purpose: the classic
 * screen, the companion and the HUD each hold their own type for the same payload, and the contract fields
 * (`read`, `scenarios`, `feed`, `analysis`) are added by other branches.
 */
export type CommentaryInput = {
  ok?: boolean | null;
  at?: number | null;
  live?: boolean | null;
  connected?: boolean | null;
  marketOpen?: boolean | null;
  reason?: string | null;
  ageSeconds?: number | null;
  replay?: boolean | null;
  feed?: Partial<FeedState> | null;
  analysis?: { analysisAt?: number | null; analysisAgeMs?: number | null } | null;
  read?: AtlasRead | null;
  scenarios?: Scenario[] | null;
  events?: CommentaryEventInput[] | null;
  thesis?: { watching?: number[] | null; invalidationPrice?: number | null } | null;
  watches?: { price?: number | null; label?: string | null }[] | null;
  intel?: { news?: { name?: string | null; at?: number | null; importance?: string | null; minutesTo?: number | null } | null } | null;
};

/* ── what goes out ─────────────────────────────────────────────────────────────────────────────────── */

export type CommentaryKind = "lean" | "scenario" | "structure" | "level" | "news" | "feed" | "status";

export type CommentaryItem = {
  id: string;
  kind: CommentaryKind;
  /** A newer item on the same topic replaces a queued older one. */
  topic: string;
  /** The same key inside `dedupeMs` is the same observation, and is dropped. */
  dedupeKey: string;
  dedupeMs: number;
  /**
   * The state this item announces (a lean, a scenario status, a feed class). Once said, it becomes the
   * topic's announced state; a later change back to it, before anything else was said, is no change at all.
   */
  stateKey: string | null;
  /** What must still be true for the item to be worth saying (checked again at delivery). */
  basis: string | null;
  /** 0–100. URGENT_PRIORITY and above may jump the cooldown. */
  priority: number;
  /** One or two sentences, ready to show or speak. */
  text: string;
  at: number;
  expiresAt: number;
  modes: readonly CommentaryMode[];
  /** Depends on a current market picture: held while input is stale, cancelled while the feed is degraded. */
  market: boolean;
};

export type FeedClass = "ok" | "degraded" | "closed" | "demo";
export type FeedView = { cls: FeedClass; status: FeedStatus | null; why: string; ageMs: number | null };

export type CommentaryState = {
  started: boolean;
  startedAt: number | null;
  seq: number;
  lastInputAt: number | null;
  lean: { lean: Lean; since: number } | null;
  scenarios: Record<string, ScenarioStatus>;
  scenariosSeen: boolean;
  seenEvents: string[];
  eventsSeen: boolean;
  feed: FeedView & { since: number };
  /** The latest valid read, for tails like "current read: …". */
  read: AtlasRead | null;
  queue: CommentaryItem[];
  /** dedupeKey → when it was last queued or said. */
  recent: Record<string, number>;
  /** topic → the last state actually said (or, at start, the state on screen when we began). */
  announced: Record<string, string>;
  lastDeliveredAt: number | null;
};

export function initialCommentaryState(): CommentaryState {
  return {
    started: false, startedAt: null, seq: 0, lastInputAt: null,
    lean: null, scenarios: {}, scenariosSeen: false, seenEvents: [], eventsSeen: false,
    feed: { cls: "ok", status: null, why: "", ageMs: null, since: 0 },
    read: null, queue: [], recent: {}, announced: {}, lastDeliveredAt: null,
  };
}

const cloneState = (s: CommentaryState): CommentaryState => ({
  ...s,
  lean: s.lean ? { ...s.lean } : null,
  scenarios: { ...s.scenarios },
  seenEvents: [...s.seenEvents],
  feed: { ...s.feed },
  queue: [...s.queue],
  recent: { ...s.recent },
  announced: { ...s.announced },
});

/* ── small, defensive readers ──────────────────────────────────────────────────────────────────────── */

const LEANS = Object.keys(LEAN_LABEL) as Lean[];
const SCENARIO_STATUSES: readonly ScenarioStatus[] = ["watching", "developing", "confirmed", "invalidated", "expired"];

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null;

/** Plain text, one line, bounded — anything that came off the wire is cleaned before it is said. */
export function clip(v: unknown, max = 160): string {
  const s = String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s{2,}/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1).replace(/[\s,;:—-]+\S*$/, "")}…` : s;
}

/** "price lost the shelf" → "Price lost the shelf." */
function sentence(v: unknown, max = 140): string {
  const s = clip(v, max).replace(/[.!?…]+$/, "");
  return s ? `${s[0].toUpperCase()}${s.slice(1)}.` : "";
}

const fmtPrice = (p: number) => p.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function validRead(x: unknown): AtlasRead | null {
  if (!x || typeof x !== "object") return null;
  const r = x as Partial<AtlasRead>;
  if (!LEANS.includes(r.lean as Lean) || num(r.since) == null) return null;
  return r as AtlasRead;
}

function validScenarios(x: unknown): Scenario[] {
  if (!Array.isArray(x)) return [];
  return x.filter((s): s is Scenario => !!s && typeof s === "object"
    && typeof (s as Scenario).id === "string" && SCENARIO_STATUSES.includes((s as Scenario).status));
}

type Ev = { key: string; at: number; code: string; detail: string; channel: string; lean: string; levelPrice: number | null; levelLabel: string; data: Record<string, unknown> };

function validEvents(x: unknown): Ev[] {
  if (!Array.isArray(x)) return [];
  const out: Ev[] = [];
  for (const e of x as CommentaryEventInput[]) {
    if (!e || typeof e !== "object") continue;
    const at = num(e.at), code = typeof e.code === "string" ? e.code : "";
    if (at == null || !code) continue;
    const data = e.data && typeof e.data === "object" ? e.data : {};
    const levelPrice = num(e.level?.price) ?? num(data.level);
    out.push({
      key: typeof e.key === "string" && e.key ? e.key : `${code}:${at}:${levelPrice ?? "-"}`,
      at, code, detail: clip(e.detail ?? "", 200), channel: String(e.channel ?? ""), lean: String(e.lean ?? ""),
      levelPrice, levelLabel: clip(e.level?.label ?? "", 60), data,
    });
  }
  return out;
}

/* ── the feed, honestly ────────────────────────────────────────────────────────────────────────────── */

/**
 * The feed state commentary works from. `feed.status` (atlas/feed) decides when present: LIVE and DELAYED are
 * both a working feed — DELAYED is how a polled or snapshot price is labelled in normal operation, and it would
 * flap with every poll — while STALE and RECONNECTING are degraded. Without `feed`, the legacy fields stand in:
 * a closed market is closed, and a read the server calls disconnected (older than five minutes) is degraded.
 * An analysis that has stopped updating is degraded too, whatever the price is doing.
 */
export function feedViewOf(input: CommentaryInput): FeedView {
  const f = input.feed ?? null;
  const status = f && typeof f.status === "string" ? (f.status as FeedStatus) : null;
  const ageMs = num(f?.ageMs);
  const reason = clip(f?.reason ?? input.reason ?? "", 140);
  if (input.replay || status === "demo") return { cls: "demo", status, why: "demo", ageMs };
  if (status === "closed" || (status == null && input.marketOpen === false)) return { cls: "closed", status, why: "closed", ageMs };
  if (status === "stale" || status === "reconnecting") return { cls: "degraded", status, why: reason || status, ageMs };
  if (status == null && input.connected === false) {
    const legacyAge = num(input.ageSeconds);
    return { cls: "degraded", status: "stale", why: reason || "the market read is out of date", ageMs: legacyAge != null ? legacyAge * 1000 : null };
  }
  const analysisAge = num(input.analysis?.analysisAgeMs);
  if (analysisAge != null && analysisAge > ANALYSIS_STALE_MS) return { cls: "degraded", status: status ?? "stale", why: "analysis", ageMs: analysisAge };
  return { cls: "ok", status, why: "", ageMs };
}

const ageWords = (ms: number | null): string => {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "";
  const s = Math.round(ms / 1000);
  if (s < 120) return `${s} seconds`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m} minute${m === 1 ? "" : "s"}` : `${Math.round(m / 60)} hours`;
};

/* ── words ─────────────────────────────────────────────────────────────────────────────────────────── */

const LEAN_SAID: Record<Lean, string> = {
  bullish_lean: "a bullish lean",
  bearish_lean: "a bearish lean",
  balanced: "balanced, range-bound",
  transitioning: "transitioning, no settled lean",
  insufficient_data: "not enough current data for a lean",
};
const TF_SAID: Record<string, string> = { "5m": "5-minute", "15m": "15-minute", "1h": "1-hour", "4h": "4-hour" };

function leanTail(read: AtlasRead | null, now: number): string {
  if (!read || now - (num(read.at) ?? 0) > READ_FRESH_MS || read.lean === "insufficient_data") return "";
  return ` Current read: ${LEAN_SAID[read.lean]}${read.horizonTf ? ` on the ${TF_SAID[read.horizonTf] ?? read.horizonTf}` : ""}.`;
}

function leanChangeText(from: Lean, read: AtlasRead): string {
  const tf = read.horizonTf ? ` on the ${TF_SAID[read.horizonTf] ?? read.horizonTf}` : "";
  const strength = read.strength ? ` (${read.strength})` : "";
  if (read.lean === "insufficient_data") return "I don't have enough current data to hold a lean right now, so I'm standing back.";
  const head = from === "insufficient_data"
    ? `I have a read again: ${LEAN_SAID[read.lean]}${tf}${strength}.`
    : `Read change: now ${LEAN_SAID[read.lean]}${tf}${strength}, from ${LEAN_SAID[from]}.`;
  const why = sentence(read.previous?.reason || read.evidenceFor?.[0]?.text || "", 110);
  const watch = read.nextWatch?.text ? sentence(`Watching ${read.nextWatch.text}`, 100) : "";
  return [head, why, watch].filter(Boolean).join(" ");
}

const ROLE_SAID: Record<string, string> = { base: "Base case", alternative: "Alternative scenario", view_change: "View-change scenario" };

function scenarioText(sc: Scenario, isNew: boolean, before?: ScenarioStatus): string {
  const role = ROLE_SAID[sc.role] ?? "Scenario";
  const title = clip(sc.title, 90) || "the scenario";
  const lastReason = Array.isArray(sc.history) && sc.history.length ? clip(sc.history[sc.history.length - 1]?.reason ?? "", 110) : "";
  if (isNew) return [`New ${role.toLowerCase()}: ${title}.`, sc.trigger?.text ? sentence(`Trigger: ${sc.trigger.text}`, 100) : ""].filter(Boolean).join(" ");
  switch (sc.status) {
    case "confirmed": return [`${role} confirmed: ${title}.`, sentence(lastReason || sc.trigger?.text || "", 110)].filter(Boolean).join(" ");
    case "invalidated": return [`${role} invalidated: ${title}.`, sentence(lastReason || sc.invalidation?.text || "", 110)].filter(Boolean).join(" ");
    case "developing": return [`${role} developing: ${title}.`, sc.trigger?.text ? sentence(`Trigger: ${sc.trigger.text}`, 100) : ""].filter(Boolean).join(" ");
    case "expired": return `${role} expired without triggering: ${title}.`;
    case "watching": return before === "developing"
      ? [`${role} back to watching: ${title}.`, sentence(lastReason || "The trigger didn't hold", 110)].filter(Boolean).join(" ")
      : `${role}: ${title}, watching.`;
    default: return `${role}: ${title}.`;
  }
}

/* ── watched levels ────────────────────────────────────────────────────────────────────────────────── */

type WatchWhy = "invalidation" | "member" | "next" | "scenario" | "thesis";
const WHY_RANK: Record<WatchWhy, number> = { invalidation: 5, member: 4, next: 3, scenario: 2, thesis: 1 };
const WHY_SAID: Record<WatchWhy, string> = {
  invalidation: "That's where my read fails.",
  member: "You asked me to watch that level.",
  next: "That's the level I flagged to watch.",
  scenario: "That level is a scenario trigger.",
  thesis: "It's on my watch list.",
};

/** The levels that make an interaction "watched": the read's next watch and invalidation, the thesis's
 *  watch list, live scenario triggers and invalidations, and what the member asked ATLAS to watch. */
function watchedLevels(input: CommentaryInput, read: AtlasRead | null, scenarios: Scenario[]): { price: number; why: WatchWhy }[] {
  const out: { price: number; why: WatchWhy }[] = [];
  const add = (p: unknown, why: WatchWhy) => { const n = num(p); if (n != null && n > 0) out.push({ price: n, why }); };
  const addRef = (ref: unknown, why: WatchWhy) => {
    if (!ref || typeof ref !== "object") return;
    const r = ref as { kind?: string; price?: unknown; from?: unknown; to?: unknown };
    if (r.kind === "zone") { add(r.from, why); add(r.to, why); } else add(r.price, why);
  };
  add(read?.invalidation?.price, "invalidation"); addRef(read?.invalidation?.ref, "invalidation");
  addRef(read?.nextWatch?.ref, "next");
  for (const w of Array.isArray(input.thesis?.watching) ? input.thesis!.watching! : []) add(w, "thesis");
  add(input.thesis?.invalidationPrice, "invalidation");
  for (const s of scenarios) {
    if (s.status !== "watching" && s.status !== "developing") continue;
    add(s.trigger?.price, "scenario"); add(s.invalidation?.price, "scenario");
  }
  for (const w of Array.isArray(input.watches) ? input.watches : []) add(w?.price, "member");
  return out;
}

function matchWatched(price: number | null, watched: { price: number; why: WatchWhy }[]): WatchWhy | null {
  if (price == null) return null;
  const tol = Math.max(0.5, price * 0.00015);
  let best: WatchWhy | null = null;
  for (const w of watched) {
    if (Math.abs(w.price - price) <= tol && (!best || WHY_RANK[w.why] > WHY_RANK[best])) best = w.why;
  }
  return best;
}

/* ── the queue ─────────────────────────────────────────────────────────────────────────────────────── */

type Draft = Omit<CommentaryItem, "id" | "at">;

/**
 * Queue a draft, editing as it goes.
 *
 * DEDUPE is for observations: the same perception event raised again on another horizon, or a level touched
 * every minute while price sits on it. STATE changes (lean, scenario status, feed) are not deduped on a timer —
 * a timer would swallow a real flip back — they are edited against what was last said instead: a newer state
 * supersedes the one waiting, and a state equal to the last one said is no change at all.
 */
function enqueue(s: CommentaryState, d: Draft, now: number, settings: CommentarySettings, added: CommentaryItem[], cancelled: CommentaryItem[]): void {
  // Superseded: a newer state on the same topic replaces whatever was waiting. A cancelled observation is
  // forgotten too, so it can never dedupe away a later, real repeat of itself.
  const supersede = () => {
    for (const old of s.queue.filter((q) => q.topic === d.topic)) {
      s.queue = s.queue.filter((q) => q !== old);
      if (s.recent[old.dedupeKey] === old.at) delete s.recent[old.dedupeKey];
      cancelled.push(old);
    }
  };
  if (settings.mode === "quiet" || !d.modes.includes(settings.mode)) {
    // Not volunteered in this mode, but it is on the member's screen: it becomes the state they know, and
    // whatever was waiting on the topic now describes something older.
    if (d.stateKey != null) { supersede(); s.announced[d.topic] = d.stateKey; }
    return;
  }
  const seen = s.recent[d.dedupeKey];
  if (seen != null && d.dedupeMs > 0 && now - seen < d.dedupeMs) return;
  supersede();
  // Net no change: back to what was last said (or what was on screen when we began) — nothing to say.
  if (d.stateKey != null && s.announced[d.topic] === d.stateKey) return;
  s.seq += 1;
  const item: CommentaryItem = { ...d, id: `c${s.seq}`, at: now };
  s.queue.push(item);
  s.recent[d.dedupeKey] = now;
  added.push(item);
  while (s.queue.length > MAX_QUEUE) {
    const worst = [...s.queue].sort((a, b) => a.priority - b.priority || a.at - b.at)[0];
    s.queue = s.queue.filter((q) => q !== worst);
    cancelled.push(worst);
  }
}

function cancelWhere(s: CommentaryState, pred: (i: CommentaryItem) => boolean, cancelled: CommentaryItem[]): void {
  const gone = s.queue.filter(pred);
  if (!gone.length) return;
  s.queue = s.queue.filter((i) => !pred(i));
  for (const g of gone) { if (s.recent[g.dedupeKey] === g.at) delete s.recent[g.dedupeKey]; cancelled.push(g); }
}

const BOTH: readonly CommentaryMode[] = ["watch", "copilot"];
const COPILOT: readonly CommentaryMode[] = ["copilot"];
const MIN = 60_000;

/* ── observe: one live payload in ──────────────────────────────────────────────────────────────────── */

export type ObserveResult = { state: CommentaryState; added: CommentaryItem[]; cancelled: CommentaryItem[] };

/**
 * Take one live payload. The first one only sets the baseline — what is on screen when ATLAS starts watching
 * is not news — and every later one is compared with what came before.
 */
export function observeCommentary(prev: CommentaryState, input: CommentaryInput | null | undefined, now: number, settings: CommentarySettings): ObserveResult {
  const added: CommentaryItem[] = [];
  const cancelled: CommentaryItem[] = [];
  if (!input || typeof input !== "object" || input.ok === false) return { state: prev, added, cancelled };
  const s = cloneState(prev);
  const first = !s.started;
  s.started = true;
  if (s.startedAt == null) s.startedAt = now;
  s.lastInputAt = now;

  const read = validRead(input.read);
  const scenarios = validScenarios(input.scenarios);
  const events = validEvents(input.events);
  if (read) s.read = read;

  /* ── the feed, first: it decides whether anything market-related may be said at all ── */
  const fv = feedViewOf(input);
  if (first) {
    s.feed = { ...fv, since: now };
    s.announced.feed = fv.cls;
  } else if (fv.cls !== s.feed.cls) {
    s.feed = { ...fv, since: now };
    // The waiting feed notice no longer describes the feed.
    cancelWhere(s, (i) => i.kind === "feed" && i.basis !== fv.cls, cancelled);
    // A picture that can't be vouched for is not narrated: everything market-related that was waiting goes.
    if (fv.cls !== "ok") cancelWhere(s, (i) => i.market, cancelled);
  } else {
    s.feed = { ...fv, since: s.feed.since };
  }
  if (!first && s.feed.cls !== s.announced.feed && now - s.feed.since >= FEED_DEBOUNCE_MS
      && !s.queue.some((i) => i.kind === "feed" && i.basis === s.feed.cls)) {
    const from = s.announced.feed;
    const cls = s.feed.cls;
    const text =
      cls === "degraded"
        ? (s.feed.why === "analysis"
          ? `Heads up — my market read hasn't updated for ${ageWords(s.feed.ageMs) || "several minutes"}. I'll hold market commentary until it's current again.`
          : s.feed.status === "reconnecting"
            ? "Heads up — the price feed is reconnecting. Until it's back, treat the price on screen as not current; I'm holding market commentary."
            : `Heads up — the price feed has gone stale${s.feed.ageMs != null ? `; the last price is ${ageWords(s.feed.ageMs)} old` : ""}. I'll hold market commentary until it's live again.`)
        : cls === "ok"
          ? `${from === "closed" ? "Gold has reopened." : from === "demo" ? "Back on the live market." : "The price feed is live again."}${leanTail(read ?? s.read, now)}`
          : cls === "closed"
            ? "Gold is closed now. I'll stay quiet until it reopens."
            : "This is demo data, not the live market — I won't narrate it as live.";
    enqueue(s, {
      kind: "feed", topic: "feed", dedupeKey: `feed:${cls}`, dedupeMs: 0, stateKey: cls, basis: cls,
      priority: cls === "degraded" ? 95 : cls === "ok" ? (from === "degraded" ? 72 : 50) : cls === "closed" ? 45 : 20,
      text, expiresAt: now + 10 * MIN, modes: BOTH, market: false,
    }, now, settings, added, cancelled);
  }
  const marketOk = s.feed.cls === "ok";

  /* ── lean ── */
  if (read) {
    if (!s.lean) {
      s.lean = { lean: read.lean, since: read.since };
      s.announced.lean = read.lean;
    } else if (read.lean !== s.lean.lean) {
      const from = s.lean.lean;
      s.lean = { lean: read.lean, since: read.since };
      // Whatever status line was waiting described the old read.
      cancelWhere(s, (i) => i.kind === "status", cancelled);
      if (marketOk && now - read.since <= CHANGE_FRESH_MS) {
        const toNoData = read.lean === "insufficient_data";
        enqueue(s, {
          kind: "lean", topic: "lean", dedupeKey: `lean:${from}>${read.lean}`, dedupeMs: 0,
          stateKey: read.lean, basis: read.lean,
          priority: toNoData ? 40 : from === "insufficient_data" ? 60 : 75,
          text: leanChangeText(from, read), expiresAt: now + 10 * MIN,
          modes: toNoData ? COPILOT : BOTH, market: true,
        }, now, settings, added, cancelled);
      } else {
        // Not said: while the feed is down the recovery line carries the current read instead, and a change
        // older than CHANGE_FRESH_MS (we were not watching) is history the screen already shows.
        cancelWhere(s, (i) => i.topic === "lean", cancelled);
        s.announced.lean = read.lean;
      }
    } else if (read.since !== s.lean.since) {
      // The same lean, restarted: not a material change.
      s.lean.since = read.since;
    }
  }

  /* ── scenarios ── */
  if (Array.isArray(input.scenarios)) {
    for (const sc of scenarios) {
      const before = s.scenarios[sc.id];
      s.scenarios[sc.id] = sc.status;
      if (!s.scenariosSeen) { s.announced[`scenario:${sc.id}`] = sc.status; continue; }
      const changedAt = num(sc.history?.[sc.history.length - 1]?.at) ?? num(sc.updatedAt) ?? now;
      const fresh = now - changedAt <= CHANGE_FRESH_MS;
      if (before === undefined) {
        s.announced[`scenario:${sc.id}`] = sc.status;
        if (marketOk && fresh && sc.role === "base" && (sc.status === "watching" || sc.status === "developing")) {
          enqueue(s, {
            kind: "scenario", topic: `scenario:${sc.id}`, dedupeKey: `scenario:${sc.id}:new`, dedupeMs: 30 * MIN,
            stateKey: null, basis: sc.status, priority: 30, text: scenarioText(sc, true),
            expiresAt: now + 10 * MIN, modes: COPILOT, market: true,
          }, now, settings, added, cancelled);
        }
        continue;
      }
      if (before === sc.status) continue;
      if (!marketOk || !fresh) {
        cancelWhere(s, (i) => i.topic === `scenario:${sc.id}`, cancelled);
        s.announced[`scenario:${sc.id}`] = sc.status;
        continue;
      }
      const terminal = sc.status === "confirmed" || sc.status === "invalidated";
      enqueue(s, {
        kind: "scenario", topic: `scenario:${sc.id}`, dedupeKey: `scenario:${sc.id}:${sc.status}`, dedupeMs: 0,
        stateKey: sc.status, basis: sc.status,
        priority: sc.status === "invalidated" ? (sc.role === "base" ? 88 : 85) : sc.status === "confirmed" ? 84 : sc.status === "developing" ? 45 : 25,
        text: scenarioText(sc, false, before), expiresAt: now + 10 * MIN,
        modes: terminal ? BOTH : COPILOT, market: true,
      }, now, settings, added, cancelled);
    }
    s.scenariosSeen = true;
    // Bounded: a long session must not grow this without limit.
    const ids = Object.keys(s.scenarios);
    if (ids.length > 60) for (const id of ids.slice(0, ids.length - 60)) delete s.scenarios[id];
  }

  /* ── perception events: structure, watched levels, news ── */
  const watched = watchedLevels(input, read, scenarios);
  const fresh: Ev[] = [];
  if (Array.isArray(input.events)) {
    const seen = new Set(s.seenEvents);
    for (const e of events) {
      if (seen.has(e.key)) continue;
      seen.add(e.key);
      s.seenEvents.push(e.key);
      if (s.eventsSeen && now - e.at <= EVENT_FRESH_MS) fresh.push(e);
    }
    s.eventsSeen = true;
    if (s.seenEvents.length > 400) s.seenEvents = s.seenEvents.slice(-400);
  }
  for (const e of [...fresh].sort((a, b) => a.at - b.at)) {
    if (!marketOk && e.code !== "NEWS_APPROACHING") continue;
    const dir = String(e.data.direction ?? (e.lean === "bullish" ? "up" : e.lean === "bearish" ? "down" : "-"));
    const why = matchWatched(e.levelPrice, watched);

    if (e.code === "STRUCTURE_BREAK" || e.code === "BREAKOUT_CONFIRMED" || e.code === "FAILED_BREAKOUT" || e.code === "STRUCTURE_RECLAIM") {
      const reclaim = e.code === "STRUCTURE_RECLAIM";
      const lead = e.code === "FAILED_BREAKOUT" ? "" : "Confirmed: ";
      const text = [`${lead}${sentence(e.detail || e.code.toLowerCase().replace(/_/g, " "), 140)}`, why ? WHY_SAID[why] : ""].filter(Boolean).join(" ");
      enqueue(s, {
        kind: "structure", topic: "structure", dedupeKey: `structure:${e.code}:${dir}`, dedupeMs: 15 * MIN,
        stateKey: null, basis: null, priority: reclaim ? 45 : e.code === "FAILED_BREAKOUT" ? 68 : 70,
        text, expiresAt: now + 6 * MIN, modes: reclaim ? COPILOT : BOTH, market: true,
      }, now, settings, added, cancelled);
      continue;
    }

    const family =
      e.code === "LEVEL_TOUCH" ? "touch" : e.code === "LEVEL_ACCEPTANCE" ? "accept" : e.code === "LEVEL_REJECTION" ? "reject"
      : e.code === "RETEST_HOLDING" ? "retest-hold" : e.code === "RETEST_FAILING" ? "retest-fail"
      : e.code === "BREAKOUT_ATTEMPT" ? "attempt" : e.code === "LEVEL_APPROACH" ? "approach" : e.code === "LIQUIDITY_SWEEP" ? "sweep" : null;
    if (family && e.levelPrice != null) {
      const loud = e.channel === "voice" || e.channel === "urgent";
      if (!why && !loud) continue;
      const base = family === "accept" || family === "reject" || family === "retest-hold" || family === "retest-fail" ? 65
        : family === "sweep" ? 60 : family === "touch" ? 55 : family === "attempt" ? 50 : 35;
      const modes = why && family !== "approach" && family !== "attempt" ? BOTH : COPILOT;
      const text = [sentence(e.detail || `${family} at ${fmtPrice(e.levelPrice)}`, 150), why ? WHY_SAID[why] : ""].filter(Boolean).join(" ");
      enqueue(s, {
        kind: "level", topic: `level:${e.levelPrice.toFixed(1)}`, dedupeKey: `level:${e.levelPrice.toFixed(1)}:${family}`, dedupeMs: 10 * MIN,
        stateKey: null, basis: null, priority: why ? base : base - 20,
        text, expiresAt: now + 4 * MIN, modes, market: true,
      }, now, settings, added, cancelled);
      continue;
    }

    if (e.code === "NEWS_APPROACHING") {
      const importance = String(e.data.importance ?? "").toLowerCase();
      const mins = num(e.data.minutes);
      if (importance !== "high" || mins == null) continue;
      const name = clip(e.detail.replace(/\s+is\s+\d+\s+minutes?\s+away\.?$/i, ""), 80);
      newsItem(s, name, e.at + mins * MIN, now, settings, added, cancelled);
    }
  }

  /* ── the calendar (intel.news), which carries the release time itself ── */
  const n = input.intel?.news;
  if (n && String(n.importance ?? "").toLowerCase() === "high" && n.name) {
    const at = num(n.at) ?? (num(n.minutesTo) != null && num(input.at) != null ? num(input.at)! + num(n.minutesTo)! * MIN : null);
    if (at != null) newsItem(s, clip(n.name, 80), at, now, settings, added, cancelled);
  }

  /* ── Session copilot: a short status line when the desk has been quiet a while ── */
  if (settings.mode === "copilot" && marketOk && read && read.lean !== "insufficient_data"
      && now - (num(read.at) ?? 0) <= READ_FRESH_MS && !s.queue.length
      && now - (s.lastDeliveredAt ?? s.startedAt ?? now) >= statusEveryMs(settings)) {
    const summary = sentence(read.summary, 200);
    if (summary) {
      enqueue(s, {
        kind: "status", topic: "status", dedupeKey: `status:${summary}`, dedupeMs: 30 * MIN,
        stateKey: null, basis: read.lean, priority: 10, text: `Status check — ${summary}`,
        expiresAt: now + 2 * MIN, modes: COPILOT, market: true,
      }, now, settings, added, cancelled);
    }
  }

  return { state: s, added, cancelled };
}

function newsItem(s: CommentaryState, name: string, releaseAt: number, now: number, settings: CommentarySettings, added: CommentaryItem[], cancelled: CommentaryItem[]): void {
  const mins = (releaseAt - now) / MIN;
  if (!name || mins <= 0 || mins > NEWS_WINDOW_MIN) return;
  const whole = Math.max(1, Math.round(mins));
  enqueue(s, {
    kind: "news", topic: `news:${name.toLowerCase()}`, dedupeKey: `news:${name.toLowerCase()}`, dedupeMs: 2 * 60 * MIN,
    stateKey: null, basis: null, priority: mins <= 5 ? 92 : 80,
    text: `High-impact news: ${name} in ${whole} minute${whole === 1 ? "" : "s"}. Expect a volatility spike and wider spreads around the release.`,
    // A calendar fact, not a price: still true while the feed is stale.
    expiresAt: releaseAt, modes: BOTH, market: false,
  }, now, settings, added, cancelled);
}

/* ── take: the next thing worth saying, if it is time ──────────────────────────────────────────────── */

export type TakeResult = { state: CommentaryState; item: CommentaryItem | null; dropped: CommentaryItem[] };

/** Is this item still true and still worth saying? */
function stillTrue(i: CommentaryItem, s: CommentaryState, now: number): boolean {
  if (now >= i.expiresAt) return false;
  if (i.market && s.feed.cls !== "ok") return false;
  switch (i.kind) {
    case "lean": case "status": return s.lean?.lean === i.basis;
    case "scenario": return s.scenarios[i.topic.slice("scenario:".length)] === i.basis;
    case "feed": return s.feed.cls === i.basis;
    default: return true;
  }
}

/**
 * The next item to deliver, or nothing. Called when the channel is free (VoiceSession decides that: on a call,
 * not while anyone is talking). Drops what expired or stopped being true, holds market items while no fresh
 * payload has arrived, and respects the mode's cooldown — urgent items may jump it, down to URGENT_FLOOR_MS.
 */
export function takeNextCommentary(prev: CommentaryState, now: number, settings: CommentarySettings): TakeResult {
  const dropped: CommentaryItem[] = [];
  if (settings.mode === "quiet") {
    if (!prev.queue.length) return { state: prev, item: null, dropped };
    const s = cloneState(prev);
    dropped.push(...s.queue);
    s.queue = [];
    return { state: s, item: null, dropped };
  }
  const s = cloneState(prev);
  for (const i of s.queue) if (!stillTrue(i, s, now) || !i.modes.includes(settings.mode)) dropped.push(i);
  if (dropped.length) s.queue = s.queue.filter((i) => !dropped.includes(i));

  const inputStale = s.lastInputAt == null || now - s.lastInputAt > INPUT_STALE_MS;
  const gap = s.lastDeliveredAt == null ? Number.POSITIVE_INFINITY : now - s.lastDeliveredAt;
  const cooldown = commentaryCooldownMs(settings);
  const next = s.queue
    .filter((i) => !(i.market && inputStale))
    .sort((a, b) => b.priority - a.priority || a.at - b.at)
    .find((i) => gap >= (i.priority >= URGENT_PRIORITY ? URGENT_FLOOR_MS : cooldown)) ?? null;
  if (!next) return { state: s, item: null, dropped };

  s.queue = s.queue.filter((i) => i !== next);
  s.lastDeliveredAt = now;
  s.recent[next.dedupeKey] = now;
  if (next.stateKey != null) s.announced[next.topic] = next.stateKey;
  return { state: s, item: next, dropped };
}

/** Switching modes: anything waiting that the new mode would not say is dropped (all of it, for Quiet). */
export function retuneCommentary(prev: CommentaryState, settings: CommentarySettings): CommentaryState {
  const keep = prev.queue.filter((i) => settings.mode !== "quiet" && i.modes.includes(settings.mode));
  return keep.length === prev.queue.length ? prev : { ...cloneState(prev), queue: keep };
}

/* ── the volunteered turn (voice) ──────────────────────────────────────────────────────────────────── */

/**
 * HOW A VOLUNTEERED LINE REACHES THE VOICE, AND WHY IT IS A `user_message`.
 *
 * The provider documents two client→server text events. `contextual_update` informs the agent "without
 * prompting a reply", and is filed in its history as a tool call, which our reasoning endpoint never reads
 * because it rebuilds the market context itself every turn. ATLAS would say nothing. `user_message` "will
 * prompt the agent to take its turn", which makes it the only supported way for the browser to have the agent
 * speak at a moment of the browser's choosing.
 *
 * So a volunteered line travels as a user_message carrying this mark, and brain/voiceLlm.ts recognises it.
 * It speaks the line verbatim (no model call, no journal entry), and never treats it as something the trader
 * said: it is kept out of the question, out of the stated-trade parser, and replaced in history by
 * VOLUNTEERED_NOTE.
 */
export const VOLUNTEERED_MARK = "[[ATLAS:VOLUNTEERED]]";
export const VOLUNTEERED_NOTE = "(The trader said nothing here. ATLAS volunteered the update that follows.)";
export const VOLUNTEERED_MAX_CHARS = 400;

/** Clean a line for speaking: no markers, no control characters, no markdown, bounded. */
export function cleanVolunteeredLine(v: unknown): string {
  return String(v ?? "")
    .replace(/\[\[[^\]]*\]\]/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[*_`#]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, VOLUNTEERED_MAX_CHARS);
}

/** The user_message text that carries a volunteered line. */
export function volunteeredTurn(line: string): string {
  return `${VOLUNTEERED_MARK} ${cleanVolunteeredLine(line)}`;
}

export function isVolunteeredTurn(raw: unknown): boolean {
  return typeof raw === "string" && raw.trimStart().startsWith(VOLUNTEERED_MARK);
}

/** The line inside a volunteered turn, cleaned — or null when this is not one (or it is empty). */
export function parseVolunteeredTurn(raw: unknown): string | null {
  if (!isVolunteeredTurn(raw)) return null;
  const line = cleanVolunteeredLine((raw as string).trimStart().slice(VOLUNTEERED_MARK.length));
  return line || null;
}
