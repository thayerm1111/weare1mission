import { CONFIG } from "./config";
import type { NewsState } from "./engine";

/**
 * Provider-agnostic news adapter. Current provider: the keyless ForexFactory weekly feed
 * (same source as the desk calendar). Tracks its own freshness so a failed or stale feed
 * reports UNKNOWN (fail-closed by config) instead of silently "clear". Never invents events.
 */
export type NewsProvider = { name: string; fetchEvents(): Promise<{ title: string; currency: string; impact: string; ts: number }[]> };

export const forexFactoryProvider: NewsProvider = {
  name: "forexfactory_thisweek",
  async fetchEvents() {
    const r = await fetch("https://nfs.faireconomy.media/ff_calendar_thisweek.json", { headers: { "user-agent": "Mozilla/5.0 (compatible; OneMissionDesk/1.0)", accept: "application/json" }, cache: "no-store" });
    if (!r.ok) throw new Error(`feed_${r.status}`);
    const raw = (await r.json()) as Record<string, unknown>[];
    return (Array.isArray(raw) ? raw : []).map((o) => ({ title: String(o.title ?? ""), currency: String(o.country ?? "").toUpperCase(), impact: String(o.impact ?? ""), ts: Date.parse(String(o.date ?? "")) || 0 })).filter((e) => e.ts > 0 && e.title);
  },
};

const state: { lastOk: number; events: { title: string; currency: string; impact: string; ts: number }[]; lastTry: number } = { lastOk: 0, events: [], lastTry: 0 };

export async function newsState(now: number, provider: NewsProvider = forexFactoryProvider): Promise<{ state: NewsState; detail?: string; provider: string; ageMs: number | null }> {
  if (now - state.lastTry > 10 * 60_000) {
    state.lastTry = now;
    try { const ev = await provider.fetchEvents(); if (ev.length) { state.events = ev; state.lastOk = now; } } catch { /* keep previous; freshness below decides */ }
  }
  const ageMs = state.lastOk ? now - state.lastOk : null;
  if (!state.lastOk || ageMs! > 3 * 3_600_000) return { state: "UNKNOWN", detail: "calendar unavailable or stale", provider: provider.name, ageMs };
  return { ...evaluateNews(state.events, now), provider: provider.name, ageMs };
}

/** Pure: is a high-impact USD event inside the configured blackout? */
export function evaluateNews(events: { title: string; currency: string; impact: string; ts: number }[], now: number): { state: NewsState; detail?: string } {
  const before = CONFIG.trade.newsBeforeMin * 60_000, after = CONFIG.trade.newsAfterMin * 60_000;
  const hit = events.find((e) => e.currency === "USD" && /high/i.test(e.impact) && e.ts >= now - after && e.ts <= now + before);
  return hit ? { state: "BLOCKED", detail: `${hit.title} ${new Date(hit.ts).toISOString()}` } : { state: "CLEAR" };
}
