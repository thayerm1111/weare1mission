import type { AtlasIdea } from "../../../command-center/engines/idea";
import { timedBars } from "@/lib/chart/candleTime";
import type { ChartLevel } from "@/lib/floor/chart";

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Display only the immutable five-minute candles retained with this Command Center call. */
export function atlasIdeaChart(idea: AtlasIdea) {
  const snapshot = idea.chart?.tf === "5m" ? idea.chart : null;
  const raw = snapshot && Array.isArray(snapshot.candles) ? snapshot.candles.filter((bar) =>
    bar && typeof bar === "object" && !Array.isArray(bar) && finite(bar.t)
    && bar.t >= 0 && (!finite(idea.at) || bar.t <= idea.at)).slice(-500) : [];
  // Command Center's Bar timestamps are numeric UTC instants from its existing market-data adapters.
  const { bars, known } = timedBars(raw, "UTC");
  const direction: "buy" | "sell" | "neutral" = idea.kind !== "stand_aside" && (idea.side === "buy" || idea.side === "sell") ? idea.side : "neutral";
  const reference = idea.kind !== "enter_now";
  const prefix = reference ? "Reference " : "";
  const levels: ChartLevel[] = [];
  if (direction !== "neutral") {
    if (finite(idea.entry?.price)) levels.push({ kind: "entry", label: `${prefix}entry`, price: idea.entry.price });
    if (finite(idea.stop?.price)) levels.push({ kind: "stop", label: `${prefix}stop`, price: idea.stop.price });
    if (Array.isArray(idea.targets)) idea.targets.slice(0, 3).forEach((target, index) => {
      if (finite(target?.price)) levels.push({ kind: "target", label: `${prefix}target ${index + 1}`, price: target.price });
    });
  }
  const zone = direction !== "neutral" && finite(idea.entry?.low) && finite(idea.entry?.high) && idea.entry.high > idea.entry.low
    ? { low: idea.entry.low, high: idea.entry.high } : null;
  return {
    bars, timeKnown: known, tfLabel: snapshot ? "5M" : "Saved candles", tfMs: snapshot ? 300_000 : 0,
    price: finite(idea.price) ? idea.price : null, dec: 2, levels, zone, direction, reference,
    viewKey: `atlas-idea:${idea.id ?? "unsaved"}:${idea.at}:${snapshot?.tf ?? "unknown"}`,
  };
}
