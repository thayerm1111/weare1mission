/**
 * WORKING ORDERS ARE EXPOSURE (owner 09-24: "Now there's multiple entries on all accounts. It's
 * supposed to be one at a time").
 *
 * The one-gold-at-a-time cap only ever looked at OPEN POSITIONS. A GENX zone entry is usually a
 * SELL_LIMIT or BUY_LIMIT resting above or below price, and a resting order is not a position — so
 * it was invisible to every guard:
 *
 *   • flow_managed_positions has no row for it (a row is written when the position exists),
 *   • the broker reports no position,
 *   • and the genx_reserve_gold reservation expires after 60s while the order can rest for hours.
 *
 * On 09-24 that put two sells on one account: a SELL_LIMIT at 4299.35 placed 01:46 was still resting
 * when a second at 4292.55 went out at 01:50, and both filled. The reservation module's own header has
 * claimed all along that "WORKING (unfilled) broker orders are counted by the caller via a broker
 * listOrders check before submit" — that check did not exist anywhere in the GENX placement paths.
 * This file is it.
 *
 * The rule matches open positions exactly (see hedge.ts): a same-side working order blocks, an
 * opposite-side one does not while hedging is on. Unreadable broker → null, and callers FAIL CLOSED,
 * because a missed entry is recoverable and a stacked position is not.
 */
import { listOrders, type TLEnv } from "@/lib/flow/tradelocker";
import { brokerConfig, columnMap, field } from "@/lib/flow/brokerEvidence";
import { blocksEntry } from "@/lib/genx/hedge";

/** Broker order states that mean "this order is still live and can still fill". */
const LIVE_STATUSES = new Set(["new", "working", "open", "pending", "accepted", "partiallyfilled", "placed", "active"]);

const norm = (v: unknown) => String(v ?? "").toLowerCase().replace(/[ _-]/g, "");

/** Is this row a resting ENTRY order (not the protective stop/TP attached to a position)? */
export function isWorkingEntry(row: unknown, cols: Record<string, number> | undefined): boolean {
  const status = norm(field(row, cols, ["status", "orderStatus"]));
  if (!LIVE_STATUSES.has(status)) return false;
  const type = norm(field(row, cols, ["type", "orderType"]));
  // A stop-loss or take-profit rides on an existing position and is not a new entry.
  if (type.includes("stop") || type.includes("takeprofit") || type.includes("tp")) return false;
  const linked = field(row, cols, ["positionId", "positionID", "posId"]);
  if (linked != null && String(linked) !== "0" && String(linked) !== "") return false;
  return true;
}

/** The side of an order row, normalised, or null when the broker did not say. */
export function orderSide(row: unknown, cols: Record<string, number> | undefined): string | null {
  const s = norm(field(row, cols, ["side", "orderSide", "direction"]));
  return s === "buy" || s === "sell" ? s : null;
}

/**
 * Sides on which this account currently has a RESTING entry order for `instrumentId`.
 * Returns null when the broker could not be read — callers must fail closed on null.
 */
export async function workingEntrySides(
  a: { env: TLEnv; token: string; accNum: string; accountId: string },
  instrumentId: string | number | null,
): Promise<Set<string> | null> {
  try {
    const cfg = await brokerConfig(a.env, a.token, a.accNum, a.accountId).catch(() => null);
    const cols = cfg ? columnMap(cfg, "ordersConfig") : undefined;
    const res = await listOrders(a.env, a.token, a.accNum, a.accountId);
    if (!res.ok) return null;
    const want = instrumentId == null ? null : String(instrumentId);
    const out = new Set<string>();
    for (const row of res.data) {
      if (!isWorkingEntry(row, cols)) continue;
      if (want != null) {
        const inst = field(row, cols, ["tradableInstrumentId", "instrumentId", "tradableInstrumentID"]);
        // Only skip on a CONFIRMED different instrument. An unreadable instrument id counts,
        // because guessing it is someone else's symbol is the mistake that stacks gold.
        if (inst != null && String(inst) !== "" && String(inst) !== want) continue;
      }
      const side = orderSide(row, cols);
      // An order whose side we cannot read blocks both ways — never stack blind.
      if (!side) { out.add("buy"); out.add("sell"); continue; }
      out.add(side);
    }
    return out;
  } catch { return null; }
}

/** Does a resting order stand in the way of an entry on `side`? Pure, given the sides. */
export function workingBlocks(sides: Set<string> | null, side: string): boolean {
  if (sides === null) return true;                       // unreadable → fail closed
  for (const s of sides) if (blocksEntry(s, side)) return true;
  return false;
}
