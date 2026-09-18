/**
 * STYLE SHADOW RECORDER — every style's calls, on the record, before a cent is risked.
 *
 * Each pass builds one market context and asks all three styles what they would take right now. Every setup is
 * written to genx_style_setups (live=false while the style is in shadow) and later graded against the candles
 * that followed. After a day of this the desk can answer "how does Rapid actually do?" with its own numbers
 * instead of a promise — which is the only honest basis for switching a style on for members.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { series, livePrice } from "@/lib/marketData";
import { detectAll } from "./detectors";
import { sessionOf, STYLES, type Bar, type Setup, type StyleCtx, type StyleId } from "./types";

type Admin = NonNullable<ReturnType<typeof createAdminClient>>;
type Row = { datetime?: string; open: string | number; high: string | number; low: string | number; close: string | number };

const toBars = (rows: unknown): Bar[] => {
  if (!Array.isArray(rows)) return [];
  return (rows as Row[])
    .map((r) => ({ t: r.datetime, o: +r.open, h: +r.high, l: +r.low, c: +r.close }))
    .filter((b) => Number.isFinite(b.o) && Number.isFinite(b.h) && Number.isFinite(b.l) && Number.isFinite(b.c));
};

/** One shared context for all three styles. Uses the same cached market data the rest of the desk reads. */
export async function buildStyleCtx(mdKey: string, nowMs = Date.now()): Promise<StyleCtx | null> {
  const [m5r, m15r, h1r, h4r, d1r] = await Promise.all([
    series("XAU/USD", "5min", 120, mdKey, false),
    series("XAU/USD", "15min", 120, mdKey, false),
    series("XAU/USD", "1h", 60, mdKey, false),
    series("XAU/USD", "4h", 60, mdKey, false),
    series("XAU/USD", "1day", 10, mdKey, false),
  ]);
  const m5 = toBars(m5r), m15 = toBars(m15r), h1 = toBars(h1r), h4 = toBars(h4r), d1 = toBars(d1r);
  if (m5.length < 30 || m15.length < 30) return null;
  const lp = await livePrice("XAU/USD", mdKey, false);
  const price = typeof lp === "number" && lp > 0 ? lp : m5[m5.length - 1].c;
  const prevDay = d1.length >= 2 ? d1[d1.length - 2] : null;
  return {
    price, atr: null, pip: 0.1, nowMs, m5, m15, h1, h4, d1,
    session: sessionOf(nowMs),
    pdh: prevDay ? prevDay.h : null,
    pdl: prevDay ? prevDay.l : null,
  };
}

/** A setup is "the same setup" while it sits on the same level, same side, in the same hour. */
export function shadowKey(s: Setup, nowMs: number): string {
  const hour = new Date(nowMs).toISOString().slice(0, 13);
  return `${s.side}:${s.level != null ? Math.round(s.level) : Math.round(s.entryLow)}:${hour}`;
}

/** Record whatever the styles see right now. Returns how many new setups were written per style. */
export async function recordStyleSetups(admin: Admin, mdKey: string, nowMs = Date.now()): Promise<Record<StyleId, number>> {
  const out = { rapid: 0, structure: 0, swing: 0 } as Record<StyleId, number>;
  const ctx = await buildStyleCtx(mdKey, nowMs);
  if (!ctx) return out;
  const found = detectAll(ctx);
  for (const style of STYLES) {
    const s = found[style];
    if (!s) continue;
    const { error } = await admin.from("genx_style_setups").insert({
      style, side: s.side, dedupe_key: shadowKey(s, nowMs), price: ctx.price,
      entry_low: s.entryLow, entry_high: s.entryHigh, stop: s.stop, tp1: s.tp1, tp2: s.tp2,
      confidence: s.confidence, level: s.level, reason: s.reason, live: false,
    });
    if (!error) out[style] += 1;                       // a duplicate key is the same setup, not a new one
  }
  return out;
}

/** Grade open shadow setups against the candles that followed: TP1 first = win, stop first = loss. */
export async function resolveStyleSetups(admin: Admin, mdKey: string, nowMs = Date.now()): Promise<number> {
  const { data } = await admin.from("genx_style_setups")
    .select("id,at,style,side,price,stop,tp1").is("outcome", null)
    .lt("at", new Date(nowMs - 5 * 60_000).toISOString()).order("at", { ascending: true }).limit(50);
  const rows = (data ?? []) as { id: string; at: string; style: string; side: string; price: number; stop: number; tp1: number }[];
  if (!rows.length) return 0;
  const bars = toBars(await series("XAU/USD", "5min", 300, mdKey, false));
  if (!bars.length) return 0;
  let graded = 0;
  for (const r of rows) {
    const t0 = Date.parse(r.at);
    const after = bars.filter((b) => (b.t ? Date.parse(String(b.t)) : 0) >= t0);
    if (!after.length) continue;
    const long = r.side === "buy";
    let outcome: string | null = null;
    for (const b of after) {
      const hitTp = long ? b.h >= r.tp1 : b.l <= r.tp1;
      const hitSl = long ? b.l <= r.stop : b.h >= r.stop;
      if (hitTp && hitSl) { outcome = "unclear"; break; }     // both inside one candle — don't claim a win
      if (hitTp) { outcome = "target"; break; }
      if (hitSl) { outcome = "stop"; break; }
    }
    // Still open after 8 hours with neither level touched: call it expired so the record stays honest.
    if (!outcome && nowMs - t0 > 8 * 3600_000) outcome = "expired";
    if (!outcome) continue;
    const pips = outcome === "target" ? Math.round(Math.abs(r.tp1 - r.price) / 0.1)
      : outcome === "stop" ? -Math.round(Math.abs(r.price - r.stop) / 0.1) : 0;
    await admin.from("genx_style_setups").update({ outcome, result_pips: pips, resolved_at: new Date(nowMs).toISOString() }).eq("id", r.id);
    graded += 1;
  }
  return graded;
}

/** The scoreboard: what each style has actually done. */
export async function styleScoreboard(admin: Admin, sinceMs: number): Promise<Record<StyleId, { setups: number; wins: number; losses: number; pips: number }>> {
  const out = { rapid: { setups: 0, wins: 0, losses: 0, pips: 0 }, structure: { setups: 0, wins: 0, losses: 0, pips: 0 }, swing: { setups: 0, wins: 0, losses: 0, pips: 0 } };
  const { data } = await admin.from("genx_style_setups").select("style,outcome,result_pips").gte("at", new Date(sinceMs).toISOString()).limit(2000);
  for (const r of (data ?? []) as { style: StyleId; outcome: string | null; result_pips: number | null }[]) {
    const s = out[r.style]; if (!s) continue;
    s.setups += 1;
    if (r.outcome === "target") s.wins += 1;
    else if (r.outcome === "stop") s.losses += 1;
    s.pips += Math.round(Number(r.result_pips) || 0);
  }
  return out;
}
