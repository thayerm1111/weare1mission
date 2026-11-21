import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildRealResults, type RealRow } from "@/lib/genx/realResults";
import { statsSince, memberStatsSince, effectiveSince } from "@/lib/genx/statsSince";
import { passState } from "@/lib/ccPass";
import { allRows, type Paged } from "@/lib/floor/rows";
import { accountFigures } from "@/lib/floor/accountState";
import {
  accountsFrom, pickAccount, periodOf, periodWindow, genxPeriod, foldFlow, atlasReadFor,
  type AccountRowIn, type ConnRowIn, type FlowPosIn, type GenxFireIn, type FloorOverview,
} from "@/lib/floor/overview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * THE FLOOR — everything its first screen shows that belongs to the signed-in member, in one answer
 * (owner 11-20: "display GENX results prominently on The Floor; display current FLOW results for the
 * signed-in customer's connected accounts; display the selected connected account's balance and equity").
 *
 *   accounts   the member's connected accounts, and which one the screen is showing
 *   figures    that account's Balance and Equity as the broker reports them, with the time they were read
 *   genx       the desk record for a period — GENX's own trades, each counted once
 *   flow       what FLOW did on that one account in a period
 *   atlas      whether the member's Command Center window is open, and ATLAS's newest read if it is
 *
 * READ-ONLY. It charges nothing, places nothing, and choosing which account to LOOK at (the
 * x-floor-account and x-floor-env headers) changes no setting: the member's default account, what it follows and what it may trade are untouched.
 * The account asked for is honoured only if it is one of the member's own (pickAccount works from their
 * rows alone), so an id from another member simply shows this member's default.
 *
 * NOTHING IS MADE UP. A part that cannot be read is null and the screen says so; a record that could
 * only be partly read is not shown as the record. The chart, the price and the setup's state come from
 * /api/floor/setup, which keeps its own gate on the play (setupLock.ts) — none of that is repeated here.
 */
function json(o: unknown, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

type Admin = NonNullable<ReturnType<typeof createAdminClient>>;

/*
 * THE DESK RECORD, READ WHOLE. It is the same for every member, so one read serves everyone for a minute.
 * The rows are read a thousand at a time (rows.ts) — one request returns only the newest thousand — and a
 * row retired without a result (outcome 'excluded': the broker stopped listing the position before its
 * close was booked) is dropped before the fold, as the Live Trade card does. Left in, the fold counts it
 * as a trade still open, and the whole GENX trade it belonged to is never graded.
 */
const DESK_TTL_MS = 60_000;
/** How long this answer waits for the broker before it goes out with the last reading instead. */
const BROKER_WAIT_MS = 3500;
let DESK: { at: number; since: string; fires: GenxFireIn[] } | null = null;
let deskRead: Promise<GenxFireIn[] | null> | null = null;

async function deskFires(admin: Admin, since: string): Promise<GenxFireIn[] | null> {
  if (DESK && DESK.since === since && Date.now() - DESK.at < DESK_TTL_MS) return DESK.fires;
  if (deskRead) return deskRead;
  const mine = (async (): Promise<GenxFireIn[] | null> => {
    const { rows, complete } = await allRows<RealRow>(() => admin.from("flow_managed_positions")
      .select("side,outcome,result_pips,created_at,resolved_at,manage_style,status")
      .eq("symbol", "XAUUSD").gte("created_at", since)
      .order("created_at", { ascending: true }).order("id", { ascending: true }) as unknown as Paged);
    if (!complete) return null;                        // part of the record is not the record
    const real = buildRealResults(rows.filter((r) => r.outcome !== "excluded"));
    const fires = real.recentFiresAll.map((f) => ({ at: f.at, side: f.side, open: f.open, avgPips: f.avgPips }));
    DESK = { at: Date.now(), since, fires };
    return fires;
  })();
  deskRead = mine;
  void mine.finally(() => { if (deskRead === mine) deskRead = null; }).catch(() => { /* answered below */ });
  return mine;
}

export async function GET(req: NextRequest) {
  const supabase = createClient();
  if (!supabase) return json({ error: "not_configured" }, 200);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);
  const admin = createAdminClient();
  if (!admin) return json({ error: "not_configured" }, 200);

  const url = new URL(req.url);
  const now = Date.now();
  const gp = periodOf(url.searchParams.get("gp"), "7d");
  const fp = periodOf(url.searchParams.get("fp"), "today");
  const tz = Number(url.searchParams.get("tz"));
  const tzOff = Number.isFinite(tz) ? tz : 0;
  const since = statsSince();

  // ── the member's accounts, and the one being looked at ──
  const [connQ, acctQ] = await Promise.all([
    admin.from("flow_broker_connections").select("id, broker, environment, status").eq("user_id", user.id),
    admin.from("flow_broker_accounts").select("account_id, acc_num, name, currency, environment, is_selected, connection_id").eq("user_id", user.id).order("created_at", { ascending: true }),
  ]);
  const accountsKnown = !connQ.error && !acctQ.error;
  const accounts = accountsKnown ? accountsFrom((connQ.data ?? []) as ConnRowIn[], (acctQ.data ?? []) as AccountRowIn[]) : [];
  // Which account to look at arrives in a header, so an account id is never part of an address or a request log.
  const account = pickAccount(accounts, req.headers.get("x-floor-account"), req.headers.get("x-floor-env"));

  // ── everything else, side by side: none of it waits on another ──
  const [figures, fires, flow, atlas] = await Promise.all([
    // The broker is given a few seconds; past that the last reading is sent and the screen asks again shortly.
    account ? accountFigures(user.id, { id: account.id, environment: account.environment }, { nowMs: now, maxWaitMs: BROKER_WAIT_MS }).catch(() => null) : Promise.resolve(null),
    deskFires(admin, since).catch(() => null),
    (async () => {
      if (!account) return null;
      // The member's own clock, when they asked for one (statsSince.ts): their results start no earlier.
      const mineSince = effectiveSince(since, await memberStatsSince(admin, user.id));
      const { rows, complete } = await allRows<FlowPosIn>(() => admin.from("flow_managed_positions")
        .select("id,position_id,account_id,environment,symbol,side,qty,exit_price,result_pips,status,outcome,created_at,resolved_at,entry,fill_price,init_stop,cur_stop,tp1,strategy_version")
        .eq("user_id", user.id).eq("account_id", account.id)
        .or(`created_at.gte."${mineSince}",status.eq.open`)
        .order("created_at", { ascending: true }).order("id", { ascending: true }) as unknown as Paged);
      if (!complete) return null;
      return { period: fp, since: mineSince, results: foldFlow(rows, account, periodWindow(fp, now, mineSince, tzOff)) };
    })().catch(() => null),
    (async () => {
      const pass = await passState(user.id, supabase);
      let read: { at: string; summary: string } | null = null;
      if (pass.active) {
        // ATLAS's read is what the window pays for, so it is sent only while the window is open.
        const { data } = await admin.from("cc_atlas_reads").select("at, summary:read->>summary").order("at", { ascending: false }).limit(1).maybeSingle();
        read = atlasReadFor(data as { at?: unknown; summary?: unknown } | null, now);
      }
      return { open: pass.active, preview: pass.preview === true, cost: pass.cost, minutes: pass.minutes, read };
    })().catch(() => null),
  ]);

  const body: FloorOverview = {
    asOf: new Date(now).toISOString(),
    accountsKnown,
    accounts,
    account,
    figures,
    genx: fires ? { period: gp, since, results: genxPeriod(fires, periodWindow(gp, now, since, tzOff)) } : null,
    flow,
    atlas,
  };
  return json(body);
}
