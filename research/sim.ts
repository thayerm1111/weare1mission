/** Shared, causal trade simulator on 1m bars (used by every research script). */
export type B = { t: number; o: number; h: number; l: number; c: number };
export type SimIn = { side: "BUY" | "SELL"; startIdx: number; entry: number; zoneLow: number; zoneHigh: number; stop: number; target: number; ttlMs: number; maxHoldMs: number; chaseUsd: number; costUsd: number; market?: boolean; beAtR?: number; trailUsd?: number; trailAfterR?: number };
export type SimOut = { filled: boolean; missReason?: "expired" | "invalidated_before_fill"; fillAt?: number; fill?: number; exitAt?: number; exit?: number; result?: "target" | "stop" | "timeout"; pnl?: number; r?: number; mfe?: number; mae?: number; holdMin?: number };

export function simulate(all: B[], p: SimIn): SimOut {
  const up = p.side === "BUY";
  const t0 = all[p.startIdx]?.t ?? Infinity;
  const expires = t0 + p.ttlMs;
  let i = p.startIdx, fillAt = -1, fill = 0;
  if (p.market) { const b = all[i]; if (!b) return { filled: false, missReason: "expired" }; fillAt = b.t; fill = b.o; }
  else {
    const limit = up ? p.zoneHigh + p.chaseUsd : p.zoneLow - p.chaseUsd;
    for (; i < all.length && all[i].t < expires; i++) {
      const b = all[i];
      if (up ? b.l <= p.stop : b.h >= p.stop) return { filled: false, missReason: "invalidated_before_fill" };
      if (up ? b.l <= limit : b.h >= limit) { fillAt = b.t; fill = up ? Math.min(limit, b.o) : Math.max(limit, b.o); break; }
    }
    if (fillAt < 0) return { filled: false, missReason: "expired" };
  }
  // bar of fill: if the same bar also hits the stop beyond the fill, count as stop (conservative)
  let mfe = 0, mae = 0; let stop = p.stop; const risk0 = Math.abs(fill - p.stop) || 1e-9;
  for (let j = i; j < all.length; j++) {
    const b = all[j];
    const hi = j === i ? Math.max(b.c, fill) : b.h, lo = j === i ? Math.min(b.c, fill) : b.l;
    const hitStop = up ? (j === i ? b.l <= stop && b.c <= fill : lo <= stop) : (j === i ? b.h >= stop && b.c >= fill : hi >= stop);
    const hitTgt = j === i ? false : up ? hi >= p.target : lo <= p.target;
    mfe = Math.max(mfe, up ? hi - fill : fill - lo); mae = Math.max(mae, up ? fill - lo : hi - fill);
    const risk = Math.abs(fill - p.stop) || 1e-9;
    const done = (exit: number, result: SimOut["result"]) => {
      const gross = up ? exit - fill : fill - exit; const pnl = gross - p.costUsd;
      return { filled: true, fillAt, fill, exitAt: b.t, exit, result, pnl: +pnl.toFixed(3), r: +(pnl / risk).toFixed(3), mfe: +mfe.toFixed(2), mae: +mae.toFixed(2), holdMin: Math.round((b.t - fillAt) / 60000) };
    };
    if (hitStop) return done(j === i ? stop : up ? Math.min(stop, b.o) : Math.max(stop, b.o), "stop");   // gap through stop fills at open
    if (hitTgt) return done(p.target, "target");
    if (b.t - fillAt >= p.maxHoldMs) return done(b.c, "timeout");
    // management applied from the NEXT bar on (decided on this bar's close — no intrabar look-ahead)
    if (p.beAtR != null && mfe >= p.beAtR * risk0) stop = up ? Math.max(stop, fill + 0.1) : Math.min(stop, fill - 0.1);
    if (p.trailUsd != null && mfe >= (p.trailAfterR ?? 0) * risk0) { const ts = up ? fill + mfe - p.trailUsd : fill - mfe + p.trailUsd; stop = up ? Math.max(stop, ts) : Math.min(stop, ts); }
  }
  return { filled: false, missReason: "expired" };
}

export function stats(pnls: number[]) {
  const n = pnls.length; if (!n) return { n: 0 };
  const w = pnls.filter((x) => x > 0), l = pnls.filter((x) => x <= 0);
  const gw = w.reduce((a, b) => a + b, 0), gl = -l.reduce((a, b) => a + b, 0);
  let cum = 0, pk = 0, dd = 0, s = 0, ms = 0;
  for (const x of pnls) { cum += x; pk = Math.max(pk, cum); dd = Math.max(dd, pk - cum); s = x <= 0 ? s + 1 : 0; ms = Math.max(ms, s); }
  const mean = cum / n, sd = Math.sqrt(pnls.reduce((a, x) => a + (x - mean) ** 2, 0) / Math.max(1, n - 1));
  return { n, win: +(w.length / n * 100).toFixed(1), avgWin: +(gw / Math.max(1, w.length)).toFixed(2), avgLoss: +(-gl / Math.max(1, l.length)).toFixed(2), exp: +mean.toFixed(3), se: +(sd / Math.sqrt(n)).toFixed(3), pf: +(gw / Math.max(gl, 1e-9)).toFixed(2), net: +cum.toFixed(1), dd: +dd.toFixed(1), maxL: ms };
}
