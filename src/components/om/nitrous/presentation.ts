import type { NitrousAccount, NitrousAnalyze, NitrousStatus } from "@/lib/nitrous/types";

export const STATUS_VISIBLE_FRESH_MS = 45_000;

/** A cached successful request is not a permanently active trading account. */
export function accountIsActive(status: NitrousStatus | null, account: NitrousAccount | null,
  receivedAt: number, now: number, error = ""): boolean {
  if (!status || !account || error || !receivedAt || !now || now < receivedAt || now - receivedAt > STATUS_VISIBLE_FRESH_MS) return false;
  const serverNow = Date.parse(status.serverTime) + now - receivedAt;
  const equityAt = Date.parse(account.equityAt ?? "");
  const workerAt = Date.parse(status.worker.lastBeatAt ?? "");
  return status.available && status.addon?.entitled === true && status.control.mode === "live" && !status.control.entriesPaused
    && status.worker.healthy && account.state === "active" && account.automationEnabled
    && account.blockers.length === 0 && account.equity !== null && account.equity > 0
    && Number.isFinite(serverNow) && Number.isFinite(equityAt) && Number.isFinite(workerAt)
    && serverNow - equityAt >= -5_000 && serverNow - equityAt <= 120_000
    && serverNow - workerAt >= -5_000 && serverNow - workerAt <= 60_000;
}

export function money(value: number | null | undefined, currency = "USD"): string {
  if (value == null || !Number.isFinite(value)) return "—";
  try { return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 2 }).format(value); }
  catch { return `${value.toFixed(2)} ${currency}`; }
}
export const price = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? "—"
  : value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export function elapsed(at: string | null | undefined, now: number): string {
  const stamp = Date.parse(at ?? "");
  if (!Number.isFinite(stamp) || !now) return "Timestamp unavailable";
  const sec = Math.max(0, Math.floor((now - stamp) / 1000));
  return sec < 5 ? "Just updated" : sec < 60 ? `${sec}s ago` : sec < 3600 ? `${Math.floor(sec / 60)}m ago` : `${Math.floor(sec / 3600)}h ago`;
}
export const modeName = (mode: string) => mode === "nitrous" ? "Nitrous" : "Slow Drip";
export const shownPnl = (account: NitrousAccount) => account.stats.pnlVerified ? account.stats.netPnl : account.stats.recordedPnl;
export const shownPnlLabel = (account: NitrousAccount) => account.stats.pnlVerified ? "Net P&L"
  : account.stats.grossPnl !== null && account.stats.grossPnl === account.stats.recordedPnl ? "Gross estimate" : "Recorded P&L";
export function scenarioState(state: string): string {
  return ({ watching: "Watching", approaching: "Approaching entry", armed: "Waiting for retest", triggered: "Trigger observed",
    consumed: "Entry handled", waiting_for_departure: "Waiting for a new visit", expired: "Expired", invalidated: "Invalidated", stale: "Reference · read delayed" } as Record<string, string>)[state] ?? "Watching";
}
export function validStatus(value: unknown): value is NitrousStatus {
  if (!value || typeof value !== "object") return false;
  const s = value as NitrousStatus;
  return typeof s.available === "boolean" && typeof s.serverTime === "string" && Array.isArray(s.accounts)
    && s.accounts.every(a => a && typeof a.accountId === "string" && Array.isArray(a.blockers)
      && Array.isArray(a.positions) && a.stats && typeof a.stats.wins === "number" && typeof a.stats.losses === "number")
    && !!s.addon && typeof s.addon.entitled === "boolean" && typeof s.addon.adminGranted === "boolean"
    && !!s.worker && typeof s.worker.healthy === "boolean" && !!s.control && Array.isArray(s.profiles) && !!s.telegram;
}
export function validAnalyze(value: unknown): value is NitrousAnalyze {
  if (!value || typeof value !== "object") return false;
  const s = value as NitrousAnalyze;
  return typeof s.available === "boolean" && typeof s.stale === "boolean" && Array.isArray(s.bars)
    && s.bars.every(b => b && [b.t,b.o,b.h,b.l,b.c].every(Number.isFinite) && b.t > 0 && b.l > 0 && b.h >= Math.max(b.o,b.c,b.l) && b.l <= Math.min(b.o,b.c,b.h))
    && Array.isArray(s.flow) && Array.isArray(s.scenarios) && s.scenarios.every(p => p
      && [p.entryBandLow,p.entryBandHigh,p.refEntry,p.stop,p.target,p.expiresAt].every(Number.isFinite)
      && p.entryBandLow <= p.entryBandHigh && p.refEntry > 0 && ["buy", "sell"].includes(p.side)
      && Array.isArray(p.conditionsMet) && Array.isArray(p.conditionsPending))
    && !!s.health && typeof s.health.state === "string" && Array.isArray(s.health.reasons);
}
