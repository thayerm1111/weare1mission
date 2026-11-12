/**
 * THE IDEA DESK — everything around one ATLAS trade idea that touches the outside world.
 *
 * engines/idea.ts decides what the idea IS, purely. This file gathers what it needs at the moment a member
 * presses GENERATE (the same snapshot, setup and read the screen is showing), keeps the idea so it can be
 * followed later, and follows it on real candles when asked.
 *
 * WHAT THIS FILE NEVER DOES. It never places, sizes or changes an order, and it never widens what the
 * member is allowed to do. Taking an idea goes through the existing trade route — ATLAS's own take-setup
 * path when the idea is the setup engine's trade, the member's manual path otherwise — with that route's
 * validation, consent and idempotency untouched. The only thing an idea can ARM is an informational watch,
 * the same one a member gets by typing "watch 4371 for me".
 *
 * Everything that reads or writes cc_ideas fails soft: without the table an idea is still generated, it is
 * simply not kept, and the caller is told so.
 */
import { db, latestWithBars, loadRolling, chartBarsFor, recentAtlasReads } from "../adapters/db";
import type { Bar, MarketSnapshot, Timeframe } from "../core/types";
import { PIP, TF_MINUTES } from "../core/types";
import { marketOpen } from "../core/sessions";
import { feedOfSnapshot, analysisMeta } from "../core/feed";
import type { AnalysisMeta, FeedState } from "../core/atlasContract";
import { LEAN_LABEL, type AtlasRead } from "../core/atlasContract";
import { signed } from "../core/read";
import { priceNow } from "../core/priceNow";
import { diffSet } from "../brain/diff";
import { findSetup, noSetup, type BrainSetup } from "./setup";
import { getProfile, asSetupProfile } from "./profile";
import { tradeState } from "./tradeLive";
import { liveGoldPrice, withLivePrice } from "./livePrice";
import { liveReadFields, STALE_MS } from "./live";
import { selectedAccount } from "./broker";
import { parseWatch, arm } from "./watch";
import {
  IDEA_VERSIONS, buildIdea, followIdea, ideaOptionsOf, ideaRecord,
  type AtlasIdea, type IdeaFollow, type IdeaOptions, type IdeaState,
} from "./idea";

export type Generated = {
  idea: AtlasIdea;
  /** False when the idea could not be kept (the table is missing or the write failed). */
  saved: boolean;
  feed: FeedState;
  analysis: AnalysisMeta;
  /** How long each real stage took, so the screen's progress is a measurement and not a performance. */
  timings: { loadMs: number; engineMs: number; readMs: number; totalMs: number };
};

/** Is the style-filtered setup the very trade the trade card shows and the server would recompute? */
const sameTrade = (a: BrainSetup, b: BrainSetup): boolean =>
  a.state === b.state && a.side === b.side && a.style === b.style && a.stop === b.stop && a.invalidationPrice === b.invalidationPrice;

/** The engine's own inputs, assembled exactly as engines/live.ts assembles them for the screen. */
async function marketNow(userId: string, options: IdeaOptions, now: number) {
  const open = marketOpen(now);
  const latest = await latestWithBars();
  if (!latest) return { open, latest: null as null };
  const stale = now - latest.at > STALE_MS;
  const [rolling, livePx, profile] = await Promise.all([
    loadRolling(),
    open && !stale ? liveGoldPrice() : Promise.resolve(null),
    getProfile(userId),
  ]);
  const s: MarketSnapshot = withLivePrice(latest.snapshot, livePx);
  const diffs = diffSet(s, rolling.snapshots.filter((x) => x.at < s.at));
  const openThesis = [...rolling.theses].reverse().find((t) => !t.endedAt) ?? null;
  const base = {
    snapshot: s, diffs, marketOpen: open && !stale,
    thesisBias: openThesis?.bias ?? null, thesisConfidence: openThesis?.confidence ?? null,
  };
  const own = asSetupProfile(profile);
  // What the trade card shows and take-setup recomputes: no style filter.
  const pick = findSetup({ ...base, profile: own });
  const setup = options.style === "auto" ? pick : findSetup({
    ...base,
    profile: { ...own, allowQuick: options.style === "quick", allowHold: options.style === "hold", allowSwing: options.style === "swing" },
  });
  return { open, latest, stale, s, diffs, profile, pick, setup, providerAt: livePx?.providerAt ?? null };
}

/**
 * GENERATE. One idea from the market as it stands, stored so it can be followed.
 */
export async function generateIdea(userId: string, rawOptions: unknown): Promise<Generated> {
  const t0 = Date.now();
  const options = ideaOptionsOf(rawOptions);
  const m = await marketNow(userId, options, t0);
  const t1 = Date.now();

  if (!m.latest) {
    const idea = buildIdea({
      snapshot: null, setup: noSetup("I can't see gold right now, so I'm not looking for a trade.", [], "blocked", t0),
      takeable: false, read: null, options, marketOpen: m.open, now: t0,
    });
    return {
      idea, saved: false,
      feed: feedOfSnapshot(null, { now: t0, marketOpen: m.open }),
      analysis: analysisMeta(null, null, t0),
      timings: { loadMs: t1 - t0, engineMs: 0, readMs: 0, totalMs: Date.now() - t0 },
    };
  }

  const { latest, s, diffs, profile, pick, setup, stale, open } = m;
  const trade = await tradeState(userId, s, diffs);
  const t2 = Date.now();
  // The read the screen shows: the worker's stored read for this snapshot, or one computed from it.
  const fields = await liveReadFields({
    snapshot: latest.snapshot, snapshotId: latest.id, bars5m: latest.bars, marketIsOpen: open,
    setupState: pick.state, tradeActive: trade.active, historySince: t0 - 24 * 3600_000, now: t0,
  });
  const t3 = Date.now();

  const takeable = options.style === "auto" || sameTrade(setup, pick);
  const idea = buildIdea({
    snapshot: s, snapshotId: latest.id, setup, takeable, read: fields.read, scenarios: fields.scenarios, options,
    marketOpen: open, stale, tradeActive: trade.active, minConfidence: profile.minConfidence,
    enginePick: takeable ? null : pick, pipSize: PIP, now: t0,
  });

  const id = await saveIdea(userId, idea);
  if (id) idea.id = id;
  return {
    idea, saved: !!id,
    feed: feedOfSnapshot(s, { now: Date.now(), marketOpen: open, providerTs: s.live?.source === "stream" ? m.providerAt : null }),
    analysis: analysisMeta(latest.snapshot, latest.id, Date.now()),
    timings: { loadMs: t1 - t0, engineMs: t2 - t1, readMs: t3 - t2, totalMs: Date.now() - t0 },
  };
}

/* ── keeping ideas ─────────────────────────────────────────────────────────────────────────────────── */

async function saveIdea(userId: string, idea: AtlasIdea): Promise<string | null> {
  const c = db();
  if (!c) return null;
  try {
    const { data, error } = await c.from("cc_ideas").insert({
      user_id: userId,
      created_at: new Date(idea.at).toISOString(),
      snapshot_id: idea.snapshotId,
      snapshot_at: idea.snapshotAt != null ? new Date(idea.snapshotAt).toISOString() : null,
      version: idea.version,
      kind: idea.kind,
      source: idea.source,
      side: idea.side,
      style: idea.style,
      price_at: idea.price,
      entry: idea.entry?.price ?? null,
      stop: idea.stop?.price ?? null,
      tp1: idea.targets[0]?.price ?? null,
      idea,
      options: idea.options,
      status: idea.kind === "stand_aside" ? "none" : "new",
      expires_at: idea.expiresAt != null ? new Date(idea.expiresAt).toISOString() : null,
    }).select("id").single();
    if (error || !data) return null;
    return String((data as { id: string }).id);
  } catch { return null; }
}

export type IdeaRow = { id: string; at: number; idea: AtlasIdea; status: IdeaState | "new"; follow: IdeaFollow | null; gradedAt: number | null };

const looksLikeIdea = (x: unknown): x is AtlasIdea => {
  if (!x || typeof x !== "object") return false;
  const i = x as Partial<AtlasIdea>;
  // Ideas stored under an earlier version are still a member's record: every version whose shape this reads.
  return typeof i.version === "string" && IDEA_VERSIONS.includes(i.version) && typeof i.at === "number" && typeof i.kind === "string" && Array.isArray(i.targets) && typeof i.headline === "string";
};

function rowOf(r: Record<string, unknown>): IdeaRow | null {
  if (!looksLikeIdea(r.idea)) return null;
  const idea = { ...(r.idea as AtlasIdea), id: String(r.id) };
  return {
    id: String(r.id), at: Date.parse(String(r.created_at)), idea,
    status: String(r.status ?? "new") as IdeaRow["status"],
    follow: (r.result ?? null) as IdeaFollow | null,
    gradedAt: r.graded_at ? Date.parse(String(r.graded_at)) : null,
  };
}

async function loadIdea(userId: string, id: string): Promise<IdeaRow | null> {
  const c = db();
  if (!c || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  try {
    const { data, error } = await c.from("cc_ideas").select("id, created_at, idea, status, result, graded_at").eq("id", id).eq("user_id", userId).maybeSingle();
    if (error || !data) return null;
    return rowOf(data as Record<string, unknown>);
  } catch { return null; }
}

/** A result that will not change any more. */
const SETTLED: (IdeaState | "new")[] = ["tp3", "stopped", "invalidated", "expired", "none"];
const isSettled = (st: IdeaState | "new", follow: IdeaFollow | null) => SETTLED.includes(st) || (follow?.stopped ?? false);

/* ── following ─────────────────────────────────────────────────────────────────────────────────────── */

type Candles = { bars: Partial<Record<Timeframe, Bar[]>> };

/** The finest stored candles that reach back to when the idea was generated. */
function barsFor(c: Candles, since: number): { bars: Bar[]; tf: Timeframe } {
  for (const tf of ["5m", "15m", "1h"] as Timeframe[]) {
    const b = c.bars[tf] ?? [];
    if (b.length && b[0].t <= since + TF_MINUTES[tf] * 60_000) return { bars: b, tf };
  }
  // Nothing reaches back that far: grade on the longest history there is, and the basis line says which.
  const tf: Timeframe = (c.bars["1h"]?.length ? "1h" : c.bars["15m"]?.length ? "15m" : "5m");
  return { bars: c.bars[tf] ?? [], tf };
}

/** ATLAS's lean over a window, oldest first, one entry per change. */
async function leansSince(since: number): Promise<{ at: number; lean: string }[]> {
  const rows = (await recentAtlasReads({ sinceMs: since - 6 * 3600_000, limit: 600 })).sort((a, b) => a.at - b.at);
  const out: { at: number; lean: string }[] = [];
  for (const r of rows) if (!out.length || out[out.length - 1].lean !== r.lean) out.push({ at: r.at, lean: r.lean });
  return out;
}

async function storeFollow(userId: string, id: string, follow: IdeaFollow): Promise<void> {
  const c = db();
  if (!c) return;
  try {
    await c.from("cc_ideas").update({ status: follow.state, result: follow, graded_at: new Date(follow.at).toISOString() }).eq("id", id).eq("user_id", userId);
  } catch { /* the grade is recomputed next time */ }
}

export type IdeaUpdate = {
  follow: IdeaFollow;
  /** What ATLAS thinks at this moment, beside what it thought then. */
  now: { price: number | null; lean: string | null; leanLabel: string | null; score: number | null; engine: { state: string; headline: string; side: string | null; style: string | null } | null };
  /** One or two sentences: is this idea still the idea? */
  verdict: string;
};

/** The sentence under "Get update": the candles' verdict, then whether ATLAS still agrees with itself. */
export function updateVerdict(idea: AtlasIdea, follow: IdeaFollow, read: AtlasRead | null, engine: BrainSetup | null): string {
  if (["tp1", "tp2", "tp3", "stopped", "invalidated", "expired", "none"].includes(follow.state)) return follow.text;
  const want = idea.side === "buy" ? "bullish_lean" : "bearish_lean";
  const parts: string[] = [follow.text];
  if (idea.source === "read_plan" && read && read.lean !== "insufficient_data") {
    parts.push(read.lean === want
      ? `ATLAS's read still agrees: ${LEAN_LABEL[read.lean].toLowerCase()}${read.strength ? `, ${read.strength}` : ""} (evidence ${signed(read.score)}).`
      : `ATLAS's read is now ${LEAN_LABEL[read.lean].toLowerCase()} (evidence ${signed(read.score)}) — that is no longer this plan's read. Generate a fresh idea.`);
  }
  if (idea.source === "forced_read" && read && read.lean !== "insufficient_data") {
    // A forced read stood on a tilt of the evidence, not on a lean: say where that tilt is now.
    const tilt = read.lean === "bullish_lean" ? 1 : read.lean === "bearish_lean" ? -1 : Math.sign(read.score);
    const mine = idea.side === "buy" ? 1 : -1;
    parts.push(tilt === mine
      ? `The evidence still tilts ${mine > 0 ? "up" : "down"}: ${LEAN_LABEL[read.lean].toLowerCase()}, ${signed(read.score)} of 100.`
      : tilt === 0 ? `The evidence is now dead even (${LEAN_LABEL[read.lean].toLowerCase()}) — this forced read has nothing behind it but its stop.`
      : `The evidence now tilts the other way: ${LEAN_LABEL[read.lean].toLowerCase()}, ${signed(read.score)} of 100. This forced read no longer has even that behind it — generate a fresh one.`);
  }
  if (idea.source === "setup_engine" && engine) {
    const same = engine.side === idea.side && engine.style === idea.style;
    parts.push(same && engine.state === "trade_ready" ? "The setup engine has this trade ready right now."
      : same ? `The setup engine still has this side: ${engine.headline.toLowerCase()}.`
      : `The setup engine has moved on: ${engine.say}`);
  } else if (engine?.state === "trade_ready" && engine.side) {
    parts.push(`The setup engine now has its own trade ready (${engine.side}). Generate again to see it.`);
  }
  return parts.join(" ");
}

/**
 * GET UPDATE / CHECK RESULT. Follow a stored idea on the candles since it was generated, with the freshest
 * price, and say whether ATLAS still agrees with it.
 */
export async function followStoredIdea(userId: string, id: string): Promise<{ row: IdeaRow; update: IdeaUpdate } | null> {
  const row = await loadIdea(userId, id);
  if (!row) return null;
  const now = Date.now();
  const options = row.idea.options ?? { style: "auto" as const };
  const [m, chart, leans] = await Promise.all([
    marketNow(userId, options, now),
    chartBarsFor(["5m", "15m", "1h"]),
    row.idea.source === "read_plan" ? leansSince(row.idea.at) : Promise.resolve([]),
  ]);
  const price = m.latest && !m.stale ? priceNow(m.s) : null;
  const { bars, tf } = barsFor(chart, row.idea.at);
  const follow = followIdea(row.idea, { price, bars, tf, now, leans, pipSize: PIP });

  let read: AtlasRead | null = null;
  if (m.latest && !isSettled(follow.state, follow)) {
    try {
      const f = await liveReadFields({
        snapshot: m.latest.snapshot, snapshotId: m.latest.id, bars5m: m.latest.bars, marketIsOpen: m.open,
        setupState: m.pick.state, tradeActive: false, historySince: now - 6 * 3600_000, now,
      });
      read = f.read;
    } catch { /* the verdict simply says less */ }
  }
  const engine = m.latest ? m.pick : null;
  await storeFollow(userId, id, follow);
  return {
    row: { ...row, status: follow.state, follow, gradedAt: now },
    update: {
      follow,
      now: {
        price,
        lean: read?.lean ?? null, leanLabel: read ? LEAN_LABEL[read.lean] : null, score: read ? Math.round(read.score) : null,
        engine: engine ? { state: engine.state, headline: engine.headline, side: engine.side, style: engine.style } : null,
      },
      verdict: updateVerdict(row.idea, follow, read, engine),
    },
  };
}

export type IdeaList = {
  ideas: { id: string; at: number; headline: string; badge: string; kind: string; source: string | null; side: string | null; style: string | null; state: IdeaState | "new"; pips: number | null; text: string | null }[];
  record: ReturnType<typeof ideaRecord> & { since: number | null; total: number };
  /** False when ideas are not being kept (the table is missing): the screen says so instead of showing an empty record. */
  kept: boolean;
};

/**
 * A member's recent ideas and their record. Ideas that are still undecided are followed again here (a few
 * at a time, on candles already loaded), so the record is current without a worker of its own.
 */
export async function listIdeas(userId: string, limit = 10): Promise<IdeaList> {
  const empty: IdeaList = { ideas: [], record: { ...ideaRecord([]), since: null, total: 0 }, kept: false };
  const c = db();
  if (!c) return empty;
  let rows: IdeaRow[];
  try {
    const { data, error } = await c.from("cc_ideas").select("id, created_at, idea, status, result, graded_at")
      .eq("user_id", userId).order("created_at", { ascending: false }).limit(120);
    if (error || !data) return empty;
    rows = (data as Record<string, unknown>[]).map(rowOf).filter((r): r is IdeaRow => !!r);
  } catch { return empty; }

  const now = Date.now();
  const open = rows.filter((r) => r.idea.kind !== "stand_aside" && !isSettled(r.status, r.follow) && now - r.at < 3 * 24 * 3600_000).slice(0, 8);
  if (open.length) {
    try {
      const oldest = Math.min(...open.map((r) => r.at));
      const [chart, latest, leans] = await Promise.all([chartBarsFor(["5m", "15m", "1h"]), latestWithBars(), leansSince(oldest)]);
      const fresh = latest && now - latest.at <= STALE_MS ? latest.snapshot.price : null;
      for (const r of open) {
        const { bars, tf } = barsFor(chart, r.at);
        const follow = followIdea(r.idea, { price: fresh, bars, tf, now, leans: r.idea.source === "read_plan" ? leans : [], pipSize: PIP });
        r.status = follow.state; r.follow = follow; r.gradedAt = now;
        void storeFollow(userId, r.id, follow);
      }
    } catch { /* show what was stored */ }
  }

  const trades = rows.filter((r) => r.idea.kind !== "stand_aside");
  return {
    kept: true,
    ideas: rows.slice(0, Math.max(1, Math.min(30, limit))).map((r) => ({
      id: r.id, at: r.at, headline: r.idea.headline, badge: r.idea.badge, kind: r.idea.kind, source: r.idea.source,
      side: r.idea.side, style: r.idea.style, state: r.status, pips: r.follow?.pips ?? null, text: r.follow?.text ?? null,
    })),
    record: {
      ...ideaRecord(trades.map((r) => ({ state: (r.status === "new" ? "waiting" : r.status) as IdeaState, pips: r.follow?.pips ?? null }))),
      since: trades.length ? trades[trades.length - 1].at : null,
      total: trades.length,
    },
  };
}

/* ── the one thing an idea may arm ─────────────────────────────────────────────────────────────────── */

/**
 * Have ATLAS watch a stored idea's entry. The price comes from the stored idea, never from the request, and
 * the watch is INFORMATIONAL: it tells the member, it can never act. Written before it is confirmed — the
 * watch engine's own rule.
 */
export async function watchIdea(userId: string, id: string): Promise<{ ok: boolean; message: string }> {
  const row = await loadIdea(userId, id);
  if (!row) return { ok: false, message: "I couldn't find that idea." };
  const w = row.idea.watch;
  if (!w) return { ok: false, message: "There is nothing to watch on that idea — its entry is already here, or it has none." };
  const latest = await latestWithBars();
  const parsed = parseWatch(w.say, latest?.snapshot ?? null);
  if (!parsed || parsed.levelPrice == null || Math.abs(parsed.levelPrice - w.price) > 0.011) {
    return { ok: false, message: "I could not register that watch, so I'm not going to tell you I'm watching it." };
  }
  const account = await selectedAccount(userId).catch(() => null);
  const watch = await arm({
    userId, said: `ATLAS idea — ${row.idea.headline}: ${w.say}`, parsed: { ...parsed, direction: w.direction },
    accountRowId: account?.id ?? null, positionId: null, authority: "informational",
  });
  if (!watch) return { ok: false, message: "I could not register that watch, so I'm not going to tell you I'm watching it. Try again in a moment." };
  return { ok: true, message: `${parsed.confirm} It's registered, so it survives you closing this.` };
}
