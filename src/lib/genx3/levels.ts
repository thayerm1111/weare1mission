import type { Bar } from "./candles";

/** Session/liquidity levels from CLOSED 1m bars, all in UTC. Asian session = 00:00–07:00 UTC. */
export type Levels = { prevDayHigh: number | null; prevDayLow: number | null; dayOpen: number | null; weekOpen: number | null; asiaHigh: number | null; asiaLow: number | null };

const DAY = 86_400_000;
export function sessionLevels(closed1m: Bar[], asOf: number): Levels {
  const dayStart = Math.floor(asOf / DAY) * DAY;
  const prev = closed1m.filter((b) => b.t >= dayStart - DAY && b.t < dayStart);
  const today = closed1m.filter((b) => b.t >= dayStart);
  const asia = today.filter((b) => b.t < dayStart + 7 * 3_600_000);
  const dow = new Date(asOf).getUTCDay();                           // 0 = Sun
  const weekStart = dayStart - ((dow + 7) % 7) * DAY;               // Sunday 00:00 UTC
  const wk = closed1m.find((b) => b.t >= weekStart);
  const asiaComplete = asOf >= dayStart + 7 * 3_600_000;
  return {
    prevDayHigh: prev.length ? Math.max(...prev.map((b) => b.h)) : null,
    prevDayLow: prev.length ? Math.min(...prev.map((b) => b.l)) : null,
    dayOpen: today[0]?.o ?? null,
    weekOpen: wk?.o ?? null,
    asiaHigh: asiaComplete && asia.length ? Math.max(...asia.map((b) => b.h)) : null,
    asiaLow: asiaComplete && asia.length ? Math.min(...asia.map((b) => b.l)) : null,
  };
}
