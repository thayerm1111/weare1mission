import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { syncMasterFromAccounts } from "@/lib/flow/armState";
import { sanitisePermissions, resolveAll, PERMISSION_KEYS } from "@/lib/flow/permissions";
import { parseMgmtPatch, applyMgmtPatch, mgmtView, mgmtViewMerged, missingColumn, BE_PIPS_CHOICES, type MgmtRow, type MgmtPatch } from "@/lib/flow/manageSettings";
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

/**
 * One account's trade settings change (manageSettings.ts).
 *
 * It is written to EVERY row this member has for the broker account, not only the card that was tapped:
 * the same login connected twice puts one account on two rows, and the trade manager runs the two rows
 * combined (off on either wins — mergeMgmt). Changing one card would change nothing that runs.
 *
 * manage_trades is then the database's to work out (trigger flow_accounts_derive_manage, migration
 * 20261008010000) from the row as it stands after the write — so two changes saved at the same moment
 * from two devices cannot leave it saying "off" over a partial that is on.
 *
 * `extra` adds columns per row (the older screens' AI Pips switch keeps each row's own follow choice).
 * Answers with the settings as they now stand — read back, combined the way the manager combines them.
 */
type Admin = NonNullable<ReturnType<typeof createAdminClient>>;
const MGMT_COLS = "id, manage_trades, gold_be_pips, be_enabled, trail_mode, partial_pct";
async function saveMgmt(admin: Admin, userId: string, accountId: string, patch: MgmtPatch, extra: (row: MgmtRow) => Record<string, unknown> = () => ({})) {
  const read = await admin.from("flow_broker_accounts").select(MGMT_COLS).eq("user_id", userId).eq("account_id", accountId);
  if (read.error) return missingColumn(read.error)
    ? { ok: false as const, error: "needs_setup", detail: "Trade settings aren't ready yet — try again in a minute." }
    : { ok: false as const, error: "save_failed", detail: "Couldn't save that — try again." };
  const rows = (read.data ?? []) as unknown as Array<MgmtRow & { id: string }>;
  if (!rows.length) return { ok: false as const, error: "not_found", detail: "That account isn't connected any more — tap Re-check." };
  const now = new Date().toISOString();
  for (const row of rows) {
    const { error } = await admin.from("flow_broker_accounts").update({ ...applyMgmtPatch(row, patch), ...extra(row), updated_at: now }).eq("id", row.id).eq("user_id", userId);
    if (error) return { ok: false as const, error: "save_failed", detail: "Couldn't save that — try again." };
  }
  const after = await admin.from("flow_broker_accounts").select(MGMT_COLS).eq("user_id", userId).eq("account_id", accountId);
  const final = (after.error ? rows.map((r) => ({ ...r, ...applyMgmtPatch(r, patch), ...extra(r) })) : (after.data ?? [])) as unknown as MgmtRow[];
  return { ok: true as const, view: mgmtViewMerged(final) };
}

/** For AI Pips switched back on from an older screen: each row keeps the follow choice the member gave it,
 *  unless it has none or it is off — then Normal, which is what AI Pips meant. */
const keepOrNormal = (row: MgmtRow): Record<string, unknown> => (row.trail_mode == null || row.trail_mode === "off" ? { trail_mode: "normal" } : {});

/** GET /api/flow/broker — ALL connections + ALL accounts (no secrets). Each
 *  account carries autotradeEnabled so the UI can show a per-account on/off. */
export async function GET() {
  const user = await authUser();
  if (!user) return json({ error: "unauthorized" }, 401);
  const conns = await getAllConnections(user.id);
  if (!conns.length) return json({ connected: false, accounts: [], connections: [] });
  const admin = createAdminClient();

  const baseCols = "account_id, acc_num, name, currency, balance, equity, open_positions, is_selected, autotrade_enabled, genx_follower";
  const settingCols = ", risk_pct, manage_trades, gold_be_pips, risk_mode, send_it, send_it_stack, send_it_guards, be_enabled, partials_enabled, profit_guard, permissions, kill_switch_at, style_quick, style_hold, style_swing";
  const perConn: Array<{ c: (typeof conns)[number]; accts: Record<string, unknown>[]; unread: boolean }> = [];
  for (const c of conns) {
    let accts: Record<string, unknown>[] = [];
    let unread = false;
    if (admin) {
      // The settings columns, newest first. A database that lacks a column (code ahead of its migration) is
      // read with the columns it has. Any other failure is tried once more, and if it fails again the
      // accounts are still listed but marked: their settings could not be read — never shown as defaults.
      const sel = (cols: string) => admin.from("flow_broker_accounts").select(cols).eq("connection_id", c.id).order("created_at", { ascending: true });
      const lists = [baseCols + settingCols + ", trail_mode, partial_pct", baseCols + settingCols, baseCols];
      for (let i = 0; i < lists.length; i++) {
        let got = await sel(lists[i]);
        if (got.error && !missingColumn(got.error)) got = await sel(lists[i]);
        if (!got.error) { accts = (got.data ?? []) as unknown as Record<string, unknown>[]; break; }
        if (missingColumn(got.error) && i < lists.length - 1) continue;
        if (i < lists.length - 1) { const b = await sel(baseCols); if (!b.error) accts = (b.data ?? []) as unknown as Record<string, unknown>[]; unread = true; }
        break;
      }
    }
    perConn.push({ c, accts, unread });
  }
  // One broker account on several rows (the same login connected twice) runs as those rows combined
  // (the trade manager's mergeMgmt), so every one of its cards shows that — what actually runs.
  const byAcct = new Map<string, MgmtRow[]>();
  for (const pc of perConn) if (!pc.unread) for (const a of pc.accts) {
    const id = String(a.account_id);
    if (!byAcct.has(id)) byAcct.set(id, []);
    byAcct.get(id)!.push(a as MgmtRow);
  }
  const accounts: Record<string, unknown>[] = [];
  for (const { c, accts, unread } of perConn) {
    for (const a of accts) {
      const same = byAcct.get(String(a.account_id)) ?? [];
      accounts.push({
        accountId: a.account_id, accNum: a.acc_num, name: a.name, currency: a.currency,
        balance: a.balance, equity: a.equity, openPositions: a.open_positions,
        selected: a.is_selected, autotradeEnabled: a.autotrade_enabled !== false,
        genxFollower: a.genx_follower === true,
        riskPct: typeof a.risk_pct === "number" && (a.risk_pct as number) > 0 ? a.risk_pct : null,
        // How an open trade is looked after (manageSettings.ts, owner 10-08): break-even, follow price and
        // partials, plus the older names (manageTrades, beEnabled, partialsEnabled, profitGuard, goldBePips)
        // that screens from before still read.
        ...(unread ? { settingsUnread: true } : same.length > 1 ? mgmtViewMerged(same) : mgmtView(a as MgmtRow)),
        riskMode: a.risk_mode === "aggressive" ? "aggressive" : "conservative", // per-account safety mode; default conservative
        sendIt: a.send_it === true, // 🚀 Send It v2: every setup — behavior configured per account below
        sendItStack: a.send_it_stack !== false,  // true = every entry (classic); false = one at a time
        sendItGuards: a.send_it_guards === true, // true = safeguards respected; false = bypassed (classic)
        // Horizons. A row written before these columns existed reads as the previous behaviour —
        // the two shorter ones on — rather than as nothing switched on.
        styleQuick: a.style_quick !== false,
        styleHold: a.style_hold !== false,
        styleSwing: a.style_swing === true,
        permissions: resolveAll(a as never), // resolved granular permissions (defaults applied)
        killSwitchAt: a.kill_switch_at ?? null,
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
    /*
     * ONE SWITCH (owner 09-24). Arming an account here used to leave the master FLOW toggle alone,
     * so a member could switch an account on, see it on, and be dropped by the master's OFF — 25
     * members were in exactly that state. The master now follows the accounts, and `flowEnabled` is
     * read back from the database rather than assumed, so if the sync fails the panel shows the
     * truth instead of quietly recreating the drift.
     */
    const sync = await syncMasterFromAccounts(admin, user.id);
    return json({ ok: true, accountId, autotradeEnabled: enabled, flowEnabled: sync.master, armedAccounts: sync.armedAccounts });
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
    // GENX following is billed as FLOW running, so it arms the master the same way auto-trading does.
    const sync = await syncMasterFromAccounts(admin, user.id);
    return json({ ok: true, accountId, genxFollower: enabled, flowEnabled: sync.master, armedAccounts: sync.armedAccounts });
  }

  if (action === "risk") {
    // Set (or clear) a single account's risk % override. null/empty → use the
    // owner's default risk. Aggressive on one account, conservative on another.
    const accountId = String(body.accountId || "");
    if (!accountId) return json({ error: "missing_account" }, 200);
    let risk: number | null = null;
    const raw = body.riskPct;
    if (raw != null && raw !== "") {
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) risk = Math.min(100, Math.max(0.01, n));
    }
    let q = admin.from("flow_broker_accounts").update({ risk_pct: risk, updated_at: new Date().toISOString() }).eq("user_id", user.id).eq("account_id", accountId);
    if (body.connectionId) q = q.eq("connection_id", String(body.connectionId));
    const { error } = await q;
    if (error) return json({ error: "needs_setup", detail: "Per-account risk isn't set up yet — the risk_pct column is missing." }, 200);
    return json({ ok: true, accountId, riskPct: risk });
  }

  if (action === "management") {
    /*
     * HOW THE AI LOOKS AFTER AN OPEN TRADE (owner 10-08) — one account's break-even, follow price and
     * partials. Any of the three can be sent alone:
     *   breakEven    "off" | 20 | 30 | 40 | 50   (gold pips; currency pairs break even halfway to target)
     *   followPrice  "off" | "tight" | "normal" | "loose"
     *   partials     0 | 25 | 50
     * Anything else is refused with a line the screen shows. Applies to the account's FLOW, GENX and
     * GEN FX trades alike, from the next price tick — including trades already open.
     */
    const accountId = String(body.accountId || "");
    if (!accountId) return json({ error: "missing_account" }, 200);
    const parsed = parseMgmtPatch(body);
    if (!parsed.ok) return json({ error: "bad_value", detail: parsed.detail }, 200);
    const saved = await saveMgmt(admin, user.id, accountId, parsed.patch);
    if (!saved.ok) return json({ error: saved.error, detail: saved.detail }, 200);
    return json({ ok: true, accountId, ...saved.view });
  }

  if (action === "manage") {
    // AI PIPS — the one switch the screens had from 09-22 to 10-08, still sent by a phone that has the
    // older app open. On = break-even at the account's own pips + follow price (Normal unless the member
    // has already picked one); off = everything off. A database without the 10-08 columns gets the one
    // switch, as before.
    const accountId = String(body.accountId || "");
    if (!accountId) return json({ error: "missing_account" }, 200);
    const enabled = body.enabled !== false; // default ON
    const saved = await saveMgmt(admin, user.id, accountId, enabled ? { breakEven: "on" } : { breakEven: "off", partials: 0 },
      enabled ? keepOrNormal : undefined);
    if (!saved.ok && saved.error !== "needs_setup") return json({ error: saved.error, detail: saved.detail }, 200);
    if (!saved.ok) {
      let q = admin.from("flow_broker_accounts").update({ manage_trades: enabled, updated_at: new Date().toISOString() }).eq("user_id", user.id).eq("account_id", accountId);
      if (body.connectionId) q = q.eq("connection_id", String(body.connectionId));
      const { error } = await q;
      if (error) return json({ error: "needs_setup", detail: "Trade management isn't set up yet — the manage_trades column is missing." }, 200);
    }
    return json({ ok: true, accountId, manageTrades: enabled });
  }

  if (action === "mode") {
    // Set the per-account SAFETY MODE. 'conservative' (default) auto-pauses that account
    // for 4h after 2 losing trades in a row (gold + forex tracked separately); 'aggressive'
    // removes that cap. Applies to that account's FLOW and GENX trades alike.
    const accountId = String(body.accountId || "");
    if (!accountId) return json({ error: "missing_account" }, 200);
    const mode = String(body.mode || "").toLowerCase() === "aggressive" ? "aggressive" : "conservative";
    let q = admin.from("flow_broker_accounts").update({ risk_mode: mode, updated_at: new Date().toISOString() }).eq("user_id", user.id).eq("account_id", accountId);
    if (body.connectionId) q = q.eq("connection_id", String(body.connectionId));
    const { error } = await q;
    if (error) return json({ error: "needs_setup", detail: "Safety mode isn't set up yet — the risk_mode column is missing." }, 200);
    return json({ ok: true, accountId, riskMode: mode });
  }

  if (action === "betoggle") {
    // Break-even on/off from an older screen. On keeps the account's own pips. (The settings screen
    // sends action "management".)
    const accountId = String(body.accountId || "");
    if (!accountId) return json({ error: "missing_account" }, 200);
    const enabled = body.enabled !== false; // default ON
    const saved = await saveMgmt(admin, user.id, accountId, { breakEven: enabled ? "on" : "off" });
    if (!saved.ok) return json({ error: saved.error, detail: saved.detail }, 200);
    return json({ ok: true, accountId, beEnabled: saved.view.beEnabled });
  }

  if (action === "partialtoggle") {
    // Partials on/off from an older screen: on is a quarter, halfway to the target.
    const accountId = String(body.accountId || "");
    if (!accountId) return json({ error: "missing_account" }, 200);
    const enabled = body.enabled !== false; // default ON
    const saved = await saveMgmt(admin, user.id, accountId, { partials: enabled ? 25 : 0 });
    if (!saved.ok) return json({ error: saved.error, detail: saved.detail }, 200);
    return json({ ok: true, accountId, partialsEnabled: saved.view.partialsEnabled });
  }

  if (action === "permissions") {
    // COMMAND CENTER XAUUSD: set one or more granular permissions on an account. Unknown keys and
    // non-boolean values are dropped; the stored object only ever holds keys this build understands.
    const accountId = String(body.accountId || "");
    if (!accountId) return json({ error: "missing_account" }, 200);
    const patch = sanitisePermissions((body as { permissions?: unknown }).permissions);
    if (!Object.keys(patch).length) return json({ error: "no_valid_permissions", keys: PERMISSION_KEYS }, 200);
    const { data: cur } = await admin.from("flow_broker_accounts").select("permissions").eq("user_id", user.id).eq("account_id", accountId).maybeSingle();
    const merged = { ...(((cur as { permissions?: Record<string, unknown> } | null)?.permissions) ?? {}), ...patch };
    let q = admin.from("flow_broker_accounts").update({ permissions: merged, updated_at: new Date().toISOString() }).eq("user_id", user.id).eq("account_id", accountId);
    if (body.connectionId) q = q.eq("connection_id", String(body.connectionId));
    const { error } = await q;
    if (error) return json({ error: "needs_setup", detail: "Permissions aren't set up yet — the permissions column is missing." }, 200);
    return json({ ok: true, accountId, permissions: merged });
  }

  if (action === "killswitch") {
    // ONE CLICK: stop new trades on this account. Protection of open positions is untouched, by design —
    // "stop trading" must never mean "stop defending what is already open". `enabled:false` clears it.
    const accountId = String(body.accountId || "");
    if (!accountId) return json({ error: "missing_account" }, 200);
    const on = body.enabled !== false;
    let q = admin.from("flow_broker_accounts").update({
      kill_switch_at: on ? new Date().toISOString() : null,
      kill_switch_by: on ? (user.email ?? "member") : null,
      updated_at: new Date().toISOString(),
    }).eq("user_id", user.id).eq("account_id", accountId);
    if (body.connectionId) q = q.eq("connection_id", String(body.connectionId));
    const { error } = await q;
    if (error) return json({ error: "needs_setup", detail: "Kill switch isn't set up yet — the column is missing." }, 200);
    return json({ ok: true, accountId, killSwitch: on });
  }

  if (action === "guardtoggle") {
    // PROFIT GUARD (owner 09-17): opt-in per account. Default OFF — a member must turn it on.
    const accountId = String(body.accountId || "");
    if (!accountId) return json({ error: "missing_account" }, 200);
    const enabled = body.enabled === true; // default OFF
    let q = admin.from("flow_broker_accounts").update({ profit_guard: enabled, updated_at: new Date().toISOString() }).eq("user_id", user.id).eq("account_id", accountId);
    if (body.connectionId) q = q.eq("connection_id", String(body.connectionId));
    const { error } = await q;
    if (error) return json({ error: "needs_setup", detail: "Profit Guard isn't set up yet — the profit_guard column is missing." }, 200);
    return json({ ok: true, accountId, profitGuard: enabled });
  }

  if (action === "styles") {
    /*
     * WHICH HORIZONS THIS ACCOUNT TAKES.
     *
     * The three are not aggression settings — they are different trades with different holding
     * periods and different overnight exposure, and a member running a small funded account has a
     * real reason to want the fast ones and not the ones that sit through a session.
     *
     * AT LEAST ONE MUST STAY ON. An account that is switched on and takes nothing looks like a
     * broken system rather than a choice, and is exactly the state somebody reaches by accident and
     * then spends an evening debugging. Turning the last one off is refused, with a reason.
     */
    const accountId = String(body.accountId || "");
    if (!accountId) return json({ error: "missing_account" }, 200);

    const quick = body.quick === true;
    const hold = body.hold === true;
    const swing = body.swing === true;
    if (!quick && !hold && !swing) {
      return json({ error: "needs_one", detail: "Keep at least one trade style on, or switch the account off instead." }, 200);
    }

    let q = admin.from("flow_broker_accounts")
      .update({ style_quick: quick, style_hold: hold, style_swing: swing, updated_at: new Date().toISOString() })
      .eq("user_id", user.id).eq("account_id", accountId);
    if (body.connectionId) q = q.eq("connection_id", String(body.connectionId));
    const { error } = await q;
    if (error) return json({ error: "needs_setup", detail: "Trade styles aren't set up yet — the style columns are missing." }, 200);
    return json({ ok: true, accountId, styleQuick: quick, styleHold: hold, styleSwing: swing });
  }

  if (action === "sendit") {
    // 🚀 SEND IT v2 (owner 09-08): this account takes every setup the AI calls, and the
    // member configures HOW in the setup prompt:
    //   stack:  true = every entry (skips the one-open cap; classic) · false = one at a time
    //   guards: true = respect the desk safeguards (halts, post-win bar, exhausted-setup)
    //           · false = bypass them (classic)
    //   be / partials: whether the trade-manager still moves break-even / banks partials —
    //           these write the account's normal be_enabled / partials_enabled toggles.
    // Sizing still uses the account's risk %. Default OFF; explicit per-account opt-in.
    // SEND IT RETIRED (owner 09-13: "Take EVERYONE off send it... Nobody can have that
    // turned on"). This endpoint can no longer enable it — it only ever forces the flags
    // OFF, so any stray client or old cached UI can't switch it back on.
    const accountId = String(body.accountId || "");
    if (!accountId) return json({ error: "missing_account" }, 200);
    let q = admin.from("flow_broker_accounts").update({ send_it: false, send_it_stack: false, send_it_guards: false, updated_at: new Date().toISOString() }).eq("user_id", user.id).eq("account_id", accountId);
    if (body.connectionId) q = q.eq("connection_id", String(body.connectionId));
    await q;
    return json({ ok: true, accountId, sendIt: false, retired: true });
  }

  if (action === "goldbe") {
    // The gold break-even distance on its own (older screens). Only the distances a member can pick on
    // the settings screen are taken — 20, 30, 40 or 50 pips — or nothing, for the 30-pip default.
    const accountId = String(body.accountId || "");
    if (!accountId) return json({ error: "missing_account" }, 200);
    const raw = body.goldBePips;
    let pips: number | null = null;
    if (raw != null && raw !== "") {
      const n = Number(raw);
      if (!BE_PIPS_CHOICES.includes(n)) return json({ error: "bad_value", detail: "Break-even is 20, 30, 40 or 50 pips." }, 200);
      pips = n;
    }
    let q = admin.from("flow_broker_accounts").update({ gold_be_pips: pips, updated_at: new Date().toISOString() }).eq("user_id", user.id).eq("account_id", accountId);
    if (body.connectionId) q = q.eq("connection_id", String(body.connectionId));
    const { error } = await q;
    if (error) return json({ error: "needs_setup", detail: "Gold breakeven pips isn't set up yet — the gold_be_pips column is missing." }, 200);
    return json({ ok: true, accountId, goldBePips: pips });
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

  // Refresh the broker's account list WITHOUT wiping the member's per-account settings.
  // (Previously this did delete()+insert(), which silently reset EVERY toggle — autotrade,
  // genx_follower, manage_trades, risk_mode, risk_pct, gold_be_pips — back to defaults on every
  // reconnect / re-check. So an account the member had switched ON came back OFF and quietly
  // stopped trading while the app still showed it on.) Now: refresh market fields on the rows we
  // already have, insert only genuinely-new accounts (with defaults), and drop only accounts the
  // broker no longer returns. Toggle columns on existing rows are never touched.
  const { data: existingRows } = await admin.from("flow_broker_accounts")
    .select("account_id").eq("connection_id", connRow.id);
  const existingIds = new Set((existingRows ?? []).map((r) => String((r as { account_id: string }).account_id)));
  const incomingIds = new Set(accounts.map((ac) => String(ac.accountId)));

  for (const ac of accounts) {
    const refresh = {
      name: ac.name ?? null, currency: ac.currency ?? null, environment: env,
      balance: ac.balance ?? null, equity: ac.equity ?? null, updated_at: nowIso,
    };
    if (existingIds.has(String(ac.accountId))) {
      // Existing account → refresh market data only; leave every toggle/setting as the member left it.
      await admin.from("flow_broker_accounts").update(refresh)
        .eq("connection_id", connRow.id).eq("account_id", ac.accountId);
    } else {
      // Brand-new account → insert with default settings.
      await admin.from("flow_broker_accounts").insert({
        user_id: user.id, connection_id: connRow.id, account_id: ac.accountId, acc_num: ac.accNum,
        is_selected: ac.accountId === firstAccount, ...refresh,
      });
    }
  }
  // Remove only accounts that no longer exist at the broker — never the ones we still see. And only when the
  // broker's list was actually read: a failed read lists nothing, and used to delete every account here —
  // its switches and trade settings with it (review, 10-08).
  const staleIds = [...existingIds].filter((id) => !incomingIds.has(id));
  if (accountsRes.ok && staleIds.length) {
    await admin.from("flow_broker_accounts").delete().eq("connection_id", connRow.id).in("account_id", staleIds);
  }

  return json({
    ok: true, connection: safeConnView(connRow as never),
    accountsFound: accounts.length,
    accounts: accounts.map((ac) => ({ accountId: ac.accountId, accNum: ac.accNum, currency: ac.currency, balance: ac.balance, equity: ac.equity, name: ac.name })),
    selectedAccountId: firstAccount,
    note: accountsRes.ok ? undefined : "Connected, but couldn't load account details yet.",
  });
}
