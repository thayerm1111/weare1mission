import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { gateCredits, chargeCredit } from "@/lib/credits";
import { isPriorityEmail } from "@/lib/marketData";
import { computeGenxRead, buildGenx, GOLD, MODES, type Mode } from "@/lib/genxCompute";
import { confirmEntry } from "@/lib/genxConfirm";
import { decideEntry, type ConfirmSignal } from "@/lib/entryEngine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GENX — flagship XAUUSD / Gold decision engine (on-demand read).
 *
 * The deterministic engine (via computeGenxRead + buildGenx in @/lib/genxCompute)
 * owns every number; the AI writes ONLY the "market story" and can never invent or
 * move a value. The exact same compute powers the automated scanner
 * (/api/cron/genx-scan) so an alerted signal matches what the member sees.
 */

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.OM_AI_MODEL || "claude-sonnet-4-6";
const ENGINE_VERSION = "genx-1.0";
const PROMPT_VERSION = "genx-story-1.0";

const GOLD_PERSONALITY =
  "Gold (XAU/USD) has wide volatility, aggressive stop-hunts, large wicks and fake breakouts; Asian accumulation, London expansion, New York reversals. It reacts to USD macro (Fed/FOMC, CPI/PCE, NFP), Treasury yields and safe-haven flows.";

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export async function POST(req: NextRequest) {
  // ── Auth ──
  const supabase = createClient();
  let fresh = false; let userId: string | null = null;
  if (supabase) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
    userId = user.id;
    fresh = isPriorityEmail(user.email);
  }
  const aiKey = process.env.ANTHROPIC_API_KEY;
  const mdKey = process.env.TWELVEDATA_API_KEY;
  if (!mdKey) return json({ notConfigured: "marketdata" }, 200);

  // ── Mode ──
  let body: { mode?: unknown } = {};
  try { body = await req.json(); } catch { /* default quick */ }
  const mode: Mode = body.mode === "intraday" || body.mode === "swing" ? body.mode : "quick";
  const m = MODES[mode];
  const TD = GOLD.symbol;

  // ── Credits (gate before spending data) ──
  const gate = await gateCredits("genx");
  if (!gate.ok && gate.reason === "unauthorized") return json({ error: "unauthorized" }, 401);
  if (!gate.ok && gate.reason === "insufficient") return json({ error: "insufficient_credits", balance: gate.balance }, 402);

  // ── Layers 1+2+4: deterministic read ──
  const rr = await computeGenxRead({ mode, mdKey, fresh });
  if (!rr.ok) {
    if (rr.error === "ratelimit") return json({ error: "ratelimit", detail: "Gold market-data limit hit for a moment — give it a minute and run again." }, 429);
    if (rr.error === "insufficient_data") return json({ error: "insufficient_data", detail: "Not enough recent Gold candles to analyze right now — try again shortly." }, 200);
    if (rr.error === "marketdata_error") return json({ error: "marketdata_error", detail: "Couldn't read a live Gold price right now — try again shortly." }, 502);
    return json({ error: rr.error, detail: rr.detail }, rr.status ?? 500);
  }
  const read = rr.read;

  // ── Layer 3: AI writes the MARKET STORY only (numbers locked) ──
  let marketStory: string[] = [];
  if (aiKey && read.state !== "INSUFFICIENT_DATA" && read.state !== "DATA_UNAVAILABLE") {
    try {
      const sys = `You are GENX, an elite XAUUSD (Gold) desk narrator. You are handed a FINAL, LOCKED analysis object a deterministic engine already produced. Your ONLY job: write "WHAT GOLD IS DOING RIGHT NOW" as 3–6 short, plain-English sentences a beginner understands. You MUST NOT change, recompute, invent or add any number, price, level, score, direction or target. Never claim to have checked news. Describe: what Gold has been doing, what it is doing now, whether buyers or sellers have the edge, how much room there is before the next level, and the most likely next move. Gold character: ${GOLD_PERSONALITY}. Educational only — no guarantees. Return ONLY a JSON array of strings.`;
      const r = await fetch(ANTHROPIC_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": aiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: MODEL, max_tokens: 500, system: sys, messages: [{ role: "user", content: `LOCKED ANALYSIS JSON:\n${JSON.stringify(read)}\n\nReturn the JSON array of sentences now.` }] }),
      });
      const j = await r.json();
      const rawTxt = Array.isArray(j?.content) ? j.content.filter((b: { type?: string }) => b?.type === "text").map((b: { text?: string }) => b.text ?? "").join("") : "";
      const mm = rawTxt.match(/\[[\s\S]*\]/);
      if (mm) { const a = JSON.parse(mm[0]); if (Array.isArray(a)) marketStory = a.map(String).slice(0, 6); }
    } catch { /* fall back to engine reason below */ }
  }
  if (!marketStory.length) {
    marketStory = [String(read.reason ?? ""), String(read.headline ?? "")].filter(Boolean);
  }

  // ── Decision mapping → GENX result (all numbers from the engine) ──
  const genx = buildGenx(read, { mode, price: rr.price, session: rr.session, dataStatus: rr.dataStatus, hold: m.hold, triggerTf: m.triggerTf, contextTf: m.contextTf, pip: GOLD.pip, dec: GOLD.dec, marketStory, volatility: rr.volatility, atr: rr.atr, m15: rr.m15, nowMs: rr.nowMs });

  // ── FLOW Entry Engine: run the live candle-close confirmation and fold it into
  // the entry decision so the on-demand read can reach a true ENTER_NOW (not just
  // the distance-based ARMED). Same confirmEntry rule the scanner + alerts use. ──
  try {
    const side: "buy" | "sell" = genx.directional_bias === "bearish" ? "sell" : "buy";
    if (genx.entry_low != null && genx.entry_high != null && genx.invalidation_price != null && genx.engine_state !== "NO_TRADE") {
      const conf = await confirmEntry({
        side,
        entryLow: genx.entry_low as number,
        entryHigh: genx.entry_high as number,
        watch: (genx.entry as number) ?? (genx.entry_low as number),
        invalidation: genx.invalidation_price as number,
        mode, mdKey, fresh,
      });
      const map: Record<string, ConfirmSignal> = { WAIT: "WAIT", AT_ZONE: "AT_ZONE", CONFIRMED: "CONFIRMED", INVALIDATED: "INVALIDATED", BUSY: "NONE", NO_DATA: "NONE" };
      const signal: ConfirmSignal = map[conf.state] ?? "NONE";
      if (signal !== "NONE") {
        genx.entry_engine = decideEntry({
          side, engineState: genx.engine_state, action: genx.action, edgeScore: genx.confidence_score,
          preferredEntry: genx.entry, entryLow: genx.entry_low, entryHigh: genx.entry_high,
          invalidation: genx.invalidation_price, tp1: genx.tp1, currentPrice: rr.price, atr: rr.atr,
          pip: GOLD.pip, dec: GOLD.dec, mode, triggerTf: m.triggerTf, nowMs: rr.nowMs,
          confirm: { state: signal, confirmedAtMs: signal === "CONFIRMED" ? rr.nowMs : null },
        });
        (genx as Record<string, unknown>).entry_confirm = { state: conf.state, detail: conf.detail, interval: conf.interval };
      }
    }
  } catch { /* confirm is best-effort; entry_engine already has a distance-based decision */ }

  // Charge only when GENX produces an actionable read.
  const chargeable = read.state === "TRADE_READY" || read.state === "DEVELOPING_SETUP" || read.state === "WATCHLIST";
  if (chargeable) await chargeCredit("genx");

  // ── Immutable signal recording (spec §27). Non-blocking. ──
  let signalId: string | null = null;
  try {
    const admin = createAdminClient();
    if (admin) {
      const rec = {
        user_id: userId,
        symbol: TD,
        mode,
        action: genx.action,
        direction: genx.directional_bias,
        entry: genx.entry, entry_low: genx.entry_low, entry_high: genx.entry_high,
        stop_loss: genx.stop_loss, tp1: genx.tp1, tp2: genx.tp2, tp3: genx.tp3,
        stop_pips: genx.stop_pips, tp1_pips: genx.tp1_pips, tp2_pips: genx.tp2_pips, tp3_pips: genx.tp3_pips,
        confidence: genx.confidence_score,
        market_regime: genx.market_regime,
        market_structure: genx.market_structure,
        momentum: genx.momentum,
        closest_support: genx.closest_support,
        closest_resistance: genx.closest_resistance,
        setup_type: genx.setup_type,
        status: genx.lifecycle,
        reasoning: genx,
        market_snapshot: { price: rr.price, session: rr.session, data_status: rr.dataStatus, asOf: rr.nowIso, candles_tf: m.tf.m15 },
        model_version: MODEL, prompt_version: PROMPT_VERSION, engine_version: ENGINE_VERSION,
      };
      const { data, error } = await admin.from("genx_signals").insert(rec).select("id").single();
      if (!error && data) signalId = (data as { id: string }).id;
    }
  } catch { /* recording is best-effort; never block the read */ }

  return json({
    ok: true, signal_id: signalId, asOf: rr.nowIso, session: rr.session, symbol: TD, mode,
    price: rr.price, data_status: rr.dataStatus, engine_version: ENGINE_VERSION,
    genx, candles: rr.candles,
    engine: read,
  }, 200);
}
