import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { AsyncLocalStorage } from "node:async_hooks";

type TradingNamespace = "rapid" | "nitrous";
const namespace = new AsyncLocalStorage<TradingNamespace>();

/** Request-local isolation: concurrent web requests never share a mutable product switch. */
export const tradingNamespace = (): TradingNamespace => namespace.getStore() ?? (process.env.NITROUS_WORKER === "1" ? "nitrous" : "rapid");
export const withNitrousDb = <T>(work: () => T): T => namespace.run("nitrous", work);
export const withRapidDb = <T>(work: () => T): T => namespace.run("rapid", work);

export function namespacedClient<T extends object>(client: T, scope: TradingNamespace): T {
  if (scope === "rapid") return client;
  return new Proxy(client, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if ((key === "from" || key === "rpc") && typeof value === "function") {
        return (name: string, ...args: unknown[]) => value.call(target, name.replace(/^rapid_/, "nitrous_"), ...args);
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * Service-role client for Rapid's own tables. RLS is bypassed here, which is why every route that
 * uses it must have already established who the caller is and what they own.
 */
let cached: SupabaseClient | null = null;
let nitrousCached: SupabaseClient | null = null;

export function admin(): SupabaseClient {
  if (!cached) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
    if (!url || !key) throw new Error("rapid_no_admin_client");
    cached = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  }
  if (tradingNamespace() === "rapid") return cached;
  return nitrousCached ?? (nitrousCached = namespacedClient(cached, "nitrous"));
}

export const adminOrNull = (): SupabaseClient | null => {
  try { return admin(); } catch { return null; }
};

/** Append-only decision journal. Never throws: losing a log line must not lose a trade. */
export async function journal(row: {
  accountId?: string | null;
  userId?: string | null;
  visitId?: string | null;
  intentId?: string | null;
  snapshotId?: string | null;
  stage: string;
  code: string;
  decision: string;
  reason: string;
  evidence?: Record<string, unknown>;
}): Promise<void> {
  try {
    await admin().from("rapid_journal").insert({
      account_id: row.accountId ?? null,
      user_id: row.userId ?? null,
      visit_id: row.visitId ?? null,
      intent_id: row.intentId ?? null,
      snapshot_id: row.snapshotId ?? null,
      stage: row.stage,
      code: row.code,
      decision: row.decision,
      reason: row.reason,
      evidence: row.evidence ?? {},
    });
  } catch {
    /* best effort */
  }
}

export async function health(component: string, state: "ok" | "degraded" | "blocked", detail?: Record<string, unknown>, accountId?: string | null): Promise<void> {
  try {
    await admin().from("rapid_health_events").insert({ component, state, account_id: accountId ?? null, detail: detail ?? {} });
  } catch {
    /* best effort */
  }
}

export async function beat(component: string, info: Record<string, unknown>): Promise<void> {
  try {
    await admin().from("rapid_heartbeat").upsert({ component, at: new Date().toISOString(), info }, { onConflict: "component" });
  } catch {
    /* best effort */
  }
}
