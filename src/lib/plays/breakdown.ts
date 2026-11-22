import { normalizePlayDiagnostics } from "./diagnostics";

export const PLAY_FRAME_ORDER = ["4H", "1H", "30M", "15M", "5M"] as const;
export type PlayFrameKey = typeof PLAY_FRAME_ORDER[number];
export type PlayFrameTrend = "bullish" | "bearish" | "ranging" | null;
export type PlayFrameView = {
  tf: PlayFrameKey;
  trend: PlayFrameTrend;
  aligned: boolean | null;
  confirmed: number | null;
  total: number | null;
  checklist: { label: string; ok: boolean }[];
  availability: "checks" | "trend" | "missing" | "unavailable";
  asOf: string | null;
  closed: boolean;
  reason?: string;
};

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown, max = 20_000) => typeof value === "string" && value.length <= max ? value.trim() : "";
const trendOf = (value: unknown): PlayFrameTrend => {
  const word = text(value, 32).toLowerCase();
  return word === "bullish" || word === "bearish" || word === "ranging" ? word : null;
};

export function playFrameKey(value: unknown): PlayFrameKey | null {
  const tf = text(value, 32).replace(/\s/g, "").toUpperCase();
  const names: Record<string, PlayFrameKey> = {
    "4H": "4H", "4HR": "4H", "240M": "4H", "240MIN": "4H",
    "1H": "1H", "1HR": "1H", "60M": "1H", "60MIN": "1H",
    "30M": "30M", "30MIN": "30M", "15M": "15M", "15MIN": "15M", "5M": "5M", "5MIN": "5M",
  };
  return names[tf] ?? null;
}

/** Presentation only: never infer an unrecorded factor or turn a count into trade eligibility. */
export function playFrameViews(value: unknown, interval?: string): PlayFrameView[] {
  const raw = record(value);
  const d = normalizePlayDiagnostics(value);
  const direction = raw.direction;
  const alignment = (trend: PlayFrameTrend): boolean | null => !trend || (direction !== "LONG" && direction !== "SHORT")
    ? null : trend === (direction === "LONG" ? "bullish" : "bearish");
  const primary = playFrameKey(interval);

  return PLAY_FRAME_ORDER.map((tf) => {
    const empty: PlayFrameView = { tf, trend: null, aligned: null, confirmed: null, total: null, checklist: [], availability: "missing", asOf: null, closed: false };
    const current = d.timeframeConfirmations?.find((row) => playFrameKey(row.tf) === tf);
    if (current) {
      if (current.unavailable) return { ...empty, availability: "unavailable", closed: true, reason: current.reason };
      const trend = trendOf(current.trend);
      const hasChecks = current.total != null && current.total > 0 && current.confirmed != null;
      return { ...empty, trend, aligned: current.aligned, confirmed: hasChecks ? current.confirmed : null, total: hasChecks ? current.total : null,
        checklist: current.checklist, availability: hasChecks ? "checks" : "trend", asOf: current.asOf, closed: current.closed };
    }

    const legacy = d.timeframes?.find((row) => playFrameKey(row.tf) === tf);
    if (legacy) {
      if (legacy.unavailable) return { ...empty, availability: "unavailable" };
      const trend = trendOf(legacy.trend), hasChecks = legacy.total > 0;
      return { ...empty, trend, aligned: alignment(trend), confirmed: hasChecks ? legacy.confirmed : null, total: hasChecks ? legacy.total : null,
        checklist: legacy.checklist, availability: hasChecks ? "checks" : "trend" };
    }

    // Older intraday records saved only their execution-frame checklist. Never copy it to other frames.
    if (primary === tf && d.checklist?.length) {
      const trend = trendOf(d.mtf?.find((row) => playFrameKey(row.tf) === tf)?.trend ?? (tf === "1H" ? d.flow?.h1 : null));
      return { ...empty, trend, aligned: alignment(trend), checklist: d.checklist,
        confirmed: d.checklist.filter((check) => check.ok).length, total: d.checklist.length, availability: "checks" };
    }

    const flowTrend = tf === "4H" ? d.flow?.h4 : tf === "1H" ? d.flow?.h1 : undefined;
    const trend = trendOf(flowTrend ?? d.mtf?.find((row) => playFrameKey(row.tf) === tf)?.trend);
    return trend ? { ...empty, trend, aligned: alignment(trend), availability: "trend" } : empty;
  });
}

export const playTrendLabel = (trend: PlayFrameTrend) => trend === "bullish" ? "Bullish" : trend === "bearish" ? "Bearish" : trend === "ranging" ? "Range" : "—";

export function playFrameScore(frame: PlayFrameView): string {
  if (frame.availability === "unavailable") return "Unavailable";
  if (frame.availability === "missing") return "Not saved";
  if (frame.confirmed != null && frame.total != null) return `${frame.confirmed}/${frame.total}`;
  return "Trend only";
}

export function playFrameNote(frame: PlayFrameView): string {
  if (frame.availability === "missing") return "This saved play did not include this timeframe’s checks.";
  if (frame.availability === "unavailable") return frame.reason === "rate_limited"
    ? "The data provider could not supply this timeframe within its request limit."
    : frame.reason === "insufficient_data" ? "There were not enough closed candles to evaluate this timeframe."
      : "This timeframe’s data was unavailable when the play was generated.";
  if (frame.availability === "trend") return "This play saved the trend for this timeframe, without a factor checklist.";
  return frame.closed ? "Checks use the closed candles available when this play was generated." : "These are the checks saved when this play was generated.";
}

/** The engine's own notes. A short preview never replaces the complete explanation. */
export function playNotes(value: unknown) {
  const raw = record(value), d = normalizePlayDiagnostics(value);
  const rationale = text(raw.rationale);
  const sentence = rationale.match(/^.*?[.!?](?=\s|$)/s)?.[0] ?? rationale;
  const preview = sentence.length > 220 ? sentence.slice(0, 217).replace(/\s+\S*$/, "") + "…" : sentence;
  return {
    setup: d.setup || preview,
    rationale,
    invalidation: text(raw.invalidation),
    bias: d.bias,
    poi: d.poi,
    target: d.liquidityTarget,
    confidence: d.confidence,
    grade: d.grade,
    waiting: raw.status === "no_trade" || raw.direction === "NEUTRAL",
    noSetup: raw.direction === "NEUTRAL",
  };
}
