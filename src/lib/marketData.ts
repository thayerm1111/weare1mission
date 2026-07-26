import { createClient } from "@/lib/supabase/server";

/**
 * Global market-data governor. Every Twelve Data call reserves its credit cost
 * from a shared per-minute budget FIRST, so the whole community's usage can
 * never exceed the plan's per-minute ceiling (default 350, safely under Grow's
 * 377/min). When the minute's budget is spent, callers get {ok:false} and
 * should return a friendly "desk is busy" instead of hitting the API.
 *
 * Fails OPEN if the governor is unavailable (not migrated / transient DB blip)
 * so a hiccup never takes the whole product down — the reduced polling + Grow's
 * large headroom mean we stay well clear of the ceiling in normal operation.
 */
const MD_MINUTE_LIMIT = Number(process.env.MD_MINUTE_LIMIT || 350);

export async function reserveMarketData(cost: number): Promise<{ ok: boolean; used?: number; limit?: number }> {
  try {
    const supabase = createClient();
    if (!supabase) return { ok: true };
    const { data, error } = await supabase.rpc("md_reserve", { p_cost: cost, p_limit: MD_MINUTE_LIMIT });
    if (error || !data) return { ok: true }; // fail open
    const d = data as { ok?: boolean; used?: number; limit?: number };
    return { ok: !!d.ok, used: d.used, limit: d.limit };
  } catch {
    return { ok: true };
  }
}
