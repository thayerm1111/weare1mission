/**
 * OM AI live market feed — REAL prices via Twelve Data (the same governed feed
 * the rest of the app uses). No fabrication.
 *
 * Resolves an instrument the member names (gold/XAUUSD, major FX pairs, metals,
 * indices, crypto, tickers) to a Twelve Data symbol, pulls real 1h + 5m candles
 * and the live price through the community governor/cache in lib/marketData, and
 * derives the structure a trader frames a setup from — HTF trend, range position
 * (premium/discount), session & swing highs/lows, and ATR for stop sizing.
 *
 * Returns a formatted LIVE MARKET DATA block, a short "busy" note if the feed is
 * rate-limited, or null when the instrument can't be resolved / data is missing.
 * It never invents a price.
 */
import { series, livePrice, type Row } from "@/lib/marketData";

const CCY = new Set(["USD", "EUR", "GBP", "JPY", "AUD", "NZD", "CAD", "CHF", "CNH", "SEK", "NOK", "MXN", "ZAR", "SGD", "HKD"]);

// Friendly aliases → Twelve Data display symbol + label.
const ALIASES: Record<string, { td: string; label: string }> = {
  gold: { td: "XAU/USD", label: "XAU/USD (Gold)" },
  xauusd: { td: "XAU/USD", label: "XAU/USD (Gold)" },
  xau: { td: "XAU/USD", label: "XAU/USD (Gold)" },
  silver: { td: "XAG/USD", label: "XAG/USD (Silver)" },
  xagusd: { td: "XAG/USD", label: "XAG/USD (Silver)" },
  oil: { td: "WTI/USD", label: "WTI Crude Oil" },
  usoil: { td: "WTI/USD", label: "WTI Crude Oil" },
  wti: { td: "WTI/USD", label: "WTI Crude Oil" },
  btc: { td: "BTC/USD", label: "BTC/USD" },
  bitcoin: { td: "BTC/USD", label: "BTC/USD" },
  btcusd: { td: "BTC/USD", label: "BTC/USD" },
  eth: { td: "ETH/USD", label: "ETH/USD" },
  ethereum: { td: "ETH/USD", label: "ETH/USD" },
  sol: { td: "SOL/USD", label: "SOL/USD" },
  nas100: { td: "NAS100", label: "Nasdaq 100 (NAS100)" },
  us100: { td: "NAS100", label: "Nasdaq 100 (NAS100)" },
  ndx: { td: "NAS100", label: "Nasdaq 100 (NAS100)" },
  nq: { td: "NAS100", label: "Nasdaq 100 (NAS100)" },
  nasdaq: { td: "NAS100", label: "Nasdaq 100 (NAS100)" },
  spx: { td: "SPX", label: "S&P 500 (SPX)" },
  spx500: { td: "SPX", label: "S&P 500 (SPX)" },
  us500: { td: "SPX", label: "S&P 500 (SPX)" },
  sp500: { td: "SPX", label: "S&P 500 (SPX)" },
};

export type Resolved = { td: string; label: string };

/** Find the instrument the member is asking about in their message. */
export function resolveInstrument(text: string): Resolved | null {
  const t = (text || "").toLowerCase();
  for (const key of Object.keys(ALIASES)) {
    if (new RegExp(`\\b${key}\\b`, "i").test(t)) return ALIASES[key];
  }
  const up = (text || "").toUpperCase();
  // Explicit pair like XAUUSD / EURUSD / GBPJPY (also with a slash).
  const fx = up.match(/\b(XAU|XAG|[A-Z]{3})[\/ ]?([A-Z]{3})\b/);
  if (fx && CCY.has(fx[2]) && (fx[1] === "XAU" || fx[1] === "XAG" || CCY.has(fx[1]))) {
    if (fx[1] === "XAU") return { td: "XAU/USD", label: "XAU/USD (Gold)" };
    if (fx[1] === "XAG") return { td: "XAG/USD", label: "XAG/USD (Silver)" };
    return { td: `${fx[1]}/${fx[2]}`, label: `${fx[1]}/${fx[2]}` };
  }
  // $TICKER stock mention.
  const tk = up.match(/\$([A-Z]{1,5})\b/);
  if (tk) return { td: tk[1], label: tk[1] };
  return null;
}

type C = { t: number; o: number; h: number; l: number; c: number };
function toCandles(rows: Row[] | "ratelimit" | null): C[] | "ratelimit" | null {
  if (rows === "ratelimit") return "ratelimit";
  if (!rows || !rows.length) return null;
  const out: C[] = [];
  for (const r of rows) {
    const o = Number(r.open), h = Number(r.high), l = Number(r.low), c = Number(r.close);
    const iso = r.datetime.includes(" ") ? r.datetime.replace(" ", "T") + "Z" : r.datetime + "T00:00:00Z";
    const t = Date.parse(iso);
    if ([o, h, l, c].every(Number.isFinite)) out.push({ t: Number.isFinite(t) ? t : 0, o, h, l, c });
  }
  return out.length ? out : null;
}

function round(n: number): number {
  const a = Math.abs(n);
  const dp = a >= 1000 ? 1 : a >= 100 ? 2 : a >= 1 ? 3 : 5;
  return +n.toFixed(dp);
}
function atr(c: C[], period = 14): number | null {
  if (c.length < period + 1) return null;
  let s = 0;
  for (let i = c.length - period; i < c.length; i++) {
    const cur = c[i], prev = c[i - 1];
    s += Math.max(cur.h - cur.l, Math.abs(cur.h - prev.c), Math.abs(cur.l - prev.c));
  }
  return s / period;
}
function sma(nums: number[], n: number): number | null {
  if (nums.length < n) return null;
  const s = nums.slice(-n);
  return s.reduce((a, b) => a + b, 0) / s.length;
}

/**
 * Build the LIVE MARKET DATA context block, a "busy" note, or null.
 * `fresh` = owner/admin bypasses cache + throttle (via lib/marketData).
 */
export async function getMarketContext(inst: Resolved, key: string, fresh: boolean): Promise<string | null> {
  const [htfR, scalpR, priceLive] = await Promise.all([
    series(inst.td, "1h", 150, key, fresh),
    series(inst.td, "5min", 200, key, fresh),
    livePrice(inst.td, key, fresh),
  ]);
  const htf = toCandles(htfR);
  const scalp = toCandles(scalpR);
  if (htf === "ratelimit" || scalp === "ratelimit") {
    return `LIVE MARKET DATA: the market feed is momentarily busy (rate-limited). Tell the member you couldn't pull a fresh ${inst.label} read this second — ask them to try again in a moment or attach their chart, and don't invent levels.`;
  }
  const src = htf && htf.length >= 20 ? htf : scalp;
  if (!src || !src.length) return null;
  const price = Number.isFinite(priceLive as number) ? (priceLive as number) : src[src.length - 1].c;

  // Staleness / session sense.
  const lastT = src[src.length - 1].t;
  const ageMin = lastT ? Math.round((Date.now() - lastT) / 60000) : null;
  const stale = ageMin != null && ageMin > 120;

  // HTF trend + range position.
  const hc = htf && htf.length >= 20 ? htf : src;
  const closes = hc.map((x) => x.c);
  const look = hc.slice(-40);
  const hi = Math.max(...look.map((x) => x.h));
  const lo = Math.min(...look.map((x) => x.l));
  const pos = hi > lo ? (price - lo) / (hi - lo) : 0.5;
  const zone = pos >= 0.62 ? "PREMIUM (upper third — favours shorts / selling rallies)"
    : pos <= 0.38 ? "DISCOUNT (lower third — favours longs / buying dips)"
    : "EQUILIBRIUM (mid-range — wait for a sweep to an extreme)";
  const s20 = sma(closes, 20), s50 = sma(closes, 50);
  const trend = s20 != null && s50 != null
    ? (price > s20 && s20 >= s50 ? "UP (price > rising 20MA, 20>50)"
      : price < s20 && s20 <= s50 ? "DOWN (price < falling 20MA, 20<50)"
      : "RANGING / mixed")
    : "unclear (limited history)";

  // Scalp-TF session extremes + ATR + nearest swings.
  const sc = scalp && scalp.length ? scalp : src;
  const sess = sc.slice(-Math.min(sc.length, 78));
  const dayHi = Math.max(...sess.map((x) => x.h));
  const dayLo = Math.min(...sess.map((x) => x.l));
  const a = atr(sc, 14);
  const win = sc.slice(-60);
  const above = win.map((x) => x.h).filter((h) => h > price).sort((x, y) => x - y);
  const below = win.map((x) => x.l).filter((l) => l < price).sort((x, y) => y - x);
  const resis = above.length ? above[Math.min(2, above.length - 1)] : hi;
  const supp = below.length ? below[Math.min(2, below.length - 1)] : lo;

  const L: string[] = [];
  L.push(`LIVE MARKET DATA — ${inst.label} (source: Twelve Data${ageMin != null ? `, last candle ~${ageMin}m ago` : ""}).`);
  if (stale) L.push(`NOTE: last print is ${ageMin}m old — market likely closed / off-session. Treat this as the level map for the next open, not a live tick.`);
  L.push(`Current price: ${round(price)}`);
  L.push(`Higher-TF (1H) trend: ${trend}.`);
  L.push(`Range position: ${zone} (recent 1H range ${round(lo)}–${round(hi)}).`);
  L.push(`Session (5m) high / low: ${round(dayHi)} / ${round(dayLo)}.`);
  L.push(`Nearest overhead level ≈ ${round(resis)}; nearest support ≈ ${round(supp)}.`);
  if (a != null) L.push(`5m ATR(14) ≈ ${round(a)} — size the scalp stop ~1–1.5× ATR beyond the invalidation level.`);
  L.push(`These are indicative feed prices, NOT the member's broker quote — they must align exact numbers to their own chart before acting.`);
  return L.join("\n");
}
