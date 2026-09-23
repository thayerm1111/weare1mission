/**
 * Gold CFD trading session model. The broker's own session data (TradeLocker /trade/sessions) is the
 * authority when it can be read; this documented fallback is used ONLY when the broker does not report
 * one, and the dashboard labels which source is in effect.
 *
 * Fallback (typical XAUUSD CFD): open Sunday 23:00 UTC → Friday 22:00 UTC, daily maintenance 22:00–23:00 UTC.
 */
export type SessionSource = "broker" | "fallback";
export type SessionWindow = { open: boolean; source: SessionSource; minutesToClose: number | null; minutesToOpen: number | null; label: string };

const DAY = 86_400_000;
export function fallbackSession(now: number): SessionWindow {
  const d = new Date(now);
  const dow = d.getUTCDay(); // 0=Sun
  const minutesUtc = d.getUTCHours() * 60 + d.getUTCMinutes();
  const dailyClose = 22 * 60, dailyOpen = 23 * 60;
  // Weekend: Friday ≥ 22:00 → Sunday < 23:00
  if (dow === 6 || (dow === 5 && minutesUtc >= dailyClose) || (dow === 0 && minutesUtc < dailyOpen)) {
    const sundayOpen = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + (dow === 5 ? 2 : dow === 6 ? 1 : 0), 23, 0));
    return { open: false, source: "fallback", minutesToClose: null, minutesToOpen: Math.max(0, Math.round((sundayOpen.getTime() - now) / 60_000)), label: "weekend close (fallback schedule)" };
  }
  if (minutesUtc >= dailyClose && minutesUtc < dailyOpen) {
    return { open: false, source: "fallback", minutesToClose: null, minutesToOpen: dailyOpen - minutesUtc, label: "daily maintenance 22:00–23:00 UTC (fallback schedule)" };
  }
  const toClose = minutesUtc < dailyClose ? dailyClose - minutesUtc : (24 * 60 - minutesUtc) + dailyClose;
  return { open: true, source: "fallback", minutesToClose: dow === 5 ? Math.min(toClose, dailyClose - minutesUtc) : toClose, minutesToOpen: null, label: "open (fallback schedule)" };
}

/** Parse a broker session payload when its shape is recognisable; otherwise null (fallback applies). */
export function brokerSession(payload: unknown, now: number): SessionWindow | null {
  const d = (payload as { d?: unknown })?.d ?? payload;
  if (!d || typeof d !== "object") return null;
  const obj = d as Record<string, unknown>;
  const isOpen = typeof obj.isOpen === "boolean" ? obj.isOpen : typeof obj.open === "boolean" ? obj.open : null;
  const nextClose = Number(obj.nextClose ?? obj.closeTime ?? obj.sessionEnd ?? NaN);
  const nextOpen = Number(obj.nextOpen ?? obj.openTime ?? obj.sessionStart ?? NaN);
  if (isOpen == null && !Number.isFinite(nextClose) && !Number.isFinite(nextOpen)) return null;
  const toClose = Number.isFinite(nextClose) ? Math.round((nextClose - now) / 60_000) : null;
  const toOpen = Number.isFinite(nextOpen) ? Math.round((nextOpen - now) / 60_000) : null;
  const open = isOpen ?? (toClose != null && toClose > 0);
  return { open, source: "broker", minutesToClose: open ? toClose : null, minutesToOpen: open ? null : toOpen, label: open ? "open (broker session)" : "closed (broker session)" };
}
void DAY;
