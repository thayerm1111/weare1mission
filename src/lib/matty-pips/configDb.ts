/**
 * MATTY PIPS — DB-backed config overrides. The engine's weights and
 * thresholds (config.ts DEFAULT_CONFIG) can be tuned WITHOUT a deploy by
 * writing a row to matty_pips_config (id='live', overrides jsonb). Cached
 * in-process for 60s so the per-minute scan costs ~one read a minute across
 * the fleet; every failure path falls back to the defaults silently.
 * This is the honest "learning" loop: outcomes → a human (or a reviewed
 * job) adjusts weights → the deterministic engine picks them up. No ML.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { DEFAULT_CONFIG, mergeConfig, type MpConfig } from "./config";

let cache: { cfg: MpConfig; at: number } | null = null;
const TTL_MS = 60_000;

export async function loadConfig(): Promise<MpConfig> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.cfg;
  try {
    const admin = createAdminClient();
    if (!admin) return DEFAULT_CONFIG;
    const { data } = await admin.from("matty_pips_config").select("overrides").eq("id", "live").maybeSingle();
    const cfg = mergeConfig((data as { overrides?: Record<string, unknown> } | null)?.overrides ?? null);
    cache = { cfg, at: Date.now() };
    return cfg;
  } catch {
    return cache?.cfg ?? DEFAULT_CONFIG;
  }
}
