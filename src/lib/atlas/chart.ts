import type { PlayView } from "@/components/om/plays/PlayDetail";
import { timedBars } from "@/lib/chart/candleTime";
import { decimalsFor } from "@/lib/flow/display";
import type { ChartLevel } from "@/lib/floor/chart";
import { analysisOf } from "@/lib/plays/lifecycle";
import type { AtlasGenxResult } from "@/lib/atlas/signals";
import { actionWords } from "@/lib/genx/words";

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

// computeGenxRead maps the engine's m15 input to these actual intervals. runEngine emits that
// input's last 48 candles; the slot name does not mean every GENX snapshot is a 15-minute chart.
const GENX_INTERVALS: Record<string, string> = { quick: "5min", intraday: "15min", swing: "1h" };

/**
 * Display only the candles and levels recorded with this GENX read. A saved BUY/SELL is still a
 * snapshot, never a new live quote; a WAIT/LIMIT/STOP remains unconfirmed reference information.
 * On-demand GENX does not declare its feed's timezone, so retain relative candle times even when
 * the read itself has a UTC asOf. Never substitute the current chart for missing historical candles.
 */
export function atlasGenxChart(result: AtlasGenxResult) {
  const raw = Array.isArray(result.candles) ? result.candles.slice(-500).filter((bar) => bar && typeof bar === "object"
    && !Array.isArray(bar) && (typeof bar.t === "string" || finite(bar.t))) : [];
  const { bars, known } = timedBars(raw, null);
  const mode = typeof result.mode === "string" ? result.mode : "";
  const interval = result.candles_tf == null
    ? Object.hasOwn(GENX_INTERVALS, mode) ? GENX_INTERVALS[mode] : ""
    : typeof result.candles_tf === "string" ? result.candles_tf : "";
  const tf = Object.hasOwn(INTERVALS, interval) ? INTERVALS[interval] : { label: "Saved candles", ms: 0 };
  const g = result.genx;
  const action = actionWords(typeof g.action === "string" ? g.action : "");
  const reference = action.side !== null && action.waiting;
  const levels: ChartLevel[] = [];
  const add = (kind: ChartLevel["kind"], price: unknown, label: string, trade = false) => {
    if (finite(price)) levels.push({ kind, price, label: trade && reference ? `Reference ${label.toLowerCase()}` : label });
  };
  // Market structure remains readable on HOLD/no-trade reads. Directional bias alone never turns
  // their dormant levels into an entry plan; only the existing engine action identifies a setup.
  add("support", g.closest_support, "Support");
  add("resistance", g.closest_resistance, "Resistance");
  let zone: { low: number; high: number } | null = null;
  if (action.side !== null) {
    add("entry", g.entry, "Entry", true);
    add("stop", g.stop_loss, "Stop", true);
    add("target", g.tp1, "Target 1", true);
    add("target", g.tp2, "Target 2", true);
    add("target", g.tp3, "Target 3", true);
    if (finite(g.entry_low) && finite(g.entry_high) && g.entry_high > g.entry_low) zone = { low: g.entry_low, high: g.entry_high };
  }
  const price = finite(result.price) ? result.price : bars.at(-1)?.c ?? null;
  const symbol = typeof result.symbol === "string" ? result.symbol : "GENX";
  const id = typeof result.signal_id === "string" ? result.signal_id : "unsaved";
  const at = typeof result.asOf === "string" ? result.asOf : "undated";
  return {
    bars, timeKnown: known, tfLabel: tf.label, tfMs: tf.ms, levels, zone, price, reference, symbol,
    dec: decimalsFor(symbol, price ?? 0),
    viewKey: `atlas-genx:${id}:${symbol}:${mode}:${interval}:${at}`,
  };
}
