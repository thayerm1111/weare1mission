import { type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { series, type Row as MdRow } from "@/lib/marketData";
import { getInstrument } from "@/lib/matty-pips/pips";
import { evaluateCall, type CallForGrading } from "@/lib/matty-pips/outcome";
import type { Candle } from "@/lib/matty-pips/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * MATTY PIPS — OUTCOME CRON (key-gated, every 15 minutes). The learning loop:
 * every archived GOLD DECISION ENGINE call gets graded against the candles
 * that printed AFTER it — TP1/2/3 vs SL first-touch, fill-or-unfilled for
 * WAIT/BREAKOUT plans, MFE/MAE, and "$3 favorable before $3 adverse".
 *
 * READ-ONLY toward the market and brokers: this route never places, modifies,
 * or closes anything, and touches only matty_pips_* tables. Costs at most two
 * cached series reads per pass regardless of how many calls are pending.
 */
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
function authorized(req: NextRequest): boolean {
  const key = process.env.GENX_CRON_KEY, secret = process.env.CRON_SECRET;
  const qp = new URL(req.url).searchParams.get("key") || "";
  const hdr = req.headers.get("authorization") || "";
  if (key && (qp === key || hdr === `Bearer ${key}`)) return true;
  if (secret && (qp === secret || hdr === `Bearer ${secret}`)) return true;
  return false;
}

function toCandles(rows: MdRow[]): Candle[] {
  return rows
    .map((r) => ({ t: Date.parse(r.datetime), o: +r.open, h: +r.high, l: +r.low, c: +r.close }))
    .filter((c) => [c.o, c.h, c.l, c.c].every(Number.isFinite))
    .sort((a, b) => a.t - b.t);
}

type AnalysisRow = {
  id: string; created_at: string; symbol: string;
  decision: { call?: (CallForGrading & { conviction?: number; confidence?: number; setupFamily?: string; regime?: string; session?: string; volatility?: string; entryQualityScore?: number; engine?: string }) | null } | null;
};

async function run(): Promise<Response> {
  const admin = createAdminClient();
  if (!admin) return json({ ok: false, error: "not_configured" }, 500);
  const mdKey = process.env.TWELVEDATA_API_KEY;
  if (!mdKey) return json({ ok: false, error: "no_market_data_key" }, 500);

  // 1) Recent gold analyses that carry a call and have no outcome row yet,
  //    plus outcome rows still pending. 72h lookback keeps the set small.
  const sinceIso = new Date(Date.now() - 72 * 3600_000).toISOString();
  const [aRes, oRes] = await Promise.all([
    admin.from("matty_pips_analysis").select("id, created_at, symbol, decision")
      .eq("symbol", "XAUUSD").gte("created_at", sinceIso)
      .order("created_at", { ascending: true }).limit(300),
    admin.from("matty_pips_outcomes").select("id, analysis_id, status").gte("call_at", sinceIso).limit(500),
  ]);
  if (aRes.error) return json({ ok: false, error: "db", detail: aRes.error.message }, 500);
  const analyses = (aRes.data ?? []) as AnalysisRow[];
  const outcomes = (oRes.data ?? []) as { id: string; analysis_id: string; status: string }[];
  const byAnalysis = new Map(outcomes.map((o) => [o.analysis_id, o]));

  const work = analyses.filter((a) => {
    const existing = byAnalysis.get(a.id);
    if (existing && existing.status !== "pending" && existing.status !== "unfilled") return false;
    return !!a.decision?.call && Number.isFinite(a.decision.call!.entry) && Number.isFinite(a.decision.call!.stopLoss);
  });
  if (!work.length) return json({ ok: true, graded: 0, pending: 0 });

  // 2) One shared candle pull: 5M covers ~13h at fine grain, 15M covers ~40h+.
  const td = getInstrument("XAUUSD").twelveDataSymbol;
  const [m5R, m15R] = await Promise.all([
    series(td, "5min", 160, mdKey, false),
    series(td, "15min", 300, mdKey, false),
  ]);
  const m5 = Array.isArray(m5R) ? toCandles(m5R) : [];
  const m15 = Array.isArray(m15R) ? toCandles(m15R) : [];
  if (m15.length < 40) return json({ ok: false, error: "no_data" }, 200);

  let graded = 0, pending = 0;
  const nowIso = new Date().toISOString();
  for (const a of work) {
    const call = a.decision!.call!;
    const callMs = Date.parse(a.created_at);
    // Closed bars strictly after the call; prefer 5M coverage when it reaches back far enough.
    const use5 = m5.length >= 40 && m5[0].t <= callMs;
    const src = use5 ? m5 : m15;
    const barMs = use5 ? 5 * 60000 : 15 * 60000;
    const bars = src.slice(0, -1).filter((c) => c.t >= callMs);
    // Bar budgets in the chosen granularity: fill window 8h, expiry 24h.
    const unfilledBars = Math.round((8 * 3600_000) / barMs);
    const expiryBars = Math.round((24 * 3600_000) / barMs);
    const r = evaluateCall(call, bars, { unfilledBars, expiryBars });

    const row = {
      analysis_id: a.id,
      call_at: a.created_at,
      symbol: "XAUUSD",
      direction: call.direction,
      conviction: call.conviction ?? call.confidence ?? null,
      execution_state: call.executionState ?? "TAKE_NOW",
      setup_family: call.setupFamily ?? null,
      regime: call.regime ?? null,
      session: call.session ?? null,
      volatility: call.volatility ?? null,
      entry_quality: call.entryQualityScore ?? null,
      engine: call.engine ?? null,
      entry: call.entry, stop_loss: call.stopLoss,
      tp1: call.tp1, tp2: call.tp2, tp3: call.tp3,
      status: r.status,
      first_hit: r.firstHit,
      filled: r.filled,
      mfe: r.mfe, mae: r.mae,
      plus3_before_minus3: r.plus3BeforeMinus3,
      bars_used: r.barsUsed,
      granularity: use5 ? "5min" : "15min",
      resolved_at: r.resolvedAtT ? new Date(r.resolvedAtT).toISOString() : null,
      updated_at: nowIso,
    };
    const existing = byAnalysis.get(a.id);
    if (existing) await admin.from("matty_pips_outcomes").update(row).eq("id", existing.id);
    else await admin.from("matty_pips_outcomes").insert(row);
    if (r.status === "pending") pending++; else graded++;
  }
  return json({ ok: true, graded, pending, scanned: work.length });
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return json({ ok: false, error: "unauthorized" }, 401);
  try { return await run(); } catch (e) {
    return json({ ok: false, error: "crashed", detail: e instanceof Error ? e.message : String(e) }, 500);
  }
}
