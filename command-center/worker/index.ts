/**
 * COMMAND CENTER XAUUSD — WORKER
 *
 * One job right now: watch gold, build a snapshot, persist it. It cannot place, modify or close anything —
 * the adapters that could are not imported here, and will not be until the Risk Engine and Execution
 * Validator are wired and tested. That is the point of building in this order.
 *
 * Runs on Railway as its own service (`npm run cc-worker`), independent of every other process.
 */
import { series, price as tdPrice, GOLD } from "../adapters/twelvedata";
import { saveSnapshot, pruneSnapshots, audit } from "../adapters/db";
import { buildSnapshot, tradeable } from "../engines/snapshot";
import { marketOpen } from "../core/sessions";
import type { Bar, FeedHealth, Timeframe } from "../core/types";

const KEY = process.env.TWELVEDATA_API_KEY ?? "";
const TICK_MS = Number(process.env.CC_TICK_MS || 20_000);
const PERSIST_MS = Number(process.env.CC_PERSIST_MS || 60_000);
const NEEDED: { tf: Timeframe; size: number }[] = [
  { tf: "5m", size: 200 }, { tf: "15m", size: 150 }, { tf: "1h", size: 150 }, { tf: "4h", size: 120 }, { tf: "1d", size: 60 },
];

const log = (msg: string, extra?: unknown) => console.log(`[${new Date().toISOString()}] cc: ${msg}`, extra ?? "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let shuttingDown = false;

/** Higher timeframes move slowly — refetching a daily candle every 20 seconds is waste, not freshness. */
const REFRESH_MS: Record<Timeframe, number> = { "1m": 30_000, "5m": 30_000, "15m": 120_000, "1h": 300_000, "4h": 900_000, "1d": 3_600_000 };
const cache = new Map<Timeframe, { at: number; bars: Bar[] }>();

async function barsFor(tf: Timeframe, size: number): Promise<{ bars: Bar[]; fresh: boolean; error?: string }> {
  const hit = cache.get(tf);
  if (hit && Date.now() - hit.at < REFRESH_MS[tf]) return { bars: hit.bars, fresh: false };
  const r = await series(tf, size, KEY);
  if (!r.ok) {
    // Keep the last good series rather than pretending the market vanished; the snapshot will flag its age.
    return { bars: hit?.bars ?? [], fresh: false, error: `${r.error}: ${r.detail}` };
  }
  cache.set(tf, { at: Date.now(), bars: r.data });
  return { bars: r.data, fresh: true };
}

async function pass(lastPersistAt: number): Promise<number> {
  const now = Date.now();
  if (!marketOpen(now)) { log("market closed — idling"); return lastPersistAt; }

  const bars: Partial<Record<Timeframe, Bar[]>> = {};
  const errors: string[] = [];
  for (const n of NEEDED) {
    const r = await barsFor(n.tf, n.size);
    if (r.bars.length) bars[n.tf] = r.bars;
    if (r.error) errors.push(`${n.tf} ${r.error}`);
  }

  const p = await tdPrice(KEY);
  const m5 = bars["5m"];
  const fallback = m5?.length ? m5[m5.length - 1].c : null;
  const live = p.ok ? p.data : fallback;
  if (live == null) { log("no price and no bars — nothing to read", errors); return lastPersistAt; }

  const lastBarAt = m5?.length ? m5[m5.length - 1].t : null;
  const feeds: FeedHealth[] = [{
    feed: "twelvedata",
    state: p.ok ? "live" : errors.length ? "degraded" : "stale",
    lastTickMs: lastBarAt,
    ageMs: lastBarAt != null ? now - lastBarAt : null,
  }];

  const snap = buildSnapshot({ now, bars, price: live, feeds });
  const gate = tradeable(snap);

  if (now - lastPersistAt >= PERSIST_MS) {
    const id = await saveSnapshot(snap);
    const tfs = Object.entries(snap.timeframes).map(([tf, v]) => `${tf}:${v!.state}`).join(" ");
    log(`snapshot#${id ?? "?"} ${snap.price.toFixed(2)} ${snap.session} ${snap.regime} pressure ${snap.pressure.net > 0 ? "+" : ""}${snap.pressure.net} | ${tfs} | ${gate.ok ? "tradeable" : `blocked: ${gate.code}`}`);
    if (errors.length) log("feed notes", errors);
    return now;
  }
  return lastPersistAt;
}

async function main(): Promise<void> {
  if (!KEY) { log("no TWELVEDATA_API_KEY — the Command Center cannot see the market; exiting"); process.exit(1); }
  log(`starting · tick ${TICK_MS}ms · persist ${PERSIST_MS}ms · symbol ${GOLD}`);
  await audit({ actor: "cc-worker", action: "worker_start", reason: "Command Center observation loop started" });

  let lastPersist = 0;
  let lastPrune = 0;
  while (!shuttingDown) {
    try {
      lastPersist = await pass(lastPersist);
      if (Date.now() - lastPrune > 6 * 3600_000) { await pruneSnapshots(); lastPrune = Date.now(); }
    } catch (e) {
      log("pass error (loop continues)", e instanceof Error ? e.message.slice(0, 200) : e);
    }
    await sleep(TICK_MS);
  }
}

process.on("SIGTERM", () => { log("SIGTERM — stopping"); shuttingDown = true; });
process.on("SIGINT", () => { log("SIGINT — stopping"); shuttingDown = true; });
process.on("unhandledRejection", (e) => log("unhandledRejection", e));

void main().catch((e) => { log("fatal", e instanceof Error ? e.message : e); process.exit(1); });
