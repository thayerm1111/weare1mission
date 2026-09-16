/**
 * GENX 1.0 — PDH/PDL BREAK → RETEST → CONTINUATION module (owner 09-16: "revert back to GENX 1.0 …
 * add the enhanced GENX brain prompt for the PDH breakout retest continuation … if the setup is there
 * and the breakout has happened, I want the entries to happen").
 *
 * Runs in the always-on worker next to the GENX 1.0 scanner (lock id 4). Every closed minute while gold
 * is open it advances the PDH/PDL state machine (src/lib/genx3/v32/pdhpdl.ts — BREAK → ACCEPT → RETEST →
 * DEFEND → CONTINUE, sweep / weak-break / failed-retest / extension rejection, restart-safe state). When a
 * setup reaches ENTRY it is published exactly like a GENX 1.0 ENTER NOW: a genx_alerts row (unique
 * dedupe key = one alert per setup), the Telegram call for members who self-manage, and the SAME GENX 1.0
 * placement (placeGenxGold / placeGenxFollower) with every GENX 1.0 execution rule — one open gold trade
 * per account, duplicate protection, kill switch, news / change-of-character / chase guards, blackouts,
 * quality gate, stop cap and each account's own risk %.
 * Every state machine (transitions, evidence, why it was taken or rejected) is logged to genx3_pd_setups.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { liveTick, tickBar } from "@/lib/flow/liveTicks";
import { sendTelegram, esc } from "@/lib/telegram";
import { genxLabel } from "@/lib/genx/brand";
import { placeGenxGold, placeGenxFollower } from "@/lib/flow/autoExec";
import { genx2Active } from "@/lib/genx3/engineSelect";
import { checkHealth, normalize1m, type Bar } from "@/lib/genx3/candles";
import { buildSeries, tradableOnly, goldMarketOpen } from "@/lib/genx3/v31/series";
import { buildContext } from "@/lib/genx3/v31/context";
import { entryBlackout } from "@/lib/genx3/v31/engine";
import { pdhPdlBreakRetest, newPdState, anchorOf, type PdMachine } from "@/lib/genx3/v32/pdhpdl";
import { score } from "@/lib/genx3/v32/engine";
import { pdRow } from "@/lib/genx3/v32/runtime";
import type { Cand32 } from "@/lib/genx3/v32/engines";

type Admin = NonNullable<ReturnType<typeof createAdminClient>>;
export const PD_G1_VERSION = "genx1-pd-1.0";
const bars = new Map<number, Bar>();
const st = newPdState();
const persisted = new Map<string, string>();
let archiveAt = 0, lastFetchMinute = 0, lastStepMinute = 0;

async function loadArchive(admin: Admin, sinceMs: number) {
  for (let page = 0; page < 40; page++) {
    const { data, error } = await admin.from("genx_candle_archive").select("t,o,h,l,c").eq("symbol", "XAU/USD").eq("interval", "1min").gte("t", new Date(sinceMs).toISOString()).order("t", { ascending: true }).range(page * 1000, page * 1000 + 999);
    if (error) throw new Error(`archive_read: ${error.message}`);
    const rows = (data ?? []) as { t: string; o: number; h: number; l: number; c: number }[];
    for (const r of rows) { const t = Date.parse(r.t); if (!bars.has(t)) bars.set(t, { t, o: +r.o, h: +r.h, l: +r.l, c: +r.c }); }
    if (rows.length < 1000) break;
  }
}
async function fetchRecent() {
  const key = process.env.TWELVEDATA_API_KEY; if (!key) throw new Error("no TWELVEDATA_API_KEY");
  const r = await fetch(`https://api.twelvedata.com/time_series?symbol=XAU%2FUSD&interval=1min&outputsize=120&timezone=UTC&order=ASC&apikey=${key}`, { cache: "no-store" });
  const j = (await r.json()) as { status?: string; values?: { datetime: string; open: string; high: string; low: string; close: string }[]; message?: string };
  if (j.status === "error" || !Array.isArray(j.values)) throw new Error(`td: ${String(j.message ?? "").slice(0, 80)}`);
  for (const v of j.values) { const t = Date.parse(`${v.datetime.replace(" ", "T")}Z`); if (Number.isFinite(t)) bars.set(t, { t, o: +v.open, h: +v.high, l: +v.low, c: +v.close }); }
  const cutoff = Date.now() - 26 * 86_400_000; for (const t of bars.keys()) if (t < cutoff) bars.delete(t);
}

/** Minimal sanity for a PDH/PDL entry. No score threshold, no room requirement, no history-based pause:
 *  only a broken data feed, an unusable stop, an erratic tape or a blackout window stops the entry. */
export function pdEntryChecks(c: Cand32, o: { atr15: number; volExtreme: boolean; dataInvalid: boolean; blackout: boolean; latencyMs: number }): string[] {
  const why: string[] = [...c.hard];
  if (o.dataInvalid) why.push("market data invalid");
  if (o.blackout) why.push("entry blackout window (daily reopen / Friday last hour / Sunday first hour)");
  if (o.volExtreme) why.push("volatility EXTREME (falling-knife / spike protection)");
  if (!(c.risk >= Math.max(1.5, 0.35 * o.atr15))) why.push(`stop $${c.risk.toFixed(2)} inside noise`);
  if (!(c.risk <= Math.min(60, 3.5 * o.atr15))) why.push(`stop $${c.risk.toFixed(2)} not a sane structure for current volatility`);
  if (o.latencyMs > 45_000) why.push("decision too late — price may have moved");
  return why;
}

async function persist(admin: Admin, machines: PdMachine[], extra?: { anchor: string; status: string; reasons: string[]; cand: Cand32; confidence: number }) {
  for (const m of machines) {
    if (m.phase === "IDLE" && !m.transitions.length) continue;
    const isX = !!extra && extra.anchor === anchorOf(m);
    const k = `${m.version}|${isX ? extra!.status : ""}`;
    const key = `G1:${anchorOf(m)}`;
    if (!isX && persisted.get(key)?.startsWith(`${m.version}|`)) continue;
    if (persisted.get(key) === k) continue;
    const row: Record<string, unknown> = pdRow(m, isX ? { setup: "PDH_PDL_BREAK_RETEST_CONTINUATION", side: m.side, anchor: extra!.anchor, status: "PASSED", reasons: extra!.reasons, score: extra!.confidence, threshold: null, components: {}, cand: extra!.cand } : undefined, null);
    row.anchor = key; row.strategy_version = PD_G1_VERSION; row.engine_mode = "GENX1_LIVE";
    if (isX) row.candidate_status = extra!.status;
    else for (const f of ["stop", "target", "confidence", "candidate_status", "candidate_reasons"]) delete row[f];
    delete row.signal_id;
    const { error } = await admin.from("genx3_pd_setups").upsert(row, { onConflict: "anchor" });
    if (!error) persisted.set(key, k);
  }
  if (persisted.size > 2000) persisted.clear();
}

export type PdTickResult = { ran: boolean; reason?: string; fired?: string | null; reasons?: string[] };
export async function genx1PdTick(admin: Admin): Promise<PdTickResult> {
  if (!genx2Active()) return { ran: false, reason: "legacy_engine_off" };
  const now = Date.now(), minute = Math.floor(now / 60_000), sec = (now % 60_000) / 1000, asOf = minute * 60_000, lastBarT = asOf - 60_000;
  if (!goldMarketOpen(lastBarT)) return { ran: false, reason: "market_closed" };
  if (now - archiveAt > 30 * 60_000) { await loadArchive(admin, now - 25 * 86_400_000); archiveAt = now; }
  if (minute !== lastFetchMinute && sec >= 2) { try { await fetchRecent(); lastFetchMinute = minute; } catch { /* the streamed-tick bar below covers a late/failed REST pull */ } }
  if (minute === lastStepMinute) return { ran: false, reason: "done_this_minute" };
  if (!bars.has(lastBarT)) {
    const tb = sec >= 1 ? tickBar("XAU/USD", lastBarT, asOf) : null;
    if (tb) bars.set(lastBarT, { t: lastBarT, o: tb.o, h: tb.h, l: tb.l, c: tb.c });
    else if (sec < 40) return { ran: false, reason: "awaiting_final_1m_bar" };
  }
  lastStepMinute = minute;
  const closed = tradableOnly(normalize1m([...bars.values()], asOf).closed);
  const lt = liveTick("XAU/USD", 20_000);
  const health = checkHealth({ closed1m: closed, asOf, maxFeedAgeMs: 150_000, maxGapBars: 3, spikeAtrMultiple: 4, duplicates: 0, outOfOrder: 0, invalid: 0, liveTick: lt, feedDisagreeUsd: 5 });
  const series = buildSeries(closed);
  const ctx = buildContext(series, asOf);
  if (!ctx) return { ran: false, reason: "insufficient_history" };
  const out = pdhPdlBreakRetest(series, ctx, st);
  const c = out.cands[0];
  if (!c) { await persist(admin, out.machines).catch(() => {}); return { ran: true, fired: null }; }

  const conf = score(c).score;
  const why = pdEntryChecks(c, { atr15: ctx.atr15, volExtreme: ctx.volState === "EXTREME", dataInvalid: health.state === "INVALID", blackout: entryBlackout(asOf), latencyMs: Date.now() - asOf });
  if (lt != null && Math.abs(lt - c.entry) > 3) why.push(`live price ${lt} too far from entry ${c.entry}`);
  if (why.length) { await persist(admin, out.machines, { anchor: c.anchor, status: "REJECTED", reasons: why, cand: c, confidence: conf }).catch(() => {}); return { ran: true, fired: null, reasons: why }; }

  const side: "buy" | "sell" = c.side === "BUY" ? "buy" : "sell";
  const m = out.machines.find((x) => anchorOf(x) === c.anchor)!;
  const dedupeKey = `pd:${c.anchor}`;
  const entryLow = +(c.entry - 0.25).toFixed(2), entryHigh = +(c.entry + 0.25).toFixed(2);
  const nowIso = new Date().toISOString();
  // ONE ALERT PER SETUP — the unique dedupe key is the idempotency guard (restarts / overlapping workers).
  const { error } = await admin.from("genx_alerts").insert({
    dedupe_key: dedupeKey, mode: "quick", side, action: side === "buy" ? "BUY_NOW" : "SELL_NOW",
    entry: c.entry, entry_low: entryLow, entry_high: entryHigh, stop: c.stop, tp1: c.target, invalidation: c.invalidation, watch: m.px,
    confidence: conf, trigger_tf: "1min", state: "entered", enter_price: c.entry, heads_up_sent_at: nowIso, enter_sent_at: nowIso, last_checked_at: nowIso, quality_ok: true,
  });
  if (error) { await persist(admin, out.machines, { anchor: c.anchor, status: "DUPLICATE", reasons: [error.message.slice(0, 120)], cand: c, confidence: conf }).catch(() => {}); return { ran: true, fired: null, reasons: ["duplicate_alert"] }; }
  await persist(admin, out.machines, { anchor: c.anchor, status: "PUBLISHED", reasons: [], cand: c, confidence: conf }).catch(() => {});
  const dir = side === "buy" ? "BUY" : "SELL";
  try {
    await sendTelegram([
      `✅ <b>${genxLabel()} — ENTER NOW · ${dir} · ${m.level} Break → Retest</b>`,
      `Gold @ ~${c.entry.toFixed(2)}`,
      `Entry ${entryLow.toFixed(2)}–${entryHigh.toFixed(2)} · Stop ${c.stop.toFixed(2)}`,
      `TP1 ${c.target.toFixed(2)}`,
      esc(`${m.level === "PDH" ? "Previous-day high" : "Previous-day low"} ${m.px.toFixed(2)} broke, held, was retested and defended — continuation starting.`),
      `<i>Educational, not financial advice.</i>`,
    ].join("\n"));
  } catch { /* note best-effort */ }
  try { await placeGenxGold({ side, entryLow, entryHigh, stop: c.stop, tp: c.target, conservativeOk: true, confidence: conf, tag: "genx-pd" }); } catch { /* placement best-effort, same as GENX 1.0 */ }
  try { await placeGenxFollower({ signalKey: dedupeKey, side, entryLow, entryHigh, stop: c.stop, tp: c.target, conservativeOk: true, confidence: conf, tag: "genx-pd" }); } catch { /* best-effort */ }
  return { ran: true, fired: dedupeKey };
}
