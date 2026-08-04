import { type NextRequest } from "next/server";
import { authedContext } from "@/lib/supabase/bearer";
import { gateCredits, chargeCredit } from "@/lib/credits";
import { series, isPriorityEmail } from "@/lib/marketData";
import { closedBars } from "@/lib/mtf";
import { XPAIRS, XSYMS, analyzePair, sessionOf, XGHOST_VERSION, type PairInput, type XSym } from "@/lib/xghost/engine";
import { classifyDxy, buildProxyCloses, fetchFreeDxy } from "@/lib/xghost/dxy";
import { rankAndGuard } from "@/lib/xghost/correlation";
import { logSignal } from "@/lib/signalLog";
import type { Row } from "@/lib/marketData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 45;

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.OM_AI_MODEL || "claude-sonnet-4-6";
const NEWS_WARNING = "NEWS NOT CHECKED — MANUAL ECONOMIC CALENDAR VERIFICATION REQUIRED BEFORE ENTRY.";

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
const arr = (r: Row[] | "ratelimit" | null): Row[] | null => (Array.isArray(r) ? r : null);

export async function POST(req: NextRequest) {
  const { supabase, user, configured } = await authedContext(req);
  let fresh = false;
  if (configured) {
    if (!user) return json({ error: "unauthorized" }, 401);
    fresh = isPriorityEmail(user.email);
  }
  const mdKey = process.env.TWELVEDATA_API_KEY;
  const aiKey = process.env.ANTHROPIC_API_KEY;
  if (!mdKey) return json({ notConfigured: "marketdata", reason: "Live market data isn't connected." }, 200);

  const gate = await gateCredits("scan", supabase);
  if (!gate.ok && gate.reason === "unauthorized") return json({ error: "unauthorized" }, 401);
  if (!gate.ok && gate.reason === "insufficient") return json({ error: "insufficient_credits", balance: gate.balance }, 402);

  const now = new Date();
  const nowMs = now.getTime();
  const session = sessionOf(now);

  // ── Fetch: 5 pairs × (1H, 15m, 5m) for pair analysis. Parallel; the shared
  // community governor + 30s cache keep this within budget. ──
  const pairFetch = XSYMS.map(async (sym) => {
    const cfg = XPAIRS[sym];
    const [h1, m15, m5, priceRow] = await Promise.all([
      series(cfg.td, "1h", 120, mdKey, fresh),
      series(cfg.td, "15min", 120, mdKey, fresh),
      series(cfg.td, "5min", 150, mdKey, fresh),
      series(cfg.td, "1min", 2, mdKey, fresh),
    ]);
    const m5arr = arr(m5);
    const price = m5arr && m5arr.length ? +m5arr[m5arr.length - 1].close : null;
    return { sym, h1: arr(h1), m15: arr(m15), m5: m5arr, priceRow: arr(priceRow), price };
  });

  // ── DXY across 1m/5m/15m/30m. Source order: NATIVE Twelve Data (opt-in via env —
  // the Grow plan does NOT serve DXY, so it's off by default and burns no budget) →
  // FREE ICE Dollar Index (DX-Y.NYB) intraday → PROXY from the pair candles. ──
  const DXY_TFS = ["1min", "5min", "15min", "30min"] as const;
  const tryNative = process.env.XGHOST_NATIVE_DXY === "1";
  const dxyFetch = (async () => {
    if (tryNative) {
      const nat = await Promise.all(DXY_TFS.map((tf) => series("DXY", tf, 150, mdKey, fresh)));
      const n = nat.map(arr);
      if (n.every((x) => x && x!.length > 25)) return { src: "native" as const, rows: n as Row[][] };
    }
    const free = await Promise.all(DXY_TFS.map((tf) => fetchFreeDxy(tf, 200)));
    if (free.every((x) => x && x.length > 25)) return { src: "free" as const, rows: free as Row[][] };
    return { src: "proxy" as const, rows: null };
  })();

  const [pairData, dxySrc] = await Promise.all([Promise.all(pairFetch), dxyFetch]);

  // Rate-limit guard: if every pair failed to fetch, bail without charging.
  const anyData = pairData.some((p) => p.h1 && p.m15 && p.m5);
  if (!anyData) return json({ error: "ratelimit", reason: "Market data is busy (per-minute limit). Wait a minute and rescan." }, 429);

  let dxy;
  if (dxySrc.rows) {
    const R = dxySrc.rows;
    // drop the last (possibly-forming) candle before reading trend
    const cb = (r: Row[]) => (r.length > 26 ? r.slice(0, -1) : r);
    dxy = classifyDxy(cb(R[0]), cb(R[1]), cb(R[2]), cb(R[3]), dxySrc.src);
  } else {
    // Proxy fallback — build a USD-strength series from the pair candles we already
    // have (5m, 15m, 1H stand in for 5m/15m/30m; 1m unavailable). Zero extra calls.
    const byTf = (tf: "h1" | "m15" | "m5") => {
      const m: Record<string, Row[] | null> = {};
      for (const p of pairData) m[p.sym] = closedBars(p[tf], 120);
      return m;
    };
    dxy = classifyDxy(null, buildProxyCloses(byTf("m5")), buildProxyCloses(byTf("m15")), buildProxyCloses(byTf("h1")), "proxy");
  }

  // ── Analyze each pair ──
  const cands = pairData.map((p) => {
    const cfg = XPAIRS[p.sym as XSym];
    const inp: PairInput = {
      h1: closedBars(p.h1, 25), m15: closedBars(p.m15, 25), m5: closedBars(p.m5, 25),
      price: p.price, nowMs, session, dxy,
    };
    return analyzePair(cfg, inp);
  });

  const { ranked, best, second, suppressed, anyTradeable } = rankAndGuard(cands);

  // ── AI narration (optional, additive) — rewrites only the prose of the LOCKED
  // deterministic objects. Never changes a number, level, direction or veto. ──
  let card: Record<string, unknown> | null = best ? { ...best } : null;
  if (aiKey && best) {
    try {
      const sys = `You are xGhost's desk-narration layer. You are given LOCKED, deterministic analysis for five forex pairs. Write ONLY plain-English prose for the customer signal card. You MUST NOT change or invent any number, level, direction, score, grade or veto. You have NO news feed — never claim news was checked. Return ONLY JSON: {"thesis":"2-3 sentences on the best setup","supporting":["short bullet","..."],"conflicting":["short bullet or empty"],"watch":"one line on the top developing pair"}. Base everything strictly on the JSON.`;
      const payload = { best, second, dxy, watchlist: ranked.map((c) => ({ symbol: c.label, dir: c.direction, stage: c.developingStage, key: c.keyLevel, score: c.score })) };
      const r = await fetch(ANTHROPIC_URL, {
        method: "POST", headers: { "content-type": "application/json", "x-api-key": aiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: MODEL, max_tokens: 500, system: sys, messages: [{ role: "user", content: `LOCKED:\n${JSON.stringify(payload)}\n\nReturn the JSON now.` }] }),
      });
      const j = await r.json();
      const raw = Array.isArray(j?.content) ? j.content.filter((b: { type?: string }) => b?.type === "text").map((b: { text?: string }) => b.text ?? "").join("") : "";
      const m = raw.match(/\{[\s\S]*\}/);
      if (m && card) { const a = JSON.parse(m[0]); if (typeof a.thesis === "string") card.thesis = a.thesis; if (Array.isArray(a.supporting)) card.supporting = a.supporting.map(String).slice(0, 6); if (Array.isArray(a.conflicting)) card.conflicting = a.conflicting.map(String).slice(0, 4); if (typeof a.watch === "string") card.aiWatch = a.watch; }
    } catch { /* deterministic prose already present */ }
  }

  // ── Stage 3: paper-log tradeable signals into the universal signal_log so the
  // scanner's own edge can be measured later. Deduped by fingerprint, so a member
  // re-pressing Analyze on the same live setup never double-counts it. Fire-and-safe. ──
  const toLog = [best, second].filter((c) => !!c && (c.execState === "ENTER_NOW" || c.execState === "LIMIT_ENTRY"));
  for (const c of toLog) {
    if (!c) continue;
    const isMarket = c.entryType === "MARKET";
    const entryRef = isMarket
      ? (c.price ?? c.entryLow ?? c.entryHigh)
      : (c.entryLow != null && c.entryHigh != null ? (c.entryLow + c.entryHigh) / 2 : (c.entryLow ?? c.entryHigh ?? c.price));
    const tpPrices = c.tps.map((t) => t.price).filter((n) => Number.isFinite(n));
    if (entryRef == null || c.stop == null || !tpPrices.length || !c.direction) continue;
    await logSignal({
      engine: "xghost", userId: user?.id ?? null,
      instrument: c.symbol, symbol: c.symbol, style: "scalp",
      method: c.family, direction: c.direction, orderType: isMarket ? "market" : "limit",
      entry: entryRef, stop: c.stop, tps: tpPrices,
      confidence: c.grade && c.grade !== "NONE" ? c.grade : undefined, score: c.score,
      regime: c.regime, session: c.session, priceAtIssue: c.price ?? undefined,
      interval: "5min", fingerprint: c.fingerprint || undefined,
      expiresAt: c.expiresAtUtc || undefined,
      meta: {
        variant: "xghost", family: c.family, grade: c.grade, exec_state: c.execState,
        rr_main: c.rrMain, rr1: c.rr1, usd_leg: c.usdLeg,
        dxy_state: dxy.state, dxy_score: dxy.score, dxy_source: dxy.source, dxy_confirm: c.dxyConfirm,
        strategy_version: XGHOST_VERSION,
      },
    });
  }

  // Charge only when we produced a real scan (not a fully rate-limited one).
  const credits = await chargeCredit("scan", supabase);

  return json({
    ok: true, asOf: now.toISOString(), session: ranked[0]?.session || "",
    dxy: { ...dxy, note: `Dollar index is ${dxy.state.toLowerCase()} (${dxy.source})` },
    anyTradeable, best: card, second,
    watchlist: ranked.map((c) => ({
      symbol: c.label, direction: c.direction, stage: c.developingStage, keyLevel: c.keyLevel,
      execState: c.execState, score: c.score, trigger: c.triggerRequired, dxyConfirm: c.dxyConfirm,
      recheckMin: c.recheckMin, vetoes: c.vetoes,
    })),
    ranked, suppressed,
    news_warning: NEWS_WARNING,
    credits, strategy_version: XGHOST_VERSION,
  }, 200);
}
