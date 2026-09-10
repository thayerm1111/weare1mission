/**
 * TWELVEDATA WEBSOCKET PRICE STREAM (owner 09-10: "faster price feed... insane speeds").
 *
 * Holds one persistent WebSocket to TwelveData's streaming server and pushes every
 * tick into the shared in-memory store (src/lib/flow/liveTicks.ts). From there:
 *   • the GENX watch's livePrice() reads the tick instantly (no HTTP, no credit),
 *   • the trade manager's feedExtremes() sees tick-level wick highs/lows the moment
 *     they print — break-even/trail reaction becomes tick-accurate.
 *
 * DESIGNED TO FAIL SOFT, ALWAYS:
 *   • Plan gate: full WS access needs the TwelveData Pro plan; on Grow only a small
 *     trial symbol list works. A rejected subscribe is logged once and simply means
 *     that symbol keeps using today's polling — nothing breaks, nothing stops.
 *   • Ticks expire in 2.5s in the readers — if the socket drops, everything reverts
 *     to the REST/polling path automatically until we reconnect (1s→30s backoff).
 *   • Vercel never runs this file; its tick store stays empty, behavior unchanged.
 *
 * Subscriptions: XAU/USD always (the GENX instrument) + the TwelveData symbol of
 * every OPEN managed position, refreshed every 30s. Runs on Node 22's native
 * WebSocket (same requirement supabase-js already pinned us to).
 * Env: TWELVEDATA_API_KEY (required), WORKER_STREAM=0 to disable.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { pushLiveTick, liveTickStats } from "@/lib/flow/liveTicks";
import { getInstrument } from "@/lib/flow/instruments";
import { contractKey } from "@/lib/flow/sizing";
import { beat } from "@/lib/flow/health";

const WS_URL = (key: string) => `wss://ws.twelvedata.com/v1/quotes/price?apikey=${key}`;
const ALWAYS_SYMBOLS = ["XAU/USD"];      // GENX's instrument — streamed whenever markets are open
const RESYNC_MS = 30_000;                // re-derive the wanted symbol set from open positions
const HEARTBEAT_MS = 10_000;             // keep-alive ping the server expects
const BEAT_MS = 15_000;                  // liveness row in flow_heartbeat
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function log(msg: string, extra?: unknown) {
  // eslint-disable-next-line no-console
  console.log(`[${new Date().toISOString()}] stream: ${msg}`, extra ?? "");
}

/** TwelveData symbols we should be subscribed to right now. */
async function wantedSymbols(admin: NonNullable<ReturnType<typeof createAdminClient>>): Promise<Set<string>> {
  const want = new Set(ALWAYS_SYMBOLS);
  try {
    const { data } = await admin.from("flow_managed_positions").select("symbol").eq("status", "open").limit(500);
    for (const r of ((data ?? []) as { symbol: string | null }[])) {
      if (!r.symbol) continue;
      const td = getInstrument(contractKey(r.symbol))?.twelveDataSymbol;
      if (td) want.add(td);
    }
  } catch { /* symbol refresh is best-effort — ALWAYS list still streams */ }
  return want;
}

export async function streamLoop(isShuttingDown: () => boolean): Promise<void> {
  if (process.env.WORKER_STREAM === "0") { log("disabled via WORKER_STREAM=0"); return; }
  const key = process.env.TWELVEDATA_API_KEY;
  if (!key) { log("no TWELVEDATA_API_KEY — stream off, polling continues"); return; }
  const admin = createAdminClient();
  if (!admin) { log("no admin client — stream off"); return; }

  let backoff = RECONNECT_MIN_MS;
  const rejected = new Set<string>();   // symbols the plan refused (log once, poll instead)

  for (;;) {
    if (isShuttingDown()) return;

    let ws: WebSocket;
    try { ws = new WebSocket(WS_URL(key)); }
    catch (e) { log("socket create failed", e instanceof Error ? e.message : e); await sleep(backoff); backoff = Math.min(backoff * 2, RECONNECT_MAX_MS); continue; }

    const subscribed = new Set<string>();
    let closed = false;
    let ticksThisConn = 0;
    const closedP = new Promise<void>((resolve) => {
      const done = () => { if (!closed) { closed = true; resolve(); } };
      ws.addEventListener("close", done);
      ws.addEventListener("error", done);
    });

    const send = (obj: unknown) => { try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); } catch { /* dropped — reconnect handles it */ } };

    ws.addEventListener("message", (ev: MessageEvent) => {
      try {
        const m = JSON.parse(String(ev.data)) as { event?: string; symbol?: string; price?: unknown; timestamp?: unknown; fails?: Array<{ symbol?: string }> | null };
        if (m.event === "price" && m.symbol) {
          const p = Number(m.price);
          if (Number.isFinite(p) && p > 0) {
            // Server timestamps are seconds; trust our own clock if it's missing/odd.
            const ts = Number(m.timestamp);
            pushLiveTick(m.symbol, p, Number.isFinite(ts) && ts > 1e9 ? ts * 1000 : undefined);
            ticksThisConn += 1;
          }
        } else if (m.event === "subscribe-status") {
          const fails = Array.isArray(m.fails) ? m.fails.map((f) => String(f?.symbol ?? "?")) : [];
          for (const f of fails) {
            if (!rejected.has(f)) {
              rejected.add(f);
              log(`plan rejected ${f} — that symbol stays on polling (full WS needs the TwelveData Pro plan)`);
            }
          }
        }
      } catch { /* non-JSON frames are ignorable */ }
    });

    const opened = await new Promise<boolean>((resolve) => {
      ws.addEventListener("open", () => resolve(true));
      closedP.then(() => resolve(false));
    });
    if (!opened) { log("connect failed"); await sleep(backoff); backoff = Math.min(backoff * 2, RECONNECT_MAX_MS); continue; }
    log("connected");
    backoff = RECONNECT_MIN_MS;

    let lastResync = 0;
    let lastHeartbeat = Date.now();
    let lastBeat = 0;
    while (!closed && !isShuttingDown()) {
      const now = Date.now();
      if (now - lastResync >= RESYNC_MS || lastResync === 0) {
        lastResync = now;
        const want = await wantedSymbols(admin);
        const add = [...want].filter((s) => !subscribed.has(s));
        const drop = [...subscribed].filter((s) => !want.has(s));
        if (add.length) { send({ action: "subscribe", params: { symbols: add.join(",") } }); add.forEach((s) => subscribed.add(s)); }
        if (drop.length) { send({ action: "unsubscribe", params: { symbols: drop.join(",") } }); drop.forEach((s) => subscribed.delete(s)); }
      }
      if (now - lastHeartbeat >= HEARTBEAT_MS) { lastHeartbeat = now; send({ action: "heartbeat" }); }
      if (now - lastBeat >= BEAT_MS) {
        lastBeat = now;
        const stats = liveTickStats();
        await beat(admin, "price_stream", { connected: true, connTicks: ticksThisConn, totalTicks: stats.ticks, live: stats.symbols, rejected: [...rejected] }).catch(() => {});
      }
      await sleep(500);
    }

    if (isShuttingDown()) { try { ws.close(); } catch { /* exiting */ } return; }
    log("disconnected — reconnecting");
    try { ws.close(); } catch { /* already closed */ }
    await beat(admin, "price_stream", { connected: false }).catch(() => {});
    await sleep(backoff);
    backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
  }
}
