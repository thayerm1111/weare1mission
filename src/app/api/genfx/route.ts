import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { gateCredits, chargeCredit } from "@/lib/credits";
import { CREDIT_COST } from "@/lib/creditConfig";
import { isPriorityEmail } from "@/lib/marketData";
import { MODES, type Mode } from "@/lib/genxCompute";
import { pairOf, type PairKey } from "@/lib/genfx/pairs";
import { computeGenfxRead, genfxOf, stopRoom } from "@/lib/genfx/compute";
import { readControl, minStopPips } from "@/lib/genfx/control";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GEN FX — the on-demand read for EUR/USD and GBP/JPY. GENX's /api/genx, with the pair as an input.
 *
 * The deterministic engine owns every number; the AI writes only the market story and can never
 * invent or move a value. The scanner runs the same compute, so a call it makes matches what a member
 * sees here.
 *
 * CREDITS. While genfx_control.billing_enabled is off, a read costs nothing. To keep a free read from
 * being an open tap on the AI, each member gets a small daily allowance of AI stories
 * (config.freeStoriesPerDay, 10 by default); past it the read still works and the story is the
 * engine's own summary. With billing on it is priced exactly as GENX is: the "genx" credit feature,
 * gated before the work and charged after it succeeds, free on the FLOW Pass.
 */
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.OM_AI_MODEL || "claude-sonnet-4-6";
const ENGINE_VERSION = "genfx-1.0";
const PROMPT_VERSION = "genfx-story-1.0";

const PERSONALITY: Record<PairKey, string> = {
  EURUSD:
    "EUR/USD is the most liquid pair in the world: tight spreads, orderly trends in London and the London/New York overlap, slow drifts in Asia. It reacts to ECB and Fed policy, US CPI/PCE and NFP, euro-area inflation and PMI data, and the gap between US and German yields.",
  GBPJPY:
    "GBP/JPY is a volatile cross with wide daily ranges and sharp reversals. It follows risk appetite and yield differentials, and reacts to Bank of England and Bank of Japan policy, UK inflation and growth data, moves in US yields and the risk of Japanese intervention. It is most active from the Tokyo close through London.",
};

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export async function POST(req: NextRequest) {
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

  let body: { mode?: unknown; pair?: unknown } = {};
  try { body = await req.json(); } catch { /* validated below */ }
  const pair = pairOf(body.pair);
  if (!pair) return json({ error: "bad_request", detail: "Pick EUR/USD or GBP/JPY." }, 400);
  const mode: Mode = body.mode === "intraday" || body.mode === "swing" ? body.mode : "quick";
  const m = MODES[mode];

  const admin = createAdminClient();
  const ctl = await readControl(admin);

  // Credits — only when the owner has switched GEN FX billing on.
  if (ctl.billing) {
    const gate = await gateCredits("genx");
    if (!gate.ok && gate.reason === "unauthorized") return json({ error: "unauthorized" }, 401);
    if (!gate.ok && gate.reason === "insufficient") return json({ error: "insufficient_credits", balance: gate.balance }, 402);
  }

  const rr = await computeGenfxRead({ pair, mode, mdKey, fresh });
  if (!rr.ok) {
    if (rr.error === "ratelimit") return json({ error: "ratelimit", detail: `${pair.name} market-data limit hit for a moment — give it a minute and run again.` }, 429);
    if (rr.error === "insufficient_data") return json({ error: "insufficient_data", detail: `Not enough recent ${pair.name} candles to analyze right now — try again shortly.` }, 200);
    if (rr.error === "marketdata_error") return json({ error: "marketdata_error", detail: `Couldn't read a live ${pair.name} price right now — try again shortly.` }, 502);
    return json({ error: rr.error, detail: rr.detail }, rr.status ?? 500);
  }
  const read = rr.read;

  // The AI story. Free reads are capped per member per day; past the cap the engine's own words stand in.
  let storyAllowed = !!aiKey && read.state !== "INSUFFICIENT_DATA" && read.state !== "DATA_UNAVAILABLE";
  if (storyAllowed && !ctl.billing && admin && userId) {
    try {
      const { count } = await admin.from("genfx_signals").select("id", { count: "exact", head: true })
        .eq("user_id", userId).not("model_version", "is", null).gte("created_at", new Date(Date.now() - 24 * 3600_000).toISOString());
      if ((count ?? 0) >= ctl.config.freeStoriesPerDay) storyAllowed = false;
    } catch { /* count unavailable → allow */ }
  }
  let marketStory: string[] = [];
  let storyByAi = false;
  if (storyAllowed) {
    try {
      const sys = `You are GEN FX, an elite ${pair.name} desk narrator. You are handed a FINAL, LOCKED analysis object a deterministic engine already produced. Your ONLY job: write "WHAT ${pair.name} IS DOING RIGHT NOW" as 3–6 short, plain-English sentences a beginner understands. You MUST NOT change, recompute, invent or add any number, price, level, score, direction or target. Never claim to have checked news. Describe: what ${pair.name} has been doing, what it is doing now, whether buyers or sellers have the edge, how much room there is before the next level, and the most likely next move. Pair character: ${PERSONALITY[pair.key]} Educational only — no guarantees. Return ONLY a JSON array of strings.`;
      const r = await fetch(ANTHROPIC_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": aiKey as string, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: MODEL, max_tokens: 500, system: sys, messages: [{ role: "user", content: `LOCKED ANALYSIS JSON:\n${JSON.stringify(read)}\n\nReturn the JSON array of sentences now.` }] }),
      });
      const j = await r.json();
      const rawTxt = Array.isArray(j?.content) ? j.content.filter((b: { type?: string }) => b?.type === "text").map((b: { text?: string }) => b.text ?? "").join("") : "";
      const mm = rawTxt.match(/\[[\s\S]*\]/);
      if (mm) { const a = JSON.parse(mm[0]); if (Array.isArray(a)) { marketStory = a.map(String).slice(0, 6); storyByAi = marketStory.length > 0; } }
    } catch { /* fall back to the engine's reason below */ }
  }
  if (!marketStory.length) marketStory = [String(read.reason ?? ""), String(read.headline ?? "")].filter(Boolean);

  const genfx = genfxOf(pair, read, { mode, price: rr.price, session: rr.session, dataStatus: rr.dataStatus, hold: m.hold, triggerTf: m.triggerTf, contextTf: m.contextTf, marketStory, volatility: rr.volatility, atr: rr.atr });

  // Charge only when the read is actionable, and only with billing on.
  const chargeable = read.state === "TRADE_READY" || read.state === "DEVELOPING_SETUP" || read.state === "WATCHLIST";
  if (ctl.billing && chargeable) await chargeCredit("genx");

  // Would auto-trade take this stop? Said on the card, enforced at placement.
  const room = stopRoom(pair, genfx.entry, genfx.stop_loss, minStopPips(ctl, pair));

  let signalId: string | null = null;
  try {
    if (admin) {
      const { data, error } = await admin.from("genfx_signals").insert({
        user_id: userId, pair: pair.key, symbol: pair.td, mode,
        action: genfx.action, direction: genfx.directional_bias,
        entry: genfx.entry, entry_low: genfx.entry_low, entry_high: genfx.entry_high,
        stop_loss: genfx.stop_loss, tp1: genfx.tp1, tp2: genfx.tp2, tp3: genfx.tp3,
        stop_pips: genfx.stop_pips, tp1_pips: genfx.tp1_pips, tp2_pips: genfx.tp2_pips, tp3_pips: genfx.tp3_pips,
        confidence: genfx.confidence_score,
        market_regime: genfx.market_regime, market_structure: genfx.market_structure, momentum: genfx.momentum,
        closest_support: genfx.closest_support, closest_resistance: genfx.closest_resistance,
        setup_type: genfx.setup_type, status: genfx.lifecycle,
        reasoning: genfx,
        market_snapshot: { price: rr.price, session: rr.session, data_status: rr.dataStatus, asOf: rr.nowIso, candles_tf: m.tf.m15 },
        model_version: storyByAi ? MODEL : null, prompt_version: PROMPT_VERSION, engine_version: ENGINE_VERSION,
      }).select("id").single();
      if (!error && data) signalId = (data as { id: string }).id;
    }
  } catch { /* recording is best-effort; never block the read */ }

  return json({
    ok: true, signal_id: signalId, asOf: rr.nowIso, session: rr.session, pair: pair.key, symbol: pair.td, mode,
    price: rr.price, data_status: rr.dataStatus, engine_version: ENGINE_VERSION,
    genfx, candles: rr.candles, engine: read,
    auto: { minStopPips: room.min, stopPips: room.pips, stopOk: room.ok, costPips: pair.costPips },
    billing: ctl.billing, cost: ctl.billing ? CREDIT_COST.genx : 0,
  }, 200);
}
