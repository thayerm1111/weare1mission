import { type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { genx2Active } from "@/lib/genx3/engineSelect";
import { computeGenxRead, buildGenx, genxConservativeGate, sessionNow, GOLD, MODES, type Mode } from "@/lib/genxCompute";
import { detectBreakdownRetest, breakdownLimits, tradingDayStart, type Bar as BrkBar } from "@/lib/genx/breakdownRetest";
import { newsHold } from "@/lib/news/calendar";
import { genxTrendGate, hourlyRead } from "@/lib/genx/trendGate";
import { detectRangeFade, readRegime, rangeFadeLimits, inNewYorkHours, RNG, type Bar as RngBar } from "@/lib/genx/rangeFade";
import { confirmEntry, CONFIRM_IV } from "@/lib/genxConfirm";
import { series } from "@/lib/marketData";
import { sendTelegram, esc } from "@/lib/telegram";
import { placeGenxGold, placeGenxFollower, rewardRisk, inWeekendCloseWindow, inScanQuietWindow, inDailyReopenWindow, goldDeskBreaker } from "@/lib/flow/autoExec";
import { checkOwnerLevels } from "@/lib/flow/ownerLevels";
import { billSetupForming } from "@/lib/flow/flowBilling";
import { watchPass, findSameSetup, decideGoldEntry, beatKeepDecision, headsUpMsg, enterMsg, invalidMsg, MODE_LABEL, r1, fmt, acquireWatchLock, extendWatchLock, releaseWatchLock, type AlertRow } from "@/lib/genx/watchTick";

// decideGoldEntry + the gold entry preference rules now live in @/lib/genx/watchTick
// (shared with the always-on worker).
import { beat } from "@/lib/flow/health";
import { genx2FlagsSnapshot } from "@/lib/genx2/flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Safety margin for the fan-out: placement now runs members concurrently (fast), but a wider
// ceiling means a slow broker patch can never cut the fan-out off partway and starve members.
export const maxDuration = 300;

/**
 * GENX AUTOMATED SCANNER → Telegram alerts.
 *
 * Runs the SAME deterministic engine the app uses (via @/lib/genxCompute) across
 * all three modes every few minutes. It:
 *   1. finds new actionable setups (TRADE_READY / DEVELOPING_SETUP),
 *   2. sends a "setup forming" heads-up once per setup,
 *   3. watches each pending setup's closed candles and sends "ENTER NOW" the
 *      moment it confirms (same rule as the in-app live confirmation),
 *   4. sends a short "invalidated" note if the setup dies first.
 *
 * State + de-dupe live in public.genx_alerts so nothing is ever double-sent.
 *
 * Triggered on a schedule (GitHub Actions) with a shared key:
 *   ?key=<GENX_CRON_KEY>  or  Authorization: Bearer <GENX_CRON_KEY>
 * (the platform-wide CRON_SECRET is also accepted).
 *
 * Telegram delivery needs TELEGRAM_BOT_TOKEN + TELEGRAM_CHANNEL_ID in the env.
 */
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
function authorized(req: NextRequest): boolean {
  const key = process.env.GENX_CRON_KEY;
  const secret = process.env.CRON_SECRET;
  const url = new URL(req.url);
  const qp = url.searchParams.get("key") || "";
  const hdr = req.headers.get("authorization") || "";
  if (key && (qp === key || hdr === `Bearer ${key}`)) return true;
  if (secret && (qp === secret || hdr === `Bearer ${secret}`)) return true;
  return false;
}

// MODE_LABEL, message builders, and AlertRow now live in @/lib/genx/watchTick (shared with the worker).

async function run(): Promise<Response> {
  // GENX 2.0 is retired while GENX 3.0 is the active engine (owner 09-16): no scan, no alerts.
  if (!genx2Active()) return json({ ok: true, skipped: "legacy_engine_off_genx3_active" }, 200);
  const mdKey = process.env.TWELVEDATA_API_KEY;
  if (!mdKey) return json({ error: "no_market_data_key" }, 500);
  const admin = createAdminClient();
  if (!admin) return json({ error: "no_admin_client" }, 500);
  const tgReady = !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHANNEL_ID);
  // Stay completely inert until Telegram is configured: don't run the engine,
  // don't record setups, don't spend market-data calls. This guarantees the very
  // first setups after go-live get their full heads-up → ENTER-NOW sequence
  // instead of being silently recorded (and de-duped) before alerts can send.
  if (!tgReady) return json({ ok: true, skipped: "telegram_not_configured" }, 200);
  await beatKeepDecision(admin, { tier: "full" }); // liveness signal for the watchdog

  // Expire stale pending setups so a fresh identical zone can re-alert later.
  const nowIso = new Date().toISOString();
  // Heartbeat so the GENX Lab can show the true "last scan" time even when a scan
  // finds no actionable setup (state 'meta' — excluded from every alert query).
  try {
    await admin.from("genx_alerts").upsert(
      { dedupe_key: "__scan_heartbeat__", mode: "meta", side: "meta", action: "HEARTBEAT", state: "meta", last_checked_at: nowIso, updated_at: nowIso },
      { onConflict: "dedupe_key" },
    );
  } catch { /* best effort */ }
  try {
    await admin.from("genx_alerts").update({ state: "expired", updated_at: nowIso })
      .eq("state", "forming").in("mode", ["quick", "intraday"]).lt("created_at", new Date(Date.now() - 8 * 3600e3).toISOString());
    await admin.from("genx_alerts").update({ state: "expired", updated_at: nowIso })
      .eq("state", "forming").eq("mode", "swing").lt("created_at", new Date(Date.now() - 48 * 3600e3).toISOString());
  } catch { /* best effort */ }

  // Grade entered calls against the candles that printed after entry — flip each
  // to win/loss, and post a 🏆 WIN recap when a called trade reaches its target.
  // This is what powers the public wins wall (only real, hit-target calls count).
  try {
    const { data: openRows } = await admin.from("genx_alerts")
      .select("id, mode, side, entry, entry_low, entry_high, stop, tp1, enter_price, enter_sent_at")
      .eq("state", "entered").is("outcome", null).limit(20);
    for (const a of (openRows ?? []) as Array<{ id: string; mode: string; side: string; entry: number | null; entry_low: number | null; entry_high: number | null; stop: number | null; tp1: number | null; enter_price: number | null; enter_sent_at: string | null }>) {
      const tp1 = Number(a.tp1), stop = Number(a.stop);
      if (!Number.isFinite(tp1) || !Number.isFinite(stop)) continue;
      const iv = CONFIRM_IV[a.mode] ?? "5min";
      const rowsRaw = await series("XAU/USD", iv, 120, mdKey, true);
      if (rowsRaw === "ratelimit") continue;
      const candles = (Array.isArray(rowsRaw) ? rowsRaw : []) as Array<{ datetime: string; high: string; low: string }>;
      const enterMs = a.enter_sent_at ? new Date(a.enter_sent_at).getTime() : 0;
      // Select post-entry candles by COUNT of elapsed intervals, not by matching
      // candle datetimes to the entry time — the feed's datetimes aren't guaranteed
      // UTC, and an offset would pull in pre-entry bars (when Gold was up near the
      // stop) and falsely score a loss. `candles` is oldest→newest, so the last N
      // bars are exactly the ones since entry.
      const ivMin = a.mode === "swing" ? 60 : a.mode === "intraday" ? 15 : 5;
      const barsSince = Math.min(candles.length, Math.max(1, Math.floor((Date.now() - enterMs) / (ivMin * 60000))));
      const after = candles.slice(-barsSince);
      const sell = a.side === "sell";
      let result: "win" | "loss" | null = null;
      for (const c of after) {
        const hi = +c.high, lo = +c.low;
        const hitTp = sell ? lo <= tp1 : hi >= tp1;
        const hitStop = sell ? hi >= stop : lo <= stop;
        if (hitTp && !hitStop) { result = "win"; break; }
        if (hitStop) { result = "loss"; break; } // stop first (or same candle) → conservative loss
      }
      const ageH = (Date.now() - enterMs) / 3600e3;
      if (!result) {
        if (ageH > 8) await admin.from("genx_alerts").update({ outcome: "expired", resolved_at: nowIso, updated_at: nowIso }).eq("id", a.id);
        continue;
      }
      const ref = Number(a.enter_price ?? a.entry ?? ((Number(a.entry_low) + Number(a.entry_high)) / 2));
      const target = result === "win" ? tp1 : stop;
      const pips = Math.round(Math.abs(ref - target) / GOLD.pip) * (result === "win" ? 1 : -1);
      await admin.from("genx_alerts").update({ outcome: result, result_pips: pips, resolved_at: nowIso, updated_at: nowIso, win_posted_at: result === "win" ? nowIso : null }).eq("id", a.id);
      if (result === "win" && tgReady) {
        await sendTelegram([
          `🏆 <b>GENX WIN · ${sell ? "SELL" : "BUY"} · ${MODE_LABEL[a.mode as Mode] || a.mode}</b>`,
          `Gold hit its target for <b>+${pips} pips</b>.`,
          `Called ${fmt(a.entry_low)}–${fmt(a.entry_high)} → TP1 ${fmt(tp1)}.`,
          `<i>Educational, not financial advice.</i>`,
        ].join("\n"));
      }
    }
  } catch { /* grading is best effort */ }

  const out: Record<string, unknown> = { modes: {}, sent: [] as string[], tgReady };
  // the quick read, kept for the breakdown-retest pass after the main scan
  let quickBias: { bias: string; bull: number; bear: number; price: number } | null = null;
  const sent = out.sent as string[];

  // All three GENX horizons, exactly as the GENX page reads them (owner 09-21: "go back to quick,
  // intraday and swing, this exact strategy"): Quick 30–80 pips, Intraday 2–6 hrs, Swing hours–days.
  for (const mode of ["quick", "intraday", "swing"] as Mode[]) {
    const modeOut: Record<string, unknown> = {};
    (out.modes as Record<string, unknown>)[mode] = modeOut;
    try {
      const rr = await computeGenxRead({ mode, mdKey, fresh: true });
      if (!rr.ok) { modeOut.skip = rr.error; continue; }
      const genx = buildGenx(rr.read, { mode, price: rr.price, session: rr.session, dataStatus: rr.dataStatus, hold: MODES[mode].hold, triggerTf: MODES[mode].triggerTf, contextTf: MODES[mode].contextTf, pip: GOLD.pip, dec: GOLD.dec, marketStory: [], volatility: rr.volatility, atr: rr.atr, m15: rr.m15 });
      if (mode === "quick") {
        const g = genx as unknown as { directional_bias?: string; bull_case_score?: number; bear_case_score?: number };
        quickBias = { bias: String(g.directional_bias ?? ""), bull: Number(g.bull_case_score ?? 0), bear: Number(g.bear_case_score ?? 0), price: rr.price };
      }

      const engineState = String(genx.engine_state || "");
      const actionable = engineState === "TRADE_READY" || engineState === "DEVELOPING_SETUP";
      modeOut.action = genx.action; modeOut.state = engineState; modeOut.conf = genx.confidence_score; modeOut.profile = genx.entry_profile;
      if (!actionable || genx.entry_low == null || genx.entry_high == null || genx.stop_loss == null) { modeOut.skip = "not_actionable"; continue; }

      const side: "buy" | "sell" = String(genx.action).includes("SELL") ? "sell" : "buy";
      const watch = side === "sell" ? (genx.closest_resistance ?? genx.entry) : (genx.closest_support ?? genx.entry);
      const invalidation = genx.invalidation_price ?? genx.stop_loss;
      const dedupeKey = `${mode}:${side}:${r1(genx.entry_low)}:${r1(genx.entry_high)}`;
      modeOut.dedupe = dedupeKey;

      // WEEKEND-CLOSE BLACKOUT (owner rule): in the final 30 min before Friday's close no new
      // alert is sent, nothing confirms, and nothing is placed — a late-Friday fill just carries
      // weekend-gap risk. Forming setups simply pause; expiry cleans them up over the weekend.
      if (inWeekendCloseWindow() || inScanQuietWindow()) { modeOut.skip = "scan_quiet_window"; continue; }

      // CONSERVATIVE QUALITY GATE — verdict computed ONCE from the fresh read and stored on
      // the alert row, so the confirm/fast-watch paths (which only see the stored row) grade
      // identically. Aggressive accounts ignore this; only conservative placement uses it.
      const qGate = genxConservativeGate({
        confidence_score: genx.confidence_score, momentum: genx.momentum, market_structure: genx.market_structure,
        action: genx.action, side, entry: genx.entry, stop_loss: genx.stop_loss, tp1: genx.tp1, session: genx.session,
        entry_profile: genx.entry_profile,
      });
      const qOk = qGate.ok;
      modeOut.quality_ok = qOk; modeOut.quality_reason = qGate.reason;

      // Existing alert for this exact setup?
      const { data: existing } = await admin.from("genx_alerts").select("*").eq("dedupe_key", dedupeKey).maybeSingle();
      const row = existing as AlertRow | null;

      const immediate = engineState === "TRADE_READY"; // BUY_NOW / SELL_NOW

      // SAME SETUP, DRIFTED ZONE (owner 09-16): not a new setup — the open alert keeps being watched; nothing is posted.
      if (!row) {
        const twin = await findSameSetup(admin, { side, entry_low: genx.entry_low, entry_high: genx.entry_high });
        if (twin) { modeOut.result = `same_setup:${twin.dedupe_key}:${twin.state}`; continue; }
        // TREND GATE (owner 09-21, see src/lib/genx/trendGate.ts): a NEW call needs the 1h EMA 20/50/200
        // stacked its way and a core-grade setup. Setups already being watched are not affected.
        // Quick: stack + core-grade. Intraday: stack. Swing: not gated (untested).
        if (mode !== "swing") {
          const tg = await genxTrendGate(side, mdKey, { profile: mode === "quick" ? (String(genx.entry_profile ?? "") || null) : null });
          modeOut.trend_gate = tg.reason;
          if (!tg.ok) { modeOut.skip = tg.reason; continue; }
        }
      }

      if (!row) {
        // Brand-new setup.
        if (immediate) {
          // Record first (unique dedupe key), then post — two overlapping scans can never both announce it.
          const { error: insErr } = await admin.from("genx_alerts").insert({
            dedupe_key: dedupeKey, mode, side, action: genx.action,
            entry: genx.entry, entry_low: genx.entry_low, entry_high: genx.entry_high,
            stop: genx.stop_loss, tp1: genx.tp1, tp2: genx.tp2, tp3: genx.tp3,
            invalidation, watch, confidence: genx.confidence_score, trigger_tf: genx.trigger_tf,
            state: "entered", enter_price: rr.price, heads_up_sent_at: nowIso, enter_sent_at: nowIso, last_checked_at: nowIso,
            quality_ok: qOk,
          });
          if (insErr) { modeOut.result = "already_recorded"; continue; }
          if (tgReady) await sendTelegram(enterMsg(side, mode, { entry_low: genx.entry_low, entry_high: genx.entry_high, stop: genx.stop_loss, tp1: genx.tp1, tp2: genx.tp2, tp3: genx.tp3 }, rr.price, true));
          // FLOW copies this gold ENTER NOW to every credited member (once per move).
          // conservativeOk gates ONLY conservative accounts; aggressive take it regardless.
          try { await placeGenxGold({ side, entryLow: genx.entry_low, entryHigh: genx.entry_high, stop: genx.stop_loss, tp: genx.tp1, conservativeOk: qOk, confidence: genx.confidence_score, mode }); } catch { /* placement is best-effort */ }
          // FOLLOWER accounts take EVERY GENX signal, risk-sized to each account's own % (separate from FLOW).
          try { await placeGenxFollower({ signalKey: dedupeKey, side, entryLow: genx.entry_low, entryHigh: genx.entry_high, stop: genx.stop_loss, tp: genx.tp1, conservativeOk: qOk, confidence: genx.confidence_score, mode }); } catch { /* follower is best-effort */ }
          sent.push(`${mode}:ENTER(immediate)`); modeOut.result = "enter_immediate";
        } else {
          // Developing → heads-up now, watch for the entry on future ticks.
          const { error: insErr } = await admin.from("genx_alerts").insert({
            dedupe_key: dedupeKey, mode, side, action: genx.action,
            entry: genx.entry, entry_low: genx.entry_low, entry_high: genx.entry_high,
            stop: genx.stop_loss, tp1: genx.tp1, tp2: genx.tp2, tp3: genx.tp3,
            invalidation, watch, confidence: genx.confidence_score, trigger_tf: genx.trigger_tf,
            state: "forming", heads_up_sent_at: nowIso, last_checked_at: nowIso,
            quality_ok: qOk,
          });
          if (insErr) { modeOut.result = "already_recorded"; continue; }
          // CREDITS (owner 09-18: "1 when the trade is forming"): every member armed for this setup pays
          // one credit, once — charged on the insert, so a re-scan of the same setup never charges twice.
          try { const b = await billSetupForming(admin, dedupeKey); modeOut.billed = b; } catch { /* billing is best-effort; it never blocks an alert */ }
          if (tgReady) await sendTelegram(headsUpMsg(side, mode, { entry_low: genx.entry_low, entry_high: genx.entry_high, stop: genx.stop_loss, tp1: genx.tp1, tp2: genx.tp2, confidence: genx.confidence_score }));
          sent.push(`${mode}:HEADSUP`); modeOut.result = "headsup";
        }
        continue;
      }

      // Known setup, still pending → check whether it has confirmed or died. A later twin of an earlier
      // open alert (zone drift) is retired silently instead (same-setup dedupe).
      if (row.state === "forming") {
        const twin = await findSameSetup(admin, row, row.id);
        if (twin && Date.parse(twin.created_at) <= Date.parse(row.created_at)) {
          await admin.from("genx_alerts").update({ state: "invalidated", last_checked_at: nowIso, updated_at: nowIso }).eq("id", row.id).eq("state", "forming");
          modeOut.result = `merged_into:${twin.dedupe_key}`;
          continue;
        }
      }
      if (row.state === "forming") {
        const conf = await confirmEntry({
          side, entryLow: row.entry_low ?? genx.entry_low, entryHigh: row.entry_high ?? genx.entry_high,
          watch: (row.watch ?? watch) as number, invalidation: (row.invalidation ?? invalidation) as number,
          mode, mdKey, fresh: true,
        });
        const cOk = row.quality_ok !== false; // stored at arm time; null (old rows) → allowed
        const armedNow = !!row.enter_sent_at;
        const lp = conf.price ?? conf.enter;
        const armedAtMs = row.enter_sent_at ? new Date(row.enter_sent_at).getTime() : Date.now();
        const tgMsg = { entry_low: row.entry_low, entry_high: row.entry_high, stop: row.stop, tp1: row.tp1, tp2: row.tp2, tp3: row.tp3 };
        const act = decideGoldEntry({ armed: armedNow, confState: conf.state, lp, entryLow: row.entry_low, entryHigh: row.entry_high, stop: row.stop, tp1: row.tp1, armedAtMs, nowMs: Date.now() });
        if (act.do === "arm") {
          // Chased on first confirmation → announce ENTER NOW once, then hold (stay 'forming') and
          // wait for price to pull back into the entry zone for the full R:R.
          if (tgReady) await sendTelegram(enterMsg(side, mode, tgMsg, lp, false));
          await admin.from("genx_alerts").update({ enter_sent_at: nowIso, last_checked_at: nowIso, updated_at: nowIso }).eq("id", row.id);
          // 🚀 SEND IT (owner 09-04): the desk waits for the pullback, but Send It accounts take
          // EVERY call — fire a send-it-only placement at market right now. Fires once (the arm
          // transition happens once per signal); followers dedupe on the signal key.
          try { await placeGenxGold({ side, entryLow: row.entry_low, entryHigh: row.entry_high, stop: row.stop, tp: row.tp1, conservativeOk: cOk, confidence: row.confidence, sendItOnly: true, mode: row.mode }); } catch { /* best-effort */ }
          try { await placeGenxFollower({ signalKey: dedupeKey, side, entryLow: row.entry_low, entryHigh: row.entry_high, stop: row.stop, tp: row.tp1, conservativeOk: cOk, confidence: row.confidence, sendItOnly: true, mode: row.mode }); } catch { /* best-effort */ }
          sent.push(`${mode}:ARM`); modeOut.result = `arm:${act.reason}`;
        } else if (act.do === "enter") {
          if (!armedNow && tgReady) await sendTelegram(enterMsg(side, mode, tgMsg, lp, false));
          await admin.from("genx_alerts").update({ state: "entered", enter_price: conf.enter ?? conf.price, enter_sent_at: nowIso, last_checked_at: nowIso, updated_at: nowIso }).eq("id", row.id);
          try { await placeGenxGold({ side, entryLow: row.entry_low, entryHigh: row.entry_high, stop: row.stop, tp: row.tp1, conservativeOk: cOk, confidence: row.confidence, mode: row.mode }); } catch { /* placement is best-effort */ }
          try { await placeGenxFollower({ signalKey: dedupeKey, side, entryLow: row.entry_low, entryHigh: row.entry_high, stop: row.stop, tp: row.tp1, conservativeOk: cOk, confidence: row.confidence, mode: row.mode }); } catch { /* follower is best-effort */ }
          sent.push(`${mode}:ENTER`); modeOut.result = `enter:${act.reason}`;
        } else if (act.do === "invalidate") {
          if (tgReady) await sendTelegram(invalidMsg(side, mode, { entry_low: row.entry_low, entry_high: row.entry_high, invalidation: row.invalidation }));
          await admin.from("genx_alerts").update({ state: "invalidated", last_checked_at: nowIso, updated_at: nowIso }).eq("id", row.id);
          sent.push(`${mode}:INVALID`); modeOut.result = `invalid:${act.reason}`;
        } else {
          await admin.from("genx_alerts").update({ last_checked_at: nowIso, updated_at: nowIso }).eq("id", row.id);
          modeOut.result = act.reason;
        }
      } else {
        modeOut.result = `already:${row.state}`;
      }
    } catch (e) {
      modeOut.error = e instanceof Error ? e.message : "error";
    } finally {
      // OBSERVABILITY: persist the exact decision of every full scan into the genx
      // heartbeat detail (upsert — zero row growth). Before this, skip reasons only
      // existed in the HTTP response and were invisible after the fact, so "why did
      // it not trade?" required guesswork. In a FINALLY because the loop body
      // `continue`s on its most common paths (not_actionable, new-setup handled) —
      // a beat placed after the try/catch never ran for those decisions.
      try {
        await beat(admin, "genx", { tier: "full", flags: genx2FlagsSnapshot(), last_decision: { at: nowIso, mode, ...modeOut } });
      } catch { /* liveness/observability best-effort */ }
    }
  }

  // BREAKDOWN-RETEST SELLS (owner 09-21) — see src/lib/genx/breakdownRetest.ts for the rule and its limits.
  try { out.breakdown = await breakdownRetestPass(admin, mdKey, quickBias, tgReady, sent); } catch (e) { out.breakdown = { error: e instanceof Error ? e.message : "error" }; }
  // SIDEWAYS-MARKET STRATEGY (owner 09-21) — see src/lib/genx/rangeFade.ts. Only runs when the regime read says RANGE.
  try { out.range = await rangeFadePass(admin, mdKey, quickBias?.price ?? null, tgReady, sent); } catch (e) { out.range = { error: e instanceof Error ? e.message : "error" }; }
  try { await beat(admin, "genx", { tier: "full", flags: genx2FlagsSnapshot(), last_decision: { at: nowIso, mode: "quick", ...(((out.modes as Record<string, unknown>).quick as Record<string, unknown>) ?? {}), breakdown: out.breakdown, range: out.range } }); } catch { /* best-effort */ }

  // MY LEVELS (owner 09-07): after the trend scan, check the owner's drawn
  // support/resistance lines — a confirmed 5-minute rejection at one fires a
  // level-bounce placement through the exact same execution path.
  let ownerLevels: { checked: number; fired: number } = { checked: 0, fired: 0 };
  if (!inScanQuietWindow()) { try { ownerLevels = await checkOwnerLevels(admin, mdKey); } catch { /* best-effort */ } }

  return json({ ok: true, asOf: nowIso, ownerLevels, ...out }, 200);
}

/** Liveness beat that PRESERVES the stored last_decision. beat() replaces the whole
 *  detail JSON, so the 30s watch tier and the start-of-run beat were erasing the
 *  full scan's decision record within seconds of it being written — making the
 *  observability useless. This merges the existing last_decision back in. */
// beatKeepDecision now lives in @/lib/genx/watchTick (shared with the worker).

// Connectivity probe: posts a one-line "connected" message to the channel so we
// can confirm Telegram delivery works even when the market has no live setup.
async function sendProbe(): Promise<Response> {
  const tgReady = !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHANNEL_ID);
  if (!tgReady) return json({ ok: false, error: "telegram_not_configured" }, 200);
  const res = await sendTelegram([
    "✅ <b>GENX alerts connected</b>",
    "This channel is now wired to the GENX auto-scanner. You'll get a heads-up when a setup forms and an <b>ENTER NOW</b> the moment it triggers.",
    "<i>Educational, not financial advice.</i>",
  ].join("\n"));
  return json({ ok: res.ok, probe: true, detail: res.detail }, res.ok ? 200 : 200);
}

/**
 * FAST-WATCH — the light, high-frequency tier (every ~30s). It does NOT run the
 * heavy full scan; it only re-checks setups already in 'forming' and confirms
 * them on 1-MINUTE closes, so an ENTER NOW fires the moment buyers/sellers
 * activate at the zone instead of waiting for the 5-minute close.
 */
// FAST WATCH LOOP (owner 09-09: "We need execution to speed up... all things firing
// faster"): the watch used to be ONE pass per minute — an armed pullback could trigger
// and be gone 50 seconds before the next look. Like flow-manage, the minutely cron
// invocation now LOOPS inside its function budget, re-checking every ~6s, so a
// confirmed entry fires within seconds instead of within a minute. Passes with no
// forming setups cost one DB read and zero market-data credits.
const WATCH_BUDGET_MS = 52_000;   // stay inside the minutely cadence (next invocation takes over)
const WATCH_INTERVAL_MS = 6_000;  // ~9 looks/min at the market instead of 1

async function runWatch(): Promise<Response> {
  const mdKey = process.env.TWELVEDATA_API_KEY;
  if (!mdKey) return json({ error: "no_market_data_key" }, 500);
  const admin = createAdminClient();
  if (!admin) return json({ error: "no_admin_client" }, 500);
  const tgReady = !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHANNEL_ID);
  // WEEKEND-CLOSE BLACKOUT — the fast watch confirms entries, so it stops confirming in the
  // final 30 min before Friday's close (same rule as the full scan and every placement path).
  if (inWeekendCloseWindow() || inScanQuietWindow()) return json({ ok: true, skipped: "scan_quiet_window" });
  // THE WATCH LOCK: the always-on worker holds it while alive (sub-2s watching); this
  // cron loop is the automatic FALLBACK — it only watches when it can take the lock
  // (worker down → lock expires in seconds → the next minutely run takes over).
  const holder = (globalThis.crypto?.randomUUID?.() ?? `w-${Date.now()}`);
  const got = await acquireWatchLock(admin, holder);
  if (!got) return json({ ok: true, watch: true, skipped: "locked (worker active)" }, 200);
  const start = Date.now();
  let ticks = 0; let lastChecked = 0; const sentAll: string[] = [];
  try {
    while (Date.now() - start < WATCH_BUDGET_MS) {
      ticks += 1;
      if (tgReady) { try { await beatKeepDecision(admin, { tier: "watch" }); } catch { /* liveness best-effort */ } }
      const pass = await watchPass(admin, mdKey, tgReady);
      lastChecked = pass.checked; sentAll.push(...pass.sent);
      await extendWatchLock(admin, holder);
      const remaining = WATCH_BUDGET_MS - (Date.now() - start);
      if (remaining <= 0) break;
      await new Promise((r) => setTimeout(r, Math.min(WATCH_INTERVAL_MS, remaining)));
    }
  } finally {
    await releaseWatchLock(admin, holder);
  }
  return json({ ok: true, watch: true, ticks, intervalMs: WATCH_INTERVAL_MS, checked: lastChecked, sent: sentAll, asOf: new Date().toISOString() }, 200);
}

// watchPass now lives in @/lib/genx/watchTick (shared with the worker).

export async function GET(req: NextRequest) {
  if (!authorized(req)) return json({ error: "unauthorized" }, 401);
  const sp = new URL(req.url).searchParams;
  if (sp.get("test")) return sendProbe();
  if (sp.get("watch") === "1") return runWatch();
  return run();
}
export async function POST(req: NextRequest) {
  if (!authorized(req)) return json({ error: "unauthorized" }, 401);
  const sp = new URL(req.url).searchParams;
  if (sp.get("test")) return sendProbe();
  if (sp.get("watch") === "1") return runWatch();
  return run();
}

/**
 * One breakdown-retest pass. Every exit returns the reason, so "why didn't it call?" is always answerable
 * from the heartbeat. Fails closed: missing data, an unreadable limit or an unknown bias means no call.
 */
async function breakdownRetestPass(
  admin: NonNullable<ReturnType<typeof createAdminClient>>, mdKey: string,
  bias: { bias: string; bull: number; bear: number; price: number } | null, tgReady: boolean, sent: string[],
): Promise<Record<string, unknown>> {
  // OFF by default since 09-21 (owner: straight GENX, how it used to find trades). GENX_BREAKDOWN_RETEST=on restores it.
  if ((process.env.GENX_BREAKDOWN_RETEST ?? "").toLowerCase() !== "on") return { skip: "switched_off" };
  if (inWeekendCloseWindow() || inScanQuietWindow() || inDailyReopenWindow()) return { skip: "quiet_window" };
  if (!bias) return { skip: "no_read" };
  if (!(bias.bias === "bearish" && bias.bear >= bias.bull)) return { skip: `bias_not_bearish:${bias.bias}` };
  const tg = await genxTrendGate("sell", mdKey);
  if (!tg.ok) return { skip: tg.reason };

  // closed 5-minute bars (the feed's last row is the bar still forming)
  const raw = await series(GOLD.symbol, "5min", 150, mdKey, false);
  if (!Array.isArray(raw) || raw.length < 60) return { skip: "no_bars" };
  // The feed's last row is the bar still forming (same convention as genxConfirm) — never trade on it.
  const rows = raw.slice(0, -1);
  const bars: BrkBar[] = rows.map((r) => ({ t: String(r.datetime), o: +r.open, h: +r.high, l: +r.low, c: +r.close }))
    .filter((b) => [b.o, b.h, b.l, b.c].every(Number.isFinite));
  const d = detectBreakdownRetest(bars);
  if (!d.ok) return { skip: d.reason };
  const s = d.setup;

  // chase check: the live price must still be near the rejection close
  if (Math.abs(bias.price - s.entry) > 0.35 * s.risk) return { skip: "moved_away", setup: s };

  // limits
  const since = new Date(Date.now() - 36 * 3600_000).toISOString();
  const { data: prev, error: prevErr } = await admin.from("genx_alerts").select("created_at, outcome").like("dedupe_key", "quick:sell:brk:%").gte("created_at", since);
  if (prevErr) return { skip: "limits_unreadable" };
  const lim = breakdownLimits(
    ((prev ?? []) as { created_at: string; outcome: string | null }[]).map((p) => ({ createdAt: p.created_at, session: sessionNow(new Date(p.created_at)), outcome: p.outcome })),
    { session: sessionNow(new Date()), dayStartMs: tradingDayStart() },
  );
  if (!lim.ok) return { skip: lim.reason, setup: s };
  const { data: open, error: openErr } = await admin.from("genx_alerts").select("id").in("state", ["forming", "entered"]).is("outcome", null).like("dedupe_key", "quick:%").limit(1);
  if (openErr) return { skip: "open_calls_unreadable" };
  if ((open ?? []).length) return { skip: "another_call_open", setup: s };
  const brk = await goldDeskBreaker(admin);
  if (brk.hold) return { skip: "desk_breaker", setup: s };
  try { if ((await newsHold("XAUUSD")).hold) return { skip: "news_blackout", setup: s }; } catch { return { skip: "news_unreadable" }; }

  // record first (unique key per level), then announce and place — never twice
  const nowIso = new Date().toISOString();
  const dedupeKey = `quick:sell:brk:${r1(s.level)}`;
  const zone = { entry_low: Math.round((s.entry - 0.3) * 100) / 100, entry_high: Math.round((s.entry + 0.3) * 100) / 100 };
  const { error: insErr } = await admin.from("genx_alerts").insert({
    dedupe_key: dedupeKey, mode: "quick", side: "sell", action: "SELL_NOW",
    entry: s.entry, ...zone, stop: s.stop, tp1: s.tp1, tp2: s.tp2, tp3: null,
    invalidation: s.stop, watch: s.level, confidence: null, trigger_tf: "5-minute",
    state: "entered", enter_price: bias.price, heads_up_sent_at: nowIso, enter_sent_at: nowIso, last_checked_at: nowIso,
    quality_ok: false, // conservative accounts never take a breakdown-retest
  });
  if (insErr) return { skip: "already_called_this_level", setup: s };
  if (tgReady) {
    await sendTelegram([
      `📉 <b>Breakdown retest</b> — support ${fmt(s.level)} broke, and its first retest just rejected. Aggressive accounts only.`,
      enterMsg("sell", "quick", { ...zone, stop: s.stop, tp1: s.tp1, tp2: s.tp2, tp3: null }, bias.price, true),
    ].join("\n"));
  }
  try { await placeGenxGold({ side: "sell", ...{ entryLow: zone.entry_low, entryHigh: zone.entry_high }, stop: s.stop, tp: s.tp1, conservativeOk: false, confidence: null, mode: "quick" }); } catch { /* best-effort */ }
  try { await placeGenxFollower({ signalKey: dedupeKey, side: "sell", entryLow: zone.entry_low, entryHigh: zone.entry_high, stop: s.stop, tp: s.tp1, conservativeOk: false, confidence: null, mode: "quick" }); } catch { /* best-effort */ }
  sent.push("quick:BREAKDOWN_RETEST");
  return { result: "called", setup: s };
}

/**
 * One range-fade pass (the sideways-market strategy). Every exit returns its reason and the regime read,
 * so "what does GENX think the market is doing?" is answerable from the heartbeat. Fails closed.
 */
async function rangeFadePass(
  admin: NonNullable<ReturnType<typeof createAdminClient>>, mdKey: string, livePx: number | null, tgReady: boolean, sent: string[],
): Promise<Record<string, unknown>> {
  if ((process.env.GENX_RANGE_FADE ?? "").toLowerCase() === "off") return { skip: "switched_off" };
  const h = await hourlyRead(mdKey);
  const regime = readRegime(h?.res?.stack ?? null, h?.closes ?? []);
  const base = { regime: regime.regime, regimeWhy: regime.why, eff: regime.eff };
  if (regime.regime !== "range") return { ...base, skip: `regime_${regime.regime}` };
  if (inWeekendCloseWindow() || inScanQuietWindow() || inDailyReopenWindow()) return { ...base, skip: "quiet_window" };
  if (inNewYorkHours()) return { ...base, skip: "new_york_hours" };

  const raw = await series(GOLD.symbol, "5min", 400, mdKey, false);
  if (!Array.isArray(raw) || raw.length < RNG.lookback + 30) return { ...base, skip: "no_bars" };
  const bars: RngBar[] = raw.slice(0, -1) // the feed's last row is the bar still forming — never trade on it
    .map((r) => ({ t: String(r.datetime), o: +r.open, h: +r.high, l: +r.low, c: +r.close }))
    .filter((b) => [b.o, b.h, b.l, b.c].every(Number.isFinite));
  const last = bars.at(-1);
  const range = bars.length > RNG.lookback ? (() => { const seg = bars.slice(-1 - RNG.lookback, -1); return { high: Math.max(...seg.map((b) => b.h)), low: Math.min(...seg.map((b) => b.l)) }; })() : null;
  const d = detectRangeFade(bars);
  if (!d.ok) return { ...base, range, skip: d.reason };
  const s = d.setup;

  const px = livePx ?? last?.c ?? null;
  if (px == null || Math.abs(px - s.entry) > RNG.chaseR * s.risk) return { ...base, skip: "moved_away", setup: s };

  // limits: gap + per-day, and never while any GENX gold call is still open
  const since = new Date(Date.now() - 36 * 3600_000).toISOString();
  const { data: prev, error: prevErr } = await admin.from("genx_alerts").select("created_at").like("dedupe_key", "intraday:%:rng:%").gte("created_at", since);
  if (prevErr) return { ...base, skip: "limits_unreadable" };
  const lim = rangeFadeLimits(((prev ?? []) as { created_at: string }[]).map((p) => ({ createdAt: p.created_at })), { nowMs: Date.now(), dayStartMs: tradingDayStart() });
  if (!lim.ok) return { ...base, skip: lim.reason, setup: s };
  const { data: open, error: openErr } = await admin.from("genx_alerts").select("id").eq("state", "entered").is("outcome", null).neq("mode", "meta").limit(1);
  if (openErr) return { ...base, skip: "open_calls_unreadable" };
  if ((open ?? []).length) return { ...base, skip: "another_call_open", setup: s };
  const brk = await goldDeskBreaker(admin);
  if (brk.hold) return { ...base, skip: "desk_breaker", setup: s };
  try { if ((await newsHold("XAUUSD")).hold) return { ...base, skip: "news_blackout", setup: s }; } catch { return { ...base, skip: "news_unreadable" }; }

  // record first (unique per signal bar), then announce and place — never twice
  const nowIso = new Date().toISOString();
  const dedupeKey = `intraday:${s.side}:rng:${String(last?.t ?? nowIso).replace(/\s+/g, "T")}`;
  const zone = { entry_low: Math.round((s.entry - 0.3) * 100) / 100, entry_high: Math.round((s.entry + 0.3) * 100) / 100 };
  const { error: insErr } = await admin.from("genx_alerts").insert({
    dedupe_key: dedupeKey, mode: "intraday", side: s.side, action: s.side === "sell" ? "SELL_NOW" : "BUY_NOW",
    entry: s.entry, ...zone, stop: s.stop, tp1: s.tp1, tp2: s.tp2, tp3: null,
    invalidation: s.stop, watch: s.side === "sell" ? s.high : s.low, confidence: null, trigger_tf: "5-minute",
    state: "entered", enter_price: px, heads_up_sent_at: nowIso, enter_sent_at: nowIso, last_checked_at: nowIso,
    quality_ok: false, // new strategy: aggressive accounts only until it has a live record
  });
  if (insErr) return { ...base, skip: "already_called_this_bar", setup: s };
  if (tgReady) {
    const edge = s.side === "sell" ? "top" : "bottom";
    await sendTelegram([
      `↔️ <b>Sideways market — range ${s.side === "sell" ? "SELL" : "BUY"}</b>`,
      `Gold has been ranging ${fmt(s.low)}–${fmt(s.high)} for 24h with no hourly trend. Price just rejected the ${edge} of it.`,
      enterMsg(s.side, "intraday", { ...zone, stop: s.stop, tp1: s.tp1, tp2: s.tp2, tp3: null }, px, true),
      `TP1 is the middle of the range, TP2 the far side. The idea is wrong if gold closes beyond ${fmt(s.side === "sell" ? s.high : s.low)} and keeps going — the stop sits past it. Aggressive accounts only.`,
    ].join("\n"));
  }
  try { await placeGenxGold({ side: s.side, entryLow: zone.entry_low, entryHigh: zone.entry_high, stop: s.stop, tp: s.tp1, conservativeOk: false, confidence: null, mode: "intraday", setup: "range_fade" }); } catch { /* best-effort */ }
  try { await placeGenxFollower({ signalKey: dedupeKey, side: s.side, entryLow: zone.entry_low, entryHigh: zone.entry_high, stop: s.stop, tp: s.tp1, conservativeOk: false, confidence: null, mode: "intraday", setup: "range_fade" }); } catch { /* best-effort */ }
  sent.push(`intraday:RANGE_FADE_${s.side.toUpperCase()}`);
  return { ...base, result: "called", setup: s };
}
