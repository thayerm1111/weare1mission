/**
 * GEN FX REPLAY — in a process of its own.
 *
 * worker/genfx.ts forks this file when a history replay has been asked for (genfx/history.ts). A year
 * of 5-minute candles through the engine on three horizons is several minutes of solid arithmetic;
 * the worker's main process runs the trade manager on a 350ms tick, and "it yields often" is not the
 * same as "it is not in the way". Here it has a thread to itself, at low priority, and if it dies it
 * takes nothing with it: the result row simply stops getting its heartbeat.
 *
 * It claims the request itself, so two of these can never both run one.
 */
import os from "node:os";
import { createAdminClient } from "@/lib/supabase/admin";
import { runRequestedReplay } from "@/lib/genfx/history";

function log(msg: string, extra?: unknown) {
  // eslint-disable-next-line no-console
  console.log(`[${new Date().toISOString()}] ${msg}`, extra ?? "");
}

async function main(): Promise<number> {
  try { os.setPriority(os.constants.priority.PRIORITY_LOW); } catch { /* not permitted here → normal priority */ }
  const admin = createAdminClient();
  if (!admin) { log("genfx-replay: no admin client"); return 2; }
  const ran = await runRequestedReplay(admin, log, () => new Promise<void>((r) => setImmediate(r)));
  log(ran ? "genfx-replay: finished" : "genfx-replay: nothing to run");
  return 0;
}

main().then((code) => process.exit(code), (e) => { log("genfx-replay: failed", e instanceof Error ? e.message.slice(0, 300) : e); process.exit(1); });
