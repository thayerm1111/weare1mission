import type { AtlasMarketSnapshot, AtlasMarketSymbol } from "./marketIntelligence";

export type AtlasTick = { symbol: string; price: number; receivedAt: string; providerAt: string | null };
export type AtlasQuote = {
  price: number | null; source: "tick" | "candle" | "none"; at: number | null;
  live: boolean; ageMs: number | null; providerTimed: boolean;
};
const time = (value: unknown, now: number): number | null => {
  const n = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(n) && n > 0 && n <= now + 3000 ? Math.min(n, now) : null;
};
const empty = (): AtlasQuote => ({ price: null, source: "none", at: null, live: false, ageMs: null, providerTimed: false });

/** Choose the newest timestamped observation. A provider-cache retrieval is not
 * the observation time of a forming candle. Only the frame's verified closedAt
 * can establish a candle quote's age; ticks retain their own provider/receipt time.
 * A forming-only fallback may display its value, but has no claimed age or live status. */
export function atlasQuote(
  snapshot: AtlasMarketSnapshot | null, symbol: AtlasMarketSymbol,
  tick: AtlasTick | undefined, now: number, marketOpen: boolean,
): AtlasQuote {
  if (!Number.isFinite(now) || now <= 0) return empty();
  let result = empty();
  let untimed: AtlasQuote | null = null, untimedOpen = -Infinity;
  if (snapshot?.symbol === symbol && time(snapshot.asOf, now) != null) {
    // Prefer the newest verified close; on a tie the shorter frame is more precise.
    for (const frame of Object.values(snapshot.frames).sort((a, b) => b.ms - a.ms)) {
      if (!frame.timeKnown || frame.dateOnly || frame.status === "unavailable" || !frame.bars.length ||
        !Number.isFinite(frame.ms) || frame.ms <= 0) continue;
      const fetched = time(frame.fetchedAt, now), closed = time(frame.closedAt, now);
      if (fetched == null || (frame.closedAt != null && closed == null)) continue;
      const verifiedThrough = closed == null ? null : Math.min(closed, fetched, now);
      for (const bar of frame.bars) {
        if (time(bar.t, now) == null || ![bar.o, bar.h, bar.l, bar.c].every((value) => Number.isFinite(value) && value > 0) ||
          bar.h < Math.max(bar.o, bar.c, bar.l) || bar.l > Math.min(bar.o, bar.c, bar.h)) continue;
        const end = bar.t + frame.ms;
        if (verifiedThrough != null && end <= verifiedThrough) {
          if (result.at == null || end >= result.at) {
            result = { price: bar.c, source: "candle", at: end, live: false, ageMs: now - end, providerTimed: true };
          }
        } else if (bar.t >= untimedOpen) {
          untimedOpen = bar.t;
          untimed = { price: bar.c, source: "candle", at: null, live: false, ageMs: null, providerTimed: false };
        }
      }
    }
  }
  if (result.source === "none" && untimed) result = untimed;
  if (!tick || typeof tick.symbol !== "string" || tick.symbol.replace(/\//g, "") !== symbol || !(tick.price > 0) || !Number.isFinite(tick.price)) return result;
  const received = time(tick.receivedAt, now);
  const hasProviderTime = tick.providerAt != null && tick.providerAt !== "";
  const provider = hasProviderTime ? time(tick.providerAt, now) : null;
  // An explicitly malformed/future provider time is not a fresh tick.
  if (received == null || (hasProviderTime && provider == null)) return result;
  const at = provider == null ? received : Math.min(provider, received);
  const live = marketOpen && now - received <= 6000 && now - at <= 6000;
  if (result.at == null || at >= result.at) {
    result = { price: tick.price, source: "tick", at, live, ageMs: Math.max(0, now - at), providerTimed: provider != null };
  }
  return result;
}
