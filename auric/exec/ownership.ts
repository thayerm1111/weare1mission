import { admin } from "../db";
import type { TLPosition } from "../broker/tradelocker";

export const AURIC_TAG_PREFIX = "AURIC:";
export const isAuricTag = (s: string | null | undefined) => !!s && s.startsWith(AURIC_TAG_PREFIX);

export type OwnershipCheck = {
  ok: boolean;
  shared: boolean;
  sharedWith: string[];
  foreignPositions: number;
  reason: string;
  checkedAt: string;
};

/**
 * Account-level isolation. Separate software ≠ separate equity. A broker account is "shared" when any
 * other One Mission product is enabled on the SAME broker account id (read-only look-ups; nothing is
 * changed on those products). A shared account is refused unless the owner explicitly allowed it after
 * reading the conflict, and even then AURIC will only ever touch positions carrying its own tag AND a
 * matching auric_positions row.
 */
export async function checkOwnership(brokerAccountId: string, positions: TLPosition[] | null, allowShared: boolean): Promise<OwnershipCheck> {
  const db = admin();
  const sharedWith: string[] = [];
  const [flow, cc] = await Promise.all([
    db.from("flow_broker_accounts").select("id, autotrade_enabled, genx_follower, manage_trades").eq("account_id", brokerAccountId),
    db.from("cc_broker_accounts").select("id, auto_trading").eq("account_id", brokerAccountId),
  ]);
  for (const r of flow.data ?? []) if (r.autotrade_enabled || r.genx_follower || r.manage_trades) { sharedWith.push("FLOW/GENX"); break; }
  for (const r of cc.data ?? []) if (r.auto_trading) { sharedWith.push("Command Center (ATLAS)"); break; }
  const foreign = positions ? positions.filter((p) => !isAuricTag(p.strategyId)).length : -1;
  const checkedAt = new Date().toISOString();
  if (positions == null) return { ok: false, shared: sharedWith.length > 0, sharedWith, foreignPositions: -1, reason: "broker positions could not be read — external exposure unknown", checkedAt };
  if (sharedWith.length && !allowShared) {
    return { ok: false, shared: true, sharedWith, foreignPositions: foreign, checkedAt,
      reason: `This broker account is also managed by ${sharedWith.join(" and ")}. Broker equity, margin and (on netting accounts) positions are shared, so AURIC cannot guarantee ownership isolation. Use a dedicated account/sub-account, or explicitly allow a shared account in AURIC settings after reading this. Nothing on ${sharedWith.join("/")} was changed.` };
  }
  if (foreign > 0 && !allowShared) {
    return { ok: false, shared: sharedWith.length > 0, sharedWith, foreignPositions: foreign, checkedAt, reason: `${foreign} open position(s) on this account were not opened by AURIC. AURIC pauses new entries while external exposure exists unless a shared account is explicitly allowed.` };
  }
  return { ok: true, shared: sharedWith.length > 0, sharedWith, foreignPositions: foreign, checkedAt, reason: sharedWith.length ? `shared account explicitly allowed (${sharedWith.join(", ")}); AURIC touches only its own tagged positions` : "dedicated account: no other One Mission product is enabled on it" };
}
