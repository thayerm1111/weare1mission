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
    // REJECTING / RECLAIM — the entry-timing core. A CLEAN rejection matters
    // more than a large candle body (owner rule): the level was tested, the
    // other side failed to hold beyond it, and a completed 15M candle closed
    // back on the right side. Confirmation comes from the EARLIEST reliable
    // signal: (a) the reclaim candle itself closing directionally, (b) a later
    // closed candle confirming, or (c) METHOD B — price breaking the completed
    // rejection candle's extreme while still near the zone (the setup candle
    // is already closed; the next price action is only the execution trigger).
    if (kind === "resistance") {
      const rejBar = recent.slice(-3).find((x) => x.h >= low - buf && x.c < low);
      if (rejBar) {
        const sellersFailing = recent.slice(-2).every((x) => x.c < high + buf);
        const wickPct = Math.round(((rejBar.h - Math.max(rejBar.o, rejBar.c)) / Math.max(rejBar.h - rejBar.l, 1e-9)) * 100);
        const closeConfirm = (k.c < k.o && k.c < low) || (rejBar === k && k.c < k.o);
        const followThrough = o.price < rejBar.l && o.price > low - 2.5 * o.atr15; // broke the rejection candle's low, still near the zone
        if ((closeConfirm || followThrough) && sellersFailing) {
          return { state: "REJECTING", brokeDirection: null, confirmedByClose: true, detail: `RESISTANCE_RECLAIM: tested ${f(low)}–${f(high)} (wick ${wickPct}%, spiked ${f(rejBar.h)}), closed back at ${f(rejBar.c)} — buyers failed to hold it${closeConfirm ? "; red close confirms" : `; price broke the rejection candle's low ${f(rejBar.l)} — follow-through trigger`}.` };
        }
        return { state: "REJECTING", brokeDirection: null, confirmedByClose: false, detail: `Rejection forming at ${f(low)}–${f(high)} (spiked ${f(rejBar.h)}, closed ${f(rejBar.c)}) — trigger: a red close, or a break under ${f(rejBar.l)} while near the zone.` };
      }
    } else {
      const rejBar = recent.slice(-3).find((x) => x.l <= high + buf && x.c > high);
      if (rejBar) {
        const buyersHolding = recent.slice(-2).every((x) => x.c > low - buf);
        const wickPct = Math.round(((Math.min(rejBar.o, rejBar.c) - rejBar.l) / Math.max(rejBar.h - rejBar.l, 1e-9)) * 100);
        const closeConfirm = (k.c > k.o && k.c > high) || (rejBar === k && k.c > k.o);
        const followThrough = o.price > rejBar.h && o.price < high + 2.5 * o.atr15; // broke the reclaim candle's high, still near the zone
        if ((closeConfirm || followThrough) && buyersHolding) {
          return { state: "REJECTING", brokeDirection: null, confirmedByClose: true, detail: `SUPPORT_RECLAIM: tested ${f(low)}–${f(high)} (wick ${wickPct}%, dipped ${f(rejBar.l)}), closed back at ${f(rejBar.c)} — sellers failed to hold below${closeConfirm ? "; green close confirms" : `; price broke the reclaim candle's high ${f(rejBar.h)} — follow-through trigger`}.` };
        }
        return { state: "REJECTING", brokeDirection: null, confirmedByClose: false, detail: `Reclaim forming at ${f(low)}–${f(high)} (dipped ${f(rejBar.l)}, closed ${f(rejBar.c)}) — trigger: a green close, or a break over ${f(rejBar.h)} while near the zone.` };
      }
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
