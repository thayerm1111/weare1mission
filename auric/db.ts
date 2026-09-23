import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { ProcessState } from "./core/types";

/** Service-role client for the worker and server routes. Never reaches a browser. */
let _admin: SupabaseClient | null = null;
export function admin(): SupabaseClient {
  if (_admin) return _admin;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase service credentials missing");
  _admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  return _admin;
}

export async function setting<T = unknown>(key: string, fallback: T): Promise<T> {
  const { data } = await admin().from("auric_settings").select("value").eq("key", key).maybeSingle();
  if (!data || data.value === null || data.value === undefined) return fallback;
  return data.value as T;
}

/** Decision-timeline event. Every process-state transition the dashboard shows comes from here. */
export async function event(accountId: string, sessionId: string | null, kind: string, message: string, state?: ProcessState, payload?: unknown) {
  await admin().from("auric_events").insert({ account_id: accountId, session_id: sessionId, kind, message, state: state ?? null, payload: payload ?? null });
}

/** Batched telemetry: flushed every few seconds rather than one write per price event. */
const buffer: Array<{ account_id: string | null; kind: string; payload: unknown }> = [];
export function telemetry(accountId: string | null, kind: string, payload: unknown) { buffer.push({ account_id: accountId, kind, payload }); if (buffer.length > 500) buffer.splice(0, buffer.length - 500); }
export async function flushTelemetry() {
  if (!buffer.length) return;
  const rows = buffer.splice(0, buffer.length);
  const { error } = await admin().from("auric_telemetry").insert(rows);
  if (error) console.error("[auric] telemetry flush failed", error.message);
}

export async function snapshot(accountId: string, payload: unknown) {
  await admin().from("auric_snapshots").upsert({ account_id: accountId, at: new Date().toISOString(), payload });
}
