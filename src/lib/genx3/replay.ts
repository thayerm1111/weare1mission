import { analyze, type Decision } from "./engine";
import type { Bar } from "./candles";
import { CONFIG } from "./config";

/**
 * Event-driven replay using the SAME analyze() as production. At each 5-minute close the
 * engine sees only bars that had closed by then (the window is cut at asOf, and analyze()
 * drops any bar not closed by asOf). Fills are simulated on later 1m bars only.
 *
 * Fill model: LIMIT inside [zoneLow, zoneHigh] + Flow's 10-pip chase allowance, within the
 * setup TTL; adverse slippage + spread cost deducted; a bar touching both stop and target
 * counts as a loss; one position at a time (Flow's one-entry rule); news not modelled
 * (treated CLEAR) — so replay results exclude news-blackout effects.
 */
export type ReplayTrade = { signalKey: string; setup: string; side: string; regime: string; score: number; decidedAt: number; filledAt: number; entry: number; stop: number; target: number; exitAt: number; exit: number; result: "target" | "stop" | "timeout"; pnlUsd: number; mfeUsd: number; maeUsd: number };
export type ReplayReport = { decisions: number; noTrade: Record<string, number>; signals: number; missedFills: number; trades: ReplayTrade[] };

export function replay(all: Bar[], opts: { from: number; to: number; windowMs?: number; chaseUsd?: number; maxHoldMs?: number; onDecision?: (d: Decision) => void }): ReplayReport {
  const windowMs = opts.windowMs ?? 6 * 86_400_000;
  const chase = opts.chaseUsd ?? 1.0;
  const maxHold = opts.maxHoldMs ?? 8 * 3_600_000;
  const cost = CONFIG.costs.spreadEstimateUsd + CONFIG.costs.slippageEstimateUsd;
  const noTrade: Record<string, number> = {};
  const trades: ReplayTrade[] = [];
  const seen = new Set<string>();
  let decisions = 0, signals = 0, missed = 0, busyUntil = 0;
  let lo = 0;
  const start = Math.ceil(opts.from / 300_000) * 300_000;
  for (let asOf = start; asOf <= opts.to; asOf += 300_000) {
    while (lo < all.length && all[lo].t < asOf - windowMs) lo++;
    let hi = lo; while (hi < all.length && all[hi].t < asOf) hi++;
    const window = all.slice(lo, hi);
    if (window.length < 1000) continue;
    if (asOf - (window.at(-1)!.t + 60_000) > 10 * 60_000) continue; // market closed
    const d = analyze({ raw1m: window, asOf, liveTick: null, news: { state: "CLEAR" } });
    decisions++;
    opts.onDecision?.(d);
    if (!d.signal) { for (const r of d.noTradeReasons) { const k = r.split(":")[0].replace(/_\d+.*$/, ""); noTrade[k] = (noTrade[k] ?? 0) + 1; } continue; }
    const s = d.signal;
    if (seen.has(s.idempotency_key)) continue;
    seen.add(s.idempotency_key);
    signals++;
    if (asOf < busyUntil) { noTrade.flow_one_entry = (noTrade.flow_one_entry ?? 0) + 1; continue; }
    const up = s.side === "BUY";
    const limit = up ? s.entry_zone_high + chase : s.entry_zone_low - chase;
    const expires = Date.parse(s.expires_at_utc);
    let i = hi; let fillAt = -1; let fill = 0;
    for (; i < all.length && all[i].t < expires; i++) {
      const b = all[i];
      if (up ? b.l <= s.stop_price : b.h >= s.stop_price) break;        // invalidated before fill
      if (up ? b.l <= limit : b.h >= limit) { fillAt = b.t; fill = up ? Math.min(limit, b.o) : Math.max(limit, b.o); break; }
    }
    if (fillAt < 0) { missed++; continue; }
    let mfe = 0, mae = 0, exit = 0, exitAt = 0, result: ReplayTrade["result"] = "timeout";
    for (let j = i + 1; j < all.length; j++) {
      const b = all[j];
      mfe = Math.max(mfe, up ? b.h - fill : fill - b.l); mae = Math.max(mae, up ? fill - b.l : b.h - fill);
      const hitStop = up ? b.l <= s.stop_price : b.h >= s.stop_price;
      const hitTgt = up ? b.h >= s.target_price : b.l <= s.target_price;
      if (hitStop) { exit = s.stop_price; exitAt = b.t; result = "stop"; break; }
      if (hitTgt) { exit = s.target_price; exitAt = b.t; result = "target"; break; }
      if (b.t - fillAt > maxHold) { exit = b.c; exitAt = b.t; break; }
    }
    if (!exitAt) continue;
    busyUntil = exitAt;
    trades.push({ signalKey: s.idempotency_key, setup: s.setup_type, side: s.side, regime: s.regime, score: s.confidence, decidedAt: asOf, filledAt: fillAt, entry: fill, stop: s.stop_price, target: s.target_price, exitAt, exit, result, pnlUsd: +((up ? exit - fill : fill - exit) - cost).toFixed(2), mfeUsd: +mfe.toFixed(2), maeUsd: +mae.toFixed(2) });
  }
  return { decisions, noTrade, signals, missedFills: missed, trades };
}

export function summarize(tr: ReplayTrade[]) {
  const n = tr.length; if (!n) return { n };
  const w = tr.filter((t) => t.pnlUsd > 0), l = tr.filter((t) => t.pnlUsd <= 0);
  const gw = w.reduce((a, t) => a + t.pnlUsd, 0), gl = -l.reduce((a, t) => a + t.pnlUsd, 0);
  let cum = 0, pk = 0, dd = 0, streak = 0, maxStreak = 0;
  for (const t of tr) { cum += t.pnlUsd; pk = Math.max(pk, cum); dd = Math.max(dd, pk - cum); streak = t.pnlUsd <= 0 ? streak + 1 : 0; maxStreak = Math.max(maxStreak, streak); }
  const mean = cum / n; const sd = Math.sqrt(tr.reduce((a, t) => a + (t.pnlUsd - mean) ** 2, 0) / Math.max(1, n - 1));
  return { n, winRate: +(w.length / n * 100).toFixed(1), avgWin: +(gw / Math.max(1, w.length)).toFixed(2), avgLoss: +(-gl / Math.max(1, l.length)).toFixed(2), expectancyUsd: +mean.toFixed(2), expectancy95ci: [+(mean - 1.96 * sd / Math.sqrt(n)).toFixed(2), +(mean + 1.96 * sd / Math.sqrt(n)).toFixed(2)], profitFactor: +(gw / Math.max(gl, 1e-9)).toFixed(2), netUsd: +cum.toFixed(2), maxDrawdownUsd: +dd.toFixed(2), maxConsecutiveLosses: maxStreak };
}
