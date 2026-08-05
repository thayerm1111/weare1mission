import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { reserveMarketData, resolveTd } from "@/lib/marketData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 45;

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.OM_AI_MODEL || "claude-sonnet-4-6";

type Row = { datetime: string; open: string; high: string; low: string; close: string };
type Trend = "bullish" | "bearish" | "ranging";
const numOk = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
// Parse a Twelve Data / ISO datetime string to epoch ms, assuming UTC when no zone is given.
const tms = (s: string): number => {
  if (!s) return NaN;
  const iso = s.includes("T") ? s : s.replace(" ", "T");
  const t = Date.parse(/([zZ]|[+-]\d\d:?\d\d)$/.test(iso) ? iso : iso + "Z");
  return Number.isFinite(t) ? t : NaN;
};

/**
 * OM AI Plays — "Get Update" on an OPEN call.
 *
 * Re-reads the live market and explains, in plain English, what is happening to
 * THIS specific trade right now: is it in profit or drawdown, how far (in price,
 * pips and R), what the market did since entry (a stop-run / liquidity sweep, a
 * genuine trend flip, a normal pullback, momentum stalling), and whether the
 * original idea is still intact, weakening, or invalidated.
 *
 * Every number is computed here in code from real candles. The LLM only turns
 * the finished, locked figures into an easy explanation — it never invents a
 * price, and it is told NOT to invent specific news headlines. Free to run.
 */

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
const INTERVAL: Record<string, string> = { scalp: "15min", intraday: "1h", swing: "1day" };

export async function POST(req: NextRequest) {
  const supabase = createClient();
  if (supabase) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
  }
  const mdKey = process.env.TWELVEDATA_API_KEY;
  const aiKey = process.env.ANTHROPIC_API_KEY;
  if (!mdKey) return json({ error: "notConfigured", reason: "Live market data isn't connected." }, 200);

  let b: { td?: unknown; symbol?: unknown; style?: unknown; direction?: unknown; entry?: unknown; stopLoss?: unknown; takeProfits?: unknown; since?: unknown };
  try { b = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const td = typeof b.td === "string" ? b.td : "";
  const symbol = typeof b.symbol === "string" ? b.symbol : td;
  const style = typeof b.style === "string" && INTERVAL[b.style] ? (b.style as string) : "intraday";
  const interval = INTERVAL[style];
  const dir = b.direction === "SHORT" ? "SHORT" : "LONG";
  const entry = Number(b.entry), stop = Number(b.stopLoss);
  const tps = (Array.isArray(b.takeProfits) ? b.takeProfits.map(Number) : []).filter(numOk);
  const since = typeof b.since === "string" ? b.since : "";
  if (!td || !numOk(entry) || !numOk(stop) || tps.length === 0) return json({ error: "bad_request", reason: "Missing trade details." }, 400);

  const md = await reserveMarketData(2);
  if (!md.ok) return json({ error: "system_busy", reason: "The data desk is busy — try again in a few seconds." }, 429);

  const [execRes, flow4Res, flow1Res] = await Promise.all([
    fetchSeries(td, interval, 200, mdKey),
    style === "swing" ? Promise.resolve(null) : fetchSeries(td, style === "scalp" ? "4h" : "1day", 60, mdKey),
    style === "swing" ? Promise.resolve(null) : fetchSeries(td, style === "scalp" ? "1h" : "4h", 60, mdKey),
  ]);
  if (execRes === "ratelimit") return json({ error: "ratelimit", reason: "Hit the free market-data limit (8/min). Wait a minute and retry." }, 429);
  const rows = Array.isArray(execRes) ? execRes : null;
  if (!rows || rows.length < 3) return json({ error: "marketdata_error", reason: "Couldn't pull fresh candles for this instrument." }, 502);

  const closes = rows.map((r) => +r.close);
  const tick = await livePrice(td, mdKey);
  const px = tick != null && Math.abs(tick - closes[closes.length - 1]) / closes[closes.length - 1] < 0.05 ? tick : closes[closes.length - 1];
  const pip = pipSize(symbol);
  const dec = px >= 1000 ? 2 : px >= 1 ? 4 : 6;
  const f = (n: number) => +n.toFixed(dec);

  const risk = Math.abs(entry - stop) || pip * 10;
  const isLong = dir === "LONG";
  // Signed progress: + = in profit, − = in drawdown.
  const move = isLong ? px - entry : entry - px;
  const rNow = move / risk;
  const pnlPct = entry ? (move / entry) * 100 : 0;
  const side = Math.abs(move) < risk * 0.05 ? "flat" : move > 0 ? "profit" : "drawdown";

  // Post-entry window (timezone-robust). We fetch the recent series in UTC (no
  // start_date) and locate the entry inside it. The window is TRUSTED only when the
  // series brackets the entry — a candle exists BEFORE the entry time (startIdx > 0)
  // — so we only read price action that happened AFTER the trade was issued, never
  // the move that set it up. If we can't bracket the entry (just-issued trade, or
  // entry older than the fetched range) it's a FRESH entry: an empty window, and we
  // make NO "already hit / already broken" claims. This prevents a trade opened
  // minutes ago from reading "+0.7R, stop 7 pips away" AND "stop hit" at once.
  const cutoff = since ? tms(since) : NaN;
  const startIdx = Number.isFinite(cutoff)
    ? rows.findIndex((r) => { const t = tms(r.datetime); return Number.isFinite(t) && t >= cutoff; })
    : -1;
  const bracketed = startIdx > 0;
  const freshEntry = !bracketed;
  const sinceRows = bracketed ? rows.slice(startIdx) : [];

  // Max favourable / adverse excursion since entry, seeded at the ENTRY price so a
  // fresh trade measures entry -> current price only (never a pre-entry extreme).
  let bestPrice = entry, worstPrice = entry;
  for (let i = 0; i < sinceRows.length; i++) { bestPrice = isLong ? Math.max(bestPrice, +sinceRows[i].high) : Math.min(bestPrice, +sinceRows[i].low); worstPrice = isLong ? Math.min(worstPrice, +sinceRows[i].low) : Math.max(worstPrice, +sinceRows[i].high); }
  bestPrice = isLong ? Math.max(bestPrice, px) : Math.min(bestPrice, px);
  worstPrice = isLong ? Math.min(worstPrice, px) : Math.max(worstPrice, px);
  const mfeR = (isLong ? bestPrice - entry : entry - bestPrice) / risk;
  const maeR = (isLong ? entry - worstPrice : worstPrice - entry) / risk;

  // A target counts as hit only when the favourable excursion actually reached it,
  // inside a trusted window (monotonic — a far TP can't read hit before a nearer one).
  const tpRs = tps.map((t) => Math.abs(entry - t) / risk);
  const tpTagged = tps.map((_, i) => bracketed && mfeR >= tpRs[i] - 1e-9);
  const nextTpIdx = tpTagged.findIndex((h) => !h);
  const nextTp = nextTpIdx >= 0 ? tps[nextTpIdx] : tps[tps.length - 1];

  // Stop "broken on close" — only inside a trusted window, and reconciled with the
  // live state: if the trade is still live and price hasn't passed the stop, a
  // close-beyond-stop reading is stale/pre-entry noise, so we don't report it.
  const pxBeyondStop = isLong ? px <= stop : px >= stop;
  let stopBrokenClose = bracketed && (isLong ? sinceRows.some((c) => +c.close <= stop) : sinceRows.some((c) => +c.close >= stop));
  if (stopBrokenClose && !pxBeyondStop && rNow > -0.98) stopBrokenClose = false;
  // A stop ORDER fills on an intrabar TOUCH, not only on a close beyond the level —
  // tracked separately (and only for THIS feed; a broker's feed can wick past the
  // stop and fill it without it showing here).
  //
  // A just-issued trade whose entry falls mid-candle can't "bracket" a post-entry
  // window (its own forming candle opened BEFORE the entry time, so nothing reads
  // as "after entry" and sinceRows is empty). That gap made an intrabar wick that
  // hit the stop invisible — so the update wrongly read "idea intact / normal
  // pullback". For that fresh case, while in drawdown, also scan the last couple of
  // exec candles for a stop touch. Safety-first: better to flag a likely fill than
  // to reassure a member on a stop that has actually hit.
  const recentTouch = freshEntry && move < 0 && (isLong
    ? rows.slice(-2).some((c) => +c.low <= stop)
    : rows.slice(-2).some((c) => +c.high >= stop));
  const stopTouched = pxBeyondStop || recentTouch || (bracketed && (isLong ? sinceRows.some((c) => +c.low <= stop) : sinceRows.some((c) => +c.high >= stop)));
  const toStopPips = Math.abs(px - stop) / pip;
  const nearStop = !stopTouched && (toStopPips <= Math.max(3, (risk / pip) * 0.15) || maeR >= 0.85);
  const toNextTpPips = Math.abs(nextTp - px) / pip;

  // Structure / flow now vs the trade direction.
  const execTrend = trendOf(rows);
  const t4 = trendOf(Array.isArray(flow4Res) ? flow4Res : null);
  const t1 = trendOf(Array.isArray(flow1Res) ? flow1Res : null);
  const rsiNow = rsi(closes);
  const wantTrend: Trend = isLong ? "bullish" : "bearish";
  const againstTrend: Trend = isLong ? "bearish" : "bullish";
  const flowAgainst = (t1 === againstTrend) || (execTrend === againstTrend);
  const flowWith = (t1 === wantTrend) || (t4 === wantTrend);

  // Stop-run / liquidity sweep: did price poke BEYOND the stop then close back on
  // the trade's side within the last few candles? (a hunt, not a real break).
  const last6 = sinceRows.length ? sinceRows.slice(-6) : rows.slice(-3);
  const stopRun = isLong
    ? last6.some((c) => +c.low <= stop && +c.close > stop)
    : last6.some((c) => +c.high >= stop && +c.close < stop);

  // Deterministic event tags.
  const events: string[] = [];
  if (stopBrokenClose) events.push("Price has already closed beyond the stop since entry — a genuine break of the level, not just a wick.");
  if (stopTouched && !stopBrokenClose) events.push("Price has tapped the stop level on this feed — a stop order there would have filled on your broker (a wick can stop you out without a candle closing beyond it). Your platform is the final word on whether it filled.");
  if (nearStop) events.push("Price is right up against the stop — it may already have filled on your broker even if it hasn't registered on this feed. Check your platform.");
  if (stopRun) events.push("Looks like a stop-run / liquidity sweep — price wicked past the stop then closed back, a classic stop hunt rather than a clean break.");
  if (side === "drawdown" && flowAgainst) events.push(`The ${style === "scalp" ? "1H/4H flow" : "higher timeframe"} has turned ${againstTrend} — momentum is currently against the trade.`);
  if (side === "drawdown" && !flowAgainst && !stopRun) events.push("This reads as a normal pullback against the position — the broader flow hasn't flipped yet.");
  if (side === "profit" && flowWith) events.push("The trade is working with the flow behind it — momentum is on-side.");
  if (rsiNow != null) { if (isLong && rsiNow > 70) events.push("Momentum (RSI) is stretched high — a pause or pullback is more likely near here."); if (!isLong && rsiNow < 30) events.push("Momentum (RSI) is stretched low — a bounce is more likely near here."); }
  if (tpTagged.some(Boolean)) events.push(`Price has already reached TP${tpTagged.filter(Boolean).length}.`);

  // Thesis verdict. A stop that has been TOUCHED (an intrabar wick that would fill a
  // stop order) or a decisive close beyond it means the position is stopped out —
  // "invalidated" — even if price later snapped back (that's a stop-run, but the
  // order still filled). Sitting right on the stop, or a drawdown with the flow
  // against the trade, is "weakening". Only otherwise is the idea "intact".
  const thesis = (stopBrokenClose || stopTouched)
    ? "invalidated"
    : (nearStop || (side === "drawdown" && flowAgainst) || stopRun)
      ? "weakening"
      : "intact";

  const headline = stopBrokenClose
    ? `${symbol} closed beyond the stop since entry — the original idea is invalidated.`
    : stopTouched
      ? (stopRun
          ? `${symbol} wicked into your stop at ${f(stop)} then snapped back — a stop-run. A stop order there would have filled, so treat the trade as stopped out even though price recovered; confirm on your platform.`
          : `${symbol} reached your stop at ${f(stop)} — a stop order there would have filled. Treat the trade as stopped out and confirm on your platform.`)
      : side === "profit"
        ? `${symbol} is ${rNow >= 1 ? "solidly" : ""} in profit, about ${rNow.toFixed(1)}R on-side.`
        : nearStop
          ? `${symbol} is right on top of your stop at ${f(stop)} (~${toStopPips.toFixed(1)} pips) — it may already have filled on your broker. Check your platform before doing anything else.`
          : flowAgainst
            ? `${symbol} is in drawdown and the flow has turned against the trade — manage risk.`
            : `${symbol} is in a normal pullback — down about ${Math.abs(rNow).toFixed(1)}R but the flow hasn't flipped.`;

  const setup = {
    status: "update" as const,
    symbol, instrument: td, direction: dir, style,
    price: f(px), as_of: rows[rows.length - 1].datetime,
    entry: f(entry), stop_loss: f(stop), take_profits: tps.map(f), next_target: f(nextTp),
    pnl: { r: +rNow.toFixed(2), price: f(Math.abs(move)) * (side === "drawdown" ? -1 : 1), pips: +(move / pip).toFixed(1), percent: +pnlPct.toFixed(2), side },
    excursion: { mfe_r: +mfeR.toFixed(2), mae_r: +maeR.toFixed(2) },
    distance: { to_stop_pips: +toStopPips.toFixed(1), to_next_target_pips: +toNextTpPips.toFixed(1), next_target_label: `TP${nextTpIdx >= 0 ? nextTpIdx + 1 : tps.length}` },
    market: { exec_trend: execTrend, flow_4h: t4, flow_1h: t1, rsi: rsiNow != null ? +rsiNow.toFixed(0) : null, flow_against_trade: flowAgainst },
    events, thesis, headline, fresh_entry: freshEntry && !stopTouched && !nearStop, stop_touched: stopTouched, near_stop: nearStop,
    explanation: [] as string[],
    what_to_watch: "",
    educational: "Educational market analysis and trade-management context only — not financial advice, and not a prediction. Manage your own risk.",
  };

  setup.explanation = await narrate(setup, aiKey).catch(() => deterministic(setup));
  setup.what_to_watch = watchLine(setup);
  return json(setup, 200);
}

function watchLine(s: Record<string, unknown>): string {
  const d = s.distance as { to_stop_pips: number; to_next_target_pips: number; next_target_label: string };
  const th = s.thesis as string;
  if (th === "invalidated") return "The stop has been hit — the idea is done. Don't add to it or move the stop further away; look for the next clean setup.";
  if (th === "weakening") return `Watch the stop at ${(s.stop_loss as number)} (~${d.to_stop_pips} pips away). If a candle closes beyond it the idea is invalidated; a reclaim of structure back on-side would revive it.`;
  return `Next objective is ${d.next_target_label} at ${(s.next_target as number)} (~${d.to_next_target_pips} pips). The idea stays valid while price holds above/below the stop at ${(s.stop_loss as number)}.`;
}

function deterministic(s: Record<string, unknown>): string[] {
  const p = s.pnl as { r: number; pips: number; side: string };
  const out = [`${s.symbol} ${s.direction} — currently ${p.side === "profit" ? "in profit" : p.side === "drawdown" ? "in drawdown" : "roughly flat"} by ${Math.abs(p.pips)} pips (${p.r >= 0 ? "+" : ""}${p.r}R).`];
  for (const e of (s.events as string[])) out.push(e);
  return out.slice(0, 6);
}

async function narrate(s: Record<string, unknown>, aiKey: string | undefined): Promise<string[]> {
  if (!aiKey) return deterministic(s);
  const sys = `You are OM AI Plays' trade-update explainer. You are given a FINAL, LOCKED JSON snapshot of an OPEN trade that a deterministic engine already computed (price, P/L in R and pips, what price did since entry, whether the flow flipped, whether it was a stop-run, etc.). Your ONLY job is to explain, in plain, simple English a beginner could follow, what is happening to THIS trade and WHY the market moved the way it did — using ONLY the mechanics in the JSON (liquidity sweep / stop-run, pullback, trend flip, momentum stretch, distance to stop/target). You MUST NOT invent or change any number. You MUST NOT invent specific news headlines, economic releases, or events that aren't in the JSON — if news could be a factor, say only that scheduled news can cause moves like this and to check an economic calendar. If "fresh_entry" is true the trade was JUST issued and nothing has happened since entry yet — say plainly it's a brand-new, just-triggered setup with no post-entry action to report. The member's own broker is the ONLY source of truth for whether their stop or target order filled; this feed can differ from a broker's gold price by a few tenths on fast wicks, and a stop fills on an intrabar TOUCH, not a close — so NEVER state the stop was not hit. If "stop_touched" or "near_stop" is set, say the stop may have filled on their broker and to trust their platform. Return ONLY a JSON array of 3-5 short plain-English sentences (no markdown).`;
  const r = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": aiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: 500, system: sys, messages: [{ role: "user", content: `LOCKED TRADE SNAPSHOT:\n${JSON.stringify(s)}\n\nReturn the JSON array of explanation sentences now.` }] }),
  });
  const j = await r.json();
  const raw = Array.isArray(j.content) ? j.content.filter((b: { type?: string }) => b?.type === "text").map((b: { text?: string }) => b.text ?? "").join("") : "";
  const m = raw.match(/\[[\s\S]*\]/);
  if (!m) return deterministic(s);
  try { const arr = JSON.parse(m[0]); return Array.isArray(arr) ? arr.map(String).slice(0, 6) : deterministic(s); } catch { return deterministic(s); }
}

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
