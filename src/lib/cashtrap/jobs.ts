import { effectiveConfig } from "./config";
import { fetchHistory } from "./data";
import { dmiStatus } from "./dmi";
import { replay } from "./replay";
import { splitReport } from "./report";
import { BarOpenProxyQuoteSource } from "./signals";
import type { Admin } from "./supabaseStore";
import { SupabaseStore } from "./supabaseStore";
import { CASHTRAP_SYMBOLS, isCashtrapSymbol, type CashtrapSymbol } from "./symbols";

/**
 * REPLAY / BACKTEST RUNS — queued from the dashboard, run here one at a time.
 *
 * Each symbol is evaluated separately on real TwelveData 5-minute history with the live engine's own
 * step, chronologically, and split into a development period and a later, untouched out-of-sample
 * period. The rules are fixed — nothing is tuned on either period.
 *
 * Outcomes use the BAR-OPEN PROXY: reference entry = the open of the candle after confirmation,
 * settlement = the open of the candle at expiry. That assumes the signal could be acted on at the
 * instant its candle closed — optimistic (live publication is several seconds later) — and uses a
 * general feed, not the broker's prices. Every report says so. These are simulated records.
 */
export type ReplayParams = { symbols: CashtrapSymbol[]; weeks: number; payouts: number[]; devFraction: number };

export function parseReplayParams(x: unknown): { ok: true; value: ReplayParams } | { ok: false; error: string } {
  const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
  const symbols = Array.isArray(o.symbols) ? o.symbols.filter(isCashtrapSymbol) : o.symbol === "all" || o.symbol == null ? [...CASHTRAP_SYMBOLS] : isCashtrapSymbol(o.symbol) ? [o.symbol] : [];
  const weeks = Number(o.weeks ?? 8);
  const payouts = (Array.isArray(o.payouts) ? o.payouts : [0.8]).map(Number).filter((p) => Number.isFinite(p) && p > 0 && p <= 5);
  const devFraction = Number(o.devFraction ?? 0.7);
  if (!symbols.length) return { ok: false, error: "symbols: one of USDJPY, EURUSD, XAUUSD, GBPJPY, or 'all'" };
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > 12) return { ok: false, error: "weeks: whole number 1–12" };
  if (!payouts.length) return { ok: false, error: "payouts: at least one net payout between 0 and 5 (0.8 = 80%)" };
  if (!(devFraction >= 0.5 && devFraction <= 0.9)) return { ok: false, error: "devFraction: 0.5–0.9" };
  return { ok: true, value: { symbols, weeks, payouts, devFraction } };
}

export async function runNextReplay(db: Admin, key: string, nowMs = Date.now()): Promise<{ id: string; status: string } | null> {
  const q = await db.from("cashtrap_replay_runs").select("id, params").eq("status", "queued").order("created_at", { ascending: true }).limit(1);
  const job = ((q.data ?? []) as Array<{ id: string; params: unknown }>)[0];
  if (!job) return null;
  const claim = await db.from("cashtrap_replay_runs").update({ status: "running", started_at: new Date(nowMs).toISOString() }).eq("id", job.id).eq("status", "queued").select("id");
  if (!claim.data?.length) return null;
  try {
    const p = parseReplayParams(job.params);
    if (!p.ok) throw new Error(p.error);
    const store = new SupabaseStore(db);
    const settings = await store.getSettings();
    const cfg = effectiveConfig(settings.assumptions);
    const dmi = dmiStatus(settings.dmiMode, settings.dmiFeedVerified);
    const mode = settings.dmiMode === "event-feed" ? "off" : settings.dmiMode;   // history has no stored feed events
    const bySymbol: Record<string, unknown> = {};
    const signalsOut: Record<string, unknown[]> = {};
    for (const symbol of p.value.symbols) {
      const h = await fetchHistory(symbol, p.value.weeks, key, nowMs);
      if (!h.ok) { bySymbol[symbol] = { error: h.reason }; continue; }
      await store.upsertCandles(symbol, h.candles, "twelvedata-history", nowMs);
      const r = await replay({
        symbol, candles: h.candles, config: cfg, dmiMode: mode, dmiAvailable: mode === "calculation" && dmi.available,
        manualZones: await store.manualZones(symbol),                 // each applies only from when it was marked
        decisionLatencyMs: 0, publishLatencyMs: 0, quotes: new BarOpenProxyQuoteSource({ [symbol]: h.candles.map((k) => ({ t: k.t, o: k.o })) }),
      });
      bySymbol[symbol] = {
        candles: h.candles.length, feedIssues: h.issues.slice(0, 20),
        ...splitReport(r.decisions, r.setups, r.signals, p.value.payouts, cfg.assumptions.tieRule, p.value.devFraction),
      };
      signalsOut[symbol] = r.signals.slice(-500).map((s) => ({ d: s.direction, setup: s.setupCandleT, conf: s.confirmationT, pub: s.publishedAt, entry: s.referencePrice, entryAt: s.referenceAt, exp: s.expiryAt, settle: s.settlementPrice, result: s.result }));
    }
    const report = {
      generatedAt: new Date().toISOString(), strategyVersion: cfg.strategyVersion, configVersion: cfg.configVersion, params: p.value,
      dmi: { mode: settings.dmiMode, label: dmi.label },
      outcomeBasis: "bar-open proxy on TwelveData 5-minute history: entry at the open of the candle after confirmation, settlement at the open of the candle at expiry. Assumes publication at the candle's close — optimistic: live signals are published ~90 s after the close, once the feed's candle is final. General feed, not broker prices. Simulated records, not broker-verified.",
      bySymbol,
    };
    await db.from("cashtrap_replay_runs").update({ status: "done", report, signals: signalsOut, finished_at: new Date().toISOString() }).eq("id", job.id);
    return { id: job.id, status: "done" };
  } catch (e) {
    await db.from("cashtrap_replay_runs").update({ status: "failed", error: e instanceof Error ? e.message : String(e), finished_at: new Date().toISOString() }).eq("id", job.id);
    return { id: job.id, status: "failed" };
  }
}
