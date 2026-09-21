/**
 * THE INTELLIGENCE PRESENTATION LAYER — gauges, not steering.
 *
 * Everything in this folder turns what ATLAS has ALREADY measured into things a person can read at a
 * glance: pressure trends, a structure summary, liquidity above and below, scenario ranking, a velocity
 * and volatility band. It exists so the Command Center screen can show far more of the engine's own
 * state without inventing a second opinion.
 *
 * ONE-WAY BY CONSTRUCTION.
 *
 *   market data → engine → snapshot / thesis / events → THIS FILE → the screen
 *
 * Nothing under command-center/core, engines (except the live read that serves the screen), brain,
 * adapters or worker imports this folder, and tests/cc-present-isolation.test.ts fails the build if one
 * ever does. Its outputs never reach setup finding, validation, sizing, execution or management.
 *
 * NO FAKE PRECISION. The engine has no probability model, so this does not publish probabilities.
 * Scenarios are ranked PRIMARY / ALTERNATIVE / LOWER, and the only percentage shown is the thesis's own
 * confidence, which the engine computes and records.
 */
import type { Bar, Level, MarketSnapshot, Timeframe } from "../core/types";
import type { BrainThesis, PerceptionEvent } from "../brain/types";
import { aboveBelow, swings } from "../core/levelMap";

export type Band = { value: number | null; label: string; tone: "up" | "down" | "gold" | "cold" | "mut" };

export type Intel = {
  /** Today's range from the engine's own levels (New York day), and change vs the daily open. */
  day: { high: number | null; low: number | null; range: number | null; open: number | null; change: number | null; changePct: number | null };
  /** Market mode headline, e.g. "TRENDING BEARISH" — built from regime + thesis bias. */
  mode: { label: string; tone: "up" | "down" | "gold" | "cold" | "mut" };
  pressure: {
    buyers: number | null; sellers: number | null; dominant: "buyers" | "sellers" | "balanced";
    /** Net pressure change over each horizon the engine diffs (5m, 15m, …). Positive = toward buyers. */
    trend: { horizon: string; from: number; to: number }[];
    buyerLabel: string; sellerLabel: string;
    /** The move over the shortest horizon the engine diffs, for "strengthening / weakening over X". */
    change: { horizon: string; deltaNet: number; buyersDelta: number; sellersDelta: number; direction: "toward buyers" | "toward sellers" | "flat" } | null;
    /** What the number is and is not. Shown on the gauges, never shortened into "order flow". */
    method: string;
    complementary: true;
  };
  velocity: Band & { band: string };
  volatility: Band & { band: string; atr: number | null };
  momentum: Band;
  alignment: {
    rows: { tf: string; state: string; dir: "up" | "down" | "flat"; word: string }[];
    bias: "BULLISH BIAS" | "BEARISH BIAS" | "MIXED" | "NO READ";
    agree: number;
  };
  structure: {
    tf: string | null; trend: string; sequence: string; phase: string;
    swingHigh: number | null; swingLow: number | null;
    brokeStructure: "up" | "down" | null; sweptLevel: number | null;
    nextWatched: number | null; invalidation: number | null;
  };
  liquidity: {
    above: { price: number; label: string; swept: boolean }[];
    below: { price: number; label: string; swept: boolean }[];
    aboveZone: [number, number] | null; belowZone: [number, number] | null;
  };
  keyLevels: { price: number; label: string; role: "resistance" | "support" | "price" | "watch" | "invalidation"; watched: boolean }[];
  /**
   * THE LIQUIDITY RADAR's blips. Every one is a price the engine (or this display layer) actually
   * measured, with the plain meaning shown on hover. Nothing here claims to see resting orders: gold is
   * over the counter and no feed in this system carries a book, so these are levels where stops and
   * resting interest are LIKELY to sit, and they say so.
   */
  radar: {
    price: number;
    kind: "buyside" | "sellside" | "equal_high" | "equal_low" | "node" | "watch";
    label: string;
    meaning: string;
    swept: boolean;
    side: "above" | "below";
    distance: number;
  }[];
  scenarios: { rank: "PRIMARY" | "ALTERNATIVE" | "LOWER"; kind: "bear" | "bull" | "range"; title: string; detail: string }[];
  /** A path consistent with the thesis, for the chart. Informational; never a prediction. */
  path: { points: number[]; label: string } | null;
  news: { name: string; at: number; importance: string; minutesTo: number | null; lockout: boolean } | null;
  /** Classified stream for the filter chips. */
  streamKinds: Record<string, "price" | "structure" | "news" | "trade">;
};

const words = (s: string) => s.replace(/_/g, " ");
const title = (s: string) => words(s).replace(/\b\w/g, (c) => c.toUpperCase());
const r2 = (n: number) => +n.toFixed(2);

const TF_ORDER: Timeframe[] = ["1d", "4h", "1h", "15m", "5m"];

export function dirOf(state: string): "up" | "down" | "flat" {
  if (/strong_up|uptrend|bullish/.test(state)) return "up";
  if (/strong_down|downtrend|bearish/.test(state)) return "down";
  return "flat";
}

export function kindOfEvent(code: string): "price" | "structure" | "news" | "trade" {
  if (/NEWS|SESSION|MARKET_(CLOSED|OPENED)|FEED/.test(code)) return "news";
  if (/TRADE_/.test(code)) return "trade";
  if (/STRUCTURE|LEVEL|BREAKOUT|RETEST|LIQUIDITY|REGIME|TIMEFRAME/.test(code)) return "structure";
  return "price";
}

/** Minutes in a diff horizon label ("5m", "15m", "1h"), for picking the shortest one. */
function horizonMin(h: string): number {
  const n = parseFloat(h);
  return /h$/.test(h) ? n * 60 : n;
}

/**
 * EQUAL HIGHS AND LOWS — display only.
 *
 * Prices the market has stopped at more than once within a tolerance. Traders read repeated touches as
 * where stops cluster; this only reports the repetition it can see in the candles, and the UI labels it
 * as estimated. Nothing here is fed to the engine.
 */
export function equalLevels(bars: Bar[], tol: number, minCount = 2): { price: number; kind: "high" | "low"; count: number }[] {
  if (bars.length < 12) return [];
  const recent = bars.slice(-200);
  const { highs, lows } = swings(recent, 2);
  const cluster = (pts: number[], kind: "high" | "low") => {
    const used = new Array(pts.length).fill(false);
    const out: { price: number; kind: "high" | "low"; count: number }[] = [];
    for (let i = 0; i < pts.length; i++) {
      if (used[i]) continue;
      const group = [pts[i]];
      used[i] = true;
      for (let j = i + 1; j < pts.length; j++) {
        if (!used[j] && Math.abs(pts[j] - pts[i]) <= tol) { group.push(pts[j]); used[j] = true; }
      }
      if (group.length >= minCount) out.push({ price: +(group.reduce((a, b) => a + b, 0) / group.length).toFixed(2), kind, count: group.length });
    }
    return out;
  };
  return [...cluster(highs.map((b) => b.h), "high"), ...cluster(lows.map((b) => b.l), "low")]
    .sort((a, b) => b.count - a.count).slice(0, 4);
}

/** The price the most recent candles overlapped most — display only, weighted by tick activity if the feed has it. */
export function busiestPrice(bars: Bar[]): number | null {
  const bs = bars.slice(-240);
  if (bs.length < 20) return null;
  const lo = Math.min(...bs.map((b) => b.l)), hi = Math.max(...bs.map((b) => b.h));
  const bins = 40, w = (hi - lo) / bins;
  if (!(w > 0)) return null;
  const acc = new Array(bins).fill(0);
  for (const b of bs) {
    const a = Math.max(0, Math.floor((b.l - lo) / w)), z = Math.min(bins - 1, Math.floor((b.h - lo) / w));
    const weight = b.v && b.v > 0 ? b.v : 1;
    for (let k = a; k <= z; k++) acc[k] += weight / Math.max(1, z - a + 1);
  }
  const k = acc.indexOf(Math.max(...acc));
  return +(lo + (k + 0.5) * w).toFixed(2);
}

export function buildIntel(i: {
  s: MarketSnapshot;
  thesis: BrainThesis | null;
  events: PerceptionEvent[];
  changes: { horizon: string; pressureFrom: number; pressureTo: number }[];
  velocityBand: string;
  weather: string;
  bars: Bar[];
}): Intel {
  const { s, thesis } = i;
  const lv = (k: string) => s.levels.find((l) => l.kind === k)?.price ?? null;

  /* day */
  const high = lv("dh"), low = lv("dl"), open = lv("daily_open");
  const change = open != null ? r2(s.price - open) : null;
  const day = {
    high, low, open, change,
    range: high != null && low != null ? r2(high - low) : null,
    changePct: open != null && open > 0 ? +(((s.price - open) / open) * 100).toFixed(2) : null,
  };

  /* mode */
  const rawBias = thesis?.bias ?? "neutral";
  const bias: "bullish" | "bearish" | "neutral" = rawBias.startsWith("bull") ? "bullish" : rawBias.startsWith("bear") ? "bearish" : "neutral";
  const regimeWord = /trend/.test(s.regime) ? "TRENDING" : /compression|squeeze|range/.test(s.regime) ? "RANGING" : /expansion|breakout/.test(s.regime) ? "EXPANDING" : /chaotic/.test(s.regime) ? "CHAOTIC" : /sweep/.test(s.regime) ? "SWEEPING" : words(s.regime).toUpperCase();
  const mode = {
    label: `${regimeWord} ${bias === "bullish" ? "BULLISH" : bias === "bearish" ? "BEARISH" : "NEUTRAL"}`.trim(),
    tone: (bias === "bullish" ? "up" : bias === "bearish" ? "down" : "cold") as Intel["mode"]["tone"],
  };

  /* pressure — the engine's own estimate (closes, wicks, momentum), not order flow */
  const buyers = Math.round(s.pressure.bullish), sellers = Math.round(s.pressure.bearish);
  const dominant = Math.abs(buyers - sellers) < 6 ? "balanced" : buyers > sellers ? "buyers" : "sellers";
  const p5 = i.changes.find((c) => c.horizon === "5m");
  const easing = (side: "b" | "s") => {
    if (!p5) return null;
    const d = p5.pressureTo - p5.pressureFrom; // positive = toward buyers
    if (Math.abs(d) < 3) return null;
    return side === "s" ? (d > 0 ? "Easing" : "Building") : (d > 0 ? "Building" : "Fading");
  };
  const shortest = i.changes.slice().sort((a, b) => horizonMin(a.horizon) - horizonMin(b.horizon))[0] ?? null;
  const deltaNet = shortest ? Math.round(shortest.pressureTo - shortest.pressureFrom) : 0;
  const pressure: Intel["pressure"] = {
    buyers, sellers, dominant: dominant as Intel["pressure"]["dominant"],
    trend: i.changes.map((c) => ({ horizon: c.horizon, from: Math.round(c.pressureFrom), to: Math.round(c.pressureTo) })),
    buyerLabel: dominant === "buyers" ? "Dominant" : easing("b") ?? (buyers < 35 ? "Weak" : "Holding"),
    sellerLabel: dominant === "sellers" ? "Dominant" : easing("s") ?? (sellers < 35 ? "Weak" : "Holding"),
    // Net pressure runs −100 (all sellers) to +100 (all buyers), so each side's share moves by half the
    // net move. Stated rather than implied, because a "+12" with no scale is not a measurement.
    change: shortest ? {
      horizon: shortest.horizon,
      deltaNet,
      buyersDelta: Math.round(deltaNet / 2),
      sellersDelta: -Math.round(deltaNet / 2),
      direction: Math.abs(deltaNet) < 3 ? "flat" : deltaNet > 0 ? "toward buyers" : "toward sellers",
    } : null,
    method: "Estimated buying and selling pressure — scored 0–100 by the engine (core/regime.ts) from where candles close inside their range, which side the wicks punish, momentum, trend slope and whether a structure break was accepted. The two sides are complementary by construction: sellers = 100 − buyers. It is NOT order flow, and it is not a probability of winning.",
    complementary: true,
  };

  /* velocity / volatility / momentum — bands the engine already names */
  const exec = s.timeframes["5m"] ?? s.timeframes["15m"];
  const f = exec?.features;
  const velTone = /extreme|accelerating|fast/.test(i.velocityBand) ? "gold" : /decelerating|calm/.test(i.velocityBand) ? "cold" : "mut";
  const velocity = { band: i.velocityBand, value: f && f.atr ? +(Math.abs(f.velocity) / f.atr).toFixed(2) : null, label: title(i.velocityBand), tone: velTone as Band["tone"] };
  const volWord: Record<string, string> = { extreme: "Extreme", expanding: "Expanding", active: "Elevated", normal: "Normal", quiet: "Low", compressed: "Compressed", news_shock: "News shock" };
  const f15 = s.timeframes["15m"]?.features ?? f;
  const volatility = {
    band: i.weather, atr: f15?.atr != null ? r2(f15.atr) : null,
    value: f15?.atr != null ? r2(f15.atr) : null,
    label: volWord[i.weather] ?? title(i.weather),
    tone: (/extreme|expanding|active|news/.test(i.weather) ? "gold" : "cold") as Band["tone"],
  };
  // Momentum: the 15-minute frame's own 5-bar return, which the engine already measures in ATR units
  // (core/math.ts). Shown as-is — a reading of −1.6 means price fell 1.6 average ranges in five bars.
  const r5 = f15?.returns5 ?? null;
  const momentum = {
    value: r5 != null && Number.isFinite(r5) ? r2(r5) : null,
    label: r5 == null ? "—" : r5 <= -0.5 ? "Bearish" : r5 >= 0.5 ? "Bullish" : "Flat",
    tone: (r5 == null ? "mut" : r5 <= -0.5 ? "down" : r5 >= 0.5 ? "up" : "cold") as Band["tone"],
  };

  /* alignment */
  // Short words, because the cards are narrow: a truncated "Volatility Expa…" tells a trader nothing.
  const SHORT: Record<string, string> = {
    compression: "Coiled", range: "Range", volatility_expansion: "Expanding", breakout: "Breakout",
    chaotic: "Chaotic", reversal: "Reversal", retest: "Retest", quiet: "Quiet",
  };
  const rows = TF_ORDER.filter((tf) => s.timeframes[tf]).map((tf) => {
    const st = s.timeframes[tf]!.state;
    const dir = dirOf(st);
    return { tf, state: st, dir, word: dir === "up" ? "Bullish" : dir === "down" ? "Bearish" : SHORT[st] ?? title(st).split(" ")[0] };
  });
  const ups = rows.filter((r) => r.dir === "up").length, downs = rows.filter((r) => r.dir === "down").length;
  const alignment = {
    rows,
    bias: (!rows.length ? "NO READ" : downs > ups && downs >= 2 ? "BEARISH BIAS" : ups > downs && ups >= 2 ? "BULLISH BIAS" : "MIXED") as Intel["alignment"]["bias"],
    agree: Math.max(ups, downs),
  };

  /* structure — the 15m frame's own structure read, else 5m */
  const stTf = s.timeframes["15m"] ? "15m" : s.timeframes["5m"] ? "5m" : null;
  const st = stTf ? s.timeframes[stTf as Timeframe]!.structure : null;
  const seqWord: Record<string, string> = { HH_HL: "Higher Highs / Lows", LH_LL: "Lower Highs / Lows", mixed: "Mixed", unknown: "Unclear" };
  const trendWord = st?.sequence === "LH_LL" ? "Downtrend" : st?.sequence === "HH_HL" ? "Uptrend" : stTf ? title(s.timeframes[stTf as Timeframe]!.state) : "—";
  const phase = /sweep/.test(s.regime) ? "Liquidity sweep" : /compression|squeeze/.test(s.regime) ? "Compression" : /range/.test(s.regime) ? "Range" : /expansion|breakout/.test(s.regime) ? "Expansion" : title(s.regime);
  const watched = thesis?.watching ?? [];
  const nextWatched = watched.length
    ? watched.slice().sort((a, b) => Math.abs(a - s.price) - Math.abs(b - s.price))[0]
    : null;

  /* liquidity — every level the engine and the history map hold, split by side, swept ones flagged */
  const sweptPrices = i.events.filter((e) => e.code === "LIQUIDITY_SWEEP").map((e) => Number(e.data?.level ?? e.level?.price ?? NaN)).filter(Number.isFinite);
  const isSwept = (p: number) => sweptPrices.some((x) => Math.abs(x - p) < 0.6) || (st?.sweptLevel != null && Math.abs(st.sweptLevel - p) < 0.6);
  const ab = aboveBelow(s.price, [s.levels, s.map ?? []], 8);
  const tag = (l: Level) => ({ price: l.price, label: l.label, swept: isSwept(l.price) });
  const zone = (ls: Level[]): [number, number] | null => ls.length >= 2 ? [Math.min(ls[0].price, ls[1].price), Math.max(ls[0].price, ls[1].price)] : ls.length ? [ls[0].price, ls[0].price] : null;
  const liquidity = { above: ab.above.map(tag), below: ab.below.map(tag), aboveZone: zone(ab.above), belowZone: zone(ab.below) };

  /* key levels — three above, price, three below, with the thesis's own watch and invalidation marked */
  const inv = thesis?.invalidationPrice ?? null;
  const near = (p: number, list: number[]) => list.some((w) => Math.abs(w - p) < 0.3);
  const keyLevels: Intel["keyLevels"] = [
    ...ab.above.slice(0, 3).reverse().map((l) => ({ price: l.price, label: l.label, role: (inv != null && Math.abs(inv - l.price) < 0.3 ? "invalidation" : "resistance") as Intel["keyLevels"][number]["role"], watched: near(l.price, watched) })),
    { price: r2(s.price), label: "Current price", role: "price", watched: false },
    ...ab.below.slice(0, 3).map((l) => ({ price: l.price, label: l.label, role: (inv != null && Math.abs(inv - l.price) < 0.3 ? "invalidation" : "support") as Intel["keyLevels"][number]["role"], watched: near(l.price, watched) })),
  ];
  for (const w of watched) {
    if (!keyLevels.some((k) => Math.abs(k.price - w) < 0.3)) keyLevels.push({ price: r2(w), label: "Atlas watch level", role: "watch", watched: true });
  }
  if (inv != null && !keyLevels.some((k) => Math.abs(k.price - inv) < 0.3)) keyLevels.push({ price: r2(inv), label: "Read fails here", role: "invalidation", watched: false });
  keyLevels.sort((a, b) => b.price - a.price);

  /* scenarios — ranked by the thesis bias, no percentages */
  const up1 = ab.above[0]?.price, up2 = ab.above[1]?.price, dn1 = ab.below[0]?.price, dn2 = ab.below[1]?.price;
  const f2 = (n: number | undefined) => (n == null ? "—" : n.toFixed(2));
  const bear = { kind: "bear" as const, title: "Bearish continuation", detail: dn1 != null ? `Lose ${f2(dn1)}${dn2 != null ? ` → ${f2(dn2)}` : ""}` : "Lose the session low" };
  const bull = { kind: "bull" as const, title: "Bullish reclaim", detail: up1 != null ? `Reclaim ${f2(inv ?? up1)}${up2 != null ? ` → ${f2(up2)}` : ""}` : "Break the session high" };
  const range = { kind: "range" as const, title: "Range / wait", detail: dn1 != null && up1 != null ? `Hold ${f2(dn1)} – ${f2(up1)}` : "No side breaks" };
  const order = bias === "bearish" ? [bear, range, bull] : bias === "bullish" ? [bull, range, bear] : [range, bull, bear];
  const scenarios = order.map((o, k) => ({ ...o, rank: (["PRIMARY", "ALTERNATIVE", "LOWER"] as const)[k] }));

  /* path — price → the nearest watched level against the bias (a retest) → the next level with it */
  let path: Intel["path"] = null;
  if (bias === "bearish" && dn1 != null) {
    const retest = up1 != null && up1 - s.price < (s.price - dn1) * 1.2 ? up1 : null;
    path = { points: [s.price, ...(retest != null ? [r2((s.price + retest) / 2)] : []), dn1, ...(dn2 != null ? [dn2] : [])], label: "Atlas scenario · potential path" };
  } else if (bias === "bullish" && up1 != null) {
    const retest = dn1 != null && s.price - dn1 < (up1 - s.price) * 1.2 ? dn1 : null;
    path = { points: [s.price, ...(retest != null ? [r2((s.price + retest) / 2)] : []), up1, ...(up2 != null ? [up2] : [])], label: "Atlas scenario · potential path" };
  }

  const news = s.news?.nextEvent
    ? { name: s.news.nextEvent.name, at: s.news.nextEvent.at, importance: s.news.nextEvent.importance, minutesTo: s.news.minutesToNext, lockout: s.news.inLockout }
    : null;

  /* ── the radar ─────────────────────────────────────────────────────────
   * Levels the engine holds, plus two display-only detections: equal highs/lows (prices tested more than
   * once within a tick or two — where stops cluster) and the busiest price in the recent candles.
   */
  const radar: Intel["radar"] = [];
  const pushBlip = (price: number, kind: Intel["radar"][number]["kind"], label: string, meaning: string, swept: boolean) => {
    if (!Number.isFinite(price) || radar.some((b) => Math.abs(b.price - price) < 0.15)) return;
    radar.push({ price: +price.toFixed(2), kind, label, meaning, swept, side: price >= s.price ? "above" : "below", distance: +Math.abs(price - s.price).toFixed(2) });
  };
  for (const w of watched) pushBlip(w, "watch", "Atlas watch level", "ATLAS is watching this price for its current read.", isSwept(w));
  for (const l of ab.above.slice(0, 6)) {
    pushBlip(l.price, "buyside", l.label, `Above price — ${isSwept(l.price) ? "already swept once. " : ""}Potential liquidity: stops from shorts and breakout orders usually sit above a level like this.`, isSwept(l.price));
  }
  for (const l of ab.below.slice(0, 6)) {
    pushBlip(l.price, "sellside", l.label, `Below price — ${isSwept(l.price) ? "already swept once. " : ""}Potential liquidity: stops from longs and breakdown orders usually sit below a level like this.`, isSwept(l.price));
  }
  for (const e of equalLevels(i.bars, Math.max(0.3, (f15?.atr ?? 3) * 0.08))) {
    pushBlip(e.price, e.kind === "high" ? "equal_high" : "equal_low",
      `Equal ${e.kind}s ×${e.count}`,
      `Price stopped within a few cents of ${e.price.toFixed(2)} ${e.count} times. Estimated liquidity: repeated touches are where stop orders tend to pile up.`,
      isSwept(e.price));
  }
  const node = busiestPrice(i.bars);
  if (node != null) pushBlip(node, "node", "Busiest price", "Where the most candle activity has overlapped recently — a price the market keeps trading around. Derived from candles, not from traded volume.", false);
  radar.sort((a, b) => a.distance - b.distance);

  const streamKinds: Intel["streamKinds"] = {};
  for (const e of i.events) streamKinds[e.key] = kindOfEvent(e.code);

  return {
    day, mode, pressure, velocity, volatility, momentum, alignment,
    structure: {
      tf: stTf, trend: trendWord, sequence: seqWord[st?.sequence ?? "unknown"] ?? "—", phase,
      swingHigh: st?.swingHigh ?? null, swingLow: st?.swingLow ?? null,
      brokeStructure: st?.brokeStructure ?? null, sweptLevel: st?.sweptLevel ?? null,
      nextWatched, invalidation: inv,
    },
    liquidity, keyLevels, radar, scenarios, path, news, streamKinds,
  };
}

/** The two display-only fields the live read and the replay harness both attach. Never throws. */
export function presentExtras(i: {
  s: MarketSnapshot; thesis: BrainThesis | null; events: PerceptionEvent[]; bars: Bar[];
  diffs: { horizon: string; pressureFrom: number; pressureTo: number }[];
  velocityBand: string; weather: string;
}): { intel: Intel | null; features: Record<string, { atr: number; atrPct: number; volRatio: number; velocity: number; acceleration: number; returns5: number; rangeExpansion: number }> } {
  let intel: Intel | null = null;
  try {
    intel = buildIntel({
      s: i.s, thesis: i.thesis, events: i.events, bars: i.bars,
      changes: i.diffs.map((d) => ({ horizon: d.horizon, pressureFrom: d.pressureFrom, pressureTo: d.pressureTo })),
      velocityBand: i.velocityBand, weather: i.weather,
    });
  } catch { intel = null; }
  const features = Object.fromEntries(Object.entries(i.s.timeframes).map(([tf, v]) => [tf, {
    atr: v!.features.atr, atrPct: v!.features.atrPct, volRatio: v!.features.volRatio,
    velocity: v!.features.velocity, acceleration: v!.features.acceleration, returns5: v!.features.returns5,
    rangeExpansion: v!.features.rangeExpansion,
  }]));
  return { intel, features };
}
