import type { Candle } from "./candles";
import { DEFAULT_ASSUMPTIONS, resolveAssumptions, type Assumptions } from "./config";
import type { DmiEvent, DmiMode } from "./dmi";
import type { Decision, EngineState } from "./engine";
import type { SetupRecord } from "./replay";
import type { SignalRecord } from "./signals";
import { roundPrice, type CashtrapSymbol } from "./symbols";
import type { ManualZoneInput, Zone } from "./zones";
import type { Snapshot } from "./snapshot";

/**
 * CASHTRAP PERSISTENCE — one interface, two implementations: Supabase (production, supabaseStore.ts)
 * and memory (tests, offline replay). The live service only talks to this interface, so a restart test
 * can throw the service away and build a new one on the same store.
 */
export type CashtrapSettings = {
  assumptions: Assumptions;
  visibility: "admin" | "members";
  dmiMode: DmiMode;
  dmiFeedVerified: boolean;
  liveEnabled: boolean;
  updatedAt: number | null;
};

export const DEFAULT_SETTINGS: CashtrapSettings = { assumptions: DEFAULT_ASSUMPTIONS, visibility: "admin", dmiMode: "calculation", dmiFeedVerified: false, liveEnabled: true, updatedAt: null };

/** Settings as stored → validated settings. Invalid stored assumptions fall back to the defaults (and say so). */
export function settingsFrom(row: { assumptions?: unknown; visibility?: unknown; dmi_mode?: unknown; dmi_feed_verified?: unknown; live_enabled?: unknown; updated_at?: unknown } | null): { settings: CashtrapSettings; warnings: string[] } {
  if (!row) return { settings: DEFAULT_SETTINGS, warnings: [] };
  const r = resolveAssumptions(row.assumptions ?? {});
  return {
    settings: {
      assumptions: r.ok ? r.value : DEFAULT_ASSUMPTIONS,
      visibility: row.visibility === "members" ? "members" : "admin",
      dmiMode: row.dmi_mode === "event-feed" || row.dmi_mode === "off" ? row.dmi_mode : "calculation",
      dmiFeedVerified: row.dmi_feed_verified === true,
      liveEnabled: row.live_enabled !== false,
      updatedAt: typeof row.updated_at === "string" ? Date.parse(row.updated_at) : null,
    },
    warnings: r.ok ? [] : [`stored assumptions are invalid (${r.errors.join("; ")}); defaults are in use`],
  };
}

export type Correction = { symbol: CashtrapSymbol; t: number; before: Candle; after: Candle; at: number };
export type AlertInput = { dedupeKey: string; kind: "armed" | "signal" | "entry" | "missed" | "outcome" | "data"; symbol?: CashtrapSymbol | null; signalKey?: string | null; setupId?: string | null; title: string; body: string; payload?: unknown };
export type AlertRow = AlertInput & { id: number; createdAt: number };

export interface CashtrapStore {
  acquireLock(holder: string, ttlMs: number, nowMs: number): Promise<boolean>;
  releaseLock(holder: string, nowMs: number): Promise<void>;
  /** A run waiting for the lock says so (the mark lapses after a few seconds unless renewed). */
  markWaiting(holder: string, nowMs: number): Promise<void>;
  /** Is another run waiting for the lock right now? */
  successorWaiting(holder: string, nowMs: number): Promise<boolean>;
  getSettings(): Promise<CashtrapSettings>;
  /** The most recent `limit` completed candles, oldest → newest. */
  loadCandles(symbol: CashtrapSymbol, limit: number): Promise<Candle[]>;
  /** Store completed candles; a stored candle that comes back different is a logged correction. */
  upsertCandles(symbol: CashtrapSymbol, candles: Candle[], source: string, nowMs: number): Promise<{ added: number; corrections: Correction[] }>;
  loadState(symbol: CashtrapSymbol): Promise<EngineState | null>;
  saveState(state: EngineState, nowMs: number): Promise<void>;
  /** Permanent: a decision already recorded for the candle is kept, never rewritten. */
  recordDecision(d: Decision): Promise<void>;
  saveSetup(r: SetupRecord, versions: { strategyVersion: string; configVersion: string }): Promise<void>;
  /** False when a signal for the same setup already exists (published at most once). */
  insertSignal(s: SignalRecord): Promise<boolean>;
  updateSignal(s: SignalRecord): Promise<void>;
  /** Signals not yet finished (published or active). */
  openSignals(): Promise<SignalRecord[]>;
  latestSignal(symbol: CashtrapSymbol): Promise<SignalRecord | null>;
  manualZones(symbol: CashtrapSymbol): Promise<ManualZoneInput[]>;
  /** Record that a manual zone was broken by a completed close (first break only). */
  markManualZoneBroken(id: string, at: number, close: number): Promise<void>;
  saveAutoZones(symbol: CashtrapSymbol, zones: Zone[]): Promise<void>;
  dmiEvents(symbol: CashtrapSymbol, fromT: number, toT: number): Promise<DmiEvent[]>;
  saveSnapshot(s: Snapshot): Promise<void>;
  snapshot(symbol: CashtrapSymbol): Promise<Snapshot | null>;
  latestDecision(symbol: CashtrapSymbol): Promise<Decision | null>;
  /** At most one alert per dedupe key, ever. */
  createAlert(a: AlertInput, nowMs: number): Promise<{ created: boolean; id: number | null }>;
  /** Reserve one delivery of an alert to a channel and recipient; false when it was already reserved (so it is never sent twice). */
  reserveDelivery(alertId: number, channel: string, recipient: string, nowMs: number): Promise<boolean>;
  finishDelivery(alertId: number, channel: string, recipient: string, ok: boolean, error: string | null): Promise<void>;
}

/* ── in memory ────────────────────────────────────────────────────────────────────────────────── */
const same = (symbol: CashtrapSymbol, a: Candle, b: Candle) => (["o", "h", "l", "c"] as const).every((f) => roundPrice(symbol, a[f]) === roundPrice(symbol, b[f]));

export class MemoryStore implements CashtrapStore {
  settings: CashtrapSettings = DEFAULT_SETTINGS;
  lock: { holder: string | null; expiresAt: number } = { holder: null, expiresAt: 0 };
  candles = new Map<string, Map<number, Candle>>();
  corrections: Correction[] = [];
  states = new Map<string, EngineState>();
  decisions = new Map<string, Decision>();
  setups = new Map<string, SetupRecord>();
  signals = new Map<string, SignalRecord>();
  manual: ManualZoneInput[] = [];
  zones = new Map<string, Zone>();
  events: DmiEvent[] = [];
  snapshots = new Map<string, Snapshot>();
  alerts: AlertRow[] = [];

  async acquireLock(holder: string, ttlMs: number, nowMs: number) {
    if (this.lock.holder && this.lock.holder !== holder && this.lock.expiresAt > nowMs) return false;
    this.lock = { holder, expiresAt: nowMs + ttlMs };
    return true;
  }
  async releaseLock(holder: string, nowMs: number) { if (this.lock.holder === holder) this.lock = { holder: null, expiresAt: nowMs }; }
  waiting: { holder: string; expiresAt: number } | null = null;
  async markWaiting(holder: string, nowMs: number) { this.waiting = { holder, expiresAt: nowMs + 3_000 }; }
  async successorWaiting(holder: string, nowMs: number) { return !!this.waiting && this.waiting.holder !== holder && this.waiting.expiresAt > nowMs; }
  async getSettings() { return this.settings; }
  async loadCandles(symbol: CashtrapSymbol, limit: number) {
    const all = [...(this.candles.get(symbol)?.values() ?? [])].sort((a, b) => a.t - b.t);
    return all.slice(Math.max(0, all.length - limit)).map((k) => ({ ...k }));
  }
  async upsertCandles(symbol: CashtrapSymbol, candles: Candle[], _source: string, nowMs: number) {
    let m = this.candles.get(symbol);
    if (!m) { m = new Map(); this.candles.set(symbol, m); }
    let added = 0;
    const corrections: Correction[] = [];
    for (const k of candles) {
      const prev = m.get(k.t);
      if (!prev) { m.set(k.t, { ...k }); added += 1; continue; }
      if (!same(symbol, prev, k)) { corrections.push({ symbol, t: k.t, before: prev, after: { ...k }, at: nowMs }); m.set(k.t, { ...k }); }
    }
    this.corrections.push(...corrections);
    return { added, corrections };
  }
  async loadState(symbol: CashtrapSymbol) { const s = this.states.get(symbol); return s ? JSON.parse(JSON.stringify(s)) : null; }
  async saveState(state: EngineState) { this.states.set(state.symbol, JSON.parse(JSON.stringify(state))); }
  async recordDecision(d: Decision) { const k = `${d.symbol}|${d.candleT}|${d.strategyVersion}`; if (!this.decisions.has(k)) this.decisions.set(k, d); }
  async saveSetup(r: SetupRecord) { this.setups.set(r.id, JSON.parse(JSON.stringify(r))); }
  async insertSignal(s: SignalRecord) {
    if (this.signals.has(s.dedupeKey) || [...this.signals.values()].some((x) => x.setupId === s.setupId)) return false;
    this.signals.set(s.dedupeKey, JSON.parse(JSON.stringify(s)));
    return true;
  }
  async updateSignal(s: SignalRecord) { this.signals.set(s.dedupeKey, JSON.parse(JSON.stringify(s))); }
  async openSignals() { return [...this.signals.values()].filter((s) => s.status === "published" || s.status === "active").map((s) => JSON.parse(JSON.stringify(s))); }
  async latestSignal(symbol: CashtrapSymbol) { return [...this.signals.values()].filter((s) => s.symbol === symbol).sort((a, b) => b.publishedAt - a.publishedAt)[0] ?? null; }
  async manualZones(symbol: CashtrapSymbol) { return this.manual.filter((z) => z.symbol === symbol).map((z) => ({ ...z })); }
  async markManualZoneBroken(id: string, at: number, close: number) {
    const z = this.manual.find((x) => x.id === id);
    if (z && z.invalidatedAt == null) { z.invalidatedAt = at; z.invalidatedByClose = close; }
  }
  async saveAutoZones(_symbol: CashtrapSymbol, zones: Zone[]) { for (const z of zones) this.zones.set(z.id, { ...z }); }
  async dmiEvents(symbol: CashtrapSymbol, fromT: number, toT: number) { return this.events.filter((e) => e.symbol === symbol && e.candleT >= fromT && e.candleT <= toT); }
  async saveSnapshot(s: Snapshot) { this.snapshots.set(s.symbol, JSON.parse(JSON.stringify(s))); }
  async snapshot(symbol: CashtrapSymbol) { const s = this.snapshots.get(symbol); return s ? JSON.parse(JSON.stringify(s)) : null; }
  async latestDecision(symbol: CashtrapSymbol) { return [...this.decisions.values()].filter((d) => d.symbol === symbol).sort((a, b) => b.candleT - a.candleT)[0] ?? null; }
  async createAlert(a: AlertInput, nowMs: number) {
    if (this.alerts.some((x) => x.dedupeKey === a.dedupeKey)) return { created: false, id: null };
    const id = this.alerts.length + 1;
    this.alerts.push({ ...a, id, createdAt: nowMs });
    return { created: true, id };
  }
  deliveries = new Map<string, { status: "sending" | "sent" | "failed"; error: string | null; at: number }>();
  async reserveDelivery(alertId: number, channel: string, recipient: string, nowMs: number) {
    const k = `${alertId}|${channel}|${recipient}`;
    if (this.deliveries.has(k)) return false;
    this.deliveries.set(k, { status: "sending", error: null, at: nowMs });
    return true;
  }
  async finishDelivery(alertId: number, channel: string, recipient: string, ok: boolean, error: string | null) {
    const k = `${alertId}|${channel}|${recipient}`;
    const d = this.deliveries.get(k);
    if (d) this.deliveries.set(k, { ...d, status: ok ? "sent" : "failed", error });
  }
}
