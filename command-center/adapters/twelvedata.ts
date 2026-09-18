/**
 * TWELVE DATA ADAPTER — market data in, Bars out. No decisions, no state beyond a small cache.
 *
 * Verified against https://twelvedata.com/docs (2026-09-18):
 *   GET /time_series  symbol, interval (1min…1month), outputsize        → { meta, values[], status }
 *   GET /price        symbol                                            → { price: "…" }
 *   GET /quote        symbol                                            → { …, is_market_open, … }
 *   Auth: header `Authorization: apikey <key>` (preferred over the query parameter).
 *   A rate-limited key answers HTTP 429; the body can also carry a 429 code with status "error".
 *
 * Twelve Data returns values NEWEST FIRST and every field as a STRING. Both are handled here, once, so no
 * engine ever has to know it.
 */
import type { Bar, Timeframe } from "../core/types";

const BASE = "https://api.twelvedata.com";
export const GOLD = "XAU/USD";

export const TD_INTERVAL: Record<Timeframe, string> = {
  "1m": "1min", "5m": "5min", "15m": "15min", "1h": "1h", "4h": "4h", "1d": "1day",
};

export type FetchResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: "rate_limited" | "bad_key" | "no_data" | "http" | "network" | "malformed"; detail: string };

type Json = Record<string, unknown>;

async function call<T>(path: string, params: Record<string, string>, key: string, timeoutMs = 12_000): Promise<FetchResult<T>> {
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url.toString(), { headers: { Authorization: `apikey ${key}` }, cache: "no-store", signal: ctrl.signal });
    const text = await r.text();
    let body: Json;
    try { body = JSON.parse(text) as Json; } catch { return { ok: false, error: "malformed", detail: text.slice(0, 200) }; }
    // A 429 can arrive as an HTTP status OR inside the body with status:"error" — both are the same problem.
    const code = Number(body.code);
    if (r.status === 429 || code === 429) return { ok: false, error: "rate_limited", detail: String(body.message ?? "rate limit") };
    if (r.status === 401 || code === 401) return { ok: false, error: "bad_key", detail: String(body.message ?? "unauthorised") };
    if (body.status === "error") return { ok: false, error: "no_data", detail: String(body.message ?? "error") };
    if (!r.ok) return { ok: false, error: "http", detail: `HTTP ${r.status}` };
    return { ok: true, data: body as T };
  } catch (e) {
    return { ok: false, error: "network", detail: e instanceof Error ? e.message : "network" };
  } finally { clearTimeout(timer); }
}

type TdSeries = { values?: { datetime: string; open: string; high: string; low: string; close: string; volume?: string }[] };

/** Parse Twelve Data's newest-first string rows into oldest-first numeric Bars. Pure, so it is testable. */
export function parseSeries(body: TdSeries): Bar[] {
  const rows = Array.isArray(body.values) ? body.values : [];
  return rows
    .map((v) => ({
      // "2026-09-18 14:35:00" is exchange time in UTC for FX/metals; Date.parse needs the T and the Z.
      t: Date.parse(v.datetime.includes("T") ? v.datetime : `${v.datetime.replace(" ", "T")}Z`),
      o: Number(v.open), h: Number(v.high), l: Number(v.low), c: Number(v.close),
      ...(v.volume != null ? { v: Number(v.volume) } : {}),
    }))
    .filter((b) => Number.isFinite(b.t) && Number.isFinite(b.o) && Number.isFinite(b.h) && Number.isFinite(b.l) && Number.isFinite(b.c))
    .sort((a, b) => a.t - b.t);
}

export async function series(tf: Timeframe, size: number, key: string, symbol = GOLD): Promise<FetchResult<Bar[]>> {
  const r = await call<TdSeries>("/time_series", { symbol, interval: TD_INTERVAL[tf], outputsize: String(Math.min(5000, Math.max(1, size))), timezone: "UTC" }, key);
  if (!r.ok) return r;
  const bars = parseSeries(r.data);
  return bars.length ? { ok: true, data: bars } : { ok: false, error: "no_data", detail: "empty series" };
}

export async function price(key: string, symbol = GOLD): Promise<FetchResult<number>> {
  const r = await call<{ price?: string }>("/price", { symbol }, key);
  if (!r.ok) return r;
  const p = Number(r.data.price);
  return Number.isFinite(p) && p > 0 ? { ok: true, data: p } : { ok: false, error: "no_data", detail: "no price" };
}

export async function marketOpen(key: string, symbol = GOLD): Promise<FetchResult<boolean>> {
  const r = await call<{ is_market_open?: boolean }>("/quote", { symbol }, key);
  return r.ok ? { ok: true, data: !!r.data.is_market_open } : r;
}
