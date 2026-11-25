import { admin, tradingNamespace } from "../db";
import { createHash } from "node:crypto";
import { field } from "../broker/http";

/**
 * Account-level isolation.
 *
 * Separate software is not separate money. Two products on the same broker account share equity,
 * margin and — on a netting account — positions. Rapid therefore refuses to arm an account another
 * One Mission product is already trading, unless the owner has explicitly accepted the conflict, and
 * even then it only ever touches positions that carry its own tag AND have a matching
 * `rapid_positions` row. A tag on its own is a string somebody could have typed.
 */

export const RAPID_TAG_PREFIX = "RAPID:";
export const isRapidTag = (s: unknown): boolean => typeof s === "string" && s.startsWith(tradingNamespace() === "nitrous" ? "NITROUS:" : RAPID_TAG_PREFIX);
export const tagFor = (intentKey: string): string => tradingNamespace() === "nitrous"
  ? `NITROUS:${createHash("sha256").update(intentKey).digest("hex").slice(0, 23)}`
  : `${RAPID_TAG_PREFIX}${intentKey}`.slice(0, 31);

export type OwnershipCheck = {
  ok: boolean;
  shared: boolean;
  sharedWith: string[];
  foreignPositions: number;
  reason: string;
  checkedAt: string;
};

/** Sharing changes entry eligibility, never which product owns an existing position. */
export function accountOwnershipDecision(input: {
  scope: "rapid" | "nitrous";
  sharedWith: string[];
  positions: unknown[] | null;
  positionCols: Record<string, number>;
  allowShared: boolean;
  checkedAt: string;
}): OwnershipCheck {
  const { scope, positions, positionCols, allowShared, checkedAt } = input;
  // Nitrous uses current broker exposure, not registries of other or retired products.
  const sharedWith = scope === "nitrous" ? [] : input.sharedWith;
  if (positions == null) {
    return { ok: false, shared: sharedWith.length > 0, sharedWith, foreignPositions: -1, checkedAt,
      reason: "the broker's open positions could not be read, so external exposure on this account is unknown" };
  }

  const prefix = scope === "nitrous" ? "NITROUS:" : RAPID_TAG_PREFIX;
  const foreign = positions.filter((p) => {
    const tag = field(p, positionCols, ["strategyId", "comment"]);
    return !(typeof tag === "string" && tag.startsWith(prefix));
  }).length;

  if (sharedWith.length && !allowShared) {
    return { ok: false, shared: true, sharedWith, foreignPositions: foreign, checkedAt,
      reason: `This broker account is also traded by ${sharedWith.join(" and ")}. Equity, margin and — on a netting account — positions are shared, so Rapid cannot guarantee isolation. Use a dedicated account or sub-account, or allow a shared account in Rapid's settings after reading this. Nothing on ${sharedWith.join("/")} has been changed.` };
  }
  if (foreign > 0 && !allowShared) {
    if (scope === "nitrous") return { ok: false, shared: sharedWith.length > 0, sharedWith, foreignPositions: foreign, checkedAt,
      reason: `${foreign} open position(s) were not opened by Nitrous. Shared-account access is not enabled on this Nitrous account.` };
    return { ok: false, shared: sharedWith.length > 0, sharedWith, foreignPositions: foreign, checkedAt,
      reason: `${foreign} open position(s) on this account were not opened by Rapid. New entries stay paused while external exposure exists, unless a shared account is explicitly allowed.` };
  }
  if (scope === "nitrous") {
    return { ok: true, shared: foreign > 0, sharedWith: [], foreignPositions: foreign, checkedAt,
      reason: allowShared ? "Shared-account access enabled. Nitrous manages only its own tagged positions."
        : "Account exposure verified. Nitrous manages only its own tagged positions." };
  }
  return { ok: true, shared: sharedWith.length > 0, sharedWith, foreignPositions: foreign, checkedAt,
    reason: sharedWith.length ? `shared account explicitly allowed (${sharedWith.join(", ")}); Rapid touches only its own tagged positions` : "dedicated account: no other One Mission product is enabled on it" };
}

export async function checkOwnership(
  brokerAccountId: string,
  positions: unknown[] | null,
  positionCols: Record<string, number>,
  allowShared: boolean,
): Promise<OwnershipCheck> {
  const scope = tradingNamespace();
  const checkedAt = new Date().toISOString();
  // No other-product lookup participates in Nitrous readiness. Connection ownership and
  // exact broker-ID/tag position ownership are verified by the Nitrous caller and manager.
  if (scope === "nitrous") {
    return accountOwnershipDecision({ scope, sharedWith: [], positions, positionCols, allowShared, checkedAt });
  }
  const db = admin();
  const sharedWith: string[] = [];

  const [flow, cc, auric] = await Promise.all([
    db.from("flow_broker_accounts").select("id, autotrade_enabled, genx_follower, manage_trades").eq("account_id", brokerAccountId),
    db.from("cc_broker_accounts").select("id, auto_trading").eq("account_id", brokerAccountId),
    db.from("auric_accounts").select("id, status").eq("broker_account_id", brokerAccountId),
  ]);
  for (const r of (flow.data ?? []) as Array<Record<string, unknown>>) {
    if (r.autotrade_enabled || r.genx_follower || r.manage_trades) { sharedWith.push("FLOW/GENX"); break; }
  }
  for (const r of (cc.data ?? []) as Array<Record<string, unknown>>) {
    if (r.auto_trading) { sharedWith.push("Command Center (ATLAS)"); break; }
  }
  for (const r of (auric.data ?? []) as Array<Record<string, unknown>>) {
    if (r.status === "linked") { sharedWith.push("AURIC"); break; }
  }

  return accountOwnershipDecision({ scope, sharedWith, positions, positionCols, allowShared, checkedAt });
}
