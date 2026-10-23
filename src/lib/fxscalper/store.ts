import type { SupabaseClient } from "@supabase/supabase-js";
import { settingsFrom, type Settings } from "./settings";

/**
 * The FX Scalper's database rows and the few writes both the dashboard and the worker make. Every
 * supabase-js call RETURNS its error rather than throwing; every result here is looked at.
 */

export type Db = SupabaseClient;

export type ControlRow = {
  id: number;
  mode: "stopped" | "live";
  entries_paused: boolean;
  pause_reason: string | null;
  pause_until: string | null;
  version: number;
  connection_id: string | null;
  account_id: string | null;
  acc_num: string | null;
  account_label: string | null;
  account_currency: string | null;
  started_at: string | null;
  started_by: string | null;
  start_settings_version: number | null;
  stopped_at: string | null;
  stop_reason: string | null;
  close_all_reason: string | null;
  close_all_at: string | null;
  updated_at: string;
  updated_by: string | null;
};

export const LIVE_STATES = ["reserved", "sending", "acknowledged", "uncertain", "open", "closing"] as const;
export type TradeState = (typeof LIVE_STATES)[number] | "rejected" | "not_filled" | "not_placed" | "closed";

export type TradeRow = {
  id: string;
  signal_key: string;
  tag: string;
  fence: number;
  control_version: number;
  settings_version: number;
  account_id: string;
  acc_num: string;
  pair: string;
  broker_symbol: string | null;
  tradable_instrument_id: string;
  side: "buy" | "sell";
  state: TradeState;
  candle_t: string;
  signal: Record<string, unknown>;
  plan: Record<string, unknown>;
  qty: number;
  planned_entry: number;
  planned_stop: number;
  planned_target: number;
  stop_pips: number;
  reserved_risk: number;
  order_id: string | null;
  position_id: string | null;
  sent_at: string | null;
  ack_at: string | null;
  ack_latency_ms: number | null;
  filled_qty: number | null;
  fill_price: number | null;
  filled_at: string | null;
  stop_price: number | null;
  target_price: number | null;
  protection: "pending" | "verified" | "failed" | "n/a";
  protection_verified_at: string | null;
  time_exit_due_at: string | null;
  close_requested_at: string | null;
  close_reason: string | null;
  exit_price: number | null;
  closed_at: string | null;
  gross_pnl: number | null;
  commission: number | null;
  other_charges: number | null;
  net_pnl: number | null;
  pnl_final: boolean;
  conversion: Record<string, unknown> | null;
  closed_lots: number | null;
  eligible_lots: number | null;
  error: string | null;
  notes: unknown[];
  broker: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

/** numeric columns come back from PostgREST as numbers or strings; make them numbers. */
const NUMERIC: Array<keyof TradeRow> = ["qty", "planned_entry", "planned_stop", "planned_target", "stop_pips", "reserved_risk", "filled_qty", "fill_price", "stop_price", "target_price", "exit_price", "gross_pnl", "commission", "other_charges", "net_pnl", "closed_lots", "eligible_lots", "fence", "control_version", "settings_version"];
export function tradeFrom(row: Record<string, unknown>): TradeRow {
  const out = { ...row } as Record<string, unknown>;
  for (const k of NUMERIC) {
    const v = out[k as string];
    if (v != null) out[k as string] = Number(v);
  }
  return out as unknown as TradeRow;
}

export async function readControl(db: Db): Promise<ControlRow> {
  const { data, error } = await db.from("fx_scalper_control").select("*").eq("id", 1).maybeSingle();
  if (error) throw new Error(`control unreadable: ${error.message}`);
  if (!data) throw new Error("control row missing (run the fx_scalper migration)");
  const r = data as ControlRow;
  return { ...r, version: Number(r.version), start_settings_version: r.start_settings_version == null ? null : Number(r.start_settings_version) };
}

export async function updateControl(db: Db, patch: Partial<ControlRow>, by: string | null, expect: number | null = null): Promise<{ ok: boolean; version: number | null; reason: string }> {
  const { data, error } = await db.rpc("fx_scalper_control_update", { p_patch: patch, p_by: by, p_expect: expect });
  if (error) return { ok: false, version: null, reason: error.message };
  const row = (Array.isArray(data) ? data[0] : data) as { ok?: boolean; new_version?: number; reason?: string } | undefined;
  return { ok: Boolean(row?.ok), version: row?.new_version == null ? null : Number(row.new_version), reason: String(row?.reason ?? "") };
}

export async function readSettings(db: Db): Promise<{ settings: Settings; version: number; warnings: string[]; updatedAt: string | null }> {
  const { data, error } = await db.from("fx_scalper_settings").select("config, version, updated_at").eq("id", 1).maybeSingle();
  if (error) throw new Error(`settings unreadable: ${error.message}`);
  if (!data) throw new Error("settings row missing (run the fx_scalper migration)");
  const row = data as { config: unknown; version: number; updated_at: string | null };
  const { settings, warnings } = settingsFrom(row.config);
  return { settings, version: Number(row.version), warnings, updatedAt: row.updated_at };
}

/** Save settings only if nobody else saved since `expectVersion` was read. */
export async function saveSettings(db: Db, settings: Settings, expectVersion: number, by: string | null): Promise<{ ok: true; version: number } | { ok: false; reason: string }> {
  const next = expectVersion + 1;
  const { data, error } = await db.from("fx_scalper_settings")
    .update({ config: settings, version: next, updated_at: new Date().toISOString(), updated_by: by })
    .eq("id", 1).eq("version", expectVersion).select("version");
  if (error) return { ok: false, reason: error.message };
  if (!data || !(data as unknown[]).length) return { ok: false, reason: "the settings changed since this page loaded — reload and try again" };
  const h = await db.from("fx_scalper_settings_history").insert({ version: next, config: settings, changed_by: by });
  if (h.error) return { ok: true, version: next };
  return { ok: true, version: next };
}

export async function addEvent(db: Db, e: { level?: "info" | "warn" | "error"; kind: string; message: string; pair?: string | null; tradeId?: string | null; data?: Record<string, unknown> }): Promise<void> {
  try {
    await db.from("fx_scalper_events").insert({ level: e.level ?? "info", kind: e.kind, message: e.message.slice(0, 2000), pair: e.pair ?? null, trade_id: e.tradeId ?? null, data: e.data ?? {} });
  } catch {
    /* a lost journal line must never stop a trade */
  }
}
