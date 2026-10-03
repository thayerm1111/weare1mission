import { createAdminClient } from "@/lib/supabase/admin";
import { DAILY_FREE } from "@/lib/creditConfig";
import { isFlowPass, PLAN_FLOW_PASS, type SubRow } from "@/lib/subscription";
import { billEvent, canAfford, unreachableFrom, TRADE_COST, UNREACHABLE_WINDOW_MS } from "@/lib/flow/flowBilling";
import { byIds } from "@/lib/genfx/db";

/**
 * GEN FX CREDITS — OFF UNTIL THE OWNER SAYS OTHERWISE.
 *
 * Nothing in this file runs unless genfx_control.billing_enabled is true. With it on, GEN FX is
 * priced exactly like GENX, through the same meter (flow_bill_event) and at the same prices:
 * 1 credit when a setup a member is armed for starts forming, 5 when an order is actually placed on
 * one of their accounts. A FLOW Pass covers it, as it covers GENX. The fee for a trade is taken only
 * after the order is on the account, once per member per call however many accounts they run.
 *
 * It does not reuse flowBilling.fireEligibleAccountIds, deliberately. That gate drops any member whose
 * master FLOW switch is off — right for gold, where FLOW off means "do not trade me". GEN FX has its
 * own switch per account and pair; a member who runs GEN FX and not FLOW has asked for these trades.
 *
 * Being the same meter has one consequence worth knowing before the switch is flipped: a member who
 * cannot pay a GEN FX fee is credit-paused, and that pause also stops their gold FLOW until they top
 * up — the same thing a gold fee they could not pay would do.
 */
type Admin = NonNullable<ReturnType<typeof createAdminClient>>;

export type FxFireGate = { eligible: Set<string>; billable: Set<string> };

/**
 * Which of these members hold an active FLOW Pass — or NULL when that could not be read. Asked a hundred
 * members at a time (db.byIds): a filter naming every member does not fit in one request past a couple
 * of hundred, the request is refused, and gold's own lookup (subscription.flowPassUserIds) answers a
 * refusal with "nobody has a Pass" — which, here, would be a fee taken from everyone who has one. Not
 * knowing who holds a Pass is a reason to charge nobody.
 */
export async function fxPassUserIds(admin: Admin, userIds: string[]): Promise<Set<string> | null> {
  const got = await byIds<SubRow>(userIds, (chunk) => admin.from("user_subscriptions").select("*").in("user_id", chunk).eq("plan", PLAN_FLOW_PASS));
  if (!got.ok) return null;
  return new Set(got.rows.filter((r) => isFlowPass(r)).map((r) => String(r.user_id)));
}

/** Which of these MEMBERS may take a GEN FX trade right now, and who pays for it? Charges nobody. */
export async function fxFireGate(admin: Admin, userIds: string[], nowMs = Date.now()): Promise<FxFireGate> {
  const eligible = new Set<string>();
  const billable = new Set<string>();
  const ids = [...new Set(userIds)];
  if (!ids.length) return { eligible, billable };
  const pass = await fxPassUserIds(admin, ids);
  if (!pass) { for (const u of ids) eligible.add(u); return { eligible, billable }; }      // Passes unreadable → trade, charge nobody
  const rest = ids.filter((u) => !pass.has(u));
  for (const u of pass) eligible.add(u);                 // Pass: trade, no charge
  if (!rest.length) return { eligible, billable };
  const got = await byIds<{ user_id: string; balance?: number | null; topped_up_on?: string | null }>(rest, (chunk) => admin.from("user_credits").select("user_id, balance, topped_up_on").in("user_id", chunk));
  if (!got.ok) { for (const u of rest) eligible.add(u); return { eligible, billable }; }   // unreadable → trade, charge nobody
  const rows = new Map(got.rows.map((r) => [String(r.user_id), r]));
  for (const u of rest) {
    if (!canAfford(rows.get(u) ?? null, TRADE_COST, DAILY_FREE, nowMs)) continue;       // cannot pay → sits out
    eligible.add(u); billable.add(u);
  }
  return { eligible, billable };
}

/** Charge the 5-credit fee for an order that WAS placed. Once per member per call. */
export async function chargeFxFire(admin: Admin, userId: string, fireKey: string, gate: FxFireGate): Promise<string> {
  if (!gate.billable.has(userId)) return "free";
  const c = await billEvent(admin, userId, `genfx:${fireKey}`, "trade", false);
  return c.result;
}

/*
 * THE SETUP FEE GOES ONLY TO MEMBERS WHO COULD TAKE THE SETUP — gold's rule (owner 09-29, after 61
 * members with no trades paid 775 credits in setup fees), on GEN FX's own evidence:
 *
 *   • NOBODY pays for a setup auto-trade will not take: placement switched off, or a stop under the
 *     pair's minimum (the call is still shown; it is never traded, so it is never billed).
 *   • A member whose latest GEN FX broker failure — account not returned, no login, broker unreadable,
 *     pair not listed, account not in dollars — is newer than their latest GEN FX order, inside 24
 *     hours, is not billed until an order actually reaches their account again.
 *
 * It reads only rows GEN FX wrote (reason starts "genfx"), the mirror of the gold rule ignoring them.
 */
const FX_FAILURES = ["no_equity", "no_broker_token", "no_broker_account", "broker_unreadable", "instrument_not_found", "non_usd_account", "no_order_labels", "contract_size"];
const PAGE = 1000;       // the API returns at most this many rows per request, whatever limit is asked for

type Ev = { user_id: string; created_at: string };
/** Every row of a query, newest first, a page at a time. Null if any page fails — a partial answer is not an answer. */
async function allPages(run: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>, maxPages = 20): Promise<Ev[] | null> {
  const out: Ev[] = [];
  for (let page = 0; page < maxPages; page++) {
    const { data, error } = await run(page * PAGE, page * PAGE + PAGE - 1);
    if (error) return null;
    const rows = (data ?? []) as Ev[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
  return out;
}

/**
 * Members GEN FX cannot currently trade for, among `userIds` (everyone, when not given). Empty
 * (everyone billable) on a read error, as gold's is.
 */
export async function fxUnreachableUserIds(admin: Admin, nowMs = Date.now(), userIds?: string[]): Promise<Set<string>> {
  const since = new Date(nowMs - UNREACHABLE_WINDOW_MS).toISOString();
  const ids = userIds ? [...new Set(userIds)] : null;
  if (ids && !ids.length) return new Set();
  // Asked a hundred members at a time: a filter naming every member would not fit in one request once
  // there are a few hundred of them. Any part unreadable → nobody is exempted (gold's own rule).
  const groups: (string[] | null)[] = ids ? Array.from({ length: Math.ceil(ids.length / 100) }, (_, i) => ids.slice(i * 100, i * 100 + 100)) : [null];
  try {
    const fails: Ev[] = [], placed: Ev[] = [];
    for (const group of groups) {
      const [f, p] = await Promise.all([
        allPages((from, to) => {
          let q = admin.from("flow_auto_events").select("user_id, created_at").eq("status", "skipped").gte("created_at", since)
            .like("reason", "genfx%").or(FX_FAILURES.map((x) => `reason.ilike.*${x}*`).join(","));
          if (group) q = q.in("user_id", group);
          return q.order("created_at", { ascending: false }).range(from, to);
        }),
        allPages((from, to) => {
          let q = admin.from("flow_auto_events").select("user_id, created_at").in("status", ["placed", "uncertain"]).gte("created_at", since).like("reason", "genfx%");
          if (group) q = q.in("user_id", group);
          return q.order("created_at", { ascending: false }).range(from, to);
        }),
      ]);
      if (!f || !p) return new Set();
      fails.push(...f); placed.push(...p);
    }
    return unreachableFrom(fails, placed);
  } catch { return new Set(); }
}

export type FxSetupBill = { members: number; charged: number; paused: number; pass: number; unreachable: number; skipped?: string };

/**
 * A setup is forming: 1 credit to each member armed for this pair, in scope, who could take it.
 * `tradeable` is the caller's answer to "would auto-trade place this at all?" — false bills nobody.
 */
export async function billFxSetup(admin: Admin, setupKey: string, userIds: string[], tradeable: { ok: boolean; why?: string } = { ok: true }): Promise<FxSetupBill> {
  const none: FxSetupBill = { members: 0, charged: 0, paused: 0, pass: 0, unreachable: 0 };
  if (!tradeable.ok) return { ...none, skipped: tradeable.why ?? "not_tradeable" };
  const ids = [...new Set(userIds)];
  if (!ids.length) return none;
  const [pass, unreachable] = await Promise.all([fxPassUserIds(admin, ids), fxUnreachableUserIds(admin, Date.now(), ids)]);
  if (!pass) return { ...none, skipped: "passes_unreadable" };       // who holds a Pass could not be read: nobody is billed for this setup
  let charged = 0, paused = 0, out = 0;
  for (const u of ids) {
    if (pass.has(u)) continue;
    if (unreachable.has(u)) { out++; continue; }
    const c = await billEvent(admin, u, `genfx:${setupKey}`, "setup", false);
    if (c.result === "charged") charged++; else if (c.result === "paused") paused++;
  }
  return { members: ids.length - pass.size - out, charged, paused, pass: pass.size, unreachable: out };
}
