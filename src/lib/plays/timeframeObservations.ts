/**
 * Display observations for a completed OM AI Play. This module cannot change a trade decision:
 * it receives the already-chosen side and the route's existing checklist evaluator, and returns
 * additional facts only. A missing feed remains missing, never a zero-score or ranging verdict.
 */
export type ObservationCandle = { datetime: string; open: string; high: string; low: string; close: string };
export type ObservationData = ObservationCandle[] | "ratelimit" | null;
type Trend = "bullish" | "bearish" | "ranging";
type Factor = { label: string; ok: boolean };
export type TimeframeObservation = {
  tf: "4H" | "1H" | "30M" | "15M" | "5M";
  trend: Trend | null; aligned: boolean | null;
  confirmed: number | null; total: number | null; checklist: Factor[];
  /** The feed's timestamp for its last closed candle; its timezone is not inferred. */
  asOf: string | null; closed: true; unavailable: boolean;
  reason?: "rate_limited" | "insufficient_data" | "unavailable";
};

export const CONFIRMATION_FRAMES = [
  { tf: "4H", interval: "4h", size: 60, ttlMs: 120_000 },
  { tf: "1H", interval: "1h", size: 60, ttlMs: 60_000 },
  { tf: "30M", interval: "30min", size: 80, ttlMs: 30_000 },
  { tf: "15M", interval: "15min", size: 80, ttlMs: 30_000 },
  { tf: "5M", interval: "5min", size: 80, ttlMs: 30_000 },
] as const;
type Frame = typeof CONFIRMATION_FRAMES[number];

const unavailable = (tf: Frame["tf"], reason: NonNullable<TimeframeObservation["reason"]>): TimeframeObservation => ({
  tf, trend: null, aligned: null, confirmed: null, total: null, checklist: [], asOf: null, closed: true, unavailable: true, reason,
});

function closedCandles(raw: ObservationCandle[]): ObservationCandle[] {
  // Always discard the newest (potentially forming) bar, including short feeds. Do not let a minimum-bar
  // fallback count a forming candle as closed. Fifty completed candles are needed for this trend rule.
  return raw.slice(0, -1).filter((r) => {
    if (!r || typeof r.datetime !== "string" || !r.datetime) return false;
    const values = [+r.open, +r.high, +r.low, +r.close];
    return values.every((n) => Number.isFinite(n) && n > 0)
      && +r.high >= Math.max(+r.open, +r.close) && +r.low <= Math.min(+r.open, +r.close);
  });
}

/** A single shared deadline bounds all optional feeds; requests run concurrently through the caller's cache. */
export async function collectTimeframeConfirmations(input: {
  existing: ReadonlyMap<string, ObservationData>;
  direction: "LONG" | "SHORT";
  load: (frame: Frame) => Promise<ObservationData>;
  evaluate: (closed: ObservationCandle[]) => { tfTrend: Trend; checklist: Factor[] };
  deadlineMs: number;
  /** Injectable clock for deterministic deadline tests. */
  now?: () => number;
}): Promise<TimeframeObservation[]> {
  const now = input.now ?? Date.now;
  return Promise.all(CONFIRMATION_FRAMES.map(async (frame): Promise<TimeframeObservation> => {
    try {
      let raw = input.existing.get(frame.interval);
      if (!input.existing.has(frame.interval)) {
        const remaining = Math.max(0, Math.min(4_000, input.deadlineMs - now()));
        if (remaining === 0) return unavailable(frame.tf, "unavailable");
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          raw = await Promise.race([
            Promise.resolve().then(() => input.load(frame)).catch(() => null),
            new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), remaining); }),
          ]);
        } finally { if (timer !== undefined) clearTimeout(timer); }
      }
      if (raw === "ratelimit") return unavailable(frame.tf, "rate_limited");
      if (!Array.isArray(raw)) return unavailable(frame.tf, "unavailable");
      const closed = closedCandles(raw);
      if (closed.length < 50) return unavailable(frame.tf, "insufficient_data");
      const result = input.evaluate(closed);
      const checklist = result.checklist.map((factor) => ({ label: factor.label, ok: factor.ok }));
      return {
        tf: frame.tf, trend: result.tfTrend,
        aligned: result.tfTrend === (input.direction === "LONG" ? "bullish" : "bearish"),
        confirmed: checklist.filter((factor) => factor.ok).length, total: checklist.length, checklist,
        asOf: closed[closed.length - 1].datetime, closed: true, unavailable: false,
      };
    } catch { return unavailable(frame.tf, "unavailable"); }
  }));
}
