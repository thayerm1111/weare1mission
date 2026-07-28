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
  try {
    const r = await fetch(
      `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(td)}&interval=${interval}&outputsize=${size}&apikey=${key}`,
      { cache: "no-store" },
    );
    const j = await r.json();
    if (j.status === "error" || !Array.isArray(j.values)) {
      const msg = String(j?.message || "");
      if (r.status === 429 || j?.code === 429 || /credit|limit|per minute/i.test(msg)) return "ratelimit";
      return null;
    }
    const rows = [...(j.values as Row[])].reverse();
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
  try {
    const r = await fetch(
      `https://api.twelvedata.com/price?symbol=${encodeURIComponent(td)}&apikey=${key}`,
      { cache: "no-store" },
    );
    const j = await r.json();
    const p = Number(j?.price);
    if (Number.isFinite(p)) {
      await putCache(ck, p);
      return p;
    }
    return null;
  } catch {
    return null;
  }
}
