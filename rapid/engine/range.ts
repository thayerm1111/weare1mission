import type { Bar, Timeframe, ValidatedRange, Zone } from "../core/types";
import { TF_MS } from "../market/bars";
import { collectReactions, zoneMid } from "./zones";
import type { RapidConfig } from "../config/defaults";

/**
 * Range validation.
 *
 * A "range" here is a conservative, mechanical approximation of what Matthew sees on a chart, and it
 * is deliberately stricter than the eye. To count, an enclosing upper/lower pair must show at least
 * two COMPLETED reaction visits at EACH boundary inside the lookback, every visit separated by a real
 * move away, both boundaries still unbroken by the close rule, and enough clear room between them to
 * pay for the minimum target.
 *
 * `blockedExamples` in the research harness records how often this definition refuses a range a human
 * would have traded. That number is the thing to argue with — not this code.
 */
export function validateRange(
  bars: Bar[],
  zones: Zone[],
  timeframe: Timeframe,
  asOf: number,
  atrEntry: number,
  cfg: RapidConfig,
): { range: ValidatedRange | null; reason: string } {
  const barMs = TF_MS[timeframe];
  const closed = bars.filter((b) => b.t + barMs <= asOf);
  if (closed.length < cfg.range.lookbackBars) {
    return { range: null, reason: `only ${closed.length} closed ${timeframe} bars; need ${cfg.range.lookbackBars}` };
  }
  const window = closed.slice(-cfg.range.lookbackBars);
  const windowStart = window[0].t;
  const separation = Math.max(cfg.range.separationUsd, cfg.range.separationAtrMult * atrEntry);

  const supports = zones.filter((z) => z.role === "support" && z.knownAt <= asOf && z.invalidatedAt == null);
  const resistances = zones.filter((z) => z.role === "resistance" && z.knownAt <= asOf && z.invalidatedAt == null);
  if (!supports.length || !resistances.length) return { range: null, reason: "no enclosing support/resistance pair" };

  const hi = Math.max(...window.map((b) => b.h));
  const lo = Math.min(...window.map((b) => b.l));

  let best: ValidatedRange | null = null;
  let why = "no pair met the reaction, containment and room tests";

  for (const lower of supports) {
    for (const upper of resistances) {
      if (zoneMid(upper) <= zoneMid(lower)) continue;
      // The pair must actually enclose the window's travel, not sit inside it.
      if (upper.high < hi - 1e-9 || lower.low > lo + 1e-9) { why = "boundaries do not enclose the lookback window"; continue; }

      const upTouches = collectReactions(window, upper, separation, timeframe, asOf).filter((r) => r.at >= windowStart);
      const loTouches = collectReactions(window, lower, separation, timeframe, asOf).filter((r) => r.at >= windowStart);
      if (upTouches.length < cfg.range.minTouchesPerSide || loTouches.length < cfg.range.minTouchesPerSide) {
        why = `reactions ${loTouches.length}/${upTouches.length}; need ${cfg.range.minTouchesPerSide} at each boundary`;
        continue;
      }

      // Containment by the close rule: no completed close beyond either far edge.
      const broken = window.find((b) => b.c > upper.high || b.c < lower.low);
      if (broken) { why = `a completed close at ${broken.c} left the range`; continue; }

      // Net room: the distance between the inner edges must pay for the minimum target plus buffers.
      const room = lower.high < upper.low ? upper.low - lower.high : 0;
      if (room < cfg.target.minUsd) { why = `net room ${room.toFixed(2)} below the ${cfg.target.minUsd} minimum target`; continue; }

      const knownAt = Math.max(
        upper.knownAt,
        lower.knownAt,
        upTouches[cfg.range.minTouchesPerSide - 1].at,
        loTouches[cfg.range.minTouchesPerSide - 1].at,
      );
      const candidate: ValidatedRange = {
        id: `range:${lower.parentId}:${upper.parentId}`,
        upper,
        lower,
        timeframe,
        knownAt,
        upperTouches: upTouches.length,
        lowerTouches: loTouches.length,
        room,
        brokenAt: null,
        brokenBy: null,
      };
      // Prefer the widest validated range: it is the one with the most room to pay for a target.
      if (!best || candidate.room > best.room) best = candidate;
    }
  }
  return best ? { range: best, reason: `validated: ${best.lowerTouches} lower and ${best.upperTouches} upper reactions, ${best.room.toFixed(2)} room` } : { range: null, reason: why };
}

/**
 * Has a qualifying breakout changed the range's state? A fading setup must be cancelled BEFORE any
 * new entry is considered, so this is checked on every closed bar rather than at entry time.
 */
export function rangeBroken(range: ValidatedRange, closedBar: Bar, breakBuffer: number, barMs: number): ValidatedRange | null {
  if (closedBar.c > range.upper.high + breakBuffer) {
    return { ...range, brokenAt: closedBar.t + barMs, brokenBy: "buy" };
  }
  if (closedBar.c < range.lower.low - breakBuffer) {
    return { ...range, brokenAt: closedBar.t + barMs, brokenBy: "sell" };
  }
  return null;
}
