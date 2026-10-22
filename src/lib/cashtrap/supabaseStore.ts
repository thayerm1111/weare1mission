import type { createAdminClient } from "@/lib/supabase/admin";
import type { Candle } from "./candles";
import type { DmiEvent } from "./dmi";
import type { Decision, EngineState } from "./engine";
import type { SetupRecord } from "./replay";
import type { SignalRecord } from "./signals";
import type { Snapshot } from "./snapshot";
import { settingsFrom, type AlertInput, type CashtrapSettings, type CashtrapStore, type Correction } from "./store";
import { roundPrice, type CashtrapSymbol } from "./symbols";
import type { ManualZoneInput, Zone } from "./zones";

/**
 * The production store: Cashtrap's own Supabase tables (migration 20261021120000_cashtrap), through the
 * service-role client. Writes that the engine depends on (state, signals) throw on failure so a pass
 * stops rather than continuing on a state it could not save.
 */
export type Admin = NonNullable<ReturnType<typeof createAdminClient>>;
const iso = (ms: number | null | undefined) => (ms == null ? null : new Date(ms).toISOString());
const ms = (s: unknown) => (typeof s === "string" ? Date.parse(s) : null);
const num = (x: unknown) => (x == null ? null : Number(x));
function must<T extends { error: { message: string } | null }>(r: T, what: string): T {
  if (r.error) throw new Error(`cashtrap ${what}: ${r.error.message}`);
  return r;
}

type SignalRow = Record<string, unknown>;
export function signalToRow(s: SignalRecord): SignalRow {
  return {
    dedupe_key: s.dedupeKey, setup_id: s.setupId, symbol: s.symbol, direction: s.direction,
    setup_candle_t: iso(s.setupCandleT), confirmation_t: iso(s.confirmationT), confirmed_at: iso(s.confirmedAt), published_at: iso(s.publishedAt),
    entry_window_start: iso(s.entryWindowStart), entry_deadline: iso(s.entryDeadline), expiry_mode: s.expiryMode, expiry_duration_sec: s.expiryDurationSec, expiry_at: iso(s.expiryAt),
    reference_price: s.referencePrice, reference_at: iso(s.referenceAt), reference_source: s.referenceSource,
    settlement_price: s.settlementPrice, settlement_at: iso(s.settlementAt), settlement_source: s.settlementSource,
    status: s.status, result: s.result, record_type: s.recordType, payout_rate: s.payoutRate, payout: s.payout,
    exhaustion_values: s.exhaustionValues, confirmation_values: s.confirmationValues, zone: s.zone,
    strategy_version: s.strategyVersion, config_version: s.configVersion, notes: s.notes, updated_at: new Date().toISOString(),
  };
}
export function signalFromRow(r: SignalRow): SignalRecord {
  return {
    dedupeKey: String(r.dedupe_key), setupId: String(r.setup_id), symbol: r.symbol as CashtrapSymbol, direction: r.direction as "CALL" | "PUT",
    setupCandleT: ms(r.setup_candle_t) as number, confirmationT: ms(r.confirmation_t) as number, confirmedAt: ms(r.confirmed_at) as number, publishedAt: ms(r.published_at) as number,
    entryWindowStart: ms(r.entry_window_start) as number, entryDeadline: ms(r.entry_deadline) as number,
    expiryMode: r.expiry_mode as "duration" | "fixed", expiryDurationSec: num(r.expiry_duration_sec), expiryAt: ms(r.expiry_at),
    referencePrice: num(r.reference_price), referenceAt: ms(r.reference_at), referenceSource: (r.reference_source as string) ?? null,
    settlementPrice: num(r.settlement_price), settlementAt: ms(r.settlement_at), settlementSource: (r.settlement_source as string) ?? null,
    status: r.status as SignalRecord["status"], result: r.result as SignalRecord["result"], recordType: r.record_type as SignalRecord["recordType"],
    payoutRate: num(r.payout_rate), payout: num(r.payout),
    exhaustionValues: r.exhaustion_values as SignalRecord["exhaustionValues"], confirmationValues: r.confirmation_values as SignalRecord["confirmationValues"], zone: (r.zone as SignalRecord["zone"]) ?? null,
    strategyVersion: String(r.strategy_version), configVersion: String(r.config_version), notes: Array.isArray(r.notes) ? (r.notes as string[]) : [],
  };
}
export function decisionFromRow(r: Record<string, unknown>): Decision {
  return {
    symbol: r.symbol as CashtrapSymbol, candleT: ms(r.candle_t) as number, decidedAt: ms(r.decided_at) as number, status: r.status as Decision["status"],
    direction: (r.direction as Decision["direction"]) ?? null, leading: (r.leading_dir as Decision["leading"]) ?? null, checklist: (r.checklist as Decision["checklist"]) ?? null,
    met: Number(r.met ?? 0), reasonCode: String(r.reason_code), reason: String(r.reason), values: (r.ind_values as Decision["values"]) ?? null,
    zoneId: (r.zone_id as string) ?? null, setupId: (r.setup_id as string) ?? null, strategyVersion: String(r.strategy_version), configVersion: String(r.config_version),
  };
}
export function zoneToRow(z: Zone): Record<string, unknown> {
  return {
    id: z.id, symbol: z.symbol, kind: z.kind, origin: z.origin, lower: z.lower, upper: z.upper, center: z.center, pivot_t: iso(z.pivotT),
    created_at: iso(z.createdAt), confirmed_at: iso(z.confirmedAt), atr_at_creation: z.atrAtCreation, half_width: z.halfWidth, touches: z.touches,
    first_touch_t: iso(z.firstTouchT), last_touch_t: iso(z.lastTouchT), invalidated_at: iso(z.invalidatedAt), invalidated_by_close: z.invalidatedByClose,
    updated_at: new Date().toISOString(),
  };
}

export class SupabaseStore implements CashtrapStore {
  constructor(private db: Admin) {}

  async acquireLock(holder: string, ttlMs: number, nowMs: number) {
    const r = must(await this.db.from("cashtrap_lock").update({ holder, expires_at: iso(nowMs + ttlMs) }).eq("id", 1)
      .or(`holder.is.null,holder.eq."${holder}",expires_at.lt."${iso(nowMs)}"`).select("id"), "lock");
    return !!r.data?.length;
  }
  async releaseLock(holder: string, nowMs: number) {
    await this.db.from("cashtrap_lock").update({ holder: null, expires_at: iso(nowMs) }).eq("id", 1).eq("holder", holder);
  }
  /** Throws when the settings cannot be read — the defaults are never used in their place (they would switch a stopped runner back on). */
  async getSettings(): Promise<CashtrapSettings> {
    const r = must(await this.db.from("cashtrap_settings").select("*").eq("id", 1).maybeSingle(), "settings read");
    if (!r.data) throw new Error("cashtrap settings row is missing");
    return settingsFrom(r.data as Record<string, unknown>).settings;
  }
  async loadCandles(symbol: CashtrapSymbol, limit: number): Promise<Candle[]> {
    const out: Candle[] = [];
    const page = 1000;
    for (let from = 0; from < limit; from += page) {
      const r = must(await this.db.from("cashtrap_candles").select("t,o,h,l,c").eq("symbol", symbol).order("t", { ascending: false }).range(from, Math.min(limit, from + page) - 1), "candles");
      const rows = (r.data ?? []) as Array<{ t: string; o: unknown; h: unknown; l: unknown; c: unknown }>;
      for (const x of rows) out.push({ t: Date.parse(x.t), o: Number(x.o), h: Number(x.h), l: Number(x.l), c: Number(x.c) });
      if (rows.length < Math.min(page, limit - from)) break;
    }
    return out.reverse();
  }
  async upsertCandles(symbol: CashtrapSymbol, candles: Candle[], source: string, nowMs: number) {
    if (!candles.length) return { added: 0, corrections: [] as Correction[] };
    const lo = candles[0].t, hi = candles[candles.length - 1].t;
    // Read what is stored in pages of 1,000 (the API's row cap), so a long history is compared in full.
    const have = new Map<number, { k: Candle; revision: number }>();
    for (let from = 0; ; from += 1000) {
      const ex = must(await this.db.from("cashtrap_candles").select("t,o,h,l,c,revision").eq("symbol", symbol).gte("t", iso(lo)).lte("t", iso(hi)).order("t", { ascending: true }).range(from, from + 999), "candles read");
      const rows = (ex.data ?? []) as Array<{ t: string; o: unknown; h: unknown; l: unknown; c: unknown; revision: number }>;
      for (const x of rows) have.set(Date.parse(x.t), { k: { t: Date.parse(x.t), o: Number(x.o), h: Number(x.h), l: Number(x.l), c: Number(x.c) }, revision: x.revision ?? 0 });
      if (rows.length < 1000) break;
    }
    const fresh = candles.filter((k) => !have.has(k.t));
    for (let i = 0; i < fresh.length; i += 1000) {
      must(await this.db.from("cashtrap_candles").upsert(fresh.slice(i, i + 1000).map((k) => ({ symbol, t: iso(k.t), o: k.o, h: k.h, l: k.l, c: k.c, source, first_seen_at: iso(nowMs), last_seen_at: iso(nowMs) })), { onConflict: "symbol,t", ignoreDuplicates: true }), "candles insert");
    }
    const corrections: Correction[] = [];
    for (const k of candles) {
      const prev = have.get(k.t);
      if (!prev) continue;
      const same = (["o", "h", "l", "c"] as const).every((f) => roundPrice(symbol, prev.k[f]) === roundPrice(symbol, k[f]));
      if (same) continue;
      must(await this.db.from("cashtrap_candles").update({ o: k.o, h: k.h, l: k.l, c: k.c, source, last_seen_at: iso(nowMs), revision: prev.revision + 1 }).eq("symbol", symbol).eq("t", iso(k.t)), "candle correction");
      must(await this.db.from("cashtrap_data_corrections").insert({ symbol, t: iso(k.t), before_ohlc: prev.k, after_ohlc: k, detected_at: iso(nowMs) }), "correction log");
      corrections.push({ symbol, t: k.t, before: prev.k, after: k, at: nowMs });
    }
    return { added: fresh.length, corrections };
  }
  async loadState(symbol: CashtrapSymbol): Promise<EngineState | null> {
    const r = must(await this.db.from("cashtrap_state").select("state").eq("symbol", symbol).maybeSingle(), "state read");
    return ((r.data as { state?: EngineState } | null)?.state as EngineState) ?? null;
  }
  async saveState(state: EngineState, nowMs: number) {
    must(await this.db.from("cashtrap_state").upsert({ symbol: state.symbol, state, last_candle_t: iso(state.lastT), updated_at: iso(nowMs) }, { onConflict: "symbol" }), "state write");
  }
  async recordDecision(d: Decision) {
    must(await this.db.from("cashtrap_decisions").upsert({
      symbol: d.symbol, candle_t: iso(d.candleT), decided_at: iso(d.decidedAt), status: d.status, direction: d.direction, leading_dir: d.leading, met: d.met,
      reason_code: d.reasonCode, reason: d.reason, checklist: d.checklist, ind_values: d.values, zone_id: d.zoneId, setup_id: d.setupId,
      strategy_version: d.strategyVersion, config_version: d.configVersion,
    }, { onConflict: "symbol,candle_t,strategy_version", ignoreDuplicates: true }), "decision");
  }
  async saveSetup(r: SetupRecord, v: { strategyVersion: string; configVersion: string }) {
    must(await this.db.from("cashtrap_setups").upsert({
      id: r.id, symbol: r.symbol, direction: r.direction, exhaustion_t: iso(r.exhaustionT), armed_at: iso(r.armedAt), status: r.status, reason: r.reason,
      ended_at: iso(r.endedAt), confirm_t: iso(r.confirmT), published: r.published, suppressed_reason: r.suppressedReason,
      zone: r.setup.zone, ind_values: r.setup.values, checklist: r.setup.checklist, strategy_version: v.strategyVersion, config_version: v.configVersion, updated_at: new Date().toISOString(),
    }, { onConflict: "id" }), "setup");
  }
  async insertSignal(s: SignalRecord) {
    const r = await this.db.from("cashtrap_signals").insert(signalToRow(s));
    if (r.error) { if ((r.error as { code?: string }).code === "23505") return false; throw new Error(`cashtrap signal insert: ${r.error.message}`); }
    return true;
  }
  async updateSignal(s: SignalRecord) {
    must(await this.db.from("cashtrap_signals").update(signalToRow(s)).eq("dedupe_key", s.dedupeKey), "signal update");
  }
  async openSignals() {
    const r = must(await this.db.from("cashtrap_signals").select("*").in("status", ["published", "active"]).limit(200), "open signals");
    return ((r.data ?? []) as SignalRow[]).map(signalFromRow);
  }
  async latestSignal(symbol: CashtrapSymbol) {
    const r = must(await this.db.from("cashtrap_signals").select("*").eq("symbol", symbol).order("published_at", { ascending: false }).limit(1), "latest signal");
    const row = ((r.data ?? []) as SignalRow[])[0];
    return row ? signalFromRow(row) : null;
  }
  async manualZones(symbol: CashtrapSymbol): Promise<ManualZoneInput[]> {
    const r = must(await this.db.from("cashtrap_zones").select("id,symbol,kind,lower,upper,active_from,active_until,created_at,note,invalidated_at,invalidated_by_close").eq("symbol", symbol).eq("origin", "manual").order("created_at", { ascending: false }).limit(500), "manual zones");   // newest first: a new zone is never left out
    return ((r.data ?? []) as Array<Record<string, unknown>>).map((z) => ({
      id: String(z.id), symbol, kind: z.kind as ManualZoneInput["kind"], lower: Number(z.lower), upper: Number(z.upper),
      activeFrom: (ms(z.active_from) ?? ms(z.created_at)) as number, activeUntil: ms(z.active_until), note: (z.note as string) ?? null,
      invalidatedAt: ms(z.invalidated_at), invalidatedByClose: num(z.invalidated_by_close),
    }));
  }
  async markManualZoneBroken(id: string, at: number, close: number) {
    must(await this.db.from("cashtrap_zones").update({ invalidated_at: iso(at), invalidated_by_close: close, updated_at: new Date().toISOString() }).eq("id", id).eq("origin", "manual").is("invalidated_at", null), "zone break");
  }
  async saveAutoZones(_symbol: CashtrapSymbol, zones: Zone[]) {
    const auto = zones.filter((z) => z.origin === "auto");
    if (auto.length) must(await this.db.from("cashtrap_zones").upsert(auto.map(zoneToRow), { onConflict: "id" }), "zones");
  }
  async dmiEvents(symbol: CashtrapSymbol, fromT: number, toT: number): Promise<DmiEvent[]> {
    const r = must(await this.db.from("cashtrap_dmi_events").select("symbol,candle_t,type,source,received_at").eq("symbol", symbol).gte("candle_t", iso(fromT)).lte("candle_t", iso(toT)).limit(200), "dmi events");
    return ((r.data ?? []) as Array<Record<string, unknown>>).map((e) => ({ symbol, candleT: ms(e.candle_t) as number, type: e.type as "B" | "S", source: String(e.source), knownAt: ms(e.received_at) as number }));
  }
  async saveSnapshot(s: Snapshot) {
    must(await this.db.from("cashtrap_snapshots").upsert({ symbol: s.symbol, snapshot: s, updated_at: iso(s.updatedAt) }, { onConflict: "symbol" }), "snapshot");
  }
  async snapshot(symbol: CashtrapSymbol): Promise<Snapshot | null> {
    const r = await this.db.from("cashtrap_snapshots").select("snapshot").eq("symbol", symbol).maybeSingle();
    return ((r.data as { snapshot?: Snapshot } | null)?.snapshot as Snapshot) ?? null;
  }
  async latestDecision(symbol: CashtrapSymbol): Promise<Decision | null> {
    const r = await this.db.from("cashtrap_decisions").select("*").eq("symbol", symbol).order("candle_t", { ascending: false }).limit(1);
    const row = ((r.data ?? []) as Array<Record<string, unknown>>)[0];
    return row ? decisionFromRow(row) : null;
  }
  async createAlert(a: AlertInput, nowMs: number) {
    const r = must(await this.db.from("cashtrap_alerts").upsert({
      dedupe_key: a.dedupeKey, kind: a.kind, symbol: a.symbol ?? null, signal_key: a.signalKey ?? null, setup_id: a.setupId ?? null,
      title: a.title, body: a.body, payload: a.payload ?? null, created_at: iso(nowMs),
    }, { onConflict: "dedupe_key", ignoreDuplicates: true }).select("id"), "alert");
    const row = ((r.data ?? []) as Array<{ id: number }>)[0];
    return { created: !!row, id: row?.id ?? null };
  }
  async reserveDelivery(alertId: number, channel: string, recipient: string, nowMs: number) {
    const r = await this.db.from("cashtrap_alert_deliveries").insert({ alert_id: alertId, channel, recipient, status: "sending", attempted_at: iso(nowMs) });
    if (r.error) { if ((r.error as { code?: string }).code === "23505") return false; throw new Error(`cashtrap delivery reserve: ${r.error.message}`); }
    return true;
  }
  async finishDelivery(alertId: number, channel: string, recipient: string, ok: boolean, error: string | null) {
    await this.db.from("cashtrap_alert_deliveries").update({ status: ok ? "sent" : "failed", error }).eq("alert_id", alertId).eq("channel", channel).eq("recipient", recipient);
  }
}
