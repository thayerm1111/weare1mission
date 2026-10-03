import { createAdminClient } from "@/lib/supabase/admin";
import { GENFX_VERSION } from "@/lib/genfx/control";
import { type PairKey } from "@/lib/genfx/pairs";

/**
 * GEN FX — WRITING A POSITION INTO THE LEDGER (flow_managed_positions), once.
 *
 * A fill has to end up as exactly one ledger row carrying GEN FX's stamp: no row and the trade
 * manager never runs it (no break-even, no trail, no booked result, invisible to the desk breaker);
 * two rows and it is managed and counted twice.
 *
 * ONE WRITER reaches a GEN FX position: the books pass (settle.ts), once the broker's own rows show
 * that the order executed and which position it opened. Placement used to write the row itself when the
 * broker named a position at once; it no longer does — every check on "is this position really this
 * order's, and only this order's?" now lives in one place. The trade manager's own orphan recovery
 * (flow/recover.ts) leaves GEN FX's orders alone, because it recognises a fill by its size and GEN FX
 * recognises its own by label. And the database holds the line under all of it: one GEN FX row per
 * account and position (flow_managed_positions_genfx_position_uidx), so a second insert — two books
 * passes overlapping — is refused rather than written.
 *
 * So this does three things, and reports honestly which happened:
 *   • a row for this position already exists → if it is this call's, fine ("exists"); if it is ANYBODY
 *     ELSE'S — another call's, or a row with no stamp at all, which is how FLOW's and gold's own trades
 *     are written — that is refused ("other_owner"). The broker put this order into a position that
 *     was already open (a netting account), and calling that "managed" would be calling one position
 *     two trades. An unstamped row is never taken over: the first version stamped it, and would have
 *     put GEN FX's name on a member's own trade;
 *   • none exists → insert it ("written"); a refusal by the unique index means the other writer got
 *     there first, and the row is looked at again;
 *   • anything fails → { ok: false }, and the caller keeps the fill unsettled so the books pass tries
 *     again. supabase-js RETURNS errors rather than throwing them; every result here is looked at.
 */
type Admin = NonNullable<ReturnType<typeof createAdminClient>>;

export type FxPosition = {
  userId: string; connectionId: string | null; accountId: string; accNum: string | null; environment: string | null;
  positionId: string; pair: PairKey; side: "buy" | "sell";
  entry: number; stop: number; tp: number | null; qty: number;
  mode: string | null; signalKey: string; setup: string | null;
};
export type LedgerWrite = { ok: boolean; how: "written" | "exists" | "other_owner" | "ledger_unreadable" | "insert_failed" };

export const fxStamp = (x: { mode: string | null; signalKey: string; setup: string | null }) =>
  ({ strategy_version: GENFX_VERSION, mode: x.mode, signal_id: x.signalKey, setup_family: x.setup });

type OwnerRow = { strategy_version: string | null; signal_id: string | null };
const isMine = (r: OwnerRow, signalKey: string) => r.strategy_version === GENFX_VERSION && r.signal_id === signalKey;

/**
 * Whose is this position, by the ledger? "mine": this call's row is there. "other": a row is there and
 * it is not this call's. "none": no row. Null: the ledger could not be read. Asked BEFORE a position is
 * touched at the broker — a position somebody else's trade is running does not get its stop moved.
 */
export async function ledgerOwner(admin: Admin, accountId: string, positionId: string, signalKey: string): Promise<"mine" | "other" | "none" | null> {
  try {
    const { data, error } = await admin.from("flow_managed_positions").select("strategy_version, signal_id").eq("account_id", accountId).eq("position_id", positionId).limit(20);
    if (error) return null;
    const rows = (data ?? []) as OwnerRow[];
    return !rows.length ? "none" : rows.some((r) => isMine(r, signalKey)) ? "mine" : "other";
  } catch { return null; }
}

export async function ensureLedgerRow(admin: Admin, x: FxPosition): Promise<LedgerWrite> {
  const stamp = fxStamp(x);
  const find = () => admin.from("flow_managed_positions").select("id, strategy_version, signal_id, created_at")
    .eq("account_id", x.accountId).eq("position_id", x.positionId).order("created_at", { ascending: true }).limit(20);
  const settle = (rows: OwnerRow[]): LedgerWrite => (rows.some((r) => isMine(r, x.signalKey)) ? { ok: true, how: "exists" } : { ok: false, how: "other_owner" });
  try {
    const have = await find();
    if (have.error) return { ok: false, how: "ledger_unreadable" };
    const rows = (have.data ?? []) as OwnerRow[];
    if (rows.length) return settle(rows);

    const ins = await admin.from("flow_managed_positions").insert({
      user_id: x.userId, connection_id: x.connectionId, account_id: x.accountId, acc_num: x.accNum, environment: x.environment,
      position_id: x.positionId, symbol: x.pair, side: x.side,
      entry: x.entry, init_stop: x.stop, tp1: x.tp, r: Math.abs(x.entry - x.stop), qty: x.qty, cur_stop: x.stop, best_price: x.entry,
      ...stamp,
    }).select("id").single();
    if (ins.error) {
      // 23505: the other writer's row landed between the look and the insert. Look again.
      if ((ins.error as { code?: string }).code !== "23505") return { ok: false, how: "insert_failed" };
      const again = await find();
      const now = (again.data ?? []) as OwnerRow[];
      return again.error || !now.length ? { ok: false, how: "insert_failed" } : settle(now);
    }
    return (ins.data as { id?: string } | null)?.id ? { ok: true, how: "written" } : { ok: false, how: "insert_failed" };
  } catch { return { ok: false, how: "ledger_unreadable" }; }
}
