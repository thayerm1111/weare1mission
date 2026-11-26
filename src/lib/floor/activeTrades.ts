import { createAdminClient } from "@/lib/supabase/admin";
import { connectionToken } from "@/lib/flow/connection";
import { contractKey } from "@/lib/flow/sizing";
import type { FlowPositionChart } from "@/lib/flow/positionChart";
import { brokerConfig } from "@/lib/flow/brokerEvidence";
import { brokerBusy } from "./brokerState";
import { brokerRateStats, withBrokerPriority, listPositions, listOrders, listInstruments, getQuote, getInstrumentDetails, getPositionChartBars, closePosition, modifyPosition, type TLInstrument } from "@/lib/flow/tradelocker";
import { parseInstrumentSpec, type TLInstrumentSpec } from "../../../command-center/adapters/tradelocker";
import { requireConsent } from "../../../command-center/engines/consent";
import { logTrade } from "@/lib/flow/tradeLog";
import type { PartialIntent } from "@/lib/flow/partialOperation";
import type { AccountRow } from "@/lib/flow/permissions";
import { activeQuote, parseOpenPositions, quoteIsFresh, tradeView, type BrokerPosition } from "./activeTradeModel";
import { executePositionAction, type PositionActionOutcome } from "./positionAction";
import { ACTIVE_TRADE_FRESH_MS, type ActiveTradeScope, type ActiveTradeActionRequest, type ActiveTradesSnapshot, type ActiveTrade } from "./activeTradeTypes";

type Admin = NonNullable<ReturnType<typeof createAdminClient>>;
type OwnedRow = AccountRow & { connection_id: string; account_id: string; acc_num: string; environment: string | null };
export type OwnedTradeAccount = { row: OwnedRow; permissions: OwnedRow[] };
type Session = OwnedTradeAccount & { admin: Admin; userId: string; scope: ActiveTradeScope; token: string; env: "live" | "demo" };
export class ActiveTradeError extends Error { constructor(public status: number, message: string) { super(message); } }
const CACHE_MS = 15_000, READ_BUDGET_MS = 12_000;
const snapshots = new Map<string, { at: number; snapshot: ActiveTradesSnapshot }>();
const reads = new Map<string, Promise<ActiveTradesSnapshot>>();
const instruments = new Map<string, { at: number; data: TLInstrument[] }>();
const specs = new Map<string, { at: number; data: TLInstrumentSpec }>();
const mutations = new Set<string>();
const versions = new Map<string, number>();
const scopeKey = (userId: string, scope: ActiveTradeScope) => `${userId}:${scope.environment}:${scope.accountId}`;

/** A dispatch quote is a reference, not a fill. Confirmation alone authorizes shrinking the stored quantity. */
export async function writePartialReference(admin: Admin, userId: string, scope: ActiveTradeScope, positionId: string, intent: PartialIntent, price: number, remaining?: number): Promise<boolean> {
  if (!(Number.isFinite(price) && price > 0 && intent.before_qty > 0 && intent.requested_qty > 0 && intent.requested_qty < intent.before_qty)) return false;
  if (remaining != null && !(Number.isFinite(remaining) && remaining > 0 && remaining <= intent.before_qty - intent.requested_qty + 1e-8)) return false;
  const answer = await admin.from("flow_managed_positions").update({ partial_px: price, partial_frac: Number((intent.requested_qty / intent.before_qty).toFixed(6)),
    ...(remaining != null ? { partial_done: true, qty: remaining } : {}) })
    .eq("user_id", userId).eq("environment", scope.environment).eq("account_id", scope.accountId).eq("position_id", positionId).eq("status", "open");
  return !answer.error;
}
/** A definite non-send/refusal frees only this attempt's unchanged, still-unconfirmed reference. */
export async function clearPartialReference(admin: Admin, userId: string, scope: ActiveTradeScope, positionId: string, price: number, fraction: number): Promise<boolean> {
  const answer = await admin.from("flow_managed_positions").update({ partial_px: null, partial_frac: null })
    .eq("user_id", userId).eq("environment", scope.environment).eq("account_id", scope.accountId).eq("position_id", positionId).eq("status", "open")
    .eq("partial_px", price).eq("partial_frac", fraction).or("partial_done.is.null,partial_done.eq.false");
  return !answer.error;
}

/** Both account and connection must belong to this authenticated member. There is no default-account fallback. */
export async function ownedTradeAccount(admin: Admin, userId: string, scope: ActiveTradeScope): Promise<OwnedTradeAccount> {
  const profile = await admin.from("profiles").select("status,role").eq("id", userId).maybeSingle();
  if (profile.error) throw new ActiveTradeError(503, "Your membership could not be verified.");
  if (!profile.data || profile.data.status !== "active" && profile.data.role !== "admin") throw new ActiveTradeError(403, "Your membership needs approval before you can access trading.");
  const answer = await admin.from("flow_broker_accounts").select("connection_id,account_id,acc_num,environment,manage_trades,permissions")
    .eq("user_id", userId).eq("account_id", scope.accountId).limit(100);
  if (answer.error) throw new ActiveTradeError(503, "The selected account could not be verified.");
  const rows = (answer.data ?? []) as OwnedRow[];
  if (!rows.length || rows.length === 100) throw new ActiveTradeError(404, "That account is not connected to your membership.");
  const connections = await admin.from("flow_broker_connections").select("id,environment,status")
    .eq("user_id", userId).in("id", [...new Set(rows.map((row) => row.connection_id))]);
  if (connections.error) throw new ActiveTradeError(503, "The selected account’s connection could not be verified.");
  const own = new Map((connections.data ?? []).map((connection) => [String(connection.id), connection]));
  const matching = rows.filter((row) => {
    const connection = own.get(row.connection_id);
    return connection?.environment === scope.environment && (!row.environment || row.environment === scope.environment);
  });
  if (!matching.length) throw new ActiveTradeError(404, "That account is not connected in the requested environment.");
  const working = matching.filter((row) => own.get(row.connection_id)?.status === "connected" && String(row.acc_num ?? "").trim());
  if (!working.length) throw new ActiveTradeError(409, "Reconnect this account in FLOW before managing its trades.");
  if (new Set(working.map((row) => String(row.acc_num))).size !== 1) throw new ActiveTradeError(409, "This account’s broker identity is ambiguous. Reconnect it in FLOW.");
  return { row: working[0], permissions: matching };
}
async function session(admin: Admin, userId: string, scope: ActiveTradeScope, owned: OwnedTradeAccount): Promise<Session> {
  const token = await connectionToken(owned.row.connection_id);
  if (!token.ok || token.env !== scope.environment) throw new ActiveTradeError(409, "Reconnect the selected account in FLOW.");
  return { ...owned, admin, userId, scope, token: token.token, env: token.env };
}
const safeRead = async <T>(fn: () => Promise<T>): Promise<T | null> => { try { return await fn(); } catch { return null; } };
async function instrumentList(s: Session): Promise<TLInstrument[]> {
  const key = `${s.env}:${s.scope.accountId}:${s.row.connection_id}`, cached = instruments.get(key);
  if (cached && Date.now() - cached.at < 300_000) return cached.data;
  const answer = await listInstruments(s.env, s.token, String(s.row.acc_num), s.scope.accountId);
  if (!answer.ok) return [];
  instruments.set(key, { at: Date.now(), data: answer.data });
  if (instruments.size > 1000) instruments.delete(instruments.keys().next().value!);
  return answer.data;
}
async function instrumentSpec(s: Session, instrument: TLInstrument, fresh = false): Promise<TLInstrumentSpec | null> {
  if (!instrument.infoRouteId) return null;
  const key = `${s.env}:${s.scope.accountId}:${s.row.connection_id}:${instrument.tradableInstrumentId}:${instrument.infoRouteId}`;
  const cached = specs.get(key);
  if (!fresh && cached && Date.now() - cached.at < 300_000) return cached.data;
  const answer = await getInstrumentDetails(s.env, s.token, String(s.row.acc_num), instrument.tradableInstrumentId, instrument.infoRouteId);
  if (!answer.ok) return null;
  const spec = parseInstrumentSpec(answer.data, { tradableInstrumentId: instrument.tradableInstrumentId, routeId: instrument.infoRouteId });
  if (String(spec.tradableInstrumentId) !== String(instrument.tradableInstrumentId)) return null;
  specs.set(key, { at: Date.now(), data: spec });
  if (specs.size > 3000) specs.delete(specs.keys().next().value!);
  return spec;
}
async function quote(s: Session, instrument: TLInstrument | undefined): Promise<ActiveTrade["quote"]> {
  if (!instrument?.infoRouteId) return activeQuote(null, Date.now());
  const answer = await safeRead(() => getQuote(s.env, s.token, String(s.row.acc_num), instrument.tradableInstrumentId, instrument.infoRouteId!));
  return activeQuote(answer?.ok ? answer.data : null, Date.now());
}
async function positions(s: Session): Promise<{ rows: BrokerPosition[]; observedAt: number }> {
  const config = await brokerConfig(s.env, s.token, String(s.row.acc_num), s.scope.accountId);
  const answer = await listPositions(s.env, s.token, String(s.row.acc_num), s.scope.accountId);
  const observedAt = Date.now();
  if (!answer.ok) throw new Error("positions_unavailable");
  if (!answer.data.length) return { rows: [], observedAt };
  const orders = await safeRead(() => listOrders(s.env, s.token, String(s.row.acc_num), s.scope.accountId));
  return { rows: parseOpenPositions(answer.data, config, s.scope.accountId, orders?.ok ? orders.data : null), observedAt };
}
async function partialStatus(s: Session, positionIds: string[]): Promise<{ known: boolean; reserved: Set<string>; done: Set<string> }> {
  if (!positionIds.length) return { known: true, reserved: new Set(), done: new Set() };
  const [reserved, ledger] = await Promise.all([
    s.admin.from("flow_partial_operations").select("position_id").eq("environment", s.env).eq("account_id", s.scope.accountId).in("position_id", positionIds).limit(1000),
    s.admin.from("flow_managed_positions").select("position_id,partial_done").eq("user_id", s.userId).eq("account_id", s.scope.accountId).eq("environment", s.env).eq("status", "open").in("position_id", positionIds).limit(1000),
  ]);
  return { known: !reserved.error && !ledger.error && Array.isArray(reserved.data) && Array.isArray(ledger.data) && reserved.data.length < 1000 && ledger.data.length < 1000,
    reserved: new Set((reserved.data ?? []).map((r) => String(r.position_id))), done: new Set((ledger.data ?? []).filter((r) => r.partial_done).map((r) => String(r.position_id))) };
}

/** FLOW shows broker evidence for one open position tracked by this member on this account. */
export async function readFlowPositionChart(userId: string, scope: ActiveTradeScope, positionId: string): Promise<FlowPositionChart> {
  const admin = createAdminClient();
  if (!admin) throw new ActiveTradeError(503, "Position data is unavailable.");
  const owned = await ownedTradeAccount(admin, userId, scope);
  const tracked = await admin.from("flow_managed_positions").select("position_id,symbol,side")
    .eq("user_id", userId).eq("environment", scope.environment).eq("account_id", scope.accountId)
    .eq("position_id", positionId).eq("status", "open").limit(1).maybeSingle();
  if (tracked.error) throw new ActiveTradeError(503, "The selected position could not be verified.");
  const ledger = tracked.data;
  if (!ledger) throw new ActiveTradeError(404, "This account has no matching open FLOW position.");
  if (brokerBusy(brokerRateStats())) throw new ActiveTradeError(503, "Your broker is busy. Try again shortly.");
  return withBrokerPriority("background", async () => {
    const s = await session(admin, userId, scope, owned);
    const reading = await positions(s);
    const position = reading.rows.find(p => p.id === positionId);
    if (!position) throw new ActiveTradeError(404, "Your broker no longer reports this open position.");
    const symbol = contractKey(String(ledger.symbol ?? ""));
    if (!symbol || String(ledger.side).toLowerCase() !== position.side) {
      throw new ActiveTradeError(409, "The broker position does not match this FLOW trade.");
    }
    const list = await safeRead(() => instrumentList(s));
    const instrument = list?.find(i => i.tradableInstrumentId === position.instrumentId);
    const route = instrument?.infoRouteId;
    const bars = route && !brokerBusy(brokerRateStats())
      ? await safeRead(() => getPositionChartBars(s.env, s.token, String(s.row.acc_num), position.instrumentId, route, reading.observedAt))
      : null;
    return { ok: true, ...scope, positionId, side: position.side,
      symbol, brokerSymbol: instrument?.brokerSymbol || position.symbol || null,
      entry: position.entry, stop: position.stopKnown ? position.stop : null, target: position.target,
      unrealizedPnl: position.unrealizedPnl ?? null, observedAt: new Date(reading.observedAt).toISOString(), bars: bars ?? [] };
  });
}

/** Only display reads are cached. Every mutation uses new broker and permission reads. */
export async function readActiveTrades(userId: string, scope: ActiveTradeScope): Promise<ActiveTradesSnapshot> {
  const admin = createAdminClient();
  if (!admin) throw new ActiveTradeError(503, "Trading is unavailable right now.");
  const owned = await ownedTradeAccount(admin, userId, scope);
  const key = scopeKey(userId, scope), cached = snapshots.get(key);
  if (cached && Date.now() - cached.at < CACHE_MS && cached.snapshot.observedAt && Date.now() - Date.parse(cached.snapshot.observedAt) <= ACTIVE_TRADE_FRESH_MS) return cached.snapshot;
  const fallback = (note: string): ActiveTradesSnapshot => cached
    ? { ...cached.snapshot, state: "stale", note }
    : { ...scope, ok: true, observedAt: null, state: "unavailable", note, positions: [] };
  if (brokerBusy(brokerRateStats())) return fallback("The broker is busy placing or protecting trades. This is the last reading.");
  let job = reads.get(key);
  if (!job) {
    const version = versions.get(key) ?? 0;
    job = withBrokerPriority("background", async (): Promise<ActiveTradesSnapshot> => {
      const s = await session(admin, userId, scope, owned);
      const reading = await positions(s);
      const [list, partial] = await Promise.all([safeRead(() => instrumentList(s)), partialStatus(s, reading.rows.map((p) => p.id))]);
      const metadata = new Map<string, { instrument?: TLInstrument; spec: TLInstrumentSpec | null; quote: ActiveTrade["quote"] }>();
      const ids = [...new Set(reading.rows.map((p) => p.instrumentId))];
      // A display cannot monopolize the broker request budget. Additional symbols keep explicit unavailable quotes.
      for (const instrumentId of ids.slice(0, 40)) {
        if (Date.now() - reading.observedAt > READ_BUDGET_MS || brokerBusy(brokerRateStats())) break;
        const instrument = list?.find((i) => i.tradableInstrumentId === instrumentId);
        const [spec, currentQuote] = await Promise.all([instrument ? safeRead(() => instrumentSpec(s, instrument)) : Promise.resolve(null), quote(s, instrument)]);
        metadata.set(instrumentId, { instrument, spec, quote: currentQuote });
      }
      const views = reading.rows.map((position) => {
        const meta = metadata.get(position.instrumentId);
        return tradeView(scope, position, meta?.instrument?.brokerSymbol || position.symbol || `Instrument ${position.instrumentId}`,
          meta?.quote ?? activeQuote(null, Date.now()), meta?.spec ?? null, owned.permissions,
          !partial.known ? "unavailable" : partial.reserved.has(position.id) || partial.done.has(position.id) ? "reserved" : "available");
      });
      const stale = Date.now() - reading.observedAt > ACTIVE_TRADE_FRESH_MS;
      const snapshot: ActiveTradesSnapshot = { ...scope, ok: true, observedAt: new Date(reading.observedAt).toISOString(), state: stale ? "stale" : "live",
        note: stale ? "The broker took longer to answer. Refresh before making a change." : null, positions: views };
      if ((versions.get(key) ?? 0) !== version) return { ...snapshot, state: "stale", note: "A position was being changed during this reading. Refresh its current details." };
      snapshots.set(key, { at: Date.now(), snapshot });
      if (snapshots.size > 2000) snapshots.delete(snapshots.keys().next().value!);
      return snapshot;
    }).catch(() => fallback("Your broker’s positions could not be refreshed. This is the last reading.")).finally(() => reads.delete(key));
    reads.set(key, job);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback("Reading your broker. Refresh shortly for the latest positions.")), READ_BUDGET_MS);
    job!.then((answer) => { clearTimeout(timer); resolve(answer); }, () => { clearTimeout(timer); resolve(fallback("Your broker did not answer just now.")); });
  });
}

export async function actOnActiveTrade(userId: string, request: ActiveTradeActionRequest): Promise<PositionActionOutcome> {
  const refused = (message: string, status = 403, needsConsent = false): PositionActionOutcome => ({ status, body: {
    ok: false, state: "refused", message, accountId: request.accountId, environment: request.environment, positionId: request.positionId, action: request.action, ...(needsConsent ? { needsConsent } : {}),
  } });
  const admin = createAdminClient();
  if (!admin) return refused("Trading is unavailable right now.", 503);
  const key = scopeKey(userId, request), operationKey = `${key}:${request.positionId}`;
  if (mutations.has(operationKey)) return { ...refused("A change to this position is already being checked. Refresh for its result.", 409), body: { ...refused("A change to this position is already being checked. Refresh for its result.").body, state: "pending" } };
  mutations.add(operationKey);
  versions.set(key, (versions.get(key) ?? 0) + 1); snapshots.delete(key);
  try {
    const owned = await ownedTradeAccount(admin, userId, request);
    const consent = await requireConsent(userId);
    if (!consent.ok) return refused(consent.reason, 403, true);
    return await withBrokerPriority("critical", async () => {
      const s = await session(admin, userId, request, owned);
      const list = await safeRead(() => instrumentList(s));
      const specRead = new Map<string, TLInstrumentSpec | null>();
      let latest: ActiveTrade | null = null;
      let dispatchPrice: number | null = null;
      let dispatchFraction: number | null = null;
      let knownInstrumentId: string | null = null;
      const read = async () => {
        // Permissions and ownership are re-read at the final dispatch check as well as at route entry.
        const currentAccount = await ownedTradeAccount(admin, userId, request);
        if (currentAccount.row.connection_id !== s.row.connection_id || String(currentAccount.row.acc_num) !== String(s.row.acc_num)) throw new Error("connection_changed");
        if (!knownInstrumentId && request.action !== "close") {
          const initial = await positions(s), position = initial.rows.find((p) => p.id === request.positionId);
          if (!position) { latest = null; return { trade: null, observedAt: initial.observedAt }; }
          knownInstrumentId = position.instrumentId;
        }
        const instrument = list?.find((i) => i.tradableInstrumentId === knownInstrumentId);
        if (request.action !== "close" && instrument && !specRead.has(instrument.tradableInstrumentId)) specRead.set(instrument.tradableInstrumentId, await safeRead(() => instrumentSpec(s, instrument, true)));
        const [currentQuote, partial] = await Promise.all([request.action !== "close" ? quote(s, instrument) : Promise.resolve(activeQuote(null, Date.now())), request.action === "partial" ? partialStatus(s, [request.positionId]) : Promise.resolve(null)]);
        // Preparation can queue behind broker traffic. Re-read membership/quantity/stop after it; no cached position is used for a send.
        const final = await positions(s), fresh = final.rows.find((p) => p.id === request.positionId);
        if (!fresh) { latest = null; return { trade: null, observedAt: final.observedAt }; }
        if (knownInstrumentId && fresh.instrumentId !== knownInstrumentId) throw new Error("instrument_changed");
        // GET hides already-reserved partials. Here the atomic partialOnce reservation is the authority:
        // recomputing that flag after owning a reservation would make a request reject itself.
        const availability = partial && (!partial.known ? "unavailable" : partial.done.has(fresh.id) ? "reserved" : "available") || "available";
        latest = tradeView(request, fresh, instrument?.brokerSymbol || fresh.symbol || `Instrument ${fresh.instrumentId}`, currentQuote,
          specRead.get(fresh.instrumentId) ?? null, currentAccount.permissions, availability);
        return { trade: latest, observedAt: final.observedAt };
      };
      const identity = { environment: request.environment, account_id: request.accountId, position_id: request.positionId };
      const outcome = await executePositionAction(request, {
        read, now: Date.now,
        close: async (qty, notAfterMs) => {
          if (qty != null) {
            if (!latest || !quoteIsFresh(latest.quote)) throw new Error("send_deadline_passed");
            dispatchPrice = latest.side === "buy" ? latest.quote.bid : latest.quote.ask;
            dispatchFraction = Number((qty / latest.qty).toFixed(6));
            // Commit the reference alongside the durable reservation BEFORE dispatch. A crash after the
            // broker accepts must not make the manager invent a quarter-sized halfway partial later.
            const recorded = dispatchPrice != null && await writePartialReference(admin, userId, request, request.positionId, { before_qty: latest.qty, requested_qty: qty }, dispatchPrice).catch(() => false);
            if (!recorded || !quoteIsFresh(latest.quote)) throw new Error("send_deadline_passed");
          }
          return closePosition(s.env, s.token, String(s.row.acc_num), request.positionId, qty, { noResend: true, notAfterMs });
        },
        modify: (stop, notAfterMs) => modifyPosition(s.env, s.token, String(s.row.acc_num), request.positionId, { stopLoss: stop }, { noResend: true, notAfterMs }),
        partialStore: { async reserve(intent) {
          const inserted = await admin.from("flow_partial_operations").insert({ ...identity, ...intent });
          if (!inserted.error) return { created: true, intent };
          if (inserted.error.code !== "23505") throw new Error("partial_reservation_unavailable");
          const existing = await admin.from("flow_partial_operations").select("before_qty,requested_qty").match(identity).single();
          const before = Number(existing.data?.before_qty), qty = Number(existing.data?.requested_qty);
          if (existing.error || !(before > 0 && qty > 0 && qty < before)) throw new Error("partial_reservation_unavailable");
          return { created: false, intent: { before_qty: before, requested_qty: qty } };
        } },
        async releasePartial() {
          // A definite refusal must not leave a price that a later unrelated partial could inherit.
          // Clear only this attempt's unchanged, unconfirmed reference before freeing its reservation.
          if (dispatchPrice != null && dispatchFraction != null) {
            if (!await clearPartialReference(admin, userId, request, request.positionId, dispatchPrice, dispatchFraction)) throw new Error("release_unavailable");
          }
          const answer = await admin.from("flow_partial_operations").delete().match(identity);
          if (answer.error) throw new Error("release_unavailable");
        },
        async partialSent(intent, remaining) {
          // Same quote-reference convention as the existing manager. This is not asserted to be an execution fill.
          if (!(dispatchPrice != null && dispatchPrice > 0)) throw new Error("partial_price_unverified");
          await writePartialReference(admin, userId, request, request.positionId, intent, dispatchPrice, remaining);
        },
      });
      const last = latest as ActiveTrade | null;
      if (request.action === "breakeven" && outcome.body.state === "confirmed" && last?.stop != null) {
        // Adopt only broker-confirmed protection. The predicate cannot overwrite a tighter concurrent ledger stop.
        const comparison = last.side === "buy" ? "lte" : "gte";
        for (let attempt = 0; attempt < 2; attempt++) {
          const saved = await safeRead(() => Promise.resolve(admin.from("flow_managed_positions").update({ be_done: true, cur_stop: last.stop, updated_at: new Date().toISOString() })
            .eq("user_id", userId).eq("environment", s.env).eq("account_id", request.accountId).eq("position_id", request.positionId).eq("status", "open")
            .or(`cur_stop.is.null,cur_stop.${comparison}.${last.stop}`)));
          if (saved && !saved.error) break;
        }
      }
      await logTrade(admin, { user_id: userId, account_id: request.accountId, position_id: request.positionId, symbol: last?.symbol ?? "unknown",
        phase: request.action === "breakeven" ? "member_break_even" : request.action === "partial" ? "member_partial" : "member_close",
        reason: outcome.body.state, price: dispatchPrice, detail: { environment: request.environment, source: "floor_selected_account", fraction: request.fraction ?? null,
          ...(dispatchPrice != null ? { price_source: "dispatch_bid_ask_quote", actual_fill: false } : {}) } });
      return outcome;
    });
  } catch (error) {
    return refused(error instanceof ActiveTradeError ? error.message : "The selected account could not be verified. Refresh before making a change.", error instanceof ActiveTradeError ? error.status : 503);
  } finally {
    snapshots.delete(key); versions.set(key, (versions.get(key) ?? 0) + 1); mutations.delete(operationKey);
  }
}
