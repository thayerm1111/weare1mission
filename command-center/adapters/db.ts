/**
 * SUPABASE ADAPTER — the Command Center's own persistence. Service role, server-side only.
 *
 * It writes to cc_* tables and nothing else. No engine calls this directly with raw SQL; every table has one
 * function here, so the schema has exactly one place that knows about it.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Bar, MarketSnapshot } from "../core/types";
import type { BrainState, BrainStatement, BrainThesis, PerceptionEvent } from "../brain/types";
import { emptyRolling, type Rolling } from "../brain/memory";
// ATLAS READ (cc_atlas_reads) — see the block at the end of this file.
import type { Timeframe } from "../core/types";
import type { AtlasRead, Lean, Scenario } from "../core/atlasContract";
import { readFromStored } from "../core/read";
import { scenarioLooksValid } from "../core/scenarios";

let _db: SupabaseClient | null = null;

export function db(): SupabaseClient | null {
  if (_db) return _db;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  _db = createClient(url, key, { auth: { persistSession: false } });
  return _db;
}

/** Persist a snapshot. Returns its id so a decision can point at the exact market it was taken from. */
export async function saveSnapshot(s: MarketSnapshot): Promise<number | null> {
  const c = db();
  if (!c) return null;
  const { data, error } = await c.from("cc_snapshots").insert({
    at: new Date(s.at).toISOString(),
    snapshot_version: s.snapshotVersion,
    price: s.price, bid: s.bid, ask: s.ask, spread: s.spread,
    session: s.session, regime: s.regime, pressure_net: s.pressure.net,
    timeframes: Object.fromEntries(Object.entries(s.timeframes).map(([tf, v]) => [tf, { state: v!.state, features: v!.features, structure: v!.structure }])),
    levels: s.levels, feeds: s.feeds,
    warnings: s.warnings,
  }).select("id").single();
  if (error) return null;
  return (data as { id: number }).id;
}

/** The newest snapshot, for the API and the UI. */
export async function latestSnapshot(): Promise<{ id: number; row: Record<string, unknown> } | null> {
  const c = db();
  if (!c) return null;
  const { data } = await c.from("cc_snapshots").select("*").order("at", { ascending: false }).limit(1).maybeSingle();
  return data ? { id: (data as { id: number }).id, row: data as Record<string, unknown> } : null;
}

export async function audit(e: {
  actor: string; action: string; reason?: string; price?: number | null;
  snapshotVersion?: string | null; userId?: string | null; accountId?: string | null; finalState?: string | null;
  riskBefore?: unknown; riskAfter?: unknown; apiResult?: unknown;
}): Promise<void> {
  const c = db();
  if (!c) return;
  try {
    await c.from("cc_audit").insert({
      actor: e.actor, action: e.action, reason: e.reason ?? null, price: e.price ?? null,
      snapshot_version: e.snapshotVersion ?? null, user_id: e.userId ?? null, account_id: e.accountId ?? null,
      risk_before: e.riskBefore ?? null, risk_after: e.riskAfter ?? null, api_result: e.apiResult ?? null,
      final_state: e.finalState ?? null,
    });
  } catch { /* the audit trail must never break the thing it is recording */ }
}

/** Snapshots are written often and read rarely; keep a rolling window rather than growing forever. */
export async function pruneSnapshots(keepDays = 14): Promise<void> {
  const c = db();
  if (!c) return;
  try { await c.from("cc_snapshots").delete().lt("at", new Date(Date.now() - keepDays * 86_400_000).toISOString()); } catch { /* best effort */ }
}

/* ══════════════════════════════════════════════════════════════════════════════
   ATLAS — perception, opinions and memory.
   Same rule as above: one function per table, so the schema has one place that knows it.
   ══════════════════════════════════════════════════════════════════════════════ */

/** Snapshot plus the candles it was read from, so the price map draws exactly what the engine saw. */
export async function saveSnapshotWithBars(s: MarketSnapshot, bars5m: Bar[]): Promise<number | null> {
  const c = db();
  if (!c) return null;
  const { data, error } = await c.from("cc_snapshots").insert({
    at: new Date(s.at).toISOString(),
    snapshot_version: s.snapshotVersion,
    price: s.price, bid: s.bid, ask: s.ask, spread: s.spread,
    session: s.session, regime: s.regime, pressure_net: s.pressure.net,
    timeframes: Object.fromEntries(Object.entries(s.timeframes).map(([tf, v]) => [tf, { state: v!.state, features: v!.features, structure: v!.structure }])),
    levels: s.levels, feeds: s.feeds, warnings: s.warnings,
    bars_5m: bars5m.slice(-140),
    raw: s,
  }).select("id").single();
  if (error) return null;
  return (data as { id: number }).id;
}

export async function saveEvents(events: PerceptionEvent[]): Promise<void> {
  const c = db();
  if (!c || !events.length) return;
  const rows = events.map((e) => ({
    at: new Date(e.at).toISOString(),
    event_key: e.key, code: e.code, horizon: e.horizon, timeframe: e.timeframe,
    detail: e.detail, data: e.data, level: e.level, lean: e.lean,
    importance: e.significance.importance, novelty: e.significance.novelty,
    urgency: e.significance.urgency, confidence: e.significance.confidence,
    score: e.significance.score, channel: e.channel,
  }));
  // The key is unique, so a re-run of the same pass updates rather than duplicating the timeline.
  try { await c.from("cc_perception_events").upsert(rows, { onConflict: "event_key" }); } catch { /* the stream must not break the loop */ }
}

export async function saveBrainState(s: BrainState): Promise<void> {
  const c = db();
  if (!c) return;
  try {
    await c.from("cc_brain_state").insert({
      at: new Date(s.at).toISOString(), presence: s.presence, headline: s.headline,
      focus: s.focus, question: s.question, intensity: s.intensity, lean: s.lean,
    });
  } catch { /* best effort */ }
}

export async function saveThesis(t: BrainThesis): Promise<void> {
  const c = db();
  if (!c) return;
  try {
    await c.from("cc_brain_thesis").upsert({
      id: t.id, bias: t.bias, label: t.label, strength: t.strength, confidence: t.confidence,
      started_at: new Date(t.startedAt).toISOString(),
      ended_at: t.endedAt ? new Date(t.endedAt).toISOString() : null,
      reason_started: t.reasonStarted, reason_strengthened: t.reasonStrengthened,
      reason_weakened: t.reasonWeakened, reason_ended: t.reasonEnded,
      watching: t.watching, invalidation_price: t.invalidationPrice,
      price_at_start: t.priceAtStart, price_at_end: t.priceAtEnd,
      updated_at: new Date().toISOString(),
    }, { onConflict: "id" });
  } catch { /* best effort */ }
}

export async function saveStatement(s: BrainStatement): Promise<void> {
  const c = db();
  if (!c) return;
  try {
    await c.from("cc_brain_statements").insert({
      at: new Date(s.at).toISOString(), kind: s.kind, body: s.text,
      channel: s.channel, price_at: s.priceAt, thesis_id: s.thesisId,
    });
  } catch { /* best effort */ }
}

export async function saveLesson(e: { userId: string | null; body: string; interpretation: string | null; snapshotId: number | null; context: unknown }): Promise<void> {
  const c = db();
  if (!c) return;
  try {
    await c.from("cc_brain_lessons").insert({
      user_id: e.userId, body: e.body, interpretation: e.interpretation,
      snapshot_id: e.snapshotId, context: e.context ?? null,
    });
  } catch { /* best effort */ }
}

/** The newest snapshot with its candles, for the API. */
export async function latestWithBars(): Promise<{ id: number; snapshot: MarketSnapshot; bars: Bar[]; at: number } | null> {
  const c = db();
  if (!c) return null;
  const { data } = await c.from("cc_snapshots").select("id, at, raw, bars_5m").order("at", { ascending: false }).limit(1).maybeSingle();
  if (!data) return null;
  const r = data as { id: number; at: string; raw: MarketSnapshot | null; bars_5m: Bar[] | null };
  if (!r.raw) return null;
  return { id: r.id, snapshot: r.raw, bars: r.bars_5m ?? [], at: Date.parse(r.at) };
}

/**
 * The newest streamed tick for a symbol, as the price stream published it (market_live_ticks). Read
 * only: this adapter never writes that table. Null when there is no row or the read fails — the
 * caller decides what to fall back to.
 */
export async function latestTick(symbol: string): Promise<{ price: number; tickAt: number; receivedAt: number; updatedAt: number | null } | null> {
  const c = db();
  if (!c) return null;
  try {
    const { data, error } = await c.from("market_live_ticks").select("price, tick_at, received_at, updated_at").eq("symbol", symbol).maybeSingle();
    if (error || !data) return null;
    const r = data as { price: number | string; tick_at: string; received_at: string; updated_at?: string | null };
    const price = Number(r.price), tickAt = Date.parse(r.tick_at), receivedAt = Date.parse(r.received_at);
    const updatedAt = r.updated_at ? Date.parse(r.updated_at) : NaN;
    return Number.isFinite(price) && price > 0 && Number.isFinite(receivedAt)
      ? { price, tickAt, receivedAt, updatedAt: Number.isFinite(updatedAt) ? updatedAt : null }
      : null;
  } catch { return null; }
}

/**
 * Rebuild Atlas's rolling memory from the database.
 *
 * This is what lets awareness survive a worker restart and lets a browser that has just opened see the
 * same history the worker has been accumulating — the market does not stop when a process does.
 */
export async function loadRolling(windowMs = 80 * 60_000): Promise<Rolling> {
  const c = db();
  const r = emptyRolling();
  if (!c) return r;
  const since = new Date(Date.now() - windowMs).toISOString();

  const [snaps, events, statements, theses] = await Promise.all([
    c.from("cc_snapshots").select("raw").gte("at", since).order("at", { ascending: true }).limit(300),
    c.from("cc_perception_events").select("*").gte("at", since).order("at", { ascending: true }).limit(240),
    c.from("cc_brain_statements").select("*").order("at", { ascending: false }).limit(40),
    c.from("cc_brain_thesis").select("*").order("started_at", { ascending: true }).limit(40),
  ]);

  r.snapshots = ((snaps.data ?? []) as { raw: MarketSnapshot | null }[]).map((x) => x.raw).filter((x): x is MarketSnapshot => !!x);

  r.events = ((events.data ?? []) as Record<string, unknown>[]).map((e) => ({
    key: String(e.event_key), at: Date.parse(String(e.at)), code: e.code as PerceptionEvent["code"],
    horizon: (e.horizon as PerceptionEvent["horizon"]) ?? null, timeframe: (e.timeframe as PerceptionEvent["timeframe"]) ?? null,
    detail: String(e.detail), data: (e.data ?? {}) as PerceptionEvent["data"], level: (e.level ?? null) as PerceptionEvent["level"],
    lean: (e.lean as PerceptionEvent["lean"]) ?? "neutral",
    significance: {
      importance: Number(e.importance) || 0, novelty: Number(e.novelty) || 0, urgency: Number(e.urgency) || 0,
      confidence: Number(e.confidence) || 0, score: Number(e.score) || 0,
    },
    channel: e.channel as PerceptionEvent["channel"],
  }));

  r.statements = ((statements.data ?? []) as Record<string, unknown>[]).map((s) => ({
    at: Date.parse(String(s.at)), kind: s.kind as BrainStatement["kind"], text: String(s.body),
    channel: s.channel as BrainStatement["channel"],
    priceAt: s.price_at == null ? null : Number(s.price_at),
    thesisId: (s.thesis_id as string | null) ?? null,
  })).reverse();

  const spoken = r.statements.filter((s) => s.channel === "voice" || s.channel === "urgent");
  r.lastSpokeAt = spoken.length ? spoken[spoken.length - 1].at : null;

  r.theses = ((theses.data ?? []) as Record<string, unknown>[]).map((t) => ({
    id: String(t.id), bias: t.bias as BrainThesis["bias"], label: String(t.label),
    strength: t.strength as BrainThesis["strength"], confidence: Number(t.confidence) || 0,
    startedAt: Date.parse(String(t.started_at)), endedAt: t.ended_at ? Date.parse(String(t.ended_at)) : null,
    reasonStarted: (t.reason_started ?? []) as string[], reasonStrengthened: (t.reason_strengthened ?? []) as string[],
    reasonWeakened: (t.reason_weakened ?? []) as string[], reasonEnded: (t.reason_ended as string | null) ?? null,
    watching: (t.watching ?? []) as number[],
    invalidationPrice: t.invalidation_price == null ? null : Number(t.invalidation_price),
    priceAtStart: Number(t.price_at_start) || 0, priceAtEnd: t.price_at_end == null ? null : Number(t.price_at_end),
    snapshotAtStart: Date.parse(String(t.started_at)), snapshotAtEnd: t.ended_at ? Date.parse(String(t.ended_at)) : null,
  }));

  return r;
}

/** The day's opinions, in order — Atlas JOURNAL. */
export async function thesisJournal(sinceIso: string): Promise<Record<string, unknown>[]> {
  const c = db();
  if (!c) return [];
  const { data } = await c.from("cc_brain_thesis").select("*").gte("started_at", sinceIso).order("started_at", { ascending: true }).limit(60);
  return (data ?? []) as Record<string, unknown>[];
}

/** The intelligence stream: what it noticed, newest first. */
export async function recentEvents(limit = 60): Promise<Record<string, unknown>[]> {
  const c = db();
  if (!c) return [];
  const { data } = await c.from("cc_perception_events").select("*").order("at", { ascending: false }).limit(limit);
  return (data ?? []) as Record<string, unknown>[];
}

export async function recentStatements(limit = 20): Promise<Record<string, unknown>[]> {
  const c = db();
  if (!c) return [];
  const { data } = await c.from("cc_brain_statements").select("*").order("at", { ascending: false }).limit(limit);
  return (data ?? []) as Record<string, unknown>[];
}

/**
 * Leave the bars this pass already fetched where the Command Center chart can read them. Display only:
 * one overwritten row per timeframe, best-effort, and nothing on a trading path ever reads it back.
 */
export async function saveChartBars(bars: Partial<Record<string, Bar[]>>): Promise<void> {
  const c = db();
  if (!c) return;
  const rows = Object.entries(bars)
    .filter(([, b]) => Array.isArray(b) && b.length)
    .map(([tf, b]) => ({ tf, bars: (b as Bar[]).slice(-240), updated_at: new Date().toISOString() }));
  if (!rows.length) return;
  try { await c.from("cc_chart_bars").upsert(rows, { onConflict: "tf" }); } catch { /* the screen can wait; the engine cannot */ }
}

/* ══════════════════════════════════════════════════════════════════════════════
   ATLAS READ — the directional read and its scenarios (cc_atlas_reads, migration 20261111010000).
   Display and conversation only: nothing on a trading path reads this table. Every function here
   fails soft (null / []) — including when the migration has not been applied yet.
   ══════════════════════════════════════════════════════════════════════════════ */

export type AtlasReadRow = { id: number; at: number; snapshotId: number | null; read: AtlasRead; scenarios: Scenario[]; reason: string | null };
/** One row, reduced to what the lean's history needs (no evidence, no scenarios). */
export type AtlasReadLite = { at: number; lean: Lean; since: number | null; summary: string | null; why: string | null; reason: string | null };

/** Append one read. Rows are never updated: the history of what ATLAS thought is the point. */
export async function saveAtlasRead(e: { read: AtlasRead; scenarios: Scenario[]; reason: string; snapshotId: number | null }): Promise<number | null> {
  const c = db();
  if (!c) return null;
  try {
    const { data, error } = await c.from("cc_atlas_reads").insert({
      at: new Date(e.read.at).toISOString(),
      snapshot_id: e.snapshotId,
      version: e.read.version,
      lean: e.read.lean,
      score: Math.round(e.read.score),
      read: e.read,
      scenarios: e.scenarios,
      reason: e.reason.slice(0, 1000),
    }).select("id").single();
    if (error || !data) return null;
    return (data as { id: number }).id;
  } catch { return null; }
}

/** The newest read, checked before it is trusted (a malformed or other-version row is treated as absent). */
export async function latestAtlasRead(): Promise<AtlasReadRow | null> {
  const c = db();
  if (!c) return null;
  try {
    const { data, error } = await c.from("cc_atlas_reads")
      .select("id, at, snapshot_id, read, scenarios, reason")
      .order("at", { ascending: false }).order("id", { ascending: false }).limit(1).maybeSingle();
    if (error || !data) return null;
    const r = data as { id: number; at: string; snapshot_id: number | string | null; read: unknown; scenarios: unknown; reason: string | null };
    const read = readFromStored(r.read);
    if (!read) return null;
    return {
      id: Number(r.id), at: Date.parse(r.at),
      snapshotId: r.snapshot_id == null ? null : Number(r.snapshot_id),
      read,
      scenarios: (Array.isArray(r.scenarios) ? r.scenarios : []).filter(scenarioLooksValid),
      reason: r.reason ?? null,
    };
  } catch { return null; }
}

/** Recent reads, newest first, light: enough to rebuild the lean's history without loading every evidence list. */
export async function recentAtlasReads(opts: { sinceMs?: number; limit?: number } = {}): Promise<AtlasReadLite[]> {
  const c = db();
  if (!c) return [];
  try {
    let q = c.from("cc_atlas_reads").select("at, lean, reason, since:read->>since, summary:read->>summary, why:read->previous->>reason");
    if (opts.sinceMs != null) q = q.gte("at", new Date(opts.sinceMs).toISOString());
    const { data, error } = await q.order("at", { ascending: false }).limit(Math.max(1, Math.min(1000, opts.limit ?? 300)));
    if (error || !data) return [];
    const leans: Lean[] = ["bullish_lean", "bearish_lean", "balanced", "transitioning", "insufficient_data"];
    return (data as Record<string, unknown>[])
      .map((r) => ({
        at: Date.parse(String(r.at)),
        lean: String(r.lean) as Lean,
        since: r.since == null || !Number.isFinite(Number(r.since)) ? null : Number(r.since),
        summary: r.summary == null ? null : String(r.summary),
        why: r.why == null ? null : String(r.why),
        reason: r.reason == null ? null : String(r.reason),
      }))
      .filter((r) => Number.isFinite(r.at) && leans.includes(r.lean));
  } catch { return []; }
}

/** Reads are appended every few minutes; keep a rolling window rather than growing forever. */
export async function pruneAtlasReads(keepDays = 30): Promise<void> {
  const c = db();
  if (!c) return;
  try { await c.from("cc_atlas_reads").delete().lt("at", new Date(Date.now() - keepDays * 86_400_000).toISOString()); } catch { /* best effort */ }
}

/**
 * The chart candles the worker last left in cc_chart_bars, per timeframe, with when each set was written.
 * Read-only. Used only when a read has to be computed outside the worker (the live route's fallback).
 */
export async function chartBarsFor(tfs: Timeframe[]): Promise<{ bars: Partial<Record<Timeframe, Bar[]>>; asOf: Partial<Record<Timeframe, number>> }> {
  const out: { bars: Partial<Record<Timeframe, Bar[]>>; asOf: Partial<Record<Timeframe, number>> } = { bars: {}, asOf: {} };
  const c = db();
  if (!c || !tfs.length) return out;
  try {
    const { data, error } = await c.from("cc_chart_bars").select("tf, bars, updated_at").in("tf", tfs);
    if (error || !data) return out;
    for (const r of data as { tf: string; bars: unknown; updated_at: string }[]) {
      const tf = r.tf as Timeframe;
      if (!tfs.includes(tf) || !Array.isArray(r.bars)) continue;
      out.bars[tf] = (r.bars as Bar[]).filter((b) => b && [b.t, b.o, b.h, b.l, b.c].every((x) => typeof x === "number" && Number.isFinite(x)));
      const at = Date.parse(r.updated_at);
      if (Number.isFinite(at)) out.asOf[tf] = at;
    }
    return out;
  } catch { return out; }
}
