import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { series, livePrice, isPriorityEmail } from "@/lib/marketData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;

/**
 * GENX LIVE ENTRY CONFIRMATION — the deterministic "is it time to enter yet?"
 * check for a WAIT setup. It is intentionally LIGHTWEIGHT and FREE (no credit
 * charge): the paid GENX read produces the plan (entry zone, invalidation,
 * targets); this endpoint just watches the real candles and reports whether the
 * confirmation the plan requires has actually happened yet.
 *
 * It reacts to CLOSED candles, never a live wick — so it won't flash "ENTER" on
 * a bounce that reverses before the candle closes. States:
 *   WAIT        — price hasn't reached the entry zone yet.
 *   AT_ZONE     — price is at/through the zone; waiting for a confirming close.
 *   CONFIRMED   — a candle CLOSED reacting off the zone, holding invalidation → enter.
 *   INVALIDATED — a candle CLOSED beyond invalidation → the setup is dead.
 *   NO_DATA     — couldn't read fresh candles this moment.
 *
 * Every number comes from the real feed; nothing here is invented.
 */
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

type Row = { datetime: string; open: string; high: string; low: string; close: string };
const numOk = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

// Trigger frame per GENX mode (where the entry is timed).
const IV: Record<string, string> = { quick: "5min", intraday: "15min", swing: "1h" };

export async function POST(req: NextRequest) {
  const supabase = createClient();
  let email: string | null = null;
  if (supabase) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
    email = user.email ?? null;
  }
  const mdKey = process.env.TWELVEDATA_API_KEY;
  if (!mdKey) return json({ state: "NO_DATA", detail: "Market data isn't configured." }, 200);

  let b: {
    side?: unknown; entryLow?: unknown; entryHigh?: unknown; watch?: unknown;
    invalidation?: unknown; mode?: unknown;
  };
  try { b = await req.json(); } catch { return json({ error: "bad_request" }, 400); }

  const side: "buy" | "sell" = b.side === "sell" ? "sell" : "buy";
  const inv = Number(b.invalidation);
  const watch = Number(b.watch);
  let zoneLo = Number(b.entryLow), zoneHi = Number(b.entryHigh);
  if (!numOk(zoneLo) || !numOk(zoneHi)) { zoneLo = watch; zoneHi = watch; }
  if (zoneLo > zoneHi) { const t = zoneLo; zoneLo = zoneHi; zoneHi = t; }
  if (!numOk(inv) || (!numOk(zoneLo) && !numOk(watch))) return json({ state: "NO_DATA", detail: "Missing setup levels." }, 200);

  const interval = IV[String(b.mode)] ?? "5min";
  const fresh = isPriorityEmail(email);

  const rowsRaw = await series("XAU/USD", interval, 24, mdKey, fresh);
  if (rowsRaw === "ratelimit") return json({ state: "BUSY", detail: "Feed busy — retrying shortly." }, 200);
  const rows = (Array.isArray(rowsRaw) ? rowsRaw : []) as Row[];
  if (rows.length < 4) return json({ state: "NO_DATA", detail: "Not enough candles right now." }, 200);

  const live = await livePrice("XAU/USD", mdKey, fresh);
  // The most recent bar is still FORMING; the one before it is the last CLOSED.
  const c = rows.map((r) => ({ o: +r.open, h: +r.high, l: +r.low, c: +r.close }));
  const formingIdx = c.length - 1;
  const lastClosed = c[formingIdx - 1];
  const recentClosed = c.slice(Math.max(0, formingIdx - 5), formingIdx); // last ~5 closed
  const price = numOk(live) ? (live as number) : c[formingIdx].c;
  const buf = Math.max((zoneHi - zoneLo) * 0.15, 0.2); // small tolerance around the zone

  const body = Math.abs(lastClosed.c - lastClosed.o);
  const range = Math.max(lastClosed.h - lastClosed.l, 1e-9);
  const bodyOk = body / range >= 0.4;

  let state: "WAIT" | "AT_ZONE" | "CONFIRMED" | "INVALIDATED";
  let detail = "";
  let enter: number | null = null;

  if (side === "buy") {
    const invalidated = recentClosed.some((k) => k.c < inv);
    const reachedZone = recentClosed.some((k) => k.l <= zoneHi + buf) || price <= zoneHi + buf;
    // Confirming BUY candle: last closed is a real bullish candle whose low tested
    // the zone (or the prior candle did) and that closed back up above the zone and
    // above invalidation — i.e. buyers reacted off support on a completed candle.
    const priorTested = recentClosed.length >= 2 && recentClosed[recentClosed.length - 2].l <= zoneHi + buf;
    const testedZone = lastClosed.l <= zoneHi + buf || priorTested;
    const confirmed =
      lastClosed.c > lastClosed.o && bodyOk && testedZone &&
      lastClosed.c >= zoneLo - buf && lastClosed.c > inv;
    if (invalidated) { state = "INVALIDATED"; detail = `A candle closed below the invalidation (${inv}). This buy setup is done — don't take it.`; }
    else if (confirmed) { state = "CONFIRMED"; enter = +price.toFixed(2); detail = `A green candle closed reacting off ${zoneLo}–${zoneHi} while holding ${inv}. Buyers confirmed — BUY is live.`; }
    else if (reachedZone) { state = "AT_ZONE"; detail = `Price is at the ${zoneLo}–${zoneHi} buy zone. Waiting for a green candle to CLOSE here (not just wick) before entering.`; }
    else { state = "WAIT"; detail = `Price is above the zone. Waiting for a pullback to ${zoneLo}–${zoneHi} first.`; }
  } else {
    const invalidated = recentClosed.some((k) => k.c > inv);
    const reachedZone = recentClosed.some((k) => k.h >= zoneLo - buf) || price >= zoneLo - buf;
    const priorTested = recentClosed.length >= 2 && recentClosed[recentClosed.length - 2].h >= zoneLo - buf;
    const testedZone = lastClosed.h >= zoneLo - buf || priorTested;
    const confirmed =
      lastClosed.c < lastClosed.o && bodyOk && testedZone &&
      lastClosed.c <= zoneHi + buf && lastClosed.c < inv;
    if (invalidated) { state = "INVALIDATED"; detail = `A candle closed above the invalidation (${inv}). This sell setup is done — don't take it.`; }
    else if (confirmed) { state = "CONFIRMED"; enter = +price.toFixed(2); detail = `A red candle closed reacting off ${zoneLo}–${zoneHi} while holding ${inv}. Sellers confirmed — SELL is live.`; }
    else if (reachedZone) { state = "AT_ZONE"; detail = `Price is at the ${zoneLo}–${zoneHi} sell zone. Waiting for a red candle to CLOSE here (not just wick) before entering.`; }
    else { state = "WAIT"; detail = `Price is below the zone. Waiting for a rally up to ${zoneLo}–${zoneHi} first.`; }
  }

  return json({ state, detail, side, price: +price.toFixed(2), enter, zoneLow: zoneLo, zoneHigh: zoneHi, invalidation: inv, interval }, 200);
}
