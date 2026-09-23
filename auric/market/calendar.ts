import type { AuricConfig } from "../config/defaults";

/**
 * Economic calendar (Financial Modeling Prep, /stable/economic-calendar). When the key is absent or the
 * request fails, the state is UNAVAILABLE — the dashboard says so and the documented fallback applies
 * (no blackout, flagged). "News checked" is never displayed unless a successful fetch backs it.
 */
export type CalEvent = { at: number; name: string; country: string | null; impact: string; currency: string | null; unstable: boolean };
export type CalendarState = { available: boolean; checkedAt: number | null; source: string; events: CalEvent[]; error?: string };

let cache: CalendarState = { available: false, checkedAt: null, source: "fmp", events: [] };
let lastFetch = 0;
const KEY = () => process.env.ECON_CALENDAR_API_KEY ?? "";

export async function loadCalendar(now = Date.now()): Promise<CalendarState> {
  if (now - lastFetch < 10 * 60_000) return cache;
  lastFetch = now;
  if (!KEY()) { cache = { available: false, checkedAt: null, source: "fmp", events: [], error: "ECON_CALENDAR_API_KEY not configured" }; return cache; }
  const from = new Date(now - 6 * 3600_000).toISOString().slice(0, 10), to = new Date(now + 48 * 3600_000).toISOString().slice(0, 10);
  try {
    let r = await fetch(`https://financialmodelingprep.com/stable/economic-calendar?from=${from}&to=${to}&apikey=${encodeURIComponent(KEY())}`, { cache: "no-store", signal: AbortSignal.timeout(10000) });
    if (!r.ok) r = await fetch(`https://financialmodelingprep.com/api/v3/economic_calendar?from=${from}&to=${to}&apikey=${encodeURIComponent(KEY())}`, { cache: "no-store", signal: AbortSignal.timeout(10000) });
    if (!r.ok) { cache = { available: false, checkedAt: now, source: "fmp", events: [], error: `HTTP ${r.status}` }; return cache; }
    const rows = (await r.json()) as Array<Record<string, unknown>>;
    if (!Array.isArray(rows)) { cache = { available: false, checkedAt: now, source: "fmp", events: [], error: "unexpected payload" }; return cache; }
    const events: CalEvent[] = rows.map((e) => {
      const d = String(e.date ?? ""); const at = Date.parse(d.includes("T") ? d : d.replace(" ", "T") + "Z");
      const name = String(e.event ?? ""); const impact = String(e.impact ?? "").toLowerCase();
      return { at, name, country: e.country ? String(e.country) : null, currency: e.currency ? String(e.currency) : null, impact, unstable: /fomc|rate decision|non-farm|nonfarm|payroll|cpi/i.test(name) };
    }).filter((e) => Number.isFinite(e.at) && (e.currency === "USD" || e.country === "US" || e.country === "United States"));
    cache = { available: true, checkedAt: now, source: "fmp", events };
  } catch (e) { cache = { available: false, checkedAt: now, source: "fmp", events: [], error: e instanceof Error ? e.message : "fetch failed" }; }
  return cache;
}

export function inBlackout(state: CalendarState, now: number, cfg: AuricConfig["calendar"]): { blocked: boolean; reason: string } {
  if (!state.available) return { blocked: false, reason: `calendar unavailable (${state.error ?? "not checked"}) — fallback: no news blackout applied` };
  for (const e of state.events) {
    if (!cfg.impacts.includes(e.impact)) continue;
    const after = e.unstable ? cfg.unstableAfterMin : cfg.afterMin;
    if (now >= e.at - cfg.beforeMin * 60_000 && now <= e.at + after * 60_000) return { blocked: true, reason: `${e.name} (${e.impact}) at ${new Date(e.at).toISOString()} — ${cfg.beforeMin} min before / ${after} min after` };
  }
  return { blocked: false, reason: `no high-impact USD release within window (checked ${new Date(state.checkedAt!).toISOString()})` };
}
