import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { gateCredits, chargeCredit } from "@/lib/credits";
import { series, livePrice, isPriorityEmail, livePriceSane } from "@/lib/marketData";
import { runEngine, type EngineCfg, type Row } from "@/lib/omEngine";
import { fetchCalendar, symbolCurrencies } from "@/lib/news/calendar";

// Economic-calendar news for MFX GHOST: the HIGH/Medium-impact events for THIS
// instrument's currencies, from ~2h ago (a just-released print still matters) to the
// next 24h. `when` is human-relative ("in 35m", "20m ago"). Best-effort — returns [] on
// any feed issue so the desk read still renders.
type GhostNews = { title: string; ccy: string; impact: string; ts: number; when: string; forecast: string; previous: string };
async function ghostNews(td: string): Promise<GhostNews[]> {
  try {
    const ccys = symbolCurrencies(td);
    const events = await fetchCalendar();
    const now = Date.now();
    const from = now - 2 * 60 * 60 * 1000;   // include a release from the last 2h
    const to = now + 24 * 60 * 60 * 1000;    // and everything scheduled in the next 24h
    return events
      .filter((e) => e.impact === "High" || e.impact === "Medium")
      .filter((e) => ccys.includes(e.country))
      .filter((e) => e.ts >= from && e.ts <= to)
      .sort((a, b) => a.ts - b.ts)
      .slice(0, 6)
      .map((e) => {
        const mins = Math.round((e.ts - now) / 60000);
        const when = mins <= 0 ? (mins > -120 ? `${-mins}m ago` : "earlier") : mins < 60 ? `in ${mins}m` : `in ${Math.round(mins / 60)}h`;
        return { title: e.title, ccy: e.country, impact: e.impact, ts: e.ts, when, forecast: e.forecast, previous: e.previous };
      });
  } catch { return []; }
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * MFX GHOST — deep single-instrument desk. Rebuilt to the deterministic model:
 * EVERY number (entry, stop, targets, R:R, score, setup zone, proximity) is
 * computed in code by the shared engine; the AI writes ONLY the desk narrative
 * and can never invent or change a level. No timeframe-alignment gate; news is
 * NOT checked (the user is handed the currencies to verify). Each instrument has
 * its own config, with a dedicated gold profile.
 */
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.OM_AI_MODEL || "claude-sonnet-4-6";

type GCfg = EngineCfg & { personality: string };
const GHOST: Record<string, GCfg> = {
  "XAU/USD": { symbol: "XAU/USD", label: "Gold (XAU/USD)", cat: "gold", pip: 0.1, dec: 2, minStopAtr: 0.5, maxStopAtr: 3.5, rrFloor: 2.0, bands: { ready: 78, develop: 66, watch: 56 }, personality: "Gold has wider volatility, aggressive stop-hunts, large wicks and fake breakouts; Asian accumulation, London expansion, New York reversals. It reacts to USD macro (Fed/FOMC, CPI/PCE, NFP), Treasury yields and safe-haven flows." },
  "EUR/USD": { symbol: "EUR/USD", label: "EUR/USD", cat: "forex", pip: 0.0001, dec: 5, minStopAtr: 0.4, maxStopAtr: 3.0, rrFloor: 1.8, bands: { ready: 76, develop: 64, watch: 54 }, personality: "EUR/USD trends cleanly through London/NY on the ECB-vs-Fed differential and DXY; it respects round numbers and prior-day highs/lows and often runs London stops before the real move." },
  "GBP/USD": { symbol: "GBP/USD", label: "GBP/USD", cat: "forex", pip: 0.0001, dec: 5, minStopAtr: 0.4, maxStopAtr: 3.2, rrFloor: 1.8, bands: { ready: 76, develop: 64, watch: 54 }, personality: "Cable is higher-beta than EUR/USD, sensitive to BoE policy and UK data; it expands hard in London and hunts liquidity around session highs/lows." },
  "AUD/USD": { symbol: "AUD/USD", label: "AUD/USD", cat: "forex", pip: 0.0001, dec: 5, minStopAtr: 0.4, maxStopAtr: 3.0, rrFloor: 1.8, bands: { ready: 76, develop: 64, watch: 54 }, personality: "AUD/USD is a risk-on / commodity currency tied to RBA policy, China data and metals; the Asian session often sets the tone, New York drives continuation or reversal." },
  "USD/CAD": { symbol: "USD/CAD", label: "USD/CAD", cat: "forex", pip: 0.0001, dec: 5, minStopAtr: 0.4, maxStopAtr: 3.0, rrFloor: 1.8, bands: { ready: 76, develop: 64, watch: 54 }, personality: "USD/CAD tracks the Fed-vs-BoC differential and crude oil (CAD strengthens when oil rises); it ranges for stretches then trends on oil/data and respects clean structure around big figures." },
  "USD/JPY": { symbol: "USD/JPY", label: "USD/JPY", cat: "forex", pip: 0.01, dec: 3, minStopAtr: 0.4, maxStopAtr: 3.0, rrFloor: 1.8, bands: { ready: 76, develop: 64, watch: 54 }, personality: "USD/JPY is dominated by US-Japan yield differentials and risk sentiment (carry); it trends strongly and is sensitive to MoF/BoJ intervention risk near multi-decade extremes." },
};
const DEFAULT_SYM = "XAU/USD";

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
const arr = (x: unknown): Row[] | null => (Array.isArray(x) ? (x as Row[]) : null);

function londonHour(d: Date): number {
  try { const s = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", hour12: false }).format(d); const h = parseInt(s, 10); return Number.isFinite(h) ? (h === 24 ? 0 : h) : d.getUTCHours(); } catch { return d.getUTCHours(); }
}
function nyHour(d: Date): number {
  try { const s = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false }).format(d); const h = parseInt(s, 10); return Number.isFinite(h) ? (h === 24 ? 0 : h) : d.getUTCHours() - 5; } catch { return d.getUTCHours() - 5; }
}
function sessionNow(d: Date): string {
  const lh = londonHour(d), nh = nyHour(d);
  const londonOpen = lh >= 7 && lh < 16, nyOpen = nh >= 8 && nh < 17;
  if (londonOpen && nyOpen) return "London/NY overlap";
  if (londonOpen) return "London"; if (nyOpen) return "New York";
  if (lh >= 0 && lh < 7) return "Asian"; return "Off-session";
}

export async function POST(req: NextRequest) {
  const supabase = createClient();
  let fresh = false;
  if (supabase) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
    fresh = isPriorityEmail(user.email);
  }
  const aiKey = process.env.ANTHROPIC_API_KEY;
  const mdKey = process.env.TWELVEDATA_API_KEY;
  if (!mdKey) return json({ notConfigured: "marketdata" }, 200);

  let reqBody: { symbol?: unknown } = {};
  try { reqBody = await req.json(); } catch { /* default instrument */ }
  const sym = typeof reqBody.symbol === "string" && GHOST[reqBody.symbol] ? reqBody.symbol : DEFAULT_SYM;
  const cfg = GHOST[sym];
  const TD = cfg.symbol;

  const gate = await gateCredits("ghost");
  if (!gate.ok && gate.reason === "unauthorized") return json({ error: "unauthorized" }, 401);
  if (!gate.ok && gate.reason === "insufficient") return json({ error: "insufficient_credits", balance: gate.balance }, 402);

  const [d1, h4, h1, m30, m15, m5] = await Promise.all([
    series(TD, "1day", 90, mdKey, fresh),
    series(TD, "4h", 80, mdKey, fresh),
    series(TD, "1h", 120, mdKey, fresh),
    series(TD, "30min", 120, mdKey, fresh),
    series(TD, "15min", 120, mdKey, fresh),
    series(TD, "5min", 120, mdKey, fresh),
  ]);
  // Include 30m in the rate-limit guard (fixes a bug where a rate-limited 30m
  // pull silently forced NO_TRADE).
  if ([d1, h4, h1, m30, m15, m5].some((x) => x === "ratelimit")) {
    return json({ error: "ratelimit", detail: "Market-data limit hit for a moment — give it a minute and run again." }, 429);
  }
  const live = await livePrice(TD, mdKey, fresh);
  const refRows = arr(m5) && arr(m5)!.length >= 3 ? arr(m5) : arr(h1);
  const liveOk = livePriceSane(live, refRows as never);
  const fallback = arr(m5)?.length ? +arr(m5)![arr(m5)!.length - 1].close : arr(h1)?.length ? +arr(h1)![arr(h1)!.length - 1].close : null;
  const price = (live != null && liveOk.ok) ? live : (liveOk.reference ?? fallback);
  if (price == null) return json({ error: "marketdata_error", detail: `Couldn't read a live ${cfg.label} price right now — try again shortly.` }, 502);

  const now = new Date();
  const nowMs = now.getTime();
  const session = sessionNow(now);

  // ── Deterministic engine — code owns every number ──
  const read = runEngine(cfg, { d1: arr(d1), h4: arr(h4), h1: arr(h1), m30: arr(m30), m15: arr(m15), m5: arr(m5), price, nowMs, session });
  read.instrument_note = cfg.personality;

  // ── News: the real economic calendar for this instrument's currencies ──
  const news = await ghostNews(TD);
  (read as Record<string, unknown>).news = news;

  // Charge only when we actually deliver something actionable (a trade or a
  // developing setup with a trigger). Watchlist / no-trade / data errors are free.
  const chargeable = read.state === "TRADE_READY" || read.state === "DEVELOPING_SETUP";
  if (chargeable) await chargeCredit("ghost");

  // ── Layer 2: the AI writes the DESK NARRATIVE only (numbers are locked) ──
  if (aiKey && read.state !== "INSUFFICIENT_DATA" && read.state !== "DATA_UNAVAILABLE") {
    try {
      const newsLine = news.length
        ? `NEWS FEED (a REAL economic calendar for ${cfg.label}'s currencies — you MAY reference it, but never invent an event not in this list): ${news.map((n) => `${n.impact}-impact ${n.ccy} "${n.title}" ${n.when}${n.forecast ? ` (forecast ${n.forecast}, prev ${n.previous})` : ""}`).join("; ")}. If a HIGH-impact event is imminent (within ~1h) or just released, call it out and note it can whip the setup; otherwise you may note the calendar looks clear near-term.`
        : `You have NO news for this instrument right now — do NOT claim to have checked news or that it is "clear".`;
      const sys = `You are MFX GHOST's desk-narration layer for ${cfg.label}. You are given a FINAL, LOCKED analysis object that a deterministic engine already produced. Your ONLY job is to write a short institutional "desk read". You MUST NOT change, recompute, or invent any number, level, direction, score or state. Do NOT add price levels that aren't in the JSON. ${newsLine} Instrument character: ${cfg.personality}. Return ONLY a JSON array of 3-5 short plain-English sentences (no markdown) covering: the regime + why this strategy fits, what price is doing / where liquidity sits, any imminent high-impact news, and — if not TRADE READY — what must happen at the setup zone. Educational only.`;
      const r = await fetch(ANTHROPIC_URL, {
        method: "POST", headers: { "content-type": "application/json", "x-api-key": aiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: MODEL, max_tokens: 500, system: sys, messages: [{ role: "user", content: `LOCKED ANALYSIS JSON:\n${JSON.stringify(read)}\n\nReturn the JSON array of desk-read sentences now.` }] }),
      });
      const j = await r.json();
      const raw = Array.isArray(j?.content) ? j.content.filter((b: { type?: string }) => b?.type === "text").map((b: { text?: string }) => b.text ?? "").join("") : "";
      const m = raw.match(/\[[\s\S]*\]/);
      if (m) { const a = JSON.parse(m[0]); if (Array.isArray(a)) read.desk_read = a.map(String).slice(0, 6); }
    } catch { /* deterministic reasoning already present */ }
  }
  if (!read.desk_read) {
    read.desk_read = [
      `${cfg.label}: regime "${read.market_regime ?? read.state}". ${read.reason ?? ""}`.trim(),
      typeof read.headline === "string" ? String(read.headline) : "",
    ].filter(Boolean);
  }

  // ── Backward-compat overlay so the deployed mobile app (which reads the old
  // schema) renders the NEW deterministic numbers without an app rebuild. The
  // website UI reads `dir_side` / `confidence_label`; the app reads `direction`
  // (LONG/SHORT) / `confidence` (number) / `entries` / `stopLoss` / `takeProfits`.
  // No fabricated fields — sections the app no longer has (scorecards/probabilities)
  // are simply omitted. ──
  legacyOverlay(read);

  return json({ ok: true, price, asOf: now.toISOString(), session, symbol: TD, read, candles: read.candles ?? [], strategy_version: "ghost-v3-deterministic" }, 200);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function legacyOverlay(read: Record<string, unknown>): void {
  const r = read as any;
  const side: string | null = r.direction === "buy" ? "buy" : r.direction === "sell" ? "sell" : null;
  r.dir_side = side;                                             // website UI
  r.direction = side === "buy" ? "LONG" : side === "sell" ? "SHORT" : "NONE";  // app UI
  r.confidence_label = typeof r.confidence === "string" ? r.confidence : null; // website UI (label)
  const overall = r.confidence_breakdown?.overall ?? r.scores?.overall;
  r.confidence = typeof overall === "number" ? overall : null;  // app UI (number)

  const pt = r.provisional_trade;
  const eObj = r.entry ?? pt?.entry;
  const slObj = r.stop_loss ?? pt?.stop_loss;
  const tps: number[] = ((r.take_profits ?? pt?.take_profits ?? []) as any[]).map((t) => t?.price).filter((n) => typeof n === "number");
  r.entries = eObj ? { primary: eObj.price ?? null, aggressive: eObj.zone_low ?? eObj.price ?? null, conservative: eObj.zone_high ?? eObj.price ?? null, confirmation: r.trigger?.confirmationRequired ?? "" } : { primary: null, aggressive: null, conservative: null, confirmation: "" };
  r.stopLoss = slObj?.price ?? null;
  r.takeProfits = tps;
  const rr = pt?.risk_reward_tp1 ?? r.rr_tp1;
  r.riskReward = typeof rr === "number" ? `1:${rr}` : "n/a";
  r.decision = r.state === "TRADE_READY" ? "TRADE" : "NO_TRADE";
  r.regime = r.market_regime ?? "";
  r.reasonsToAvoid = Array.isArray(r.what_next) ? r.what_next : [];
  r.invalidation = slObj?.reason ?? (r.setup_zone?.invalidation ?? "");
  r.bias = r.current_bias ?? "";
  r.winningStrategy = r.strategy ?? "";
}
/* eslint-enable @typescript-eslint/no-explicit-any */
