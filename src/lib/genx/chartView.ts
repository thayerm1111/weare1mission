import { timedBars } from "@/lib/chart/candleTime";

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const INTERVALS: Record<string, { label: string; ms: number }> = {
  "5min": { label: "5m", ms: 300_000 },
  "15min": { label: "15m", ms: 900_000 },
  "1h": { label: "1h", ms: 3_600_000 },
};
const MODE_INTERVAL: Record<string, string> = { quick: "5min", intraday: "15min", swing: "1h" };

function timeframe(mode: unknown, interval?: unknown) {
  const key = interval == null
    ? typeof mode === "string" && Object.hasOwn(MODE_INTERVAL, mode) ? MODE_INTERVAL[mode] : ""
    : typeof interval === "string" ? interval : "";
  return { interval: key, ...(Object.hasOwn(INTERVALS, key) ? INTERVALS[key] : { label: "Saved candles", ms: 0 }) };
}

/** Filter unsafe stamps before the shared candle reader coerces them. Prices remain untouched. */
function barsOf(raw: unknown, timezone: unknown) {
  const rows = Array.isArray(raw) ? raw.slice(-500).filter((bar) => bar && typeof bar === "object"
    && !Array.isArray(bar) && (typeof bar.t === "string" || finite(bar.t))) : [];
  return timedBars(rows, timezone);
}

/**
 * Every generated read owns its original chart. The current market only supplies the free view
 * before a read is opened; it cannot fill a missing snapshot. A read also owns its own interval,
 * independently of a later horizon selection. This selects display data and never fetches anything.
 */
export function genxChartView(input: {
  mode: string;
  hasRead: boolean;
  saved: boolean;
  savedMode?: string | null;
  readMode?: unknown;
  readInterval?: unknown;
  readCandles?: unknown;
  readPrice?: unknown;
  liveCandles?: unknown;
  liveTimezone?: unknown;
  livePrice?: unknown;
}) {
  const own = barsOf(input.readCandles, null);
  const live = barsOf(input.liveCandles, input.liveTimezone);
  const snapshot = input.saved || input.hasRead;
  const selected = snapshot ? own : live;
  const source = input.saved ? own.bars.length >= 1 ? "saved" : "missing_saved"
    : snapshot ? own.bars.length >= 1 ? "read" : "missing_read" : "current";
  // A legacy record's mode belongs to its read, never to whichever horizon is selected today.
  const tf = snapshot ? timeframe(input.readMode ?? input.savedMode, input.readInterval) : timeframe(input.mode);
  const price = snapshot
    ? finite(input.readPrice) ? input.readPrice : own.bars.at(-1)?.c ?? null
    : finite(input.livePrice) ? input.livePrice : live.bars.at(-1)?.c ?? null;
  const priceFrom = finite(snapshot ? input.readPrice : input.livePrice) ? "quote" : price != null ? "candle" : null;
  return { source, snapshot, bars: selected.bars, timeKnown: selected.known, price, priceFrom, tf };
}
