import { type NextRequest } from "next/server";
import { authedContext } from "@/lib/supabase/bearer";
import { gateCredits, chargeCredit } from "@/lib/credits";
import { series, livePrice, livePriceSane } from "@/lib/marketData";
import { closedBars, mtfAlign } from "@/lib/mtf";
import {
  PAIRS, SCALP_SYMBOLS, STRATEGY_VERSION, CONFIG_VERSION,
  classifyRegime, findSetup, buildTargets, scoreSetup, sessionOf, spreadFor, round, pips, fingerprint,
  type ScalpSignal, type Decision, type ConfidenceLabel, type TakeProfit, type SessionKey,
} from "@/lib/scalp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.OM_AI_MODEL || "claude-sonnet-4-6";

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
const arr = (x: unknown) => (Array.isArray(x) ? (x as never[]) : null);

/**
 * OM SCALP — on-demand analysis for one instrument.
 * Layer 1 (this route + lib/scalp.ts) computes EVERY number deterministically.
 * Layer 2 (Claude) only turns the finished object into prose; it cannot change
 * a level, score, direction or the decision. NO_TRADE is the default result.
 */
export async function POST(req: NextRequest) {
  const nowIso = new Date().toISOString();
  const { supabase, user } = await authedContext(req);
  const mdKey = process.env.TWELVEDATA_API_KEY;
  const aiKey = process.env.ANTHROPIC_API_KEY;
  if (!mdKey) return json({ error: "notConfigured", reason: "Live market data isn't connected." }, 200);

  let body: { symbol?: string };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const symbol = String(body?.symbol || "").toUpperCase();
  const cfg = PAIRS[symbol];
  if (!cfg) return json({ error: "unknown_symbol", reason: `Supported: ${SCALP_SYMBOLS.join(", ")}` }, 400);

  const gate = await gateCredits("signal", supabase);
  if (!gate.ok && gate.reason === "unauthorized") return json({ error: "unauthorized" }, 401);
  if (!gate.ok && gate.reason === "insufficient") return json({ error: "insufficient_credits", balance: gate.balance }, 402);

  // ── Verified market data: 4H context, 1H/30m/15m stack, 5m trigger ─────────
  const [r4, r1, r30, r15, r5, price] = await Promise.all([
    series(cfg.td, "4h", 60, mdKey),
    series(cfg.td, "1h", 120, mdKey),
    series(cfg.td, "30min", 120, mdKey),
    series(cfg.td, "15min", 120, mdKey),
    series(cfg.td, "5min", 120, mdKey),
    livePrice(cfg.td, mdKey),
  ]);
  if ([r4, r1, r30, r15, r5].some((x) => x === "ratelimit")) {
    return json({ error: "ratelimit", reason: "Market-data limit hit for a moment — try again shortly." }, 429);
  }
  // Closed candles only (drop the forming bar — no look-ahead).
  const h4 = closedBars(arr(r4), 25), h1 = closedBars(arr(r1), 30), m30 = closedBars(arr(r30), 25), m15 = closedBars(arr(r15), 30), m5 = closedBars(arr(r5), 25);
  const session = sessionOf(new Date());
  const spreadPips = spreadFor(cfg, session);
  const dataTs = m5 && m5.length ? new Date((m5[m5.length - 1].datetime || "").replace(" ", "T") + "Z").toISOString() : null;

  // Base object (mutated as gates run). NO_TRADE-first: levels stay null until earned.
  const sig: ScalpSignal = {
    decision: "NO_TRADE", symbol, direction: "NONE", timestampUtc: nowIso, dataTimestampUtc: dataTs,
    setupFamily: "None", regime: "Unclear / conflicting", score: 0, confidenceLabel: "REJECTED",
    entryType: "NONE", entryZone: { low: null, high: null }, currentPrice: price != null ? round(price, cfg) : null,
    stopLoss: null, takeProfits: [], invalidation: "", expiresAtUtc: null, maximumChasePrice: null,
    spreadStatus: `~${spreadPips.toFixed(1)} pips (estimated)`, sessionStatus: sessionLabel(session), newsStatus: "UNVERIFIED — no economic-calendar feed connected",
    mtf: [], passedConditions: [], failedConditions: [], vetoes: [], scoreBreakdown: [], riskWarnings: [
      "Analysis & education only — not financial advice and not an auto-trader. You decide whether to trade.",
      "Spreads shown are conservative ESTIMATES; your broker's live spread/slippage may differ.",
    ],
    explanation: "", fingerprint: "", strategyVersion: STRATEGY_VERSION, configVersion: CONFIG_VERSION, dataSource: "Twelve Data",
  };

  // ── Hard data-quality gate ────────────────────────────────────────────────
  const missing: string[] = [];
  if (!h4) missing.push("4H"); if (!h1) missing.push("1H"); if (!m30) missing.push("30m"); if (!m15) missing.push("15m"); if (!m5) missing.push("5m");
  if (missing.length) { sig.vetoes.push(`Required timeframe(s) unavailable: ${missing.join(", ")}`); return finish(sig, aiKey); }
  const sane = livePriceSane(price, m5!);
  const px = price != null && sane.ok ? price : (sane.reference ?? null);
  if (px == null) { sig.vetoes.push("Current price could not be verified against recent candles"); return finish(sig, aiKey); }
  sig.currentPrice = round(px, cfg);
  // Staleness: newest 5m bar must be recent while the session is liquid.
  if (dataTs) {
    const ageMin = (Date.now() - Date.parse(dataTs)) / 60000;
    if (ageMin > 20 && session !== "rollover") { sig.vetoes.push(`Market data is stale (~${Math.round(ageMin)} min old)`); return finish(sig, aiKey); }
  }
  sig.passedConditions.push("Data fresh & all timeframes loaded");

  // ── Regime + execution-stack alignment (context, not an auto-entry) ────────
  const regime = classifyRegime(h1!, m15!);
  sig.regime = regime.regime;
  const mtf = mtfAlign([{ tf: "1H", rows: h1 }, { tf: "30m", rows: m30 }, { tf: "15m", rows: m15 }]);
  sig.mtf = mtf.byTf;
  const mtfDir = mtf.dir === "LONG" ? "BUY" : mtf.dir === "SHORT" ? "SELL" : null;

  if (regime.regime === "Unclear / conflicting" || regime.regime.includes("disorder")) {
    sig.failedConditions.push(`Regime is ${regime.regime.toLowerCase()} — no qualified environment`);
    return finish(sig, aiKey);
  }
  sig.passedConditions.push(`Regime: ${regime.regime}`);

  // ── Setup family (only the four approved models can qualify) ───────────────
  const cand = findSetup(cfg, regime, mtfDir, h1!, m15!, m5!, px);
  if (!cand) { sig.failedConditions.push("No approved setup family present (pullback / sweep / breakout-retest / range)"); return finish(sig, aiKey); }
  sig.setupFamily = cand.family;
  sig.direction = cand.direction;

  const entry = cand.ideal;
  const { tps, obstacle } = buildTargets(cand, cfg, m15!, entry);
  const risk = Math.abs(entry - cand.stop) || cfg.minStopPips * cfg.pip;
  const spreadPrice = spreadPips * cfg.pip;
  const rr = (tp: number) => (Math.abs(tp - entry) - spreadPrice) / (risk + spreadPrice);
  const rr1 = rr(tps[0]);
  const rrMain = rr(tps[1]);
  const mtfAligned = mtfDir === cand.direction;

  // ── Score (before vetoes) ─────────────────────────────────────────────────
  const newsClear = false; // no feed → cannot assert "clear"; treated as unverified (score & alert impact)
  const { score, breakdown } = scoreSetup(cfg, regime, cand, mtfAligned, spreadPips, session, newsClear, rrMain);
  sig.score = score; sig.scoreBreakdown = breakdown;

  // ── Hard vetoes ───────────────────────────────────────────────────────────
  const stopPips = pips(entry, cand.stop, cfg);
  const stopWrongSide = (cand.direction === "BUY" && cand.stop >= entry) || (cand.direction === "SELL" && cand.stop <= entry);
  if (stopWrongSide) sig.vetoes.push("Stop resolved on the wrong side of entry — invalid structure, rejecting");
  if (spreadPips > cfg.maxSpreadPips) sig.vetoes.push(`Spread too wide (est. ${spreadPips.toFixed(1)} > max ${cfg.maxSpreadPips} pips)`);
  if (cfg.restrictedSessions.includes(session)) sig.vetoes.push(`Restricted session for ${cfg.label} (${sessionLabel(session)})`);
  if (stopPips < cfg.minStopPips) sig.vetoes.push(`Stop too tight (${stopPips.toFixed(1)} < min ${cfg.minStopPips} pips for the pair)`);
  if (rrMain < cfg.minRRmain) sig.vetoes.push(`Reward-to-risk after costs is only ${rrMain.toFixed(2)}R (min ${cfg.minRRmain}R)`);
  if (cand.entryType === "MARKET" && pips(px, entry, cfg) > cfg.maxChasePips) sig.vetoes.push(`Entry would chase (${pips(px, entry, cfg).toFixed(1)} pips past the level, max ${cfg.maxChasePips})`);
  if (obstacle != null) {
    const obstacleBeforeTp1 = cand.direction === "BUY" ? obstacle < tps[0] && obstacle > entry : obstacle > tps[0] && obstacle < entry;
    if (obstacleBeforeTp1) sig.vetoes.push(`Opposing structure at ${round(obstacle, cfg)} sits before TP1 — not enough clean room`);
  }
  if (!mtfAligned) sig.vetoes.push(`Execution stack not aligned with the setup (${mtf.label})`);

  // ── Decision ──────────────────────────────────────────────────────────────
  // Conditions summary for the UI.
  sig.passedConditions.push(`${cand.family} identified`);
  if (mtfAligned) sig.passedConditions.push(`1H/30m/15m aligned ${cand.direction}`); else sig.failedConditions.push(`Stack not aligned (${mtf.label})`);
  if (cand.triggerOk) sig.passedConditions.push("5m execution trigger present"); else sig.failedConditions.push("No clean 5m trigger yet");
  if (rrMain >= cfg.minRRmain) sig.passedConditions.push(`Reward ~${rrMain.toFixed(1)}R after est. costs`); else sig.failedConditions.push(`Reward only ${rrMain.toFixed(2)}R after costs`);
  if (spreadPips <= cfg.maxSpreadPips) sig.passedConditions.push(`Spread OK (est. ${spreadPips.toFixed(1)} pips)`);
  sig.riskWarnings.push("News status is UNVERIFIED (no economic-calendar feed). Check the calendar before trading.");

  if (sig.vetoes.length > 0) {
    sig.decision = "NO_TRADE"; sig.confidenceLabel = "REJECTED"; sig.direction = "NONE"; sig.setupFamily = cand.family;
    sig.entryType = "NONE"; sig.stopLoss = null; sig.takeProfits = [];
    return finish(sig, aiKey);
  }

  // Passed all vetoes → grade by score. Public-alert threshold is applied by the
  // notifier, not here; on-demand analysis surfaces WATCHLIST too.
  let decision: Decision, label: ConfidenceLabel;
  if (score >= 90) { decision = "TRADE"; label = "ELITE"; }
  else if (score >= 85) { decision = "TRADE"; label = "QUALIFIED"; }
  else if (score >= 80) { decision = "WATCHLIST"; label = "WATCHLIST"; }
  else { decision = "NO_TRADE"; label = "REJECTED"; sig.failedConditions.push(`Score ${score} is below the 80 standard`); }

  sig.decision = decision; sig.confidenceLabel = label;
  if (decision === "NO_TRADE") { sig.direction = "NONE"; sig.entryType = "NONE"; return finish(sig, aiKey); }

  // Populate the trade levels (TRADE / WATCHLIST only).
  sig.entryType = cand.entryType;
  sig.entryZone = { low: round(Math.min(cand.entryLow, cand.entryHigh), cfg), high: round(Math.max(cand.entryLow, cand.entryHigh), cfg) };
  sig.stopLoss = round(cand.stop, cfg);
  const tp: TakeProfit[] = tps.slice(0, 3).map((p, i) => ({ label: `TP${i + 1}`, price: round(p, cfg), rMultiple: +rr(p).toFixed(2) }));
  sig.takeProfits = tp;
  sig.invalidation = cand.invalidation;
  sig.maximumChasePrice = round(cand.direction === "BUY" ? entry + cfg.maxChasePips * cfg.pip : entry - cfg.maxChasePips * cfg.pip, cfg);
  sig.expiresAtUtc = new Date(Date.now() + cfg.expiryMin * 60000).toISOString();
  const day = nowIso.slice(0, 10);
  sig.fingerprint = fingerprint(symbol, cand.direction, cand.family, entry, day);

  return finish(sig, aiKey, cand.reasons);
}

function sessionLabel(s: SessionKey): string {
  return { asian: "Asian (Tokyo)", london: "London", overlap: "London / New York overlap", ny: "New York", rollover: "Rollover / illiquid" }[s];
}

// ── Layer 2: Claude explains the finished object (never edits a number) ─────
async function finish(sig: ScalpSignal, aiKey: string | undefined, reasons: string[] = []): Promise<Response> {
  await chargeCredit("signal");
  sig.explanation = deterministicExplain(sig, reasons);
  if (aiKey) {
    try {
      const system = `You are the explanation layer for a deterministic scalping engine. You are given a FINAL, LOCKED JSON decision. Your ONLY job is to write a short, plain-English explanation (3–5 sentences) a trader can read fast. You MUST NOT change or restate different numbers, MUST NOT invent data, MUST NOT upgrade a NO_TRADE into a trade, and MUST NOT claim a win probability. If decision is NO_TRADE or WATCHLIST, explain plainly why it does not meet the standard and what would need to change. Return ONLY the explanation text, no JSON, no preamble.`;
      const r = await fetch(ANTHROPIC_URL, {
        method: "POST", headers: { "content-type": "application/json", "x-api-key": aiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: MODEL, max_tokens: 320, system: [{ type: "text", text: system }], messages: [{ role: "user", content: JSON.stringify(sig) }] }),
      });
      const j = await r.json().catch(() => null);
      const t = j?.content?.find?.((c: { type?: string; text?: string }) => c.type === "text")?.text;
      if (typeof t === "string" && t.trim()) sig.explanation = t.trim();
    } catch { /* keep deterministic explanation */ }
  }
  return json(sig, 200);
}

function deterministicExplain(sig: ScalpSignal, reasons: string[]): string {
  if (sig.decision === "NO_TRADE") {
    const why = sig.vetoes[0] || sig.failedConditions[0] || "conditions do not meet the required standard";
    return `NO TRADE — ${sig.symbol}. ${why}. The engine only calls a trade when a qualified setup, an aligned 1H/30m/15m stack, a real location edge and enough reward after estimated costs are all present. ${sig.newsStatus}.`;
  }
  const tp1 = sig.takeProfits[0]?.price;
  const r = reasons.slice(0, 2).join("; ");
  return `${sig.decision} — ${sig.symbol} ${sig.direction} (${sig.setupFamily}, score ${sig.score}). ${r}. Entry ${sig.entryZone.low ?? "—"}–${sig.entryZone.high ?? "—"}, stop ${sig.stopLoss}, first target ${tp1} (${sig.takeProfits[0]?.rMultiple}R after est. costs). Invalidation: ${sig.invalidation}. ${sig.newsStatus}.`;
}
