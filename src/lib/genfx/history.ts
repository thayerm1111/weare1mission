import { createAdminClient } from "@/lib/supabase/admin";
import { PAIRS, PAIR_KEYS, type FxPair, type PairKey } from "@/lib/genfx/pairs";
import { configOf } from "@/lib/genfx/control";
import { replay, type Bar, type ReplayOut } from "@/lib/genfx/replay";
import { type Mode } from "@/lib/genxCompute";

/**
 * GEN FX REPLAY RUNNER — fetches real 5-minute history and runs replay.ts over it.
 *
 * It runs on the always-on worker, because that is where the market-data key lives. It is asked for
 * through the control row: set genfx_control.replay_request to an object (even an empty one) and the
 * worker picks it up within half a minute, runs both pairs, and writes the result to replay_result.
 *
 *   update genfx_control set replay_request = '{"weeks": 26}' where id = 1;
 *
 * Request fields, all optional:
 *   weeks        how much history to fetch (default 26, at most 104)
 *   costPips     { "EURUSD": 1.0, "GBPJPY": 2.5 }   round-trip cost charged per trade
 *   minStopPips  { "EURUSD": 10,  "GBPJPY": 20 }    tightest stop taken (default: the live setting)
 *   modes        ["quick","intraday","swing"]
 *   trades       true to keep every simulated trade in the result (default: the last 40 per pair)
 *
 * Read-only against the market and the broker: it places nothing and touches no account.
 */
type Admin = NonNullable<ReturnType<typeof createAdminClient>>;
const M5 = 5 * 60_000;
const PAGE = 5000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Real 5-minute candles for `weeks`, oldest → newest, timestamps in UTC. Null when the feed refuses. */
export async function fetchM5(pair: FxPair, weeks: number, key: string): Promise<Bar[] | null> {
  const want = Math.ceil(weeks * 5 * 288 * 1.02);
  const byT = new Map<number, Bar>();
  let end: string | null = null;
  for (let page = 0; page < 60 && byT.size < want; page++) {
    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(pair.td)}&interval=5min&outputsize=${PAGE}&timezone=UTC&order=DESC${end ? `&end_date=${encodeURIComponent(end)}` : ""}&apikey=${key}`;
    let values: Array<{ datetime?: string; open?: string; high?: string; low?: string; close?: string }> = [];
    try {
      const r = await fetch(url, { cache: "no-store" });
      const j = (await r.json()) as { status?: string; values?: typeof values; message?: string; code?: number };
      if (j.status === "error" || !Array.isArray(j.values)) {
        if (r.status === 429 || j.code === 429) { await sleep(20_000); continue; }   // per-minute credit limit: wait it out
        break;
      }
      values = j.values;
    } catch { break; }
    if (!values.length) break;
    let oldest = Infinity;
    for (const v of values) {
      const t = Date.parse(String(v.datetime ?? "").replace(" ", "T") + "Z");
      const o = Number(v.open), h = Number(v.high), l = Number(v.low), c = Number(v.close);
      if (!Number.isFinite(t) || ![o, h, l, c].every((n) => Number.isFinite(n) && n > 0)) continue;
      byT.set(t, { t, o, h, l, c });
      oldest = Math.min(oldest, t);
    }
    if (!Number.isFinite(oldest) || values.length < PAGE) break;
    end = new Date(oldest - 1000).toISOString().slice(0, 19).replace("T", " ");
    await sleep(400);
  }
  if (byT.size < 2000) return null;
  return [...byT.values()].sort((a, b) => a.t - b.t).filter((b) => b.h >= b.l && b.t % M5 === 0);
}

const mapOf = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

/** If a replay has been asked for, run it and store the result. Returns whether one ran. */
export async function runRequestedReplay(admin: Admin, log: (m: string, x?: unknown) => void, yieldFn: () => Promise<void>): Promise<boolean> {
  const { data } = await admin.from("genfx_control").select("replay_request, config").eq("id", 1).maybeSingle();
  const row = data as { replay_request?: unknown; config?: unknown } | null;
  if (!row || !row.replay_request || typeof row.replay_request !== "object") return false;
  const req = row.replay_request as Record<string, unknown>;
  const startedAt = new Date().toISOString();
  // Claim it first: clearing the request is what stops a second worker (or the next tick) running it again.
  const { data: won } = await admin.from("genfx_control").update({ replay_request: null, replay_result: { status: "running", startedAt, request: req } }).eq("id", 1).not("replay_request", "is", null).select("id");
  if (!won?.length) return false;

  const key = process.env.TWELVEDATA_API_KEY ?? "";
  const cfg = configOf(row.config);
  const weeks = Math.max(4, Math.min(104, Number(req.weeks) || 26));
  const modes = (Array.isArray(req.modes) ? req.modes : []).filter((m): m is Mode => m === "quick" || m === "intraday" || m === "swing");
  const keepAll = req.trades === true;
  const out: Record<string, unknown> = {};
  log(`genfx-replay: starting (${weeks} weeks)`);
  for (const k of PAIR_KEYS) {
    const pair = PAIRS[k as PairKey];
    try {
      const bars = key ? await fetchM5(pair, weeks, key) : null;
      if (!bars) { out[k] = { error: "no_history (the market-data feed returned too little)" }; continue; }
      const cost = Number(mapOf(req.costPips)[k]);
      const minStop = Number(mapOf(req.minStopPips)[k]);
      // Swing reads weekly candles and needs ten of them before its first decision; every horizon
      // starts from the same point so they are compared over the same weeks.
      const warmup = Math.min(Math.floor(bars.length * 0.45), 11 * 5 * 288);
      const res: ReplayOut = await replay(pair, bars, {
        costPips: Number.isFinite(cost) && cost >= 0 ? cost : undefined,
        minStopPips: Number.isFinite(minStop) && minStop > 0 ? minStop : cfg.minStopPips[pair.key],
        modes: modes.length ? modes : undefined, warmupBars: warmup, onYield: yieldFn,
      });
      out[k] = { ...res, trades: keepAll ? res.trades : res.trades.slice(-40) };
      log(`genfx-replay: ${k} done`, { bars: res.bars, steps: res.steps, placed: res.placement.placed, managedR: res.managed.all.r, rawR: res.raw.all.r });
    } catch (e) {
      out[k] = { error: e instanceof Error ? e.message.slice(0, 200) : "error" };
    }
    // Each pair is stored as it finishes, so a long run shows what it has while the next pair is still going.
    try { await admin.from("genfx_control").update({ replay_result: { status: "running", startedAt, request: req, weeks, pairs: out } }).eq("id", 1); } catch { /* the final write below is the one that matters */ }
  }
  await admin.from("genfx_control").update({ replay_result: { status: "done", startedAt, finishedAt: new Date().toISOString(), request: req, weeks, pairs: out } }).eq("id", 1);
  return true;
}
