import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { reserveMarketData } from "@/lib/marketData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 45;

/**
 * XAUGHOST outcome check + learning. Given a saved gold call, it replays the
 * real XAU/USD candles since the call to decide WIN (which take-profit hit) or
 * LOSS (stop hit), then runs a post-mortem so the engine LEARNS: on a loss, why
 * the stop happened and what to adjust; on a win, how it won and what to repeat.
 * The lesson is stored on the trade and later fed back into new calls.
 */
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.OM_AI_MODEL || "claude-sonnet-4-6";
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export async function POST(req: NextRequest) {
  const supabase = createClient();
  if (!supabase) return json({ status: "open", note: "not_configured" });
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  let body: { id?: unknown };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const id = typeof body?.id === "string" ? body.id : typeof body?.id === "number" ? String(body.id) : "";
  if (!id) return json({ error: "bad_request" }, 400);

  const { data: trade } = await supabase.from("xaughost_trades").select("*").eq("client_id", id).maybeSingle();
  if (!trade) return json({ error: "not_found" }, 404);
  if (trade.status === "win" || trade.status === "loss") {
    return json({ status: trade.status, hitTp: trade.hit_tp ?? undefined, lesson: trade.lesson ?? undefined });
  }

  const dir = trade.direction === "SHORT" ? "SHORT" : trade.direction === "LONG" ? "LONG" : null;
  const sl = num(trade.stop_loss);
  const tps = [num(trade.tp1), num(trade.tp2), num(trade.tp3)].filter((x): x is number => x != null);
  const asOf: string = typeof trade.as_of === "string" ? trade.as_of : "";
  if (!dir || sl == null || !tps.length || !asOf) return json({ status: "open", note: "not_evaluable" });

  const mdKey = process.env.TWELVEDATA_API_KEY;
  if (!mdKey) return json({ status: "open", note: "marketdata not connected" });
  await reserveMarketData(1);

  // Twelve Data wants "YYYY-MM-DD HH:MM:SS"; normalise the stored ISO timestamp.
  const since = asOf.replace("T", " ").replace(/\..*$/, "").replace("Z", "").trim();
  const symbol = typeof trade.symbol === "string" && trade.symbol ? trade.symbol : "XAU/USD";
  let rows: { datetime: string; high: string; low: string }[] = [];
  try {
    const r = await fetch(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=15min&outputsize=500&start_date=${encodeURIComponent(since)}&apikey=${mdKey}`, { cache: "no-store" });
    const j = await r.json();
    if (Array.isArray(j.values)) rows = [...j.values].reverse();
  } catch { return json({ status: "open", note: "data_error" }); }

  // Highest TP reached before SL (SL priority within a bar = conservative).
  const ladder = tps.map((p, i) => ({ n: i + 1, p })).sort((a, b) => (dir === "LONG" ? a.p - b.p : b.p - a.p));
  let maxTp = 0, hitAt = "", stopAt = "";
  let hi = 0, lo = 0;
  for (const c of rows) {
    if (c.datetime <= since) continue;
    hi = +c.high; lo = +c.low;
    if (dir === "LONG" ? lo <= sl : hi >= sl) {
      if (maxTp >= 1) { break; }        // already banked a TP earlier → win
      stopAt = c.datetime; break;        // stopped out first
    }
    for (const t of ladder) { const reached = dir === "LONG" ? hi >= t.p : lo <= t.p; if (reached && t.n > maxTp) { maxTp = t.n; hitAt = c.datetime; } }
  }

  let status: "open" | "win" | "loss" = "open";
  if (maxTp >= 1) status = "win";
  else if (stopAt) status = "loss";
  if (status === "open") return json({ status: "open" });

  // ── Post-mortem: LEARN from the outcome ──────────────────────────────────
  const p = (trade.payload || {}) as Record<string, unknown>;
  const outcome = status === "win"
    ? `WIN — price reached TP${maxTp} (${(tps[maxTp - 1] ?? 0)}) before the stop at ${sl}.`
    : `LOSS — price hit the stop at ${sl} before any take-profit.`;
  let lesson = "";
  const aiKey = process.env.ANTHROPIC_API_KEY;
  if (aiKey) {
    const sys = `You are MFXGHOST's learning module for ${symbol}. A previous ${symbol} call has resolved. In 2-4 concise, specific, actionable sentences, extract the KEY lesson:
- If it WON: exactly HOW it won — which regime read, strategy, liquidity/structure or timing edge delivered — and what to KEEP doing.
- If it LOST: exactly WHY the stop was hit — what regime/liquidity/timing signal was misread or missed, whether the strategy fit the conditions — and ONE concrete adjustment for next time.
Plain text only. No preamble, no JSON, no bullet symbols.`;
    const usr = `Call: ${dir} via "${trade.strategy || p.winningStrategy || "?"}" | regime "${trade.regime || p.regime || "?"}" | entry ${trade.entry} stop ${sl} TPs ${tps.join(", ")}.
Why it was chosen: ${String(p.whyChosen || p.bestStrategy || "n/a")}
Original narrative: ${String(p.narrative || "n/a")}
Outcome: ${outcome}
Give the lesson now.`;
    try {
      const r = await fetch(ANTHROPIC_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": aiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: MODEL, max_tokens: 400, system: sys, messages: [{ role: "user", content: usr }] }),
      });
      const j = await r.json();
      lesson = (j?.content?.find((c: { type?: string }) => c.type === "text") as { text?: string } | undefined)?.text?.trim() || "";
    } catch { /* lesson optional */ }
  }

  await supabase.from("xaughost_trades").update({
    status, hit_tp: status === "win" ? maxTp : null,
    outcome_at: (status === "win" ? hitAt : stopAt) || new Date().toISOString(),
    lesson: lesson || null, updated_at: new Date().toISOString(),
  }).eq("client_id", id);

  return json({ status, hitTp: status === "win" ? maxTp : undefined, lesson });
}
