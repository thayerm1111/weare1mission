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
   THE BRAIN — perception, opinions and memory.
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
 * Rebuild The BRAIN's rolling memory from the database.
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

/** The day's opinions, in order — the BRAIN JOURNAL. */
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
