import { type NextRequest } from "next/server";
import { authedContext } from "@/lib/supabase/bearer";
import { gateCredits, chargeCredit } from "@/lib/credits";
import { isPriorityEmail } from "@/lib/marketData";
import { XGHOST_VERSION } from "@/lib/xghost/engine";
import { scanXghost, logXghostSignals } from "@/lib/xghost/scan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 45;

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.OM_AI_MODEL || "claude-sonnet-4-6";
const NEWS_WARNING = "NEWS NOT CHECKED — MANUAL ECONOMIC CALENDAR VERIFICATION REQUIRED BEFORE ENTRY.";

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

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

  // Shared scan core — identical analysis to the automatic cron scan.
  const scan = await scanXghost(mdKey, fresh);
  if (scan.status === "ratelimit") return json({ error: "ratelimit", reason: "Market data is busy (per-minute limit). Wait a minute and rescan." }, 429);
  const { asOf, dxy, ranked, best, second, suppressed, anyTradeable } = scan;

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

  // Paper-log tradeable signals (deduped by fingerprint) for performance tracking.
  await logXghostSignals(best, second, dxy, user?.id ?? null);

  // Charge only when we produced a real scan (not a fully rate-limited one).
  const credits = await chargeCredit("scan", supabase);

  return json({
    ok: true, asOf, session: ranked[0]?.session || "",
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
