/**
 * MATTY PIPS — the REACTION ENGINE. The heart of the system.
 * Classifies what price is DOING at the active level/complex, on CLOSED 15M
 * candles only. A wick through a level is NEVER an accepted break.
 *
 *   APPROACHING → TESTING → RESPECTING / REJECTING / FAILED_BREAK
 *                          → ACCEPTED_BREAK → BREAK_RETEST / MOMENTUM_CONTINUATION
 *                          → EXPANSION_BREAKOUT (violent break, own decision path)
 */
import type { Candle, ReactionRead } from "./types";

const f = (n: number) => (n >= 100 ? n.toFixed(1) : n.toFixed(4).replace(/0+$/, "").replace(/\.$/, ""));

export function readReaction(o: {
  node: { low: number; high: number; kind: "support" | "resistance" };
  price: number;
  m15: Candle[];
  atr15: number;
  atr1h: number;
}): ReactionRead {
  const closed = o.m15.slice(0, -1);       // NEVER read the forming candle
  const none: ReactionRead = { state: "NONE", detail: "Not enough 15M history.", brokeDirection: null, confirmedByClose: false };
  if (closed.length < 12) return none;

  const { low, high, kind } = o.node;
  const buf = 0.25 * o.atr15;
  const look = closed.slice(-48);          // ~12 hours of 15M behavior
  const k = look[look.length - 1];         // last closed candle
  const upEdge = high, dnEdge = low;

  // ── Find the most recent ACCEPTED break (a CLOSE beyond the far edge + buffer).
  let brokeUpIdx = -1, brokeDnIdx = -1;
  for (let i = look.length - 1; i >= 0; i--) {
    if (brokeUpIdx === -1 && look[i].c > upEdge + buf) brokeUpIdx = i;
    if (brokeDnIdx === -1 && look[i].c < dnEdge - buf) brokeDnIdx = i;
    if (brokeUpIdx !== -1 && brokeDnIdx !== -1) break;
  }
  // The break that matters is the one price is currently living on the other side of.
  const beyondUp = o.price > upEdge + buf, beyondDn = o.price < dnEdge - buf;
  const breakIdx = beyondUp && brokeUpIdx !== -1 ? brokeUpIdx : beyondDn && brokeDnIdx !== -1 ? brokeDnIdx : -1;
  const brokeDir: "up" | "down" | null = breakIdx === -1 ? null : beyondUp ? "up" : "down";

  if (breakIdx !== -1 && brokeDir) {
    const bk = look[breakIdx];
    const range = Math.max(bk.h - bk.l, 1e-9);
    const after = look.slice(breakIdx + 1);
    const edge = brokeDir === "up" ? upEdge : dnEdge;

    // EXPANSION: a violently large break candle (or immediate travel) — its own path.
    const travel = brokeDir === "up" ? bk.c - edge : edge - bk.c;
    if (range >= 2.0 * o.atr15 || travel >= 1.5 * o.atr15) {
      return {
        state: "EXPANSION_BREAKOUT", brokeDirection: brokeDir, confirmedByClose: true,
        detail: `Explosive break: candle range ${f(range)} (${(range / o.atr15).toFixed(1)}×ATR15) closed ${f(bk.c)} — ${f(travel)} beyond the ${f(edge)} edge. Own decision path: no chasing, no blind fading.`,
      };
    }

    // Retest? price came back to the broken edge after the break.
    const touched = after.some((x) => (brokeDir === "up" ? x.l <= edge + buf : x.h >= edge - buf));
    const held = after.length > 0 && after.every((x) => (brokeDir === "up" ? x.c > edge - buf : x.c < edge + buf));
    if (touched && held) {
      const confirmed = brokeDir === "up" ? k.c > k.o : k.c < k.o;
      return {
        state: "BREAK_RETEST", brokeDirection: brokeDir, confirmedByClose: confirmed,
        detail: `Closed ${brokeDir === "up" ? "above" : "below"} ${f(edge)}, came back to retest it, and the level is holding as new ${brokeDir === "up" ? "support" : "resistance"}${confirmed ? " with a confirming close" : " — waiting on the confirming candle"}.`,
      };
    }
    if (touched && !held) {
      return {
        state: "FAILED_BREAK", brokeDirection: brokeDir, confirmedByClose: true,
        detail: `Break of ${f(edge)} lost the level on the retest — treated as a failed break, not a breakout.`,
      };
    }
    // No retest yet — momentum continuation candidate (evaluator decides chase/wait).
    return {
      state: "MOMENTUM_CONTINUATION", brokeDirection: brokeDir, confirmedByClose: true,
      detail: `Accepted break of ${f(edge)} (${look.length - 1 - breakIdx} closed candles ago) with no retest yet — continuation evaluator decides.`,
    };
  }

  // ── No accepted break in force. Did price poke beyond and get slapped back?
  const recent = look.slice(-6);
  const farEdge = kind === "resistance" ? upEdge : dnEdge;
  const sweep = recent.find((x) => kind === "resistance" ? (x.h > farEdge && x.c < farEdge) : (x.l < farEdge && x.c > farEdge));
  if (sweep) {
    const confirmed = kind === "resistance" ? k.c < k.o && k.c < upEdge : k.c > k.o && k.c > dnEdge;
    return {
      state: "FAILED_BREAK", brokeDirection: kind === "resistance" ? "up" : "down", confirmedByClose: confirmed,
      detail: kind === "resistance"
        ? `Traded ${f(sweep.h)} above ${f(farEdge)} but the 15M closed back at ${f(sweep.c)} — liquidity sweep, resistance did NOT break${confirmed ? "; bearish close confirms" : "; waiting on the confirming candle"}.`
        : `Traded ${f(sweep.l)} below ${f(farEdge)} but the 15M closed back at ${f(sweep.c)} — liquidity sweep, support did NOT break${confirmed ? "; bullish close confirms" : "; waiting on the confirming candle"}.`,
    };
  }

  // Touching / inside the band?
  const inside = o.price >= low - buf && o.price <= high + buf;
  const touchedRecently = recent.some((x) => x.l <= high + buf && x.h >= low - buf);
  if (inside || touchedRecently) {
    // REJECTING: a candle reacted off the level AND a closed candle confirms direction
    // (no size threshold — the question is "did it reject and did the close confirm?").
    if (kind === "resistance") {
      const rejBar = recent.slice(-3).find((x) => x.h >= low - buf && x.c < low && (x.h - Math.max(x.o, x.c)) / Math.max(x.h - x.l, 1e-9) >= 0.35);
      const confirming = k.c < k.o && k.c < low;
      if (rejBar && (confirming || (rejBar === k && k.c < k.o))) {
        return { state: "REJECTING", brokeDirection: null, confirmedByClose: true, detail: `Rejected ${f(low)}–${f(high)}: wick to ${f(rejBar.h)}, closed ${f(rejBar.c)} back under, and a red candle confirms the move away.` };
      }
      if (rejBar) return { state: "REJECTING", brokeDirection: null, confirmedByClose: false, detail: `Wick rejection at ${f(low)}–${f(high)} (high ${f(rejBar.h)}, close ${f(rejBar.c)}) — waiting for the confirming red close.` };
    } else {
      const rejBar = recent.slice(-3).find((x) => x.l <= high + buf && x.c > high && (Math.min(x.o, x.c) - x.l) / Math.max(x.h - x.l, 1e-9) >= 0.35);
      const confirming = k.c > k.o && k.c > high;
      if (rejBar && (confirming || (rejBar === k && k.c > k.o))) {
        return { state: "REJECTING", brokeDirection: null, confirmedByClose: true, detail: `Rejected ${f(low)}–${f(high)}: wick to ${f(rejBar.l)}, closed ${f(rejBar.c)} back above, and a green candle confirms the move away.` };
      }
      if (rejBar) return { state: "REJECTING", brokeDirection: null, confirmedByClose: false, detail: `Wick rejection at ${f(low)}–${f(high)} (low ${f(rejBar.l)}, close ${f(rejBar.c)}) — waiting for the confirming green close.` };
    }
    // RESPECTING: multiple touches, closes keep holding the original side, no progress through.
    const touches = look.slice(-12).filter((x) => x.l <= high + buf && x.h >= low - buf).length;
    const holding = kind === "resistance" ? recent.every((x) => x.c < upEdge + buf) : recent.every((x) => x.c > dnEdge - buf);
    if (touches >= 2 && holding) {
      return { state: "RESPECTING", brokeDirection: null, confirmedByClose: false, detail: `${touches} touches of ${f(low)}–${f(high)} in the last 12 candles with every close holding the level — ${kind} is being respected, no confirmed rejection yet.` };
    }
    return { state: "TESTING", brokeDirection: null, confirmedByClose: false, detail: `Price is trading at ${f(low)}–${f(high)} — the level hasn't given its verdict yet.` };
  }

  // Not there yet.
  const dist = o.price < low ? low - o.price : o.price - high;
  if (dist <= 1.2 * o.atr1h) {
    return { state: "APPROACHING", brokeDirection: null, confirmedByClose: false, detail: `Traveling toward ${f(low)}–${f(high)} (${f(dist)} away).` };
  }
  return none;
}
