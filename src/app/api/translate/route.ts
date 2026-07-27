import { type NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Batch translation for the on-the-fly site localizer (see I18nProvider).
 * Takes an array of English UI strings and returns the same array translated to
 * Spanish, in order. Numbers, tickers, prices and brand names are preserved so
 * live trading data stays intact. Results are cached client-side, so this is
 * only hit once per unique string per browser.
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
  // No AI key configured → hand back the originals so the UI still works.
  if (!key) return json({ translations: texts });

  const target = body?.target === "en" ? "English" : "Spanish";
  const sys = `You are a professional UI localizer for a members' community and trading-education web app. Translate each English string in the given JSON array into natural, concise ${target} (neutral Latin-American Spanish when Spanish).
Rules:
- Respond with ONLY a JSON array of strings — same length, same order as the input, translated. No prose, no keys, no code fences.
- Preserve EXACTLY: numbers, prices, percentages, dates, tickers/symbols (e.g. XAU/USD, BTC/USD, NAS100, US30, SPY), emails, URLs, and brand names (1 Mission, One Mission, OM, OM AI, OM AI Plays, Market Pulse).
- Keep UI strings tight: buttons and labels stay short. Don't add explanations or punctuation that wasn't there.
- If a string is only a number, symbol, code, or proper noun, return it unchanged.`;

  try {
    const r = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 8000,
        system: sys,
        messages: [{ role: "user", content: JSON.stringify(texts) }],
      }),
    });
    const j = await r.json();
    const text: string = j?.content?.[0]?.text || "";
    const match = text.match(/\[[\s\S]*\]/);
    let arr: unknown = [];
    try { arr = JSON.parse(match ? match[0] : text); } catch { arr = []; }
    if (!Array.isArray(arr) || arr.length !== texts.length) return json({ translations: texts });
    return json({ translations: arr.map((x, i) => (typeof x === "string" ? x : texts[i])) });
  } catch {
    return json({ translations: texts });
  }
}
