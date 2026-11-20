/**
 * THE SELECTED ACCOUNT'S BALANCE AND EQUITY, FROM THE BROKER (owner 11-20: "display the selected connected
 * account's balance and equity … Show actual broker-reported values").
 *
 * WHAT WAS THERE BEFORE. flow_broker_accounts.balance is written when an account is connected and almost
 * never again (of 547 connected accounts, 13 had been touched in the last day), its `updated_at` moves
 * whenever a setting is saved, and `equity` has never been stored for anyone. Shown as they are, those would
 * be an old balance wearing a fresh timestamp and an equity that does not exist.
 *
 * WHAT THIS DOES. For the ONE account the member is looking at, it asks the broker for the account's state
 * (GET /trade/accounts/{id}/state), reads the row by the column names the broker's own config gives
 * (accountDetailsConfig — the row is positional and is never read by guessing positions), and keeps the
 * reading with the time it was taken in a table of its own (floor_account_state). flow_broker_accounts —
 * the table sizing, the executor and the trade manager read — is only ever READ here, never written:
 * showing a number must not be able to change a trade.
 *
 * IT MUST NEVER COST A TRADE. TradeLocker's edge limits requests by IP, and that budget is what places
 * orders and moves stops (src/lib/flow/tradelocker.ts). So a display read:
 *   • runs at "background" priority — behind every order, stop, login and ordinary read;
 *   • is skipped outright while an order or a login is waiting in the scheduler;
 *   • is shared: one reading per account per STATE_TTL_MS, whoever asks and from however many tabs.
 * When it is skipped, fails or is too old, the last reading is shown WITH ITS AGE and is not called live
 * (overview.figuresState). A number that was never read is null — never zero.
 *
 * Read-only toward the broker. It changes no setting, selects no account and enables nothing. A login the
 * site already knows is broken is not tried again from here — reconnecting is the member's act, in FLOW.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { connectionToken } from "@/lib/flow/connection";
import { brokerRateStats, getAccountState, getConfig, listAccounts, withBrokerPriority } from "@/lib/flow/tradelocker";
import type { AccountFigures } from "./overview";
import { STATE_TTL_MS, CONFIG_TTL_MS, brokerBusy, detailColumns, figuresFromStored, parseAccountState, type AccountRow, type ParsedState, type StateRow } from "./brokerState";

const MEM = new Map<string, { at: number; fig: AccountFigures }>();
const COLS = new Map<string, { at: number; cols: string[] }>();
const INFLIGHT = new Map<string, Promise<AccountFigures>>();

/**
 * The figures for one account the member owns. `readBroker: false` never leaves the database.
 *
 * `maxWaitMs` keeps the screen from waiting on a slow broker: past it, the answer is the last reading,
 * marked `reading: true` (a fresh one has been asked for and is not back yet), and the screen asks again
 * in a few seconds. The read itself carries on and is there for that next ask.
 */
export async function accountFigures(
  userId: string, account: { id: string; environment: "live" | "demo" }, opts: { nowMs?: number; readBroker?: boolean; maxWaitMs?: number } = {},
): Promise<AccountFigures> {
  const now = opts.nowMs ?? Date.now();
  const none = (note: string): AccountFigures => ({ balance: null, equity: null, openPnl: null, positions: null, at: null, state: "unavailable", note });
  const admin = createAdminClient();
  if (!admin) return none("Account figures are not available right now.");

  // The account, as the member's own row(s) in FLOW. Ownership is this query: user id AND account id.
  const got = await admin.from("flow_broker_accounts").select("connection_id, account_id, acc_num, environment, balance").eq("user_id", userId).eq("account_id", account.id);
  if (got.error) return none("Account figures could not be read just now.");
  const rows = ((got.data ?? []) as unknown as AccountRow[]).filter((r) => (String(r.environment ?? "").toLowerCase() === "live" ? "live" : "demo") === account.environment);
  if (!rows.length) return none("That account is not connected.");

  // The last reading. Its table arrives with a migration; without it a reading lives in memory only.
  let canStore = true;
  let reading: StateRow | null = null;
  const st0 = await admin.from("floor_account_state").select("balance, equity, open_pl, positions, read_at").eq("user_id", userId).eq("environment", account.environment).eq("account_id", account.id).maybeSingle();
  if (st0.error) canStore = false;      // no table yet, or unreadable just now: nothing is written where nothing could be read
  else reading = (st0.data as StateRow | null) ?? null;

  const stored = figuresFromStored(reading, rows, now);
  if (stored.state === "live") return stored;
  const key = `${userId}:${account.environment}:${account.id}`;
  const mem = MEM.get(key);
  if (mem && now - mem.at <= STATE_TTL_MS) return mem.fig;
  if (opts.readBroker === false) return stored;
  if (brokerBusy(brokerRateStats())) return { ...stored, note: stored.state === "unavailable" ? "The broker connection is busy placing trades. The figures will appear shortly." : "The broker connection is busy placing trades. This is the last reading." };

  // Only a login the site holds as working is asked. One marked as needing attention is left alone: trying
  // it from a screen would be a sign-in attempt nobody asked for.
  const conns = await admin.from("flow_broker_connections").select("id, status").eq("user_id", userId).in("id", [...new Set(rows.map((r) => r.connection_id))]);
  const working = new Set(((conns.data ?? []) as { id: string; status: string | null }[]).filter((c) => c.status === "connected").map((c) => c.id));
  const usable = rows.filter((r) => working.has(r.connection_id) && r.acc_num);
  if (!usable.length) return { ...stored, note: stored.state === "unavailable" ? "This account needs to be reconnected in FLOW." : "This account needs to be reconnected in FLOW. This is the last reading." };

  const bounded = (job: Promise<AccountFigures>): Promise<AccountFigures> => {
    const wait = opts.maxWaitMs;
    if (!(wait != null && wait > 0)) return job;
    return new Promise<AccountFigures>((resolve) => {
      const late = setTimeout(() => resolve({ ...stored, reading: true, note: stored.state === "unavailable" ? "Reading your broker…" : "Reading your broker. This is the last reading." }), wait);
      job.then((v) => { clearTimeout(late); resolve(v); }, () => { clearTimeout(late); resolve({ ...stored, note: stored.state === "unavailable" ? "Your broker did not answer just now." : "Your broker did not answer just now. This is the last reading." }); });
    });
  };
  const running = INFLIGHT.get(key);
  if (running) return bounded(running);
  const job = withBrokerPriority("background", async (): Promise<AccountFigures> => {
    let lastNote = "Your broker did not answer just now.";
    for (const row of usable) {
      const t = await connectionToken(row.connection_id);
      if (!t.ok) { lastNote = "This account needs to be reconnected in FLOW."; continue; }
      let cols = COLS.get(row.connection_id);
      if (!cols || now - cols.at > CONFIG_TTL_MS) {
        const cfg = await getConfig(t.env, t.token, String(row.acc_num));
        cols = { at: now, cols: cfg.ok ? detailColumns(cfg.data) : [] };
        if (cols.cols.length) COLS.set(row.connection_id, cols);
        if (COLS.size > 2000) COLS.clear();
      }
      const st = await getAccountState(t.env, t.token, String(row.acc_num), account.id);
      let parsed: ParsedState | null = st.ok ? parseAccountState(st.data, cols.cols) : null;
      if (!parsed) {
        // No readable state on this broker build: the account list still carries the balance. Equity stays unknown.
        const list = await listAccounts(t.env, t.token);
        const mine = list.ok ? list.data.find((a) => String(a.accountId) === account.id) : null;
        if (mine && mine.balance != null) parsed = { balance: mine.balance, equity: mine.equity ?? null, openPnl: null, positions: null };
      }
      if (!parsed) { lastNote = "Your broker did not answer just now."; continue; }
      const at = new Date().toISOString();
      const fig: AccountFigures = { ...parsed, at, state: "live", note: parsed.equity == null ? "Your broker reported the balance only." : null };
      MEM.set(key, { at: Date.now(), fig });
      if (MEM.size > 5000) MEM.clear();
      if (canStore) {
        try {
          await admin.from("floor_account_state").upsert(
            { user_id: userId, environment: account.environment, account_id: account.id, balance: parsed.balance, equity: parsed.equity, open_pl: parsed.openPnl, positions: parsed.positions, read_at: at },
            { onConflict: "user_id,environment,account_id" });
        } catch { /* the reading is still shown; it is simply read again next time */ }
      }
      return fig;
    }
    return { ...stored, note: stored.state === "unavailable" ? lastNote : `${lastNote} This is the last reading.` };
  }).finally(() => INFLIGHT.delete(key));
  INFLIGHT.set(key, job);
  void job.catch(() => { /* answered through `bounded`; never an unhandled rejection */ });
  return bounded(job);
}
