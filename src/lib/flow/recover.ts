import { createAdminClient } from "@/lib/supabase/admin";
import { connectionToken } from "@/lib/flow/connection";
import { listPositions, listInstruments, getConfig, type TLEnv } from "@/lib/flow/tradelocker";
import { matchInstrument } from "@/lib/flow/executor";
import { contractKey } from "@/lib/flow/sizing";

/**
 * ORPHAN-POSITION RECOVERY (P1-F).
 *
 * When FLOW submits an entry and the broker FILLS it, but the acknowledgement is lost
 * (a request TIMEOUT after the fill, a crash/redeploy mid-placement, or the post-order
 * position-id poll simply misses the new position), the live position ends up with NO
 * flow_managed_positions row — so it is never break-even'd / partialed / trailed and is
 * invisible to the desk. This module reconciles that: it finds recent FLOW PLACEMENTS
 * (logged in flow_auto_events) that have no managed row, asks the broker what's actually
 * open on that account, and ADOPTS the matching live position into management.
 *
 * SAFETY — it must never adopt a user's unrelated MANUAL position. Adoption requires a
 * matching FLOW placement event (proof FLOW placed on this account/symbol/side recently)
 * AND a broker position that matches on HARD identifiers: same tradable instrument, same
 * side, quantity within tolerance, and — when more than one candidate — the stop-loss the
 * event recorded. Any ambiguity (two equally-plausible untracked positions) → skip, never
 * guess. It only ever INSERTS a managed row; it never places / modifies / closes an order.
 */

type Admin = NonNullable<ReturnType<typeof createAdminClient>>;

export type BrokerPos = { positionId: string; instrId: string; side: string; qty: number; sl: number | null; avg: number | null; tp: number | null };
export type OrphanWant = { instrId: string; side: "buy" | "sell"; qty: number; stop: number | null };

/**
 * Choose the single broker position that is FLOW's just-placed orphan, or null.
 * Match on instrument + side + quantity (within 2%); if several match, disambiguate by the
 * recorded stop; if still ambiguous, return null (do NOT adopt on a guess). `trackedIds`
 * are position ids already owned by a managed row and are always excluded.
 * PURE + unit-tested.
 */
export function pickOrphanMatch(positions: BrokerPos[], want: OrphanWant, trackedIds: Set<string>): BrokerPos | null {
  if (!want.instrId || !(want.qty > 0)) return null;
  const qtyClose = (a: number, b: number) => b > 0 && Math.abs(a - b) <= Math.max(b * 0.02, 0.005);
  let cands = positions.filter((p) =>
    p.positionId && !trackedIds.has(String(p.positionId)) &&
    String(p.instrId) === String(want.instrId) &&
    String(p.side).toLowerCase() === want.side &&
    p.qty > 0 && qtyClose(p.qty, want.qty),
  );
  if (cands.length === 0) return null;
  if (cands.length > 1 && want.stop != null) {
    const tol = Math.max(Math.abs(want.stop) * 0.001, 1e-9);
    const bySl = cands.filter((p) => p.sl != null && Math.abs((p.sl as number) - (want.stop as number)) <= tol);
    if (bySl.length >= 1) cands = bySl;
  }
  return cands.length === 1 ? cands[0] : null; // ambiguous → skip
}

// ── column detection + row normalisation (broker returns positions as columnar arrays) ──
function idOfCol(c: unknown): string { return String((c as Record<string, unknown>)?.id ?? (c as Record<string, unknown>)?.key ?? (c as Record<string, unknown>)?.name ?? ""); }
function posIdOf(p: unknown): string {
  if (Array.isArray(p)) return p.length ? String(p[0]) : "";
  if (p && typeof p === "object") { const o = p as Record<string, unknown>; const v = o.id ?? o.positionId ?? o.positionID; return v == null ? "" : String(v); }
  return "";
}
function valAt(p: unknown, idx: number, keys: string[]): unknown {
  if (Array.isArray(p)) { return idx >= 0 && idx < p.length ? p[idx] : undefined; }
  if (p && typeof p === "object") { const o = p as Record<string, unknown>; for (const k of keys) { if (o[k] !== undefined && o[k] !== null) return o[k]; } }
  return undefined;
}
function numAt(p: unknown, idx: number, keys: string[]): number | null { const v = valAt(p, idx, keys); const n = typeof v === "string" ? parseFloat(v) : Number(v); return Number.isFinite(n) ? n : null; }

type PosCols = { instrIdx: number; sideIdx: number; qtyIdx: number; slIdx: number; tpIdx: number; avgIdx: number };
async function positionCols(env: TLEnv, token: string, accNum: string): Promise<PosCols> {
  const def: PosCols = { instrIdx: 1, sideIdx: 3, qtyIdx: 4, slIdx: -1, tpIdx: -1, avgIdx: 5 };
  try {
    const cfg = await getConfig(env, token, accNum);
    if (!cfg.ok) return def;
    const d = ((cfg.data as Record<string, unknown>)?.d ?? cfg.data) as Record<string, unknown>;
    const raw = d?.positionsConfig as unknown;
    const cols = (Array.isArray(raw) ? raw : (raw as Record<string, unknown>)?.columns) as unknown[] | undefined;
    if (!Array.isArray(cols) || !cols.length) return def;
    const find = (pred: (id: string) => boolean) => cols.findIndex((c) => pred(idOfCol(c).toLowerCase()));
    const instrIdx = find((id) => id === "tradableinstrumentid" || id === "instrumentid");
    const sideIdx = find((id) => id === "side");
    const qtyIdx = find((id) => id === "qty" || id === "quantity" || id === "volume");
    const slIdx = find((id) => id === "stoploss" || id === "stoplossprice" || id === "sl");
    const tpIdx = find((id) => id === "takeprofit" || id === "takeprofitprice" || id === "tp");
    const avgIdx = find((id) => id === "avgprice");
    return {
      instrIdx: instrIdx >= 0 ? instrIdx : def.instrIdx,
      sideIdx: sideIdx >= 0 ? sideIdx : def.sideIdx,
      qtyIdx: qtyIdx >= 0 ? qtyIdx : def.qtyIdx,
      slIdx, tpIdx,
      avgIdx: avgIdx >= 0 ? avgIdx : def.avgIdx,
    };
  } catch { return def; }
}
function normalizePos(p: unknown, cols: PosCols): BrokerPos {
  return {
    positionId: posIdOf(p),
    instrId: String(valAt(p, cols.instrIdx, ["tradableInstrumentId", "instrumentId"]) ?? ""),
    side: String(valAt(p, cols.sideIdx, ["side"]) ?? "").toLowerCase(),
    qty: numAt(p, cols.qtyIdx, ["qty", "quantity", "volume", "size"]) ?? 0,
    sl: numAt(p, cols.slIdx, ["stopLoss", "sl"]),
    avg: numAt(p, cols.avgIdx, ["avgPrice", "openPrice", "price"]),
    tp: numAt(p, cols.tpIdx, ["takeProfit", "tp"]),
  };
}

type EvRow = { id: string; user_id: string; account_id: string; symbol: string; side: "buy" | "sell"; qty: number | null; entry: number | null; stop: number | null; tp: number | null; status: string; created_at: string };
type MrRow = { account_id: string; symbol: string; side: string; position_id: string | null; created_at: string };
type AccRow = { account_id: string; connection_id: string; acc_num: string; environment?: string | null };

/**
 * Scan recent FLOW placements for orphans and adopt the matching live broker positions.
 * Best-effort and cheap on the common path: if there are no recent placements without a
 * managed row, it makes a single small query and returns. Safe to call every manage tick.
 */
export async function recoverOrphans(admin: Admin): Promise<{ adopted: number; checked: number }> {
  const sinceIso = new Date(Date.now() - 15 * 60_000).toISOString();
  const { data: ev } = await admin.from("flow_auto_events")
    .select("id,user_id,account_id,symbol,side,qty,entry,stop,tp,status,created_at")
    .in("status", ["placed", "uncertain"])
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false }).limit(100);
  const events = (ev ?? []) as EvRow[];
  if (!events.length) return { adopted: 0, checked: 0 };

  const acctIds = [...new Set(events.map((e) => String(e.account_id)).filter(Boolean))];
  const { data: mr } = await admin.from("flow_managed_positions")
    .select("account_id,symbol,side,position_id,created_at")
    .in("account_id", acctIds)
    .gte("created_at", new Date(Date.now() - 30 * 60_000).toISOString());
  const managed = (mr ?? []) as MrRow[];
  const trackedByAcct = new Map<string, Set<string>>();
  for (const m of managed) {
    const s = trackedByAcct.get(String(m.account_id)) ?? new Set<string>();
    if (m.position_id) s.add(String(m.position_id));
    trackedByAcct.set(String(m.account_id), s);
  }
  const canon = (s: string) => contractKey(s);
  const hasManagedNear = (e: EvRow) => managed.some((m) =>
    String(m.account_id) === String(e.account_id) &&
    canon(m.symbol) === canon(e.symbol) &&
    m.side === e.side &&
    Math.abs(Date.parse(m.created_at) - Date.parse(e.created_at)) < 6 * 60_000);

  const orphans = events.filter((e) => e.account_id && e.symbol && e.side && !hasManagedNear(e));
  if (!orphans.length) return { adopted: 0, checked: 0 };

  const { data: accRows } = await admin.from("flow_broker_accounts")
    .select("account_id,connection_id,acc_num,environment")
    .in("account_id", [...new Set(orphans.map((o) => String(o.account_id)))]);
  const accInfo = new Map<string, AccRow>();
  for (const a of (accRows ?? []) as AccRow[]) accInfo.set(String(a.account_id), a);

  const byAcct = new Map<string, EvRow[]>();
  for (const o of orphans) { const k = String(o.account_id); const arr = byAcct.get(k) ?? []; arr.push(o); byAcct.set(k, arr); }

  let adopted = 0, checked = 0;
  for (const [accountId, evs] of byAcct) {
    const info = accInfo.get(accountId);
    if (!info) continue;
    const tok = await connectionToken(info.connection_id);
    if (!tok.ok) continue;
    checked += evs.length;
    const posRes = await listPositions(tok.env, tok.token, info.acc_num, accountId);
    const instRes = await listInstruments(tok.env, tok.token, info.acc_num, accountId);
    if (!posRes.ok || !instRes.ok) continue;
    const cols = await positionCols(tok.env, tok.token, info.acc_num);
    const bposs = posRes.data.map((p) => normalizePos(p, cols)).filter((p) => p.positionId);
    const tracked = trackedByAcct.get(accountId) ?? new Set<string>();
    for (const e of evs) {
      const inst = matchInstrument(canon(e.symbol), instRes.data);
      if (!inst) continue;
      const want: OrphanWant = { instrId: String(inst.tradableInstrumentId), side: e.side, qty: Number(e.qty) || 0, stop: e.stop != null ? Number(e.stop) : null };
      const match = pickOrphanMatch(bposs, want, tracked);
      if (!match) continue;
      const entry = (match.avg != null && match.avg > 0) ? match.avg : (e.entry != null ? Number(e.entry) : null);
      const sl = match.sl != null ? match.sl : (e.stop != null ? Number(e.stop) : null);
      const tp = match.tp != null ? match.tp : (e.tp != null ? Number(e.tp) : null);
      if (entry == null || sl == null) continue; // cannot manage without a real entry + stop
      const ins = await admin.from("flow_managed_positions").insert({
        user_id: e.user_id, connection_id: info.connection_id, account_id: accountId, acc_num: info.acc_num,
        environment: info.environment ?? tok.env,
        position_id: match.positionId, symbol: canon(e.symbol), side: e.side,
        entry, init_stop: sl, tp1: tp, r: Math.abs(entry - sl), qty: match.qty, cur_stop: sl, best_price: entry, status: "open",
      });
      if (!ins.error) { adopted += 1; tracked.add(String(match.positionId)); }
    }
    trackedByAcct.set(accountId, tracked);
  }
  return { adopted, checked };
}
