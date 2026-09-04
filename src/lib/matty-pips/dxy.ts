/**
 * MATTY PIPS — DXY cross-market context for gold. SUPPORTING evidence only:
 * it can raise or lower confidence a few points, it can NEVER veto a valid
 * gold price-action setup. No hardcoded "DXY up = gold sell" — the recent
 * gold/DXY relationship is measured, so a dislocated regime is detected.
 * Fails soft: no data → DXY_UNAVAILABLE (treated as neutral).
 */
import { series, type Row } from "@/lib/marketData";
import type { Candle, DxyVerdict } from "./types";

function toCandles(rows: Row[]): Candle[] {
  return rows.map((r) => ({ t: Date.parse(r.datetime), o: +r.open, h: +r.high, l: +r.low, c: +r.close }))
    .filter((c) => [c.o, c.h, c.l, c.c].every(Number.isFinite));
}

/** Sign of the recent gold↔dollar relationship via return correlation. */
function corrSign(gold: Candle[], usd: Candle[]): number {
  const n = Math.min(gold.length, usd.length, 40);
  if (n < 12) return -1; // default inverse (the historical norm)
  const g = gold.slice(-n).map((c) => c.c), u = usd.slice(-n).map((c) => c.c);
  const gr = g.slice(1).map((v, i) => v - g[i]), ur = u.slice(1).map((v, i) => v - u[i]);
  const mg = gr.reduce((a, b) => a + b, 0) / gr.length, mu = ur.reduce((a, b) => a + b, 0) / ur.length;
  let num = 0, dg = 0, du = 0;
  for (let i = 0; i < gr.length; i++) { num += (gr[i] - mg) * (ur[i] - mu); dg += (gr[i] - mg) ** 2; du += (ur[i] - mu) ** 2; }
  const corr = dg > 0 && du > 0 ? num / Math.sqrt(dg * du) : -0.5;
  return corr >= 0.15 ? 1 : corr <= -0.15 ? -1 : 0;
}

export async function dxyContext(o: {
  goldM15: Candle[];
  proposedDirection: "buy" | "sell" | null;
  mdKey: string;
  fresh: boolean;
}): Promise<{ verdict: DxyVerdict; detail: string }> {
  if (!o.proposedDirection) return { verdict: "DXY_NEUTRAL", detail: "No proposed gold direction to weigh DXY against." };
  // Try the real index; fall back to inverted EUR/USD as the dollar proxy.
  let usd: Candle[] = [];
  let label = "DXY";
  try {
    const dxy = await series("DXY", "15min", 60, o.mdKey, o.fresh);
    if (Array.isArray(dxy) && dxy.length >= 20) usd = toCandles(dxy);
  } catch { /* fall through */ }
  if (usd.length < 20) {
    try {
      const eu = await series("EUR/USD", "15min", 60, o.mdKey, o.fresh);
      if (Array.isArray(eu) && eu.length >= 20) {
        usd = toCandles(eu).map((c) => ({ t: c.t, o: 1 / c.o, h: 1 / c.l, l: 1 / c.h, c: 1 / c.c })); // inverted = dollar proxy
        label = "USD (EUR/USD-inverse proxy)";
      }
    } catch { /* unavailable */ }
  }
  if (usd.length < 20) return { verdict: "DXY_UNAVAILABLE", detail: "Dollar-index feed unavailable — treated as neutral, gold price action decides alone." };

  const closedUsd = usd.slice(0, -1);
  const last6 = closedUsd.slice(-6);
  const usdMove = last6[last6.length - 1].c - last6[0].c;
  const usdDir = Math.abs(usdMove) < 1e-9 ? 0 : usdMove > 0 ? 1 : -1;
  const rel = corrSign(o.goldM15.slice(0, -1), closedUsd); // -1 inverse (normal), +1 positive, 0 dislocated
  if (usdDir === 0 || rel === 0) {
    return { verdict: "DXY_NEUTRAL", detail: `${label} flat or the gold/dollar relationship is dislocated right now — no lean either way.` };
  }
  // Expected gold direction implied by the measured relationship.
  const impliedGold = (usdDir === 1 ? -1 : 1) * (rel === -1 ? 1 : -1); // usd up + inverse rel → gold down
  const wanted = o.proposedDirection === "buy" ? 1 : -1;
  if (impliedGold === wanted) {
    return { verdict: "DXY_SUPPORTS", detail: `${label} ${usdDir === 1 ? "rising" : "falling"} with a ${rel === -1 ? "normal inverse" : "positive"} gold relationship — supports the ${o.proposedDirection.toUpperCase()}.` };
  }
  return { verdict: "DXY_CONFLICTS", detail: `${label} ${usdDir === 1 ? "rising" : "falling"} leans against the ${o.proposedDirection.toUpperCase()} — lowers confidence, never a veto.` };
}
