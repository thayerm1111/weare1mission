import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PRIVATE ADMIN RESULTS — the owner's OWN accounts, tracked honestly.
 *
 * Unlike the public FLOW/GENX track record (signal-level, with the community
 * break-even display rule), this reads the REAL closed fills on the owner's live
 * accounts from flow_managed_positions — every genuine stop-out is a loss here, no
 * reclassification — and turns the losing trades into a data-driven "what to tweak"
 * read. It changes NOTHING about how trades are placed or how the public board
 * looks; it is a read-only back-office mirror + learning view. Admin-only.
 */
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

// The owner's account owner_id. His live accounts hang off this user.
const OWNER_USER_ID = "3b5e06e5-258c-4880-b1f2-d1623cbca100";

/** Price size of one pip for this instrument. */
function pipSize(symbol: string): number {
  const s = symbol.toUpperCase();
  if (s === "XAUUSD" || s === "GOLD") return 0.1;
  if (s === "USDJPY") return 0.01;
  if (s === "NAS100" || s === "US30") return 1;
  return 0.0001; // fx majors
}
/** USD value of ONE pip per 1.0 lot (a $ estimate; JPY/CAD are quote-scaled). */
function pipUsdPerLot(symbol: string, entry: number): number {
  const s = symbol.toUpperCase();
  if (s === "XAUUSD" || s === "GOLD") return 10;                 // 1 lot = 100oz → $10 / 0.1 pip
  if (s === "USDJPY") return entry > 0 ? 1000 / entry : 6.7;     // 100000 * 0.01 / price
  if (s === "USDCAD") return entry > 0 ? 10 / entry : 7.4;       // 100000 * 0.0001 / price
  if (s === "NAS100" || s === "US30") return 10;                 // $10 / point / lot
  return 10;                                                     // fx majors ≈ $10 / pip / lot
}

function sessionOf(iso: string): "Asian" | "London" | "London/NY" | "New York" | "Off" {
  const h = new Date(iso).getUTCHours();
  if (h >= 0 && h < 7) return "Asian";
  if (h >= 7 && h < 12) return "London";
  if (h >= 12 && h < 16) return "London/NY";
  if (h >= 16 && h < 21) return "New York";
  return "Off";
}

type Row = {
  symbol: string; side: string; entry: number | null; init_stop: number | null; qty: number | null;
  outcome: string | null; result_pips: number | null; best_price: number | null;
  created_at: string; resolved_at: string | null; environment: string | null;
};

export async function GET(_req: NextRequest) {
  const supabase = createClient();
  if (!supabase) return json({ error: "not_configured" }, 500);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);
  const { data: me } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (!me || me.role !== "admin") return json({ error: "forbidden" }, 404); // 404 = hidden from non-admins

  const admin = createAdminClient();
  if (!admin) return json({ error: "no_admin_client" }, 500);

  const { data } = await admin
    .from("flow_managed_positions")
    .select("symbol,side,entry,init_stop,qty,outcome,result_pips,best_price,created_at,resolved_at,environment")
    .eq("user_id", OWNER_USER_ID)
    .eq("status", "closed")
    .neq("environment", "demo")
    .not("outcome", "is", null)
    .order("resolved_at", { ascending: false, nullsFirst: false })
    .limit(1500);
  const rows = (data ?? []) as Row[];

  // ── HONEST RECORD (a stop is a loss; target/trail is a win; breakeven is a scratch; manual out). ──
  const isLoss = (o: string | null) => o === "stop";
  const isWin = (o: string | null) => o === "target" || o === "trail";
  const counted = rows.filter((r) => r.outcome !== "manual" && r.outcome !== "excluded");
  const usd = (r: Row): number => (r.result_pips == null || r.entry == null) ? 0 : r.result_pips * pipUsdPerLot(r.symbol, r.entry) * (r.qty ?? 0);
  const greenPips = (r: Row): number => (r.entry == null || r.best_price == null) ? 0 : (r.side === "buy" ? r.best_price - r.entry : r.entry - r.best_price) / pipSize(r.symbol);
  const stopWidthPips = (r: Row): number | null => (r.entry == null || r.init_stop == null) ? null : Math.round(Math.abs(r.entry - r.init_stop) / pipSize(r.symbol));

  const wins = counted.filter((r) => isWin(r.outcome));
  const losses = counted.filter((r) => isLoss(r.outcome));
  const scratches = counted.filter((r) => r.outcome === "breakeven");
  const netPips = Math.round(counted.reduce((a, r) => a + (r.result_pips ?? 0), 0));
  const netUsd = Math.round(counted.reduce((a, r) => a + usd(r), 0));
  const grossLostPips = Math.round(losses.reduce((a, r) => a + Math.abs(r.result_pips ?? 0), 0));
  const grossLostUsd = Math.round(losses.reduce((a, r) => a + Math.abs(usd(r)), 0));
  const wl = wins.length + losses.length;

  // per-symbol
  const bySym = new Map<string, { w: number; l: number; pips: number; usd: number }>();
  for (const r of counted) {
    const k = r.symbol.toUpperCase();
    const c = bySym.get(k) ?? { w: 0, l: 0, pips: 0, usd: 0 };
    if (isWin(r.outcome)) c.w++; else if (isLoss(r.outcome)) c.l++;
    c.pips += r.result_pips ?? 0; c.usd += usd(r);
    bySym.set(k, c);
  }

  // ── LOSS LEARNINGS — break the stop-outs down into causes we can act on. ──
  const gaveBack = losses.filter((r) => greenPips(r) >= 15);   // ran ≥15 pips green, then reversed to a stop
  const wrongFromStart = losses.length - gaveBack.length;
  const wide = losses.filter((r) => { const w = stopWidthPips(r); return w != null && w > 150; });
  const bySideLoss = { buy: losses.filter((r) => r.side === "buy").length, sell: losses.filter((r) => r.side === "sell").length };
  const bySessionLoss = new Map<string, number>();
  for (const r of losses) { const s = sessionOf(r.created_at); bySessionLoss.set(s, (bySessionLoss.get(s) ?? 0) + 1); }
  const worstSession = [...bySessionLoss.entries()].sort((a, b) => b[1] - a[1])[0] ?? null;

  // Suggested tweaks (deterministic, tied to the guards that already exist).
  const tweaks: string[] = [];
  if (losses.length) {
    if (gaveBack.length >= Math.max(2, losses.length * 0.4)) tweaks.push(`${gaveBack.length} of ${losses.length} losses ran ≥15 pips green, then reversed to a full stop — an earlier break-even move or partial would have saved these. Consider pulling the gold break-even trigger in (currently ~35 pips).`);
    if (wrongFromStart >= Math.max(2, losses.length * 0.4)) tweaks.push(`${wrongFromStart} of ${losses.length} losses went wrong from the start (never green) — direction/timing misses; the change-of-character guard is meant to cut the counter-trend ones. Watch whether it reduces them.`);
    if (wide.length) tweaks.push(`${wide.length} loss${wide.length > 1 ? "es" : ""} had a very wide stop (>150 pips) — those cost the most dollars. Consider a stop-width cap or smaller size when the signal's stop is that wide.`);
    if (worstSession && worstSession[1] >= 2) tweaks.push(`Losses cluster in the ${worstSession[0]} session (${worstSession[1]}). Consider tightening entries or pausing new gold there if the pattern holds.`);
    if (bySideLoss.sell > bySideLoss.buy * 2 && bySideLoss.sell >= 3) tweaks.push(`Sells are losing far more than buys (${bySideLoss.sell} vs ${bySideLoss.buy}) — the desk may be over-selling a market that's turning up. The change-of-character + post-win re-analyze holds target exactly this.`);
    if (bySideLoss.buy > bySideLoss.sell * 2 && bySideLoss.buy >= 3) tweaks.push(`Buys are losing far more than sells (${bySideLoss.buy} vs ${bySideLoss.sell}) — the desk may be over-buying into breakdowns.`);
  }
  if (!tweaks.length) tweaks.push("No strong loss pattern yet — not enough real losses in the window to tweak on. Keeping the current guards.");

  const recent = counted.slice(0, 25).map((r) => ({
    at: r.resolved_at ?? r.created_at, symbol: r.symbol.toUpperCase(), side: (r.side || "").toLowerCase(),
    outcome: r.outcome, pips: Math.round(r.result_pips ?? 0), usd: Math.round(usd(r)), stopPips: stopWidthPips(r),
  }));

  return json({
    ok: true,
    generatedAt: new Date().toISOString(),
    record: {
      trades: wl, wins: wins.length, losses: losses.length, scratches: scratches.length,
      winRate: wl ? Math.round((wins.length / wl) * 100) : null,
      netPips, netUsd, grossLostPips, grossLostUsd,
    },
    perSymbol: [...bySym.entries()].map(([symbol, c]) => ({
      symbol, wins: c.w, losses: c.l, winRate: (c.w + c.l) ? Math.round((c.w / (c.w + c.l)) * 100) : null,
      netPips: Math.round(c.pips), netUsd: Math.round(c.usd),
    })).sort((a, b) => (b.wins + b.losses) - (a.wins + a.losses)),
    lossLearnings: {
      totalLosses: losses.length, gaveBackAfterGreen: gaveBack.length, wrongFromStart, wideStop: wide.length,
      bySide: bySideLoss, worstSession: worstSession ? { session: worstSession[0], count: worstSession[1] } : null,
      tweaks,
    },
    recent,
  }, 200);
}
