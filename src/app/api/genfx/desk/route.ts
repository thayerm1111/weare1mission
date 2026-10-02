import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { PAIRS, PAIR_KEYS, pairOf, type PairKey } from "@/lib/genfx/pairs";
import { readControl, inScope, minStopPips, OWNER_USER_ID, GENFX_VERSION } from "@/lib/genfx/control";
import { isZoneKey } from "@/lib/genfx/decide";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GEN FX DESK — everything the GEN FX page shows that is not the read itself: the member's accounts
 * and their per-pair auto-trade switches, what the scanner is watching and has called, the record so
 * far (the scanner's calls graded on paper, and real trades on real accounts — kept apart, because
 * they are different claims), and for the owner the master switches and the history replay.
 *
 *   GET                         -> the desk
 *   POST { action: "arm", accountId, pair, enabled }      a member turns a pair on or off for one of their accounts
 *   POST { action: "control", auto?, scope?, billing?, telegram?, scan? }   owner only
 *   POST { action: "replay", weeks? }                     owner only — asks the worker for a history replay
 *
 * A member can only ever arm their own account, and only one the owner's scope reaches: a live
 * account cannot be armed while GEN FX is running on demo accounts, so opening it up later never
 * switches on an account whose owner said yes to something else.
 */
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
type Admin = NonNullable<ReturnType<typeof createAdminClient>>;

async function me() {
  const supabase = createClient();
  if (!supabase) return null;
  const { data: { user } } = await supabase.auth.getUser();
  return user ?? null;
}

type AcctRow = { account_id: string; acc_num: string | null; name: string | null; currency: string | null; equity: number | null; balance: number | null; connection_id: string; genfx_eurusd: boolean | null; genfx_gbpjpy: boolean | null; risk_pct: number | null; kill_switch_at: string | null };
type ConnRow = { id: string; environment: string | null; server: string | null; status: string | null };

async function myAccounts(admin: Admin, userId: string) {
  const { data: conns } = await admin.from("flow_broker_connections").select("id, environment, server, status").eq("user_id", userId);
  const cs = (conns ?? []) as ConnRow[];
  if (!cs.length) return [] as (AcctRow & { conn: ConnRow })[];
  const { data: accts } = await admin.from("flow_broker_accounts")
    .select("account_id, acc_num, name, currency, equity, balance, connection_id, genfx_eurusd, genfx_gbpjpy, risk_pct, kill_switch_at")
    .eq("user_id", userId).order("created_at", { ascending: true });
  const byId = new Map(cs.map((c) => [String(c.id), c]));
  return ((accts ?? []) as unknown as AcctRow[]).filter((a) => byId.has(String(a.connection_id))).map((a) => ({ ...a, conn: byId.get(String(a.connection_id))! }));
}

export async function GET() {
  const user = await me();
  if (!user) return json({ error: "unauthorized" }, 401);
  const admin = createAdminClient();
  if (!admin) return json({ error: "not_configured" }, 200);
  const owner = user.id === OWNER_USER_ID;
  const ctl = await readControl(admin);
  const d30 = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
  const d7ms = Date.now() - 7 * 24 * 3600_000;

  const [accts, live, graded, mine, deskRows, events, hb] = await Promise.all([
    myAccounts(admin, user.id),
    admin.from("genfx_alerts").select("id, pair, dedupe_key, mode, side, state, entry, entry_low, entry_high, stop, tp1, confidence, created_at, enter_price, enter_sent_at, outcome, result_pips")
      .in("state", ["zone", "forming", "entered"]).order("created_at", { ascending: false }).limit(40),
    admin.from("genfx_alerts").select("pair, dedupe_key, mode, outcome, result_pips, resolved_at").in("outcome", ["win", "loss"]).gte("resolved_at", d30).limit(2000),
    admin.from("flow_managed_positions").select("symbol, side, mode, entry, init_stop, tp1, qty, status, outcome, result_pips, created_at, resolved_at, account_id, environment")
      .eq("user_id", user.id).eq("strategy_version", GENFX_VERSION).order("created_at", { ascending: false }).limit(20),
    admin.from("flow_managed_positions").select("symbol, signal_id, outcome, result_pips, status, environment").eq("strategy_version", GENFX_VERSION).gte("created_at", d30).limit(5000),
    admin.from("flow_auto_events").select("symbol, side, status, reason, created_at, account_id").eq("user_id", user.id).like("reason", "genfx%").order("created_at", { ascending: false }).limit(12),
    admin.from("flow_heartbeat").select("last_run, detail").eq("component", "genfx").maybeSingle(),
  ]);

  const accounts = accts.map((a) => ({
    accountId: a.account_id, accNum: a.acc_num, name: a.name, currency: a.currency,
    environment: a.conn.environment, server: a.conn.server, connected: a.conn.status === "connected",
    riskPct: typeof a.risk_pct === "number" && a.risk_pct > 0 ? a.risk_pct : null,
    killed: !!a.kill_switch_at,
    EURUSD: a.genfx_eurusd === true, GBPJPY: a.genfx_gbpjpy === true,
    inScope: inScope(ctl.scope, { userId: user.id, environment: a.conn.environment }, OWNER_USER_ID),
  }));

  // The scanner's calls, graded on paper: first target or stop first. Nobody had to take them.
  const record: Record<string, { d7: { win: number; loss: number }; d30: { win: number; loss: number; pips: number } }> = {};
  for (const k of PAIR_KEYS) record[k] = { d7: { win: 0, loss: 0 }, d30: { win: 0, loss: 0, pips: 0 } };
  for (const r of ((graded.data ?? []) as { pair: PairKey; outcome: "win" | "loss"; result_pips: number | null; resolved_at: string }[])) {
    const rec = record[r.pair]; if (!rec) continue;
    rec.d30[r.outcome] += 1; rec.d30.pips += Number(r.result_pips) || 0;
    if (Date.parse(r.resolved_at) >= d7ms) rec.d7[r.outcome] += 1;
  }

  // Trades actually placed on connected accounts — demo and live kept apart, because a win on demo
  // money is not a win on real money. One call fans out to many accounts, so a call counts once per
  // kind of account, at the average result of the accounts that took it and have closed.
  type Rec = { calls: number; win: number; loss: number; flat: number; pips: number; open: number };
  const blank = (): Rec => ({ calls: 0, win: 0, loss: 0, flat: 0, pips: 0, open: 0 });
  const real: Record<string, { demo: Rec; live: Rec }> = {};
  for (const k of PAIR_KEYS) real[k] = { demo: blank(), live: blank() };
  const bySignal = new Map<string, { symbol: string; env: "demo" | "live"; pips: number[]; open: number }>();
  for (const r of ((deskRows.data ?? []) as { symbol: string; signal_id: string | null; outcome: string | null; result_pips: number | null; status: string; environment: string | null }[])) {
    const env = String(r.environment ?? "").toLowerCase() === "live" ? "live" : "demo";
    const key = `${r.symbol}|${env}|${r.signal_id ?? "?"}`;
    const g = bySignal.get(key) ?? { symbol: r.symbol, env, pips: [], open: 0 };
    if (r.status === "open") g.open += 1; else if (r.outcome && r.outcome !== "excluded" && r.result_pips != null) g.pips.push(Number(r.result_pips));
    bySignal.set(key, g);
  }
  for (const g of bySignal.values()) {
    const rec = real[g.symbol]?.[g.env]; if (!rec) continue;
    if (!g.pips.length) { if (g.open) rec.open += 1; continue; }
    const avg = g.pips.reduce((x, y) => x + y, 0) / g.pips.length;
    rec.calls += 1; rec.pips += avg;
    if (avg > 0.5) rec.win += 1; else if (avg < -0.5) rec.loss += 1; else rec.flat += 1;
  }
  for (const k of PAIR_KEYS) for (const e of ["demo", "live"] as const) real[k][e].pips = Math.round(real[k][e].pips * 10) / 10;

  const alerts = ((live.data ?? []) as Record<string, unknown>[]).map((a) => ({ ...a, kind: isZoneKey(String(a.dedupe_key)) ? "zone" : "scanner" }));
  const hbRow = hb.data as { last_run?: string; detail?: { at?: string; quiet?: boolean; decisions?: Record<string, Record<string, unknown>> } } | null;

  const out: Record<string, unknown> = {
    ok: true, owner,
    switches: { readable: ctl.readable, scan: ctl.scan, auto: ctl.auto, scope: ctl.scope, billing: ctl.billing, telegram: ctl.telegram },
    pairs: PAIR_KEYS.map((k) => ({ key: k, name: PAIRS[k].name, minStopPips: minStopPips(ctl, PAIRS[k]), costPips: PAIRS[k].costPips, dec: PAIRS[k].dec })),
    limits: { maxMinLotRiskPct: ctl.config.maxMinLotRiskPct, maxLots: ctl.config.maxLots },
    accounts, alerts, record, real,
    myTrades: mine.data ?? [],
    activity: events.data ?? [],
    lastScan: hbRow ? { at: hbRow.detail?.at ?? hbRow.last_run ?? null, beat: hbRow.last_run ?? null, quiet: hbRow.detail?.quiet ?? null, decisions: hbRow.detail?.decisions ?? null } : null,
  };

  if (owner) {
    const [armed, ctlRow] = await Promise.all([
      admin.from("flow_broker_accounts").select("user_id, connection_id, genfx_eurusd, genfx_gbpjpy").or("genfx_eurusd.eq.true,genfx_gbpjpy.eq.true"),
      admin.from("genfx_control").select("replay_request, replay_result").eq("id", 1).maybeSingle(),
    ]);
    const rows = (armed.data ?? []) as { user_id: string; genfx_eurusd: boolean; genfx_gbpjpy: boolean }[];
    out.ownerView = {
      armed: { accounts: rows.length, members: new Set(rows.map((r) => r.user_id)).size, EURUSD: rows.filter((r) => r.genfx_eurusd).length, GBPJPY: rows.filter((r) => r.genfx_gbpjpy).length },
      replayPending: !!(ctlRow.data as { replay_request?: unknown } | null)?.replay_request,
      replay: (ctlRow.data as { replay_result?: unknown } | null)?.replay_result ?? null,
    };
  }
  return json(out);
}

export async function POST(req: NextRequest) {
  const user = await me();
  if (!user) return json({ error: "unauthorized" }, 401);
  const admin = createAdminClient();
  if (!admin) return json({ error: "server", detail: "Storage unavailable." }, 200);
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* validated below */ }
  const action = String(body.action || "");
  const owner = user.id === OWNER_USER_ID;

  if (action === "arm") {
    const pair = pairOf(body.pair);
    const accountId = String(body.accountId || "");
    if (!pair || !accountId) return json({ error: "bad_request" }, 400);
    const enabled = body.enabled === true;     // opt-in: anything but an explicit true is off
    if (enabled) {
      const ctl = await readControl(admin);
      const acct = (await myAccounts(admin, user.id)).find((a) => String(a.account_id) === accountId);
      if (!acct) return json({ ok: false, error: "account_not_found", detail: "That account isn't connected anymore." }, 200);
      if (!inScope(ctl.scope, { userId: user.id, environment: acct.conn.environment }, OWNER_USER_ID)) {
        return json({ ok: false, error: "not_open", detail: ctl.scope === "demo" ? "GEN FX auto-trade is running on demo accounts first. Live accounts open once it has a record." : "GEN FX auto-trade isn't open to members yet." }, 200);
      }
    }
    const { data, error } = await admin.from("flow_broker_accounts").update({ [pair.column]: enabled, updated_at: new Date().toISOString() })
      .eq("user_id", user.id).eq("account_id", accountId).select("account_id");
    if (error || !data?.length) return json({ ok: false, error: "not_saved", detail: "Couldn't save that switch — try again." }, 200);
    return json({ ok: true, accountId, pair: pair.key, enabled });
  }

  if (!owner) return json({ error: "forbidden" }, 403);

  if (action === "control") {
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (typeof body.scan === "boolean") patch.scan_enabled = body.scan;
    if (typeof body.auto === "boolean") patch.auto_enabled = body.auto;
    if (typeof body.billing === "boolean") patch.billing_enabled = body.billing;
    if (typeof body.telegram === "boolean") patch.telegram_enabled = body.telegram;
    if (body.scope === "owner" || body.scope === "demo" || body.scope === "all") patch.auto_scope = body.scope;
    const { error } = await admin.from("genfx_control").update(patch).eq("id", 1);
    if (error) return json({ ok: false, detail: error.message }, 200);
    const ctl = await readControl(admin);
    return json({ ok: true, switches: { readable: ctl.readable, scan: ctl.scan, auto: ctl.auto, scope: ctl.scope, billing: ctl.billing, telegram: ctl.telegram } });
  }

  if (action === "replay") {
    const weeks = Math.max(4, Math.min(104, Number(body.weeks) || 52));
    const { error } = await admin.from("genfx_control").update({ replay_request: { weeks, askedAt: new Date().toISOString() } }).eq("id", 1);
    if (error) return json({ ok: false, detail: error.message }, 200);
    return json({ ok: true, weeks });
  }

  return json({ error: "bad_request" }, 400);
}
