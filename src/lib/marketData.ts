import { createClient } from "@/lib/supabase/server";

/**
 * Global market-data governor + community cache.
 *
 * Two jobs:
 *  1. GOVERNOR — every real Twelve Data call reserves its credit cost from a shared
 *     per-minute budget FIRST, so total community usage can never exceed the plan's
 *     per-minute ceiling (default 350, safely under Grow's 377/min).
 *  2. CACHE — an identical (symbol, interval, size) pull made by anyone in the
 *     community within MD_CACHE_TTL seconds is reused from a shared cache WITHOUT
 *     hitting Twelve Data or spending budget. So credit usage scales with the number
 *     of distinct instruments being watched, not the number of users.
 *
 * Priority (admin) callers ALWAYS bypass the cache for fresh data and are NEVER
 * throttled. Set ADMIN_EMAILS to control who gets that fast-path.
 *
 * Everything fails OPEN if the DB governor is unavailable (not migrated / transient
 * blip) so a hiccup never takes the whole product down.
 */
const MD_MINUTE_LIMIT = Number(process.env.MD_MINUTE_LIMIT || 350);
const MD_CACHE_TTL = Number(process.env.MD_CACHE_TTL || 30); // seconds a shared pull stays reusable
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "thayerm1111@gmail.com")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

export type Row = { datetime: string; open: string; high: string; low: string; close: string };

// ── Synthetic index instruments ─────────────────────────────────────────────
// Twelve Data's plan here serves NO clean Nasdaq-100 index level (NDX / US100 /
// NAS100 / ^NDX all resolve to unrelated tickers or "unavailable"). So we present
// NAS100 in true index terms by sourcing the liquid QQQ ETF — which tracks the
// Nasdaq-100 tick-for-tick — and scaling it to the index level.
//   scale = index level / QQQ price, verified live: 27,756.65 / 675.5 = 41.09.
// Re-tune SCALE if the two drift materially (QQQ's tiny expense-ratio/dividend
// drift moves the ratio by a fraction of a percent per year).
const SYNTH: Record<string, { base: string; scale: number }> = {
  NAS100: { base: "QQQ", scale: 41.09 },
};

/** Map a display symbol to the symbol we actually fetch + the scale to apply. */
export function resolveTd(td: string): { fetchTd: string; scale: number } {
  const s = SYNTH[td];
  return s ? { fetchTd: s.base, scale: s.scale } : { fetchTd: td, scale: 1 };
}

/** Scale every OHLC field of a candle series (no-op when scale === 1). */
export function scaleRows(rows: Row[], scale: number): Row[] {
  if (scale === 1) return rows;
  const m = (x: string) => String(Number(x) * scale);
  return rows.map((r) => ({ datetime: r.datetime, open: m(r.open), high: m(r.high), low: m(r.low), close: m(r.close) }));
}

/** True for accounts that always get fresh, un-throttled data (the owner/admins). */
export function isPriorityEmail(email?: string | null): boolean {
  return !!email && ADMIN_EMAILS.includes(email.toLowerCase());
}

/**
 * Legacy batch reservation — still used by routes that fetch outside the cached
 * helpers below. Reserves `cost` credits against the per-minute ceiling.
 */
export async function reserveMarketData(cost: number): Promise<{ ok: boolean; used?: number; limit?: number }> {
  try {
    const supabase = createClient();
    if (!supabase) return { ok: true };
    const { data, error } = await supabase.rpc("md_reserve", { p_cost: cost, p_limit: MD_MINUTE_LIMIT });
    if (error || !data) return { ok: true }; // fail open
    const d = data as { ok?: boolean; used?: number; limit?: number };
    return { ok: !!d.ok, used: d.used, limit: d.limit };
  } catch {
    return { ok: true };
  }
}

/** Combined cache-check + budget reservation in one round trip. */
async function getOrReserve(
  key: string,
  cost: number,
  fresh: boolean,
): Promise<{ hit: boolean; ok?: boolean; payload?: unknown }> {
  try {
    const supabase = createClient();
    if (!supabase) return { hit: false, ok: true };
    const { data, error } = await supabase.rpc("md_get_or_reserve", {
      p_key: key,
      p_ttl: MD_CACHE_TTL,
      p_cost: cost,
      p_limit: MD_MINUTE_LIMIT,
      p_fresh: fresh,
    });
    if (error || !data) return { hit: false, ok: true }; // fail open → fetch fresh
    return data as { hit: boolean; ok?: boolean; payload?: unknown };
  } catch {
    return { hit: false, ok: true };
  }
}

/** Store a fresh payload after a real Twelve Data fetch (best-effort). */
async function putCache(key: string, payload: unknown): Promise<void> {
  try {
    const supabase = createClient();
    if (!supabase) return;
    await supabase.rpc("md_put", { p_key: key, p_payload: payload });
  } catch {
    /* cache write is best-effort; never block a request on it */
  }
}

/**
 * Fetch a candle series with community caching + governor. Returns oldest→newest
 * rows, "ratelimit" when the per-minute ceiling is hit, or null on data error.
 * Pass fresh=true (admin) to always bypass the cache and never be throttled.
 */
export async function series(
  td: string,
  interval: string,
  size: number,
  key: string,
  fresh = false,
): Promise<Row[] | "ratelimit" | null> {
  const ck = `s:${td}:${interval}:${size}`;
  const g = await getOrReserve(ck, 1, fresh);
  if (g.hit && Array.isArray(g.payload)) return g.payload as Row[];
  if (g.ok === false) return "ratelimit";
  const { fetchTd, scale } = resolveTd(td);
  try {
    const r = await fetch(
      `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(fetchTd)}&interval=${interval}&outputsize=${size}&apikey=${key}`,
      { cache: "no-store" },
    );
    const j = await r.json();
    if (j.status === "error" || !Array.isArray(j.values)) {
      const msg = String(j?.message || "");
      if (r.status === 429 || j?.code === 429 || /credit|limit|per minute/i.test(msg)) return "ratelimit";
      return null;
    }
    const rows = scaleRows([...(j.values as Row[])].reverse(), scale);
    await putCache(ck, rows);
    return rows;
  } catch {
    return null;
  }
}

/**
 * Fetch a live price with community caching + governor. Pass fresh=true (admin) to
 * always bypass the cache and never be throttled.
 */
export async function livePrice(td: string, key: string, fresh = false): Promise<number | null> {
  const ck = `p:${td}`;
  const g = await getOrReserve(ck, 1, fresh);
  if (g.hit && g.payload != null) {
    const cached = Number(g.payload);
    return Number.isFinite(cached) ? cached : null;
  }
  if (g.ok === false) return null;
  const { fetchTd, scale } = resolveTd(td);
  try {
    const r = await fetch(
      `https://api.twelvedata.com/price?symbol=${encodeURIComponent(fetchTd)}&apikey=${key}`,
      { cache: "no-store" },
    );
    const j = await r.json();
    const p = Number(j?.price);
    if (Number.isFinite(p)) {
      const sp = p * scale;
      await putCache(ck, sp);
      return sp;
    }
    return null;
  } catch {
    return null;
  }
}
