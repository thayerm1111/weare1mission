/**
 * THE BROKER LAYER — one member's connection to their own TradeLocker accounts.
 *
 * Multi-user from the first line: every function takes a userId and every query is scoped by it. There is
 * no code path here that can read or act on an account belonging to somebody else.
 *
 * On credentials: this stores the REFRESH TOKEN and nothing else. It deliberately does NOT keep the
 * member's broker password, even encrypted. The cost is that a member has to reconnect when a refresh
 * token finally expires; the benefit is that a database compromise does not hand over the ability to log
 * into their broker. That trade is worth making, and it is why `cc_broker_connections.credentials` exists
 * but is never written to.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { db } from "../adapters/db";
import { open, seal, encryptionAvailable, maskEmail } from "../core/crypto";
import { resolve as resolveInstrument, type Resolved } from "../core/instrument";
import {
  authenticate, refresh as refreshToken, listAccounts, listInstruments, instrumentDetails, instrumentRow,
  accountState as fetchAccountState, parseAccounts, parseAccountState, parseInstrumentSpec, findGold,
  type TLAuth, type TLEnv, type TLInstrumentSpec,
} from "../adapters/tradelocker";

export type AccountRow = {
  id: string;
  user_id: string;
  connection_id: string;
  account_id: string;
  acc_num: string;
  is_live: boolean;
  currency: string | null;
  name: string | null;
  balance: number | null;
  equity: number | null;
  open_pl: number | null;
  margin_available: number | null;
  state_at: string | null;
  instrument_id: string | null;
  route_id: string | null;
  instrument_spec: TLInstrumentSpec | null;
  is_selected: boolean;
  auto_trading: boolean;
  live_authorized_at: string | null;
  permissions: Record<string, boolean>;
  risk_limits: Record<string, number> | null;
};

export type ConnectionRow = {
  id: string; user_id: string; env: TLEnv; server: string; email_masked: string;
  access_token: string | null; refresh_token: string | null; token_at: string | null;
  status: string; last_error: string | null; label: string | null;
};

const need = (): SupabaseClient => {
  const c = db();
  if (!c) throw new Error("Database is not configured");
  return c;
};

/* ── connecting ─────────────────────────────────────────────────────────── */

export type ConnectResult =
  | { ok: true; connectionId: string; accounts: { accountId: string; accNum: string; name: string | null; currency: string | null; balance: number | null; isLive: boolean }[] }
  | { ok: false; reason: string };

/**
 * Sign in to TradeLocker and record the accounts found. The password is used once, here, and never stored.
 */
export async function connect(userId: string, input: { env: TLEnv; server: string; email: string; password: string; label?: string }): Promise<ConnectResult> {
  if (!encryptionAvailable()) {
    return { ok: false, reason: "Broker connections are disabled because no encryption key is configured on the server. Nothing was sent to the broker." };
  }
  const authed = await authenticate(input.env, input.email, input.password, input.server);
  if (!authed.ok) return { ok: false, reason: authed.error || "The broker rejected those details." };

  const accountsRes = await listAccounts(input.env, authed.data.accessToken);
  if (!accountsRes.ok) return { ok: false, reason: `Signed in, but could not read the account list: ${accountsRes.error}` };
  const accounts = parseAccounts(accountsRes.data);
  if (!accounts.length) return { ok: false, reason: "Signed in, but the broker listed no trading accounts." };

  const c = need();
  const { data: conn, error } = await c.from("cc_broker_connections").insert({
    user_id: userId,
    env: input.env,
    server: input.server,
    email_masked: maskEmail(input.email),
    access_token: seal(authed.data.accessToken),
    refresh_token: seal(authed.data.refreshToken),
    token_at: new Date().toISOString(),
    label: input.label ?? null,
    status: "active",
  }).select("id").single();
  if (error || !conn) return { ok: false, reason: "Could not save the connection." };

  const connectionId = (conn as { id: string }).id;
  const rows = accounts.map((a) => ({
    user_id: userId,
    connection_id: connectionId,
    account_id: a.id,
    acc_num: a.accNum,
    is_live: input.env === "live",
    currency: a.currency ?? null,
    name: a.name ?? null,
    balance: a.balance ?? null,
    equity: a.equity ?? null,
  }));
  await c.from("cc_broker_accounts").upsert(rows, { onConflict: "connection_id,account_id" });

  return {
    ok: true,
    connectionId,
    accounts: accounts.map((a) => ({
      accountId: a.id, accNum: a.accNum, name: a.name ?? null, currency: a.currency ?? null,
      balance: a.balance ?? null, isLive: input.env === "live",
    })),
  };
}

export async function disconnect(userId: string, connectionId: string): Promise<void> {
  const c = need();
  await c.from("cc_broker_connections").update({ status: "revoked", access_token: null, refresh_token: null }).eq("id", connectionId).eq("user_id", userId);
}

/* ── sessions ───────────────────────────────────────────────────────────── */

/** How old an access token may be before it is refreshed rather than used. */
const TOKEN_MAX_AGE_MS = 8 * 60_000;

export type Session = { auth: TLAuth; account: AccountRow; connection: ConnectionRow };

/**
 * Get a usable authenticated handle on one of THIS member's accounts, refreshing the token if needed.
 * Returns null — never someone else's session — when the account is not theirs.
 */
export async function session(userId: string, accountRowId: string): Promise<{ ok: true; session: Session } | { ok: false; reason: string; needsReconnect?: boolean }> {
  const c = need();
  const { data: acct } = await c.from("cc_broker_accounts").select("*").eq("id", accountRowId).eq("user_id", userId).maybeSingle();
  if (!acct) return { ok: false, reason: "That account is not connected to your Command Center." };
  const account = acct as AccountRow;

  const { data: conn } = await c.from("cc_broker_connections").select("*").eq("id", account.connection_id).eq("user_id", userId).maybeSingle();
  if (!conn) return { ok: false, reason: "The broker connection for that account is missing." };
  const connection = conn as ConnectionRow;
  if (connection.status === "revoked") return { ok: false, reason: "That broker connection was disconnected.", needsReconnect: true };

  const ageMs = connection.token_at ? Date.now() - Date.parse(connection.token_at) : Infinity;
  let access = open(connection.access_token);

  if (!access || ageMs > TOKEN_MAX_AGE_MS) {
    const rt = open(connection.refresh_token);
    if (!rt) {
      await c.from("cc_broker_connections").update({ status: "expired", last_error: "No usable refresh token" }).eq("id", connection.id);
      return { ok: false, reason: "That broker session has expired. Reconnect the account to carry on.", needsReconnect: true };
    }
    const r = await refreshToken(connection.env, rt);
    if (!r.ok) {
      await c.from("cc_broker_connections").update({ status: "expired", last_error: r.error.slice(0, 200) }).eq("id", connection.id);
      return { ok: false, reason: "The broker would not renew that session. Reconnect the account to carry on.", needsReconnect: true };
    }
    access = r.data.accessToken;
    await c.from("cc_broker_connections").update({
      access_token: seal(access),
      refresh_token: r.data.refreshToken ? seal(r.data.refreshToken) : connection.refresh_token,
      token_at: new Date().toISOString(),
      status: "active",
      last_error: null,
    }).eq("id", connection.id);
  }

  return {
    ok: true,
    session: {
      auth: { env: connection.env, accessToken: access, accountId: account.account_id, accNum: account.acc_num },
      account,
      connection,
    },
  };
}

/* ── account state and instrument ───────────────────────────────────────── */

/** Refresh balance, equity and open P&L from the broker, and record when it was read. */
export async function syncAccountState(s: Session): Promise<{ balance: number | null; equity: number | null; openPl: number | null; marginAvailable: number | null } | null> {
  const r = await fetchAccountState(s.auth);
  let st = r.ok ? parseAccountState(r.data) : null;

  // Not every TradeLocker build exposes a per-account /state route, and an account with no readable
  // balance cannot be sized — which would block every trade with a confusing message. The account
  // listing carries balance and equity too, so fall back to it rather than giving up.
  if (!st || (st.balance == null && st.equity == null)) {
    const list = await listAccounts(s.connection.env, s.auth.accessToken);
    if (list.ok) {
      const mine = parseAccounts(list.data).find((a) => a.id === s.account.account_id || a.accNum === s.account.acc_num);
      if (mine) st = { balance: mine.balance ?? null, equity: mine.equity ?? mine.balance ?? null, openPl: st?.openPl ?? null, marginAvailable: st?.marginAvailable ?? null };
    }
  }
  if (!st) return null;
  const c = need();
  await c.from("cc_broker_accounts").update({
    balance: st.balance, equity: st.equity, open_pl: st.openPl, margin_available: st.marginAvailable,
    state_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).eq("id", s.account.id);
  return st;
}

export type InstrumentResolution =
  | { ok: true; spec: TLInstrumentSpec; resolved: Extract<Resolved, { ok: true }> }
  | { ok: false; reason: string };

/**
 * Find XAUUSD on this account and read its trading specification.
 *
 * Cached on the account row, because lot steps do not change minute to minute — but re-read whenever it
 * is missing, because sizing a position from a stale or absent specification is how a trade ends up ten
 * times too big.
 */
export async function goldInstrument(s: Session, force = false): Promise<InstrumentResolution> {
  const c = need();
  let spec = (!force && s.account.instrument_spec) ? s.account.instrument_spec : null;

  if (!spec) {
    let id = s.account.instrument_id;
    let route = s.account.route_id;
    if (!id || !route || force) {
      const list = await listInstruments(s.auth);
      if (!list.ok) return { ok: false, reason: `Could not read the instrument list: ${list.error}` };
      const gold = findGold(list.data);
      if (!gold) return { ok: false, reason: "This account does not list an XAUUSD instrument." };
      id = gold.tradableInstrumentId;
      route = gold.routeId;
    }
    // Prefer the per-instrument detail route; fall back to the row inside the instrument LIST, which is
    // the call the desk has always used. Either way the specification is the BROKER'S, never a guess.
    const det = await instrumentDetails(s.auth, id, route);
    if (det.ok) {
      spec = parseInstrumentSpec(det.data, { tradableInstrumentId: id, routeId: route });
    } else {
      const list = await listInstruments(s.auth);
      const row = list.ok ? instrumentRow(list.data, id) : null;
      if (!row) return { ok: false, reason: `Could not read the XAUUSD specification: ${det.error}` };
      spec = parseInstrumentSpec(row, { tradableInstrumentId: id, routeId: route });
    }
    await c.from("cc_broker_accounts").update({
      instrument_id: id, route_id: route, instrument_spec: spec, updated_at: new Date().toISOString(),
    }).eq("id", s.account.id);
  }

  const r = resolveInstrument(spec, s.account.currency);
  if (!r.ok) return { ok: false, reason: r.reason };
  return { ok: true, spec, resolved: r };
}

/* ── listing for the UI ─────────────────────────────────────────────────── */

export type AccountSummary = {
  id: string; accountId: string; accNum: string; label: string; isLive: boolean;
  currency: string | null; balance: number | null; equity: number | null; openPl: number | null;
  selected: boolean; autoTrading: boolean; liveAuthorized: boolean;
  permissions: Record<string, boolean>; connectionStatus: string; env: string; server: string;
};

export async function listForUser(userId: string): Promise<AccountSummary[]> {
  const c = need();
  const { data } = await c
    .from("cc_broker_accounts")
    .select("*, cc_broker_connections!inner(status, env, server)")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  return ((data ?? []) as (AccountRow & { cc_broker_connections: { status: string; env: string; server: string } })[])
    .filter((a) => a.cc_broker_connections?.status !== "revoked")
    .map((a) => ({
      id: a.id,
      accountId: a.account_id,
      accNum: a.acc_num,
      label: a.name || `Account ${a.acc_num}`,
      isLive: a.is_live,
      currency: a.currency,
      balance: a.balance,
      equity: a.equity,
      openPl: a.open_pl,
      selected: a.is_selected,
      autoTrading: a.auto_trading,
      liveAuthorized: !!a.live_authorized_at,
      permissions: a.permissions ?? {},
      connectionStatus: a.cc_broker_connections?.status ?? "unknown",
      env: a.cc_broker_connections?.env ?? (a.is_live ? "live" : "demo"),
      server: a.cc_broker_connections?.server ?? "",
    }));
}

export async function selectAccount(userId: string, accountRowId: string): Promise<void> {
  const c = need();
  await c.from("cc_broker_accounts").update({ is_selected: false }).eq("user_id", userId);
  await c.from("cc_broker_accounts").update({ is_selected: true, updated_at: new Date().toISOString() }).eq("id", accountRowId).eq("user_id", userId);
}

export async function selectedAccount(userId: string): Promise<AccountRow | null> {
  const c = need();
  const { data } = await c.from("cc_broker_accounts").select("*").eq("user_id", userId).eq("is_selected", true).maybeSingle();
  if (data) return data as AccountRow;
  const { data: first } = await c.from("cc_broker_accounts").select("*").eq("user_id", userId).order("created_at", { ascending: true }).limit(1).maybeSingle();
  return (first as AccountRow) ?? null;
}

/**
 * Turn on trading for a LIVE account. Deliberately its own explicit step, separate from connecting, and
 * separate again from enabling automation — because "I linked my account" and "I am willing for real
 * money to move" are not the same sentence.
 */
export async function authorizeLive(userId: string, accountRowId: string): Promise<boolean> {
  const c = need();
  const { error } = await c.from("cc_broker_accounts")
    .update({ live_authorized_at: new Date().toISOString(), live_authorized_by: userId, updated_at: new Date().toISOString() })
    .eq("id", accountRowId).eq("user_id", userId).eq("is_live", true);
  return !error;
}

export const PERMISSION_KEYS = ["manual_execute", "ai_break_even", "ai_protect_stop", "ai_partial", "ai_close"] as const;
export type PermissionKey = (typeof PERMISSION_KEYS)[number];

export async function setPermissions(userId: string, accountRowId: string, patch: Partial<Record<PermissionKey, boolean>>): Promise<Record<string, boolean> | null> {
  const c = need();
  const { data } = await c.from("cc_broker_accounts").select("permissions").eq("id", accountRowId).eq("user_id", userId).maybeSingle();
  if (!data) return null;
  const current = ((data as { permissions: Record<string, boolean> }).permissions) ?? {};
  const next = { ...current };
  for (const k of PERMISSION_KEYS) if (patch[k] !== undefined) next[k] = !!patch[k];
  await c.from("cc_broker_accounts").update({ permissions: next, updated_at: new Date().toISOString() }).eq("id", accountRowId).eq("user_id", userId);
  return next;
}

export async function setAutoTrading(userId: string, accountRowId: string, on: boolean): Promise<boolean> {
  const c = need();
  // Automation on a live account requires the live authorisation to exist first. Two gates, not one.
  const { data } = await c.from("cc_broker_accounts").select("is_live, live_authorized_at").eq("id", accountRowId).eq("user_id", userId).maybeSingle();
  if (!data) return false;
  const row = data as { is_live: boolean; live_authorized_at: string | null };
  if (on && row.is_live && !row.live_authorized_at) return false;
  const { error } = await c.from("cc_broker_accounts").update({ auto_trading: on, updated_at: new Date().toISOString() }).eq("id", accountRowId).eq("user_id", userId);
  return !error;
}
