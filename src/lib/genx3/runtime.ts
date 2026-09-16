import { createAdminClient } from "@/lib/supabase/admin";
import { liveTick } from "@/lib/flow/liveTicks";
import { placeGenxGold, placeGenxFollower } from "@/lib/flow/autoExec";
import { sendTelegram, esc } from "@/lib/telegram";
import { analyze, type Decision } from "./engine";
import type { Bar } from "./candles";
import { CONFIG, STRATEGY_VERSION, validateConfig } from "./config";
import { newsState } from "./news";
import { stableUuid, validateSignal, type Genx3Signal } from "./signal";
import { TERMINAL, type SetupState } from "./stateMachine";
import { genx3Active } from "./engineSelect";

type Admin = NonNullable<ReturnType<typeof createAdminClient>>;
/** Who a LIVE signal may reach. "designated" = only the listed users (none listed = blocked);
 *  "authorized" = every account Flow already has opted in (Flow's own gates still apply). */
export function deliveryScope(ctl: Pick<Control, "live_scope" | "designated_user_ids">): { onlyUserIds: string[] | null; blocked: boolean } {
  if (ctl.live_scope === "authorized") return { onlyUserIds: null, blocked: false };
  const ids = (ctl.designated_user_ids ?? []).filter((x) => /^[0-9a-f-]{36}$/i.test(x));
  return { onlyUserIds: ids, blocked: ids.length === 0 };
}
export type Control = { mode: "OFF" | "MONITOR" | "LIVE" | "EMERGENCY_DISABLED"; live_scope: "designated" | "authorized"; designated_user_ids: string[]; strategy_version: string };

const bars = new Map<number, Bar>();
let archiveLoadedAt = 0;
let lastFetchAt = 0;
let lastFetchMinute = 0;

async function loadArchive(admin: Admin, sinceMs: number): Promise<void> {
  for (let page = 0; page < 20; page++) {
    const { data, error } = await admin.from("genx_candle_archive").select("t,o,h,l,c").eq("symbol", "XAU/USD").eq("interval", "1min")
      .gte("t", new Date(sinceMs).toISOString()).order("t", { ascending: true }).range(page * 1000, page * 1000 + 999);
    if (error) throw new Error(`archive_read: ${error.message}`);
    const rows = (data ?? []) as { t: string; o: number; h: number; l: number; c: number }[];
    for (const r of rows) { const t = Date.parse(r.t); bars.set(t, { t, o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c) }); }
    if (rows.length < 1000) break;
  }
}

/** Latest 1m bars straight from the provider in UTC (includes the forming bar; analyze() separates it). */
async function fetchRecent(): Promise<number> {
  const key = process.env.TWELVEDATA_API_KEY;
  if (!key) throw new Error("no TWELVEDATA_API_KEY");
  const r = await fetch(`https://api.twelvedata.com/time_series?symbol=XAU%2FUSD&interval=1min&outputsize=90&timezone=UTC&order=ASC&apikey=${key}`, { cache: "no-store" });
  const j = (await r.json()) as { status?: string; values?: { datetime: string; open: string; high: string; low: string; close: string }[]; message?: string };
  if (j.status === "error" || !Array.isArray(j.values)) throw new Error(`td: ${String(j.message ?? "").slice(0, 80)}`);
  for (const v of j.values) {
    const t = Date.parse(`${v.datetime.replace(" ", "T")}Z`);
    if (Number.isFinite(t)) bars.set(t, { t, o: Number(v.open), h: Number(v.high), l: Number(v.low), c: Number(v.close) });
  }
  // keep ~7 days in memory
  const cutoff = Date.now() - 7 * 86_400_000;
  for (const t of bars.keys()) if (t < cutoff) bars.delete(t);
  return j.values.length;
}

export async function readControl(admin: Admin): Promise<Control | null> {
  const { data } = await admin.from("genx3_control").select("mode, live_scope, designated_user_ids, strategy_version").eq("id", 1).maybeSingle();
  return (data as Control | null) ?? null;
}

async function incident(admin: Admin, kind: string, severity: "info" | "warn" | "critical", detail: Record<string, unknown>) {
  try { await admin.from("genx3_incidents").insert({ kind, severity, detail }); } catch { /* best-effort */ }
}

/** Automatic technical rollback: stop new GENX 3.0 signals immediately. */
export async function emergencyDisable(admin: Admin, reason: string, detail: Record<string, unknown> = {}): Promise<void> {
  await admin.from("genx3_control").update({ mode: "EMERGENCY_DISABLED", note: reason.slice(0, 200), updated_by: "genx3-auto-rollback" }).eq("id", 1);
  await incident(admin, "auto_rollback", "critical", { reason, ...detail });
  try { await sendTelegram(`🛑 <b>GENX 3.0 disabled automatically</b>\n${esc(reason)}`, { chatId: process.env.TELEGRAM_ADMIN_CHAT_ID || undefined }); } catch { /* best-effort */ }
}

const STAGE_TO_STATE: Record<string, SetupState> = { WATCHING: "WATCHING", APPROACHING: "APPROACHING", ARMED: "ARMED", TRIGGERED: "TRIGGERED" };
const ORDER: Record<string, number> = { WAIT: 0, WATCHING: 1, APPROACHING: 2, ARMED: 3, TRIGGERED: 4, PUBLISHED: 5 };

async function upsertSetups(admin: Admin, d: Decision): Promise<void> {
  const ttl = CONFIG.trade.setupTtlMin * 60_000;
  for (const c of d.candidates) {
    const state = STAGE_TO_STATE[c.stage]; if (!state) continue;
    const setupId = stableUuid(`setup:${STRATEGY_VERSION}:${c.setupKey}`);
    const detail = { entry: c.entry, zone: [c.zoneLow, c.zoneHigh], stop: c.stop, target: c.target, invalidation: c.invalidation, reject: c.rejectReason, evidence: c.evidence, score: c.score?.total ?? null, transition_reason: c.rejectReason ?? c.stage };
    const { data: existing } = await admin.from("genx3_setups").select("state").eq("setup_id", setupId).maybeSingle();
    if (!existing) {
      await admin.from("genx3_setups").insert({ setup_id: setupId, strategy_version: STRATEGY_VERSION, setup_key: c.setupKey, setup_type: c.setupType, side: c.side, state: c.stage === "TRIGGERED" && c.rejectReason ? "ARMED" : state, snapshot_id: d.snapshotId, expires_at: new Date(d.asOf + ttl).toISOString(), detail });
      continue;
    }
    const cur = (existing as { state: SetupState }).state;
    const target = c.stage === "TRIGGERED" && c.rejectReason ? "ARMED" : state;
    if (TERMINAL.has(cur) || (ORDER[target] ?? 0) <= (ORDER[cur] ?? 0)) continue;
    await admin.from("genx3_setups").update({ state: target, snapshot_id: d.snapshotId, detail }).eq("setup_id", setupId).eq("state", cur);
  }
  // Expire and invalidate open setups.
  const lastClose = d.health.newestClosed1m != null ? bars.get(d.health.newestClosed1m)?.c ?? null : null;
  const { data: open } = await admin.from("genx3_setups").select("setup_id, side, state, expires_at, detail").eq("strategy_version", STRATEGY_VERSION).not("state", "in", "(PUBLISHED,EXPIRED,INVALIDATED,REJECTED_BY_FLOW)").limit(200);
  for (const s of (open ?? []) as { setup_id: string; side: string; state: SetupState; expires_at: string; detail: { invalidation?: number } }[]) {
    const inv = s.detail?.invalidation;
    if (lastClose != null && typeof inv === "number" && (s.side === "BUY" ? lastClose < inv : lastClose > inv)) {
      await admin.from("genx3_setups").update({ state: "INVALIDATED", detail: { ...s.detail, transition_reason: `1m close ${lastClose} beyond invalidation ${inv}` } }).eq("setup_id", s.setup_id).eq("state", s.state);
    } else if (Date.parse(s.expires_at) <= d.asOf) {
      await admin.from("genx3_setups").update({ state: "EXPIRED", detail: { ...s.detail, transition_reason: "ttl" } }).eq("setup_id", s.setup_id).eq("state", s.state);
    }
  }
}

function signalMessage(s: Genx3Signal): string {
  const dir = s.side === "BUY" ? "BUY" : "SELL";
  return [
    `🧠 <b>GENX 3.0 — ${dir} XAUUSD · ${esc(s.setup_type.replace(/_/g, " "))}</b>`,
    `Regime: ${esc(s.regime.replace(/_/g, " "))} · Score ${s.confidence}/100`,
    `Entry ${s.entry_zone_low.toFixed(2)}–${s.entry_zone_high.toFixed(2)} · Stop ${s.stop_price.toFixed(2)} · Target ${s.target_price.toFixed(2)}`,
    `Move $${s.target_price_distance.toFixed(2)} vs risk $${s.risk_price_distance.toFixed(2)} (R:R ${s.gross_reward_risk.toFixed(2)})`,
    ...s.evidence.slice(0, 3).map((e) => `• ${esc(e)}`),
    `Cancels if: ${esc(s.invalidation_conditions[0] ?? "structure breaks")}`,
    `<i>Educational, not financial advice.</i>`,
  ].join("\n");
}

async function deliver(admin: Admin, s: Genx3Signal, ctl: Control): Promise<void> {
  const { data: claimed } = await admin.rpc("genx3_claim_delivery", { p_signal_id: s.signal_id });
  if (claimed !== true) return; // someone else delivered it, or it expired
  const tag = `genx3:${s.signal_id.slice(0, 8)}`;
  const startedAt = new Date().toISOString();
  const scope = deliveryScope(ctl);
  const onlyUserIds = scope.onlyUserIds;
  if (scope.blocked) {
    await admin.from("genx3_signals").update({ status: "BLOCKED", delivery_finished_at: new Date().toISOString(), delivery_summary: { reason: "designated scope has no users" } }).eq("signal_id", s.signal_id);
    return;
  }
  const side = s.side === "BUY" ? "buy" : "sell";
  const common = { side, entryLow: s.entry_zone_low, entryHigh: s.entry_zone_high, stop: s.stop_price, tp: s.target_price, conservativeOk: true, confidence: s.confidence, origin: "genx3" as const, onlyUserIds, tag };
  let copy = { members: 0, placed: 0 }, follow = { accounts: 0, placed: 0 };
  let err: string | null = null;
  try { copy = await placeGenxGold(common as Parameters<typeof placeGenxGold>[0]); } catch (e) { err = `copy: ${String(e).slice(0, 120)}`; }
  try { follow = await placeGenxFollower({ ...(common as object), signalKey: `genx3:${s.signal_id}` } as Parameters<typeof placeGenxFollower>[0]); } catch (e) { err = `${err ?? ""} follower: ${String(e).slice(0, 120)}`; }
  // Per-account outcomes from Flow's own event log (reason starts with the tag).
  const { data: ev } = await admin.from("flow_auto_events").select("user_id, account_id, status, reason, order_id, qty").gte("created_at", startedAt).like("reason", `${tag}%`).limit(2000);
  const rows = (ev ?? []) as { user_id: string; account_id: string | null; status: string; reason: string | null; order_id: string | null; qty: number | null }[];
  const perAcct = new Map<string, number>();
  for (const r of rows) {
    if (!r.account_id) continue;
    if (r.status === "placed") perAcct.set(r.account_id, (perAcct.get(r.account_id) ?? 0) + 1);
    const status = ["placed", "error", "deferred", "uncertain"].includes(r.status) ? r.status : "skipped";
    await admin.from("genx3_deliveries").upsert({ signal_id: s.signal_id, account_id: r.account_id, user_id: r.user_id, path: (r.reason ?? "").startsWith(`${tag}f`) ? "follower" : "copy", status, reason: r.reason, order_id: r.order_id, qty: r.qty }, { onConflict: "signal_id,account_id", ignoreDuplicates: false });
  }
  const placed = [...perAcct.values()].reduce((a, b) => a + Math.min(b, 1), 0);
  const dupAccounts = [...perAcct.entries()].filter(([, n]) => n > 1).map(([a]) => a);
  const errors = rows.filter((r) => r.status === "error" || r.status === "uncertain").length;
  const status = placed > 0 && errors === 0 ? "DELIVERED" : placed > 0 ? "PARTIAL" : copy.members + follow.accounts === 0 ? "BLOCKED" : "FAILED";
  await admin.from("genx3_signals").update({ status, delivery_finished_at: new Date().toISOString(), delivery_summary: { copy, follow, placedAccounts: placed, errorEvents: errors, error: err } }).eq("signal_id", s.signal_id);
  if (status === "BLOCKED") await admin.from("genx3_setups").update({ state: "REJECTED_BY_FLOW", detail: { transition_reason: "Flow gates held every account" } }).eq("setup_id", s.setup_id).eq("state", "PUBLISHED");
  if (dupAccounts.length) await emergencyDisable(admin, "duplicate live orders for one signal", { signal_id: s.signal_id, accounts: dupAccounts });
  if (onlyUserIds) {
    const stray = rows.filter((r) => r.status === "placed" && !onlyUserIds.includes(r.user_id));
    if (stray.length) await emergencyDisable(admin, "signal reached an account outside the live scope", { signal_id: s.signal_id, users: stray.map((r) => r.user_id) });
  }
}

export type TickResult = { ran: boolean; reason?: string; decisionClose?: string; signal?: string | null; noTrade?: string[] };

/** One engine pass. Safe to call every few seconds; does work once per closed 5m candle. */
export async function genx3Tick(admin: Admin, holder: string): Promise<TickResult> {
  validateConfig();
  if (!genx3Active()) return { ran: false, reason: "engine_not_selected" };
  const ctl = await readControl(admin);
  if (!ctl) return { ran: false, reason: "no_control_row" };
  if (ctl.mode === "OFF" || ctl.mode === "EMERGENCY_DISABLED") return { ran: false, reason: `mode_${ctl.mode}` };
  if (ctl.strategy_version !== STRATEGY_VERSION) { await emergencyDisable(admin, `strategy version mismatch: control ${ctl.strategy_version} vs worker ${STRATEGY_VERSION}`); return { ran: false, reason: "version_mismatch" }; }
  const now = Date.now();
  if (now - archiveLoadedAt > 30 * 60_000) { await loadArchive(admin, now - 7 * 86_400_000); archiveLoadedAt = now; }
  const minute = Math.floor(now / 60_000);
  const secIntoMinute = (now % 60_000) / 1000;
  const decisionClose = Math.floor(now / 300_000) * 300_000;
  const lastMinuteOfCandle = decisionClose - 60_000;
  // The provider publishes a 1m bar a few seconds after it closes. Inside the decision window,
  // re-fetch every ~10s until the candle's final minute is present, so the 5m bar is complete.
  const inWindow = now - decisionClose <= 90_000;
  const needFinalBar = inWindow && !bars.has(lastMinuteOfCandle);
  if ((minute !== lastFetchMinute && secIntoMinute >= 3) || (needFinalBar && now - lastFetchAt >= 10_000 && secIntoMinute >= 3)) {
    lastFetchAt = now;
    try { await fetchRecent(); lastFetchMinute = minute; } catch (e) { await incident(admin, "provider_fetch_failed", "warn", { error: String(e).slice(0, 200) }); }
  }
  if (!inWindow) return { ran: false, reason: "between_decision_candles" };   // only decide in the first 90s after a 5m close
  if (lastFetchMinute * 60_000 < decisionClose) return { ran: false, reason: "awaiting_fresh_bars" };
  if (!bars.has(lastMinuteOfCandle)) {
    if (now - decisionClose < 80_000) return { ran: false, reason: "awaiting_final_1m_bar" };
    // still missing near the end of the window: decide anyway; the health check records the gap/staleness and fails closed
  }
  const { data: already } = await admin.from("genx3_decisions").select("id").eq("strategy_version", STRATEGY_VERSION).eq("decision_candle_close", new Date(decisionClose).toISOString()).maybeSingle();
  if (already) return { ran: false, reason: "decided" };

  const news = await newsState(now);
  const d = analyze({ raw1m: [...bars.values()], asOf: now, liveTick: liveTick("XAU/USD", 20_000), news });
  if (d.decisionCandleClose !== decisionClose) d.noTradeReasons.push(`decision_candle_mismatch_${d.decisionCandleClose}`);
  const signal = d.decisionCandleClose === decisionClose ? d.signal : null;

  const { error: decErr } = await admin.from("genx3_decisions").insert({
    strategy_version: STRATEGY_VERSION, snapshot_id: d.snapshotId, as_of: new Date(now).toISOString(), decision_candle_close: new Date(decisionClose).toISOString(), mode: ctl.mode,
    data_state: d.health.state, data_issues: d.health.issues, feed_age_ms: d.health.feedAgeMs, news_state: news.state,
    regime: d.regime?.regime ?? null, regime_confidence: d.regime?.confidence ?? null,
    regime_detail: d.regime ? { bias1h: d.regime.bias1h, env4h: d.regime.env4h, supporting: d.regime.supporting, contradicting: d.regime.contradicting, invalidation: d.regime.invalidation, features: d.regime.features } : null,
    candidates: d.candidates.map((c) => ({ setupType: c.setupType, side: c.side, stage: c.stage, entry: c.entry, stop: c.stop, target: c.target, reject: c.rejectReason, score: c.score, evidence: c.evidence })),
    no_trade_reasons: signal ? [] : d.noTradeReasons, signal_id: signal?.signal_id ?? null, worker: holder,
  });
  if (decErr) return { ran: false, reason: /duplicate|unique/i.test(decErr.message) ? "decided_by_other" : `decision_write_failed: ${decErr.message}` };
  await upsertSetups(admin, d);

  if (signal) {
    const errs = validateSignal(signal);
    if (errs.length) { await incident(admin, "signal_schema_invalid", "critical", { errs }); return { ran: true, signal: null, noTrade: errs }; }
    if (Date.now() - decisionClose > 120_000) return { ran: true, signal: null, noTrade: ["stale_signal_not_published"] };
    const live = ctl.mode === "LIVE";
    const { error } = await admin.from("genx3_signals").insert({
      signal_id: signal.signal_id, idempotency_key: signal.idempotency_key, setup_id: signal.setup_id, strategy_version: STRATEGY_VERSION,
      decision_candle_close: signal.decision_candle_close_time, side: signal.side, entry_zone_low: signal.entry_zone_low, entry_zone_high: signal.entry_zone_high,
      stop_price: signal.stop_price, target_price: signal.target_price, payload: signal, mode: live ? "LIVE" : "MONITOR",
      status: live ? "PUBLISHED" : "NOT_DELIVERED_MONITOR", expires_at: signal.expires_at_utc,
    });
    if (error) return { ran: true, signal: null, noTrade: [/duplicate|unique/i.test(error.message) ? "signal_already_published" : `signal_write_failed: ${error.message}`] };
    await admin.from("genx3_setups").update({ state: "PUBLISHED", detail: { transition_reason: live ? "published LIVE" : "published MONITOR" } }).eq("setup_id", signal.setup_id).eq("state", "TRIGGERED");
    if (live) {
      try { await sendTelegram(signalMessage(signal)); } catch { /* best-effort */ }
      await deliver(admin, signal, ctl);
    }
  }
  return { ran: true, decisionClose: new Date(decisionClose).toISOString(), signal: signal?.signal_id ?? null, noTrade: signal ? [] : d.noTradeReasons };
}
