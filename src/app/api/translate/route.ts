import { type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Batch translation for the on-the-fly site localizer (see I18nProvider).
 * Takes an array of English UI strings and returns the same array translated to
 * Spanish, in order. Numbers, tickers, prices and brand names are preserved so
 * live trading data stays intact.
 *
 * Cost control: translations are cached in a SHARED server-side table
 * (public.ui_translations), so each unique string is translated by Claude at
 * most ONCE for the whole platform — not once per browser as before. On each
 * request we serve every string we already hold from the shared cache and only
 * send the genuine misses to the model, then write those back for everyone. The
 * client's localStorage cache still sits on top for instant repeat loads.
 */
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.OM_AI_MODEL || "claude-sonnet-4-6";

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export async function POST(req: NextRequest) {
  const key = process.env.ANTHROPIC_API_KEY;

  let body: { texts?: unknown; target?: unknown };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const texts = Array.isArray(body?.texts)
    ? (body!.texts as unknown[]).filter((t): t is string => typeof t === "string").slice(0, 120)
    : [];
  if (!texts.length) return json({ translations: [] });

  // Target "en" means "restore English". Our source strings are already English,
  // so that's an identity mapping — never spend a model call on it.
  const lang = body?.target === "en" ? "en" : "es";
  if (lang === "en") return json({ translations: texts });

  // Per-request result slots, filled from cache first, then the model.
  const out: (string | null)[] = texts.map(() => null);

  // 1) Shared-cache read: fill everything we already have translated.
  const admin = createAdminClient();
  if (admin) {
    try {
      const uniqueSources = Array.from(new Set(texts));
      const { data } = await admin
        .from("ui_translations")
        .select("source, translated")
        .eq("lang", lang)
        .in("source", uniqueSources);
      if (Array.isArray(data)) {
        const hit = new Map<string, string>();
        for (const row of data as { source: string; translated: string }[]) hit.set(row.source, row.translated);
        texts.forEach((t, i) => { const v = hit.get(t); if (typeof v === "string") out[i] = v; });
      }
    } catch { /* cache miss / not migrated → fall through to the model */ }
  }

  // 2) Misses = the distinct strings we still don't have.
  const misses = Array.from(new Set(texts.filter((t, i) => out[i] === null)));

  // Nothing to translate (full cache hit) — return immediately, no model call.
  if (!misses.length) return json({ translations: out.map((v, i) => v ?? texts[i]) });

  // No AI key configured → hand back originals for the misses so the UI still works.
  if (!key) return json({ translations: out.map((v, i) => v ?? texts[i]) });

  const sys = `You are a professional UI localizer for a members' community and trading-education web app. Translate each English string in the given JSON array into natural, concise Spanish (neutral Latin-American Spanish).
Rules:
- Respond with ONLY a JSON array of strings — same length, same order as the input, translated. No prose, no keys, no code fences.
- Preserve EXACTLY: numbers, prices, percentages, dates, tickers/symbols (e.g. XAU/USD, BTC/USD, NAS100, US30, SPY), emails, URLs, and brand names (1 Mission, One Mission, OM, OM AI, OM AI Plays, Market Pulse).
- Keep UI strings tight: buttons and labels stay short. Don't add explanations or punctuation that wasn't there.
- If a string is only a number, symbol, code, or proper noun, return it unchanged.`;

  const translatedBySource = new Map<string, string>();
  try {
    const r = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 8000,
        system: sys,
        messages: [{ role: "user", content: JSON.stringify(misses) }],
      }),
    });
    const j = await r.json();
    const text: string = j?.content?.[0]?.text || "";
    const match = text.match(/\[[\s\S]*\]/);
    let arr: unknown = [];
    try { arr = JSON.parse(match ? match[0] : text); } catch { arr = []; }
    if (Array.isArray(arr) && arr.length === misses.length) {
      misses.forEach((src, i) => { if (typeof arr[i] === "string") translatedBySource.set(src, arr[i] as string); });
    }
  } catch {
    // model failed → we'll fall back to originals for the misses below
  }

  // 3) Write the fresh translations back to the shared cache for everyone.
  if (admin && translatedBySource.size) {
    try {
      const rows = Array.from(translatedBySource.entries()).map(([source, translated]) => ({ source, lang, translated }));
      await admin.from("ui_translations").upsert(rows, { onConflict: "source,lang" });
    } catch { /* best-effort: a cache-write failure must never break the response */ }
  }

  // 4) Assemble the final ordered array: cache hits, then model results, else original.
  const translations = texts.map((t, i) => out[i] ?? translatedBySource.get(t) ?? t);
  return json({ translations });
}
