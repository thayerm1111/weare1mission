import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { series, livePrice } from "@/lib/marketData";
import { sessionNow } from "@/lib/genxCompute";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

/**
 * THE FLOOR — "SETUP FORMING" panel data.
 *
 * Returns the CURRENT GENX gold setup (levels, side, readiness), a recent XAUUSD
 * candle series for the chart, a live conditions checklist, AND a plain-English
 * "what has to happen for GENX to enter" guidance line with live distance / risk
 * / reward metrics. READ-ONLY and does NOT charge credits: it reads the setup the
 * scanner already computed (genx_alerts) and pulls candles from the shared,
 * community-cached feed. An in-memory cache means many members with The Floor
 * open never multiply market-data usage.
 *
 * Freshness: we prefer a genuinely CURRENT setup — the newest FORMING setup in
 * the last 12h; failing that a very recent ENTERED trade (last 3h); otherwise the
 * panel shows an honest "scanning" state rather than a stale, confusing setup.
 */

const GOLD_PIP = 0.1;

type Candle = { t: string; o: number; h: number; l: number; c: number };
type Setup = {
  side: "buy" | "sell"; state: string; mode: string;
  entry: number | null; entryLow: number | null; entryHigh: number | null;
  stop: number | null; tp1: number | null; tp2: number | null; tp3: number | null;
  breakLevel: number | null; readiness: number; createdAt: string;
};
type Metrics = { toEntry: number | null; risk: number | null; reward: number | null; rr: number | null };
type Payload = {
  setup: Setup | null; candles: Candle[]; price: number | null; session: string;
  conditions: { label: string; met: boolean }[]; statusText: string;
  phase: string; guidance: string; metrics: Metrics | null;
};

let CACHE: { at: number; body: Payload } | null = null;
const TTL_MS = 30_000;

function json(o: unknown, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

const numOr = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (v == null) return null;
  const n = Number(v); return Number.isFinite(n) ? n : null;
};
const gp = (a: number | null, b: number | null): number | null => (a != null && b != null ? Math.round(Math.abs(a - b) / GOLD_PIP) : null);

function mapRow(d: Record<string, unknown>): Setup {
  return {
    side: String(d.side) === "sell" ? "sell" : "buy",
    state: String(d.state || "forming"), mode: String(d.mode || "intraday"),
    entry: numOr(d.entry), entryLow: numOr(d.entry_low), entryHigh: numOr(d.entry_high),
    stop: numOr(d.stop), tp1: numOr(d.tp1), tp2: numOr(d.tp2), tp3: numOr(d.tp3),
    breakLevel: numOr(d.watch) ?? numOr(d.invalidation),
    readiness: Math.round(numOr(d.confidence) ?? 0),
    createdAt: String(d.created_at || ""),
  };
}

export async function GET() {
  const supabase = createClient();
  if (supabase) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
  }
  if (CACHE && Date.now() - CACHE.at < TTL_MS) return json({ ...CACHE.body, cached: true });

  const mdKey = process.env.TWELVEDATA_API_KEY;
  const admin = createAdminClient();
  const cols = "side, action, state, mode, entry, entry_low, entry_high, stop, tp1, tp2, tp3, invalidation, watch, confidence, created_at";

  // Prefer the freshest FORMING setup (a genuine "what has to happen to enter"),
  // else a very recent ENTERED trade, else nothing (honest scanning state).
  let setup: Setup | null = null;
  if (admin) {
    try {
      const since12h = new Date(Date.now() - 12 * 3600_000).toISOString();
      const forming = await admin.from("genx_alerts").select(cols)
        .eq("state", "forming").not("entry_low", "is", null).gte("created_at", since12h)
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (forming.data) setup = mapRow(forming.data as Record<string, unknown>);
      else {
        const since3h = new Date(Date.now() - 3 * 3600_000).toISOString();
        const entered = await admin.from("genx_alerts").select(cols)
          .eq("state", "entered").not("entry_low", "is", null).gte("created_at", since3h)
          .order("created_at", { ascending: false }).limit(1).maybeSingle();
        if (entered.data) setup = mapRow(entered.data as Record<string, unknown>);
      }
    } catch { /* scanning state */ }
  }

  // Candles + live price from the shared cached feed (never multiplies usage).
  let candles: Candle[] = [];
  let price: number | null = null;
  if (mdKey) {
    const raw = await series("XAU/USD", "15min", 60, mdKey, false);
    if (Array.isArray(raw)) candles = raw.map((r) => ({ t: r.datetime, o: +r.open, h: +r.high, l: +r.low, c: +r.close })).filter((k) => Number.isFinite(k.c));
    const lp = await livePrice("XAU/USD", mdKey, false);
    price = typeof lp === "number" ? lp : (candles.length ? candles[candles.length - 1].c : null);
  }

  const session = sessionNow(new Date());

  // Conditions checklist + guidance + metrics.
  const conditions: { label: string; met: boolean }[] = [];
  let statusText = "Scanning for a setup";
  let phase = "scanning";
  let guidance = "GENX is scanning gold. No setup is forming right now — when one does, its entry zone, stop, and targets appear here with the exact trigger to enter.";
  let metrics: Metrics | null = null;

  if (setup && price != null) {
    const buy = setup.side === "buy";
    const e = setup.entry, st = setup.stop, tp = setup.tp1, brk = setup.breakLevel;
    const zoneLo = Math.min(setup.entryLow ?? e ?? price, setup.entryHigh ?? e ?? price);
    const zoneHi = Math.max(setup.entryLow ?? e ?? price, setup.entryHigh ?? e ?? price);
    const inZone = price >= zoneLo - 0.5 && price <= zoneHi + 0.5;
    const last = candles.length >= 1 ? candles[candles.length - 1] : null;
    const mom = last ? (buy ? last.c >= last.o : last.c <= last.o) : false;
    const broke = brk != null ? (buy ? price > brk : price < brk) : false;
    conditions.push({ label: brk != null ? `Break ${brk}` : "Break level", met: broke });
    conditions.push({ label: "Price at zone", met: inZone });
    conditions.push({ label: "Momentum confirms", met: mom });

    const risk = gp(e ?? zoneHi, st);
    const reward = gp(e ?? zoneHi, tp);
    metrics = { toEntry: inZone ? 0 : gp(price, buy ? zoneHi : zoneLo), risk, reward, rr: risk && reward ? +(reward / risk).toFixed(1) : null };

    const zoneStr = `${zoneLo.toFixed(2)}–${zoneHi.toFixed(2)}`;
    if (setup.state === "entered") {
      phase = "in_trade"; statusText = "Live — in trade";
      guidance = `GENX is IN this ${buy ? "long" : "short"} from ${(e ?? zoneHi).toFixed(2)}. Managing toward ${tp != null ? tp.toFixed(2) : "target"}${reward != null ? ` (${reward} pips)` : ""}; stop ${st != null ? st.toFixed(2) : "—"}${risk != null ? ` (${risk} pips)` : ""}.`;
    } else if (inZone) {
      phase = "in_zone"; statusText = "At the zone — arming";
      guidance = `Price is IN the ${buy ? "buy" : "sell"} zone (${zoneStr}). GENX enters the moment a candle closes ${buy ? "up" : "down"} with momentum while holding ${st != null ? st.toFixed(2) : "the stop"}.`;
    } else if (buy ? price > zoneHi : price < zoneLo) {
      phase = "await_pullback"; statusText = "Waiting for pullback";
      guidance = `Price is ${metrics.toEntry ?? "—"} pips ${buy ? "above" : "below"} the zone. GENX enters on a pullback into ${zoneStr} that holds ${st != null ? st.toFixed(2) : "the stop"}, then a momentum candle.`;
    } else {
      phase = "reclaim"; statusText = "Needs a reclaim";
      guidance = `Price has pushed ${buy ? "below" : "above"} the zone toward the ${st != null ? st.toFixed(2) : ""} stop. GENX needs a reclaim back into ${zoneStr} for this ${buy ? "long" : "short"} to stay valid.`;
    }
  }

  const body: Payload = { setup, candles, price, session, conditions, statusText, phase, guidance, metrics };
  CACHE = { at: Date.now(), body };
  return json(body);
}
