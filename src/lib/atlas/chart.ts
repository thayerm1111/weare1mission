import type { PlayView } from "@/components/om/plays/PlayDetail";
import { timedBars } from "@/lib/chart/candleTime";
import { decimalsFor } from "@/lib/flow/display";
import type { ChartLevel } from "@/lib/floor/chart";
import { analysisOf } from "@/lib/plays/lifecycle";

const INTERVALS: Record<string, { label: string; ms: number }> = {
  "1min": { label: "1M", ms: 60_000 }, "5min": { label: "5M", ms: 300_000 },
  "15min": { label: "15M", ms: 900_000 }, "30min": { label: "30M", ms: 1_800_000 },
  "1h": { label: "1H", ms: 3_600_000 }, "2h": { label: "2H", ms: 7_200_000 },
  "4h": { label: "4H", ms: 14_400_000 }, "1day": { label: "1D", ms: 86_400_000 },
  "1week": { label: "1W", ms: 604_800_000 },
};
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * The exact candles and levels that came with this play, never another instrument's live chart.
 * OM snapshots do not declare a candle timezone: preserve their spacing, without claiming clock times
 * or that every candle is closed. The separate five-frame evidence keeps its own closed-bar labels.
 */
export function atlasPlayChart(play: PlayView) {
  const raw = Array.isArray(play.candles) ? play.candles.slice(-500).filter((bar) => bar && typeof bar === "object"
    && !Array.isArray(bar) && (typeof bar.t === "string" || finite(bar.t))) : [];
  const { bars, known } = timedBars(raw, null);
  const interval = typeof play.interval === "string" ? play.interval : "";
  const tf = Object.hasOwn(INTERVALS, interval) ? INTERVALS[interval] : { label: "Saved candles", ms: 0 };
  const analysis = analysisOf(play.signal), reference = analysis.kind === "idea";
  const levels: ChartLevel[] = [];
  const add = (kind: ChartLevel["kind"], price: unknown, label: string) => {
    if (finite(price)) levels.push({ kind, price, label: reference ? `Reference ${label.toLowerCase()}` : label });
  };
  if (analysis.kind !== "none") {
    add("entry", play.signal.entry, String(play.orderType).toLowerCase() === "limit" ? "Limit entry" : "Entry");
    add("stop", play.signal.stopLoss, "Stop");
    if (Array.isArray(play.signal.takeProfits)) play.signal.takeProfits.slice(0, 3).forEach((price, i) => add("target", price, `Target ${i + 1}`));
  }
  const price = finite(play.live_price) ? play.live_price : finite(play.price) ? play.price : bars.at(-1)?.c ?? null;
  return {
    bars, timeKnown: known, tfLabel: tf.label, tfMs: tf.ms, levels, price, reference,
    dec: decimalsFor(play.symbol, price ?? 0),
    viewKey: `atlas-play:${play.id}:${play.symbol}:${interval}:${play.as_of ?? play.asOf}`,
  };
}
