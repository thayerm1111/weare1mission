import type { TimedBar } from "../chart/candleTime";
import type { ActiveTradeScope } from "../floor/activeTradeTypes";

export type FlowPositionChart = ActiveTradeScope & {
  ok: true;
  positionId: string;
  symbol: string;
  brokerSymbol: string | null;
  side: "buy" | "sell";
  observedAt: string;
  entry: number | null;
  stop: number | null;
  target: number | null;
  unrealizedPnl: number | null;
  bars: TimedBar[];
};

const FIVE_MINUTES = 300_000;
export const FLOW_CHART_HISTORY_MS = 24 * 60 * 60_000;

function numeric(value: unknown): number {
  return typeof value === "number" || typeof value === "string" && value.trim() ? Number(value) : NaN;
}

export function completedBrokerBars(rows: unknown, asOf: number): TimedBar[] {
  if (!Array.isArray(rows)) return [];
  const bars = new Map<number, TimedBar>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const stamp = numeric(row.t);
    const t = stamp < 1e12 ? stamp * 1000 : stamp;
    if (!Number.isSafeInteger(t) || t < asOf - FLOW_CHART_HISTORY_MS || t + FIVE_MINUTES > asOf) continue;
    const o = numeric(row.o), h = numeric(row.h), l = numeric(row.l), c = numeric(row.c);
    if (![o, h, l, c].every(n => Number.isFinite(n) && n > 0) || h < Math.max(o, c) || l > Math.min(o, c)) continue;
    bars.set(t, { t, o, h, l, c });
  }
  return [...bars.values()].sort((a, b) => a.t - b.t).slice(-90);
}
