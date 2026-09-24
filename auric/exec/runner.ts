import { randomUUID } from "node:crypto";
import { DEFAULT_CONFIG, MANAGEMENT_VERSION, type AuricConfig } from "../config/defaults";
import type { Bar, Candidate, InstrumentSpec, ProcessState, Quote } from "../core/types";
import { admin, event, setting, snapshot, telemetry } from "../db";
import { evaluate, emptyEngineState, type EngineState } from "../engine/evaluate";
import { sizePosition } from "../engine/sizing";
import { checkBreakers, freshRiskState, recordClose, recordRejection, type RiskState } from "../engine/breakers";
import { manage, type ManagedPosition } from "../engine/management";
import { noteRangeFailure } from "../engine/setups";
import { confirmedPivots } from "../engine/features";
import { aggregate, closedBars } from "../market/bars";
import { feedFor } from "../market/feed";
import { fallbackSession, type SessionWindow } from "../market/session";
import { referencePrice, referenceConfigured, referenceBudget } from "../market/twelvedata";
import { inBlackout, loadCalendar } from "../market/calendar";
import * as TL from "../broker/tradelocker";
import { discoverGold, missingFields } from "../broker/instrument";
import { authFor, type ConnRow } from "../broker/session";
import { checkOwnership, isAuricTag, AURIC_TAG_PREFIX } from "./ownership";
import { LatencySet } from "./latency";

/** Routes an entry actually needs; a backoff on discovery/history must not freeze order placement. */
const ENTRY_ROUTES = ["GET /trade/quotes", "POST /trade/accounts/:id/orders", "GET /trade/accounts/:id/positions", "GET /trade/accounts/:id/state"];

export type AccountRow = {
  id: string; user_id: string; connection_id: string; broker_account_id: string; acc_num: string; currency: string | null;
  instrument_spec: InstrumentSpec | null; risk_fraction: number; allow_shared_account: boolean; status: string; live_authorized_at: string | null; updated_at?: string | null;
};
export type SessionRow = { id: string; expires_at: string; status: string; paused_entries: boolean; pause_reason: string | null; auto_renew: boolean };
type PosRow = { id: string; broker_position_id: string; strategy_tag: string; side: "buy" | "sell"; qty: number; entry: number; stop: number; target: number; initial_risk: number; invalidation: number; setup_family: string; protected: boolean; protection_attempts: number; opened_at: string; status: string; close_reason: string | null; management_version: string; mgmt: Record<string, unknown>; session_id: string | null; intent_id: string | null };

const LEASE_TTL_SEC = 20;
const SUBMIT_UNKNOWN_GRACE_MS = 45_000;

/**
 * One runner per broker account. Everything for the account is serialized through `tick()`; the worker
 * never runs two ticks for one account concurrently, and a database lease with a fence prevents a second
 * worker instance (redeploy overlap) from acting on the same account.
 */
export class AccountRunner {
  cfg: AuricConfig = DEFAULT_CONFIG;
  owner: string;
  fence = 0;
  m1: Bar[] = [];
  quote: Quote | null = null; lastQuoteRaw: TL.TLQuoteRaw | null = null;
  ref: Quote | null = null;
  tlcfg: TL.TLConfig | null = null;
  spec: InstrumentSpec | null = null;
  engine: EngineState = emptyEngineState();
  risk: RiskState | null = null;
  lat = new LatencySet();
  session: SessionRow | null = null;
  state: ProcessState = "OBSERVING";
  lastPersist = 0; lastHistory = 0; lastRef = 0; lastAccountState = 0; lastReconcile = 0; lastSpecCheck = 0; lastQuoteAt = 0;
  acctState: TL.TLAccountState | null = null;
  positions: TL.TLPosition[] | null = null;
  ownership: Awaited<ReturnType<typeof checkOwnership>> | null = null;
  busy = false; stopped = false;
  health = { broker: "unknown" as "ok" | "error" | "unknown", data: "unknown" as "ok" | "stale" | "unknown", lastError: null as string | null };
  private sessionWindow: SessionWindow = fallbackSession(Date.now());

  constructor(public acct: AccountRow, public conn: ConnRow, hostTag: string) { this.owner = `${hostTag}`; }

  private async auth() { return authFor(this.conn, this.acct.broker_account_id, this.acct.acc_num); }

  private async setState(s: ProcessState, message: string, payload?: unknown) {
    if (s === this.state && s !== "OBSERVING") return;
    this.state = s;
    await event(this.acct.id, this.session?.id ?? null, "state", message, s, payload);
  }

  async acquireLease(): Promise<boolean> {
    const { data, error } = await admin().rpc("auric_acquire_lease", { p_account: this.acct.id, p_owner: this.owner, p_ttl_sec: LEASE_TTL_SEC });
    if (error || !data?.ok) return false;
    if (this.fence && data.fence !== this.fence) { await event(this.acct.id, null, "lease", `lease fence moved ${this.fence} → ${data.fence}: another worker acted; reconciling before continuing`); this.lastReconcile = 0; }
    this.fence = Number(data.fence); return true;
  }

  async loadPersisted() {
    const db = admin();
    const [{ data: es }, { data: rs }] = await Promise.all([db.from("auric_engine_state").select("state").eq("account_id", this.acct.id).maybeSingle(), db.from("auric_risk_state").select("state").eq("account_id", this.acct.id).maybeSingle()]);
    if (es?.state) this.engine = es.state as EngineState;
    if (rs?.state) this.risk = rs.state as RiskState;
  }
  async persist() {
    const db = admin(); const now = new Date().toISOString();
    await Promise.all([
      db.from("auric_engine_state").upsert({ account_id: this.acct.id, state: this.engine, updated_at: now }),
      this.risk ? db.from("auric_risk_state").upsert({ account_id: this.acct.id, state: this.risk, updated_at: now }) : Promise.resolve(),
    ]);
  }

  /* ------------------------------------------------------------ market data */
  private specRetryAt = 0; private specEventAt = 0;
  async ensureSpec(a: TL.TLAuth) {
    const now = Date.now();
    // 1) Reuse the persisted specification (written by an earlier successful discovery) instead of asking the
    //    broker again on every restart: several runners share one broker login and the instrument endpoints are
    //    the first thing Cloudflare rate-limits. A complete persisted spec is trusted for 6h, then re-checked.
    if (!this.spec && this.acct.instrument_spec && missingFields(this.acct.instrument_spec).length === 0) {
      this.spec = this.acct.instrument_spec; this.cfg = { ...this.cfg, priceDecimals: this.spec.priceDecimals ?? 2 };
      this.lastSpecCheck = Date.parse(this.acct.updated_at ?? "") || now;
    }
    if (this.spec && now - this.lastSpecCheck < 6 * 3600_000) return;
    // 2) Failed discoveries retry with backoff (60s → 10 min), never every tick.
    if (now < this.specRetryAt) return;
    if (!this.tlcfg) { const c = await TL.getConfig(a); if (c.ok) { this.tlcfg = c.data; TL.applyRateLimits(c.data); } }
    const d = await discoverGold(a);
    if (!d.ok) {
      this.health.lastError = d.error;
      this.specRetryAt = now + Math.min(600_000, 60_000 * Math.max(1, Math.round((now - this.lastSpecCheck) / 60_000) || 1));
      if (now - this.specEventAt > 300_000) { this.specEventAt = now; await event(this.acct.id, this.session?.id ?? null, "instrument", `instrument discovery failed: ${d.error}${this.spec ? " — keeping the last good specification" : ""}`); }
      return;
    }
    // 3) Never replace a complete specification with an incomplete one.
    if (d.missing.length && this.spec && missingFields(this.spec).length === 0) {
      this.specRetryAt = now + 300_000;
      if (now - this.specEventAt > 300_000) { this.specEventAt = now; await event(this.acct.id, this.session?.id ?? null, "instrument", `broker returned an incomplete specification (missing ${d.missing.join(", ")}) — keeping the last good one`); }
      return;
    }
    this.lastSpecCheck = now; this.specRetryAt = 0;
    this.spec = d.spec; this.cfg = { ...this.cfg, priceDecimals: d.spec.priceDecimals ?? 2 };
    await admin().from("auric_accounts").update({ instrument_spec: d.spec, spec_missing: d.missing, updated_at: new Date().toISOString() }).eq("id", this.acct.id);
    if (d.missing.length) await event(this.acct.id, this.session?.id ?? null, "instrument", `broker specification incomplete: missing ${d.missing.join(", ")} — sizing will refuse`);
    else if (d.missing.length === 0 && this.specEventAt) { this.specEventAt = 0; await event(this.acct.id, this.session?.id ?? null, "instrument", `instrument specification confirmed: ${d.spec.name} tick ${d.spec.tickSize} · step ${d.spec.lotStep} · min ${d.spec.minLot} · contract ${d.spec.contractSize ?? "n/a"}`); }
  }

  private feed() { return feedFor(this.conn.env, this.spec!.tradableInstrumentId, this.spec!.infoRouteId); }

  async refreshHistory(a: TL.TLAuth, force = false) {
    if (!this.spec) return;
    const f = this.feed();
    const r = await f.refreshHistory(a, this.cfg.feed.m1RefreshMs, force);
    if (!r.ok) { this.lat.add("history_fetch", r.latencyMs); this.health.data = f.m1.length && Date.now() - f.lastHistoryOk < 3 * this.cfg.feed.m1RefreshMs ? "ok" : "stale"; this.m1 = f.m1; telemetry(this.acct.id, "history_error", { error: r.error, status: r.status }); if (r.status === 401) this.conn.token_exp = null; return; }
    if (!r.shared) { this.lat.add("history_fetch", r.latencyMs); if (r.data.outOfOrder || r.data.replaced > 3) telemetry(this.acct.id, "history_anomaly", r.data); }
    this.m1 = f.m1;
    this.health.data = this.m1.length ? "ok" : "stale";
  }

  async pollQuote(a: TL.TLAuth) {
    if (!this.spec) return;
    const r = await this.feed().pollQuote(a, this.cfg.feed.brokerQuotePollMs);
    if (!r.ok) { this.health.broker = r.status === 401 ? "error" : this.health.broker; telemetry(this.acct.id, "quote_error", { error: r.error, status: r.status }); if (r.status === 401) this.conn.token_exp = null; return; }
    if (!r.shared) { this.lat.add("quote_roundtrip", r.latencyMs); telemetry(this.acct.id, "quote", { b: r.data.bid, a: r.data.ask, ms: +r.latencyMs.toFixed(1) }); }
    this.health.broker = "ok"; this.lastQuoteRaw = r.data; this.lastQuoteAt = r.data.receivedAt;
    this.quote = { source: "broker", bid: r.data.bid, ask: r.data.ask, providerTs: null, providerTsPrecision: "none", receivedAt: r.data.receivedAt };
  }

  async pollReference() {
    if (!referenceConfigured()) return;
    const now = Date.now(); if (now - this.lastRef < this.cfg.feed.referencePollMs) return; this.lastRef = now;
    const q = await referencePrice(); if (q) this.ref = q;
  }

  feedGate(): { ok: boolean; reason: string } {
    if (!this.quote) return { ok: false, reason: "Broker quote is unavailable." };
    const age = Date.now() - this.quote.receivedAt;
    if (age > this.cfg.breakers.maxQuoteAgeMs) return { ok: false, reason: `Broker quote is stale (${(age / 1000).toFixed(1)}s old).` };
    if (this.ref && Date.now() - this.ref.receivedAt < 120_000) {
      const mid = (this.quote.bid + this.quote.ask) / 2, div = Math.abs(mid - this.ref.bid);
      if (div > this.cfg.breakers.maxFeedDivergenceUsd) return { ok: false, reason: `Broker mid ${mid.toFixed(2)} diverges $${div.toFixed(2)} from reference ${this.ref.bid.toFixed(2)} (limit $${this.cfg.breakers.maxFeedDivergenceUsd}).` };
    }
    return { ok: true, reason: "broker quote fresh" + (this.ref ? ` and within $${this.cfg.breakers.maxFeedDivergenceUsd} of reference` : " (no reference feed configured)") };
  }

  /* ------------------------------------------------------------ account + reconciliation */
  async refreshAccount(a: TL.TLAuth, force = false) {
    const now = Date.now(); if (!force && now - this.lastAccountState < 10_000) return; this.lastAccountState = now;
    const [st, ps] = await Promise.all([TL.getAccountState(a, this.tlcfg), TL.listPositions(a, this.tlcfg)]);
    this.lat.add("account_state", st.latencyMs);
    if (st.ok) { this.acctState = st.data; const eq = st.data.projectedBalance ?? (st.data.balance != null && st.data.openNetPnL != null ? st.data.balance + st.data.openNetPnL : st.data.balance); await admin().from("auric_accounts").update({ balance: st.data.balance, equity: eq, state_at: new Date().toISOString() }).eq("id", this.acct.id); }
    this.positions = ps.ok ? ps.data : null;
    if (!ps.ok) telemetry(this.acct.id, "positions_error", { error: ps.error, status: ps.status });
  }
  equity(): number | null { const s = this.acctState; if (!s) return null; return s.projectedBalance ?? (s.balance != null && s.openNetPnL != null ? s.balance + s.openNetPnL : s.balance); }

  async openRows(): Promise<PosRow[]> {
    const { data } = await admin().from("auric_positions").select("*").eq("account_id", this.acct.id).in("status", ["open", "closing", "orphan_review"]);
    return (data ?? []) as PosRow[];
  }

  /** Broker is the truth. Called on startup, periodically, after uncertain responses and after a fence change. */
  async reconcile(a: TL.TLAuth, force = false) {
    const now = Date.now(); if (!force && now - this.lastReconcile < 30_000) return; this.lastReconcile = now;
    await this.refreshAccount(a, true);
    if (!this.positions) return; // cannot reconcile without the broker's view; nothing is assumed closed
    const db = admin();
    const rows = await this.openRows();
    const brokerById = new Map(this.positions.map((p) => [p.id, p]));
    for (const r of rows) {
      const bp = brokerById.get(r.broker_position_id);
      if (bp) {
        const prot = !!bp.stopLossId && !!bp.takeProfitId;
        if (prot !== r.protected) await db.from("auric_positions").update({ protected: prot, sl_id: bp.stopLossId, tp_id: bp.takeProfitId, updated_at: new Date().toISOString() }).eq("id", r.id);
        continue;
      }
      // Gone at the broker → find how it closed. Never mark closed without broker evidence.
      const hist = await TL.listOrdersHistory(a, this.tlcfg, Date.parse(r.opened_at) - 60_000);
      if (!hist.ok) { telemetry(this.acct.id, "reconcile_history_error", { error: hist.error }); continue; }
      const closers = hist.data.filter((o) => o.positionId === r.broker_position_id && o.status === "FILLED" && o.avgPrice != null && o.createdDate != null && o.createdDate > Date.parse(r.opened_at) - 1000);
      const closer = closers.sort((x, y) => (y.createdDate ?? 0) - (x.createdDate ?? 0))[0];
      const contract = this.spec?.contractSize ?? null;
      let realized: number | null = null;
      if (closer && contract) realized = (r.side === "buy" ? closer.avgPrice! - r.entry : r.entry - closer.avgPrice!) * r.qty * contract;
      const reason = closer ? (closer.type === "stop" || (closer.avgPrice! <= r.stop && r.side === "buy") || (closer.avgPrice! >= r.stop && r.side === "sell") ? "stop" : (r.side === "buy" ? closer.avgPrice! >= r.target : closer.avgPrice! <= r.target) ? "target" : "closed (manual/other)") : "closed at broker (fill not found in history)";
      await db.from("auric_positions").update({ status: "closed", closed_at: new Date().toISOString(), close_reason: r.close_reason ?? reason, realized_pnl: realized, updated_at: new Date().toISOString() }).eq("id", r.id);
      if (this.risk && realized != null) { this.risk = recordClose(this.risk, realized, now, this.cfg.breakers); }
      if (reason === "stop" && r.setup_family === "RANGE_REJECTION" && this.engine.range) this.engine.setups = noteRangeFailure(this.engine.setups, this.engine.range.id);
      await this.setState("TRADE_CLOSED", `Trade closed — ${reason}${realized != null ? `, realized ${realized >= 0 ? "+" : ""}$${realized.toFixed(2)} (brokerage net, excl. credits)` : " (P&L pending broker data)"}`, { positionId: r.broker_position_id, reason, realized, closePrice: closer?.avgPrice ?? null });
      if (reason.startsWith("closed (manual")) await event(this.acct.id, this.session?.id ?? null, "manual_close", "Position was closed outside AURIC; the same setup will not be reopened.");
    }
    // Orphans: broker positions carrying AURIC's tag with no row (crash between fill and record).
    const known = new Set(rows.map((r) => r.broker_position_id));
    for (const bp of this.positions) {
      if (!isAuricTag(bp.strategyId) || known.has(bp.id)) continue;
      const { data: intent } = await db.from("auric_intents").select("*").eq("strategy_tag", bp.strategyId!).maybeSingle();
      if (intent && intent.account_id === this.acct.id) {
        await this.recordFill(intent, bp, "reconcile");
      } else {
        await db.from("auric_positions").upsert({ account_id: this.acct.id, broker_position_id: bp.id, strategy_tag: bp.strategyId, side: bp.side, qty: bp.qty, entry: bp.avgPrice ?? 0, stop: 0, target: 0, initial_risk: 0, invalidation: 0, setup_family: "UNKNOWN", protected: !!bp.stopLossId && !!bp.takeProfitId, opened_at: new Date(bp.openDate ?? now).toISOString(), status: "orphan_review", management_version: MANAGEMENT_VERSION }, { onConflict: "account_id,broker_position_id" });
        await event(this.acct.id, this.session?.id ?? null, "orphan", `Broker position ${bp.id} carries an AURIC tag but no record — held for review, new entries stopped.`);
      }
    }
    // Intents left in flight by a crash: resolve by tag.
    const { data: inflight } = await db.from("auric_intents").select("*").eq("account_id", this.acct.id).in("status", ["submitting", "submitted", "unknown"]);
    for (const it of inflight ?? []) {
      const bp = this.positions.find((p) => p.strategyId === it.strategy_tag);
      if (bp) { await this.recordFill(it, bp, "reconcile"); continue; }
      const age = now - Date.parse(it.updated_at ?? it.created_at);
      if (age > SUBMIT_UNKNOWN_GRACE_MS) {
        const hist = await TL.listOrdersHistory(a, this.tlcfg, Date.parse(it.created_at) - 60_000);
        const o = hist.ok ? hist.data.find((x) => x.strategyId === it.strategy_tag || (it.broker_order_id && x.id === it.broker_order_id)) : null;
        const status = o ? (o.status === "FILLED" ? "unknown" : "rejected") : hist.ok ? "rejected" : "unknown";
        if (status !== "unknown") await db.from("auric_intents").update({ status, error: o ? `broker history: ${o.status}` : "not found at broker after grace period", updated_at: new Date().toISOString() }).eq("id", it.id);
      }
    }
  }

  private async recordFill(intent: Record<string, unknown>, bp: TL.TLPosition, via: string) {
    const db = admin(); const cand = intent.candidate as Candidate;
    const entry = bp.avgPrice ?? Number(intent.entry_ref);
    const prot = !!bp.stopLossId && !!bp.takeProfitId;
    await db.from("auric_positions").upsert({
      account_id: this.acct.id, session_id: intent.session_id, intent_id: intent.id, broker_position_id: bp.id, strategy_tag: bp.strategyId, side: bp.side, qty: bp.qty,
      entry, stop: Number(intent.stop), target: Number(intent.target), initial_risk: Math.abs(entry - Number(intent.stop)), invalidation: cand.invalidation, setup_family: cand.family,
      protected: prot, sl_id: bp.stopLossId, tp_id: bp.takeProfitId, opened_at: new Date(bp.openDate ?? Date.now()).toISOString(), status: "open", management_version: MANAGEMENT_VERSION, mgmt: {},
    }, { onConflict: "account_id,broker_position_id" });
    await db.from("auric_intents").update({ status: "filled", broker_position_id: bp.id, fill_price: entry, updated_at: new Date().toISOString() }).eq("id", intent.id);
    if (this.risk) this.risk.lastEntryAt = Date.now();
    await this.setState(prot ? "POSITION_PROTECTED" : "ORDER_SUBMITTED", prot ? `Filled ${bp.side} ${bp.qty} @ ${entry.toFixed(2)} with broker-held stop ${Number(intent.stop).toFixed(2)} and target ${Number(intent.target).toFixed(2)} verified (${via})` : `Filled ${bp.side} ${bp.qty} @ ${entry.toFixed(2)} — protection NOT verified, starting recovery`, { positionId: bp.id, entry, slippage: +(Math.abs(entry - Number(intent.entry_ref))).toFixed(2) });
    const slipTicks = this.spec?.tickSize ? Math.abs(entry - Number(intent.entry_ref)) / this.spec.tickSize : 0;
    if (slipTicks > this.cfg.breakers.maxSlippageTicks) await this.pauseSession(`abnormal slippage ${slipTicks.toFixed(0)} ticks on fill`);
  }

  /* ------------------------------------------------------------ entries */
  private async pauseSession(reason: string) {
    if (!this.session || this.session.paused_entries) return;
    this.session.paused_entries = true; this.session.pause_reason = reason;
    await admin().from("auric_sessions").update({ paused_entries: true, pause_reason: reason }).eq("id", this.session.id);
    await this.setState("PAUSED", `New entries paused: ${reason}`);
  }

  private async entryGates(a: TL.TLAuth, now: number): Promise<{ ok: boolean; reason: string; code: string }> {
    if (!this.session) return { ok: false, code: "NO_SESSION", reason: "No active credit session — monitoring only; existing positions are still managed." };
    if (Date.parse(this.session.expires_at) <= now) return { ok: false, code: "SESSION_EXPIRED", reason: "Credit session expired — new entries stopped; open positions remain managed at no charge." };
    if (this.session.paused_entries) return { ok: false, code: "PAUSED", reason: `Entries paused: ${this.session.pause_reason ?? "by user"}` };
    const liveOk = this.conn.env !== "live" || (this.acct.live_authorized_at && (await setting<boolean>("live_orders_enabled", false)));
    if (!liveOk) return { ok: false, code: "LIVE_NOT_AUTHORIZED", reason: "Live orders are not authorized for this account (activation + global live flag required)." };
    if (!this.spec) return { ok: false, code: "NO_SPEC", reason: "Instrument specification not available." };
    if (!this.sessionWindow.open) return { ok: false, code: "MARKET_CLOSED", reason: `Market closed: ${this.sessionWindow.label}` };
    if (this.sessionWindow.minutesToClose != null && this.sessionWindow.minutesToClose <= this.cfg.protection.noNewEntriesBeforeCloseMin) return { ok: false, code: "NEAR_CLOSE", reason: `${this.sessionWindow.minutesToClose} min to session close — no new intraday positions.` };
    const fg = this.feedGate(); if (!fg.ok) return { ok: false, code: "FEED", reason: fg.reason };
    if (TL.anyBackoff(ENTRY_ROUTES)) return { ok: false, code: "RATE_LIMITED", reason: "Broker rate limit backoff in effect on an order-path route." };
    const cal = inBlackout(await loadCalendar(now), now, this.cfg.calendar); if (cal.blocked) return { ok: false, code: "NEWS", reason: `High-impact release window: ${cal.reason}` };
    const rows = await this.openRows();
    if (rows.length) return { ok: false, code: "POSITION_OPEN", reason: rows.some((r) => r.status === "orphan_review") ? "An AURIC-tagged position is held for review." : "One AURIC position is already open (limit: one at a time)." };
    const { data: inflight } = await admin().from("auric_intents").select("id").eq("account_id", this.acct.id).in("status", ["submitting", "submitted", "unknown"]);
    if (inflight?.length) return { ok: false, code: "INTENT_IN_FLIGHT", reason: "An order intent is unresolved — nothing new is sent until the broker confirms its outcome." };
    if (!this.positions) return { ok: false, code: "EXPOSURE_UNKNOWN", reason: "Broker positions could not be read — external exposure unknown, entries paused." };
    this.ownership = await checkOwnership(this.acct.broker_account_id, this.positions, this.acct.allow_shared_account);
    if (!this.ownership.ok) return { ok: false, code: "OWNERSHIP", reason: this.ownership.reason };
    const eq = this.equity(); if (eq == null) return { ok: false, code: "NO_ACCOUNT_STATE", reason: "Account equity unavailable." };
    if (!this.risk) this.risk = freshRiskState(now, eq, this.cfg.breakers);
    const b = checkBreakers(this.risk, now, eq, this.cfg.breakers); this.risk = b.state;
    if (!b.verdict.ok) { if (b.verdict.hard) await this.pauseSession(`${b.verdict.code}: ${b.verdict.detail}`); return { ok: false, code: b.verdict.code, reason: b.verdict.detail }; }
    void a;
    return { ok: true, code: "OK", reason: "all entry gates passed" };
  }

  private async submit(a: TL.TLAuth, cand: Candidate, now: number) {
    const db = admin(); const spec = this.spec!; const eq = this.equity()!;
    await this.setState("RISK_CHECK", `Trigger validated (${cand.family}); sizing for ${(this.acct.risk_fraction * 100).toFixed(2)}% of $${eq.toFixed(2)}`, { setupId: cand.setupId });
    const sz = sizePosition({ side: cand.side, entry: cand.frozen.entryRef, stop: cand.plannedStop, equity: eq, riskFraction: this.acct.risk_fraction, spec, cfg: this.cfg.sizing, accountCurrency: this.acct.currency });
    if (!sz.ok) { await event(this.acct.id, this.session!.id, "rejection", sz.explanation, "OBSERVING", { code: sz.code, setupId: cand.setupId }); return; }
    // Margin check with what the broker reports. Unknown leverage → require available funds ≥ 2× estimated loss and say so.
    const avail = this.acctState?.availableFunds ?? null;
    if (avail != null && avail < 2 * sz.estLoss) { await event(this.acct.id, this.session!.id, "rejection", `Available funds $${avail.toFixed(2)} are below 2× the estimated loss $${sz.estLoss.toFixed(2)}.`, "OBSERVING", { code: "FUNDS" }); return; }
    // Durable intent BEFORE any broker call. Unique (account, setup) makes a retry a no-op.
    const tag = `${AURIC_TAG_PREFIX}${randomUUID().slice(0, 12)}`;
    const { data: intent, error } = await db.from("auric_intents").insert({ account_id: this.acct.id, session_id: this.session!.id, setup_id: cand.setupId, strategy_version: cand.strategyVersion, side: cand.side, qty: sz.qty, entry_ref: cand.frozen.entryRef, stop: cand.plannedStop, target: cand.plannedTarget, strategy_tag: tag, status: "planned", candidate: cand, sizing: sz, fence: this.fence }).select("*").single();
    if (error || !intent) { await event(this.acct.id, this.session!.id, "rejection", `Intent not recorded (${error?.message ?? "duplicate setup"}); nothing sent.`, "OBSERVING"); return; }
    // Final pre-submit recheck on a FRESH quote.
    await this.pollQuote(a);
    const q = this.quote!; const fg = this.feedGate();
    const entryNow = cand.side === "buy" ? q.ask : q.bid;
    const drift = Math.abs(entryNow - cand.frozen.entryRef);
    const stopDist = Math.abs(entryNow - cand.plannedStop);
    const badStop = cand.side === "buy" ? cand.plannedStop >= q.bid : cand.plannedStop <= q.ask;
    const minDist = spec.minStopDistance ?? 0;
    if (!fg.ok || badStop || stopDist < minDist || drift > 0.25 * stopDist || (q.ask - q.bid) / stopDist > this.cfg.breakers.maxSpreadToStopRatio || now > cand.expiresAt) {
      const why = !fg.ok ? fg.reason : badStop ? "stop is on the wrong side of the market" : stopDist < minDist ? `stop distance ${stopDist.toFixed(2)} below broker minimum ${minDist}` : now > cand.expiresAt ? "candidate expired" : drift > 0.25 * stopDist ? `price drifted ${drift.toFixed(2)} from the validated entry` : "spread widened against the stop";
      await db.from("auric_intents").update({ status: "cancelled", error: why, updated_at: new Date().toISOString() }).eq("id", intent.id);
      await event(this.acct.id, this.session!.id, "rejection", `Pre-submit check failed: ${why}`, "OBSERVING", { code: "PRESUBMIT", setupId: cand.setupId }); return;
    }
    const resize = sizePosition({ side: cand.side, entry: entryNow, stop: cand.plannedStop, equity: eq, riskFraction: this.acct.risk_fraction, spec, cfg: this.cfg.sizing, accountCurrency: this.acct.currency });
    const qty = resize.ok ? Math.min(resize.qty, sz.qty) : 0;
    if (!(qty > 0)) { await db.from("auric_intents").update({ status: "cancelled", error: "re-sized to zero on fresh quote", updated_at: new Date().toISOString() }).eq("id", intent.id); await event(this.acct.id, this.session!.id, "rejection", "Re-check on the fresh quote left no valid quantity.", "OBSERVING"); return; }
    // Fenced transition to submitting; if the fence moved, another worker owns this account now.
    const { data: okFence } = await db.rpc("auric_fenced_intent_update", { p_intent: intent.id, p_fence: this.fence, p_patch: { status: "submitting", submitted_at: new Date().toISOString() } });
    if (!okFence) { await event(this.acct.id, this.session!.id, "lease", "Lost the account lease before submitting — order not sent."); return; }
    await this.setState("ORDER_SUBMITTED", `Submitting ${cand.side} ${qty} @ ~${entryNow.toFixed(2)}, stop ${cand.plannedStop.toFixed(2)}, target ${cand.plannedTarget.toFixed(2)} (${sz.explanation})`, { qty, tag });
    const t0 = performance.now();
    const r = await TL.placeMarketOrder(a, { tradableInstrumentId: spec.tradableInstrumentId, tradeRouteId: spec.tradeRouteId, side: cand.side, qty, stopLoss: cand.plannedStop, takeProfit: cand.plannedTarget, strategyId: tag });
    const ackMs = performance.now() - t0; this.lat.add("order_ack", ackMs);
    if (r.ok) {
      await db.rpc("auric_fenced_intent_update", { p_intent: intent.id, p_fence: this.fence, p_patch: { status: "submitted", broker_order_id: r.data.orderId, ack_at: new Date().toISOString(), ack_latency_ms: Math.round(ackMs) } });
      this.risk!.lastEntryAt = now;
    } else if (r.uncertain) {
      await db.rpc("auric_fenced_intent_update", { p_intent: intent.id, p_fence: this.fence, p_patch: { status: "unknown", error: r.error, ack_latency_ms: Math.round(ackMs) } });
      await event(this.acct.id, this.session!.id, "order", `Order outcome UNKNOWN (${r.error}) — checking the broker before anything else is sent.`);
    } else {
      await db.rpc("auric_fenced_intent_update", { p_intent: intent.id, p_fence: this.fence, p_patch: { status: "rejected", error: r.error, ack_latency_ms: Math.round(ackMs) } });
      this.risk = recordRejection(this.risk!, now, this.cfg.breakers);
      await event(this.acct.id, this.session!.id, "order", `Broker rejected the order: ${r.error}`, "OBSERVING");
      return;
    }
    // Confirm the fill by tag (the order id → position id mapping is discovered, never assumed).
    for (let i = 0; i < 6; i++) {
      await new Promise((res) => setTimeout(res, 800));
      const ps = await TL.listPositions(a, this.tlcfg); if (!ps.ok) continue;
      this.positions = ps.data; const bp = ps.data.find((p) => p.strategyId === tag);
      if (bp) { this.lat.add("fill_confirm", performance.now() - t0); await this.recordFill(intent, bp, "fill-poll"); return; }
    }
    await db.from("auric_intents").update({ status: "unknown", updated_at: new Date().toISOString() }).eq("id", intent.id).in("status", ["submitted"]);
    await event(this.acct.id, this.session!.id, "order", "Fill not yet visible at the broker — reconciliation will resolve it; no second order will be sent.");
    this.lastReconcile = 0;
  }

  /* ------------------------------------------------------------ management */
  private async managePositions(a: TL.TLAuth, now: number) {
    const rows = await this.openRows(); if (!rows.length) return;
    const db = admin(); const q = this.quote; const spec = this.spec;
    if (!q || !spec || !this.positions) return;
    for (const r of rows) {
      const bp = this.positions.find((p) => p.id === r.broker_position_id);
      if (!bp) { this.lastReconcile = 0; continue; }
      if (r.status === "orphan_review") continue;
      // Protection recovery: bounded attempts, then emergency close scoped to this AURIC position.
      if (!(bp.stopLossId && bp.takeProfitId)) {
        if (r.protection_attempts >= 3) {
          await event(this.acct.id, r.session_id, "protection", `Protection could not be established after ${r.protection_attempts} attempts — emergency close of AURIC position ${bp.id}.`);
          const c = await TL.closePosition(a, bp.id, 0);
          await db.from("auric_positions").update({ status: c.ok ? "closing" : "open", close_reason: "emergency: unprotected", protection_attempts: r.protection_attempts + 1, updated_at: new Date().toISOString() }).eq("id", r.id);
          await this.pauseSession("a position filled without verifiable protection");
          continue;
        }
        const m = await TL.modifyPosition(a, bp.id, { stopLoss: r.stop, takeProfit: r.target });
        this.lat.add("protection_modify", m.latencyMs);
        await db.from("auric_positions").update({ protection_attempts: r.protection_attempts + 1, updated_at: new Date().toISOString() }).eq("id", r.id);
        await event(this.acct.id, r.session_id, "protection", m.ok ? `Protection re-sent (attempt ${r.protection_attempts + 1}); verifying with the broker.` : `Protection attempt ${r.protection_attempts + 1} failed: ${m.error}`);
        this.lastReconcile = 0; continue;
      }
      if (!r.protected) { await db.from("auric_positions").update({ protected: true, sl_id: bp.stopLossId, tp_id: bp.takeProfitId, updated_at: new Date().toISOString() }).eq("id", r.id); await this.setState("POSITION_PROTECTED", `Broker-held stop and target verified for position ${bp.id}.`); }
      if (r.status === "closing") continue;
      const closedM1 = closedBars(this.m1, 60_000, now);
      const m5 = aggregate(closedM1, 5, true, now); const piv = confirmedPivots(m5, this.cfg.features.pivotLeft, this.cfg.features.pivotRight);
      const mp: ManagedPosition = { side: r.side, entry: Number(r.entry), stop: Number(r.stop), target: Number(r.target), qty: Number(r.qty), openedAt: Date.parse(r.opened_at), initialRisk: Number(r.initial_risk), managementVersion: r.management_version, setupFamily: r.setup_family, invalidation: Number(r.invalidation), breakevenDone: !!r.mgmt?.breakevenDone };
      const act = manage(mp, q.bid, q.ask, spec.tickSize ?? 0.01, spec.minStopDistance ?? 0, closedM1, piv.highs, piv.lows, now, this.cfg.protection, this.sessionWindow.minutesToClose, q.ask - q.bid);
      if (act.kind === "none") { if (this.state !== "POSITION_MANAGED") await this.setState("POSITION_MANAGED", `Managing ${r.side} ${r.qty} from ${Number(r.entry).toFixed(2)}: stop ${Number(r.stop).toFixed(2)}, target ${Number(r.target).toFixed(2)}`); continue; }
      if (act.kind === "modify_stop") {
        const m = await TL.modifyPosition(a, bp.id, { stopLoss: act.newStop });
        this.lat.add("protection_modify", m.latencyMs);
        if (m.ok) { await db.from("auric_positions").update({ stop: act.newStop, mgmt: { ...r.mgmt, breakevenDone: r.mgmt?.breakevenDone || !!act.breakeven }, updated_at: new Date().toISOString() }).eq("id", r.id); await event(this.acct.id, r.session_id, "manage", `Stop moved to ${act.newStop.toFixed(2)}: ${act.reason}`, "POSITION_MANAGED"); this.lastReconcile = 0; }
        else await event(this.acct.id, r.session_id, "manage", `Stop modification refused by broker (${m.error}); original stop stays.`);
      } else if (act.kind === "close") {
        const c = await TL.closePosition(a, bp.id, 0);
        await db.from("auric_positions").update({ status: c.ok ? "closing" : "open", close_reason: act.code === "TIME_STOP" ? "time-stop" : act.code === "SESSION_END" ? "session-end" : "setup-invalidated", updated_at: new Date().toISOString() }).eq("id", r.id);
        await event(this.acct.id, r.session_id, "manage", c.ok ? `Close requested: ${act.reason}` : `Close request failed (${c.error}); will retry.`, c.ok ? "POSITION_MANAGED" : undefined);
        this.lastReconcile = 0;
      }
    }
  }

  /** User-requested: close every AURIC-owned position on this account. Never anything else. */
  async closeAllAuric(a: TL.TLAuth, who: string) {
    const rows = await this.openRows();
    for (const r of rows) {
      if (r.status === "closing") continue;
      const c = await TL.closePosition(a, r.broker_position_id, 0);
      await admin().from("auric_positions").update({ status: c.ok ? "closing" : r.status, close_reason: `user close (${who})`, updated_at: new Date().toISOString() }).eq("id", r.id);
      await event(this.acct.id, r.session_id, "manage", c.ok ? `Close requested by ${who} for AURIC position ${r.broker_position_id}.` : `Close by ${who} failed: ${c.error}`);
    }
    this.lastReconcile = 0;
  }

  /* ------------------------------------------------------------ the tick */
  async tick(sessionRow: SessionRow | null, pendingCommands: Array<{ id: string; command: string; by: string }>) {
    if (this.busy || this.stopped) return; this.busy = true;
    const now = Date.now();
    try {
      if (!(await this.acquireLease())) return;
      this.session = sessionRow;
      this.sessionWindow = fallbackSession(now);
      const a = await this.auth();
      if (!a) { this.health.broker = "error"; await snapshot(this.acct.id, this.snapshotPayload(null, now)); return; }
      await this.ensureSpec(a); if (!this.spec) return;
      await this.refreshHistory(a);
      await this.pollQuote(a);
      await this.pollReference();
      await this.refreshAccount(a);
      await this.reconcile(a);
      for (const c of pendingCommands) { if (c.command === "close_auric") await this.closeAllAuric(a, c.by); }
      await this.managePositions(a, now);

      // Strategy evaluation on CLOSED bars with the fresh broker quote.
      const m1c = closedBars(this.m1, 60_000, now);
      const inp = { cfg: this.cfg, m1: m1c, m5: aggregate(m1c, 5, true, now), m15: aggregate(m1c, 15, true, now), h1: aggregate(m1c, 60, true, now), quote: this.quote, tick: this.spec.tickSize ?? 0.01, contractSize: this.spec.contractSize, now };
      const gate = await this.entryGates(a, now);
      const out = evaluate(inp, this.engine);
      this.lat.add("strategy_compute", out.computeMs); this.engine = out.state;
      const cand = out.decision.kind === "candidate" ? out.decision.candidate : null;
      const forming = out.decision.rejections.find((r) => /FORMING|AWAITING|RETEST_HELD/.test(r.code));
      if (cand && gate.ok) { await this.setState("TRIGGER_VALIDATED", `${cand.family} ${cand.side}: ${cand.trigger}`, { setupId: cand.setupId, reasons: cand.reasons }); await this.submit(a, cand, now); }
      else if (cand && !gate.ok) await event(this.acct.id, this.session?.id ?? null, "rejection", `Qualifying ${cand.family} ${cand.side} not taken: ${gate.reason}`, this.state, { code: gate.code, setupId: cand.setupId });
      else if (!(await this.openRows()).length) {
        if (forming && this.state !== "SETUP_FORMING") await this.setState("SETUP_FORMING", forming.detail);
        else if (!forming && this.state !== "OBSERVING" && this.state !== "PAUSED" && this.state !== "TRADE_CLOSED") await this.setState("OBSERVING", `Observing: ${out.regime.regime}`);
        else if (this.state === "TRADE_CLOSED") await this.setState("OBSERVING", "Observing after trade close");
      }
      if (now - this.lastPersist > 5000) { this.lastPersist = now; await this.persist(); await snapshot(this.acct.id, this.snapshotPayload(out, now, gate, cand)); }
    } catch (e) {
      this.health.lastError = e instanceof Error ? e.message : String(e);
      console.error(`[auric:${this.acct.id.slice(0, 8)}]`, this.health.lastError);
      telemetry(this.acct.id, "tick_error", { error: this.health.lastError });
    } finally { this.busy = false; }
  }

  snapshotPayload(out: ReturnType<typeof evaluate> | null, now: number, gate?: { ok: boolean; reason: string; code: string }, cand?: Candidate | null) {
    const f = out?.features;
    return {
      at: now, state: this.state, strategyVersion: this.cfg.version, managementVersion: MANAGEMENT_VERSION,
      regime: out ? { regime: out.regime.regime, since: out.regime.since, pending: out.regime.pending, reasons: out.regime.reasons } : null,
      features: f ? { atrM5: f.atrM5, atrM1: f.atrM1, atrPercentile: f.atrPercentile, efficiency: f.efficiency, efficiencyDefined: f.efficiencyDefined, emaSlopeAtr: f.emaSlopeAtr, bodyRatioMean: f.bodyRatioMean, overlapMean: f.overlapMean, structure: f.structure, h1Bias: f.h1Bias, m15Structure: f.m15Structure, asOf: f.asOf, m1AsOf: f.m1AsOf, pivotsHigh: f.pivotsHigh.slice(-6), pivotsLow: f.pivotsLow.slice(-6), range: f.range } : null,
      compression: this.engine.setups.compression,
      candidate: cand ?? null,
      rejections: out ? out.decision.rejections.slice(-40) : [],
      gate: gate ?? null,
      quote: this.quote ? { bid: this.quote.bid, ask: this.quote.ask, spread: +(this.quote.ask - this.quote.bid).toFixed(2), ageMs: now - this.quote.receivedAt, source: "broker", providerTs: "not provided by TradeLocker /quotes" } : null,
      reference: this.ref ? { price: this.ref.bid, ageMs: now - this.ref.receivedAt, source: "twelvedata (minutely REST)", budget: referenceBudget() } : { configured: referenceConfigured() },
      account: { equity: this.equity(), balance: this.acctState?.balance ?? null, availableFunds: this.acctState?.availableFunds ?? null, currency: this.acct.currency, riskFraction: this.acct.risk_fraction, riskDollars: this.equity() != null ? +(this.equity()! * this.acct.risk_fraction).toFixed(2) : null, positionsAtBroker: this.positions?.length ?? null },
      spec: this.spec ? { name: this.spec.name, tickSize: this.spec.tickSize, lotStep: this.spec.lotStep, minLot: this.spec.minLot, contractSize: this.spec.contractSize, tickValue: this.spec.tickValue, currency: this.spec.currency, minStopDistance: this.spec.minStopDistance } : null,
      session: this.session ? { id: this.session.id, expiresAt: this.session.expires_at, paused: this.session.paused_entries, pauseReason: this.session.pause_reason, autoRenew: this.session.auto_renew } : null,
      market: this.sessionWindow, ownership: this.ownership, risk: this.risk,
      health: { ...this.health, worker: this.owner, fence: this.fence, bars: this.m1.length, lastBarT: this.m1[this.m1.length - 1]?.t ?? null },
      latency: this.lat.report(["quote_roundtrip", "strategy_compute", "order_ack", "fill_confirm", "protection_modify", "account_state", "history_fetch"]),
      bars: closedBars(this.m1, 60_000, now).slice(-240),
    };
  }
}
