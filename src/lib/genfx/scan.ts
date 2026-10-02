import { createAdminClient } from "@/lib/supabase/admin";
import { MODES, genxConservativeGate, type Mode } from "@/lib/genxCompute";
import { CONFIRM_IV } from "@/lib/genxConfirm";
import { series } from "@/lib/marketData";
import { sendTelegram } from "@/lib/telegram";
import { beat } from "@/lib/flow/health";
import { inWeekendCloseWindow, inScanQuietWindow } from "@/lib/flow/autoExec";
import { PAIRS, PAIR_KEYS, type FxPair, type PairKey } from "@/lib/genfx/pairs";
import { computeGenfxRead, genfxOf } from "@/lib/genfx/compute";
import { confirmFxEntry } from "@/lib/genfx/confirm";
import { decideFxEntry, sameSetupZone, scanKey, zoneKey, zoneOf, zoneAction, zoneBand, SAME_SETUP_WINDOW_MS } from "@/lib/genfx/decide";
import { readControl, type GenfxControl } from "@/lib/genfx/control";
import { headsUpMsg, enterMsg, invalidMsg, winMsg } from "@/lib/genfx/messages";
import { placeGenfx, armedAccounts } from "@/lib/genfx/place";
import { billFxSetup } from "@/lib/genfx/billing";

/**
 * GEN FX SCANNER — GENX's automated scanner (api/cron/genx-scan), for two pairs.
 *
 * Every five minutes it runs the same engine the GEN FX page runs, across both pairs and all three
 * horizons, and for each read:
 *   1. registers the setup the page is showing as a "zone" (entered on touch by the fast watch),
 *   2. records a brand-new scanner setup — ENTER NOW if the engine says trade-ready, otherwise a
 *      heads-up that then waits for a closed-candle confirmation,
 *   3. re-checks its own pending setups: enter, arm for a pullback, invalidate, or keep waiting,
 *   4. grades the calls it has already made against the candles that printed afterwards.
 *
 * State lives in public.genfx_alerts. A row is written BEFORE anything is announced or placed, under
 * a unique key, and every change of state is a conditional update that reports whether THIS process
 * won it — so the scan and the fast watch can overlap and a call is still announced once and placed
 * once.
 *
 * What is not here, because it is not GENX's core but gold-only strategies bolted beside it, each
 * tuned on gold history alone: the sideways-market range fade, the PDH/PDL break-and-retest, the
 * breakdown retest and the owner's hand-drawn levels.
 */
type Admin = NonNullable<ReturnType<typeof createAdminClient>>;

export type FxAlert = {
  id: string; pair: PairKey; dedupe_key: string; mode: Mode; side: "buy" | "sell"; action: string;
  entry: number | null; entry_low: number | null; entry_high: number | null;
  stop: number | null; tp1: number | null; tp2: number | null; tp3: number | null;
  invalidation: number | null; watch: number | null; confidence: number | null;
  trigger_tf: string | null; state: string; created_at: string;
  quality_ok: boolean | null; enter_sent_at: string | null; enter_price: number | null;
};

const MODES_ORDER: Mode[] = ["quick", "intraday", "swing"];
const tgEnv = () => !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHANNEL_ID);
const say = async (ctl: GenfxControl, html: string) => { if (ctl.telegram && tgEnv()) { try { await sendTelegram(html); } catch { /* a note never blocks a call */ } } };

/** An open scanner alert on this pair that is the same setup as this zone (the zone drifted; it is not new). */
export async function findSameSetup(admin: Admin, pair: FxPair, z: { side: "buy" | "sell"; entry_low: number | null; entry_high: number | null }, excludeId?: string): Promise<FxAlert | null> {
  const since = new Date(Date.now() - SAME_SETUP_WINDOW_MS).toISOString();
  const { data } = await admin.from("genfx_alerts").select("*").eq("pair", pair.key).eq("side", z.side).in("state", ["forming", "entered"]).is("outcome", null)
    .like("dedupe_key", `${pair.key}:quick:%`).gte("created_at", since).order("created_at", { ascending: true }).limit(50);
  for (const r of (data ?? []) as FxAlert[]) if (r.id !== excludeId && sameSetupZone(pair, r, z)) return r;
  return null;
}

/** Register the page setup this horizon is showing; a newer one on the same pair, horizon and side replaces the older. Never throws. */
export async function registerZone(admin: Admin, pair: FxPair, mode: Mode, g: { action?: unknown; entry?: unknown; stop_loss?: unknown; tp1?: unknown; tp2?: unknown; tp3?: unknown; confidence_score?: unknown; trigger_tf?: unknown }, price: number | null): Promise<string> {
  try {
    const z = zoneOf(g);
    if (!z) return "no_setup";
    if (price != null && zoneAction(pair, z.side, z.entry, z.stop, price) === "invalidate") return "beyond_stop";
    const nowMs = Date.now();
    const key = zoneKey(pair, mode, z.side, z.entry, nowMs);
    const nowIso = new Date(nowMs).toISOString();
    await admin.from("genfx_alerts").update({ state: "replaced", updated_at: nowIso })
      .eq("state", "zone").eq("pair", pair.key).eq("mode", mode).eq("side", z.side).neq("dedupe_key", key);
    const band = zoneBand(pair, z.entry);
    const conf = typeof g.confidence_score === "number" && Number.isFinite(g.confidence_score) ? g.confidence_score : null;
    const { error } = await admin.from("genfx_alerts").insert({
      pair: pair.key, dedupe_key: key, mode, side: z.side, action: String(g.action),
      entry: z.entry, entry_low: band.low, entry_high: band.high,
      stop: z.stop, tp1: z.tp1, tp2: z.tp2, tp3: z.tp3, invalidation: z.stop, watch: z.entry,
      confidence: conf, trigger_tf: g.trigger_tf != null ? String(g.trigger_tf) : null,
      state: "zone", last_checked_at: nowIso, quality_ok: true,
    });
    return error ? "already_registered" : "registered";
  } catch { return "error"; }
}

/** Members armed for this pair, in scope — the ones a forming setup is billed to when billing is on. */
async function armedUserIds(admin: Admin, pair: FxPair, ctl: GenfxControl): Promise<string[]> {
  return [...new Set((await armedAccounts(admin, pair, ctl)).map((a) => String(a.user_id)))];
}

/**
 * Act on a pending (forming) alert with a fresh confirmation read. Shared by the scan and the fast
 * watch. Returns what happened, or null when another process got there first.
 */
export async function stepForming(admin: Admin, ctl: GenfxControl, pair: FxPair, row: FxAlert, mdKey: string): Promise<string | null> {
  const nowIso = new Date().toISOString();
  const conf = await confirmFxEntry({
    pair, side: row.side, entryLow: (row.entry_low ?? 0) as number, entryHigh: (row.entry_high ?? 0) as number,
    watch: (row.watch ?? row.entry_low ?? 0) as number, invalidation: (row.invalidation ?? row.stop ?? 0) as number,
    mode: row.mode, mdKey, fresh: true,
  });
  const armedNow = !!row.enter_sent_at;
  const lp = conf.price ?? conf.enter;
  const armedAtMs = row.enter_sent_at ? new Date(row.enter_sent_at).getTime() : Date.now();
  const act = decideFxEntry(pair, { armed: armedNow, confState: conf.state, lp, entryLow: row.entry_low, entryHigh: row.entry_high, stop: row.stop, tp1: row.tp1, armedAtMs, nowMs: Date.now() });
  const lv = { entry_low: row.entry_low, entry_high: row.entry_high, stop: row.stop, tp1: row.tp1, tp2: row.tp2, tp3: row.tp3, invalidation: row.invalidation };

  if (act.do === "arm") {
    // Chased on the first confirmation: announce once, stay pending, wait five minutes for the pullback.
    const { data: won } = await admin.from("genfx_alerts").update({ enter_sent_at: nowIso, last_checked_at: nowIso, updated_at: nowIso })
      .eq("id", row.id).eq("state", "forming").is("enter_sent_at", null).select("id");
    if (!won?.length) return null;
    await say(ctl, enterMsg(pair, row.side, row.mode, lv, lp, false));
    return `arm:${act.reason}`;
  }
  if (act.do === "enter") {
    const { data: won } = await admin.from("genfx_alerts").update({ state: "entered", enter_price: conf.enter ?? conf.price, enter_sent_at: nowIso, last_checked_at: nowIso, updated_at: nowIso })
      .eq("id", row.id).eq("state", "forming").select("id");
    if (!won?.length) return null;
    if (!armedNow) await say(ctl, enterMsg(pair, row.side, row.mode, lv, lp, false));
    try { await placeGenfx({ pair: pair.key, signalKey: row.dedupe_key, side: row.side, mode: row.mode, entryLow: row.entry_low, entryHigh: row.entry_high, stop: row.stop, tp: row.tp1, setup: "scanner", confidence: row.confidence, alertId: row.id }); } catch { /* placement is best-effort */ }
    return `enter:${act.reason}`;
  }
  if (act.do === "invalidate") {
    const { data: won } = await admin.from("genfx_alerts").update({ state: "invalidated", last_checked_at: nowIso, updated_at: nowIso })
      .eq("id", row.id).eq("state", "forming").select("id");
    if (!won?.length) return null;
    await say(ctl, invalidMsg(pair, row.side, row.mode, lv));
    return `invalid:${act.reason}`;
  }
  await admin.from("genfx_alerts").update({ last_checked_at: nowIso, updated_at: nowIso }).eq("id", row.id).eq("state", "forming");
  return act.reason;
}

/** Grade calls already entered against the candles since: target first is a win, stop first (or the same candle) a loss. */
async function gradeEntered(admin: Admin, ctl: GenfxControl, mdKey: string): Promise<number> {
  let graded = 0;
  const nowIso = new Date().toISOString();
  const { data: openRows } = await admin.from("genfx_alerts")
    .select("id, pair, mode, side, entry, entry_low, entry_high, stop, tp1, enter_price, enter_sent_at")
    .eq("state", "entered").is("outcome", null).limit(40);
  for (const a of (openRows ?? []) as Array<{ id: string; pair: PairKey; mode: Mode; side: "buy" | "sell"; entry: number | null; entry_low: number | null; entry_high: number | null; stop: number | null; tp1: number | null; enter_price: number | null; enter_sent_at: string | null }>) {
    const pair = PAIRS[a.pair];
    const tp1 = Number(a.tp1), stop = Number(a.stop);
    if (!pair || !Number.isFinite(tp1) || !Number.isFinite(stop)) continue;
    const iv = CONFIRM_IV[a.mode] ?? "5min";
    const rowsRaw = await series(pair.td, iv, 120, mdKey, true);
    if (rowsRaw === "ratelimit" || !Array.isArray(rowsRaw)) continue;
    const enterMs = a.enter_sent_at ? new Date(a.enter_sent_at).getTime() : 0;
    // The bars since entry are selected by COUNT, not by matching the feed's datetimes to the entry
    // time: the feed does not promise UTC, and an offset would pull in bars from before the entry.
    const ivMin = a.mode === "swing" ? 60 : a.mode === "intraday" ? 15 : 5;
    const barsSince = Math.min(rowsRaw.length, Math.max(1, Math.floor((Date.now() - enterMs) / (ivMin * 60_000))));
    const sell = a.side === "sell";
    let result: "win" | "loss" | null = null;
    for (const c of rowsRaw.slice(-barsSince)) {
      const hi = +c.high, lo = +c.low;
      const hitTp = sell ? lo <= tp1 : hi >= tp1;
      const hitStop = sell ? hi >= stop : lo <= stop;
      if (hitTp && !hitStop) { result = "win"; break; }
      if (hitStop) { result = "loss"; break; }
    }
    if (!result) {
      if ((Date.now() - enterMs) / 3600e3 > 8) await admin.from("genfx_alerts").update({ outcome: "expired", resolved_at: nowIso, updated_at: nowIso }).eq("id", a.id).is("outcome", null);
      continue;
    }
    const ref = Number(a.enter_price ?? a.entry ?? ((Number(a.entry_low) + Number(a.entry_high)) / 2));
    const pips = Math.round(Math.abs(ref - (result === "win" ? tp1 : stop)) / pair.pip) * (result === "win" ? 1 : -1);
    const { data: won } = await admin.from("genfx_alerts").update({ outcome: result, result_pips: pips, resolved_at: nowIso, updated_at: nowIso, win_posted_at: result === "win" ? nowIso : null })
      .eq("id", a.id).is("outcome", null).select("id");
    if (!won?.length) continue;
    graded += 1;
    if (result === "win") await say(ctl, winMsg(pair, a.side, a.mode, { entry_low: a.entry_low, entry_high: a.entry_high, stop: a.stop, tp1: a.tp1 }, pips));
  }
  return graded;
}

export type ScanOut = { ok: boolean; skipped?: string; asOf: string; graded?: number; decisions: Record<string, Record<string, unknown>>; /** What was written to the heartbeat — the worker re-sends it with its liveness beats so they never erase it. */ detail?: Record<string, unknown> };

/** One full scan of both pairs across all three horizons. */
export async function runGenfxScan(admin: Admin, mdKey: string, opts: { worker?: boolean } = {}): Promise<ScanOut> {
  const nowIso = new Date().toISOString();
  const decisions: Record<string, Record<string, unknown>> = {};
  const ctl = await readControl(admin);
  if (!ctl.readable || !ctl.scan) {
    await beat(admin, "genfx", { tier: "full", worker: !!opts.worker, skipped: ctl.readable ? "scan_off" : "control_unreadable" });
    return { ok: true, skipped: ctl.readable ? "scan_off" : "control_unreadable", asOf: nowIso, decisions };
  }

  // Expire pending setups that have waited too long (the same windows gold uses).
  try {
    await admin.from("genfx_alerts").update({ state: "expired", updated_at: nowIso })
      .eq("state", "forming").in("mode", ["quick", "intraday"]).lt("created_at", new Date(Date.now() - 8 * 3600e3).toISOString());
    await admin.from("genfx_alerts").update({ state: "expired", updated_at: nowIso })
      .eq("state", "forming").eq("mode", "swing").lt("created_at", new Date(Date.now() - 48 * 3600e3).toISOString());
  } catch { /* best effort */ }

  let graded = 0;
  try { graded = await gradeEntered(admin, ctl, mdKey); } catch { /* grading is best effort */ }

  const quiet = inWeekendCloseWindow() || inScanQuietWindow();

  for (const key of PAIR_KEYS) {
    const pair = PAIRS[key];
    for (const mode of MODES_ORDER) {
      const out: Record<string, unknown> = { at: nowIso };
      decisions[`${key}:${mode}`] = out;
      // Around the daily close and over the weekend nothing is registered and nothing is called, so
      // there is nothing to read the market for — and no reason to spend thirty data requests finding out.
      if (quiet) { out.skip = "scan_quiet_window"; continue; }
      try {
        const rr = await computeGenfxRead({ pair, mode, mdKey, fresh: true });
        if (!rr.ok) { out.skip = rr.error; continue; }
        const g = genfxOf(pair, rr.read, { mode, price: rr.price, session: rr.session, dataStatus: rr.dataStatus, hold: MODES[mode].hold, triggerTf: MODES[mode].triggerTf, contextTf: MODES[mode].contextTf, marketStory: [], volatility: rr.volatility, atr: rr.atr });
        const engineState = String(g.engine_state || "");
        out.action = g.action; out.state = engineState; out.conf = g.confidence_score; out.price = rr.price;
        out.zone = await registerZone(admin, pair, mode, g, rr.price);

        const actionable = engineState === "TRADE_READY" || engineState === "DEVELOPING_SETUP";
        if (!actionable || g.entry_low == null || g.entry_high == null || g.stop_loss == null) { out.skip = "not_actionable"; continue; }

        const side: "buy" | "sell" = String(g.action).includes("SELL") ? "sell" : "buy";
        const watch = side === "sell" ? (g.closest_resistance ?? g.entry) : (g.closest_support ?? g.entry);
        const invalidation = g.invalidation_price ?? g.stop_loss;
        const dedupeKey = scanKey(pair, mode, side, g.entry_low, g.entry_high, Date.now());
        out.dedupe = dedupeKey;

        // The conservative confluence verdict is stored with the call, as gold stores it. Since 09-22 it
        // gates nobody (conservative differs by its loss cool-down alone); it is kept as a record.
        const q = genxConservativeGate({ confidence_score: g.confidence_score, momentum: g.momentum, market_structure: g.market_structure, action: g.action, side, entry: g.entry, stop_loss: g.stop_loss, tp1: g.tp1, session: g.session, entry_profile: g.entry_profile });
        out.quality_ok = q.ok;

        const { data: existing } = await admin.from("genfx_alerts").select("*").eq("dedupe_key", dedupeKey).maybeSingle();
        const row = existing as FxAlert | null;

        if (!row) {
          const twin = await findSameSetup(admin, pair, { side, entry_low: g.entry_low, entry_high: g.entry_high });
          if (twin) { out.result = `same_setup:${twin.dedupe_key}:${twin.state}`; continue; }
          const levels = { entry: g.entry, entry_low: g.entry_low, entry_high: g.entry_high, stop: g.stop_loss, tp1: g.tp1, tp2: g.tp2, tp3: g.tp3, invalidation, watch, confidence: g.confidence_score, trigger_tf: g.trigger_tf };
          if (engineState === "TRADE_READY") {
            const { data: ins, error } = await admin.from("genfx_alerts").insert({
              pair: pair.key, dedupe_key: dedupeKey, mode, side, action: g.action, ...levels,
              state: "entered", enter_price: rr.price, heads_up_sent_at: nowIso, enter_sent_at: nowIso, last_checked_at: nowIso, quality_ok: q.ok,
            }).select("id").single();
            if (error) { out.result = "already_recorded"; continue; }
            await say(ctl, enterMsg(pair, side, mode, levels, rr.price, true));
            try { out.placed = await placeGenfx({ pair: pair.key, signalKey: dedupeKey, side, mode, entryLow: g.entry_low, entryHigh: g.entry_high, stop: g.stop_loss, tp: g.tp1, setup: "scanner", confidence: g.confidence_score, alertId: (ins as { id: string } | null)?.id ?? null }); } catch { /* placement is best-effort */ }
            out.result = "enter_immediate";
          } else {
            const { error } = await admin.from("genfx_alerts").insert({
              pair: pair.key, dedupe_key: dedupeKey, mode, side, action: g.action, ...levels,
              state: "forming", heads_up_sent_at: nowIso, last_checked_at: nowIso, quality_ok: q.ok,
            });
            if (error) { out.result = "already_recorded"; continue; }
            if (ctl.billing) { try { out.billed = await billFxSetup(admin, dedupeKey, await armedUserIds(admin, pair, ctl)); } catch { /* billing never blocks a call */ } }
            await say(ctl, headsUpMsg(pair, side, mode, levels));
            out.result = "headsup";
          }
          continue;
        }

        if (row.state === "forming") {
          const twin = await findSameSetup(admin, pair, row, row.id);
          if (twin && Date.parse(twin.created_at) <= Date.parse(row.created_at)) {
            await admin.from("genfx_alerts").update({ state: "invalidated", last_checked_at: nowIso, updated_at: nowIso }).eq("id", row.id).eq("state", "forming");
            out.result = `merged_into:${twin.dedupe_key}`;
            continue;
          }
          out.result = (await stepForming(admin, ctl, pair, row, mdKey)) ?? "handled_elsewhere";
        } else {
          out.result = `already:${row.state}`;
        }
      } catch (e) {
        out.error = e instanceof Error ? e.message.slice(0, 160) : "error";
      }
    }
  }

  // Every decision of the scan, kept in one upserted row: "why didn't it trade?" is answerable afterwards.
  const detail = { tier: "full", worker: !!opts.worker, at: nowIso, quiet, graded, switches: { scan: ctl.scan, auto: ctl.auto, scope: ctl.scope, billing: ctl.billing, telegram: ctl.telegram }, decisions };
  await beat(admin, "genfx", detail);
  return { ok: true, asOf: nowIso, graded, decisions, detail };
}

