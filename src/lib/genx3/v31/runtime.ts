/**
 * GENX 3.1 live runtime (Railway worker, lock id 3). Every closed minute: refresh bars, run the
 * SAME step() the replays use, record the decision, publish at most one signal, deliver through
 * Flow to the configured scope. Fails closed on stale/invalid data, unknown news, version mismatch.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { liveTick } from "@/lib/flow/liveTicks";
import { sendTelegram, esc } from "@/lib/telegram";
import { checkHealth, normalize1m, type Bar } from "../candles";
import { newsState } from "../news";
import { stableUuid, type Genx3Signal } from "../signal";
import { XAUUSD, distance } from "../instrument";
import { readControl, emergencyDisable, deliver } from "../runtime";
import { buildSeries, tradableOnly } from "./series";
import { step, newState, STRATEGY_VERSION_31, type Scored } from "./engine";
import type { Ctx } from "./context";
import { CONFIG31 } from "./config";
import { createHash } from "node:crypto";

type Admin = NonNullable<ReturnType<typeof createAdminClient>>;
const bars = new Map<number, Bar>();
const st = newState();
let archiveLoadedAt = 0, lastFetchMinute = 0, lastFetchAt = 0, lastStepMinute = 0, seenLoaded = false;

async function loadArchive(admin: Admin, sinceMs: number) {
  for (let page = 0; page < 80; page++) {
    const { data, error } = await admin.from("genx_candle_archive").select("t,o,h,l,c").eq("symbol", "XAU/USD").eq("interval", "1min").gte("t", new Date(sinceMs).toISOString()).order("t", { ascending: true }).range(page * 1000, page * 1000 + 999);
    if (error) throw new Error(`archive_read: ${error.message}`);
    const rows = (data ?? []) as { t: string; o: number; h: number; l: number; c: number }[];
    for (const r of rows) { const t = Date.parse(r.t); bars.set(t, { t, o: +r.o, h: +r.h, l: +r.l, c: +r.c }); }
    if (rows.length < 1000) break;
  }
}
async function fetchRecent() {
  const key = process.env.TWELVEDATA_API_KEY; if (!key) throw new Error("no TWELVEDATA_API_KEY");
  const r = await fetch(`https://api.twelvedata.com/time_series?symbol=XAU%2FUSD&interval=1min&outputsize=120&timezone=UTC&order=ASC&apikey=${key}`, { cache: "no-store" });
  const j = (await r.json()) as { status?: string; values?: { datetime: string; open: string; high: string; low: string; close: string }[]; message?: string };
  if (j.status === "error" || !Array.isArray(j.values)) throw new Error(`td: ${String(j.message ?? "").slice(0, 80)}`);
  for (const v of j.values) { const t = Date.parse(`${v.datetime.replace(" ", "T")}Z`); if (Number.isFinite(t)) bars.set(t, { t, o: +v.open, h: +v.high, l: +v.low, c: +v.close }); }
  const cutoff = Date.now() - 40 * 86_400_000; for (const t of bars.keys()) if (t < cutoff) bars.delete(t);
}
async function incident(admin: Admin, kind: string, severity: "info" | "warn" | "critical", detail: Record<string, unknown>) { try { await admin.from("genx3_incidents").insert({ kind, severity, detail }); } catch { /* best-effort */ } }

export function buildSignal31(best: Scored, ctx: Ctx, asOf: number, feedAgeMs: number | null): Genx3Signal {
  const { c, v } = best; const rule = CONFIG31.rules[c.playbook]; const d = c.side === "BUY" ? 1 : -1;
  const target = +(c.entry + d * rule.exitR * c.risk).toFixed(2);
  // Flow places a GTC limit at the zone edge ± 10 pips. MARKET → zone at the entry (fills within
  // 10 pips); LIMIT → zone 10 pips beyond the entry so the resting order sits exactly at the entry.
  const edge = c.entryType === "LIMIT" ? +(c.entry - d * 1.0).toFixed(2) : c.entry;
  const key = createHash("sha256").update([STRATEGY_VERSION_31, c.anchor, asOf, c.side, c.entry.toFixed(2), c.stop.toFixed(2), target.toFixed(2)].join("|")).digest("hex");
  const dT = distance(c.entry, target), dR = distance(c.entry, c.stop), cost = CONFIG31.costUsd;
  return {
    signal_id: stableUuid(`sig:${key}`), setup_id: stableUuid(`setup:${STRATEGY_VERSION_31}:${c.anchor}`), strategy: "GENX_3_0", strategy_version: STRATEGY_VERSION_31,
    symbol_canonical: "XAUUSD", broker_symbol: XAUUSD.brokerSymbol, side: c.side, setup_type: c.playbook as never, regime: ctx.regime as never,
    created_at_utc: new Date(asOf).toISOString(), expires_at_utc: new Date(asOf + 3 * 60_000).toISOString(), market_snapshot_id: stableUuid(`snap31:${asOf}`), decision_candle_close_time: new Date(asOf).toISOString(),
    entry_type: "LIMIT", entry_price: c.entry, entry_zone_low: edge, entry_zone_high: edge, stop_price: c.stop, target_price: target,
    target_price_distance: dT.priceUsd, target_ticks: dT.ticks, target_points: dT.points, target_display_pips: dT.displayPips,
    risk_price_distance: dR.priceUsd, gross_reward_risk: +(dT.priceUsd / dR.priceUsd).toFixed(3), estimated_net_reward_risk: +((dT.priceUsd - cost) / (dR.priceUsd + cost)).toFixed(3),
    confidence: v.score, score_components: { total: v.score, threshold: v.threshold, components: Object.entries(v.components).map(([key, points]) => ({ key, points, max: 0, evidence: "" })), penalties: [], version: STRATEGY_VERSION_31 },
    evidence: c.evidence, contradictions: [], invalidation_conditions: [`price trades ${d > 0 ? "below" : "above"} ${c.invalidation.toFixed(2)} (structure)`],
    spread_at_decision: CONFIG31.costUsd, spread_is_estimate: true, feed_latency_ms: feedAgeMs, data_quality: "HEALTHY", news_state: "CLEAR",
    idempotency_key: key, correlation_id: stableUuid(`corr:${key}`), instrument_spec_version: XAUUSD.specVersion,
  };
}

export function validateSignal31(s: Genx3Signal): string[] {
  const e: string[] = [];
  for (const k of ["entry_price", "entry_zone_low", "entry_zone_high", "stop_price", "target_price", "risk_price_distance", "target_price_distance", "confidence"] as const) if (!Number.isFinite(s[k] as number)) e.push(`${k} not finite`);
  if (s.strategy_version !== STRATEGY_VERSION_31) e.push("version mismatch");
  if (!/^[0-9a-f]{64}$/.test(s.idempotency_key)) e.push("idempotency_key invalid");
  const up = s.side === "BUY";
  if (up ? !(s.stop_price < s.entry_zone_low && s.target_price > s.entry_zone_high) : !(s.stop_price > s.entry_zone_high && s.target_price < s.entry_zone_low)) e.push("stop/target on the wrong side of the zone");
  if (s.risk_price_distance > CONFIG31.maxRiskUsd + 1e-9 || s.risk_price_distance < CONFIG31.minRiskUsd) e.push("risk outside limits");
  if (!s.evidence.length) e.push("no evidence");
  return e;
}

function message(s: Genx3Signal): string {
  return [`🧠 <b>GENX ${STRATEGY_VERSION_31.slice(0, 3)} — ${s.side} XAUUSD · ${esc(String(s.setup_type).replace(/_/g, " "))}</b>`, `Regime ${esc(String(s.regime))} · Score ${s.confidence}`,
    `Entry ${s.entry_price.toFixed(2)} · Stop ${s.stop_price.toFixed(2)} · Target ${s.target_price.toFixed(2)} (${s.gross_reward_risk.toFixed(1)}R)`, ...s.evidence.slice(0, 3).map((x) => `• ${esc(x)}`), `<i>Educational, not financial advice.</i>`].join("\n");
}

export type Tick31 = { ran: boolean; reason?: string; asOf?: string; signal?: string | null; reasons?: string[] };
export async function genx31Tick(admin: Admin, holder: string): Promise<Tick31> {
  const ctl = await readControl(admin);
  if (!ctl) return { ran: false, reason: "no_control_row" };
  if (ctl.mode === "OFF" || ctl.mode === "EMERGENCY_DISABLED") return { ran: false, reason: `mode_${ctl.mode}` };
  if (ctl.strategy_version !== STRATEGY_VERSION_31) { await emergencyDisable(admin, `strategy version mismatch: control ${ctl.strategy_version} vs worker ${STRATEGY_VERSION_31}`); return { ran: false, reason: "version_mismatch" }; }
  const now = Date.now();
  if (now - archiveLoadedAt > 30 * 60_000) { await loadArchive(admin, now - 35 * 86_400_000); archiveLoadedAt = now; }
  if (!seenLoaded) {
    const { data } = await admin.from("genx3_setups").select("setup_key").eq("strategy_version", STRATEGY_VERSION_31).gte("first_seen_at", new Date(now - 3 * 86_400_000).toISOString()).limit(5000);
    for (const r of (data ?? []) as { setup_key: string }[]) st.seen.add(r.setup_key);
    seenLoaded = true;
  }
  const minute = Math.floor(now / 60_000), sec = (now % 60_000) / 1000;
  const asOf = minute * 60_000;                     // the minute that just closed
  const lastBarT = asOf - 60_000;
  if ((minute !== lastFetchMinute && sec >= 3) || (!bars.has(lastBarT) && sec >= 3 && sec <= 45 && now - lastFetchAt >= 8_000)) {
    lastFetchAt = now;
    try { await fetchRecent(); lastFetchMinute = minute; } catch (e) { await incident(admin, "provider_fetch_failed", "warn", { error: String(e).slice(0, 200) }); }
  }
  if (minute === lastStepMinute) return { ran: false, reason: "done_this_minute" };
  if (!bars.has(lastBarT) && sec < 45) return { ran: false, reason: "awaiting_final_1m_bar" };
  lastStepMinute = minute;

  const closed = tradableOnly(normalize1m([...bars.values()], asOf).closed);
  const health = checkHealth({ closed1m: closed, asOf, maxFeedAgeMs: 150_000, maxGapBars: 3, spikeAtrMultiple: 4, duplicates: 0, outOfOrder: 0, invalid: 0, liveTick: liveTick("XAU/USD", 20_000), feedDisagreeUsd: 5 });
  const series = buildSeries(closed);
  const news = await newsState(now);
  const r = step(series, asOf, CONFIG31, st, { early: CONFIG31.early, newsBlocked: news.state !== "CLEAR" });
  const reasons = [...r.reasons];
  let best = r.best;
  if (best && health.state === "INVALID") { reasons.push(`data_invalid: ${health.issues.join(",")}`); best = null; }
  if (best && news.state !== "CLEAR") { reasons.push(`news_${news.state}`); best = null; }
  const record = r.kind === "5m" || r.scored.length > 0;
  if (record) {
    const { error } = await admin.from("genx3_decisions").insert({
      strategy_version: STRATEGY_VERSION_31, snapshot_id: stableUuid(`snap31:${asOf}`), as_of: new Date(now).toISOString(), decision_candle_close: new Date(asOf).toISOString(), mode: ctl.mode,
      data_state: health.state, data_issues: health.issues, feed_age_ms: health.feedAgeMs, news_state: news.state,
      regime: r.ctx?.regime ?? null, regime_confidence: null,
      regime_detail: r.ctx ? { vol: r.ctx.volState, volRatio: +r.ctx.volRatio.toFixed(2), session: r.ctx.session, bias1h: r.ctx.bias1h, bias4h: r.ctx.bias4h, mom20d: r.ctx.mom20d, atr5: +r.ctx.atr5.toFixed(2), atr15: +r.ctx.atr15.toFixed(2), armed: st.armed.length, kind: r.kind } : null,
      candidates: r.scored.map((x) => ({ playbook: x.c.playbook, side: x.c.side, entry: x.c.entry, stop: x.c.stop, risk: x.c.risk, score: x.v.score, threshold: x.v.threshold, ok: x.v.ok, hardFail: x.v.hardFail, components: x.v.components, evidence: x.c.evidence })),
      no_trade_reasons: best ? [] : reasons, signal_id: null, worker: holder,
    });
    if (error && /duplicate|unique/i.test(error.message)) return { ran: false, reason: "decided_by_other" };
  }
  for (const x of r.scored) {
    await admin.from("genx3_setups").upsert({ setup_id: stableUuid(`setup:${STRATEGY_VERSION_31}:${x.c.anchor}`), strategy_version: STRATEGY_VERSION_31, setup_key: x.c.anchor, setup_type: x.c.playbook, side: x.c.side, state: "TRIGGERED", snapshot_id: stableUuid(`snap31:${asOf}`), expires_at: new Date(asOf + 3 * 60_000).toISOString(), detail: { entry: x.c.entry, stop: x.c.stop, risk: x.c.risk, score: x.v.score, ok: x.v.ok, hardFail: x.v.hardFail, evidence: x.c.evidence, transition_reason: x.v.ok ? "passed stage 2" : x.v.hardFail ?? "score below threshold" } }, { onConflict: "strategy_version,setup_key", ignoreDuplicates: true });
    if (!x.v.ok || x !== best) await admin.from("genx3_setups").update({ state: x.v.ok ? "EXPIRED" : "INVALIDATED", detail: { transition_reason: x.v.ok ? "not selected" : x.v.hardFail ?? "score below threshold" } }).eq("strategy_version", STRATEGY_VERSION_31).eq("setup_key", x.c.anchor).eq("state", "TRIGGERED");
  }
  if (!best || !r.ctx) return { ran: true, asOf: new Date(asOf).toISOString(), signal: null, reasons };
  if (Date.now() - asOf > 75_000) return { ran: true, signal: null, reasons: ["stale_signal_not_published"] };
  const sig = buildSignal31(best, r.ctx, asOf, health.feedAgeMs);
  const errs = validateSignal31(sig);
  if (errs.length) { await incident(admin, "signal_schema_invalid", "critical", { errs }); return { ran: true, signal: null, reasons: errs }; }
  const live = ctl.mode === "LIVE";
  const { error } = await admin.from("genx3_signals").insert({ signal_id: sig.signal_id, idempotency_key: sig.idempotency_key, setup_id: sig.setup_id, strategy_version: STRATEGY_VERSION_31, decision_candle_close: sig.decision_candle_close_time, side: sig.side, entry_zone_low: sig.entry_zone_low, entry_zone_high: sig.entry_zone_high, stop_price: sig.stop_price, target_price: sig.target_price, payload: sig, mode: live ? "LIVE" : "MONITOR", status: live ? "PUBLISHED" : "NOT_DELIVERED_MONITOR", expires_at: sig.expires_at_utc });
  if (error) return { ran: true, signal: null, reasons: [/duplicate|unique/i.test(error.message) ? "signal_already_published" : `signal_write_failed: ${error.message}`] };
  await admin.from("genx3_decisions").update({ signal_id: sig.signal_id }).eq("strategy_version", STRATEGY_VERSION_31).eq("decision_candle_close", new Date(asOf).toISOString());
  await admin.from("genx3_setups").update({ state: "PUBLISHED", detail: { transition_reason: live ? "published LIVE" : "published MONITOR" } }).eq("setup_id", sig.setup_id).eq("state", "TRIGGERED");
  if (live) { if (process.env.TELEGRAM_ADMIN_CHAT_ID) { try { await sendTelegram(message(sig), { chatId: process.env.TELEGRAM_ADMIN_CHAT_ID }); } catch { /* best-effort */ } } await deliver(admin, sig, ctl); }
  return { ran: true, asOf: new Date(asOf).toISOString(), signal: sig.signal_id, reasons: [] };
}
