import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildRealResults, type RealRow } from "@/lib/genx/realResults";
import { statsSince } from "@/lib/genx/statsSince";
import { setupLabel, gradeOf } from "@/lib/genx/liveTrade";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

/**
 * LIVE TRADE CARD (owner 09-17: "when someone is entered into a trade… a card that displays the trade. Also the
 * last 3 that were took and the result. Win or lesson. Don't say loss… people see this first").
 *
 * Built from the same real-trade ledger as the Floor record (flow_managed_positions, XAUUSD, since the stats reset):
 *   live   — the newest GENX fire that still has open accounts (entry = average fill across those accounts), with the
 *            call's stop / target / setup from genx_alerts and a live gold price for the running pips.
 *   recent — the last 3 fully-closed fires, graded once at the average realized result across every account:
 *            WIN (> 0 pips), LESSON (< 0), BREAKEVEN (0).
 */
type PosRow = RealRow & { entry: number | string | null; position_id: string | null; account_id: string | null };
type AlertRow = { dedupe_key: string; side: string; entry_low: number | null; entry_high: number | null; stop: number | null; tp1: number | null; enter_sent_at: string | null; created_at: string; confidence: number | null };

function json(o: unknown, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

let PRICE: { at: number; price: number } | null = null;
async function goldPrice(): Promise<number | null> {
  if (PRICE && Date.now() - PRICE.at < 15_000) return PRICE.price;
  const key = process.env.TWELVEDATA_API_KEY;
  if (!key) return PRICE?.price ?? null;
  try {
    const r = await fetch(`https://api.twelvedata.com/price?symbol=XAU%2FUSD&apikey=${key}`, { cache: "no-store" });
    const j = (await r.json()) as { price?: string };
    const p = Number(j.price);
    if (Number.isFinite(p) && p > 0) { PRICE = { at: Date.now(), price: p }; return p; }
  } catch { /* keep last */ }
  return PRICE?.price ?? null;
}

export async function GET() {
  const supabase = createClient();
  if (supabase) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
  }
  const admin = createAdminClient();
  if (!admin) return json({ live: null, recent: [] });

  const since = new Date(Math.max(Date.parse(statsSince()), Date.now() - 14 * 86_400_000)).toISOString();
  const { data } = await admin.from("flow_managed_positions")
    .select("side,outcome,result_pips,created_at,resolved_at,manage_style,status,entry,position_id,account_id")
    .eq("symbol", "XAUUSD").gte("created_at", since).order("created_at", { ascending: false }).limit(5000);
  // one row per broker position (the ledger can carry a duplicate row for the same position)
  const seen = new Set<string>();
  const rows = ((data ?? []) as PosRow[]).filter((r) => { const k = `${r.account_id}|${r.position_id}`; if (!r.position_id) return true; if (seen.has(k)) return false; seen.add(k); return true; });
  const real = buildRealResults(rows);

  const recent = real.recentFiresAll.filter((f) => f.open === 0 && f.avgPips != null).slice(0, 3)
    .map((f) => ({ at: f.at, side: f.side.toUpperCase(), pips: f.avgPips, accounts: f.accounts, grade: gradeOf(f.avgPips) }));

  const liveFire = real.recentFiresAll.find((f) => f.open > 0 && Date.now() - Date.parse(f.at) < 36 * 3600_000);
  let live: Record<string, unknown> | null = null;
  if (liveFire) {
    const t0 = Date.parse(liveFire.at);
    const openRows = rows.filter((r) => r.status === "open" && String(r.side).toLowerCase() === liveFire.side && Math.abs(Date.parse(r.created_at) - t0) <= 20 * 60_000);
    const entries = openRows.map((r) => Number(r.entry)).filter((n) => Number.isFinite(n) && n > 0);
    const entry = entries.length ? entries.reduce((a, b) => a + b, 0) / entries.length : null;
    const { data: al } = await admin.from("genx_alerts").select("dedupe_key,side,entry_low,entry_high,stop,tp1,enter_sent_at,created_at,confidence")
      .eq("side", liveFire.side).gte("created_at", new Date(t0 - 6 * 3600_000).toISOString()).lte("created_at", new Date(t0 + 5 * 60_000).toISOString())
      .order("created_at", { ascending: false }).limit(5);
    const alert = ((al ?? []) as AlertRow[]).find((a) => a.enter_sent_at && Math.abs(Date.parse(a.enter_sent_at) - t0) <= 15 * 60_000) ?? null;
    const price = await goldPrice();
    const d = liveFire.side === "buy" ? 1 : -1;
    live = {
      side: liveFire.side.toUpperCase(), openedAt: liveFire.at, accountsIn: new Set(openRows.map((r) => r.account_id)).size || liveFire.open,
      entry: entry != null ? +entry.toFixed(2) : null, stop: alert?.stop ?? null, target: alert?.tp1 ?? null,
      setup: setupLabel(alert?.dedupe_key), confidence: alert?.confidence ?? null,
      price, pips: price != null && entry != null ? Math.round(d * (price - entry) * 10) : null,
    };
  }
  return json({ live, recent, asOf: new Date().toISOString() });
}
