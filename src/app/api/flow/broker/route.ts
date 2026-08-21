import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { authenticate, listAccounts, type TLEnv } from "@/lib/flow/tradelocker";
import { encryptSecret, encryptionReady } from "@/lib/flow/crypto";
import { getConnection, getAllConnections, safeConnView } from "@/lib/flow/connection";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });

async function authUser() {
  const supabase = createClient();
  if (!supabase) return null;
  const { data: { user } } = await supabase.auth.getUser();
  return user ?? null;
}

/** GET /api/flow/broker — ALL connections + ALL accounts (no secrets). Each
 *  account carries autotradeEnabled so the UI can show a per-account on/off. */
export async function GET() {
  const user = await authUser();
  if (!user) return json({ error: "unauthorized" }, 401);
  const conns = await getAllConnections(user.id);
  if (!conns.length) return json({ connected: false, accounts: [], connections: [] });
  const admin = createAdminClient();

  const accounts: Record<string, unknown>[] = [];
  for (const c of conns) {
    const { data: accts } = admin
      ? await admin.from("flow_broker_accounts").select("account_id, acc_num, name, currency, balance, equity, open_positions, is_selected, autotrade_enabled, genx_follower").eq("connection_id", c.id).order("created_at", { ascending: true })
      : { data: [] };
    for (const a of accts ?? []) {
      accounts.push({
        accountId: a.account_id, accNum: a.acc_num, name: a.name, currency: a.currency,
        balance: a.balance, equity: a.equity, openPositions: a.open_positions,
        selected: a.is_selected, autotradeEnabled: a.autotrade_enabled !== false,
        genxFollower: a.genx_follower === true,
        connectionId: c.id, environment: c.environment, server: c.server,
      });
    }
  }
  const primary = conns[0];
  return json({
    connected: conns.some((c) => c.status === "connected"),
    connection: safeConnView(primary), // primary (most-recent) login, for the header
    connections: conns.map((c) => ({ ...safeConnView(c), connectionId: c.id })),
    accounts,
    selectedAccountId: primary.selected_account_id,
    activeCount: accounts.filter((a) => a.autotradeEnabled).length,
  });
}

/** POST /api/flow/broker — { action: "connect" | "select" | "disconnect", ... } */
export async function POST(req: NextRequest) {
  const user = await authUser();
  if (!user) return json({ error: "unauthorized" }, 401);
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* */ }
  const action = String(body.action || "connect");
  const admin = createAdminClient();
  if (!admin) return json({ error: "server", detail: "Storage unavailable." }, 200);

  if (action === "disconnect") {
    // With a connectionId, remove just that login; without one, remove all logins.
    const connectionId = String(body.connectionId || "");
    if (connectionId) await admin.from("flow_broker_connections").delete().eq("id", connectionId).eq("user_id", user.id);
    else await admin.from("flow_broker_connections").delete().eq("user_id", user.id);
    return json({ ok: true });
  }

  if (action === "toggle") {
    // Turn a single account ON/OFF for trading (auto-run + one-tap Execute).
    const accountId = String(body.accountId || "");
    if (!accountId) return json({ error: "missing_account" }, 200);
    const enabled = body.enabled !== false; // default ON
    let q = admin.from("flow_broker_accounts").update({ autotrade_enabled: enabled, updated_at: new Date().toISOString() }).eq("user_id", user.id).eq("account_id", accountId);
    if (body.connectionId) q = q.eq("connection_id", String(body.connectionId));
    await q;
    return json({ ok: true, accountId, autotradeEnabled: enabled });
  }

  if (action === "genxfollow") {
    // Turn a single account into a GENX FOLLOWER (takes every gold ENTER NOW at
    // 0.01, raw) — or off. Independent of the FLOW autotrade toggle above.
    const accountId = String(body.accountId || "");
    if (!accountId) return json({ error: "missing_account" }, 200);
    const enabled = body.enabled === true; // default OFF (opt-in)
    let q = admin.from("flow_broker_accounts").update({ genx_follower: enabled, updated_at: new Date().toISOString() }).eq("user_id", user.id).eq("account_id", accountId);
    if (body.connectionId) q = q.eq("connection_id", String(body.connectionId));
    await q;
    return json({ ok: true, accountId, genxFollower: enabled });
  }

  if (action === "select") {
    const accountId = String(body.accountId || "");
    if (!accountId) return json({ error: "missing_account" }, 200);
    const conn = await getConnection(user.id);
    if (!conn) return json({ error: "not_connected" }, 200);
    const nowIso = new Date().toISOString();
    await admin.from("flow_broker_connections").update({ selected_account_id: accountId, updated_at: nowIso }).eq("id", conn.id);
    await admin.from("flow_broker_accounts").update({ is_selected: false }).eq("connection_id", conn.id);
    await admin.from("flow_broker_accounts").update({ is_selected: true }).eq("connection_id", conn.id).eq("account_id", accountId);
    return json({ ok: true, selectedAccountId: accountId });
  }

  // action === "connect"
  if (!encryptionReady()) return json({ error: "not_configured", detail: "Secure storage isn't configured yet. Try again shortly." }, 200);
  const email = String(body.email || "").trim();
  const password = String(body.password || "");
  const server = String(body.server || "").trim();
  const env: TLEnv = body.environment === "live" ? "live" : "demo";
  if (!email || !password || !server) return json({ error: "missing_fields", detail: "Enter your TradeLocker email, password and server." }, 200);

  const a = await authenticate(env, email, password, server);
  if (!a.ok) return json({ error: "auth_failed", detail: a.error }, 200);

  const accountsRes = await listAccounts(env, a.data.accessToken);
  const accounts = accountsRes.ok ? accountsRes.data : [];
  const nowIso = new Date().toISOString();
  const firstAccount = accounts[0]?.accountId ?? null;

  const { data: connRow, error: connErr } = await admin.from("flow_broker_connections").upsert({
    user_id: user.id, broker: "tradelocker", environment: env, server, email,
    enc_refresh: encryptSecret(a.data.refreshToken),
    enc_password: encryptSecret(password),
    access_token: a.data.accessToken,
    selected_account_id: firstAccount,
    status: "connected", last_error: null, last_auth_at: nowIso, updated_at: nowIso,
  }, { onConflict: "user_id,broker,environment,server,email" }).select("*").maybeSingle();
  if (connErr || !connRow) return json({ error: "server", detail: "Couldn't save the connection." }, 200);

  await admin.from("flow_broker_accounts").delete().eq("connection_id", connRow.id);
  if (accounts.length) {
    await admin.from("flow_broker_accounts").insert(accounts.map((ac) => ({
      user_id: user.id, connection_id: connRow.id, account_id: ac.accountId, acc_num: ac.accNum,
      name: ac.name ?? null, currency: ac.currency ?? null, environment: env,
      balance: ac.balance ?? null, equity: ac.equity ?? null,
      is_selected: ac.accountId === firstAccount, updated_at: nowIso,
    })));
  }

  return json({
    ok: true, connection: safeConnView(connRow as never),
    accountsFound: accounts.length,
    accounts: accounts.map((ac) => ({ accountId: ac.accountId, accNum: ac.accNum, currency: ac.currency, balance: ac.balance, equity: ac.equity, name: ac.name })),
    selectedAccountId: firstAccount,
    note: accountsRes.ok ? undefined : "Connected, but couldn't load account details yet.",
  });
}
