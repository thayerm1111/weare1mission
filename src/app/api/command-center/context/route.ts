import { createClient } from "@/lib/supabase/server";
import { createClient as adminClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GLOBAL CONTEXT — DXY, US10Y, SPX, WTI. INFORMATIONAL, NEVER AN INPUT.
 *
 * Shown beside gold because a trader wants to see them. GENX and THE BRAIN do not use them and this does
 * not change that: nothing on a trading path reads this route or the row it caches in.
 *
 * One batched quote every fifteen minutes, shared by every viewer through the cc_chart_bars row "ctx", so
 * the feed budget the engine depends on is barely touched. Any symbol the plan does not carry comes back
 * as null and is shown as "—", never guessed.
 */
const TTL_MS = 15 * 60_000;
const SYMBOLS: { key: string; label: string; symbols: string[] }[] = [
  // Index symbols are plan-gated on Twelve Data, so each row lists fallbacks. Whichever one answers is
  // named in the row, so a proxy is never passed off as the index itself.
  { key: "dxy", label: "DXY", symbols: ["DXY", "UUP"] },
  { key: "us10y", label: "US10Y", symbols: ["US10Y", "TNX", "IEF"] },
  { key: "spx", label: "SPX", symbols: ["SPX", "SPY"] },
  { key: "wti", label: "WTI", symbols: ["WTI/USD", "USO"] },
];

function json(o: unknown, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
type Quote = { label: string; value: number | null; changePct: number | null; via?: string | null };

export async function GET() {
  const supabase = createClient();
  if (!supabase) return json({ ok: false, quotes: [] }, 503);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ ok: false, error: "unauthorized" }, 401);

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, sk = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !sk) return json({ ok: false, quotes: [] }, 503);
  const c = adminClient(url, sk, { auth: { persistSession: false } });

  const { data } = await c.from("cc_chart_bars").select("bars, updated_at").eq("tf", "ctx").maybeSingle();
  const row = data as { bars: Quote[]; updated_at: string } | null;
  if (row && Date.now() - Date.parse(row.updated_at) < TTL_MS) return json({ ok: true, quotes: row.bars, at: Date.parse(row.updated_at) });

  const key = process.env.TWELVEDATA_API_KEY;
  if (!key) return json({ ok: false, quotes: row?.bars ?? [], error: "feed_not_configured" });
  try {
    const q = new URL("https://api.twelvedata.com/quote");
    q.searchParams.set("symbol", SYMBOLS.flatMap((s) => s.symbols).join(","));
    const r = await fetch(q.toString(), { headers: { Authorization: `apikey ${key}` }, cache: "no-store", signal: AbortSignal.timeout(8000) });
    const body = (await r.json().catch(() => ({}))) as Record<string, Record<string, unknown>>;
    const quotes: Quote[] = SYMBOLS.map((s) => {
      for (const sym of s.symbols) {
        const o = body[sym] ?? {};
        const v = Number(o.close), ch = Number(o.percent_change);
        if (o.status !== "error" && Number.isFinite(v)) {
          return { label: s.label, value: v, changePct: Number.isFinite(ch) ? ch : null, via: sym === s.symbols[0] ? null : sym };
        }
      }
      return { label: s.label, value: null, changePct: null, via: null };
    });
    await c.from("cc_chart_bars").upsert({ tf: "ctx", bars: quotes, updated_at: new Date().toISOString() }, { onConflict: "tf" });
    return json({ ok: true, quotes, at: Date.now() });
  } catch {
    return json({ ok: false, quotes: row?.bars ?? [], error: "feed_error" });
  }
}
