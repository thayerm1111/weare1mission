import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import { PAIRS, PAIR_KEYS, type PairKey } from "@/lib/fxscalper/pairs";
import { settingsBlockers, DEFAULT_SETTINGS, type Settings } from "@/lib/fxscalper/settings";
import { evaluate, M1_MS, type Bar, type Evaluation } from "@/lib/fxscalper/strategy";
import type { InstrumentSpec } from "@/lib/fxscalper/plan";
import { convert, type Rates } from "@/lib/fxscalper/money";
import { entryBlackout, fxDayKey, fxDayStart } from "@/lib/fxscalper/clock";
import { lossStreak, streakPauseUntil, tradePnl } from "@/lib/fxscalper/risk";
import { open as unseal, seal } from "@/lib/fxscalper/crypto";
import type { ControlRow, TradeRow } from "@/lib/fxscalper/store";
import { Scheduler, P, type Priority } from "@/lib/fxscalper/tl/transport";
import {
  allAccounts, columnsFrom, getConfig, getHistory, getInstrumentDetails, getInstruments, getOrders, getPositions,
  getQuote, getState, getTradeAccounts, refreshTokens, signIn,
  type AccountState, type BrokerQuote, type Columns, type Conn, type Order, type Position, type TradeAccount,
} from "@/lib/fxscalper/tl/api";
import { resolveSymbol, specFrom } from "@/lib/fxscalper/tl/discover";
import { supabaseStore, type DayRow, type WorkerStore } from "./db";

/**
 * THE FX SCALPER WORKER'S STATE AND PLUMBING — lease, control, broker session, market data, account
 * data and the dashboard snapshot. The trading decisions live in trading.ts and operate on this.
 *
 * One process, one lease. Everything the bot knows about money is read from the broker; everything it
 * decides is written to the database before it acts.
 */

export const LEASE_TTL_MS = 15_000;
const TOKEN_MARGIN_MS = 120_000;
const TOKEN_REUSE_MS = 10 * 60_000;
const HISTORY_DAYS = 5;
const MAX_BARS = 3000;
export const TAG_PREFIX = "OMFX-";

/** The charges a trade was planned with (kept on its row), falling back to the current settings. */
export function chargesOf(t: TradeRow, s: Settings): { commissionPerLotPerSide: number; otherRtPerLot: number } {
  const plan = (t.plan ?? {}) as { commissionRtPerLot?: unknown; otherRtPerLot?: unknown };
  const rt = Number(plan.commissionRtPerLot);
  const other = Number(plan.otherRtPerLot);
  return {
    commissionPerLotPerSide: Number.isFinite(rt) ? rt / 2 : s.costs.commissionPerLotPerSide ?? 0,
    otherRtPerLot: Number.isFinite(other) ? other : s.costs.otherChargesPerLotRoundTrip,
  };
}

export type PairState = {
  key: PairKey;
  spec: InstrumentSpec | null;
  problem: string | null;
  candidates: string[];
  notes: string[];
  symbolStatus: string | null;
  bars: Bar[];
  initialised: boolean;
  evaluatedT: number | null;
  eval: Evaluation | null;
  decision: { at: number; code: string; text: string } | null;
  quote: (BrokerQuote & { changedAt: number }) | null;
  revisions: number;
  barLagMs: number | null;
};

export type Session = {
  connectionId: string;
  server: string;
  emailMasked: string;
  accessToken: string | null;
  refreshToken: string;
  expiresAt: number | null;
  lastAuthAt: number | null;
  status: "connected" | "reconnect_required" | "error";
  error: string | null;
  accountId: string;
  accNum: string;
  currency: string | null;
  label: string | null;
  columns: Columns | null;
  columnsMissing: string[];
  rateLimits: Record<string, string>;
  dataLimits: Record<string, number>;
  brokerAccount: TradeAccount | null;
  ready: boolean;
};

type Job = { name: string; everyMs: () => number; nextAt: number; running: boolean; fn: () => Promise<void> };

export class Bot {
  constructor(readonly store: WorkerStore = supabaseStore()) {}

  readonly owner = `${hostname()}:${process.pid}:${randomBytes(3).toString("hex")}`;
  readonly startedAt = Date.now();
  readonly sched = new Scheduler({ maxInFlight: 4 });
  fence: number | null = null;
  leaseValidUntil = 0;
  stopping = false;

  control: ControlRow | null = null;
  settings: Settings = DEFAULT_SETTINGS;
  settingsVersion = 0;
  settingsWarnings: string[] = [];

  session: Session | null = null;
  sessionKey: string | null = null;
  pairs = new Map<PairKey, PairState>(PAIR_KEYS.map((k) => [k, Bot.emptyPair(k)]));

  state: AccountState | null = null;
  stateAt = 0;
  positions: Position[] | null = null;
  positionsAt = 0;
  orders: Order[] | null = null;
  ordersAt = 0;
  foreignSpecs = new Map<string, { lotSize: number; quote: string } | { unknownAt: number }>();
  excludedPaid = 0;

  trades = new Map<string, TradeRow>();
  inEntry = new Set<string>();
  closedRecent: TradeRow[] = [];
  dayKey: string | null = null;
  day: DayRow | null = null;
  dayRealized = 0;
  observedSlipPips: number | null = null;
  reconciled = false;
  reconcileNote = "not yet reconciled";
  qtyCheck: { state: "unverified" | "verified" | "contradicted"; detail: string } = { state: "unverified", detail: "No fill has been checked yet." };
  ordersToday = 0;
  protectionAlarm: string | null = null;
  /** Why every bot position is being closed (owner close-all, emergency, daily limit), or null. Persisted. */
  closeAllReason: string | null = null;
  /** When the day's figures (loss streak, daily loss) were last read successfully. Entries need them fresh. */
  dayFreshAt = 0;
  errors: Array<{ at: number; where: string; message: string }> = [];
  private jobs: Job[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private positionsFlight: Promise<Position[] | null> | null = null;
  private ordersFlight: Promise<Order[] | null> | null = null;
  private tokenFlight: Promise<boolean> | null = null;
  private entryChain: Promise<void> = Promise.resolve();
  private lastEventAt = new Map<string, number>();

  static emptyPair(k: PairKey): PairState {
    return { key: k, spec: null, problem: "not discovered yet", candidates: [], notes: [], symbolStatus: null, bars: [], initialised: false, evaluatedT: null, eval: null, decision: null, quote: null, revisions: 0, barLagMs: null };
  }

  // ---- Small helpers ---------------------------------------------------------------------------------

  /** May this process write to the broker right now? Only while its lease is comfortably valid. */
  leaseOk(marginMs = 2000): boolean {
    return this.fence != null && Date.now() + marginMs < this.leaseValidUntil && !this.stopping;
  }

  conn(): Conn | null {
    const s = this.session;
    if (!s || !s.accessToken) return null;
    return { env: "live", sched: this.sched, accessToken: s.accessToken, accountId: s.accountId, accNum: s.accNum };
  }

  rates(): Rates {
    const r: Rates = {};
    for (const [k, p] of this.pairs) if (p.quote) r[k] = { bid: p.quote.bid, ask: p.quote.ask };
    return r;
  }

  noteError(where: string, e: unknown): void {
    const message = e instanceof Error ? e.message : String(e);
    this.errors.unshift({ at: Date.now(), where, message: message.slice(0, 300) });
    if (this.errors.length > 25) this.errors.length = 25;
    void this.event("error", "worker_error", `${where}: ${message}`, {}, null, null, `err:${where}:${message.slice(0, 60)}`, 60_000);
  }

  /**
   * Journal line. Never waited on: a slow or hung journal write must not delay anything that matters
   * (the store bounds it and swallows its failure). `dedupeKey` + `everyMs` keep a repeating condition
   * from flooding the journal.
   */
  async event(level: "info" | "warn" | "error", kind: string, message: string, data: Record<string, unknown> = {}, pair: string | null = null, tradeId: string | null = null, dedupeKey?: string, everyMs = 0): Promise<void> {
    if (dedupeKey) {
      const last = this.lastEventAt.get(dedupeKey) ?? 0;
      if (Date.now() - last < everyMs) return;
      this.lastEventAt.set(dedupeKey, Date.now());
    }
    void this.store.event({ level, kind, message, pair, tradeId, data }).catch(() => undefined);
  }

  /** Entries one at a time, so each decision sees the exposure the previous one created. */
  exclusive(fn: () => Promise<void>): Promise<void> {
    const next = this.entryChain.then(fn, fn);
    this.entryChain = next.catch(() => undefined);
    return next;
  }

  // ---- Lease -----------------------------------------------------------------------------------------

  async takeLease(): Promise<boolean> {
    const started = Date.now();
    const r = await this.store.acquireLease(this.owner, LEASE_TTL_MS);
    if (!r.acquired) return false;
    this.fence = r.fence;
    // Measured from BEFORE the call: the database's clock started the lease no later than that.
    this.leaseValidUntil = started + LEASE_TTL_MS - 1000;
    return true;
  }

  private async renewLease(): Promise<void> {
    if (this.fence == null) return;
    const started = Date.now();
    const held = await this.store.extendLease(this.owner, this.fence, LEASE_TTL_MS);
    if (held === true) { this.leaseValidUntil = started + LEASE_TTL_MS - 1000; return; }
    if (held === false) {
      // Another worker commands the account now. Stop at once; Railway restarts this process, which
      // then waits for the lease like any new one.
      await this.event("error", "lease_lost", "This worker lost the lease to another one and is stopping.");
      this.stopping = true;
      setTimeout(() => process.exit(1), 500);
    }
    // null: the database could not answer. The lease may still be ours; leaseOk() stops broker writes
    // once its known validity runs out.
  }

  // ---- Control and settings ----------------------------------------------------------------------------

  private async loadControl(): Promise<void> {
    const before = this.control;
    this.control = await this.store.readControl();
    // The owner pressing Resume (or START LIVE) after a safety pause acknowledges the alarm behind it.
    if (before && before.entries_paused && !this.control.entries_paused && this.control.updated_by) this.protectionAlarm = null;
    if (before && before.mode === "stopped" && this.control.mode === "live") this.protectionAlarm = null;
    const s = await this.store.readSettings();
    if (s.version !== this.settingsVersion) {
      const overridesChanged = JSON.stringify(s.settings.symbolOverrides) !== JSON.stringify(this.settings.symbolOverrides);
      this.settings = s.settings;
      this.settingsVersion = s.version;
      this.settingsWarnings = s.warnings;
      if (overridesChanged && this.session?.ready) void this.discover().catch((e) => this.noteError("discover", e));
    }
    const c = this.control;
    if (c.close_all_reason && !this.closeAllReason) this.closeAllReason = c.close_all_reason;
    // Auto-resume a pause that was set to end (the daily loss limit resets at the next 17:00 New York).
    if (c.entries_paused && c.pause_until && Date.parse(c.pause_until) <= Date.now() && this.leaseOk()) {
      const r = await this.store.updateControl({ entries_paused: false, pause_reason: null, pause_until: null }, null, c.version);
      if (r.ok) await this.event("info", "auto_resume", `New entries resumed: ${c.pause_reason ?? "the pause"} ended.`);
    }
    const key = c.connection_id && c.account_id && c.acc_num ? `${c.connection_id}:${c.account_id}:${c.acc_num}` : null;
    if (key !== this.sessionKey) {
      this.sessionKey = key;
      this.session = null;
      this.reconciled = false;
      this.positions = null;
      this.orders = null;
      this.state = null;
      this.pairs = new Map(PAIR_KEYS.map((k) => [k, Bot.emptyPair(k)]));
      if (key) await this.openSession();
    }
  }

  /**
   * Pause new entries for a reason (the worker's own safety brakes). A pause that is already open-ended
   * (the owner's own, or a safety stop) is never turned into one that resumes by itself; a timed pause
   * is only ever lengthened or made open-ended.
   */
  async pauseEntries(reason: string, untilMs: number | null = null): Promise<void> {
    // Decided on the row as it is NOW, and written only if it is still that row: an owner's Pause that
    // lands a moment earlier is never turned into a pause that resumes by itself.
    for (let attempt = 0; attempt < 3; attempt++) {
      const c = await this.store.readControl();
      this.control = c;
      let patch: Partial<ControlRow>;
      if (!c.entries_paused) patch = { entries_paused: true, pause_reason: reason, pause_until: untilMs ? new Date(untilMs).toISOString() : null };
      else if (!c.pause_until) {
        await this.event("warn", "entries_paused", `New entries were already paused (${c.pause_reason ?? "paused"}); also: ${reason}.`);
        return;
      } else if (untilMs == null) patch = { pause_reason: reason, pause_until: null };
      else if (untilMs > Date.parse(c.pause_until)) patch = { pause_reason: reason, pause_until: new Date(untilMs).toISOString() };
      else return;
      const r = await this.store.updateControl(patch, null, c.version);
      if (r.ok) {
        this.control = { ...c, ...patch, version: r.version ?? c.version };
        await this.event("warn", "entries_paused", `New entries paused: ${reason}`);
        return;
      }
    }
    await this.event("error", "pause_failed", `Could not record the pause (${reason}); the control row kept changing.`);
  }

  /** Close every bot position for this reason, and remember it across a restart. */
  async setCloseAll(reason: string): Promise<void> {
    if (this.closeAllReason === reason) return;
    this.closeAllReason = reason;
    await this.store.updateControl({ close_all_reason: reason, close_all_at: new Date(Date.now()).toISOString() }, null).catch(() => undefined);
  }

  async clearCloseAll(): Promise<void> {
    if (!this.closeAllReason && !this.control?.close_all_reason) return;
    this.closeAllReason = null;
    const r = await this.store.updateControl({ close_all_reason: null, close_all_at: null }, null).catch(() => null);
    if (r?.ok && this.control) this.control = { ...this.control, close_all_reason: null, close_all_at: null };
  }

  // ---- Broker session ----------------------------------------------------------------------------------

  private async openSession(): Promise<void> {
    const c = this.control!;
    const row = await this.store.readConnection(c.connection_id!);
    if (!row || row.status === "revoked") {
      this.session = null;
      return;
    }
    let refresh: string;
    let access: string | null = null;
    try {
      refresh = unseal(row.enc_refresh);
      access = row.enc_access ? unseal(row.enc_access) : null;
    } catch {
      await this.store.saveConnection(row.id, { status: "reconnect_required", last_error: "the stored credentials could not be decrypted (encryption key changed?)" });
      await this.event("error", "credentials_unreadable", "The stored broker credentials could not be decrypted. Reconnect the account on the dashboard.");
      return;
    }
    this.session = {
      connectionId: row.id, server: row.server, emailMasked: row.email_masked,
      accessToken: access, refreshToken: refresh, expiresAt: row.access_expires_at ? Date.parse(row.access_expires_at) : null,
      lastAuthAt: row.last_auth_at ? Date.parse(row.last_auth_at) : null,
      status: row.status === "connected" ? "connected" : "reconnect_required", error: row.last_error,
      accountId: c.account_id!, accNum: c.acc_num!, currency: c.account_currency, label: c.account_label,
      columns: null, columnsMissing: [], rateLimits: {}, dataLimits: {}, brokerAccount: null, ready: false,
    };
    await this.event("info", "session", `Opening the broker session for account ${c.account_label ?? c.acc_num}.`);
  }

  /** After the owner reconnects on the dashboard (the connection row is "connected" again), pick it up. */
  async pickUpReconnect(): Promise<void> {
    const s = this.session;
    if (!s || s.status !== "reconnect_required") return;
    const row = await this.store.readConnection(s.connectionId);
    if (!row || row.status !== "connected") return;
    try {
      s.refreshToken = unseal(row.enc_refresh);
      s.accessToken = row.enc_access ? unseal(row.enc_access) : null;
    } catch {
      return;
    }
    s.expiresAt = row.access_expires_at ? Date.parse(row.access_expires_at) : null;
    s.lastAuthAt = row.last_auth_at ? Date.parse(row.last_auth_at) : null;
    s.status = "connected";
    s.error = null;
    await this.event("info", "reconnected", "The broker session was renewed from the dashboard; the worker carries on.");
  }

  /** A usable access token, refreshing (or signing in again, if allowed) when it is near expiry. */
  ensureToken(force = false): Promise<boolean> {
    if (this.tokenFlight) return this.tokenFlight;
    this.tokenFlight = this.mintToken(force).finally(() => { this.tokenFlight = null; });
    return this.tokenFlight;
  }

  private async mintToken(force: boolean): Promise<boolean> {
    const s = this.session;
    if (!s || s.status === "reconnect_required") return false;
    const fresh = s.accessToken && !force && (s.expiresAt != null ? s.expiresAt - Date.now() > TOKEN_MARGIN_MS : s.lastAuthAt != null && Date.now() - s.lastAuthAt < TOKEN_REUSE_MS);
    if (fresh) return true;
    const r = await refreshTokens(this.sched, "live", s.refreshToken);
    if (r.ok) {
      await this.saveTokens(r.data.accessToken, r.data.refreshToken, r.data.expiresAt);
      return true;
    }
    if (r.status === 0 || r.limited || r.status >= 500) {
      s.error = r.error;
      return Boolean(s.accessToken && s.expiresAt && s.expiresAt > Date.now());
    }
    // The refresh token itself was refused. If the owner has just renewed the session on the dashboard,
    // the row holds newer tokens: use them. Otherwise sign in again if the owner allowed it.
    const row = await this.store.readConnection(s.connectionId);
    if (row && row.status === "connected" && row.last_auth_at && Date.parse(row.last_auth_at) > (s.lastAuthAt ?? 0)) {
      try {
        s.refreshToken = unseal(row.enc_refresh);
        s.accessToken = row.enc_access ? unseal(row.enc_access) : null;
        s.expiresAt = row.access_expires_at ? Date.parse(row.access_expires_at) : null;
        s.lastAuthAt = Date.parse(row.last_auth_at);
        s.error = null;
        return true;
      } catch {
        /* fall through */
      }
    }
    if (row?.enc_email && row.enc_password) {
      try {
        const a = await signIn(this.sched, "live", unseal(row.enc_email), unseal(row.enc_password), s.server);
        if (a.ok) {
          await this.saveTokens(a.data.accessToken, a.data.refreshToken, a.data.expiresAt);
          await this.event("info", "signed_in_again", "The broker session ended; the worker signed in again with the stored credentials.");
          return true;
        }
        s.error = a.error;
      } catch (e) {
        s.error = (e as Error).message;
      }
    }
    s.status = "reconnect_required";
    await this.store.saveConnection(s.connectionId, { status: "reconnect_required", last_error: s.error ?? r.error });
    await this.event("error", "reconnect_required", `The broker session could not be renewed (${s.error ?? r.error}). New entries are blocked; reconnect on the dashboard. Open positions keep their broker-side stop and target.`);
    return false;
  }

  private async saveTokens(access: string, refresh: string, expiresAt: number | null): Promise<void> {
    const s = this.session!;
    s.accessToken = access;
    s.refreshToken = refresh;
    s.expiresAt = expiresAt;
    s.lastAuthAt = Date.now();
    s.status = "connected";
    s.error = null;
    await this.store.saveConnection(s.connectionId, {
      enc_access: seal(access), enc_refresh: seal(refresh), access_expires_at: expiresAt ? new Date(expiresAt).toISOString() : null,
      last_auth_at: new Date().toISOString(), status: "connected", last_error: null,
    });
  }

  /** Config, account rules, the seven pairs, their history. Runs once per session, then refreshes. */
  async prepareSession(): Promise<void> {
    const s = this.session;
    if (!s || s.ready) return;
    if (!(await this.ensureToken())) return;
    const c = this.conn()!;
    // The account must still be on this login.
    const accts = await allAccounts(this.sched, "live", c.accessToken);
    if (accts.ok) {
      const mine = accts.data.find((a) => a.accountId === s.accountId && a.accNum === s.accNum);
      if (!mine) { s.error = "The selected account is no longer on this broker login."; return; }
      s.currency = mine.currency ?? s.currency;
    } else if (accts.unauthorized) { await this.ensureToken(true); return; }
    const cfg = await getConfig(c);
    if (!cfg.ok) { s.error = cfg.error; return; }
    s.rateLimits = this.sched.applyConfig(cfg.data);
    const { columns, missing } = columnsFrom(cfg.data);
    s.columns = columns;
    s.columnsMissing = missing;
    const limits = (cfg.data.limits ?? []) as unknown;
    if (Array.isArray(limits)) for (const l of limits as Array<{ limitType?: string; limit?: number }>) if (l?.limitType) s.dataLimits[l.limitType] = Number(l.limit);
    await this.refreshTradeAccount();
    await this.discover();
    // Ready to MANAGE as soon as the contracts are known: open positions are not kept waiting for five
    // days of candles. The candles load next, in the background; entries wait for them (warm-up).
    s.ready = true;
    s.error = null;
    await this.event("info", "session_ready", `Broker session ready: ${[...this.pairs.values()].filter((p) => p.spec).length} of 7 pairs tradable on this account.`, { rateLimits: s.rateLimits, columnsMissing: missing });
    void this.initAllHistory();
  }

  private async initAllHistory(): Promise<void> {
    for (const ps of this.pairs.values()) {
      if (ps.spec && !ps.initialised) await this.initHistory(ps.key).catch((e) => this.noteError(`history ${ps.key}`, e));
    }
  }

  /** A pair with a bot trade in flight or open keeps its last known contract whatever discovery says. */
  private pairBusy(k: PairKey): boolean {
    return [...this.trades.values()].some((t) => t.pair === k);
  }

  async refreshTradeAccount(): Promise<void> {
    const c = this.conn();
    const s = this.session;
    if (!c || !s) return;
    const r = await getTradeAccounts(c);
    if (r.ok) s.brokerAccount = r.data.find((a) => a.accountId === s.accountId || a.accNum === s.accNum) ?? null;
  }

  /** Find the seven pairs on this account and load their contract details. */
  async discover(): Promise<void> {
    const c = this.conn();
    const s = this.session;
    if (!c || !s) return;
    const list = await getInstruments(c);
    if (!list.ok) { s.error = list.error; return; }
    for (const k of PAIR_KEYS) {
      const ps = this.pairs.get(k)!;
      const found = resolveSymbol(list.data, k, this.settings.symbolOverrides[k] ?? null);
      ps.candidates = found.candidates;
      const keep = ps.spec != null && this.pairBusy(k);
      if (!found.ok) {
        if (!keep) ps.spec = null;
        ps.problem = keep ? `${found.reason} (keeping the last known contract while a bot trade is open)` : found.reason;
        await this.store.saveInstrument({ pair: k, account_id: s.accountId, acc_num: s.accNum, status: ps.spec ? "ready" : "blocked", problem: ps.problem, candidates: found.candidates });
        continue;
      }
      const row = found.row;
      if (!row.tradeRouteId || !row.infoRouteIds.length) {
        if (!keep) ps.spec = null;
        ps.problem = "the instrument has no TRADE or INFO route";
        await this.store.saveInstrument({ pair: k, account_id: s.accountId, acc_num: s.accNum, status: ps.spec ? "ready" : "blocked", problem: ps.problem, broker_symbol: row.name, candidates: found.candidates });
        continue;
      }
      // Some accounts list more than one INFO route and the first may not answer quotes: probe in order.
      let info: string | null = null;
      for (const id of row.infoRouteIds) {
        const q = await getQuote(c, row.tradableInstrumentId, id, P.BACKGROUND);
        if (q.ok) { info = id; this.setQuote(k, q.data); break; }
      }
      const det = await getInstrumentDetails(c, row.tradableInstrumentId, info ?? row.tradeRouteId);
      // A failed request is not a changed contract: the same instrument keeps what was known about it.
      const sameInstrument = ps.spec != null && ps.spec.tradableInstrumentId === row.tradableInstrumentId;
      if ((!det.ok || !info) && sameInstrument) {
        ps.notes = [...ps.notes.filter((n) => !n.startsWith("Last refresh failed")), `Last refresh failed (${det.ok ? "no quote" : det.error}); keeping the known contract.`];
        continue;
      }
      const details = det.ok ? det.data : {};
      const spec = specFrom(k, row, details, info);
      ps.symbolStatus = details.symbolStatus ? String(details.symbolStatus) : ps.symbolStatus;
      if (!spec.ok) {
        if (!keep) ps.spec = null;
        ps.problem = `${row.name}: ${spec.problems.join("; ")}${det.ok ? "" : ` (${det.error})`}`;
        ps.notes = [];
      } else {
        // A different instrument (the owner chose another symbol): its candles start from scratch.
        if (ps.spec && ps.spec.tradableInstrumentId !== spec.spec.tradableInstrumentId) {
          ps.bars = [];
          ps.initialised = false;
          ps.evaluatedT = null;
          ps.eval = null;
        }
        ps.spec = spec.spec;
        ps.problem = null;
        ps.notes = spec.notes;
      }
      await this.store.saveInstrument({
        pair: k, account_id: s.accountId, acc_num: s.accNum, status: ps.spec ? "ready" : "blocked", problem: ps.problem,
        broker_symbol: row.name, candidates: found.candidates, tradable_instrument_id: row.tradableInstrumentId,
        trade_route_id: row.tradeRouteId, info_route_id: info, lot_size: spec.ok ? spec.spec.lotSize : spec.partial.lotSize ?? null,
        lot_step: spec.ok ? spec.spec.lotStep : spec.partial.lotStep ?? null, min_lot: spec.ok ? spec.spec.minLot : spec.partial.minLot ?? null,
        max_lot: spec.ok ? spec.spec.maxLot : spec.partial.maxLot ?? null, tick_size: spec.ok ? spec.spec.tickSize : spec.partial.tickSize ?? null,
        pip_size: PAIRS[k].pip, price_decimals: spec.ok ? spec.spec.decimals : null, bar_source: spec.ok ? spec.spec.barSource : spec.partial.barSource ?? null,
        quoting_currency: spec.ok ? spec.spec.quote : spec.partial.quote ?? null, base_currency: spec.ok ? spec.spec.base : spec.partial.base ?? null,
        leverage: spec.ok ? spec.spec.leverage : spec.partial.leverage ?? null, symbol_status: ps.symbolStatus,
        trade_session_id: details.tradeSessionId != null ? String(details.tradeSessionId) : null,
        session_status_id: details.tradeSessionStatusId != null ? String(details.tradeSessionStatusId) : null, raw: details,
      });
    }
  }

  /** Re-read each pair's market status (FULLY_OPEN, CLOSED, TRADING_HALT). */
  async refreshSymbolStatus(): Promise<void> {
    const c = this.conn();
    if (!c) return;
    for (const ps of this.pairs.values()) {
      if (!ps.spec) continue;
      const d = await getInstrumentDetails(c, ps.spec.tradableInstrumentId, ps.spec.infoRouteId);
      if (d.ok) ps.symbolStatus = d.data.symbolStatus ? String(d.data.symbolStatus) : ps.symbolStatus;
    }
  }

  // ---- Market data -----------------------------------------------------------------------------------

  setQuote(k: PairKey, q: BrokerQuote): void {
    const ps = this.pairs.get(k)!;
    const changed = !ps.quote || ps.quote.bid !== q.bid || ps.quote.ask !== q.ask;
    ps.quote = { ...q, changedAt: changed ? q.receivedAt : ps.quote!.changedAt };
  }

  async fetchQuote(k: PairKey, priority: Priority, deadlineAt: number | null = null): Promise<BrokerQuote | null> {
    const c = this.conn();
    const ps = this.pairs.get(k)!;
    if (!c || !ps.spec) return null;
    const q = await getQuote(c, ps.spec.tradableInstrumentId, ps.spec.infoRouteId, priority, deadlineAt);
    if (!q.ok) {
      if (q.unauthorized) void this.ensureToken(true);
      return null;
    }
    this.setQuote(k, q.data);
    return q.data;
  }

  private async initHistory(k: PairKey): Promise<void> {
    const c = this.conn();
    const ps = this.pairs.get(k)!;
    if (!c || !ps.spec) return;
    const now = Date.now();
    const r = await getHistory(c, ps.spec.tradableInstrumentId, ps.spec.infoRouteId, "1m", now - HISTORY_DAYS * 86_400_000, now, P.BACKGROUND);
    if (!r.ok) { ps.problem = `history unavailable: ${r.error}`; return; }
    ps.bars = r.data.filter((b) => b.t + M1_MS <= Date.now()).slice(-MAX_BARS);
    ps.initialised = true;
  }

  /**
   * Fetch the newest 1-minute candles. Completed candles only; a candle that changes after it was used
   * for a decision is counted and journalled as a revision.
   */
  async refreshBars(k: PairKey, priority: Priority, deadlineAt: number | null): Promise<boolean> {
    const c = this.conn();
    const ps = this.pairs.get(k)!;
    if (!c || !ps.spec) return false;
    if (!ps.initialised) { await this.initHistory(k); return ps.initialised; }
    const now = Date.now();
    const last = ps.bars[ps.bars.length - 1];
    const from = last ? last.t - 3 * M1_MS : now - HISTORY_DAYS * 86_400_000;
    const r = await getHistory(c, ps.spec.tradableInstrumentId, ps.spec.infoRouteId, "1m", from, now, priority, deadlineAt);
    if (!r.ok) {
      if (r.unauthorized) void this.ensureToken(true);
      return false;
    }
    const cutoff = Date.now();
    for (const b of r.data) {
      if (b.t + M1_MS > cutoff) continue;
      const i = ps.bars.findIndex((x) => x.t === b.t);
      if (i >= 0) {
        const x = ps.bars[i];
        if (x.o !== b.o || x.h !== b.h || x.l !== b.l || x.c !== b.c) {
          if (ps.evaluatedT != null && b.t <= ps.evaluatedT) {
            ps.revisions++;
            void this.event("warn", "candle_revised", `${k} ${new Date(b.t).toISOString().slice(11, 16)} candle changed after it was used`, { before: x, after: b }, k, null, `rev:${k}:${b.t}`, 3_600_000);
          }
          ps.bars[i] = b;
        }
      } else if (!last || b.t > ps.bars[ps.bars.length - 1].t) ps.bars.push(b);
      else { ps.bars.push(b); ps.bars.sort((a, z) => a.t - z.t); }
    }
    if (ps.bars.length > MAX_BARS) ps.bars.splice(0, ps.bars.length - MAX_BARS);
    return true;
  }

  evaluatePair(k: PairKey): Evaluation | null {
    const ps = this.pairs.get(k)!;
    if (!ps.bars.length) return null;
    ps.eval = evaluate(ps.bars, this.settings.strategy);
    ps.evaluatedT = ps.eval.candleT;
    return ps.eval;
  }

  // ---- Account data ----------------------------------------------------------------------------------

  async refreshState(priority: Priority = P.SYNC): Promise<void> {
    const c = this.conn();
    const cols = this.session?.columns;
    if (!c || !cols) return;
    const r = await getState(c, cols, priority);
    if (r.ok) { this.state = r.data; this.stateAt = Date.now(); }
    else if (r.unauthorized) void this.ensureToken(true);
  }

  /** Positions, at most `maxAgeMs` old; concurrent callers share one request. */
  async freshPositions(maxAgeMs: number, priority: Priority): Promise<Position[] | null> {
    if (this.positions && Date.now() - this.positionsAt <= maxAgeMs) return this.positions;
    if (this.positionsFlight) return this.positionsFlight;
    const c = this.conn();
    const cols = this.session?.columns;
    if (!c || !cols) return null;
    const asked = Date.now();
    this.positionsFlight = getPositions(c, cols, priority).then((r) => {
      if (r.ok) { this.positions = r.data; this.positionsAt = asked; return r.data; }
      if (r.unauthorized) void this.ensureToken(true);
      return null;
    }).finally(() => { this.positionsFlight = null; });
    return this.positionsFlight;
  }

  async freshOrders(maxAgeMs: number, priority: Priority): Promise<Order[] | null> {
    if (this.orders && Date.now() - this.ordersAt <= maxAgeMs) return this.orders;
    if (this.ordersFlight) return this.ordersFlight;
    const c = this.conn();
    const cols = this.session?.columns;
    if (!c || !cols) return null;
    const asked = Date.now();
    this.ordersFlight = getOrders(c, cols, priority).then((r) => {
      if (r.ok) { this.orders = r.data; this.ordersAt = asked; return r.data; }
      if (r.unauthorized) void this.ensureToken(true);
      return null;
    }).finally(() => { this.ordersFlight = null; });
    return this.ordersFlight;
  }

  /** Equity as the broker reports it (projected balance = balance with open P&L). */
  equity(): number | null {
    const s = this.state;
    if (!s) return null;
    if (s.projectedBalance != null) return s.projectedBalance;
    if (s.balance != null) return s.balance + (s.openNetPnL ?? 0);
    return null;
  }

  eligibleEquity(): number | null {
    const e = this.equity();
    if (e == null) return null;
    return e - this.settings.risk.excludedCapital - Math.max(0, this.excludedPaid);
  }

  /** Gross notional of every position on the account (anyone's), account currency, or null if one cannot be valued. */
  grossNotional(): { value: number | null; unknown: string[] } {
    const pos = this.positions;
    const ccy = this.session?.currency;
    if (!pos || !ccy) return { value: null, unknown: ["positions or account currency not read yet"] };
    const rates = this.rates();
    let total = 0;
    const unknown: string[] = [];
    for (const p of pos) {
      const mine = [...this.pairs.values()].find((x) => x.spec?.tradableInstrumentId === p.tradableInstrumentId)?.spec;
      const fs = this.foreignSpecs.get(p.tradableInstrumentId);
      const spec = mine ? { lotSize: mine.lotSize, quote: mine.quote } : fs && "lotSize" in fs ? fs : null;
      if (!spec || p.qty == null || p.avgPrice == null) { unknown.push(p.tradableInstrumentId); continue; }
      const v = convert(Math.abs(p.qty) * spec.lotSize * p.avgPrice, spec.quote, ccy, rates);
      if (v == null) { unknown.push(p.tradableInstrumentId); continue; }
      total += v;
    }
    // Bot orders on their way count too.
    for (const t of this.trades.values()) {
      if (!["reserved", "sending", "acknowledged", "uncertain"].includes(t.state)) continue;
      const ps = this.pairs.get(t.pair as PairKey);
      if (!ps?.spec) continue;
      const v = convert(t.qty * ps.spec.lotSize * t.planned_entry, ps.spec.quote, ccy, rates);
      if (v == null) { unknown.push(t.pair); continue; }
      total += v;
    }
    return { value: unknown.length ? null : total, unknown };
  }

  /** Learn the contract of instruments other tools or the owner hold, so their notional counts. */
  async learnForeignSpecs(): Promise<void> {
    const c = this.conn();
    if (!c || !this.positions) return;
    for (const p of this.positions) {
      const ours = [...this.pairs.values()].some((x) => x.spec?.tradableInstrumentId === p.tradableInstrumentId);
      const known = this.foreignSpecs.get(p.tradableInstrumentId);
      // A lookup that failed is tried again after five minutes rather than remembered as unknown for good.
      if (ours || !p.routeId || (known && ("lotSize" in known || Date.now() - known.unknownAt < 300_000))) continue;
      const d = await getInstrumentDetails(c, p.tradableInstrumentId, p.routeId);
      if (!d.ok) { this.foreignSpecs.set(p.tradableInstrumentId, { unknownAt: Date.now() }); continue; }
      const lotSize = Number(d.data.lotSize);
      const quote = String(d.data.quotingCurrency ?? "").toUpperCase();
      this.foreignSpecs.set(p.tradableInstrumentId, lotSize > 0 && quote ? { lotSize, quote } : { unknownAt: Date.now() });
    }
  }

  // ---- Day, streak, slippage -----------------------------------------------------------------------

  async refreshDay(): Promise<void> {
    const now = Date.now();
    const key = fxDayKey(now);
    if (key !== this.dayKey || !this.day) {
      const existing = await this.store.readDay(key);
      if (existing) this.day = existing;
      else {
        const eq = this.equity();
        const el = this.eligibleEquity();
        if (eq == null || el == null) return;
        this.day = await this.store.startDay({ day: key, starts_at: new Date(fxDayStart(now)).toISOString(), start_equity: eq, start_eligible_equity: el, limit_amount: (this.settings.risk.dailyLossLimitPct / 100) * el, limit_hit_at: null });
      }
      this.dayKey = key;
    }
    const closed = await this.store.closedSince(this.day.starts_at);
    // A close the broker's records have not priced yet counts as the most it could have lost.
    this.dayRealized = closed.reduce((a, t) => a + (t.pnl_final && t.net_pnl != null ? t.net_pnl : -Math.abs(Number(t.reserved_risk) || 0)), 0);
    this.closedRecent = await this.store.recentClosed(30);
    const fills = await this.store.recentFills(20);
    const slips = fills.map((t) => {
      const ps = this.pairs.get(t.pair as PairKey);
      const pip = ps?.spec?.pipSize ?? PAIRS[t.pair as PairKey]?.pip;
      if (!pip || t.fill_price == null) return null;
      const adverse = t.side === "buy" ? (t.fill_price - t.planned_entry) / pip : (t.planned_entry - t.fill_price) / pip;
      return Math.max(0, adverse);
    }).filter((x): x is number => x != null);
    this.observedSlipPips = slips.length ? slips.reduce((a, b) => a + b, 0) / slips.length : null;
    this.ordersToday = await this.store.countTodaysTrades(this.day.starts_at);
    this.excludedPaid = await this.store.paidIntoAccount();
    this.dayFreshAt = Date.now();
  }

  slippageInUse(): number {
    return Math.max(this.settings.costs.slippageAllowancePips, this.observedSlipPips ?? 0);
  }

  /** The bot's day so far: realized net plus what open trades would realize now. Positive = loss. */
  dayLossNow(): { loss: number; limit: number | null; openNet: number } {
    let openNet = 0;
    const ccy = this.session?.currency ?? "USD";
    for (const t of this.trades.values()) {
      if (t.state !== "open" && t.state !== "closing") continue;
      const ps = this.pairs.get(t.pair as PairKey);
      const pos = this.positions?.find((p) => p.id === t.position_id);
      const rates = chargesOf(t, this.settings);
      const lots = Number(t.filled_qty ?? t.qty);
      const charges = (rates.commissionPerLotPerSide * 2 + rates.otherRtPerLot) * lots;
      if (pos?.unrealizedPl != null) { openNet += pos.unrealizedPl - charges; continue; }
      if (!ps?.spec || !ps.quote || t.fill_price == null) { openNet -= Math.abs(Number(t.reserved_risk) || 0); continue; }
      const exit = t.side === "buy" ? ps.quote.bid : ps.quote.ask;
      const pnl = tradePnl({ side: t.side, lots, lotSize: ps.spec.lotSize, fill: t.fill_price, exit, quoteCcy: ps.spec.quote, accountCcy: ccy, rates: this.rates(), ...rates });
      openNet += pnl ? pnl.net : -Math.abs(Number(t.reserved_risk) || 0);
    }
    const limit = this.day?.start_eligible_equity != null ? (this.settings.risk.dailyLossLimitPct / 100) * this.day.start_eligible_equity : null;
    return { loss: -(this.dayRealized + openNet), limit, openNet };
  }

  // ---- What blocks a new entry right now -----------------------------------------------------------------

  /** Account-wide reasons no new entry may be made. Empty = entries allowed (each pair still has its own checks). */
  entryBlockers(now = Date.now()): string[] {
    const b: string[] = [];
    const c = this.control;
    if (!c) return ["The control row has not been read."];
    if (c.mode !== "live") b.push("The bot is stopped. Press START LIVE to allow entries.");
    if (c.entries_paused) b.push(`New entries are paused${c.pause_reason ? `: ${c.pause_reason}` : ""}${c.pause_until ? ` (until ${new Date(c.pause_until).toISOString().slice(11, 16)} UTC)` : ""}.`);
    if (!this.leaseOk(3000)) b.push("This worker does not hold a valid lease.");
    const s = this.session;
    if (!s) b.push("No broker account is connected.");
    else {
      if (s.status !== "connected") b.push("The broker session needs reconnecting.");
      if (!s.ready) b.push(`The broker session is not ready${s.error ? `: ${s.error}` : ""}.`);
      if (s.columnsMissing.length) b.push(`The broker config did not describe: ${s.columnsMissing.join(", ")}.`);
      const st = s.brokerAccount?.status;
      if (st && st.toUpperCase() !== "ACTIVE") b.push(`The broker reports the account as ${st}.`);
      const tr = s.brokerAccount?.tradingRules ?? {};
      if (tr.supportBrackets === false) b.push("The broker does not accept a stop and target with the order on this account.");
    }
    b.push(...settingsBlockers(this.settings));
    if (this.settingsWarnings.length) b.push("Some stored settings were invalid and replaced by defaults — review the settings.");
    if (!this.reconciled) b.push(`Reconciliation with the broker is not complete (${this.reconcileNote}).`);
    if (this.qtyCheck.state === "contradicted") b.push(`Order sizes are not being read as lots: ${this.qtyCheck.detail}`);
    if (this.protectionAlarm) b.push(this.protectionAlarm);
    if (this.closeAllReason) b.push(`Closing every bot position (${this.closeAllReason.replace(/_/g, " ")}); entries wait until none is left.`);
    const pending = [...this.trades.values()].filter((t) => t.state === "uncertain" || (t.state === "acknowledged" && t.ack_at && now - Date.parse(t.ack_at) > 10_000));
    if (pending.length) b.push(`Waiting for the broker to confirm ${pending.map((t) => t.pair).join(", ")} (pending reconciliation).`);
    const blackout = entryBlackout(now, this.settings.session);
    if (blackout) b.push(blackout);
    const until = streakPauseUntil(this.closedRecent.map((t) => ({ closedAt: Date.parse(t.closed_at ?? t.updated_at), net: t.pnl_final ? t.net_pnl : null })), this.settings.risk, now);
    if (until) b.push(`${this.settings.risk.lossStreakCount} losses in a row: new entries resume at ${new Date(until).toISOString().slice(11, 16)} UTC.`);
    const d = this.dayLossNow();
    if (d.limit != null && d.loss >= d.limit) b.push(`The daily loss limit is reached (${d.loss.toFixed(2)} of ${d.limit.toFixed(2)}).`);
    if (this.day?.limit_hit_at) b.push("The daily loss limit was reached today; entries resume at 17:00 New York.");
    const cap = Number(s?.brokerAccount?.riskRules?.maxOrdersCount);
    if (Number.isFinite(cap) && cap > 0 && this.ordersToday * 3 >= cap * 0.8) b.push(`Close to the broker's daily order cap (${cap}).`);
    if (this.equity() == null) b.push("The account's equity has not been read yet.");
    if (now - this.dayFreshAt > 60_000) b.push("The day's results (loss streak, daily loss) have not been read in the last minute.");
    return b;
  }

  streakInfo(): { count: number; pauseUntil: number | null } {
    const closed = this.closedRecent.map((t) => ({ closedAt: Date.parse(t.closed_at ?? t.updated_at), net: t.pnl_final ? t.net_pnl : null }));
    return { count: lossStreak(closed).count, pauseUntil: streakPauseUntil(closed, this.settings.risk, Date.now()) };
  }

  // ---- Jobs ------------------------------------------------------------------------------------------

  every(name: string, everyMs: () => number, fn: () => Promise<void>, firstInMs = 0): void {
    this.jobs.push({ name, everyMs, nextAt: Date.now() + firstInMs, running: false, fn });
  }

  start(): void {
    this.every("lease", () => 3000, () => this.renewLease());
    this.every("control", () => 1000, () => this.loadControl());
    this.every("session", () => 5000, async () => {
      if (!this.session) return;
      if (this.session.status === "reconnect_required") {
        await this.pickUpReconnect();
        if ((this.session.status as string) !== "connected") return;
      }
      await this.ensureToken();
      if (!this.session.ready) await this.prepareSession();
    });
    this.timer = setInterval(() => this.tick(), 100);
  }

  private tick(): void {
    const now = Date.now();
    for (const j of this.jobs) {
      if (j.running || now < j.nextAt) continue;
      if (this.stopping && j.name !== "lease" && j.name !== "status") continue;
      j.running = true;
      j.nextAt = now + j.everyMs();
      j.fn().catch((e) => this.noteError(j.name, e)).finally(() => { j.running = false; });
    }
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.event("info", "worker_stopping", "The worker is stopping (deploy or restart). Open positions keep their broker-side stop and target; the next worker reconciles them.");
    if (this.fence != null) await this.store.releaseLease(this.owner, this.fence);
  }
}
