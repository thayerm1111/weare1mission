import { stampMs } from "../chart/candleTime";

const HOUR = 3_600_000;
const HOURS = 6;
export type PulseComparison = { end: number; changes: number[] };

/** The same six elapsed hours for every asset. A missing close or session gap leaves its row blank. */
export function pulseComparison(rows: { datetime: string; close: string }[], scanAt: number): PulseComparison | null {
  const end = Math.floor(scanAt / HOUR) * HOUR;
  const closes = new Map<number, number>();
  for (const row of rows) {
    const close = Number(row.close);
    if (Number.isFinite(close) && close > 0) closes.set(stampMs(row.datetime) + HOUR, close);
  }
  const start = end - HOURS * HOUR;
  const base = closes.get(start);
  if (!base) return null;
  const changes: number[] = [];
  for (let t = start; t <= end; t += HOUR) {
    const close = closes.get(t);
    if (!close) return null;
    changes.push(100 * (close - base) / base);
  }
  return { end, changes };
}

export function readComparison(value: unknown, scanAt: number | null): PulseComparison | null {
  if (!value || typeof value !== "object" || !scanAt) return null;
  const { end, changes } = value as Partial<PulseComparison>;
  if (end !== Math.floor(scanAt / HOUR) * HOUR || !Array.isArray(changes) || changes.length !== HOURS + 1 ||
      changes[0] !== 0 || !changes.every(n => typeof n === "number" && Number.isFinite(n) && n > -100)) return null;
  return { end, changes };
}
