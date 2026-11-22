/** Optional evidence is display data. Missing or malformed evidence must never change a play's trade state. */
export type PlayCheck = { label: string; ok: boolean };
export type PlayTimeframe = {
  tf: string; trend: string; confirmed: number; total: number;
  checklist: PlayCheck[]; unavailable?: boolean;
};
export type PlayTimeframeConfirmation = {
  tf: "4H" | "1H" | "30M" | "15M" | "5M";
  trend: "bullish" | "bearish" | "ranging" | null;
  aligned: boolean | null; confirmed: number | null; total: number | null;
  checklist: PlayCheck[]; asOf: string | null; closed: true; unavailable: boolean;
  reason?: "rate_limited" | "insufficient_data" | "unavailable";
};

const WORD_FIELDS = [
  "confidence", "riskReward", "timeframe", "rationale", "invalidation", "no_trade_reason",
  "setup", "bias", "poi", "liquidityTarget", "verdict", "momentum_rating", "trend_rating", "chase_note", "mtf_label",
] as const;
type WordField = typeof WORD_FIELDS[number];
export type PlayDiagnostics = Partial<Record<WordField, string>> & {
  grade?: string | null; gate_score?: number;
  checklist?: PlayCheck[]; confirmed?: number; total?: number;
  flow?: { h4: string; h1: string; dir: string; aligned: boolean };
  timeframes?: PlayTimeframe[];
  timeframeConfirmations?: PlayTimeframeConfirmation[];
  mtf?: { tf: string; trend: string }[];
};

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max;
const count = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 256;
const MAX_CHECKS = 32;
const MAX_FRAMES = 16;

/** Keep a checklist whole: removing a malformed check could misrepresent the saved count. */
function checklist(value: unknown): PlayCheck[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_CHECKS) return undefined;
  if (!value.every((item) => object(item) && text(item.label, 1000) && typeof item.ok === "boolean")) return undefined;
  return value.map((item) => ({ label: item.label, ok: item.ok }));
}

function legacyTimeframe(value: unknown): PlayTimeframe | null {
  if (!object(value) || !text(value.tf, 32) || !text(value.trend, 64)) return null;
  if (!count(value.confirmed) || !count(value.total) || value.confirmed > value.total) return null;
  const checks = checklist(value.checklist);
  if (!checks || value.unavailable != null && typeof value.unavailable !== "boolean") return null;
  return {
    tf: value.tf, trend: value.trend, confirmed: value.confirmed, total: value.total, checklist: checks,
    ...(typeof value.unavailable === "boolean" ? { unavailable: value.unavailable } : {}),
  };
}

const FRAMES = new Set(["4H", "1H", "30M", "15M", "5M"]);
const TRENDS = new Set(["bullish", "bearish", "ranging"]);
const REASONS = new Set(["rate_limited", "insufficient_data", "unavailable"]);

function timeframeConfirmation(value: unknown): PlayTimeframeConfirmation | null {
  if (!object(value) || !text(value.tf, 32) || !FRAMES.has(value.tf.toUpperCase()) || value.closed !== true || typeof value.unavailable !== "boolean") return null;
  const tf = value.tf.toUpperCase() as PlayTimeframeConfirmation["tf"];
  const reason = typeof value.reason === "string" && REASONS.has(value.reason)
    ? value.reason as PlayTimeframeConfirmation["reason"] : undefined;
  if (value.unavailable) {
    // No-data rows carry no score or trend, even if a damaged saved payload contains one.
    return { tf, trend: null, aligned: null, confirmed: null, total: null, checklist: [], asOf: null, closed: true, unavailable: true, ...(reason ? { reason } : {}) };
  }
  if (typeof value.trend !== "string" || !TRENDS.has(value.trend)) return null;
  if (value.aligned !== null && typeof value.aligned !== "boolean") return null;
  if (!count(value.confirmed) || !count(value.total) || value.confirmed > value.total) return null;
  if (value.asOf !== null && !text(value.asOf, 128)) return null;
  const checks = checklist(value.checklist);
  if (!checks) return null;
  return {
    tf, trend: value.trend as PlayTimeframeConfirmation["trend"], aligned: value.aligned,
    confirmed: value.confirmed, total: value.total, checklist: checks, asOf: value.asOf,
    closed: true, unavailable: false, ...(reason ? { reason } : {}),
  };
}

/** Retain bounded, valid evidence from current responses and older saved plays; do not invent missing evidence. */
export function normalizePlayDiagnostics(value: unknown): PlayDiagnostics {
  if (!object(value)) return {};
  const out: PlayDiagnostics = {};
  for (const field of WORD_FIELDS) if (text(value[field], 20_000)) out[field] = value[field];
  if (value.grade === null || text(value.grade, 64)) out.grade = value.grade;
  if (typeof value.gate_score === "number" && Number.isFinite(value.gate_score) && value.gate_score >= 0 && value.gate_score <= 100) out.gate_score = value.gate_score;
  const checks = checklist(value.checklist);
  if (checks) out.checklist = checks;
  // Legacy scalp totals aggregate multiple frames; they need not equal the primary frame's checklist.
  if (count(value.confirmed)) out.confirmed = value.confirmed;
  if (count(value.total)) out.total = value.total;
  if (out.confirmed !== undefined && out.total !== undefined && out.confirmed > out.total) {
    delete out.confirmed; delete out.total;
  }
  const flow = value.flow;
  if (object(flow) && text(flow.h4, 64) && text(flow.h1, 64) && text(flow.dir, 32) && typeof flow.aligned === "boolean") {
    out.flow = { h4: flow.h4, h1: flow.h1, dir: flow.dir, aligned: flow.aligned };
  }
  if (Array.isArray(value.timeframes)) out.timeframes = value.timeframes.slice(0, MAX_FRAMES).map(legacyTimeframe).filter((row): row is PlayTimeframe => row !== null);
  if (Array.isArray(value.timeframeConfirmations)) {
    const seen = new Set<string>();
    out.timeframeConfirmations = value.timeframeConfirmations.slice(0, MAX_FRAMES).map(timeframeConfirmation).filter((row): row is PlayTimeframeConfirmation => {
      if (!row || seen.has(row.tf)) return false;
      seen.add(row.tf); return true;
    });
  }
  if (Array.isArray(value.mtf)) out.mtf = value.mtf.slice(0, MAX_FRAMES).flatMap((row) => object(row) && text(row.tf, 32) && text(row.trend, 64) ? [{ tf: row.tf, trend: row.trend }] : []);
  return out;
}

/** The display boundary preserves every core field, then replaces only optional evidence with its safe copy. */
export function sanitizePlaySignal<T extends Record<string, unknown>>(signal: T): T & PlayDiagnostics {
  const clean: Record<string, unknown> = { ...signal };
  for (const field of [...WORD_FIELDS, "grade", "gate_score", "checklist", "confirmed", "total", "flow", "timeframes", "timeframeConfirmations", "mtf"]) delete clean[field];
  return { ...clean, ...normalizePlayDiagnostics(signal) } as T & PlayDiagnostics;
}
