import { createAdminClient } from "@/lib/supabase/admin";
import { type Mode } from "@/lib/genxCompute";
import { PAIRS, px, type FxPair, type PairKey } from "@/lib/genfx/pairs";
import { readControl, inScope, minStopPips, OWNER_USER_ID, GENFX_VERSION, type GenfxControl } from "@/lib/genfx/control";
import { sizeFx, FX_LOT_UNITS } from "@/lib/genfx/sizing";
import { judgeSignal, noiseRoom, slopeFrom15m, fxChoch, fxBreaker, stopWideEnough, chasedAt, BREAKER_WINDOW_MS, type StopRow } from "@/lib/genfx/guards";
import { pairPrice, usdJpyRate, closedSeries } from "@/lib/genfx/market";
import { fxFireGate, chargeFxFire, type FxFireGate } from "@/lib/genfx/billing";
import { reserveFx, markFx, releaseFxIfHeldBy, fxResvKey } from "@/lib/genfx/reserve";
import { byIds } from "@/lib/genfx/db";
import { UNSETTLED, CLAIM_DEAD_MS, SEND_DEADLINE_MS, sameSide, maxEntryFor, fxTag, carriesLabels, restingEntrySides, type Rows } from "@/lib/genfx/fills";
import { inWeekendCloseWindow, inScanQuietWindow, consecutiveLossStreak } from "@/lib/flow/autoExec";
import { connectionToken } from "@/lib/flow/connection";
import { can } from "@/lib/flow/permissions";
import { listAccounts, listOrders, withBrokerPriority, type TLEnv } from "@/lib/flow/tradelocker";
import { brokerConfig, columnMap } from "@/lib/flow/brokerEvidence";
import { placeFixedLotFollower, instrumentIdFor, contractSizeFor, warmInstruments, entryQuoteFor } from "@/lib/flow/executor";
import { filterAccountsByStyle } from "@/lib/flow/tradeStyles";
import { newsHold } from "@/lib/news/calendar";

/**
 * GEN FX PLACEMENT — a call becomes orders on the accounts that asked for it.
 *
 * The shape is GENX's follower path (autoExec.placeGenxFollower): one pass over the opted-in accounts,
 * each risk-sized to its own equity and its own risk %, one order per call per account, and every
 * account that sits a call out leaves a reason in flow_auto_events. The order itself goes through the
 * desk's one order function (executor.placeFixedLotFollower): a limit, stop and target attached,
 * brackets verified. Placement stops there: it records the order and the books pass (settle.ts), which
 * runs seconds later, writes the fill to the same ledger gold uses (flow_managed_positions) — so the
 * trade manager — break-even, trail, the booked result — runs it with no code of its own for this.
 *
 * WHO IT REACHES. Only an account whose own GEN FX switch for THIS pair is on
 * (flow_broker_accounts.genfx_eurusd / genfx_gbpjpy — off for everybody until they turn it on;
 * nobody's gold settings carry over), and only inside the owner's scope (control.ts).
 *
 * WHAT STOPS A CALL FOR EVERYONE, in order: GEN FX auto-trade is off · the market is in its closed or
 * quiet window · the guards in guards.judgeSignal (quality, breaker, change of character, a sane and
 * wide-enough stop, not chased) · for GBP/JPY, no USD/JPY rate to size with.
 *
 * WHAT STOPS IT FOR ONE ACCOUNT: its kill switch or "open new trades" permission · its horizon
 * switches · the conservative two-losses cool-down · already in a trade on this pair the same way ·
 * an earlier GEN FX order on it that has not been settled yet · a resting order on the pair · an
 * account not in dollars · this broker's own price already through the stop, too close to it, or past
 * the 0.8-to-1 floor · a size the rules in sizing.ts refuse.
 *
 * IT FAILS CLOSED. Every "is this account already in a trade?" question has to be ANSWERED before an
 * order leaves: a ledger that cannot be read, a broker that cannot be read, a lock that cannot be
 * taken, a claim that cannot be written — each is a skip with its reason, never a guess. A missed
 * entry is recoverable; a stacked position is not.
 *
 * THE ORDER IS REMEMBERED BEFORE IT IS SENT (fills.ts). The account's row for this call carries the
 * size and the levels before the order leaves, so whatever happens next — the broker times out, this
 * process is redeployed mid-order — a later pass knows exactly what to look for at the broker, and the
 * account is not offered another trade the same way until it has been found or ruled out.
 *
 * EVERY ORDER CARRIES GEN FX'S LABEL (fills.fxTag, the broker's strategyId), and is sent AT MOST ONCE.
 * The label is how the order — and the position it opens — is told apart afterwards from anything else
 * on the account, the member's own trades included; an account on a broker that does not give the
 * label back sits out, because nothing placed there could be followed safely. And where the desk's
 * broker client would re-send an order after a relay failed without saying whether the first arrived,
 * a labelled order is not re-sent: it is recorded as "may have filled" and the broker is asked.
 *
 * AND NOT LATE. From the moment an account's claim is written, its order has forty-five seconds to
 * START — the first try, a turn in the rate-limit queue, the retry without the target, the retry at the
 * smallest size: one clock for all of them (fills.SEND_DEADLINE_MS). The books pass counts from the same
 * moment, so by the time it would call a silent send dead, nothing of it can still be on its way.
 *
 * THE SIZE IS CUT FROM THE BROKER'S PRICE. The call is judged once, for everyone, on the market-data
 * feed. Each account's lots are then worked out from that account's own broker quote, read a moment
 * before its order goes: the ask for a buy, the bid for a sell. The order may fill no further than a
 * quarter of the stop distance past that price (fills.maxEntryFor), so the risk an account actually
 * takes is at most 1.25 times what it was sized for; beyond that the order rests rather than chases.
 */
type Admin = NonNullable<ReturnType<typeof createAdminClient>>;

export type FxSignal = {
  pair: PairKey; signalKey: string; side: "buy" | "sell"; mode: Mode;
  entryLow: number | null; entryHigh: number | null; stop: number | null; tp: number | null;
  setup: "zone" | "scanner"; confidence?: number | null; alertId?: string | null;
};
export type PlaceReport = { pair: PairKey; ran: boolean; reason: string; eligible: number; placed: number; skipped: Record<string, number> };

const FANOUT = 20;
const MEMBER_STREAK = 2;
const MEMBER_COOLDOWN_MS = 2 * 3600_000;

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, async () => {
    for (;;) { const i = cursor++; if (i >= items.length) break; out[i] = await fn(items[i]); }
  }));
  return out;
}

type AcctRow = {
  user_id: string; account_id: string; acc_num: string | null; connection_id: string; currency: string | null;
  risk_pct: number | null; risk_mode: string | null; permissions: Record<string, unknown> | null; kill_switch_at: string | null;
  style_quick: boolean | null; style_hold: boolean | null; style_swing: boolean | null; created_at?: string | null;
};
/** `login`: the broker login the account's connection signs in with — two connections can be one login. */
export type ArmedAccount = AcctRow & { env: string | null; login?: string | null };

/**
 * One row per BROKER ACCOUNT. The same broker account can be connected twice (a member who
 * reconnected, or two members sharing a login); it is still one account and takes one order. The row
 * kept is the one on a working connection, and of those the oldest. Pure.
 */
export function onePerAccount<T extends { account_id: string; connection_id: string; created_at?: string | null }>(rows: T[], connected: (connId: string) => boolean): T[] {
  const best = new Map<string, T>();
  const rank = (r: T) => (connected(String(r.connection_id)) ? 0 : 1);
  for (const r of rows) {
    const k = String(r.account_id);
    const cur = best.get(k);
    if (!cur) { best.set(k, r); continue; }
    const a = rank(r), b = rank(cur);
    if (a < b || (a === b && String(r.created_at ?? "") < String(cur.created_at ?? ""))) best.set(k, r);
  }
  return [...best.values()];
}

/** The accounts with this pair switched on, inside the owner's scope, with each connection's environment. Null when they could not be read. */
export async function armedAccounts(admin: Admin, pair: FxPair, ctl: GenfxControl): Promise<ArmedAccount[] | null> {
  const { data, error } = await admin.from("flow_broker_accounts")
    .select("user_id, account_id, acc_num, connection_id, currency, risk_pct, risk_mode, permissions, kill_switch_at, style_quick, style_hold, style_swing, created_at")
    .eq(pair.column, true);
  if (error) return null;
  const rows = (data ?? []) as unknown as AcctRow[];
  if (!rows.length) return [];
  const connIds = [...new Set(rows.map((r) => String(r.connection_id)))];
  type Conn = { id: string; environment: string | null; status: string | null; server?: string | null; email?: string | null };
  const conns = await byIds<Conn>(connIds, (chunk) => admin.from("flow_broker_connections").select("id, environment, status, server, email").in("id", chunk));
  if (!conns.ok) return null;
  const connOf = new Map(conns.rows.map((c) => [String(c.id), c]));
  const loginOf = (c: Conn | undefined) => (c?.email ? `${c.environment ?? ""}|${c.server ?? ""}|${String(c.email).trim().toLowerCase()}` : null);
  return onePerAccount(rows.filter((r) => connOf.has(String(r.connection_id))), (id) => connOf.get(id)?.status === "connected")
    .map((r) => ({ ...r, env: connOf.get(String(r.connection_id))?.environment ?? null, login: loginOf(connOf.get(String(r.connection_id))) }))
    .filter((r) => inScope(ctl.scope, { userId: String(r.user_id), environment: r.env }, OWNER_USER_ID));
}

type Ref = { env: TLEnv; token: string; accNum: string; accountId: string; connId: string };
type Bars = { h: number; l: number; c: number }[];
export type Sent = { ok: true; orderId: string | null; positionId: string | null; qty: number } | { ok: false; reason: string; deferred: boolean };

/**
 * Everything placement asks of the market and of a broker, in one place. The desk's own answers are
 * `deskIo`; the tests hand in theirs, which is how "the broker timed out after the order left" and
 * "the ledger write failed after the fill" get run rather than reasoned about.
 */
export type PlaceIo = {
  /** Is the market in its closed or quiet window? */
  quiet(): boolean;
  /** Is high-impact news for this pair inside the blackout window? */
  news(pair: PairKey): Promise<boolean>;
  price(pair: FxPair): Promise<number | null>;
  /** CLOSED candles, oldest → newest, or null. */
  bars(pair: FxPair, interval: string, size: number): Promise<Bars | null>;
  usdJpy(): Promise<number | null>;
  login(connectionId: string): Promise<{ token: string; env: TLEnv } | null>;
  /** Equity and currency of every account under a login, by account id. Empty when the broker did not answer. */
  accounts(tok: { token: string; env: TLEnv }): Promise<Map<string, { equity: number | null; currency: string | null }>>;
  instrument(ref: Ref, pair: PairKey): Promise<string | number | null>;
  /** Could the broker's instrument list be read at all? */
  listed(ref: Ref): Promise<boolean>;
  /** Units in one lot of this pair, when the broker's instrument list says. Null: it does not say. */
  contract?(ref: Ref, pair: PairKey): Promise<number | null>;
  /** Does this broker give an order's label back on its rows? Null = its settings could not be read. */
  labels(ref: Ref): Promise<boolean | null>;
  /** Sides with a resting entry order on this instrument; null = the orders could not be read. */
  restingSides(ref: Ref, instrumentId: string | number): Promise<Set<string> | null>;
  /** The price an entry on `side` would fill at on this account right now, or null. */
  quote(ref: Ref, pair: PairKey, side: "buy" | "sell"): Promise<number | null>;
  /** Send the order. A refusal is `{ ok: false }`; a THROW means it may have filled. */
  send(o: { userId: string; ref: Ref; pair: PairKey; side: "buy" | "sell"; qty: number; stop: number; tp: number; maxEntry: number; tag: string; notAfterMs: number }): Promise<Sent>;
};

/** The account's resting orders with their column names. Null when either could not be read. One retry: a timeout is not an answer. */
async function restingOrders(ref: Ref): Promise<Rows | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await listOrders(ref.env, ref.token, ref.accNum, ref.accountId);
      if (!res.ok) { if (res.status >= 400 && res.status < 500) return null; continue; }      // a 4xx is an answer; it is not retried
      if (!res.data.some((r) => Array.isArray(r))) return { rows: res.data, cols: undefined };
      const cols = columnMap(await brokerConfig(ref.env, ref.token, ref.accNum, ref.accountId), "ordersConfig");
      return cols ? { rows: res.data, cols } : null;
    } catch { /* timeout, network, or the config could not be read: try once more */ }
  }
  return null;
}

export const deskIo: PlaceIo = {
  quiet: () => inWeekendCloseWindow() || inScanQuietWindow(),
  news: async (pair) => (await newsHold(pair)).hold,
  price: (pair) => pairPrice(pair),
  bars: (pair, interval, size) => closedSeries(pair, interval, size),
  usdJpy: () => usdJpyRate(),
  login: (connectionId) => connectionToken(connectionId).then((t) => (t.ok ? { token: t.token, env: t.env } : null)).catch(() => null),
  accounts: (tok) => listAccounts(tok.env, tok.token).then((res) => {
    const m = new Map<string, { equity: number | null; currency: string | null }>();
    if (res.ok) for (const x of res.data) m.set(String(x.accountId), { equity: typeof x.equity === "number" ? x.equity : typeof x.balance === "number" ? x.balance : null, currency: x.currency ?? null });
    return m;
  }).catch(() => new Map()),
  instrument: (ref, pair) => instrumentIdFor(ref, pair),
  listed: (ref) => warmInstruments(ref),
  contract: (ref, pair) => contractSizeFor(ref, pair),
  labels: async (ref) => {
    try {
      const cfg = await brokerConfig(ref.env, ref.token, ref.accNum, ref.accountId);
      return carriesLabels(columnMap(cfg, "ordersConfig"), columnMap(cfg, "ordersHistoryConfig"));
    } catch { return null; }
  },
  restingSides: async (ref, instrumentId) => restingEntrySides(await restingOrders(ref), instrumentId),
  quote: (ref, pair, side) => withBrokerPriority("critical", () => entryQuoteFor(ref, pair, side)),
  send: (o) => placeFixedLotFollower({
    userId: o.userId, env: o.ref.env, token: o.ref.token, connId: o.ref.connId, accountId: o.ref.accountId, accNum: o.ref.accNum,
    symbol: o.pair, side: o.side, qty: o.qty, stop: o.stop, tp: o.tp, source: "genfx", maxEntry: o.maxEntry, tag: o.tag, notAfterMs: o.notAfterMs,
  }),
};

/** Read the live numbers judgeSignal needs for one pair. Each read fails soft to the value that blocks least — except the breaker, which fails closed. */
async function marketFor(admin: Admin, io: PlaceIo, pair: FxPair, ctl: GenfxControl, needSlope: boolean) {
  const [live, m5, m15] = await Promise.all([
    io.price(pair).catch(() => null),
    io.bars(pair, "5min", 60).catch(() => null),
    needSlope ? io.bars(pair, "15min", 100).catch(() => null) : Promise.resolve(null),
  ]);
  const room = noiseRoom(pair, (m5 ?? []).slice(-12));
  const choch = m5 && m5.length >= 8 ? fxChoch(pair, m5.slice(-30)) : null;
  const slope = m15 ? slopeFrom15m(m15.map((b) => b.c)) : null;

  // DESK BREAKER — the one read that must succeed. Not knowing whether GEN FX is on a losing streak on
  // this pair is not permission to add to it.
  let breakerPaused = false; let breakerNote = "";
  try {
    const since = new Date(Date.now() - BREAKER_WINDOW_MS).toISOString();
    const { data, error } = await admin.from("flow_managed_positions")
      .select("side, init_stop, resolved_at, result_pips, partial_taken")
      .eq("symbol", pair.key).eq("strategy_version", GENFX_VERSION).eq("status", "closed").eq("outcome", "stop")
      .gte("resolved_at", since).order("resolved_at", { ascending: false }).limit(500);
    if (error) throw error;
    breakerPaused = fxBreaker(pair, (data ?? []) as StopRow[]).paused;
  } catch { breakerPaused = true; breakerNote = " (the loss record could not be read)"; }

  return { live, room, slope, choch, breakerPaused, breakerNote, minStopPips: minStopPips(ctl, pair) };
}

const words = (e: unknown): string => (e instanceof Error ? e.message : typeof e === "string" ? e : "error").slice(0, 140);

/** A database write that must not throw: supabase-js returns its errors, but a dropped connection can still reject. */
async function safe(run: () => PromiseLike<{ error: unknown }>): Promise<{ error: unknown }> {
  try { return { error: (await run()).error ?? null }; } catch (e) { return { error: e ?? "threw" }; }
}

/** Why the account's lock was refused, in a member's words. */
const lockWords = (pair: FxPair, side: string, reason: string): string =>
  reason === "open_position" ? `already in a ${pair.name} ${side} on this account`
    : reason.startsWith("reserved") ? `another GEN FX ${pair.name} ${side} on this account is being placed or confirmed`
      : reason;

export async function placeGenfx(sig: FxSignal, deps: { admin?: Admin | null; io?: PlaceIo } = {}): Promise<PlaceReport> {
  const pair = PAIRS[sig.pair];
  const report = (ran: boolean, reason: string, eligible = 0, placed = 0, skipped: Record<string, number> = {}): PlaceReport => ({ pair: sig.pair, ran, reason, eligible, placed, skipped });
  const admin = deps.admin === undefined ? createAdminClient() : deps.admin;
  const io = deps.io ?? deskIo;
  if (!admin || !pair) return report(false, "no_admin_client");

  const ctl = await readControl(admin);
  if (!ctl.readable || !ctl.auto) return report(false, ctl.readable ? "auto_off" : "control_unreadable");

  // Nothing desk-wide is ever silent: a call that reaches nobody leaves the reason under the owner's id.
  const desk = async (reason: string, status = "skipped") => {
    try { await admin.from("flow_auto_events").insert({ user_id: OWNER_USER_ID, symbol: pair.key, side: sig.side, status, reason: `genfx: ${reason}`.slice(0, 200) }); } catch { /* breadcrumb best-effort */ }
  };

  if (io.quiet()) { await desk("quiet_window (no new entries around the daily close or over the weekend)"); return report(false, "quiet_window"); }
  if (ctl.config.newsBlackout) {
    try { if (await io.news(pair.key)) { await desk("news_blackout (high-impact news for this pair inside the window)"); return report(false, "news_blackout"); } } catch { /* calendar down → don't block */ }
  }

  const mkt = await marketFor(admin, io, pair, ctl, sig.setup === "scanner");
  const v = judgeSignal(pair, { side: sig.side, mode: sig.mode, entryLow: sig.entryLow, entryHigh: sig.entryHigh, stop: sig.stop, tp: sig.tp, setup: sig.setup }, mkt);
  if (!v.ok) { await desk(`${v.code} — ${v.reason}${v.code === "desk_breaker" ? mkt.breakerNote : ""}`); return report(false, v.code); }

  // GBP/JPY is sized in yen and paid in dollars: no USD/JPY rate, no trade.
  const usdJpy = pair.quote === "JPY" ? await io.usdJpy().catch(() => null) : null;
  if (pair.quote === "JPY" && usdJpy == null) { await desk("no_usdjpy_rate (cannot size a yen pair without it)"); return report(false, "no_usdjpy_rate"); }

  const armed = await armedAccounts(admin, pair, ctl);
  if (armed === null) { await desk("accounts_unreadable (the list of accounts with this pair switched on could not be read)"); return report(false, "accounts_unreadable"); }
  const loaded = armed.length;
  if (!loaded) { await desk(`fanout 0 accounts (nobody in scope "${ctl.scope}" has ${pair.name} switched on)`, "fanout"); return report(true, "no_armed_accounts"); }
  // The member's own horizon switches decide here exactly as they do for gold (and are a no-op when
  // GENX_TRADE_STYLES is off, as it is for gold).
  const accts = filterAccountsByStyle(armed.map((a) => ({ ...a, styleQuick: a.style_quick, styleHold: a.style_hold, styleSwing: a.style_swing })), sig.mode);

  const gate: FxFireGate = ctl.billing ? await fxFireGate(admin, accts.map((a) => String(a.user_id))) : { eligible: new Set(), billable: new Set() };

  // One login and one account list per connection, however many of its accounts are armed.
  const tokens = new Map<string, Promise<{ token: string; env: TLEnv } | null>>();
  const tokenFor = (connId: string) => {
    let p = tokens.get(connId);
    if (!p) { p = io.login(connId).catch(() => null); tokens.set(connId, p); }
    return p;
  };
  type Live = { equity: number | null; currency: string | null };
  const lives = new Map<string, Promise<Map<string, Live>>>();
  const liveFor = (connId: string, tok: { token: string; env: TLEnv }) => {
    let p = lives.get(connId);
    if (!p) { p = io.accounts(tok).catch(() => new Map<string, Live>()); lives.set(connId, p); }
    return p;
  };
  const defaultRisk = new Map<string, Promise<number>>();
  const riskFor = (userId: string) => {
    let p = defaultRisk.get(userId);
    if (!p) {
      p = (async () => {
        try {
          const { data } = await admin.from("flow_trade_prefs").select("risk_pct").eq("user_id", userId).maybeSingle();
          const r = (data as { risk_pct?: number | null } | null)?.risk_pct;
          return typeof r === "number" && r > 0 ? r : 1;
        } catch { return 1; }
      })();
      defaultRisk.set(userId, p);
    }
    return p;
  };

  /**
   * Is auto-trade still on for this account, right now? The master switch and the scope (one read
   * shared by accounts asking within a quarter of a second), then the account's own switch for this
   * pair and its kill switch. Anything that cannot be read is "off".
   *
   * The pair switch is the one on the row this order goes out through. The KILL SWITCH is the
   * account's, wherever it was set: an account connected twice has two rows, and "stop everything on
   * this account" set through one of them stops an order going out through the other.
   */
  let ctlNow: { at: number; p: Promise<GenfxControl> } | null = null;
  const stillOn = async (a: ArmedAccount): Promise<"on" | string> => {
    if (!ctlNow || Date.now() - ctlNow.at > 250) ctlNow = { at: Date.now(), p: readControl(admin) };
    const c = await ctlNow.p;
    if (!c.readable || !c.auto) return "GEN FX auto-trade was switched off";
    if (!inScope(c.scope, { userId: String(a.user_id), environment: a.env }, OWNER_USER_ID)) return "this account is no longer in scope";
    try {
      const { data, error } = await admin.from("flow_broker_accounts").select(`connection_id, ${pair.column}, kill_switch_at`).eq("account_id", String(a.account_id)).limit(20);
      const all = (data ?? []) as unknown as Record<string, unknown>[];
      const row = all.find((r) => String(r.connection_id) === String(a.connection_id));
      if (error || !row) return "this account's switches could not be read";
      if (row[pair.column] !== true) return `${pair.name} was switched off on this account`;
      if (all.some((r) => !!r.kill_switch_at)) return "this account's kill switch is on";
    } catch { return "this account's switches could not be read"; }
    return "on";
  };

  const skipped: Record<string, number> = {};
  const resvKey = fxResvKey(pair.key, sig.side);          // always pair-and-side; gold's hedge switch is not consulted
  const signalKey = String(sig.signalKey).slice(0, 200);
  const stop = v.stop, tp = v.tp, sizeEntry = v.sizeEntry;

  const one = async (a: ArmedAccount): Promise<number> => {
    const uid = String(a.user_id), aid = String(a.account_id);
    const count = (code: string) => { skipped[code] = (skipped[code] ?? 0) + 1; };
    const event = async (row: Record<string, unknown>) => {
      try { await admin.from("flow_auto_events").insert({ user_id: uid, symbol: pair.key, side: sig.side, account_id: aid, ...row }); } catch { /* a breadcrumb never blocks */ }
    };
    const skip = async (code: string, reason: string): Promise<number> => {
      count(code);
      await event({ status: "skipped", reason: `genfx: ${reason}`.slice(0, 200) });
      return 0;
    };
    // This call's own row for this account: every write to it names both halves of its key.
    const fill = () => admin.from("genfx_fills");

    const tag = fxTag(signalKey, aid);      // this order's label at the broker
    let claimed = false;      // this call's row exists in genfx_fills for this account
    let reserved = false;     // the account's lock for this pair and side is ours
    let claimAt = 0;          // when the claim was made — the one clock the send deadline and the books pass both count from
    const undo = async () => {
      if (claimed) await safe(() => fill().delete().eq("signal_key", signalKey).eq("account_id", aid));     // if this fails, the sweep voids a claim that was never sent
      if (reserved) await releaseFxIfHeldBy(admin, aid, resvKey, signalKey);      // only ever this call's own lock
    };

    /* ── 1. Everything that can be decided before an order exists. A throw in here means nothing was
     *       sent: the claim and the lock are handed back and the account sits this call out. ── */
    let ready: { ref: Ref; fillRef: number; lots: number; riskPct: number; lossPerLot: number };
    try {
      if (!a.acc_num) return skip("no_broker_account", "no_broker_account (this account has no broker number)");
      const perm = can({ account_id: aid, autotrade_enabled: true, permissions: a.permissions, kill_switch_at: a.kill_switch_at }, "allow_entries");
      if (!perm.allowed) return skip("permission", `permission (${perm.reason})`);
      if (ctl.billing && !gate.eligible.has(uid)) return skip("credits", "credits (not enough credits for this trade)");

      // CONSERVATIVE: two GEN FX losses in a row on this pair rest this account for two hours.
      if (String(a.risk_mode ?? "conservative").toLowerCase() !== "aggressive") {
        const { data, error } = await admin.from("flow_managed_positions")
          .select("symbol, side, outcome, created_at, resolved_at")
          .eq("account_id", aid).eq("symbol", pair.key).eq("strategy_version", GENFX_VERSION).eq("status", "closed").not("outcome", "is", null)
          .gte("resolved_at", new Date(Date.now() - 12 * 3600_000).toISOString()).order("resolved_at", { ascending: false }).limit(200);
        if (error) return skip("ledger_unreadable", "ledger_unreadable (couldn't read this account's recent results)");
        const s = consecutiveLossStreak((data ?? []) as never);
        if (s.streak >= MEMBER_STREAK && Date.now() < s.lastClosedAt + MEMBER_COOLDOWN_MS) return skip("conservative_cooldown", `conservative_cooldown (${s.streak} ${pair.name} losses in a row — 2h)`);
      }

      // ONE TRADE PER PAIR, PER SIDE, PER ACCOUNT — asked three ways, and each has to answer.
      // (a) The ledger: an open position on this pair the same way is a no, at once. The trade manager
      //     closes the row within a minute of the position closing; nothing here second-guesses it.
      const led = await admin.from("flow_managed_positions").select("side").eq("account_id", aid).eq("symbol", pair.key).eq("status", "open");
      if (led.error) return skip("ledger_unreadable", "ledger_unreadable (couldn't read this account's open trades)");
      if (((led.data ?? []) as { side: string | null }[]).some((r) => sameSide(r.side, sig.side))) return skip("one_open", `one_open (already in a ${pair.name} ${sig.side} on this account)`);
      // (b) GEN FX's own orders on this account that are not settled yet — sent and unanswered,
      //     resting, or withdrawn and not yet confirmed dead.
      const [own, pend] = await Promise.all([
        fill().select("status").eq("signal_key", signalKey).eq("account_id", aid).limit(1),
        fill().select("side, status").eq("account_id", aid).eq("pair", pair.key).in("status", UNSETTLED).limit(50),
      ]);
      if (own.error || pend.error) return skip("ledger_unreadable", "ledger_unreadable (couldn't read this account's GEN FX orders)");
      if ((own.data ?? []).length) return 0;                    // this call was already handled on this account
      if (((pend.data ?? []) as { side: string | null }[]).some((r) => sameSide(r.side, sig.side))) return skip("one_open", `one_open (an earlier GEN FX ${pair.name} order on this account is still being confirmed)`);

      const tok = await tokenFor(String(a.connection_id));
      if (!tok) return skip("no_broker_token", "no_broker_token (reconnect your broker)");
      const ref = { env: tok.env, token: tok.token, accNum: String(a.acc_num), accountId: aid, connId: String(a.connection_id) };

      // (c) The broker: a resting entry is exposure too. Scoped to THIS instrument — passing no
      //     instrument would let a resting gold order block a currency trade.
      const instId = await io.instrument(ref, pair.key);
      if (instId == null) {
        const listed = await io.listed(ref);
        return listed
          ? skip("instrument_not_found", `instrument_not_found (this broker does not list ${pair.key})`)
          : skip("broker_unreadable", "broker_unreadable (couldn't load the broker's instruments — the broker may have API trading switched off for this account)");
      }
      // A lot is 100,000 units of the first currency — the sizing rests on it. Where the broker's own
      // instrument list says otherwise, the size would be wrong by that factor, so nothing is placed.
      const lot = io.contract ? await io.contract(ref, pair.key).catch(() => null) : null;
      if (lot != null && lot > 0 && Math.abs(lot - FX_LOT_UNITS) > 0.5) return skip("contract_size", `contract_size (this broker's ${pair.name} lot is ${lot} units; GEN FX sizes for ${FX_LOT_UNITS})`);
      // Can this broker tell GEN FX's orders apart afterwards? Without the label nothing placed here could
      // be followed safely, so nothing is placed.
      const labels = await io.labels(ref);
      if (labels === null) return skip("broker_unreadable", "broker_unreadable (couldn't read this broker's settings)");
      if (!labels) return skip("no_order_labels", "no_order_labels (this broker does not return an order's label, so GEN FX could not tell its own orders from yours)");
      const wsides = await io.restingSides(ref, instId);
      if (wsides === null) return skip("broker_unreadable", "broker_unreadable (couldn't read your orders)");
      if ([...wsides].some((x) => sameSide(x, sig.side))) return skip("one_open", `one_open (resting ${pair.name} order)`);

      // The lock, then the claim. Neither is assumed: no lock or no claim, no order.
      const resv = await reserveFx(admin, aid, pair.key, sig.side, signalKey, 60);
      if (!resv.ok) return resv.reason === "reservation_unavailable"
        ? skip("ledger_unreadable", "ledger_unreadable (couldn't take this account's lock)")
        : skip("one_open", `one_open (${lockWords(pair, sig.side, resv.reason)})`);
      reserved = true;
      // The claim is first looked at by the books pass two minutes from now: by then it has become an
      // order, or it never will. Its time is written by THIS clock, the one the send deadline is read from.
      claimAt = Date.now();
      const ins = await fill().insert({
        signal_key: signalKey, account_id: aid, user_id: uid, connection_id: a.connection_id, acc_num: ref.accNum, environment: tok.env,
        pair: pair.key, side: sig.side, mode: sig.mode, setup: sig.setup, alert_id: sig.alertId ?? null, status: "reserved",
        tag, created_at: new Date(claimAt).toISOString(), next_check_at: new Date(claimAt + CLAIM_DEAD_MS).toISOString(),
      });
      if (ins.error) {
        await undo();
        if ((ins.error as { code?: string }).code !== "23505") return skip("ledger_unreadable", "ledger_unreadable (couldn't record this order before sending it)");
        // Refused by a unique key. Either this very call is already on this account (another pass got
        // there first — nothing to say), or ANOTHER call's unsettled order is: the database's own
        // "one unsettled order per account, pair and side".
        const mine = await fill().select("status").eq("signal_key", signalKey).eq("account_id", aid).limit(1);
        return !mine.error && (mine.data ?? []).length ? 0 : skip("one_open", `one_open (an earlier GEN FX ${pair.name} order on this account is still being confirmed)`);
      }
      claimed = true;

      const live = (await liveFor(String(a.connection_id), tok)).get(aid);
      const equity = live?.equity ?? null;
      if (equity == null || !(equity > 0)) { await undo(); return skip("no_equity", "no_equity (broker did not return this account's size)"); }
      const ccy = String(live?.currency ?? a.currency ?? "").toUpperCase();
      if (ccy !== "USD") { await undo(); return skip("non_usd_account", ccy ? `non_usd_account (GEN FX sizes in dollars; this account is in ${ccy})` : "non_usd_account (couldn't read this account's currency, and GEN FX only sizes dollar accounts)"); }

      // THIS BROKER'S PRICE, NOW. If it cannot be read the feed's stands in — as it does inside the
      // order function — moved by the pair's usual cost so that the size errs small, never large.
      let brokerPx: number | null = null;
      try { brokerPx = await io.quote(ref, pair.key, sig.side); } catch { brokerPx = null; }
      const fillRef = brokerPx != null && brokerPx > 0 ? brokerPx : px(pair, sig.side === "buy" ? sizeEntry + pair.costPips * pair.pip : sizeEntry - pair.costPips * pair.pip);
      // The call passed these three on the feed's price; an account whose own price fails them sits out.
      if (sig.side === "buy" ? fillRef <= stop : fillRef >= stop) { await undo(); return skip("through_stop", "through_stop (this broker's price is already through the stop)"); }
      const wide = stopWideEnough(pair, fillRef, stop, mkt.minStopPips);
      if (!wide.ok) { await undo(); return skip("stop_too_tight", `stop_too_tight (the stop is ${wide.pips} pips from this broker's price — under the ${mkt.minStopPips}-pip minimum)`); }
      if (chasedAt(sig.side, stop, tp, fillRef)) { await undo(); return skip("chased", "chased (this broker's price is past the 0.8-to-1 floor)"); }

      const riskPct = typeof a.risk_pct === "number" && a.risk_pct > 0 ? a.risk_pct : await riskFor(uid);
      const s = sizeFx(pair, { entry: fillRef, stop, equity, riskPct, usdJpy, limits: ctl.config });
      if (!s.ok) {
        await undo();
        const why = s.reason === "min_lot_over_risk" ? `the smallest ${pair.name} order would risk $${s.estLossAtStop} on this stop — over ${ctl.config.maxMinLotRiskPct}% of this account`
          : s.reason === "min_lot_over_leverage" ? `the smallest ${pair.name} order is worth more than ${ctl.config.maxLeverage} times this account`
            : "this account could not be sized for this trade";
        return skip(`size_${s.reason}`, `${s.reason} (${why})`);
      }
      ready = { ref, fillRef, lots: s.lots, riskPct: s.riskPct, lossPerLot: s.estLossAtStop / s.lots };
    } catch (e) {
      await undo();
      return skip("broker_unreadable", `broker_unreadable (${words(e)})`);
    }

    /* ── 2. The order. What is about to be sent is written down first; from that write on, anything
     *       that goes wrong is "it may have filled", and the row says so until the broker settles it. ── */
    const { ref, fillRef } = ready;
    const maxEntry = maxEntryFor(pair, sig.side, fillRef, stop);
    const estLoss = (q: number) => +(q * ready.lossPerLot).toFixed(2);
    /**
     * Write down what is about to be sent, and prove the row took it. The update only matches the row
     * in the state this pass left it in: if the sweep wrote the claim off in the meantime (a pass that
     * stalled for minutes), nothing matches, and no order is sent on a claim that is no longer held.
     */
    const remember = async (qty: number, from: "reserved" | "sending"): Promise<boolean> => {
      try {
        const { data, error } = await fill().update({ status: "sending", qty, entry: fillRef, stop, tp, risk_pct: ready.riskPct, est_loss: estLoss(qty), updated_at: new Date().toISOString() })
          .eq("signal_key", signalKey).eq("account_id", aid).eq("status", from).select("account_id");
        return !error && Array.isArray(data) && data.length === 1;
      } catch { return false; }
    };
    /**
     * Write what became of the send onto the row — "placed" with the broker's ids, or "uncertain" — and
     * prove the row took it. Only a row still as this pass left it is written ("sending", or "uncertain"
     * from an earlier attempt of this same call).
     *   "written"  the row took it.
     *   "pending"  the write failed, or the row is still as it was: it reads "sending", which the books
     *              pass treats exactly as a send that threw — it finds the order by its label.
     *   "moved"    the books pass has been here already and is following it.
     *   "closed"   the row had been WRITTEN OFF (or is gone) while the send was out, and could not be
     *              brought back — its slot has been taken by another call. The one case that is not safe
     *              to leave; the caller raises the alarm.
     */
    const record = async (row: Record<string, unknown>): Promise<"written" | "pending" | "moved" | "closed"> => {
      /** Rows this write reached: 1, 0 (the row is no longer as this pass left it), or null (the write failed). */
      const write = async (from: string[]): Promise<number | null> => {
        try {
          const { data, error } = await fill().update(row).eq("signal_key", signalKey).eq("account_id", aid).in("status", from).select("account_id");
          return error || !Array.isArray(data) ? null : data.length;
        } catch { return null; }
      };
      let wrote = await write(["sending", "uncertain"]);
      if (wrote === null) wrote = await write(["sending", "uncertain"]);            // once more: a dropped connection is not an answer
      if (wrote === 1) return "written";
      let now: string | null = null;
      try { const cur = await fill().select("status").eq("signal_key", signalKey).eq("account_id", aid).limit(1); now = cur.error ? null : String(((cur.data ?? []) as { status?: string }[])[0]?.status ?? "gone"); } catch { now = null; }
      if (now === "void" || now === "gone") return now === "void" && (await write(["void"])) === 1 ? "written" : "closed";
      return now === null || now === "sending" || now === "uncertain" ? "pending" : "moved";
    };
    // ONE deadline for everything this call sends, counted from its claim.
    const notAfterMs = claimAt + SEND_DEADLINE_MS;
    const send = (qty: number) => io.send({ userId: uid, ref, pair: pair.key, side: sig.side, qty, stop, tp, maxEntry, tag, notAfterMs });

    let qty = ready.lots;
    // The switches, once more, a moment before the order: a fan-out takes seconds, and "off" has to mean
    // off for the accounts it has not reached yet.
    const still = await stillOn(a);
    if (still !== "on") { await undo(); return skip("switched_off", `switched_off (${still})`); }
    if (!(await remember(qty, "reserved"))) { await undo(); return skip("ledger_unreadable", "ledger_unreadable (couldn't record this order before sending it)"); }

    let r: Sent;
    let attempts = 0;         // sends that came back with the broker's refusal in words: nothing of them is on the account
    try {
      r = await send(qty);
      // The broker refused the size for margin: take the minimum instead of sitting out (the desk's own rule).
      if (!r.ok && !r.deferred && /margin/i.test(r.reason) && qty > 0.011) {
        attempts = 1;
        qty = 0.01;
        if (await remember(qty, "sending")) r = await send(qty);
      }
    } catch (e) {
      // THROWN BEFORE ANY ORDER WAS ATTEMPTED (the order function marks it): a quote that timed out, an
      // instrument list that could not be read. Nothing left this desk, so the account simply sits out.
      if ((e as { noOrderSent?: boolean } | null)?.noOrderSent === true) {
        await undo();
        return skip("broker_unreadable", `broker_unreadable (${words(e)}${attempts ? " — after the broker refused the first size" : ""})`);
      }
      // AN ORDER THAT THREW MAY HAVE FILLED. The lock is held as unknown, the row stays (with the size
      // and levels written above) so this account takes nothing else the same way. The books pass asks
      // the broker what happened — it finds the order by its label.
      // (If the status write itself fails the row is still "sending", which the books pass treats the same way.)
      await markFx(admin, aid, resvKey, "unknown");
      const doubt = await record({ status: "uncertain", clean: 0, next_check_at: new Date().toISOString(), updated_at: new Date().toISOString() });
      if (doubt === "closed") {
        // The row had been written off while the send was out, and could not be brought back: if the
        // order did reach the broker, nothing is following it. (It cannot happen while the send deadline
        // holds; this is the guard for the day something is slower than it can be.)
        await event({ status: "error", qty, entry: fillRef, stop, tp, reason: "genfx: AN ORDER WHOSE OUTCOME IS UNKNOWN WAS SENT AFTER ITS RECORD HAD BEEN CLOSED — if it reached the broker it is NOT being followed. CHECK THIS ACCOUNT".slice(0, 200) });
        await desk(`an order on account ${aid} whose outcome is unknown was sent after its record had been closed — NOT being followed`, "error");
        count("unfollowed");
        return 0;
      }
      await event({ status: "uncertain", qty, entry: fillRef, stop, tp, reason: `genfx: order outcome unknown — being checked with the broker (${words(e)})`.slice(0, 200) });
      count("uncertain");
      return 0;
    }
    if (!r.ok) {
      // A refusal the broker put in words: nothing is on the account.
      await undo();
      count(r.deferred ? "session_closed" : /entry_deadline_passed/.test(r.reason) ? "too_late" : "broker_rejected");
      return 0;   // placeFixedLotFollower already logged the broker's words on this account
    }

    /* ── 3. The broker has the order. That fact is written to the row, and the row is what the books
     *       pass works from: within seconds it reads the broker's own record of the order, and — once
     *       that says it executed, and the position it names is this order's alone — puts the position
     *       in the ledger for the trade manager. Placement writes no ledger row itself. ── */
    const sentQty = r.qty, orderId = r.orderId, positionId = r.positionId;
    await markFx(admin, aid, resvKey, "active", orderId, positionId);
    const took = await record({ status: "placed", order_id: orderId, position_id: positionId, qty: sentQty, est_loss: estLoss(sentQty), clean: 0, next_check_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    if (took === "closed") {
      await event({ status: "error", qty: sentQty, entry: fillRef, stop, tp, order_id: orderId, reason: `genfx: ORDER ${orderId ?? "?"} WAS ACCEPTED AFTER ITS RECORD HAD BEEN CLOSED — it is on the account and is NOT being followed. CHECK THIS ACCOUNT`.slice(0, 200) });
      await desk(`order ${orderId ?? "?"} on account ${aid} was accepted after its record had been closed — NOT being followed`, "error");
      count("unfollowed");
    } else if (took === "pending") {
      await event({ status: "placed", qty: sentQty, entry: fillRef, stop, tp, order_id: orderId, reason: "genfx: accepted — its record is pending" });
    }
    if (ctl.billing) { try { await chargeFxFire(admin, uid, signalKey, gate); } catch { /* billing never undoes a fill */ } }
    return 1;
  };

  // Separate logins go out together; accounts under ONE login go one after another, as gold's do — the
  // broker's limits are per login, and two orders racing on one credential is how one of them is refused.
  // An account's pass never throws by design; if one ever does, it must not take the others' orders down with it.
  const byLogin = new Map<string, ArmedAccount[]>();
  for (const a of accts) { const k = String(a.login ?? a.connection_id); const g = byLogin.get(k); if (g) g.push(a); else byLogin.set(k, [a]); }
  const results = await mapPool([...byLogin.values()], FANOUT, async (group) => {
    let n = 0;
    for (const a of group) n += await one(a).catch(() => { skipped.error = (skipped.error ?? 0) + 1; return 0; });
    return n;
  });
  const placed = results.reduce((n, x) => n + (x || 0), 0);
  const parts = Object.entries(skipped).map(([k, n]) => `${k} ${n}`).join(", ");
  await desk(`fanout ${loaded} armed → ${placed} placed${parts ? ` (${parts})` : ""} · ${sig.mode} ${sig.setup} · stop ${v.stopPips}p`, "fanout");
  return report(true, "ok", accts.length, placed, skipped);
}
