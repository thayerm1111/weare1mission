import { createAdminClient } from "@/lib/supabase/admin";
import { addEvent, LIVE_STATES, readControl, readSettings, tradeFrom, updateControl, type ControlRow, type Db, type TradeRow } from "@/lib/fxscalper/store";
import type { Settings } from "@/lib/fxscalper/settings";

/**
 * Everything the worker reads and writes in its database, behind one interface: the Supabase one below
 * in production, an in-memory one in the tests (tests/fxscalper-worker.test.ts). Trade rows only ever
 * move through the fenced RPC (fx_scalper_update_trade): a worker that has lost the lease can no longer
 * write anything about a trade.
 */

export type ConnectionRow = {
  id: string; server: string; email_masked: string; enc_email: string | null; enc_password: string | null; enc_refresh: string;
  enc_access: string | null; access_expires_at: string | null; status: string; last_error: string | null; last_auth_at: string | null;
};
export type DayRow = { day: string; starts_at: string; start_equity: number | null; start_eligible_equity: number | null; limit_amount: number | null; limit_hit_at: string | null };
export type CommandRow = { id: string; kind: "close_bot" | "emergency" | "close_account_all"; created_at: string; status: string; claimed_fence?: number | null };
export type EventInput = { level?: "info" | "warn" | "error"; kind: string; message: string; pair?: string | null; tradeId?: string | null; data?: Record<string, unknown> };

export interface WorkerStore {
  acquireLease(owner: string, ttlMs: number): Promise<{ acquired: boolean; fence: number }>;
  /** true = still ours; false = gone; null = could not tell. */
  extendLease(owner: string, fence: number, ttlMs: number): Promise<boolean | null>;
  releaseLease(owner: string, fence: number): Promise<void>;
  readControl(): Promise<ControlRow>;
  updateControl(patch: Partial<ControlRow>, by: string | null, expect?: number | null): Promise<{ ok: boolean; version: number | null; reason: string }>;
  readSettings(): Promise<{ settings: Settings; version: number; warnings: string[] }>;
  event(e: EventInput): Promise<void>;
  readConnection(id: string): Promise<ConnectionRow | null>;
  saveConnection(id: string, patch: Partial<ConnectionRow>): Promise<void>;
  saveInstrument(row: Record<string, unknown>): Promise<void>;
  reserveTrade(inp: { owner: string; fence: number; controlVersion: number; maxLive: number; maxRisk: number; row: Record<string, unknown> }): Promise<{ id: string | null; reason: string }>;
  updateTrade(owner: string, fence: number, id: string, from: string[] | null, patch: Partial<TradeRow>): Promise<boolean>;
  liveTrades(): Promise<TradeRow[]>;
  tradeById(id: string): Promise<TradeRow | null>;
  /** undefined = could not read. */
  tradeByTag(tag: string): Promise<TradeRow | null | undefined>;
  recentClosed(limit: number): Promise<TradeRow[]>;
  closedSince(sinceIso: string): Promise<TradeRow[]>;
  recentFills(limit: number): Promise<TradeRow[]>;
  countTodaysTrades(sinceIso: string): Promise<number>;
  readDay(key: string): Promise<DayRow | null>;
  startDay(row: DayRow): Promise<DayRow>;
  markDayLimit(key: string, atIso: string): Promise<void>;
  writeStatus(worker: string, snapshot: Record<string, unknown>): Promise<void>;
  /** Commands waiting, and commands left running by a worker with an older lease (it is gone). */
  pendingCommands(fence: number): Promise<CommandRow[]>;
  claimCommand(id: string, fence: number): Promise<boolean>;
  finishCommand(id: string, ok: boolean, result: Record<string, unknown>): Promise<void>;
  /** Paid compensation recorded as left in this account (not risk capital). */
  paidIntoAccount(): Promise<number>;
}

const num = (v: unknown) => (v == null ? null : Number(v));

/**
 * Every database call is bounded: a call that hangs (a half-open socket) must not hold a trade's time
 * exit hostage. The request itself may still complete later; trade writes are compare-and-set, so a
 * write that lands after its caller gave up is found and resynced on the next pass.
 */
export const DB_TIMEOUT_MS = 8000;
export async function timed<T>(p: PromiseLike<T>, what: string, ms = DB_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(p),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: the database did not answer within ${ms} ms`)), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function supabaseStore(): WorkerStore {
  let cached: Db | null = null;
  const db = (): Db => {
    if (cached) return cached;
    const c = createAdminClient();
    if (!c) throw new Error("fx_scalper: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
    cached = c;
    return c;
  };
  const rows = (data: unknown) => ((data ?? []) as Record<string, unknown>[]).map(tradeFrom);
  const dayFrom = (d: DayRow): DayRow => ({ ...d, start_equity: num(d.start_equity), start_eligible_equity: num(d.start_eligible_equity), limit_amount: num(d.limit_amount) });

  return {
    async acquireLease(owner, ttlMs) {
      const { data, error } = await timed(db().rpc("fx_scalper_acquire_lease", { p_owner: owner, p_ttl_ms: ttlMs }), "lease");
      if (error) throw new Error(`lease: ${error.message}`);
      const row = (Array.isArray(data) ? data[0] : data) as { fence?: number; acquired?: boolean } | undefined;
      return { acquired: Boolean(row?.acquired), fence: Number(row?.fence ?? 0) };
    },
    async extendLease(owner, fence, ttlMs) {
      let data: unknown, error: unknown;
      try { ({ data, error } = await timed(db().rpc("fx_scalper_extend_lease", { p_owner: owner, p_fence: fence, p_ttl_ms: ttlMs }), "lease")); } catch { return null; }
      if (error) return null;
      return data === true;
    },
    async releaseLease(owner, fence) {
      try { await timed(db().rpc("fx_scalper_release_lease", { p_owner: owner, p_fence: fence }), "lease", 3000); } catch { /* the TTL expires it */ }
    },
    readControl: () => timed(readControl(db()), "control"),
    updateControl: (patch, by, expect = null) => timed(updateControl(db(), patch, by, expect), "control update"),
    readSettings: () => timed(readSettings(db()), "settings"),
    event: (e) => timed(addEvent(db(), e), "journal", 5000).catch(() => undefined),
    async readConnection(id) {
      const { data, error } = await timed(db().from("fx_scalper_connections").select("*").eq("id", id).maybeSingle(), "connection");
      if (error) throw new Error(`connection unreadable: ${error.message}`);
      return (data as ConnectionRow | null) ?? null;
    },
    async saveConnection(id, patch) {
      const { error } = await timed(db().from("fx_scalper_connections").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id), "connection");
      if (error) throw new Error(`connection not saved: ${error.message}`);
    },
    async saveInstrument(row) {
      const { error } = await timed(db().from("fx_scalper_instruments").upsert({ ...row, resolved_at: new Date().toISOString() }, { onConflict: "pair" }), "instrument");
      if (error) throw new Error(`instrument not saved: ${error.message}`);
    },
    async reserveTrade(inp) {
      const { data, error } = await timed(db().rpc("fx_scalper_reserve", {
        p_owner: inp.owner, p_fence: inp.fence, p_control_version: inp.controlVersion, p_max_live: inp.maxLive, p_max_risk: inp.maxRisk, p_row: inp.row,
      }), "reserve");
      if (error) return { id: null, reason: `could not reserve: ${error.message}` };
      const r = (Array.isArray(data) ? data[0] : data) as { trade_id?: string | null; created?: boolean; reason?: string } | undefined;
      return r?.created && r.trade_id ? { id: r.trade_id, reason: "reserved" } : { id: null, reason: r?.reason ?? "not reserved" };
    },
    async updateTrade(owner, fence, id, from, patch) {
      const { data, error } = await timed(db().rpc("fx_scalper_update_trade", { p_owner: owner, p_fence: fence, p_id: id, p_from: from, p_patch: patch }), "trade update");
      if (error) throw new Error(`trade update failed: ${error.message}`);
      return data === true;
    },
    async liveTrades() {
      const { data, error } = await timed(db().from("fx_scalper_trades").select("*").in("state", LIVE_STATES as unknown as string[]).order("created_at", { ascending: true }), "trades");
      if (error) throw new Error(`trades unreadable: ${error.message}`);
      return rows(data);
    },
    async tradeById(id) {
      const { data, error } = await timed(db().from("fx_scalper_trades").select("*").eq("id", id).maybeSingle(), "trade");
      if (error) throw new Error(`trade unreadable: ${error.message}`);
      return data ? tradeFrom(data as Record<string, unknown>) : null;
    },
    async tradeByTag(tag) {
      let data: unknown, error: unknown;
      try { ({ data, error } = await timed(db().from("fx_scalper_trades").select("*").eq("tag", tag).maybeSingle(), "trade by label")); } catch { return undefined; }
      if (error) return undefined;
      return data ? tradeFrom(data as Record<string, unknown>) : null;
    },
    async recentClosed(limit) {
      const { data, error } = await timed(db().from("fx_scalper_trades").select("*").eq("state", "closed").order("closed_at", { ascending: false }).limit(limit), "closed trades");
      if (error) throw new Error(`closed trades unreadable: ${error.message}`);
      return rows(data);
    },
    async closedSince(sinceIso) {
      const { data, error } = await timed(db().from("fx_scalper_trades").select("*").eq("state", "closed").gte("closed_at", sinceIso).order("closed_at", { ascending: true }), "closed trades");
      if (error) throw new Error(`closed trades unreadable: ${error.message}`);
      return rows(data);
    },
    async recentFills(limit) {
      const { data, error } = await timed(db().from("fx_scalper_trades").select("*").not("fill_price", "is", null).order("filled_at", { ascending: false }).limit(limit), "fills");
      if (error) throw new Error(`fills unreadable: ${error.message}`);
      return rows(data);
    },
    async countTodaysTrades(sinceIso) {
      const { count, error } = await timed(db().from("fx_scalper_trades").select("id", { count: "exact", head: true }).gte("created_at", sinceIso).not("order_id", "is", null), "order count");
      return error ? 0 : count ?? 0;
    },
    async readDay(key) {
      const { data, error } = await timed(db().from("fx_scalper_days").select("*").eq("day", key).maybeSingle(), "day");
      if (error) throw new Error(`day unreadable: ${error.message}`);
      return data ? dayFrom(data as DayRow) : null;
    },
    async startDay(row) {
      // Written once (the first reading of the day) and never moved.
      const { error } = await timed(db().from("fx_scalper_days").upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: "day", ignoreDuplicates: true }), "day");
      if (error) throw new Error(`day not saved: ${error.message}`);
      const { data } = await timed(db().from("fx_scalper_days").select("*").eq("day", row.day).maybeSingle(), "day");
      return data ? dayFrom(data as DayRow) : row;
    },
    async markDayLimit(key, atIso) {
      await timed(db().from("fx_scalper_days").update({ limit_hit_at: atIso, updated_at: new Date().toISOString() }).eq("day", key).is("limit_hit_at", null), "day");
    },
    async writeStatus(worker, snapshot) {
      try { await timed(db().from("fx_scalper_status").upsert({ id: 1, at: new Date().toISOString(), worker, snapshot }, { onConflict: "id" }), "status", 5000); } catch { /* next one */ }
    },
    async pendingCommands(fence) {
      const f = Math.floor(fence);
      const { data, error } = await timed(db().from("fx_scalper_commands").select("id, kind, created_at, status, claimed_fence")
        .or(`status.eq.pending,and(status.eq.running,or(claimed_fence.is.null,claimed_fence.lt.${f}))`)
        .order("created_at", { ascending: true }), "commands");
      return error ? [] : ((data ?? []) as CommandRow[]);
    },
    async claimCommand(id, fence) {
      const f = Math.floor(fence);
      const { data, error } = await timed(db().from("fx_scalper_commands").update({ status: "running", claimed_fence: f, claimed_at: new Date().toISOString() })
        .eq("id", id).or(`status.eq.pending,and(status.eq.running,or(claimed_fence.is.null,claimed_fence.lt.${f}))`).select("id"), "command");
      return !error && Array.isArray(data) && data.length > 0;
    },
    async finishCommand(id, ok, result) {
      await timed(db().from("fx_scalper_commands").update({ status: ok ? "done" : "failed", result, finished_at: new Date().toISOString() }).eq("id", id), "command");
    },
    async paidIntoAccount() {
      const { data, error } = await timed(db().from("fx_scalper_compensation").select("kind, amount, paid_into_account").eq("paid_into_account", true), "compensation");
      if (error || !data) return 0;
      return (data as Array<{ kind: string; amount: number }>).reduce((a, r) => a + (r.kind === "reversal" ? -Number(r.amount) : r.kind === "paid" ? Number(r.amount) : 0), 0);
    },
  };
}
