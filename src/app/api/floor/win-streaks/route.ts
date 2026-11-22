import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { statsSince } from "@/lib/statsClock";
import { effectiveSince } from "@/lib/genx/statsSince";
import { allRows, type Paged } from "@/lib/floor/rows";
import { accountsFrom, pickAccount, type AccountRowIn, type ConnRowIn } from "@/lib/floor/overview";
import {
  flowWinStreak, genxWinStreak, unavailableWinStreak,
  type FlowWinRow, type GenxWinRow, type FloorWinStreaks, type WinStreakMetrics,
} from "@/lib/floor/winStreaks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Admin = NonNullable<ReturnType<typeof createAdminClient>>;
const READ_WAIT_MS = 20_000;
const GENX_TTL_MS = 30_000;
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "private, no-store" } });
}

/** A slow/incomplete display read is unknown; it must not hold up the Floor or become a fake zero. */
async function boundedRead<T>(read: (signal: AbortSignal) => Promise<T>, fallback: T): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read(controller.signal),
      new Promise<T>((resolve) => { timer = setTimeout(() => { controller.abort(); resolve(fallback); }, READ_WAIT_MS); }),
    ]);
  } catch { return fallback; }
  finally { if (timer) clearTimeout(timer); }
}

// The callout ledger is public/community data. It alone may be shared between requests; an account's
// result is never cached here. Each source carries the actual timestamp of its own read.
let calloutsCache: { since: string; readAt: number; metrics: WinStreakMetrics } | null = null;
let calloutsPending: { since: string; promise: Promise<WinStreakMetrics> } | null = null;
async function readCallouts(admin: Admin, since: string, asOf: string): Promise<WinStreakMetrics> {
  if (calloutsCache?.since === since && Date.now() - calloutsCache.readAt < GENX_TTL_MS) return calloutsCache.metrics;
  if (calloutsPending?.since === since) return calloutsPending.promise;
  const promise = boundedRead(async (signal) => {
    const { rows, complete } = await allRows<GenxWinRow>(() => admin.from("genx_alerts")
      .select("id,dedupe_key,mode,side,state,outcome,result_pips,created_at,resolved_at,enter_sent_at")
      .gte("created_at", since).lte("created_at", asOf)
      .order("created_at", { ascending: true }).order("id", { ascending: true }).abortSignal(signal) as unknown as Paged);
    return genxWinStreak(rows, { since, asOf, complete });
  }, unavailableWinStreak("genx_calls", since, asOf));
  const pending = { since, promise };
  calloutsPending = pending;
  try {
    const metrics = await promise;
    if (metrics.state === "ready") calloutsCache = { since, readAt: Date.now(), metrics };
    return metrics;
  } finally { if (calloutsPending === pending) calloutsPending = null; }
}

type MemberRead = Pick<FloorWinStreaks, "account" | "flow">;
async function readMember(admin: Admin, userId: string, req: NextRequest, since: string, asOf: string): Promise<MemberRead> {
  return boundedRead(async (signal): Promise<MemberRead> => {
    const [connections, accountsRead, prefs] = await Promise.all([
      allRows<ConnRowIn>(() => admin.from("flow_broker_connections")
        .select("id,broker,environment,status").eq("user_id", userId)
        .order("id", { ascending: true }).abortSignal(signal) as unknown as Paged),
      allRows<AccountRowIn>(() => admin.from("flow_broker_accounts")
        .select("account_id,acc_num,name,currency,environment,is_selected,connection_id").eq("user_id", userId)
        .order("created_at", { ascending: true }).order("account_id", { ascending: true }).order("connection_id", { ascending: true })
        .abortSignal(signal) as unknown as Paged),
      admin.from("flow_trade_prefs").select("stats_since").eq("user_id", userId).abortSignal(signal).maybeSingle(),
    ]);
    if (!connections.complete || !accountsRead.complete) return { account: null, flow: unavailableWinStreak("account", null, asOf) };
    const accounts = accountsFrom(connections.rows, accountsRead.rows);
    // Selection is a view preference only. An arbitrary account header cannot bypass ownership.
    const selected = pickAccount(accounts, req.headers.get("x-floor-account"), req.headers.get("x-floor-env"));
    const account = selected ? { id: selected.id, environment: selected.environment, name: selected.name } : null;
    const reset = prefs.data?.stats_since;
    const resetKnown = !prefs.error && (reset == null || (typeof reset === "string" && Number.isFinite(Date.parse(reset))));
    // Unlike a best-effort stats read, a failed personal-clock read cannot silently include older trades.
    if (!resetKnown) return { account, flow: unavailableWinStreak("account", null, asOf) };
    const mineSince = effectiveSince(since, typeof reset === "string" ? reset : null);
    if (!account) return { account, flow: unavailableWinStreak("account", mineSince, asOf, "no_account") };
    const { rows, complete } = await allRows<FlowWinRow>(() => admin.from("flow_managed_positions")
      .select("id,position_id,account_id,environment,status,outcome,result_pips,created_at,resolved_at")
      .eq("user_id", userId).eq("account_id", account.id).gte("created_at", mineSince).lte("created_at", asOf)
      .order("created_at", { ascending: true }).order("id", { ascending: true }).abortSignal(signal) as unknown as Paged);
    // An old row without environment is usable only when this member has no live/demo twin with the
    // same broker account id. The wrong environment must never supply a winning result.
    const allowLegacyEnvironment = accounts.filter((a) => a.id === account.id).length === 1;
    return { account, flow: flowWinStreak(rows, account, { since: mineSince, asOf, complete }, allowLegacyEnvironment) };
  }, { account: null, flow: unavailableWinStreak("account", null, asOf) });
}

/** Read-only. No broker API, model, credit charge, order, strategy/risk gate, or database mutation. */
export async function GET(req: NextRequest) {
  const supabase = createClient();
  if (!supabase) return json({ error: "not_configured" }, 503);
  let userId: string;
  try {
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) return json({ error: "unauthorized" }, 401);
    userId = user.id;
  } catch { return json({ error: "unavailable" }, 503); }
  const admin = createAdminClient();
  if (!admin) return json({ error: "not_configured" }, 503);
  const asOf = new Date().toISOString(), since = statsSince();
  const [member, genx] = await Promise.all([
    readMember(admin, userId, req, since, asOf),
    readCallouts(admin, since, asOf),
  ]);
  const result: FloorWinStreaks = { asOf, account: member.account, flow: member.flow, genx };
  return json(result);
}
