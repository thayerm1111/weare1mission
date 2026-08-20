import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { placeMarketOrder, probeBroker, placeOnActiveAccounts } from "@/lib/flow/executor";
import { activeAccounts } from "@/lib/flow/connection";
import { sizeFromRisk, contractKey } from "@/lib/flow/sizing";

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

    if (entry == null || stop == null) return json({ ok: false, error: "missing_levels", detail: "This play needs an entry and a stop to size the trade." }, 200);

    const admin = createAdminClient();
    type Pref = { account_size?: number | null; risk_pct?: number | null };
    let pref: Pref | null = null;
    if (admin) {
      const { data } = await admin.from("flow_trade_prefs").select("account_size, risk_pct").eq("user_id", user.id).maybeSingle();
      pref = (data as Pref | null) ?? null;
    }
    const riskPct = (num(body.riskPct) ?? (pref && num(pref.risk_pct)) ?? 1) as number;
    const isGold = contractKey(symbol) === "XAUUSD";

    // Connected? Size + (on place) fan out across EVERY active account.
    const accts = await activeAccounts(user.id);
    if (accts.length) {
      const per = accts.map((a) => {
        const floor = isGold && (a.equity ?? 0) < 500;
        const s = a.equity != null ? sizeFromRisk({ canonical: symbol, entry, stop, equity: a.equity, riskPct, floorToMinLot: floor }) : null;
        return {
          accountId: a.accountId, accNum: a.accNum, name: a.name, environment: a.env, equity: a.equity,
          lots: s && s.ok ? s.lots : null, estLossAtStop: s && s.ok ? s.estLossAtStop : null,
          reason: a.equity == null ? "no_equity" : s && !s.ok ? s.reason : undefined,
        };
      });
      const sizable = per.filter((p) => p.lots != null);
      const first = sizable[0] || per[0];
      const totalLots = +sizable.reduce((n, p) => n + (p.lots || 0), 0).toFixed(2);
      const info = { riskPct, accountCount: accts.length, accounts: per, totalLots, equitySource: "broker", lots: first?.lots ?? null, equity: first?.equity ?? null, sizing: first ? { estLossAtStop: first.estLossAtStop } : null };
      if (preview) return json({ ok: true, preview: true, ...info }, 200);
      if (!sizable.length) return json({ ok: false, error: "size_failed", detail: per[0]?.reason || "Couldn't size the trade for any connected account.", ...info }, 200);

      const res = await placeOnActiveAccounts({ userId: user.id, symbol, side, entry, stop, tp, riskPct, source: "play", accounts: accts });
      const placedFills = res.accounts.filter((a) => a.status === "placed");
      const outcome = placedFills.length
        ? { status: "placed" as const, qty: placedFills[0].qty ?? null, orderId: placedFills[0].orderId ?? null, accountId: placedFills[0].accountId, environment: placedFills[0].environment }
        : { status: "error" as const, reason: res.accounts.find((a) => a.status === "error")?.reason || "No accounts filled." };
      return json({ ok: res.placed > 0, outcome, placed: res.placed, ...info, accounts: res.accounts }, 200);
    }

    // Not connected → preview only, from an entered/saved account size.
    const equity = num(body.accountSize) ?? (pref && num(pref.account_size)) ?? null;
    if (equity == null) return json({ ok: false, error: "no_account_size", detail: "Connect your TradeLocker account or save an account size so I can size the trade." }, 200);
    const floorToMinLot = isGold && equity < 500;
    const sizing = sizeFromRisk({ canonical: symbol, entry, stop, equity, riskPct, floorToMinLot });
    if (!sizing.ok) return json({ ok: false, error: "size_failed", detail: sizing.reason, sizing }, 200);
    if (sizing.lots > MAX_LOTS) return json({ ok: false, error: "size_too_large", detail: `Computed size ${sizing.lots} exceeds the ${MAX_LOTS}-lot safety cap.`, sizing }, 200);
    const info = { lots: sizing.lots, riskPct, equity, equitySource: "provided", sizing, accountCount: 0 };
    if (preview) return json({ ok: true, preview: true, ...info }, 200);
    return json({ ok: false, error: "not_connected", detail: "Connect your TradeLocker account to place this trade." }, 200);
  }

  return json({ error: "not_enabled", detail: "That action isn't switched on yet." }, 200);
}
