/**
 * THE ATLAS CONTRACT (owner 11-11: "upgrade ATLAS into a real-time conversational market copilot").
 *
 * One set of shapes that every part of the upgrade builds against, so the chart, the price strip, the
 * read, the scenario cards, chat and voice all describe the SAME market state:
 *
 *   FeedState     — where the price came from, when the provider stamped it, when we received it, and an
 *                   honest status (LIVE / DELAYED / RECONNECTING / STALE / MARKET CLOSED / DEMO).
 *   AnalysisMeta  — which snapshot and which engine version an analysis came from, and how old it is. A
 *                   quote moves faster than a conclusion: the two carry their own timestamps.
 *   AtlasRead     — ATLAS's directional read: lean, horizon, the evidence for and against, what it is
 *                   watching next and what would invalidate it. Higher-timeframe trend, immediate momentum,
 *                   directional lean, setup stage and entry confirmation are separate fields on purpose: a
 *                   lean is never an entry.
 *   Scenario      — base case, alternative, and what would change the view, each with a lifecycle.
 *   ChartAction   — the only things ATLAS may do to the chart, validated against real level IDs, real
 *                   candle timestamps and real scenario IDs before they are shown.
 *
 * Pure: no I/O. Shared by the worker, the API routes and the browser.
 */
import type { Timeframe } from "./types";

/* ── Feed ──────────────────────────────────────────────────────────────────────────────────────────── */

export type FeedStatus = "live" | "delayed" | "reconnecting" | "stale" | "closed" | "demo";
/** How the price reached the screen. "websocket_relay" = the worker's provider WebSocket, relayed to us. */
export type FeedTransport = "websocket_relay" | "poll" | "snapshot" | "replay";

export type FeedState = {
  provider: string;            // "Twelve Data"
  symbol: string;              // "XAU/USD"
  /** What the number is. Twelve Data's XAU/USD is a composite spot price, not a broker's bid or ask. */
  quoteType: "mid" | "bid" | "ask" | "last";
  transport: FeedTransport;
  price: number | null;
  /** The provider's own timestamp — can be coarse (Twelve Data stamps gold to the minute). */
  providerTs: number | null;
  /** When our side received the price. Freshness is judged on this. */
  receivedTs: number | null;
  ageMs: number | null;
  status: FeedStatus;
  /** One plain line saying why the status is what it is. */
  reason: string;
  /** When this state was worked out. */
  checkedAt: number;
};

export type AnalysisMeta = {
  snapshotId: number | null;
  /** The snapshot engine's version string. */
  analysisVersion: string;
  /** When the analysed snapshot was taken. */
  analysisAt: number | null;
  analysisAgeMs: number | null;
  readVersion: string;
};

/* ── The read ──────────────────────────────────────────────────────────────────────────────────────── */

export const ATLAS_READ_VERSION = "read-1";

export type Lean = "bullish_lean" | "bearish_lean" | "balanced" | "transitioning" | "insufficient_data";

export const LEAN_LABEL: Record<Lean, string> = {
  bullish_lean: "Bullish lean",
  bearish_lean: "Bearish lean",
  balanced: "Balanced / range",
  transitioning: "Transitioning",
  insufficient_data: "Not enough current data",
};

/** What a piece of evidence points at on the chart. Only real objects: a level by ID, a confirmed swing,
 *  a closed candle by its open time, or a price zone. */
export type EvidenceRef =
  | { kind: "level"; levelId: string; price: number }
  | { kind: "swing"; tf: Timeframe; t: number; price: number; type: "high" | "low" }
  | { kind: "candle"; tf: Timeframe; t: number }
  | { kind: "zone"; from: number; to: number; label: string };

export type Evidence = { text: string; weight: number; ref?: EvidenceRef };

export type AtlasRead = {
  version: string;
  /** The time of the snapshot this read was computed from. */
  at: number;
  snapshotId: number | null;
  /** What the lean is about. Viewing a 5-minute chart never turns this into a 5-minute forecast. */
  horizon: "intraday";
  horizonTf: "15m" | "1h";
  lean: Lean;
  strength: "slight" | "clear" | "strong" | null;
  /** Signed balance of the evidence, -100..100. A measure of agreement, NOT a probability of anything. */
  score: number;
  htfTrend: { tf: "1h" | "4h"; state: "up" | "down" | "range" | "unknown"; text: string };
  momentum: { tf: "5m" | "15m"; state: "rising" | "falling" | "flat" | "unknown"; text: string };
  setupStage: "none" | "watching" | "developing" | "ready" | "in_trade";
  entry: "none" | "awaiting_confirmation" | "confirmed";
  evidenceFor: Evidence[];
  evidenceAgainst: Evidence[];
  nextWatch: { text: string; ref?: EvidenceRef } | null;
  invalidation: { text: string; price: number | null; ref?: EvidenceRef } | null;
  /** When this lean began (it persists across snapshots until the rules let it change). */
  since: number;
  previous: { lean: Lean; until: number; reason: string } | null;
  /** One plain sentence in ATLAS's voice: the read, the reason, what matters next. */
  summary: string;
};

/* ── Scenarios ─────────────────────────────────────────────────────────────────────────────────────── */

export type ScenarioStatus = "watching" | "developing" | "confirmed" | "invalidated" | "expired";
export type ScenarioRole = "base" | "alternative" | "view_change";

export type Scenario = {
  id: string;
  role: ScenarioRole;
  title: string;
  tf: "15m" | "1h";
  direction: "up" | "down" | "range";
  evidence: string[];
  trigger: { text: string; price: number | null; ref?: EvidenceRef };
  invalidation: { text: string; price: number | null; ref?: EvidenceRef };
  status: ScenarioStatus;
  since: number;
  updatedAt: number;
  /** Append-only: prior statuses are kept, never rewritten after the outcome. */
  history: { at: number; status: ScenarioStatus; reason: string }[];
};

/* ── Chart actions ─────────────────────────────────────────────────────────────────────────────────── */

export type ChartTf = "5m" | "15m" | "1h" | "4h" | "1d";
export const CHART_TFS: readonly ChartTf[] = ["5m", "15m", "1h", "4h", "1d"];

export type ChartAction =
  | { type: "timeframe"; tf: ChartTf }
  | { type: "highlight_level"; levelId: string; price: number; label: string }
  | { type: "show_zone"; from: number; to: number; label: string }
  | { type: "mark_candle"; tf: ChartTf; t: number; label: string }
  | { type: "scenario"; scenarioId: string | null }
  | { type: "clear" };

/** The browser event the copilot dispatches and the chart listens for. detail: ChartAction. */
export const CHART_ACTION_EVENT = "cc:chart-action";

/** A level's stable ID: its kind and price. Deterministic, so the server and the browser agree. */
export const levelIdOf = (l: { kind: string; price: number }): string => `${l.kind}@${Number(l.price).toFixed(2)}`;

export type ChartActionContext = {
  levels: { kind: string; price: number; label: string }[];
  /** Candle open times available per timeframe (closed or forming). */
  candles: Partial<Record<ChartTf, number[]>>;
  scenarios: { id: string }[];
  /** Current price, to keep zones sane. */
  price: number | null;
};

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: unknown, max = 80): string => String(v ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);

/**
 * Accept a chart action only if it points at something real. Levels must match a known level ID; candles
 * must be a known open time on that timeframe; scenarios must exist; zones must be ordered, finite and
 * within a sane distance of the price (5%). Anything else is dropped (null) rather than drawn.
 */
export function validateChartAction(raw: unknown, ctx: ChartActionContext): ChartAction | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  const type = String(a.type ?? "");
  if (type === "clear") return { type: "clear" };
  if (type === "timeframe") {
    const tf = String(a.tf ?? "") as ChartTf;
    return CHART_TFS.includes(tf) ? { type: "timeframe", tf } : null;
  }
  if (type === "highlight_level") {
    const id = String(a.levelId ?? "");
    const lv = ctx.levels.find((l) => levelIdOf(l) === id);
    return lv ? { type: "highlight_level", levelId: id, price: lv.price, label: str(a.label) || lv.label } : null;
  }
  if (type === "show_zone") {
    let from = num(a.from), to = num(a.to);
    if (from == null || to == null || from <= 0 || to <= 0) return null;
    if (from > to) [from, to] = [to, from];
    const ref = ctx.price ?? (from + to) / 2;
    if (Math.abs(from - ref) / ref > 0.05 || Math.abs(to - ref) / ref > 0.05 || to - from > ref * 0.03) return null;
    return { type: "show_zone", from, to, label: str(a.label) || "Zone" };
  }
  if (type === "mark_candle") {
    const tf = String(a.tf ?? "") as ChartTf;
    const t = num(a.t);
    if (!CHART_TFS.includes(tf) || t == null) return null;
    const known = ctx.candles[tf] ?? [];
    return known.includes(t) ? { type: "mark_candle", tf, t, label: str(a.label) || "Candle" } : null;
  }
  if (type === "scenario") {
    if (a.scenarioId == null) return { type: "scenario", scenarioId: null };
    const id = String(a.scenarioId);
    return ctx.scenarios.some((s) => s.id === id) ? { type: "scenario", scenarioId: id } : null;
  }
  return null;
}
