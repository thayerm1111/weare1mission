/**
 * GENX 3.2 live runtime (Railway worker, lock id 3). Every closed minute while XAUUSD is open:
 * bars (archive + provider REST, or the streamed-tick bar when REST is late) → step32 → decision,
 * candidate and shadow logging → at most one idempotent signal → Flow (whitelisted accounts only).
 * Never fails open: stale/invalid data, unknown news, malformed signal or impossible price = no trade.
 */
import { createHash } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { liveTick, tickBar, tickCoverage } from "@/lib/flow/liveTicks";
import { sendTelegram, esc } from "@/lib/telegram";
import { checkHealth, normalize1m, type Bar } from "../candles";
import { newsState } from "../news";
import { stableUuid, type Genx3Signal } from "../signal";
import { XAUUSD, distance } from "../instrument";
import { readControl, emergencyDisable, deliver } from "../runtime";
import { selectBrain } from "../engineSelect";
import { buildSeries, tradableOnly, lastClosed } from "../v31/series";
import { step32, newState32, type Record32, type Step32 } from "./engine";
import { CONFIG32, STRATEGY_VERSION_32 } from "./config";
import { simulate } from "./sim";

type Admin = NonNullable<ReturnType<typeof createAdminClient>>;
const bars = new Map<number, Bar>();
const barSource = new Map<number, "rest" | "ticks">();
const st = newState32();
const loggedWaits = new Map<string, string>();
let lastTickCoverage: unknown = null;
let archiveLoadedAt = 0, lastFetchMinute = 0, lastFetchAt = 0, lastStepMinute = 0, seenLoaded = false, impossiblePrice = 0;

async function loadArchive(admin: Admin, sinceMs: number) {
  for (let page = 0; page < 80; page++) {
    const { data, error } = await admin.from("genx_candle_archive").select("t,o,h,l,c").eq("symbol", "XAU/USD").eq("interval", "1min").gte("t", new Date(sinceMs).toISOString()).order("t", { ascending: true }).range(page * 1000, page * 1000 + 999);
    if (error) throw new Error(`archive_read: ${error.message}`);
    const rows = (data ?? []) as { t: string; o: number; h: number; l: number; c: number }[];
    for (const r of rows) { const t = Date.parse(r.t); if (barSource.get(t) !== "rest") { bars.set(t, { t, o: +r.o, h: +r.h, l: +r.l, c: +r.c }); barSource.set(t, "rest"); } }
    if (rows.length < 1000) break;
  }
}
async function fetchRecent() {
  const key = process.env.TWELVEDATA_API_KEY; if (!key) throw new Error("no TWELVEDATA_API_KEY");
  const r = await fetch(`https://api.twelvedata.com/time_series?symbol=XAU%2FUSD&interval=1min&outputsize=120&timezone=UTC&order=ASC&apikey=${key}`, { cache: "no-store" });
  const j = (await r.json()) as { status?: string; values?: { datetime: string; open: string; high: string; low: string; close: string }[]; message?: string };
  if (j.status === "error" || !Array.isArray(j.values)) throw new Error(`td: ${String(j.message ?? "").slice(0, 80)}`);
  for (const v of j.values) { const t = Date.parse(`${v.datetime.replace(" ", "T")}Z`); if (Number.isFinite(t)) { bars.set(t, { t, o: +v.open, h: +v.high, l: +v.low, c: +v.close }); barSource.set(t, "rest"); } }
  const cutoff = Date.now() - 40 * 86_400_000; for (const t of bars.keys()) if (t < cutoff) { bars.delete(t); barSource.delete(t); }
}
async function incident(admin: Admin, kind: string, severity: "info" | "warn" | "critical", detail: Record<string, unknown>) { try { await admin.from("genx3_incidents").insert({ kind, severity, detail }); } catch { /* best-effort */ } }

export function buildSignal32(sel: Record32, res: Step32, feedAgeMs: number | null): Genx3Signal {
  const c = sel.cand!, asOf = res.asOf, d = c.side === "BUY" ? 1 : -1;
  const key = createHash("sha256").update([STRATEGY_VERSION_32, c.anchor, asOf, c.side, c.entry.toFixed(2), c.stop.toFixed(2), c.target.toFixed(2)].join("|")).digest("hex");
  const dT = distance(c.entry, c.target), dR = distance(c.entry, c.stop), cost = CONFIG32.costUsd;
  return {
    signal_id: stableUuid(`sig:${key}`), setup_id: stableUuid(`setup:${STRATEGY_VERSION_32}:${c.anchor}`), strategy: "GENX_3_0", strategy_version: STRATEGY_VERSION_32,
    symbol_canonical: "XAUUSD", broker_symbol: XAUUSD.brokerSymbol, side: c.side, setup_type: c.setup as never, regime: res.state!.state as never,
    created_at_utc: new Date(asOf).toISOString(), expires_at_utc: new Date(asOf + 3 * 60_000).toISOString(), market_snapshot_id: stableUuid(`snap32:${asOf}`), decision_candle_close_time: new Date(asOf).toISOString(),
    entry_type: "LIMIT", entry_price: c.entry, entry_zone_low: c.entry, entry_zone_high: c.entry, stop_price: c.stop, target_price: c.target,
    target_price_distance: dT.priceUsd, target_ticks: dT.ticks, target_points: dT.points, target_display_pips: dT.displayPips,
    risk_price_distance: dR.priceUsd, gross_reward_risk: +(dT.priceUsd / dR.priceUsd).toFixed(3), estimated_net_reward_risk: +((dT.priceUsd - cost) / (dR.priceUsd + cost)).toFixed(3),
    confidence: sel.score ?? 0, score_components: { total: sel.score ?? 0, threshold: sel.threshold ?? 0, components: Object.entries(sel.components).map(([k, points]) => ({ key: k, points, max: 0, evidence: "" })), penalties: [], version: STRATEGY_VERSION_32 },
    evidence: c.evidence, contradictions: [], invalidation_conditions: [`price trades ${d > 0 ? "below" : "above"} ${c.invalidation.toFixed(2)} (structure)`, `structural room ${c.roomR}R`],
    spread_at_decision: null, spread_is_estimate: true, feed_latency_ms: feedAgeMs, data_quality: "HEALTHY", news_state: "CLEAR",
    idempotency_key: key, correlation_id: stableUuid(`corr:${key}`), instrument_spec_version: XAUUSD.specVersion,
  };
}

export function validateSignal32(s: Genx3Signal): string[] {
  const e: string[] = [];
  for (const k of ["entry_price", "entry_zone_low", "entry_zone_high", "stop_price", "target_price", "risk_price_distance", "target_price_distance", "confidence"] as const) if (!Number.isFinite(s[k] as number) || (s[k] as number) < 0) e.push(`${k} not finite`);
  if (s.strategy_version !== STRATEGY_VERSION_32) e.push("version mismatch");
  if (s.side !== "BUY" && s.side !== "SELL") e.push("side invalid");
  if (!/^[0-9a-f]{64}$/.test(s.idempotency_key)) e.push("idempotency_key invalid");
  const up = s.side === "BUY";
  if (up ? !(s.stop_price < s.entry_zone_low && s.target_price > s.entry_zone_high) : !(s.stop_price > s.entry_zone_high && s.target_price < s.entry_zone_low)) e.push("stop/target on the wrong side of the zone");
  if (!(s.risk_price_distance >= CONFIG32.minRiskUsd && s.risk_price_distance <= CONFIG32.maxRiskUsd)) e.push(`risk ${s.risk_price_distance} outside ${CONFIG32.minRiskUsd}..${CONFIG32.maxRiskUsd} (corrupt-data bound)`);
  if (Math.abs(s.risk_price_distance - Math.abs(s.entry_price - s.stop_price)) > 0.02) e.push("risk calculation inconsistent with entry/stop");
  if (!(s.entry_price > 500 && s.entry_price < 20000)) e.push("entry price outside plausible XAUUSD range");
  if (!s.evidence.length) e.push("no evidence");
  return e;
}

const TRACK = new Set(["PASSED", "SELECTED", "LOST_ARBITRATION", "SHADOW_ONLY", "FAILED", "NOT_ROUTED"]);

async function resolveShadow(admin: Admin) {
  const { data } = await admin.from("genx3_candidates").select("id, at, side, entry, stop, target").eq("strategy_version", STRATEGY_VERSION_32).eq("shadow_status", "OPEN").lt("at", new Date(Date.now() - 2 * 60_000).toISOString()).order("at", { ascending: true }).limit(100);
  const rows = (data ?? []) as { id: string; at: string; side: "BUY" | "SELL"; entry: number; stop: number; target: number }[];
  if (!rows.length) return;
  const arr = [...bars.values()].sort((a, b) => a.t - b.t);
  const idx = (t: number) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].t < t) lo = m + 1; else hi = m; } return lo; };
  for (const r of rows) {
    const t = Date.parse(r.at); const start = idx(Math.floor(t / 60000) * 60000 + 60000);
    const sim = simulate(arr, { side: r.side, startIdx: start, entry: +r.entry, zoneLow: +r.entry, zoneHigh: +r.entry, stop: +r.stop, target: +r.target, ttlMs: 3 * 60_000, maxHoldMs: 24 * 3_600_000, chaseUsd: 1, costUsd: CONFIG32.costUsd });
    const risk = Math.abs(+r.entry - +r.stop) || 1;
    if (!sim.filled) {
      if (Date.now() - t > 10 * 60_000) await admin.from("genx3_candidates").update({ shadow_status: "NOT_FILLED", shadow_result: sim.missReason, resolved_at: new Date().toISOString() }).eq("id", r.id);
      continue;
    }
    if (sim.open) continue;                                                                          // still open in the simulation
    await admin.from("genx3_candidates").update({ shadow_status: "RESOLVED", shadow_fill: sim.fill, shadow_fill_at: new Date(sim.fillAt!).toISOString(), shadow_exit: sim.exit, shadow_exit_at: new Date(sim.exitAt!).toISOString(), shadow_result: sim.result, shadow_r: +(sim.pnl! / risk).toFixed(3), shadow_mfe_r: +(sim.mfe! / risk).toFixed(2), shadow_mae_r: +(sim.mae! / risk).toFixed(2), resolved_at: new Date().toISOString() }).eq("id", r.id);
  }
}

async function resolveFills(admin: Admin) {
  const { data } = await admin.from("genx3_executions").select("id, position_id, requested_entry, signal_stop, account_id").is("fill_price", null).eq("ok", true).not("position_id", "is", null).gte("created_at", new Date(Date.now() - 2 * 86_400_000).toISOString()).limit(50);
  for (const r of (data ?? []) as { id: string; position_id: string; requested_entry: number; signal_stop: number; account_id: string }[]) {
    const { data: p } = await admin.from("flow_managed_positions").select("entry, created_at, side, qty").eq("position_id", r.position_id).eq("account_id", r.account_id).maybeSingle();
    const pos = p as { entry: number | null; created_at: string; side: string; qty: number | null } | null;
    if (!pos || pos.entry == null) continue;
    const dir = pos.side === "buy" || pos.side === "BUY" ? 1 : -1;
    await admin.from("genx3_executions").update({ fill_price: pos.entry, fill_at: pos.created_at, slippage: +(dir * (+pos.entry - +r.requested_entry)).toFixed(3), filled_qty: pos.qty }).eq("id", r.id);
  }
}

export type Tick32 = { ran: boolean; reason?: string; signal?: string | null; state?: string; reasons?: string[]; latencyMs?: number };
export async function genx32Tick(admin: Admin, holder: string): Promise<Tick32> {
  const ctl = await readControl(admin);
  if (!ctl) return { ran: false, reason: "no_control_row" };
  if (ctl.mode === "OFF" || ctl.mode === "EMERGENCY_DISABLED") return { ran: false, reason: `mode_${ctl.mode}` };
  if (selectBrain(ctl.strategy_version) !== STRATEGY_VERSION_32) return { ran: false, reason: "not_selected_version" };
  if (ctl.mode === "LIVE" && ctl.live_scope === "designated" && !(ctl.designated_account_ids ?? []).length) { await emergencyDisable(admin, "GENX 3.2 LIVE without an account whitelist"); return { ran: false, reason: "no_account_whitelist" }; }
  const now = Date.now();
  if (now - archiveLoadedAt > 30 * 60_000) { await loadArchive(admin, now - 35 * 86_400_000); archiveLoadedAt = now; }
  if (!seenLoaded) {
    const { data } = await admin.from("genx3_candidates").select("anchor").eq("strategy_version", STRATEGY_VERSION_32).neq("status", "WAITED").gte("at", new Date(now - 3 * 86_400_000).toISOString()).limit(20000);
    for (const r of (data ?? []) as { anchor: string }[]) st.seen.add(r.anchor);
    seenLoaded = true;
  }
  const minute = Math.floor(now / 60_000), sec = (now % 60_000) / 1000, asOf = minute * 60_000, lastBarT = asOf - 60_000;
  if ((minute !== lastFetchMinute && sec >= 2) || (!bars.has(lastBarT) && sec >= 2 && sec <= 40 && now - lastFetchAt >= 5_000)) {
    lastFetchAt = now;
    try { await fetchRecent(); lastFetchMinute = minute; } catch (e) { await incident(admin, "provider_fetch_failed", "warn", { error: String(e).slice(0, 200) }); }
  }
  if (minute === lastStepMinute) return { ran: false, reason: "done_this_minute" };
  let source: "rest" | "ticks" = "rest";
  if (!bars.has(lastBarT)) {
    // SPEED: the provider publishes the 1m bar ~10–25s late. The worker's own price stream already
    // holds every tick of that minute — use it when coverage is complete (documented semantics).
    const tb = sec >= 1 ? tickBar("XAU/USD", lastBarT, asOf) : null;
    if (tb) { bars.set(lastBarT, { t: lastBarT, o: tb.o, h: tb.h, l: tb.l, c: tb.c }); barSource.set(lastBarT, "ticks"); source = "ticks"; }
    else { lastTickCoverage = tickCoverage("XAU/USD", lastBarT, asOf); if (sec < 40) return { ran: false, reason: "awaiting_final_1m_bar" }; }
  }
  lastStepMinute = minute;
  const t0 = Date.now();

  const closed = tradableOnly(normalize1m([...bars.values()], asOf).closed);
  const lt = liveTick("XAU/USD", 20_000);
  const health = checkHealth({ closed1m: closed, asOf, maxFeedAgeMs: 150_000, maxGapBars: 3, spikeAtrMultiple: 4, duplicates: 0, outOfOrder: 0, invalid: 0, liveTick: lt, feedDisagreeUsd: 5 });
  const series = buildSeries(closed);
  const news = await newsState(now);
  const res = step32(series, asOf, st);
  const reasons = [...res.reasons];
  let sel = res.selected;
  if (sel && health.state === "INVALID") { reasons.push(`data_invalid: ${health.issues.join(",")}`); sel.status = "FAILED"; sel.reasons.push("data invalid"); sel = null; }
  if (sel && news.state !== "CLEAR") { reasons.push(`news_${news.state}`); sel.status = "FAILED"; sel.reasons.push(`news ${news.state}`); sel = null; }
  if (sel && lt != null && Math.abs(lt - sel.cand!.entry) > 3) { impossiblePrice++; reasons.push("impossible_or_stale_price"); sel.status = "FAILED"; sel.reasons.push(`live price ${lt} vs entry ${sel.cand!.entry}`); await incident(admin, "stale_or_impossible_price", "warn", { live: lt, entry: sel.cand!.entry }); if (impossiblePrice >= 3) await emergencyDisable(admin, "repeated impossible/stale price at signal time"); sel = null; }
  else if (sel) impossiblePrice = 0;
  const latencyMs = Date.now() - asOf;

  if (res.ctx && res.state) {
    const live = res.records.filter((r) => r.status !== "WAITED");
    const { error } = await admin.from("genx3_decisions").insert({
      strategy_version: STRATEGY_VERSION_32, snapshot_id: stableUuid(`snap32:${asOf}`), as_of: new Date(now).toISOString(), decision_candle_close: new Date(asOf).toISOString(), mode: ctl.mode,
      data_state: health.state, data_issues: health.issues, feed_age_ms: health.feedAgeMs, news_state: news.state, regime: res.state.state, regime_confidence: res.state.confidence,
      regime_detail: { dir: res.state.dir, atrPct: +res.state.atrPct.toFixed(2), rvRatio: +res.state.rvRatio.toFixed(2), er15: +res.state.er15.toFixed(2), er1h: +res.state.er1h.toFixed(2), trend15: res.state.trend15, trend1h: res.state.trend1h, bias1h: res.ctx.bias1h, bias4h: res.ctx.bias4h, mom20d: res.ctx.mom20d, vol: res.ctx.volState, session: res.ctx.session, atr5: +res.ctx.atr5.toFixed(2), atr15: +res.ctx.atr15.toFixed(2), evidence: res.state.evidence, bar_source: source, tick_coverage: source === "ticks" ? null : lastTickCoverage, decision_latency_ms: latencyMs, compute_ms: Date.now() - t0, waiting: res.records.filter((r) => r.status === "WAITED").map((r) => `${r.setup} ${r.side}: ${r.reasons[0]}`).slice(0, 12) },
      candidates: live.map((r) => ({ setup: r.setup, side: r.side, status: r.status, score: r.score, threshold: r.threshold, reasons: r.reasons })),
      no_trade_reasons: sel ? [] : reasons, signal_id: null, worker: holder,
    });
    if (error && /duplicate|unique/i.test(error.message)) return { ran: false, reason: "decided_by_other" };
    // candidate + shadow log (waits once per anchor+reason)
    const rows = [];
    for (const r of res.records) {
      if (r.status === "WAITED") { const k = `${r.anchor}|${r.reasons[0]}`; if (loggedWaits.get(r.anchor) === k) continue; loggedWaits.set(r.anchor, k); if (loggedWaits.size > 5000) loggedWaits.clear(); }
      const c = r.cand;
      rows.push({ strategy_version: STRATEGY_VERSION_32, at: new Date(asOf).toISOString(), setup: r.setup, side: r.side, anchor: r.anchor, status: r.status, reasons: r.reasons, score: r.score, threshold: r.threshold, components: r.components,
        engine_mode: CONFIG32.rules[r.setup].mode, market_state: res.state.state, htf: { bias1h: res.ctx.bias1h, bias4h: res.ctx.bias4h, mom20d: res.ctx.mom20d, trend1h: res.state.trend1h, trend15: res.state.trend15 },
        entry: c?.entry ?? null, stop: c?.stop ?? null, target: c?.target ?? null, risk: c?.risk ?? null, target_r: c?.targetR ?? null, room_r: c?.roomR ?? null, evidence: c?.evidence ?? [],
        shadow_status: c && TRACK.has(r.status) ? "OPEN" : "NA" });
    }
    if (rows.length) { const { error: ce } = await admin.from("genx3_candidates").insert(rows); if (ce) await incident(admin, "candidate_log_failed", "warn", { error: ce.message.slice(0, 200) }); }
  }
  try { await resolveShadow(admin); await resolveFills(admin); } catch { /* best-effort */ }

  if (!sel || !sel.cand || !res.state) return { ran: true, signal: null, state: res.state?.state, reasons, latencyMs };
  if (Date.now() - asOf > 45_000) { await incident(admin, "signal_too_late", "warn", { latencyMs: Date.now() - asOf }); return { ran: true, signal: null, reasons: ["stale_signal_not_published"], latencyMs }; }
  const sig = buildSignal32(sel, res, health.feedAgeMs);
  const errs = validateSignal32(sig);
  if (errs.length) { await emergencyDisable(admin, `malformed GENX 3.2 signal: ${errs.join("; ")}`, { anchor: sel.anchor }); return { ran: true, signal: null, reasons: errs }; }
  const live = ctl.mode === "LIVE";
  // setup row first (genx3_signals.setup_id references genx3_setups; DB guards the state machine)
  const { error: se } = await admin.from("genx3_setups").insert({ setup_id: sig.setup_id, strategy_version: STRATEGY_VERSION_32, setup_key: sel.anchor, setup_type: sel.setup, side: sig.side, state: "TRIGGERED", snapshot_id: sig.market_snapshot_id, expires_at: sig.expires_at_utc, detail: { score: sel.score, threshold: sel.threshold, market_state: res.state.state, evidence: sig.evidence, transition_reason: "selected by arbitration" } });
  if (se) return { ran: true, signal: null, reasons: [/duplicate|unique/i.test(se.message) ? "setup_already_recorded" : `setup_write_failed: ${se.message}`] };
  const { error } = await admin.from("genx3_signals").insert({ signal_id: sig.signal_id, idempotency_key: sig.idempotency_key, setup_id: sig.setup_id, strategy_version: STRATEGY_VERSION_32, decision_candle_close: sig.decision_candle_close_time, side: sig.side, entry_zone_low: sig.entry_zone_low, entry_zone_high: sig.entry_zone_high, stop_price: sig.stop_price, target_price: sig.target_price, payload: { ...sig, market_state: res.state.state, bar_source: source, decision_latency_ms: latencyMs }, mode: live ? "LIVE" : "MONITOR", status: live ? "PUBLISHED" : "NOT_DELIVERED_MONITOR", expires_at: sig.expires_at_utc });
  if (error) return { ran: true, signal: null, reasons: [/duplicate|unique/i.test(error.message) ? "signal_already_published" : `signal_write_failed: ${error.message}`] };
  await admin.from("genx3_decisions").update({ signal_id: sig.signal_id }).eq("strategy_version", STRATEGY_VERSION_32).eq("decision_candle_close", new Date(asOf).toISOString());
  await admin.from("genx3_candidates").update({ signal_id: sig.signal_id }).eq("strategy_version", STRATEGY_VERSION_32).eq("anchor", sel.anchor).eq("status", "SELECTED");
  if (live) {
    if (process.env.TELEGRAM_ADMIN_CHAT_ID) { try { await sendTelegram(`🧠 <b>GENX 3.2 — ${sig.side} XAUUSD · ${esc(String(sig.setup_type))}</b>\nState ${esc(res.state.state)} · score ${sig.confidence}\nEntry ${sig.entry_price.toFixed(2)} · SL ${sig.stop_price.toFixed(2)} · TP ${sig.target_price.toFixed(2)}`, { chatId: process.env.TELEGRAM_ADMIN_CHAT_ID }); } catch { /* best-effort */ } }
    await deliver(admin, sig, ctl, { signalId: sig.signal_id, strategyVersion: STRATEGY_VERSION_32, setup: sel.setup, marketState: res.state.state, signalAt: new Date(asOf).toISOString(), signalPrice: series.m1.bars[lastClosed(series.m1, asOf)].c, requestedEntry: sig.entry_price, stop: sig.stop_price, target: sig.target_price });
  }
  return { ran: true, signal: sig.signal_id, state: res.state.state, reasons: [], latencyMs };
}
