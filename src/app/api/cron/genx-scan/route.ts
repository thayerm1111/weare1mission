import { type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { computeGenxRead, buildGenx, GOLD, MODES, type Mode } from "@/lib/genxCompute";
import { confirmEntry, CONFIRM_IV } from "@/lib/genxConfirm";
import { series } from "@/lib/marketData";
import { sendTelegram, esc } from "@/lib/telegram";
import { placeGenxGold, placeGenxFollower } from "@/lib/flow/autoExec";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

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

const MODE_LABEL: Record<Mode, string> = { quick: "Quick", intraday: "Intraday", swing: "Swing" };
const r1 = (n: number) => Math.round(n);
const fmt = (n: number | null | undefined) => (typeof n === "number" && Number.isFinite(n) ? n.toFixed(2) : "—");

type AlertRow = {
  id: string; dedupe_key: string; mode: Mode; side: "buy" | "sell"; action: string;
  entry: number | null; entry_low: number | null; entry_high: number | null;
  stop: number | null; tp1: number | null; tp2: number | null; tp3: number | null;
  invalidation: number | null; watch: number | null; confidence: number | null;
  trigger_tf: string | null; state: string; created_at: string;
};

function headsUpMsg(side: "buy" | "sell", mode: Mode, a: { entry_low: number | null; entry_high: number | null; stop: number | null; tp1: number | null; tp2: number | null; confidence: number | null }): string {
  const dir = side === "sell" ? "SELL" : "BUY";
  const zone = a.entry_low != null && a.entry_high != null ? `${fmt(a.entry_low)}–${fmt(a.entry_high)}` : "—";
  const tps = [a.tp1 != null ? `TP1 ${fmt(a.tp1)}` : null, a.tp2 != null ? `TP2 ${fmt(a.tp2)}` : null].filter(Boolean).join(" · ");
  return [
    `⏳ <b>GENX — ${dir} setup forming · ${MODE_LABEL[mode]}</b>`,
    `Gold (XAU/USD)`,
    `Zone: <b>${esc(zone)}</b>`,
    `Stop: ${fmt(a.stop)}${tps ? " · " + esc(tps) : ""}`,
    a.confidence != null ? `Confidence ${a.confidence}/100` : "",
    `Waiting for price to reach the zone and confirm. You'll get an <b>ENTER NOW</b> the moment it triggers.`,
    `<i>Educational, not financial advice.</i>`,
  ].filter(Boolean).join("\n");
}

function enterMsg(side: "buy" | "sell", mode: Mode, a: { entry_low: number | null; entry_high: number | null; stop: number | null; tp1: number | null; tp2: number | null; tp3: number | null }, atPrice: number | null, immediate: boolean): string {
  const dir = side === "sell" ? "SELL" : "BUY";
  const zone = a.entry_low != null && a.entry_high != null ? `${fmt(a.entry_low)}–${fmt(a.entry_high)}` : "—";
  const tps = [a.tp1 != null ? `TP1 ${fmt(a.tp1)}` : null, a.tp2 != null ? `TP2 ${fmt(a.tp2)}` : null, a.tp3 != null ? `TP3 ${fmt(a.tp3)}` : null].filter(Boolean).join(" · ");
  const confirmLine = immediate
    ? `Live setup — Gold is at the zone now.`
    : `${side === "sell" ? "Sellers" : "Buyers"} confirmed on the ${MODE_LABEL[mode] === "Quick" ? "5-minute" : MODE_LABEL[mode] === "Intraday" ? "15-minute" : "1-hour"} close.`;
  return [
    `✅ <b>GENX — ENTER NOW · ${dir} · ${MODE_LABEL[mode]}</b>`,
    `Gold @ ~${fmt(atPrice)}`,
    `Entry ${esc(zone)} · Stop ${fmt(a.stop)}`,
    tps ? esc(tps) : "",
    confirmLine,
    `<i>Educational, not financial advice.</i>`,
  ].filter(Boolean).join("\n");
}

function invalidMsg(side: "buy" | "sell", mode: Mode, a: { entry_low: number | null; entry_high: number | null; invalidation: number | null }): string {
  const dir = side === "sell" ? "SELL" : "BUY";
  const zone = a.entry_low != null && a.entry_high != null ? `${fmt(a.entry_low)}–${fmt(a.entry_high)}` : "the zone";
  return [
    `❌ <b>GENX — Setup invalidated · ${dir} · ${MODE_LABEL[mode]}</b>`,
    `The ${esc(zone)} ${dir.toLowerCase()} is off — price closed beyond ${fmt(a.invalidation)}. Don't take it.`,
  ].join("\n");
}

async function run(): Promise<Response> {
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
  const sent = out.sent as string[];

  // Scalp only for now — the Quick (5-min, 30–80 pip) timeframe. Add "intraday"
  // and "swing" back here to widen coverage later.
  for (const mode of ["quick"] as Mode[]) {
    const modeOut: Record<string, unknown> = {};
    (out.modes as Record<string, unknown>)[mode] = modeOut;
    try {
      const rr = await computeGenxRead({ mode, mdKey, fresh: true });
      if (!rr.ok) { modeOut.skip = rr.error; continue; }
      const genx = buildGenx(rr.read, { mode, price: rr.price, session: rr.session, dataStatus: rr.dataStatus, hold: MODES[mode].hold, triggerTf: MODES[mode].triggerTf, contextTf: MODES[mode].contextTf, pip: GOLD.pip, dec: GOLD.dec, marketStory: [], volatility: rr.volatility, atr: rr.atr, m15: rr.m15 });

      const engineState = String(genx.engine_state || "");
      const actionable = engineState === "TRADE_READY" || engineState === "DEVELOPING_SETUP";
      modeOut.action = genx.action; modeOut.state = engineState; modeOut.conf = genx.confidence_score;
      if (!actionable || genx.entry_low == null || genx.entry_high == null || genx.stop_loss == null) { modeOut.skip = "not_actionable"; continue; }

      const side: "buy" | "sell" = String(genx.action).includes("SELL") ? "sell" : "buy";
      const watch = side === "sell" ? (genx.closest_resistance ?? genx.entry) : (genx.closest_support ?? genx.entry);
      const invalidation = genx.invalidation_price ?? genx.stop_loss;
      const dedupeKey = `${mode}:${side}:${r1(genx.entry_low)}:${r1(genx.entry_high)}`;
      modeOut.dedupe = dedupeKey;

      // Existing alert for this exact setup?
      const { data: existing } = await admin.from("genx_alerts").select("*").eq("dedupe_key", dedupeKey).maybeSingle();
      const row = existing as AlertRow | null;

      const immediate = engineState === "TRADE_READY"; // BUY_NOW / SELL_NOW

      if (!row) {
        // Brand-new setup.
        if (immediate) {
          // Live now → send ENTER NOW straight away.
          if (tgReady) await sendTelegram(enterMsg(side, mode, { entry_low: genx.entry_low, entry_high: genx.entry_high, stop: genx.stop_loss, tp1: genx.tp1, tp2: genx.tp2, tp3: genx.tp3 }, rr.price, true));
          await admin.from("genx_alerts").insert({
            dedupe_key: dedupeKey, mode, side, action: genx.action,
            entry: genx.entry, entry_low: genx.entry_low, entry_high: genx.entry_high,
            stop: genx.stop_loss, tp1: genx.tp1, tp2: genx.tp2, tp3: genx.tp3,
            invalidation, watch, confidence: genx.confidence_score, trigger_tf: genx.trigger_tf,
            state: "entered", enter_price: rr.price, heads_up_sent_at: nowIso, enter_sent_at: nowIso, last_checked_at: nowIso,
          });
          // FLOW copies this gold ENTER NOW to every credited member (once per move).
          try { await placeGenxGold({ side, entryLow: genx.entry_low, entryHigh: genx.entry_high, stop: genx.stop_loss, tp: genx.tp1 }); } catch { /* placement is best-effort */ }
          // FOLLOWER accounts take EVERY GENX signal at a flat 0.01, raw (separate from FLOW).
          try { await placeGenxFollower({ signalKey: dedupeKey, side, stop: genx.stop_loss, tp: genx.tp1 }); } catch { /* follower is best-effort */ }
          sent.push(`${mode}:ENTER(immediate)`); modeOut.result = "enter_immediate";
        } else {
          // Developing → heads-up now, watch for the entry on future ticks.
          if (tgReady) await sendTelegram(headsUpMsg(side, mode, { entry_low: genx.entry_low, entry_high: genx.entry_high, stop: genx.stop_loss, tp1: genx.tp1, tp2: genx.tp2, confidence: genx.confidence_score }));
          await admin.from("genx_alerts").insert({
            dedupe_key: dedupeKey, mode, side, action: genx.action,
            entry: genx.entry, entry_low: genx.entry_low, entry_high: genx.entry_high,
            stop: genx.stop_loss, tp1: genx.tp1, tp2: genx.tp2, tp3: genx.tp3,
            invalidation, watch, confidence: genx.confidence_score, trigger_tf: genx.trigger_tf,
            state: "forming", heads_up_sent_at: nowIso, last_checked_at: nowIso,
          });
          sent.push(`${mode}:HEADSUP`); modeOut.result = "headsup";
        }
        continue;
      }

      // Known setup, still pending → check whether it has confirmed or died.
      if (row.state === "forming") {
        const conf = await confirmEntry({
          side, entryLow: row.entry_low ?? genx.entry_low, entryHigh: row.entry_high ?? genx.entry_high,
          watch: (row.watch ?? watch) as number, invalidation: (row.invalidation ?? invalidation) as number,
          mode, mdKey, fresh: true,
        });
        if (conf.state === "CONFIRMED") {
          if (tgReady) await sendTelegram(enterMsg(side, mode, { entry_low: row.entry_low, entry_high: row.entry_high, stop: row.stop, tp1: row.tp1, tp2: row.tp2, tp3: row.tp3 }, conf.enter ?? conf.price, false));
          await admin.from("genx_alerts").update({ state: "entered", enter_price: conf.enter ?? conf.price, enter_sent_at: nowIso, last_checked_at: nowIso, updated_at: nowIso }).eq("id", row.id);
          try { await placeGenxGold({ side, entryLow: row.entry_low, entryHigh: row.entry_high, stop: row.stop, tp: row.tp1 }); } catch { /* placement is best-effort */ }
          try { await placeGenxFollower({ signalKey: dedupeKey, side, stop: row.stop, tp: row.tp1 }); } catch { /* follower is best-effort */ }
          sent.push(`${mode}:ENTER`); modeOut.result = "enter";
        } else if (conf.state === "INVALIDATED") {
          if (tgReady) await sendTelegram(invalidMsg(side, mode, { entry_low: row.entry_low, entry_high: row.entry_high, invalidation: row.invalidation }));
          await admin.from("genx_alerts").update({ state: "invalidated", last_checked_at: nowIso, updated_at: nowIso }).eq("id", row.id);
          sent.push(`${mode}:INVALID`); modeOut.result = "invalidated";
        } else {
          await admin.from("genx_alerts").update({ last_checked_at: nowIso, updated_at: nowIso }).eq("id", row.id);
          modeOut.result = `pending:${conf.state}`;
        }
      } else {
        modeOut.result = `already:${row.state}`;
      }
    } catch (e) {
      modeOut.error = e instanceof Error ? e.message : "error";
    }
  }

  return json({ ok: true, asOf: nowIso, ...out }, 200);
}

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
async function runWatch(): Promise<Response> {
  const mdKey = process.env.TWELVEDATA_API_KEY;
  if (!mdKey) return json({ error: "no_market_data_key" }, 500);
  const admin = createAdminClient();
  if (!admin) return json({ error: "no_admin_client" }, 500);
  const tgReady = !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHANNEL_ID);
  const nowIso = new Date().toISOString();
  const { data } = await admin.from("genx_alerts").select("*").eq("state", "forming");
  const rows = (data ?? []) as AlertRow[];
  const sent: string[] = [];
  for (const row of rows) {
    try {
      const side = row.side;
      const conf = await confirmEntry({
        side, entryLow: (row.entry_low ?? 0) as number, entryHigh: (row.entry_high ?? 0) as number,
        watch: (row.watch ?? row.entry_low ?? 0) as number, invalidation: (row.invalidation ?? row.stop ?? 0) as number,
        mode: row.mode, mdKey, fresh: true, interval: "1min",
      });
      if (conf.state === "CONFIRMED") {
        if (tgReady) await sendTelegram(enterMsg(side, row.mode, { entry_low: row.entry_low, entry_high: row.entry_high, stop: row.stop, tp1: row.tp1, tp2: row.tp2, tp3: row.tp3 }, conf.enter ?? conf.price, false));
        await admin.from("genx_alerts").update({ state: "entered", enter_price: conf.enter ?? conf.price, enter_sent_at: nowIso, last_checked_at: nowIso, updated_at: nowIso }).eq("id", row.id);
        try { await placeGenxGold({ side, entryLow: row.entry_low, entryHigh: row.entry_high, stop: row.stop, tp: row.tp1 }); } catch { /* placement is best-effort */ }
        // Same dedupe_key scheme the full scan uses, so the follower dedup lines up
        // whether the ENTER NOW fired from the 5-min scan or this 1-min fast-watch.
        try {
          const fKey = (row.entry_low != null && row.entry_high != null) ? `${row.mode}:${side}:${r1(row.entry_low)}:${r1(row.entry_high)}` : `id:${row.id}`;
          await placeGenxFollower({ signalKey: fKey, side, stop: row.stop, tp: row.tp1 });
        } catch { /* follower is best-effort */ }
        sent.push(`${row.mode}:ENTER`);
      } else if (conf.state === "INVALIDATED") {
        if (tgReady) await sendTelegram(invalidMsg(side, row.mode, { entry_low: row.entry_low, entry_high: row.entry_high, invalidation: row.invalidation }));
        await admin.from("genx_alerts").update({ state: "invalidated", last_checked_at: nowIso, updated_at: nowIso }).eq("id", row.id);
        sent.push(`${row.mode}:INVALID`);
      } else {
        await admin.from("genx_alerts").update({ last_checked_at: nowIso, updated_at: nowIso }).eq("id", row.id);
      }
    } catch { /* per-row best effort */ }
  }
  return json({ ok: true, watch: true, asOf: nowIso, checked: rows.length, sent }, 200);
}

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
