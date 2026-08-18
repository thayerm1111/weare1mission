import { type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { computeGenxRead, buildGenx, GOLD, MODES, type Mode } from "@/lib/genxCompute";
import { confirmEntry } from "@/lib/genxConfirm";
import { sendTelegram, esc } from "@/lib/telegram";

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
  try {
    await admin.from("genx_alerts").update({ state: "expired", updated_at: nowIso })
      .eq("state", "forming").in("mode", ["quick", "intraday"]).lt("created_at", new Date(Date.now() - 8 * 3600e3).toISOString());
    await admin.from("genx_alerts").update({ state: "expired", updated_at: nowIso })
      .eq("state", "forming").eq("mode", "swing").lt("created_at", new Date(Date.now() - 48 * 3600e3).toISOString());
  } catch { /* best effort */ }

  const out: Record<string, unknown> = { modes: {}, sent: [] as string[], tgReady };
  const sent = out.sent as string[];

  for (const mode of ["quick", "intraday", "swing"] as Mode[]) {
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
            state: "entered", heads_up_sent_at: nowIso, enter_sent_at: nowIso, last_checked_at: nowIso,
          });
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
          await admin.from("genx_alerts").update({ state: "entered", enter_sent_at: nowIso, last_checked_at: nowIso, updated_at: nowIso }).eq("id", row.id);
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

export async function GET(req: NextRequest) {
  if (!authorized(req)) return json({ error: "unauthorized" }, 401);
  return run();
}
export async function POST(req: NextRequest) {
  if (!authorized(req)) return json({ error: "unauthorized" }, 401);
  return run();
}
