import type { AuricConfig } from "../config/defaults";

/**
 * Risk circuit breakers — persisted per account in auric_risk_state, so they survive restarts, deploys
 * and credit purchases. Loss accounting uses REALIZED AURIC P&L only (brokerage net, from closed AURIC
 * positions) against a baseline equity captured at the reset boundary; deposits/withdrawals during the
 * window are excluded by adding them to the baseline (cash-flow adjustment) when the broker reports them.
 */
export type RiskState = {
  dayKey: string; weekKey: string;
  dayBaselineEquity: number; weekBaselineEquity: number; peakEquity: number;
  dayRealized: number; weekRealized: number; cashFlowAdj: number;
  consecutiveLosses: number; cooldownUntil: number | null;
  latched: { code: string; detail: string; at: number; needsReview: boolean } | null;
  rejections: number[];   // timestamps of broker rejections within the window
  lastEntryAt: number | null;
};

export function dayKeyUtc(now: number, resetHHMM: string): string {
  const [hh, mm] = resetHHMM.split(":").map(Number);
  const d = new Date(now - (hh * 60 + mm) * 60_000);
  return d.toISOString().slice(0, 10);
}
export function weekKeyUtc(now: number, resetHHMM: string): string {
  const [hh, mm] = resetHHMM.split(":").map(Number);
  const d = new Date(now - (hh * 60 + mm) * 60_000);
  const day = (d.getUTCDay() + 6) % 7; // Monday=0
  const monday = new Date(d.getTime() - day * 86_400_000);
  return monday.toISOString().slice(0, 10);
}

export function freshRiskState(now: number, equity: number, cfg: AuricConfig["breakers"]): RiskState {
  return { dayKey: dayKeyUtc(now, cfg.resetTimeUtc), weekKey: weekKeyUtc(now, cfg.resetTimeUtc), dayBaselineEquity: equity, weekBaselineEquity: equity, peakEquity: equity,
    dayRealized: 0, weekRealized: 0, cashFlowAdj: 0, consecutiveLosses: 0, cooldownUntil: null, latched: null, rejections: [], lastEntryAt: null };
}

/** Roll day/week windows. Drawdown latch is NOT reset by time — it needs deliberate review. */
export function rollWindows(s: RiskState, now: number, equity: number, cfg: AuricConfig["breakers"]): RiskState {
  let n = { ...s };
  const dk = dayKeyUtc(now, cfg.resetTimeUtc), wk = weekKeyUtc(now, cfg.resetTimeUtc);
  if (dk !== n.dayKey) { n = { ...n, dayKey: dk, dayBaselineEquity: equity, dayRealized: 0, latched: n.latched && n.latched.code === "DAILY_LOSS" ? null : n.latched }; }
  if (wk !== n.weekKey) { n = { ...n, weekKey: wk, weekBaselineEquity: equity, weekRealized: 0, latched: n.latched && n.latched.code === "WEEKLY_LOSS" ? null : n.latched }; }
  if (equity > n.peakEquity) n.peakEquity = equity;
  return n;
}

export function recordClose(s: RiskState, realized: number, now: number, cfg: AuricConfig["breakers"]): RiskState {
  const n: RiskState = { ...s, dayRealized: s.dayRealized + realized, weekRealized: s.weekRealized + realized };
  if (realized < 0) { n.consecutiveLosses = s.consecutiveLosses + 1; if (n.consecutiveLosses >= cfg.consecutiveLosses) n.cooldownUntil = now + cfg.cooldownMinutes * 60_000; }
  else if (realized > 0) n.consecutiveLosses = 0;
  return n;
}
export function recordRejection(s: RiskState, now: number, cfg: AuricConfig["breakers"]): RiskState {
  const win = now - cfg.rejectionWindowMin * 60_000;
  const rejections = [...s.rejections.filter((t) => t >= win), now];
  const n: RiskState = { ...s, rejections };
  if (rejections.length >= cfg.rejectionBurst && !n.latched) n.latched = { code: "REJECTION_BURST", detail: `${rejections.length} broker rejections in ${cfg.rejectionWindowMin} min`, at: now, needsReview: false };
  return n;
}

export type BreakerVerdict = { ok: true } | { ok: false; code: string; detail: string; hard: boolean };

/** Evaluate hard limits (latching) and soft gates (cooldown, spacing). */
export function checkBreakers(s: RiskState, now: number, equity: number, cfg: AuricConfig["breakers"]): { state: RiskState; verdict: BreakerVerdict } {
  let n = rollWindows(s, now, equity, cfg);
  const dayBase = n.dayBaselineEquity + n.cashFlowAdj, weekBase = n.weekBaselineEquity + n.cashFlowAdj;
  if (!n.latched) {
    if (dayBase > 0 && -n.dayRealized >= (cfg.dailyLossPct / 100) * dayBase) n = { ...n, latched: { code: "DAILY_LOSS", detail: `realized AURIC loss $${(-n.dayRealized).toFixed(2)} ≥ ${cfg.dailyLossPct}% of $${dayBase.toFixed(2)}`, at: now, needsReview: false } };
    else if (weekBase > 0 && -n.weekRealized >= (cfg.weeklyLossPct / 100) * weekBase) n = { ...n, latched: { code: "WEEKLY_LOSS", detail: `realized AURIC loss $${(-n.weekRealized).toFixed(2)} ≥ ${cfg.weeklyLossPct}% of $${weekBase.toFixed(2)}`, at: now, needsReview: false } };
    else if (n.peakEquity > 0 && (n.peakEquity - equity) / n.peakEquity >= cfg.drawdownPct / 100) n = { ...n, latched: { code: "DRAWDOWN", detail: `equity $${equity.toFixed(2)} is ${(100 * (n.peakEquity - equity) / n.peakEquity).toFixed(1)}% below peak $${n.peakEquity.toFixed(2)}`, at: now, needsReview: true } };
  }
  if (n.latched) return { state: n, verdict: { ok: false, code: n.latched.code, detail: n.latched.detail, hard: true } };
  if (n.cooldownUntil && now < n.cooldownUntil) return { state: n, verdict: { ok: false, code: "COOLDOWN", detail: `${n.consecutiveLosses} consecutive losses — cooling down until ${new Date(n.cooldownUntil).toISOString()}`, hard: false } };
  if (n.lastEntryAt && now - n.lastEntryAt < cfg.minEntrySpacingMin * 60_000) return { state: n, verdict: { ok: false, code: "ENTRY_SPACING", detail: `last entry ${Math.round((now - n.lastEntryAt) / 60_000)} min ago (< ${cfg.minEntrySpacingMin})`, hard: false } };
  return { state: n, verdict: { ok: true } };
}
