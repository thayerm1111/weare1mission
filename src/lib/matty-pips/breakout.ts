/**
 * MATTY PIPS — breakout phase machine for the BREAKOUT RUNNER setup.
 * Evaluated deterministically from recent 15M closed candles against a zone:
 * APPROACHING → TESTING → (FAKE) → CONFIRMED → RETEST → CONTINUATION.
 */
import type { BreakoutPhase, Candle, Zone } from "./types";

const f = (n: number) => (n >= 100 ? n.toFixed(1) : n.toFixed(4).replace(/0+$/, "").replace(/\.$/, ""));

export function breakoutRead(o: {
  zone: Zone;                    // the zone being broken
  direction: "up" | "down";      // up = through resistance, down = through support
  price: number;
  m15: Candle[];
  atr15: number;
  atr1h: number;
}): { phase: BreakoutPhase; detail: string } {
  const closed = o.m15.slice(0, -1);
  if (closed.length < 12) return { phase: "NONE", detail: "Not enough 15M history." };
  const z = o.zone;
  const buf = 0.25 * o.atr15;
  const edge = o.direction === "up" ? z.zoneHigh : z.zoneLow;
  const beyond = (c: number) => (o.direction === "up" ? c > edge + buf : c < edge - buf);
  const look = closed.slice(-40);

  // Find the most recent CONFIRMED close beyond the edge + buffer.
  let confirmIdx = -1;
  for (let i = look.length - 1; i >= 0; i--) {
    if (beyond(look[i].c)) { confirmIdx = i; break; }
  }

  if (confirmIdx === -1) {
    // No confirmed close. Fake? poked beyond intrabar but closed back inside recently.
    const lastFew = look.slice(-4);
    const poked = lastFew.some((k) => (o.direction === "up" ? k.h > edge : k.l < edge) && !beyond(k.c));
    const inside = o.price >= z.zoneLow && o.price <= z.zoneHigh;
    if (poked && !inside) return { phase: "FAKE", detail: `Poked ${o.direction === "up" ? "above" : "below"} ${f(edge)} intrabar but closed back — failed break so far.` };
    if (inside) return { phase: "TESTING", detail: `Price is inside the ${f(z.zoneLow)}–${f(z.zoneHigh)} zone, testing it.` };
    const dist = o.direction === "up" ? edge - o.price : o.price - edge;
    if (dist >= 0 && dist <= 1.0 * o.atr1h) return { phase: "APPROACHING", detail: `Within 1×ATR(1H) of the zone edge ${f(edge)}.` };
    return { phase: "NONE", detail: `No live breakout interaction with ${f(z.zoneLow)}–${f(z.zoneHigh)}.` };
  }

  // Confirmed. Has a retest happened after it?
  const after = look.slice(confirmIdx + 1);
  const touchedEdge = after.some((k) => (o.direction === "up" ? k.l <= edge + buf : k.h >= edge - buf));
  const heldEdge = after.length > 0 && after.every((k) => (o.direction === "up" ? k.c > edge - buf : k.c < edge + buf));

  if (touchedEdge && heldEdge) {
    // Continuation: a new 15M extreme beyond the post-break extreme after the retest touch.
    const touchIdx = after.findIndex((k) => (o.direction === "up" ? k.l <= edge + buf : k.h >= edge - buf));
    const preTouch = after.slice(0, touchIdx + 1);
    const postTouch = after.slice(touchIdx + 1);
    const breakExtreme = o.direction === "up"
      ? Math.max(look[confirmIdx].h, ...preTouch.map((k) => k.h))
      : Math.min(look[confirmIdx].l, ...preTouch.map((k) => k.l));
    const continued = postTouch.some((k) => (o.direction === "up" ? k.c > breakExtreme : k.c < breakExtreme));
    if (continued) return { phase: "CONTINUATION", detail: `Broke ${f(edge)}, retested it, and pushed past ${f(breakExtreme)} — continuation is live.` };
    return { phase: "RETEST", detail: `Confirmed break of ${f(edge)}; price came back to retest the level and is holding it.` };
  }
  if (touchedEdge && !heldEdge) {
    return { phase: "FAKE", detail: `Closed beyond ${f(edge)} but lost the level on the retest — treat as a failed break.` };
  }
  return { phase: "CONFIRMED", detail: `15M closed ${o.direction === "up" ? "above" : "below"} ${f(edge)} with the volatility buffer — break confirmed, waiting on the retest.` };
}
