import { createAdminClient } from "@/lib/supabase/admin";
import { type Mode } from "@/lib/genxCompute";
import { sameSetupZone, isScannerKey, within } from "@/lib/genx/watchTick";

/**
 * GENX — ONE IDEA, ONE SETUP FEE (10-05).
 *
 * "1 credit when the trade is forming" (owner 09-18) is charged once per member per setup KEY, and the
 * key is the zone rounded to the dollar. The engine re-derives the zone on every scan, so it drifts a
 * dollar or two and the key changes — and each drift was a new key, a new row and a new fee, while the
 * setup the member had already paid for was still on the desk. The same-setup rule of 09-16 stops that
 * for Quick; Intraday and Swing came back on 09-21 and were never under it.
 *
 * Measured on every setup fee since event billing began (09-18 → 10-05 06:45 UTC): 10,995 credits were
 * charged for 364 setups. Thirty-four of those setups were already invalid when recorded (1,158
 * credits; watchTick.bornDead ends that). By the rule below the other 330 were 108 ideas, and 5,006
 * credits were a fee for an idea the same member had already paid for — 3,266 of them on Intraday and
 * 1,416 on Swing, against 324 on Quick. On the morning this was written one intraday buy was recorded
 * eight times in twenty-one minutes, and every member with credits left paid for it eight times.
 *
 * THE RULE. The first reading of an idea is billed under its own key and is that idea's HEAD. A new
 * scanner setup is billed under a head's key — so a member who has paid for the idea is not charged
 * again — when that head is on the same horizon and side, is the same setup (watchTick.sameSetupZone:
 * within $6 of the HEAD's zone, or 1.5× the zone width) and is still on the desk: pending, or entered
 * and not yet graded, or let go (invalidated, timed out) no more than half an hour ago. Otherwise the
 * new setup is a new idea: it is billed under its own key and becomes a head itself.
 *
 * Everything is measured from the head, never from the latest re-reading. A zone that creeps away is a
 * new idea once it is more than $6 from where the idea started, and an idea ends with its head: when
 * the head has been graded, or half an hour after it was let go, the next reading is a new idea even
 * if re-readings of the old one are still open. So there is no chain to run on: a fee cannot be put
 * off indefinitely by a setup that keeps being re-read, in price or in time.
 *
 * The key each setup was billed under is stored on its row (genx_alerts.fee_key), so what a member
 * paid for can be read back later: flow_billing_events.event_key = 'setup:' || fee_key. Rows written
 * before the column have none; every one of those was billed under its own key, which makes each a
 * head.
 *
 * WHAT THIS DOES NOT CHANGE: which setups are recorded, announced, entered or traded; the 5-credit
 * fee for a placed order; who is billable (Pass, FLOW off, swing floor, unusable broker); what a new
 * idea costs; and the meter itself — still one charge per member per key (flow_bill_event), so a
 * member who has paid for the idea gets "already" and one who has not pays once, now.
 */
type Admin = NonNullable<ReturnType<typeof createAdminClient>>;

/** A head let go no longer ago than this still covers a re-reading of its setup. */
export const FEE_RECALL_MS = 30 * 60_000;
/** Open setups are read this far back. A pending Swing setup is let go after two days. */
export const FEE_LOOKBACK_MS = 3 * 86_400_000;
/** The desk is given this long to answer before the setup is billed under its own key. */
export const FEE_READ_WAIT_MS = 5_000;

export { isScannerKey };

export type FeeAlert = {
  dedupe_key: string; fee_key: string | null; side: "buy" | "sell"; entry_low: number | null; entry_high: number | null;
  state: string; outcome: string | null; created_at: string; updated_at: string | null;
};
type Zone = { side: "buy" | "sell"; entry_low: number | null; entry_high: number | null };

const ms = (s: string | null | undefined): number => (s ? Date.parse(s) : NaN);

/** Was this setup billed under its own key — the first reading of its idea? (A row from before the column was: every setup then was.) */
export const isHead = (r: FeeAlert): boolean => r.fee_key == null || r.fee_key === r.dedupe_key;

/** Is the setup still on the desk at `nowMs`: pending, entered and not graded, or let go within the last half hour? A graded call is finished. Pure. */
export function stillLive(r: FeeAlert, nowMs: number): boolean {
  if (r.state === "forming") return true;
  if (r.state === "entered") return r.outcome == null;
  if (r.state !== "invalidated" && r.state !== "expired") return false;
  const letGo = ms(r.updated_at ?? r.created_at);
  return Number.isFinite(letGo) && nowMs - letGo <= FEE_RECALL_MS;
}

/**
 * The key a new setup is billed under, given the scanner setups on record (any order, any horizon or
 * side): the key of the most recent head that is still on the desk and is the same setup, or `ownKey`
 * when there is none and this is a new idea. Pure.
 */
export function feeKeyFrom(rows: FeeAlert[], z: Zone, ownKey: string, nowMs: number): string {
  const horizon = ownKey.split(":")[0];
  let head: FeeAlert | null = null;
  for (const r of rows) {
    if (!isScannerKey(r.dedupe_key) || r.dedupe_key.split(":")[0] !== horizon) continue;
    if (!isHead(r) || !stillLive(r, nowMs) || !sameSetupZone(r, z)) continue;          // (sameSetupZone is false across sides)
    const t = ms(r.created_at), best = head ? ms(head.created_at) : -Infinity;
    if (!Number.isFinite(t)) continue;
    if (t > best || (t === best && head != null && r.dedupe_key > head.dedupe_key)) head = r;
  }
  return head ? head.dedupe_key : ownKey;
}

/**
 * Read what is on the desk for this horizon and side and answer feeKeyFrom. `read: false` means the
 * desk could not be read (an error, or no answer in `waitMs`): the setup is then billed under its own
 * key, exactly as before this file existed — a fee too many is the old behaviour, and this question
 * must never stop or delay a setup being recorded.
 */
export async function setupFeeKey(admin: Admin, mode: Mode, z: Zone, ownKey: string, nowMs = Date.now(), waitMs = FEE_READ_WAIT_MS): Promise<{ key: string; read: boolean }> {
  const unread = { key: ownKey, read: false };
  try {
    const cols = "dedupe_key, fee_key, side, entry_low, entry_high, state, outcome, created_at, updated_at";
    // Two short lists rather than one long one, so a busy day can never crowd a head out of the answer:
    // what is open (scanner keys begin with the horizon; the page setups, "zone:…", are left out), and
    // what was let go in the last half hour.
    const open = admin.from("genx_alerts").select(cols).eq("mode", mode).eq("side", z.side).like("dedupe_key", `${mode}:%`)
      .in("state", ["forming", "entered"]).is("outcome", null).gte("created_at", new Date(nowMs - FEE_LOOKBACK_MS).toISOString())
      .order("created_at", { ascending: false }).limit(400);
    const letGo = admin.from("genx_alerts").select(cols).eq("mode", mode).eq("side", z.side).like("dedupe_key", `${mode}:%`)
      .in("state", ["invalidated", "expired"]).gte("updated_at", new Date(nowMs - FEE_RECALL_MS).toISOString())
      .order("updated_at", { ascending: false }).limit(400);
    const got = await within(Promise.all([open, letGo]), waitMs);
    if (!got || got[0].error || got[1].error) return unread;
    const rows = [...((got[0].data ?? []) as FeeAlert[]), ...((got[1].data ?? []) as FeeAlert[])];
    return { key: feeKeyFrom(rows, z, ownKey, nowMs), read: true };
  } catch { return unread; }
}
