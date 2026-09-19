/**
 * SUPABASE ADAPTER — the Command Center's own persistence. Service role, server-side only.
 *
 * It writes to cc_* tables and nothing else. No engine calls this directly with raw SQL; every table has one
 * function here, so the schema has exactly one place that knows about it.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { MarketSnapshot } from "../core/types";

let _db: SupabaseClient | null = null;

export function db(): SupabaseClient | null {
  if (_db) return _db;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  _db = createClient(url, key, { auth: { persistSession: false } });
  return _db;
}

/** Persist a snapshot. Returns its id so a decision can point at the exact market it was taken from. */
export async function saveSnapshot(s: MarketSnapshot): Promise<number | null> {
  const c = db();
  if (!c) return null;
  const { data, error } = await c.from("cc_snapshots").insert({
    at: new Date(s.at).toISOString(),
    snapshot_version: s.snapshotVersion,
    price: s.price, bid: s.bid, ask: s.ask, spread: s.spread,
    session: s.session, regime: s.regime, pressure_net: s.pressure.net,
    timeframes: Object.fromEntries(Object.entries(s.timeframes).map(([tf, v]) => [tf, { state: v!.state, features: v!.features, structure: v!.structure }])),
    levels: s.levels, feeds: s.feeds,
    warnings: s.warnings,
  }).select("id").single();
  if (error) return null;
  return (data as { id: number }).id;
}

/** The newest snapshot, for the API and the UI. */
export async function latestSnapshot(): Promise<{ id: number; row: Record<string, unknown> } | null> {
  const c = db();
  if (!c) return null;
  const { data } = await c.from("cc_snapshots").select("*").order("at", { ascending: false }).limit(1).maybeSingle();
  return data ? { id: (data as { id: number }).id, row: data as Record<string, unknown> } : null;
}

export async function audit(e: {
  actor: string; action: string; reason?: string; price?: number | null;
  snapshotVersion?: string | null; userId?: string | null; accountId?: string | null; finalState?: string | null;
  riskBefore?: unknown; riskAfter?: unknown; apiResult?: unknown;
}): Promise<void> {
  const c = db();
  if (!c) return;
  try {
    await c.from("cc_audit").insert({
      actor: e.actor, action: e.action, reason: e.reason ?? null, price: e.price ?? null,
      snapshot_version: e.snapshotVersion ?? null, user_id: e.userId ?? null, account_id: e.accountId ?? null,
      risk_before: e.riskBefore ?? null, risk_after: e.riskAfter ?? null, api_result: e.apiResult ?? null,
      final_state: e.finalState ?? null,
    });
  } catch { /* the audit trail must never break the thing it is recording */ }
}

/** Snapshots are written often and read rarely; keep a rolling window rather than growing forever. */
export async function pruneSnapshots(keepDays = 14): Promise<void> {
  const c = db();
  if (!c) return;
  try { await c.from("cc_snapshots").delete().lt("at", new Date(Date.now() - keepDays * 86_400_000).toISOString()); } catch { /* best effort */ }
}
