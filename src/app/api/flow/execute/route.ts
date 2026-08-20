import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { placeMarketOrder, probeBroker, accountEquity } from "@/lib/flow/executor";
import { sizeFromRisk } from "@/lib/flow/sizing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * FLOW order placement — MEMBER-INITIATED only. Requires the member's own
 * authenticated session; a member can only ever act on their own connected
 * account.
 *   • "test"  — hard-capped 0.01-lot order to prove the broker pipe.
 *   • "probe" — read-only diagnostics, places nothing.
 *   • "play"  — semi-auto execute of a generated play (OM AI Play / signal).
 *               Sizes the lot from the member's risk % against LIVE broker equity
 *               (falling back to a saved account size), attaches the play's stop
 *               and take-profit, and places it at market ONLY when the member taps
 *               Execute. `preview:true` returns the computed size WITHOUT placing.
 */
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const MAX_LOTS = 100; // fat-finger backstop

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? parseFloat(v) : (v as number);
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

export async function POST(req: NextRequest) {
  const supabase = createClient();
  if (!supabase) return json({ error: "unauthorized" }, 401);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  let body: Record<string, unknown> = {};
  try { body = (await req.json()) as Record<string, unknown>; } catch { /* */ }
  const symbol = typeof body.symbol === "string" ? body.symbol : "XAUUSD";
  const side: "buy" | "sell" = body.side === "sell" ? "sell" : "buy";
  const source = body.source === "test" ? "test" : body.source === "probe" ? "probe" : body.source === "play" ? "play" : "manual";

  if (source === "probe") {
    const probe = await probeBroker(user.id, symbol);
    return json({ ok: probe.ok === true, probe }, 200);
  }

  if (source === "test") {
    const out = await placeMarketOrder({ userId: user.id, symbol, side, qty: 0.01, source: "test" });
    return json({ ok: out.status === "placed", outcome: out }, 200);
  }

  if (source === "play") {
    const entry = num(body.entry);
    const stop = num(body.stop);
    const tp = num(body.tp);
    const preview = body.preview === true;
    const explicitLots = num(body.lots);

    if (entry == null || stop == null) return json({ ok: false, error: "missing_levels", detail: "This play needs an entry and a stop to size the trade." }, 200);

    // Equity: live broker equity first, then a saved account size, then a provided one.
    const admin = createAdminClient();
    type Pref = { account_size?: number | null; risk_pct?: number | null };
    let pref: Pref | null = null;
    if (admin) {
      const { data } = await admin.from("flow_trade_prefs").select("account_size, risk_pct").eq("user_id", user.id).maybeSingle();
      pref = (data as Pref | null) ?? null;
    }
    const eq = await accountEquity(user.id);
    let equity: number | null = null;
    let equitySource = "";
    if (eq.ok) { equity = eq.equity; equitySource = "broker"; }
    else if (num(body.accountSize)) { equity = num(body.accountSize); equitySource = "provided"; }
    else if (pref && num(pref.account_size)) { equity = num(pref.account_size); equitySource = "saved"; }

    const riskPct = num(body.riskPct) ?? (pref && num(pref.risk_pct)) ?? 1;

    // Determine lots: explicit override, else risk-based sizing.
    let lots: number;
    let sizing: ReturnType<typeof sizeFromRisk> | null = null;
    if (explicitLots && explicitLots > 0) {
      lots = explicitLots;
    } else {
      if (equity == null) return json({ ok: false, error: "no_account_size", detail: "Connect your TradeLocker account or save an account size so I can size the trade." }, 200);
      sizing = sizeFromRisk({ canonical: symbol, entry, stop, equity, riskPct: riskPct as number });
      if (!sizing.ok) return json({ ok: false, error: "size_failed", detail: sizing.reason, sizing }, 200);
      lots = sizing.lots;
    }
    if (lots > MAX_LOTS) return json({ ok: false, error: "size_too_large", detail: `Computed size ${lots} exceeds the ${MAX_LOTS}-lot safety cap.`, sizing }, 200);

    const info = { lots, riskPct, equity, equitySource, sizing };
    if (preview) return json({ ok: true, preview: true, ...info }, 200);

    const out = await placeMarketOrder({ userId: user.id, symbol, side, qty: lots, stop, tp, source: "play" });
    return json({ ok: out.status === "placed", outcome: out, ...info }, 200);
  }

  return json({ error: "not_enabled", detail: "That action isn't switched on yet." }, 200);
}
