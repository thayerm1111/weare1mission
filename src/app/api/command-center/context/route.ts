import { createClient } from "@/lib/supabase/server";
import { createClient as adminClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GLOBAL CONTEXT — DXY, US 10-YEAR, S&P AND WTI. INFORMATIONAL, NEVER AN INPUT.
 *
 * Shown because a gold trader wants them on screen. GENX and THE BRAIN do not read this route, this
 * file imports nothing from the engine, and nothing it returns reaches a trading decision.
 *
 * WHAT THE DATA PLAN ACTUALLY SERVES (probed 09-21 with /api/admin/feed-probe):
 *
 *   DXY      the index itself is NOT on this Twelve Data plan (404). "DX" and "USDX" resolve to an
 *            unrelated REIT and an unrelated ETF, so they are never used — a wrong instrument under the
 *            right name is worse than an empty panel. Instead the index is COMPUTED from the six live FX
 *            pairs with ICE's published formula, and the screen says so.
 *   US10Y    not served. The IEF Treasury ETF is, at an end-of-day price, and is labelled as that.
 *   SPX      not served. SPY is, end-of-day, labelled as that.
 *   WTI/USD  served live.
 *
 * Every row carries the instrument actually used, the source, the time it was quoted and a status
 * (live / delayed / stale / not connected). Nothing is invented and nothing delayed is called live.
 *
 * COST: one batched quote every fifteen minutes, shared by every viewer through the cached row, so the
 * feed budget THE BRAIN depends on is barely touched. A failure here leaves the last good values in
 * place and the panel says how old they are.
 */
const TTL_MS = 15 * 60_000;
const HISTORY_MAX = 64;

/** ICE's published US Dollar Index formula. The weights are the index's definition, not a fit. */
const DXY_LEGS: { sym: string; exp: number }[] = [
  { sym: "EUR/USD", exp: -0.576 }, { sym: "USD/JPY", exp: 0.136 }, { sym: "GBP/USD", exp: -0.119 },
  { sym: "USD/CAD", exp: 0.091 }, { sym: "USD/SEK", exp: 0.042 }, { sym: "USD/CHF", exp: 0.036 },
];
const DXY_K = 50.14348112;

const ETF_ROWS: { key: string; label: string; symbol: string; instrument: string; note: string }[] = [
  { key: "us10y", label: "US10Y", symbol: "IEF", instrument: "IEF ETF", note: "US 10-year yield is not on this data plan. IEF (7–10y Treasuries) moves inversely to yields." },
  { key: "spx", label: "SPX", symbol: "SPY", instrument: "SPY ETF", note: "The S&P index is not on this data plan. SPY tracks it." },
  { key: "wti", label: "WTI", symbol: "WTI/USD", instrument: "WTI spot", note: "Crude oil spot." },
];

type Status = "live" | "delayed" | "stale" | "not_connected";
export type ContextRow = {
  key: string; label: string; instrument: string; source: string; note: string;
  value: number | null; change: number | null; changePct: number | null;
  period: string; asOf: string | null; status: Status;
};
type Cached = { rows: ContextRow[]; history: { t: number; v: number }[]; at: number };

const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const num = (v: unknown): number | null => { const n = Number(v); return Number.isFinite(n) ? n : null; };

/** Quote rows for a batch of symbols. A single symbol comes back unwrapped, so both shapes are handled. */
async function quotes(symbols: string[], key: string): Promise<Record<string, Record<string, unknown>>> {
  const u = new URL("https://api.twelvedata.com/quote");
  u.searchParams.set("symbol", symbols.join(","));
  const r = await fetch(u.toString(), { headers: { Authorization: `apikey ${key}` }, cache: "no-store", signal: AbortSignal.timeout(9000) });
  const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (symbols.length === 1) return { [symbols[0]]: body as Record<string, unknown> };
  return body as Record<string, Record<string, unknown>>;
}

/**
 * Live, delayed or stale — and a shut market is not a broken feed.
 *
 * A Friday close read on a Sunday is the latest price that exists for that instrument, so it is DELAYED,
 * not stale. Only a quote older than five days (a market that should have traded and did not) is stale.
 */
function statusOf(q: Record<string, unknown> | undefined, ageMs: number | null): Status {
  if (!q || q.status === "error") return "not_connected";
  if (ageMs != null && ageMs > 5 * 24 * 3600_000) return "stale";
  return q.is_market_open === true ? "live" : "delayed";
}

function ageOf(q: Record<string, unknown> | undefined): { asOf: string | null; ageMs: number | null } {
  const ts = q?.timestamp != null ? Number(q.timestamp) * 1000 : null;
  const dt = typeof q?.datetime === "string" ? Date.parse(q.datetime + (q.datetime.length <= 10 ? "T21:00:00Z" : "Z")) : null;
  const at = ts && Number.isFinite(ts) ? ts : dt && Number.isFinite(dt) ? dt : null;
  return { asOf: at ? new Date(at).toISOString() : null, ageMs: at ? Date.now() - at : null };
}

/** The index from six pairs, and the same computation on each pair's previous close for the change. */
function computeDxy(qs: Record<string, Record<string, unknown>>): { value: number; prev: number | null; live: boolean; asOf: string | null } | null {
  let value = DXY_K, prev = DXY_K, havePrev = true, live = true;
  let newest: number | null = null;
  for (const leg of DXY_LEGS) {
    const q = qs[leg.sym];
    const close = num(q?.close);
    if (!q || q.status === "error" || close == null || close <= 0) return null;
    value *= Math.pow(close, leg.exp);
    const pct = num(q.percent_change);
    if (pct == null) havePrev = false;
    else prev *= Math.pow(close / (1 + pct / 100), leg.exp);
    if (q.is_market_open !== true) live = false;
    const { asOf } = ageOf(q);
    const t = asOf ? Date.parse(asOf) : null;
    if (t && (newest == null || t > newest)) newest = t;
  }
  return { value: +value.toFixed(3), prev: havePrev ? +prev.toFixed(3) : null, live, asOf: newest ? new Date(newest).toISOString() : null };
}

export async function GET() {
  const supabase = createClient();
  if (!supabase) return json({ ok: false, rows: [] }, 503);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ ok: false, error: "unauthorized" }, 401);

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, sk = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !sk) return json({ ok: false, rows: [] }, 503);
  const c = adminClient(url, sk, { auth: { persistSession: false } });

  const { data } = await c.from("cc_chart_bars").select("bars, updated_at").eq("tf", "ctx").maybeSingle();
  const row = data as { bars: Cached | unknown; updated_at: string } | null;
  const cached = (row?.bars && typeof row.bars === "object" && "rows" in (row.bars as object) ? row.bars as Cached : null);
  const cachedAt = row ? Date.parse(row.updated_at) : 0;
  if (cached && Date.now() - cachedAt < TTL_MS) {
    return json({ ok: true, rows: cached.rows, history: cached.history ?? [], at: cachedAt, cached: true });
  }

  const key = process.env.TWELVEDATA_API_KEY;
  if (!key) {
    return json({ ok: false, error: "TWELVEDATA_API_KEY is not set on this deployment", rows: cached?.rows ?? [], history: cached?.history ?? [], at: cachedAt || null });
  }

  try {
    const syms = ["DXY", ...DXY_LEGS.map((l) => l.sym), ...ETF_ROWS.map((r) => r.symbol)];
    const qs = await quotes(syms, key);

    const rows: ContextRow[] = [];

    /* DXY — the real index if the plan ever serves it, otherwise the computed basket, never a lookalike. */
    const realDxy = qs["DXY"];
    const realClose = num(realDxy?.close);
    if (realDxy && realDxy.status !== "error" && realClose != null) {
      const { asOf, ageMs } = ageOf(realDxy);
      const pct = num(realDxy.percent_change);
      rows.push({
        key: "dxy", label: "DXY", instrument: "US Dollar Index", source: "Twelve Data",
        note: "The US Dollar Index as published.",
        value: realClose, changePct: pct, change: pct != null ? +(realClose * pct / 100).toFixed(3) : null,
        period: "vs previous close", asOf, status: statusOf(realDxy, ageMs),
      });
    } else {
      const d = computeDxy(qs);
      rows.push(d ? {
        key: "dxy", label: "DXY", instrument: "Computed from the ICE basket",
        source: "Twelve Data FX · ICE formula",
        note: "The index itself is not on this data plan, so it is computed live from EUR, JPY, GBP, CAD, SEK and CHF with ICE's published weights. It tracks DXY closely but is our calculation, not the published index.",
        value: d.value, change: d.prev != null ? +(d.value - d.prev).toFixed(3) : null,
        changePct: d.prev != null ? +(((d.value - d.prev) / d.prev) * 100).toFixed(3) : null,
        period: "vs previous close", asOf: d.asOf, status: d.live ? "live" : "delayed",
      } : {
        key: "dxy", label: "DXY", instrument: "—", source: "—",
        note: "DXY feed not connected. Missing dependency: a Twelve Data plan that serves the DXY index, or a second provider for it. The FX pairs needed to compute it are also unavailable right now.",
        value: null, change: null, changePct: null, period: "vs previous close", asOf: null, status: "not_connected",
      });
    }

    for (const r of ETF_ROWS) {
      const q = qs[r.symbol];
      const close = num(q?.close);
      const { asOf, ageMs } = ageOf(q);
      const pct = num(q?.percent_change);
      rows.push({
        key: r.key, label: r.label, instrument: r.instrument, source: "Twelve Data", note: r.note,
        value: q && q.status !== "error" ? close : null,
        change: close != null && pct != null ? +(close * pct / 100).toFixed(3) : null,
        changePct: pct, period: "vs previous close", asOf, status: statusOf(q, ageMs),
      });
    }

    // Our own sample history for the dollar sparkline: one point per refresh, so the line is real
    // samples we took rather than a series we did not pay for.
    const dxyValue = rows[0]?.value ?? null;
    const history = [...(cached?.history ?? []), ...(dxyValue != null ? [{ t: Date.now(), v: dxyValue }] : [])].slice(-HISTORY_MAX);

    const payload: Cached = { rows, history, at: Date.now() };
    await c.from("cc_chart_bars").upsert({ tf: "ctx", bars: payload, updated_at: new Date().toISOString() }, { onConflict: "tf" });
    return json({ ok: true, rows, history, at: payload.at });
  } catch (e) {
    return json({
      ok: false, error: e instanceof Error ? e.message.slice(0, 160) : "feed_error",
      rows: cached?.rows ?? [], history: cached?.history ?? [], at: cachedAt || null,
    });
  }
}
