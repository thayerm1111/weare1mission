/**
 * ONE MISSION FX SCALPER — THE WORKER (owner 10-23). A separate, always-on Railway service:
 *   npm run fx-scalper        (tsx fxscalper/worker/index.ts; config: fxscalper/railway.json)
 *
 * Required environment (same values as the web app): NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 * and FX_SCALPER_ENC_KEY or FLOW_ENC_KEY (to read the broker credentials the dashboard stored).
 * Optional: TL_DEVELOPER_API_KEY (TradeLocker Developer Program key, sent as `developer-api-key`).
 *
 * Starting this process never sends an order. Orders need, all at once: a connected account, the
 * owner's START LIVE (fx_scalper_control.mode = 'live', entries not paused), this process holding the
 * lease, a clean reconciliation with the broker, and a completed-candle signal that passes every cost,
 * position and risk check.
 *
 * RESTART / RECOVERY. Kill it, redeploy it, let it crash: open positions keep their broker-side stop
 * and target. The next process waits for the lease, reloads the books, asks the broker about every
 * trade that was in flight (by its order id and its label), adopts or closes bot-labelled positions it
 * finds, closes anything whose 120-second time exit passed while it was away, and only then allows
 * new entries.
 */
import { Bot } from "./bot";
import { commands, dayCheck, exits, manageAll, minuteCycle, quotePair, reconcile } from "./trading";
import { publish } from "./snapshot";
import { P } from "@/lib/fxscalper/tl/transport";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const bot = new Bot();
  let shuttingDown = false;
  const stop = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[fx-scalper] ${sig}: stopping`);
    await bot.shutdown().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("unhandledRejection", (e) => bot.noteError("unhandled", e));
  process.on("uncaughtException", (e) => bot.noteError("uncaught", e));

  console.log(`[fx-scalper] ${bot.owner} starting; waiting for the lease`);
  for (;;) {
    try {
      if (await bot.takeLease()) break;
    } catch (e) {
      console.error("[fx-scalper] lease:", (e as Error).message);
    }
    // The dashboard's status row belongs to the worker that holds the lease; a waiting one stays quiet.
    await sleep(2000);
  }
  console.log(`[fx-scalper] lease taken (fence ${bot.fence})`);
  await bot.event("info", "worker_started", `Worker ${bot.owner} started and holds the lease (fence ${bot.fence}). No orders until reconciliation and START LIVE.`);

  bot.start();
  const live = () => [...bot.trades.values()].length;
  const open = () => [...bot.trades.values()].filter((t) => t.state === "open" || t.state === "closing").length;
  const ready = () => Boolean(bot.session?.ready);

  // Each minute, just after the close (plus the settle delay): the signal pass.
  bot.every("minute", () => {
    const now = Date.now();
    return Math.floor(now / 60_000) * 60_000 + 60_000 + bot.settings.data.barSettleMs - now;
  }, () => minuteCycle(bot), 2000);
  // Due closes (time exit, close-all, the worker's own target) first and on their own: never behind a
  // trade's other steps, a positions read or the journal.
  bot.every("exits", () => 250, () => exits(bot));
  bot.every("manage", () => 250, () => manageAll(bot));
  // While the bot has trades these reads are protective (they are how an exit is seen), and a protective
  // check that finds one of them already on its way shares it — so they run at protective priority.
  bot.every("positions", () => (live() ? 1000 : 4000), async () => { if (ready()) await bot.freshPositions(500, live() ? P.PROTECT : P.BACKGROUND); });
  bot.every("orders", () => (open() ? 3000 : 20_000), async () => { if (ready()) await bot.freshOrders(1000, open() ? P.PROTECT : P.BACKGROUND); });
  bot.every("state", () => 2000, async () => { if (ready()) await bot.refreshState(P.SYNC); });
  bot.every("quotes", () => Math.max(300, Math.floor(bot.settings.data.quoteIntervalMs / 7)), quotePair(bot));
  bot.every("reconcile", () => (bot.reconciled ? 15_000 : 4000), () => reconcile(bot), 1500);
  bot.every("day", () => 10_000, () => dayCheck(bot), 3000);
  bot.every("commands", () => 1000, () => commands(bot));
  bot.every("symbols", () => 60_000, async () => { if (ready()) await bot.refreshSymbolStatus(); }, 30_000);
  bot.every("rediscover", () => 30 * 60_000, async () => { if (ready()) await bot.discover(); }, 30 * 60_000);
  bot.every("account", () => 5 * 60_000, async () => { if (ready()) await bot.refreshTradeAccount(); }, 5 * 60_000);
  bot.every("foreign", () => 30_000, async () => { if (ready()) await bot.learnForeignSpecs(); }, 5000);
  bot.every("status", () => 2000, () => publish(bot), 500);
}

main().catch((e) => {
  console.error("[fx-scalper] fatal:", e);
  process.exit(1);
});
