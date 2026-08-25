import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { connectionToken, freshAccessToken } from "@/lib/flow/connection";
import { listPositions, listInstruments } from "@/lib/flow/tradelocker";
import { matchInstrument, accountEquity } from "@/lib/flow/executor";
import { assumedPointValue, brokerPointValue, riskImpact, pointValueVerdict } from "@/lib/flow/metaAudit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * READ-ONLY diagnostic for the trade manager. Owner-gated. Places/modifies/closes
 * NOTHING — it only reads the flow_managed_positions ledger and (with ?live=1) asks
 * each account's broker which positions are actually open, so we can see WHY a
 * managed position isn't being break-even'd / partialed:
 *   • is the DB row still status='open', or did the manager mark it 'closed'?
 *   • last_error on the row (token / account_read / no_quote / no_R / be_err …)
 *   • does the broker actually still hold that position id under that acc_num?
 */
const MASTER = "3b5e06e5-258c-4880-b1f2-d1623cbca100";
function json(o: unknown, s = 200) {
  return new Response(JSON.stringify(o, null, 2), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
function posId(p: unknown): string {
  if (Array.isArray(p)) return p.length ? String(p[0]) : "";
  if (p && typeof p === "object") { const o = p as Record<string, unknown>; const v = o.id ?? o.positionId ?? o.positionID; return v == null ? "" : String(v); }
  return "";
}

export async function GET(req: NextRequest) {
  const supabase = createClient();
  if (supabase) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user || user.id !== MASTER) return json({ error: "forbidden" }, 403);
  }
  const admin = createAdminClient();
  if (!admin) return json({ error: "not_configured" }, 200);

  const sp = req.nextUrl.searchParams;

  // ── INSTRUMENT METADATA AUDIT (?instruments=1) ──────────────────────────────────────────
  // Shows, for each FLOW instrument on the OWNER's broker: the point value FLOW ASSUMES for
  // sizing vs what the broker reports, the ratio, a verdict, and the risk-% impact — so a
  // sizing constant (e.g. NAS100) is only ever changed on evidence. READ-ONLY; changes nothing.
  if (sp.get("instruments") === "1") {
    const fresh = await freshAccessToken(MASTER);
    if (!fresh.ok) return json({ error: "no_owner_connection", detail: fresh.error }, 200);
    const acc = fresh.conn.selected_account_id;
    if (!acc) return json({ error: "no_account_selected" }, 200);
    const { data: acctRow } = await admin.from("flow_broker_accounts").select("acc_num").eq("connection_id", fresh.conn.id).eq("account_id", acc).maybeSingle();
    const accNum = acctRow?.acc_num ? String(acctRow.acc_num) : null;
    if (!accNum) return json({ error: "no_acc_num" }, 200);
    const eq = await accountEquity(MASTER);
    const equity = eq.ok ? eq.equity : 100000;
    const instRes = await listInstruments(fresh.env, fresh.token, accNum, acc);
    if (!instRes.ok) return json({ error: "instrument_list_failed", detail: instRes.error }, 200);
    const FLOW_SYMBOLS = ["XAUUSD", "EURUSD", "GBPUSD", "USDJPY", "NAS100", "US30", "USOIL"];
    const rows = FLOW_SYMBOLS.map((sym) => {
      const inst = matchInstrument(sym, instRes.data);
      if (!inst) return { symbol: sym, found: false };
      const assumedPV = assumedPointValue(sym);
      const actualPV = brokerPointValue(inst);
      const { verdict, ratio } = pointValueVerdict(assumedPV, actualPV);
      return {
        symbol: sym, brokerSymbol: inst.brokerSymbol, found: true,
        assumedPointValue: assumedPV,
        broker: { contractSize: inst.contractSize ?? null, tickSize: inst.tickSize ?? null, tickValue: inst.tickValue ?? null, lotSize: inst.lotSize ?? null },
        brokerDerivedPointValue: actualPV,
        ratio, verdict,
        impact: riskImpact(assumedPV, actualPV, equity),
      };
    });
    return json({ note: "Assumed = FLOW sizing constant. brokerDerivedPointValue = tickValue/tickSize (or contractSize). verdict 'diverges' means the constant should be reviewed. Sizing is UNCHANGED by this endpoint.", equityUsed: equity, environment: fresh.env, instruments: rows });
  }

  const idsParam = (sp.get("ids") || "").split(",").map((s) => s.trim()).filter(Boolean);
  const live = sp.get("live") === "1";
  const includeDemo = sp.get("all") === "1";   // demo accounts are hidden by default; ?all=1 shows them

  // Recent managed positions (any status) — target specific ids if given, else the
  // last 24h of gold, so we can see the Crucial vs Genesis rows side by side.
  let q = admin.from("flow_managed_positions")
    .select("position_id, user_id, account_id, acc_num, connection_id, symbol, side, qty, status, be_done, partial_done, entry, init_stop, cur_stop, tp1, last_error, environment, created_at, updated_at")
    .order("created_at", { ascending: false }).limit(60);
  if (idsParam.length) q = q.in("position_id", idsParam);
  else q = q.eq("symbol", "XAUUSD").gte("created_at", new Date(Date.now() - 24 * 3600e3).toISOString());
  if (!includeDemo) q = q.neq("environment", "demo");   // LIVE-ONLY by default
  const { data: rows } = await q;
  const tracked = (rows ?? []) as Record<string, unknown>[];

  const out: Record<string, unknown> = { count: tracked.length, tracked };

  if (live) {
    // For each distinct account in the set, ask the broker what's actually open.
    const byAcct = new Map<string, { connection_id: string; account_id: string; acc_num: string }>();
    for (const r of tracked) byAcct.set(String(r.account_id), { connection_id: String(r.connection_id), account_id: String(r.account_id), acc_num: String(r.acc_num) });
    const broker: Record<string, unknown>[] = [];
    for (const a of byAcct.values()) {
      try {
        const t = await connectionToken(a.connection_id);
        if (!t.ok) { broker.push({ account_id: a.account_id, acc_num: a.acc_num, error: `token: ${t.error}` }); continue; }
        const pp = await listPositions(t.env, t.token, a.acc_num, a.account_id);
        if (!pp.ok) { broker.push({ account_id: a.account_id, acc_num: a.acc_num, error: `listPositions: ${pp.error}` }); continue; }
        broker.push({ account_id: a.account_id, acc_num: a.acc_num, openCount: pp.data.length, openIds: pp.data.map(posId).filter(Boolean) });
      } catch (e) {
        broker.push({ account_id: a.account_id, acc_num: a.acc_num, error: e instanceof Error ? e.message.slice(0, 120) : "error" });
      }
    }
    out.broker = broker;
    // Cross-check: for each tracked row, is its position_id present at its own account?
    out.check = tracked.map((r) => {
      const b = broker.find((x) => x.account_id === String(r.account_id)) as { openIds?: string[] } | undefined;
      const present = !!b?.openIds?.includes(String(r.position_id));
      return { position_id: r.position_id, acc_num: r.acc_num, status: r.status, be_done: r.be_done, partial_done: r.partial_done, last_error: r.last_error, brokerHasIt: present };
    });
  }

  return json(out);
}
