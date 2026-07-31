import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { gateCredits, chargeCredit } from "@/lib/credits";
import { reserveMarketData, resolveTd } from "@/lib/marketData";
import { createHash } from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 45;

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.OM_AI_MODEL || "claude-sonnet-4-6";

/**
 * TRADE CHAT — talk to the AI about a SPECIFIC open trade.
 *
 * The member opens a conversation right on the signal card. Every message, the
 * engine re-reads the LIVE market for that instrument, computes exactly where the
 * trade stands (price, R, profit/drawdown, distance to stop & next target, flow,
 * momentum, stop-run vs real break), and hands those LOCKED numbers to the model
 * so it can coach like a professional desk mentor — grounded in real data, never
 * inventing a price or a news headline.
 *
 * Posture: direct and useful. It will give a clear lean on breakeven, partials,
 * trailing, holding vs closing, and where the idea is invalidated. On averaging
 * into a loser / martingale it tells the truth (that's how accounts blow up) and
 * steers to disciplined risk — it never sizes or endorses doubling a loser.
 *
 * Persisted per trade (trade_key) so the conversation survives refresh. Each
 * question costs 1 credit; loading history is free.
 */

type Row = { datetime: string; open: string; high: string; low: string; close: string };
type Trend = "bullish" | "bearish" | "ranging";
const numOk = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

const tms = (s: string): number => {
  if (!s) return NaN;
  const iso = s.includes("T") ? s : s.replace(" ", "T");
  const t = Date.parse(/([zZ]|[+-]\d\d:?\d\d)$/.test(iso) ? iso : iso + "Z");
  return Number.isFinite(t) ? t : NaN;
};

function sma(v: number[], n: number): number | null { return v.length < n ? null : v.slice(-n).reduce((a, b) => a + b, 0) / n; }
function rsi(c: number[], p = 14): number | null {
  if (c.length < p + 1) return null;
  let g = 0, l = 0;
  for (let i = c.length - p; i < c.length; i++) { const d = c[i] - c[i - 1]; if (d >= 0) g += d; else l -= d; }
  const ag = g / p, al = l / p; if (al === 0) return 100; return 100 - 100 / (1 + ag / al);
}
function trendOf(rows: Row[] | null): Trend {
  if (!rows || rows.length < 20) return "ranging";
  const c = rows.map((v) => +v.close), p = c[c.length - 1], s20 = sma(c, 20), s50 = sma(c, 50);
  if (!s20 || !s50) return "ranging";
  return p > s20 && s20 > s50 ? "bullish" : p < s20 && s20 < s50 ? "bearish" : "ranging";
}
async function fetchSeries(td: string, interval: string, size: number, key: string, since?: string): Promise<Row[] | "ratelimit" | null> {
  const { fetchTd, scale } = resolveTd(td);
  try {
    const sd = since ? `&start_date=${encodeURIComponent(since)}` : "";
    const r = await fetch(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(fetchTd)}&interval=${interval}&outputsize=${size}${sd}&timezone=UTC&apikey=${key}`, { cache: "no-store" });
    const j = await r.json();
    if (j.status === "error" || !Array.isArray(j.values)) {
      const msg = String(j?.message || "");
      if (r.status === 429 || j?.code === 429 || /credit|limit|per minute/i.test(msg)) return "ratelimit";
      return null;
    }
    const rows = [...(j.values as Row[])].reverse();
    if (scale === 1) return rows;
    const m = (x: string) => String(Number(x) * scale);
    return rows.map((v) => ({ ...v, open: m(v.open), high: m(v.high), low: m(v.low), close: m(v.close) }));
  } catch { return null; }
}
async function livePrice(td: string, key: string): Promise<number | null> {
  const { fetchTd, scale } = resolveTd(td);
  try { const r = await fetch(`https://api.twelvedata.com/price?symbol=${encodeURIComponent(fetchTd)}&apikey=${key}`, { cache: "no-store" }); const j = await r.json(); const p = Number(j?.price); return Number.isFinite(p) ? p * scale : null; } catch { return null; }
}
const pipSize = (s: string): number => {
  const u = (s || "").toUpperCase();
  if (u.includes("JPY")) return 0.01;
  if (u.includes("XAU") || u.includes("GOLD")) return 0.1;
  if (u.includes("XAG") || u.includes("SILVER")) return 0.01;
  if (/(BTC|ETH|SOL|XRP|DOGE|US30|NAS|NDX|SPX|US100|US500|GER|UK100|DXY)/.test(u)) return 1;
  return 0.0001;
};
// Accept an explicit interval; otherwise map from a style label.
function intervalFor(interval: string, style: string): string {
  if (/^(1min|3min|5min|15min|30min|45min|1h|2h|4h|1day|1week)$/.test(interval)) return interval;
  const s = (style || "").toLowerCase();
  if (s.includes("scalp")) return "15min";
  if (s.includes("swing") || s.includes("daily")) return "1day";
  return "1h";
}

type Trade = { td: string; symbol: string; interval: string; direction: "LONG" | "SHORT"; entry: number; stop: number; tps: number[]; since: string };

// Deterministic key so the same trade always maps to the same conversation.
function tradeKeyOf(t: Trade): string {
  const raw = [t.td, t.direction, t.entry, t.stop, t.tps[0] ?? "", t.since || ""].join("|");
  return createHash("sha256").update(raw).digest("hex").slice(0, 40);
}

// The LOCKED live snapshot of the trade — every number computed here, never by the model.
async function snapshot(t: Trade, mdKey: string): Promise<Record<string, unknown> | { error: string; reason: string }> {
  // Fetch the RECENT series (no start_date) in UTC, then locate the entry inside it.
  // Using start_date made the "since entry" window depend on Twelve Data's date/tz
  // handling, which could pull in candles from BEFORE the trade was issued.
  const [execRes, higherRes] = await Promise.all([
    fetchSeries(t.td, t.interval, 200, mdKey),
    fetchSeries(t.td, t.interval === "1day" ? "1week" : t.interval === "15min" ? "4h" : "1day", 60, mdKey),
  ]);
  if (execRes === "ratelimit") return { error: "ratelimit", reason: "Hit the market-data limit (8/min). Give it a minute and ask again." };
  const rows = Array.isArray(execRes) ? execRes : null;
  if (!rows || rows.length < 3) return { error: "marketdata_error", reason: "Couldn't pull fresh candles for this instrument right now." };

  const closes = rows.map((r) => +r.close);
  const tick = await livePrice(t.td, mdKey);
  const px = tick != null && Math.abs(tick - closes[closes.length - 1]) / closes[closes.length - 1] < 0.05 ? tick : closes[closes.length - 1];
  const pip = pipSize(t.symbol);
  const dec = px >= 1000 ? 2 : px >= 1 ? 4 : 6;
  const f = (n: number) => +n.toFixed(dec);
  const isLong = t.direction === "LONG";
  const risk = Math.abs(t.entry - t.stop) || pip * 10;
  const move = isLong ? px - t.entry : t.entry - px;
  const rNow = move / risk;
  const side = Math.abs(move) < risk * 0.05 ? "flat" : move > 0 ? "profit" : "drawdown";

  // ---- Post-entry window (timezone-robust) -----------------------------------
  // Locate the entry inside the fetched UTC series. The window is TRUSTED only when
  // the series brackets the entry — i.e. there is at least one candle BEFORE the
  // entry time (startIdx > 0). That guarantees we're reading price action AFTER the
  // trade was issued, never the move that set it up. If we can't bracket the entry
  // (just-issued trade, or entry older than the fetched range) we treat it as a
  // FRESH entry and make NO "already hit / already broken" claims.
  const cutoff = t.since ? tms(t.since) : NaN;
  const startIdx = Number.isFinite(cutoff)
    ? rows.findIndex((r) => { const tt = tms(r.datetime); return Number.isFinite(tt) && tt >= cutoff; })
    : -1;
  const bracketed = startIdx > 0;
  const freshEntry = !bracketed;
  // Fresh/untrusted -> EMPTY historical window; excursion is measured entry -> live
  // price only, so a brand-new trade never inherits a pre-entry candle's extremes.
  const sinceRows = bracketed ? rows.slice(startIdx) : [];

  // Max favourable / adverse excursion since entry, seeded at the ENTRY price so a
  // one-candle fresh window still measures entry -> current extremes (never 0).
  let best = t.entry, worst = t.entry;
  for (const c of sinceRows) {
    best = isLong ? Math.max(best, +c.high) : Math.min(best, +c.low);
    worst = isLong ? Math.min(worst, +c.low) : Math.max(worst, +c.high);
  }
  best = isLong ? Math.max(best, px) : Math.min(best, px);
  worst = isLong ? Math.min(worst, px) : Math.max(worst, px);
  const mfeR = (isLong ? best - t.entry : t.entry - best) / risk;
  const maeR = (isLong ? t.entry - worst : worst - t.entry) / risk;

  // A target counts as hit only when the FAVOURABLE excursion actually reached it,
  // and only inside a trusted window. This ties "hit" to real post-entry travel and
  // stays monotonic — a far TP can't read hit unless the nearer ones were.
  const tpR = t.tps.map((tp) => Math.abs(t.entry - tp) / risk);
  const tpTagged = t.tps.map((_, i) => bracketed && mfeR >= tpR[i] - 1e-9);
  const tpsHit = tpTagged.filter(Boolean).length;
  const nextTpIdx = tpTagged.findIndex((h) => !h);
  const nextTp = nextTpIdx >= 0 ? t.tps[nextTpIdx] : t.tps[t.tps.length - 1];

  // Stop "broken on close" — only inside a trusted window, and reconciled with the
  // live state: if the trade is still live and price hasn't passed the stop, a
  // close-beyond-stop reading is stale/pre-entry noise, so we don't report it.
  const pxBeyondStop = isLong ? px <= t.stop : px >= t.stop;
  let stopBrokenClose = bracketed && (isLong ? sinceRows.some((c) => +c.close <= t.stop) : sinceRows.some((c) => +c.close >= t.stop));
  if (stopBrokenClose && !pxBeyondStop && rNow > -0.98) stopBrokenClose = false;

  // A real stop ORDER fills on an intrabar TOUCH of the level, not only on a close
  // beyond it. Track that separately so we never tell a member "your stop wasn't hit"
  // when price actually reached it. NOTE: this is only THIS feed — a member's broker
  // gold feed can wick past the stop (and fill it) without it showing here.
  const stopTouched = pxBeyondStop || (bracketed && (isLong ? sinceRows.some((c) => +c.low <= t.stop) : sinceRows.some((c) => +c.high >= t.stop)));
  const toStopPips = Math.abs(px - t.stop) / pip;
  const nearStop = !stopTouched && (toStopPips <= Math.max(3, (risk / pip) * 0.15) || maeR >= 0.85);

  const beMove = isLong ? px - t.entry : t.entry - px; // >0 means price has moved past breakeven in our favour

  const execTrend = trendOf(rows);
  const higher = trendOf(Array.isArray(higherRes) ? higherRes : null);
  const rsiNow = rsi(closes);
  const want: Trend = isLong ? "bullish" : "bearish";
  const against: Trend = isLong ? "bearish" : "bullish";
  const flowAgainst = execTrend === against || higher === against;

  const last6 = sinceRows.slice(-6);
  const stopRun = isLong ? last6.some((c) => +c.low <= t.stop && +c.close > t.stop) : last6.some((c) => +c.high >= t.stop && +c.close < t.stop);
  const thesis = stopBrokenClose ? "invalidated" : (side === "drawdown" && flowAgainst) || stopRun || stopTouched ? "weakening" : "intact";

  return {
    symbol: t.symbol, direction: t.direction, price: f(px), entry: f(t.entry), stop: f(t.stop),
    take_profits: t.tps.map(f), next_target: f(nextTp), next_target_label: `TP${nextTpIdx >= 0 ? nextTpIdx + 1 : t.tps.length}`,
    r_now: +rNow.toFixed(2), side, pips: +(move / pip).toFixed(1),
    at_or_past_breakeven: beMove >= 0,
    mfe_r: +mfeR.toFixed(2), mae_r: +maeR.toFixed(2),
    to_stop_pips: +toStopPips.toFixed(1),
    to_next_target_pips: +(Math.abs(nextTp - px) / pip).toFixed(1),
    exec_trend: execTrend, higher_trend: higher, rsi: rsiNow != null ? +rsiNow.toFixed(0) : null,
    flow_against_trade: flowAgainst, stop_run: stopRun, stop_broken_close: stopBrokenClose,
    stop_touched: stopTouched, near_stop: nearStop,
    tps_already_hit: tpsHit, fresh_entry: freshEntry, thesis, as_of: rows[rows.length - 1].datetime,
  };
}

const SYSTEM = `You are the OM AI trade coach — a calm, experienced trading desk mentor talking to a member about ONE specific open trade of theirs, live. You speak like a real professional sitting next to them: direct, plain-spoken, confident, never robotic, never a wall of disclaimers.

You are given a LOCKED JSON snapshot of the trade computed from real live market data (current price, R, profit/drawdown, distance to stop and next target, higher-timeframe flow, RSI, whether it was a stop-run vs a real break, whether it's at/past breakeven, MFE/MAE, thesis). Ground EVERYTHING in those numbers.

Rules:
- NEVER invent or change a price, level, or R number — use only what's in the snapshot. If asked something the data can't answer, say so plainly.
- The snapshot describes what THIS market-data feed shows. If "fresh_entry" is true the trade was just issued and is live and un-triggered — answer as if managing a brand-new open position and don't claim targets were reached.
- ORDER FILLS ARE THE BROKER'S CALL, NOT YOURS. The member's own broker/platform is the ONLY source of truth for whether their stop or target actually filled. A stop order fills the instant price TOUCHES the level (an intrabar wick) — it does NOT wait for a candle to close beyond it — and broker XAU/gold feeds routinely differ from this feed by a few tenths to over a dollar, especially on fast wicks. So NEVER state as fact that "the stop was not hit" or "your order didn't fill." At most say what THIS feed shows (e.g. "on my data I don't see price reaching your stop"), and immediately defer to their platform. If "stop_touched" is true, treat the position as stopped out. If "near_stop" is true, warn plainly that the stop may already have filled on their broker even though it isn't showing here.
- If the member says they were stopped out, or shows a closed/stopped position, BELIEVE THEM — do not argue with the snapshot or tell them they're still in the trade. Acknowledge the stop-out, then be useful: was it a wick/stop-run or a decisive break, was the stop placement reasonable, and what to take from it. "tps_already_hit" and "stop_broken_close" describe a decisive close through a level for THESIS purposes only — they are not a claim about whether the member's order filled.
- NEVER invent specific news/economic events. If news might matter, say only that scheduled news can move price like this and to check an economic calendar.
- Be genuinely useful and DIRECT. Give a clear lean with your reasoning tied to the plan + live conditions. Answer questions about moving to breakeven, taking partials, trailing the stop, holding vs closing, and where the idea is invalidated — like a pro would.
- Keep it conversational and tight: a few sentences or short lines, not an essay. Lead with the answer, then the why.

Non-negotiable risk stance — averaging into a loser / martingale / "doubling up" to recover: do NOT endorse it and do NOT give sizing to add to a losing position. Answer the question honestly: adding to a loser is the single most common way retail accounts get wiped; the risk on this trade was defined at entry, and the disciplined options are to hold to the stop, cut early if the thesis is breaking, or wait for a fresh, valid setup — not to double down. Say this plainly, as a mentor protecting their account, then redirect to the real options.

This is educational trade-management coaching, not financial advice; the member manages their own risk.`;

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export async function POST(req: NextRequest) {
  const supabase = createClient();
  if (!supabase) return json({ error: "not_configured" }, 500);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return json({ error: "bad_request" }, 400); }

  const action = b.action === "load" ? "load" : "ask";
  const td = typeof b.td === "string" ? b.td : "";
  const symbol = typeof b.symbol === "string" ? b.symbol : td;
  const direction: "LONG" | "SHORT" = /short|sell/i.test(String(b.direction)) ? "SHORT" : "LONG";
  const entry = Number(b.entry), stop = Number(b.stopLoss);
  const tps = (Array.isArray(b.takeProfits) ? (b.takeProfits as unknown[]).map(Number) : []).filter(numOk);
  const since = typeof b.since === "string" ? b.since : "";
  const interval = intervalFor(typeof b.interval === "string" ? b.interval : "", typeof b.style === "string" ? b.style : "");
  if (!td || !numOk(entry) || !numOk(stop) || tps.length === 0) return json({ error: "bad_request", reason: "Missing trade details." }, 400);

  const trade: Trade = { td, symbol, interval, direction, entry, stop, tps, since };
  const key = tradeKeyOf(trade);

  // Load prior conversation for this trade (RLS scopes to the caller).
  const { data: histRaw } = await supabase
    .from("trade_chats").select("role,content,created_at").eq("trade_key", key)
    .order("created_at", { ascending: true }).limit(40);
  const history = (histRaw || []) as { role: "user" | "assistant"; content: string }[];

  if (action === "load") return json({ ok: true, messages: history }, 200);

  const question = typeof b.question === "string" ? b.question.trim().slice(0, 1000) : "";
  if (!question) return json({ error: "empty_question" }, 400);

  // Credit gate BEFORE the paid work.
  const gate = await gateCredits("chat");
  if (!gate.ok && gate.reason === "unauthorized") return json({ error: "unauthorized" }, 401);
  if (!gate.ok && gate.reason === "insufficient") return json({ error: "insufficient_credits", balance: gate.balance }, 402);

  const aiKey = process.env.ANTHROPIC_API_KEY;
  const mdKey = process.env.TWELVEDATA_API_KEY;
  if (!aiKey || !mdKey) return json({ error: "notConfigured", reason: "The AI or market-data key isn't connected." }, 200);

  const md = await reserveMarketData(2);
  if (!md.ok) return json({ error: "system_busy", reason: "The data desk is busy — try again in a few seconds." }, 429);

  const snap = await snapshot(trade, mdKey);
  if ("error" in snap) return json(snap, 429);

  // Build the conversation: system + prior turns + the new question (with the fresh snapshot attached).
  const priorMsgs = history.slice(-20).map((m) => ({ role: m.role, content: m.content }));
  const userContent = `LIVE TRADE SNAPSHOT (locked, computed from real data):\n${JSON.stringify(snap)}\n\nMy question: ${question}`;
  let reply = "";
  try {
    const r = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": aiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: MODEL, max_tokens: 700,
        system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
        messages: [...priorMsgs, { role: "user", content: userContent }],
      }),
    });
    const j = await r.json();
    if (!r.ok) return json({ error: "ai_error", reason: (j?.error?.message || `status ${r.status}`).slice(0, 200) }, 502);
    reply = Array.isArray(j.content) ? j.content.filter((c: { type?: string }) => c?.type === "text").map((c: { text?: string }) => c.text ?? "").join("").trim() : "";
  } catch { return json({ error: "ai_unreachable" }, 502); }
  if (!reply) return json({ error: "empty_reply" }, 502);

  // Work succeeded → charge, then persist both turns (best-effort).
  const credits = await chargeCredit("chat");
  await supabase.from("trade_chats").insert([
    { user_id: user.id, trade_key: key, role: "user", content: question },
    { user_id: user.id, trade_key: key, role: "assistant", content: reply, meta: snap },
  ]);

  return json({ ok: true, reply, snapshot: snap, credits }, 200);
}
