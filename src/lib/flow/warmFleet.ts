/**
 * PRE-TRADE WARM-UP (owner 09-17: "we really need to speed up entry — execution needs to happen the fastest
 * possible way"). When a GENX setup is close to triggering (a forming alert is being watched, or a PDH/PDL
 * retest is in progress / defended / armed), the worker logs every eligible member into their broker, reads
 * their accounts' equity and loads the instrument list — ahead of the ENTER NOW. The fan-out then reuses that
 * work (activeAccounts maxBrokerAgeMs) and goes straight to the order. Read-only: no orders. Throttled so it
 * runs at most once every 75s, and never twice at the same time.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { activeAccounts } from "@/lib/flow/connection";
import { warmInstruments } from "@/lib/flow/executor";
import { withBrokerPriority } from "@/lib/flow/tradelocker";

export const WARM_EVERY_MS = 75_000;
let lastWarmAt = 0, running = false;
export function warmDue(nowMs: number): boolean { return !running && nowMs - lastWarmAt >= WARM_EVERY_MS; }

export function warmGoldFleet(why: string): void {
  if (!warmDue(Date.now())) return;
  lastWarmAt = Date.now(); running = true;
  // background priority: the warm-up never takes budget from an order or from position protection
  void withBrokerPriority("background", () => run(why)).finally(() => { running = false; });
}

async function run(why: string): Promise<void> {
  const admin = createAdminClient();
  if (!admin) return;
  const t0 = Date.now();
  const { data } = await admin.from("flow_broker_accounts").select("user_id").eq("autotrade_enabled", true).eq("flow_credit_paused", false);
  const users = [...new Set(((data ?? []) as { user_id: string }[]).map((r) => r.user_id))];
  let i = 0, accounts = 0;
  const worker = async () => {
    while (i < users.length) {
      const uid = users[i++];
      try {
        const list = await activeAccounts(uid);
        accounts += list.length;
        const seen = new Set<string>();
        for (const a of list) { if (seen.has(a.connId)) continue; seen.add(a.connId); await warmInstruments(a).catch(() => false); }
      } catch { /* warm-up is best-effort */ }
    }
  };
  await Promise.all(Array.from({ length: 20 }, worker));
  // eslint-disable-next-line no-console
  console.log(`[${new Date().toISOString()}] warm-fleet: ${users.length} members / ${accounts} accounts ready in ${Date.now() - t0}ms (${why})`);
}
