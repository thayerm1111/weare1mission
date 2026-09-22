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
 * PER MEMBER (owner 09-17: only the viewer's own accounts). From the member's own ledger rows (flow_managed_positions, XAUUSD):
 *   live   — the member's newest GENX trade still open on any of their accounts: their fill, their current stop and
 *            target, setup from genx_alerts, and a live gold price for the running pips.
 *   recent — the member's last 3 fully-closed trades, graded at their average realized result:
 *            WIN (> 0 pips), LESSON (< 0), BREAKEVEN (0).
 */
type PosRow = RealRow & { entry: number | string | null; cur_stop: number | string | null; tp1: number | string | null; position_id: string | null; account_id: string | null };
type AlertRow = { dedupe_key: string; side: string; enter_sent_at: string | null; created_at: string; confidence: number | null };

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
  if (!supabase) return json({ live: null, recent: [] });
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);
  const admin = createAdminClient();
  if (!admin) return json({ live: null, recent: [] });

  // PER MEMBER (owner 09-17: "only show the person's account, not everyone's"): only this member's own positions.
  const since = new Date(Math.max(Date.parse(statsSince()), Date.now() - 30 * 86_400_000)).toISOString();
  const { data } = await admin.from("flow_managed_positions")
    .select("side,outcome,result_pips,created_at,resolved_at,manage_style,status,entry,cur_stop,tp1,position_id,account_id")
    .eq("user_id", user.id).eq("symbol", "XAUUSD").gte("created_at", since).order("created_at", { ascending: false }).limit(2000);

  const rows = dedupePositions((data ?? []) as PosRow[]);
  const real = buildRealResults(rows);

  // OWNER RULE (09-22): "If I close one of my accounts in profit I want that recorded as a win, even if I
  // self-managed it." A trade counts as a WIN on the member's own record when ANY of their accounts closed it in
  // profit (hand-closed included), shown at that account's result. Otherwise it is graded at the average as before.
  // Member-only: the desk record, the GENX results card and FLOW stats are unchanged.
  const recent = real.recentFiresAll.filter((f) => f.open === 0 && f.avgPips != null).slice(0, 3)
    .map((f) => {
      const won = (f.bestPips ?? 0) > 0;
      const pips = won ? f.bestPips : f.avgPips;
      return { at: f.at, side: f.side.toUpperCase(), pips, accounts: f.accounts, grade: won ? "WIN" as const : gradeOf(f.avgPips) };
    });

  const liveFire = real.recentFiresAll.find((f) => f.open > 0 && Date.now() - Date.parse(f.at) < 72 * 3600_000);
  let live: Record<string, unknown> | null = null;
  if (liveFire) {
    const t0 = Date.parse(liveFire.at);
    const openRows = rows.filter((r) => r.status === "open" && String(r.side).toLowerCase() === liveFire.side && Math.abs(Date.parse(r.created_at) - t0) <= 20 * 60_000);
    const entry = avg(openRows.map((r) => r.entry));
    const stop = avg(openRows.map((r) => r.cur_stop));
    const target = avg(openRows.map((r) => r.tp1));
    const { data: al } = await admin.from("genx_alerts").select("dedupe_key,side,enter_sent_at,created_at,confidence")
      .eq("side", liveFire.side).gte("created_at", new Date(t0 - 6 * 3600_000).toISOString()).lte("created_at", new Date(t0 + 5 * 60_000).toISOString())
      .order("created_at", { ascending: false }).limit(5);
    const alert = ((al ?? []) as AlertRow[]).find((a) => a.enter_sent_at && Math.abs(Date.parse(a.enter_sent_at) - t0) <= 15 * 60_000) ?? null;
    const price = await goldPrice();
    const d = liveFire.side === "buy" ? 1 : -1;
    live = {
      side: liveFire.side.toUpperCase(), openedAt: liveFire.at,
      accountsIn: new Set(openRows.map((r) => r.account_id)).size || liveFire.open,
      entry: round2(entry), stop: round2(stop), target: round2(target),
      setup: setupLabel(alert?.dedupe_key), confidence: alert?.confidence ?? null,
      price, pips: price != null && entry != null ? Math.round(d * (price - entry) * 10) : null,
    };
  }
  return json({ live, recent, scope: "member", asOf: new Date().toISOString() });
}

/** One row per broker position (the ledger can carry a duplicate row for the same position). */
function dedupePositions(rows: PosRow[]): PosRow[] {
  const seen = new Set<string>();
  return rows.filter((r) => { if (!r.position_id) return true; const k = `${r.account_id}|${r.position_id}`; if (seen.has(k)) return false; seen.add(k); return true; });
}
function avg(v: (number | string | null)[]): number | null {
  const n = v.map(Number).filter((x) => Number.isFinite(x) && x > 0);
  return n.length ? n.reduce((a, b) => a + b, 0) / n.length : null;
}
const round2 = (n: number | null) => (n != null ? +n.toFixed(2) : null);
