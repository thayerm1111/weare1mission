/**
 * MATTY PIPS — broker adapter (auto-trade). ISOLATED: reads FLOW's connection
 * and TradeLocker client libraries as pure functions (never modifies them),
 * stores everything in matty_pips_* tables, and manages ONLY positions it
 * opened. Members opt in per account; nothing here touches FLOW/GENX rows.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { connectionToken, getAllConnections } from "@/lib/flow/connection";
import { matchInstrument } from "@/lib/flow/executor";
import { sizeFromRisk } from "@/lib/flow/sizing";
import { listInstruments, listAccounts, listPositions, createOrder, type TLEnv, type TLInstrument } from "@/lib/flow/tradelocker";
import { getInstrument, priceToPips } from "./pips";
import type { DecisionObject } from "./types";

type Admin = NonNullable<ReturnType<typeof createAdminClient>>;

export type MpAccountRow = {
  id?: string; user_id: string; connection_id: string; account_id: string; acc_num: string;
  name: string | null; currency: string | null;
  enabled: boolean; mode: string; risk_pct: number;
  be_enabled: boolean; partials_enabled: boolean; max_open: number;
};

/** UI list: every broker account the member has, merged with Matty Pips settings. */
export async function listMemberAccounts(admin: Admin, userId: string): Promise<MpAccountRow[]> {
  const conns = await getAllConnections(userId);
  const out: MpAccountRow[] = [];
  const { data: settings } = await admin.from("matty_pips_accounts").select("*").eq("user_id", userId);
  const map = new Map<string, Record<string, unknown>>();
  for (const s of (settings ?? []) as Record<string, unknown>[]) map.set(String(s.account_id), s);
  for (const conn of conns) {
    const { data } = await admin.from("flow_broker_accounts")
      .select("account_id, acc_num, name, currency").eq("connection_id", conn.id);
    for (const a of (data ?? []) as { account_id: string; acc_num: string | null; name: string | null; currency: string | null }[]) {
      if (!a.acc_num) continue;
      const s = map.get(String(a.account_id));
      out.push({
        user_id: userId, connection_id: conn.id, account_id: String(a.account_id), acc_num: String(a.acc_num),
        name: a.name, currency: a.currency,
        enabled: s?.enabled === true,
        mode: (s?.mode as string) || "conservative",
        risk_pct: Number(s?.risk_pct ?? 0.5),
        be_enabled: s?.be_enabled !== false,
        partials_enabled: s?.partials_enabled !== false,
        max_open: Number(s?.max_open ?? 1),
      });
    }
  }
  return out;
}

/** Cron: all accounts with Matty Pips auto ON. */
export async function enabledAccounts(admin: Admin): Promise<MpAccountRow[]> {
  const { data } = await admin.from("matty_pips_accounts").select("*").eq("enabled", true).limit(200);
  return ((data ?? []) as MpAccountRow[]).filter((r) => r.acc_num && r.account_id && r.connection_id);
}

const instCache = new Map<string, { at: number; data: TLInstrument[] }>();

/**
 * Place ONE market order for a TAKE_NOW decision on one opted-in account.
 * Claims the (account, signal) pair first via the unique index, so overlapping
 * cron runs can never double-fill. Best-effort: every failure is recorded.
 */
export async function placeForAccount(admin: Admin, acct: MpAccountRow, d: DecisionObject, signalKey: string): Promise<{ placed: boolean; reason: string }> {
  const t = d.trade;
  if (!t) return { placed: false, reason: "no_trade" };

  // CLAIM (unique account_id+signal_key): if the row already exists, another run has it.
  const { data: claim, error: claimErr } = await admin.from("matty_pips_trades").insert({
    user_id: acct.user_id, account_id: acct.account_id, acc_num: acct.acc_num, connection_id: acct.connection_id,
    signal_key: signalKey, symbol: d.symbol, direction: t.direction, setup_type: t.setupType,
    entry: t.entry, stop: t.stopLoss, tp1: t.tp1, tp2: t.tp2, runner: t.runnerTarget,
    score: d.score.total, mode: d.mode, status: "placing",
  }).select("id").maybeSingle();
  if (claimErr || !claim) return { placed: false, reason: "already_claimed_or_insert_failed" };
  const tradeId = (claim as { id: string }).id;
  const fail = async (msg: string) => {
    await admin.from("matty_pips_trades").update({ status: "failed", error: msg.slice(0, 220), updated_at: new Date().toISOString() }).eq("id", tradeId);
    return { placed: false, reason: msg.slice(0, 120) };
  };

  // Max simultaneous.
  const { count } = await admin.from("matty_pips_positions").select("id", { count: "exact", head: true })
    .eq("account_id", acct.account_id).eq("status", "open");
  if ((count ?? 0) >= (acct.max_open || 1)) return fail(`max_open reached (${count})`);

  // Token + instrument + equity.
  const tok = await connectionToken(acct.connection_id);
  if (!tok.ok) return fail(`auth: ${tok.error}`);
  const env: TLEnv = tok.env;
  const ck = `${acct.connection_id}:${env}`;
  let instruments = instCache.get(ck)?.data;
  if (!instruments || Date.now() - (instCache.get(ck)?.at ?? 0) > 10 * 60_000) {
    const li = await listInstruments(env, tok.token, acct.acc_num, acct.account_id);
    if (!li.ok) return fail(`instruments: ${li.error}`);
    instruments = li.data; instCache.set(ck, { at: Date.now(), data: instruments });
  }
  const inst = matchInstrument(d.symbol, instruments);
  if (!inst) return fail(`instrument ${d.symbol} not found on account`);
  const accs = await listAccounts(env, tok.token);
  const live = accs.ok ? accs.data.find((x) => String(x.accountId) === String(acct.account_id)) : undefined;
  const equity = typeof live?.equity === "number" ? live.equity : typeof live?.balance === "number" ? live.balance : null;
  if (!equity || equity <= 0) return fail("no_equity");

  // Risk-based size from the STRUCTURAL stop (wider stop → smaller size).
  const size = sizeFromRisk({
    canonical: d.symbol, entry: t.entry, stop: t.stopLoss, equity, riskPct: acct.risk_pct || 0.5,
    broker: { quantityStep: inst.quantityStep, minQuantity: inst.minQuantity }, floorToMinLot: true,
  });
  if (!size.ok || !(size.lots > 0)) return fail(`sizing: ${size.reason || "zero lots"}`);

  // Snapshot open positions to resolve the new id after the market fill.
  const before = await listPositions(env, tok.token, acct.acc_num, acct.account_id);
  const beforeIds = new Set((before.ok ? before.data : []).map(posId).filter(Boolean));

  const order = await createOrder(env, tok.token, {
    accountId: acct.account_id, accNum: acct.acc_num,
    tradableInstrumentId: inst.tradableInstrumentId, routeId: inst.routeId,
    side: t.direction, type: "market", qty: size.lots,
    stopLoss: t.stopLoss, takeProfit: t.tp1,
  });
  if (!order.ok) return fail(`order: ${order.error}`);

  // Resolve position id (market orders return an orderId; the position lands a beat later).
  let positionId = order.data.positionId ?? null;
  for (let i = 0; i < 4 && !positionId; i++) {
    await new Promise((r) => setTimeout(r, 600));
    const pp = await listPositions(env, tok.token, acct.acc_num, acct.account_id);
    if (pp.ok) positionId = pp.data.map(posId).filter(Boolean).find((id) => !beforeIds.has(id)) ?? null;
  }

  await admin.from("matty_pips_trades").update({
    status: "placed", qty: size.lots, order_id: order.data.orderId ?? null, position_id: positionId, updated_at: new Date().toISOString(),
  }).eq("id", tradeId);

  if (positionId) {
    const meta = getInstrument(d.symbol);
    await admin.from("matty_pips_positions").insert({
      user_id: acct.user_id, connection_id: acct.connection_id, account_id: acct.account_id, acc_num: acct.acc_num,
      environment: env, position_id: positionId, symbol: d.symbol, side: t.direction,
      entry: t.entry, init_stop: t.stopLoss, cur_stop: t.stopLoss, tp1: t.tp1,
      tp1_pips: t.tp1Pips, qty: size.lots, tid: inst.tradableInstrumentId, route_id: inst.routeId,
      be_enabled: acct.be_enabled, partials_enabled: acct.partials_enabled,
      be_trigger: t.management.breakevenAtPips, partial_trigger: t.management.partialAtPips, lock_pips: t.management.lockProfitPips,
    });
    void meta;
  }
  return { placed: true, reason: positionId ? "placed" : "placed_no_position_id" };
}

function posId(p: unknown): string {
  if (Array.isArray(p)) return p.length ? String(p[0]) : "";
  if (p && typeof p === "object") { const o = p as Record<string, unknown>; const v = o.id ?? o.positionId ?? o.positionID; return v == null ? "" : String(v); }
  return "";
}

export function pipsFrom(symbol: string, from: number, to: number, side: "buy" | "sell"): number {
  const signed = side === "buy" ? to - from : from - to;
  return Math.sign(signed) * priceToPips(symbol, Math.abs(signed));
}
