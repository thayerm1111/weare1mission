/**
 * ASKING ATLAS — the I/O around one conversation turn: what is loaded before a question is answered, and
 * the one call to the model.
 *
 * FRESH AT QUESTION TIME. The route has already read the newest snapshot with the live tick attached
 * (liveMemory({ livePrice: true })). This adds what the answer needs to point at the chart and to be
 * honest about itself: which snapshot that was (its id), the candles the chart is drawing on every
 * timeframe, the thesis journal when the question reaches back in time, the read, and the feed status.
 *
 * Fields the read and feed engines publish (`read`, `scenarios`, `readHistory`, `feed`, `analysis`) are
 * used when they are handed in; when they are not, the read is derived from the running thesis and the
 * feed is judged from the snapshot — the conversation never waits on them to exist.
 */
import type { Bar } from "../core/types";
import type { BrainMemory } from "./types";
import { CHART_TFS, type AnalysisMeta, type AtlasRead, type ChartTf, type FeedState, type Scenario } from "../core/atlasContract";
import { db, latestWithBars, thesisJournal } from "../adapters/db";
import { marketOpen } from "../core/sessions";
import {
  conversationFeed, journalFromRows, journalFromTheses, readFromThesis,
  type JournalEntry, type ReadHistoryEntry,
} from "./conversation";
import { liveReadFields } from "../engines/live";
import { feedOfSnapshot } from "../core/feed";
import type { SetupState } from "../engines/setup";

/** What the read/feed engines publish on the live payload, when a caller has it. */
export type AskPayload = Partial<{
  read: AtlasRead | null;
  scenarios: Scenario[];
  readHistory: ReadHistoryEntry[];
  feed: FeedState;
  analysis: AnalysisMeta;
}>;

export type AskContext = {
  snapshotId: number | null;
  analysisAt: number | null;
  bars: Partial<Record<ChartTf, Bar[]>>;
  read: AtlasRead;
  scenarios: Scenario[];
  readHistory: ReadHistoryEntry[];
  journal: JournalEntry[];
  feed: FeedState;
  /** Where the read and the feed came from — the engines, or this file's fallbacks. */
  sources: { read: "engine" | "thesis"; feed: "engine" | "conversation" };
};

const isBar = (b: unknown): b is Bar => {
  if (!b || typeof b !== "object") return false;
  const x = b as Record<string, unknown>;
  return ["t", "o", "h", "l", "c"].every((k) => typeof x[k] === "number" && Number.isFinite(x[k] as number));
};

/**
 * The candles the chart draws above 5 minutes (cc_chart_bars, which the worker overwrites each pass — the
 * same rows /api/command-center/bars serves the screen). Read-only and best-effort: without them only the
 * 5-minute candles can be pointed at, which is a smaller answer, not a broken one.
 */
export async function chartBars(): Promise<Partial<Record<ChartTf, Bar[]>>> {
  const c = db();
  if (!c) return {};
  try {
    const { data } = await c.from("cc_chart_bars").select("tf, bars").in("tf", [...CHART_TFS]);
    const out: Partial<Record<ChartTf, Bar[]>> = {};
    for (const row of (data ?? []) as { tf: string; bars: unknown }[]) {
      if (!CHART_TFS.includes(row.tf as ChartTf) || !Array.isArray(row.bars)) continue;
      out[row.tf as ChartTf] = row.bars.filter(isBar).slice(-240);
    }
    return out;
  } catch { return {}; }
}

/**
 * Everything a turn loads beyond the memory. Every read is best-effort: a failed query shrinks what the
 * answer can point at; it never stops the answer.
 */
export async function loadAskContext(m: BrainMemory, i: {
  nowMs: number;
  /** When the question reaches back to ("since your last update"), so the journal covers it. */
  since?: number | null;
  setup?: { state: string; waitingFor: string[]; side?: string | null } | null;
  tradeActive?: boolean;
  payload?: AskPayload;
  demo?: boolean;
}): Promise<AskContext> {
  const s = m.now;
  const [latest, chart, rows] = await Promise.all([
    latestWithBars().catch(() => null),
    chartBars(),
    i.since != null ? thesisJournal(new Date(i.since - 6 * 3600_000).toISOString()).catch(() => []) : Promise.resolve([] as Record<string, unknown>[]),
  ]);

  // The id is only claimed when it is the SAME snapshot the memory was built from — a newer one may have
  // landed between the two reads, and a wrong id is worse than none.
  const same = !!latest && !!s && latest.at === s.at;
  const snapshotId = i.payload?.analysis?.snapshotId ?? (same ? latest!.id : null);
  const analysisAt = i.payload?.analysis?.analysisAt ?? s?.at ?? null;
  const bars: Partial<Record<ChartTf, Bar[]>> = { ...chart };
  if (latest?.bars?.length) bars["5m"] = latest.bars.filter(isBar);   // the 5m chart draws the snapshot's own candles

  const journal = new Map<string, JournalEntry>();
  for (const j of [...journalFromRows(rows as Record<string, unknown>[]), ...journalFromTheses([m.previousThesis, m.thesis])]) journal.set(j.id, j);

  /*
   * THE SAME READ THE SCREEN SHOWS (integration 11-11). When the caller has not handed the engine's fields in,
   * load them here from the very snapshot this answer is about (engines/live.ts liveReadFields — the stored
   * read for that snapshot, or one computed from it), so chat, voice and the panel can never report three
   * different leans. The thesis-derived read stays as the fallback for when there is no snapshot id.
   */
  let engine: AskPayload | null = i.payload ?? null;
  if (!engine?.read && s && snapshotId != null && !i.demo) {
    try {
      const fields = await liveReadFields({
        snapshot: s, snapshotId, bars5m: (bars["5m"] ?? []) as Bar[], marketIsOpen: marketOpen(i.nowMs),
        setupState: (i.setup?.state ?? null) as SetupState | null, tradeActive: !!i.tradeActive,
        historySince: i.nowMs - 24 * 3600_000, now: i.nowMs,
      });
      engine = { ...(engine ?? {}), read: fields.read, scenarios: fields.scenarios, readHistory: fields.readHistory };
    } catch { /* fall back to the thesis-derived read below */ }
  }
  const engineRead = engine?.read ?? null;
  const read = engineRead ?? readFromThesis({
    snapshot: s, snapshotId, thesis: m.thesis, previousThesis: m.previousThesis,
    events: m.recentEvents, bars5m: bars["5m"], setup: i.setup ?? null, tradeActive: i.tradeActive, nowMs: i.nowMs,
  });
  // The feed is judged exactly as the screen judges it (core/feed.ts), from the same price the answer quotes.
  const feed = engine?.feed ?? (s ? feedOfSnapshot(s, { now: i.nowMs, marketOpen: marketOpen(i.nowMs), replay: !!i.demo })
    : conversationFeed(s, i.nowMs, marketOpen(i.nowMs), { demo: i.demo }));

  return {
    snapshotId, analysisAt, bars, read,
    scenarios: engine?.scenarios ?? [],
    readHistory: engine?.readHistory ?? [],
    journal: [...journal.values()].sort((a, b) => a.at - b.at),
    feed,
    sources: { read: engineRead ? "engine" : "thesis", feed: engine?.feed || s ? "engine" : "conversation" },
  };
}

/* ── the model ─────────────────────────────────────────────────────────────────────────────────────── */

export const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

export type ModelResult =
  | { ok: true; text: string }
  | { ok: false; reason: "http" | "empty" | "network" | "timeout"; status?: number };

/**
 * One non-streamed call. The key stays here, server-side; `fetchImpl` exists so tests never reach the
 * network. A reply that is late is treated as no reply — the deterministic voice answers instead.
 */
export async function callAtlasModel(i: {
  key: string;
  model: string;
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  maxTokens: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<ModelResult> {
  const f = i.fetchImpl ?? fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), i.timeoutMs ?? 25_000);
  try {
    const r = await f(ANTHROPIC_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": i.key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: i.model, max_tokens: i.maxTokens, system: i.system, messages: i.messages }),
      signal: ac.signal,
    });
    const j = (await r.json().catch(() => null)) as { content?: { type?: string; text?: string }[] } | null;
    if (!r.ok) return { ok: false, reason: "http", status: r.status };
    const text = Array.isArray(j?.content) ? j!.content.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("").trim() : "";
    return text ? { ok: true, text } : { ok: false, reason: "empty" };
  } catch {
    return { ok: false, reason: ac.signal.aborted ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
}
