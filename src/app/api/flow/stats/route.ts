import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * FLOW track record — how the FLOW auto-engine has actually performed, read
 * straight from the `flow_managed_positions` outcome ledger the trade-manager
 * fills when each position closes. Every signed-in member can read this desk-wide
 * aggregate (same pattern as the GENX track record); it exposes ONLY engine-level
 * numbers, never per-member data.
 *
 * Outcomes (classifyOutcome in flowManage.ts):
 *   stop      — stopped out before +1R  → the ONLY loss
 *   breakeven — reached +1R (partial banked), runner scratched at break-even
 *   trail     — reached +1R, runner trailed out in profit below target
 *   target    — reached +1R and price hit the full target
 * A win is anything that isn't a stop (BE and better all bank the partial).
 * 'excluded' rows (bug-duplicate legs closed manually) are left out entirely.
 *
 * The same signal fans out across many accounts, so we DEDUPE by signal
 * (symbol+side+entry) and keep the largest-size fill as the representative — so
 * the record reads as one trade per signal, not one per account.
 */
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

type Row = {
  symbol: string; side: string; entry: number; qty: number;
  outcome: string | null; result_pips: number | null; resolved_at: string | null; created_at: string;
};

const WIN = new Set(["breakeven", "trail", "target"]);

type Tally = { trades: number; wins: number; stop: number; breakeven: number; trail: number; target: number; partials: number; pips: number };
const emptyTally = (): Tally => ({ trades: 0, wins: 0, stop: 0, breakeven: 0, trail: 0, target: 0, partials: 0, pips: 0 });
function add(t: Tally, o: string, pips: number) {
  t.trades++;
  t.pips += pips;
  if (o === "stop") t.stop++;
  else { t.wins++; if (o === "breakeven") t.breakeven++; else if (o === "trail") t.trail++; else if (o === "target") t.target++; }
  if (o === "breakeven" || o === "trail" || o === "target") t.partials++;
}
function summarize(t: Tally) {
  return {
    trades: t.trades,
    wins: t.wins,
    stops: t.stop,
    breakeven: t.breakeven,
    trailed: t.trail,
    fullTarget: t.target,
    partialsTaken: t.partials,
    pips: Math.round(t.pips),
    winRate: t.trades ? +((t.wins / t.trades) * 100).toFixed(0) : null,
  };
}

export async function GET() {
  // Signed-in members only (protects the aggregate from anonymous scraping).
  const supabase = createClient();
  if (supabase) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
  }

  const admin = createAdminClient();
  if (!admin) return json({ error: "not_configured" }, 200);

  // FLOW's track record covers FOREX/indices only — GOLD is reported by the GENX
  // engine (which sources it) via /api/genx-stats, so it isn't double-counted here.
  // Scoped to the LEAD account, since every member copies the lead's trades — this
  // is the desk's canonical result, free of any per-member divergence.
  const LEAD_USER_ID = "3b5e06e5-258c-4880-b1f2-d1623cbca100";
  const [{ count: openCount }, { data, error }] = await Promise.all([
    admin.from("flow_managed_positions").select("id", { count: "exact", head: true }).eq("status", "open").eq("user_id", LEAD_USER_ID).neq("symbol", "XAUUSD"),
    admin
      .from("flow_managed_positions")
      .select("symbol,side,entry,qty,outcome,result_pips,resolved_at,created_at")
      .eq("user_id", LEAD_USER_ID)
      .neq("symbol", "XAUUSD")
      .not("outcome", "is", null)
      .neq("outcome", "excluded")
      .order("resolved_at", { ascending: false, nullsFirst: false })
      .limit(2000),
  ]);
  if (error) return json({ error: "load_failed", detail: error.message }, 200);

  const rows = (data || []) as Row[];

  // Dedupe the fan-out: one entry per SIGNAL (symbol|side|entry), keeping the
  // largest-size fill as the representative outcome for that signal.
  const bySignal = new Map<string, Row>();
  for (const r of rows) {
    const key = `${String(r.symbol).toUpperCase()}|${r.side}|${r.entry}`;
    const cur = bySignal.get(key);
    if (!cur || (r.qty ?? 0) > (cur.qty ?? 0)) bySignal.set(key, r);
  }
  const signals = [...bySignal.values()];

  const overall = emptyTally();
  const perPairMap = new Map<string, Tally>();
  for (const s of signals) {
    const o = s.outcome as string;
    const pips = typeof s.result_pips === "number" ? s.result_pips : 0;
    add(overall, o, pips);
    const sym = String(s.symbol).toUpperCase();
    if (!perPairMap.has(sym)) perPairMap.set(sym, emptyTally());
    add(perPairMap.get(sym)!, o, pips);
  }

  const perPair = [...perPairMap.entries()]
    .map(([symbol, t]) => ({ symbol, ...summarize(t) }))
    .sort((a, b) => b.trades - a.trades);

  const recent = signals
    .slice()
    .sort((a, b) => new Date(b.resolved_at || b.created_at).getTime() - new Date(a.resolved_at || a.created_at).getTime())
    .slice(0, 10)
    .map((s) => ({
      symbol: String(s.symbol).toUpperCase(),
      side: (s.side || "").toLowerCase(),
      outcome: s.outcome,
      win: WIN.has(String(s.outcome)),
      pips: typeof s.result_pips === "number" ? Math.round(s.result_pips) : null,
      at: s.resolved_at || s.created_at,
    }));

  return json({
    open: openCount ?? 0,
    ...summarize(overall),
    perPair,
    recent,
  }, 200);
}
