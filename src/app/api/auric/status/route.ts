import { ctx, json, readSettings } from "../_lib";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/auric/status — everything the dashboard needs, scoped to the caller. Viewing never charges. */
export async function GET(req: Request) {
  const r = await ctx(req); if (!r.ok) return r.res; const c = r.c;
  const url = new URL(req.url); const accountId = url.searchParams.get("accountId");
  const [{ data: accounts }, settings, bal, { data: hb }] = await Promise.all([
    c.admin.from("auric_accounts").select("id, connection_id, broker_account_id, acc_num, name, currency, balance, equity, state_at, spec_missing, risk_fraction, allow_shared_account, consent_at, consent_version, live_authorized_at, status, block_reason, ownership_check, instrument_spec, created_at").eq("user_id", c.user.id).order("created_at"),
    readSettings(c),
    c.supabase.rpc("get_credit_balance", { p_daily_allowance: Number(process.env.NEXT_PUBLIC_DAILY_FREE_CREDITS ?? 5) }),
    c.admin.from("auric_worker_heartbeat").select("worker, at, info").order("at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const connIds = [...new Set((accounts ?? []).map((a) => a.connection_id))];
  const { data: conns } = connIds.length ? await c.admin.from("auric_broker_connections").select("id, env, server, email_masked, status, last_error, imported_from").in("id", connIds) : { data: [] };
  const acct = accountId ? (accounts ?? []).find((a) => a.id === accountId) : (accounts ?? [])[0];
  let snapshot = null, session = null, positions: unknown[] = [], recent: unknown[] = [];
  if (acct) {
    const [s, se, p, ev] = await Promise.all([
      c.admin.from("auric_snapshots").select("at, payload").eq("account_id", acct.id).maybeSingle(),
      c.admin.from("auric_sessions").select("id, starts_at, expires_at, credits_charged, auto_renew, auto_renew_price, status, paused_entries, pause_reason").eq("account_id", acct.id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
      c.admin.from("auric_positions").select("id, broker_position_id, side, qty, entry, stop, target, initial_risk, setup_family, protected, opened_at, status, closed_at, close_reason, realized_pnl, management_version").eq("account_id", acct.id).order("opened_at", { ascending: false }).limit(50),
      c.admin.from("auric_events").select("id, at, kind, state, message, payload").eq("account_id", acct.id).order("at", { ascending: false }).limit(60),
    ]);
    snapshot = s.data; session = se.data; positions = p.data ?? []; recent = ev.data ?? [];
  }
  const workerAlive = hb ? Date.now() - Date.parse(hb.at) < 45_000 : false;
  const price = settings.daily_price_credits ?? null;
  return json({
    ok: true, accounts: accounts ?? [], connections: conns ?? [], account: acct ?? null, snapshot, session, positions, events: recent,
    wallet: bal.data ?? null,
    product: { price, priceConfigured: price != null, sessionHours: settings.session_hours ?? 24, engineEnabled: settings.engine_enabled === true, liveOrdersEnabled: settings.live_orders_enabled === true, worker: { alive: workerAlive, at: hb?.at ?? null, info: hb?.info ?? null } },
    isAdmin: c.isAdmin,
  });
}
