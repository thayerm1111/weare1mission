import type { TimedBar } from "../chart/candleTime";

/** A read-only interpretation of the candles already available on The Floor.
 * Independent of the gated GENX/GEN FX/Plays trade plans. No entry, stop,
 * target, order or probability is produced by this module.
 */
export type MarketDirection = "bullish" | "bearish" | "range" | "mixed" | "unknown";
export type MarketLevel = { price: number; source: "Confirmed swing" | "Recent range" };
export type MarketRead = {
  trend: MarketDirection; momentum: "Rising" | "Falling" | "Flat" | "Unknown";
  support: MarketLevel | null; resistance: MarketLevel | null;
  rangeLow: number | null; rangeHigh: number | null;
  close: number | null; candleAt: number | null; atr: number | null; barsUsed: number;
  move: number | null; movePct: number | null;
};

const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
const blank = (): MarketRead => ({
  trend: "unknown", momentum: "Unknown", support: null, resistance: null,
  rangeLow: null, rangeHigh: null, close: null, candleAt: null, atr: null,
  barsUsed: 0, move: null, movePct: null,
});
/** Only closed candles. If timestamps aren't verified, conservatively omit
 * the newest candle; it may still be forming. Never invent missing candles. */
export function floorMarketRead(bars: readonly TimedBar[], tfMs: number, now: number, known: boolean): MarketRead {
  const unique = new Map<number, TimedBar>();
  for (const b of bars) {
    if (![b.t,b.o,b.h,b.l,b.c].every(Number.isFinite) || b.l <= 0 || b.h < Math.max(b.o,b.c,b.l) || b.l > Math.min(b.o,b.c)) continue;
    unique.set(b.t,b);
  }
  const ordered = [...unique.values()].sort((a,b)=>a.t-b.t);
  const closed = (known && now > 0 && tfMs > 0 ? ordered.filter(b=>b.t+tfMs<=now) : ordered.slice(0,-1)).slice(-90);
  if (closed.length < 12) return blank();
  const last = closed[closed.length-1], prev = closed[closed.length-5];
  const sample = closed.slice(-40);
  const rangeLow = Math.min(...sample.map(b=>b.l)), rangeHigh = Math.max(...sample.map(b=>b.h));
  const recentBars=closed.slice(-15);
  const trs = recentBars.slice(1).map((b,i)=>{
    const before = recentBars[i];
    return Math.max(b.h-b.l,Math.abs(b.h-before.c),Math.abs(b.l-before.c));
  });
  const atr = Math.max(mean(trs),last.c*0.000001);
  const move = last.c-prev.c;
  const momentum = Math.abs(move) <= atr*.35 ? "Flat" : move > 0 ? "Rising" : "Falling";
  let trend: MarketDirection = "unknown";
  if (closed.length >= 25) {
    const closes=closed.map(b=>b.c);
    const ma20=mean(closes.slice(-20)), earlier=mean(closes.slice(-25,-5));
    const slope=ma20-earlier;
    const half=sample.length>>1, older=sample.slice(0,half), recent=sample.slice(half);
    const oldHigh=Math.max(...older.map(b=>b.h)), newHigh=Math.max(...recent.map(b=>b.h));
    const oldLow=Math.min(...older.map(b=>b.l)), newLow=Math.min(...recent.map(b=>b.l));
    const up=last.c>ma20 && slope>atr*.12 && newHigh>oldHigh && newLow>oldLow;
    const down=last.c<ma20 && slope < -atr*.12 && newHigh<oldHigh && newLow<oldLow;
    trend=up?"bullish":down?"bearish":Math.abs(slope)<atr*.35 && Math.abs(last.c-ma20)<atr*1.5?"range":"mixed";
  }
  const highs:number[]=[],lows:number[]=[];
  for(let i=2;i<sample.length-2;i++){
    const b=sample[i], neighbors=[sample[i-2],sample[i-1],sample[i+1],sample[i+2]];
    if(neighbors.every(n=>b.h>=n.h)&&neighbors.some(n=>b.h>n.h)) highs.push(b.h);
    if(neighbors.every(n=>b.l<=n.l)&&neighbors.some(n=>b.l<n.l)) lows.push(b.l);
  }
  // Nearest actual confirmed pivots on the correct side of the closed quote.
  const nearestLow=lows.filter(p=>p<last.c).sort((a,b)=>b-a)[0];
  const nearestHigh=highs.filter(p=>p>last.c).sort((a,b)=>a-b)[0];
  const support:MarketLevel|null=nearestLow!==undefined?{price:nearestLow,source:"Confirmed swing"}:rangeLow<last.c?{price:rangeLow,source:"Recent range"}:null;
  const resistance:MarketLevel|null=nearestHigh!==undefined?{price:nearestHigh,source:"Confirmed swing"}:rangeHigh>last.c?{price:rangeHigh,source:"Recent range"}:null;
  return {trend,momentum,support,resistance,rangeLow,rangeHigh,close:last.c,candleAt:last.t,atr,barsUsed:closed.length,move,movePct:move/prev.c*100};
}

export const TREND_WORD: Record<MarketDirection,string> = {bullish:"Bullish",bearish:"Bearish",range:"Ranging",mixed:"Mixed structure",unknown:"Awaiting data"};
/** A conditional market observation, never a trade call. Quote changes can
 * cross a level, but cannot turn it into a confirmed closed-candle break. */
export function marketPosition(read: MarketRead, quote: number|null): string {
  if (quote==null || read.close==null || !Number.isFinite(quote)) return "Awaiting market data.";
  if(read.resistance && quote>read.resistance.price) return "Price is above the last mapped resistance. Watch for a candle close and retest.";
  if(read.support && quote<read.support.price) return "Price is below the last mapped support. Watch for a candle close and retest.";
  if(read.support && read.resistance) {
    const span=read.resistance.price-read.support.price;
    const pos=span>0?(quote-read.support.price)/span:.5;
    if(pos>=.75) return "Price is approaching resistance. Watch for a rejection or a sustained break.";
    if(pos<=.25) return "Price is approaching support. Watch for a hold or a sustained break.";
    return "Price is between support and resistance. Watch for a test of either level.";
  }
  return "The recent candles have not established a level on both sides of price.";
}

/** Public market context only. Signal generation and trade eligibility remain
 * with the existing Atlas Command Center engine. Every frame is fetched from
 * its own provider interval; a daily read is never inferred from intraday bars. */
export const ATLAS_FRAMES = [
  { id: "1d", label: "D", interval: "1day", ms: 86_400_000 },
  { id: "4h", label: "4h", interval: "4h", ms: 14_400_000 },
  { id: "1h", label: "1h", interval: "1h", ms: 3_600_000 },
  { id: "30m", label: "30m", interval: "30min", ms: 1_800_000 },
  { id: "15m", label: "15m", interval: "15min", ms: 900_000 },
  { id: "5m", label: "5m", interval: "5min", ms: 300_000 },
] as const;
export type AtlasFrameId = typeof ATLAS_FRAMES[number]["id"];
export type AtlasMarketSymbol = "XAUUSD" | "EURUSD" | "GBPJPY" | "USDJPY";
export type AtlasFrameStatus = "ready" | "stale" | "insufficient" | "unavailable";
export type AtlasStructureZone = {
  id: string; timeframe: AtlasFrameId; low: number; high: number; price: number;
  source: "Confirmed swing" | "Recent range"; origin: "support" | "resistance";
  touches: number; firstAt: number; lastAt: number; confirmedAt: number;
};
export type AtlasPositionedZone = AtlasStructureZone & {
  role: "support" | "resistance" | "testing"; roleReversed: boolean;
  confirmedRole: boolean; label: string;
};
export type AtlasFrameSummary = {
  id: AtlasFrameId; label: string; ms: number; status: AtlasFrameStatus;
  timeKnown: boolean; fetchedAt: number | null; closedAt: number | null;
  /** Daily provider session dates are not exact UTC open/close instants. */
  dateOnly: boolean; closedDate: string | null;
  bars: TimedBar[]; read: MarketRead; structure: string; summary: string;
  zones: AtlasStructureZone[]; error: string | null;
};
export type AtlasMarketSnapshot = {
  symbol: AtlasMarketSymbol; asOf: number; marketOpen: boolean;
  source: "Twelve Data · native timeframe candles";
  frames: Record<AtlasFrameId, AtlasFrameSummary>;
};
export type AtlasFlowSummary = {
  id: AtlasFrameId; label: string; trend: MarketDirection;
  momentum: MarketRead["momentum"]; status: AtlasFrameStatus;
  summary: string; closedAt: number | null;
};
export type AtlasPriceEvent = {
  price: number; low: number; high: number; direction: "above" | "below";
  timeframe: AtlasFrameId; condition: string; confirmed: boolean;
};
export type AtlasReadiness = {
  state: "watching" | "approaching" | "awaiting_close" | "awaiting_retest" |
    "retest_confirmed" | "extended" | "unavailable" | "market_closed";
  label: string; summary: string; observational: true;
  steps: { label: string; state: "complete" | "current" | "pending" }[];
};
export type AtlasMarketView = {
  frame: AtlasFrameSummary;
  /** Direction of the last four closed candles, separate from structural trend. */
  direction: MarketDirection; directionLabel: string;
  higherTimeframeBias: MarketDirection; higherTimeframeLabel: string;
  summary: string; flow: AtlasFlowSummary[];
  support: AtlasPositionedZone | null; resistance: AtlasPositionedZone | null;
  activeZone: AtlasPositionedZone | null;
  crossedLevel: { zone: AtlasPositionedZone; direction: "above" | "below";
    confirmation: "provisional" | "closed"; closedAt: number | null } | null;
  readiness: AtlasReadiness; trigger: AtlasPriceEvent | null;
  alternative: AtlasPriceEvent | null;
  /** Structural scenario failure, not a suggested stop-loss or order. */
  invalidation: { price: number; direction: "above" | "below"; condition: string } | null;
  distance: { price: number; percent: number; atr: number | null; label: string } | null;
};
export type AtlasFrameInput = {
  bars: readonly TimedBar[]; fetchedAt: number; timeKnown: boolean; error?: string | null;
  dateOnly?: boolean;
  /** Conservative provider observation cutoff, including upstream cache age. */
  closedBefore?: number;
};

const FRAME_FETCH_AGE: Record<AtlasFrameId, number> = {
  "1d": 900_000, "4h": 360_000, "1h": 180_000,
  "30m": 180_000, "15m": 120_000, "5m": 120_000,
};
const validPrice = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;
function cleanBars(bars: readonly TimedBar[], now: number, dateOnly=false): TimedBar[] {
  const unique = new Map<number, TimedBar>();
  for (const b of bars) {
    if (!validPrice(b.t) || b.t > now + (dateOnly?86_400_000:3_000) || ![b.o,b.h,b.l,b.c].every(validPrice) ||
      b.h < Math.max(b.o,b.c,b.l) || b.l > Math.min(b.o,b.c,b.h)) continue;
    unique.set(b.t, { t: b.t, o: b.o, h: b.h, l: b.l, c: b.c });
  }
  return [...unique.values()].sort((a,b) => a.t-b.t).slice(-160);
}
function closedBars(frame: AtlasFrameSummary, now: number): TimedBar[] {
  if (frame.dateOnly) return frame.bars.slice(0,-1);
  // Time passing in the browser cannot turn previously captured partial OHLC
  // into a verified close. Only a new provider observation can advance this.
  return frame.timeKnown && frame.closedAt!=null ? frame.bars.filter(b => b.t + frame.ms <= Math.min(now,frame.closedAt!)) : [];
}
function cadenceMatches(bars: readonly TimedBar[], ms: number): boolean {
  const recent = bars.slice(-40);
  if (recent.length < 3) return true;
  // Weekends and market breaks may create larger gaps. A stream of 5m bars
  // must never masquerade as a genuine daily or 4h series.
  const gaps = recent.slice(1).map((b,i) => b.t-recent[i].t);
  return gaps.filter(g => g >= ms * .9).length >= Math.ceil(gaps.length * .8) &&
    gaps.filter(g => g >= ms * .9 && g <= ms * 1.1).length >= Math.ceil(gaps.length * .6);
}
type Pivot = { i: number; at: number; confirmedAt: number; price: number; low: number; high: number; origin: "support" | "resistance" };
function pivots(bars: readonly TimedBar[], ms: number): Pivot[] {
  const found: Pivot[] = [];
  for (let i=2; i<bars.length-2; i++) {
    const b=bars[i], near=[bars[i-2],bars[i-1],bars[i+1],bars[i+2]];
    if (near.every(n => b.l <= n.l) && near.some(n => b.l < n.l))
      found.push({i,at:b.t,confirmedAt:bars[i+2].t+ms,price:b.l,low:b.l,high:Math.min(b.o,b.c),origin:"support"});
    if (near.every(n => b.h >= n.h) && near.some(n => b.h > n.h))
      found.push({i,at:b.t,confirmedAt:bars[i+2].t+ms,price:b.h,low:Math.max(b.o,b.c),high:b.h,origin:"resistance"});
  }
  return found;
}
function structuralSummary(read: MarketRead, points: Pivot[]): { structure: string; summary: string } {
  if (read.trend === "unknown") return { structure: "Insufficient closed candles", summary: "Waiting for enough closed candles to describe structure." };
  const highs=points.filter(p => p.origin === "resistance").slice(-2);
  const lows=points.filter(p => p.origin === "support").slice(-2);
  const tolerance=(read.atr ?? 0)*.08;
  const hh=highs.length===2 && highs[1].price > highs[0].price+tolerance;
  const hl=lows.length===2 && lows[1].price > lows[0].price+tolerance;
  const lh=highs.length===2 && highs[1].price < highs[0].price-tolerance;
  const ll=lows.length===2 && lows[1].price < lows[0].price-tolerance;
  const structure=hh && hl ? "Higher swing highs and higher swing lows" : lh && ll ? "Lower swing highs and lower swing lows"
    : read.trend === "bullish" ? "Rising price and 20-candle mean"
      : read.trend === "bearish" ? "Falling price and 20-candle mean"
        : read.trend === "range" ? "Sideways structure" : "Mixed structural signals";
  const movement=read.momentum === "Rising" ? "the last four closed candles are moving up"
    : read.momentum === "Falling" ? "the last four closed candles are moving down" : "the last four closed candles have little net movement";
  const summary=read.trend === "range" ? "Sideways structure; " + movement + " inside that broader range."
    : (structure + "; " + movement + ".");
  return { structure, summary };
}
function mapZones(bars: readonly TimedBar[], id: AtlasFrameId, ms: number, atr: number, points: Pivot[]): AtlasStructureZone[] {
  const grouped: AtlasStructureZone[] = [];
  const tolerance=Math.max(atr*.2, bars.at(-1)!.c*.000001);
  for (const point of points) {
    const nearby=grouped.find(z => z.origin === point.origin && Math.abs(z.price-point.price) <= tolerance);
    if (nearby) {
      const widened=point.low<nearby.low || point.high>nearby.high;
      nearby.low=Math.min(nearby.low,point.low);
      nearby.high=Math.max(nearby.high,point.high);
      nearby.price=point.origin === "support" ? nearby.low : nearby.high;
      // Adjacent plateau pivots are one test of the zone, not independent
      // touches. New boundaries cannot be applied to earlier price events.
      if (point.at-nearby.lastAt>ms*2) nearby.touches++;
      nearby.lastAt=point.at;
      if (widened) nearby.confirmedAt=point.confirmedAt;
    } else {
      grouped.push({ id:id+":"+point.origin+":"+point.at, timeframe:id, low:point.low, high:point.high,
        price:point.price, source:"Confirmed swing", origin:point.origin, touches:1,
        firstAt:point.at, lastAt:point.at, confirmedAt:point.confirmedAt });
    }
  }
  // Range edges are actual observed extremes, with honest provenance. They
  // are point references when no confirmed pivot has established that edge.
  const recent=bars.slice(-40);
  for (const origin of ["support","resistance"] as const) {
    const edge=recent.reduce((best,b) => origin === "support" ? b.l<best.l?b:best : b.h>best.h?b:best, recent[0]);
    const price=origin === "support" ? edge.l : edge.h;
    if (grouped.some(z => z.origin === origin && Math.abs(z.price-price) <= tolerance)) continue;
    grouped.push({ id:id+":range:"+origin, timeframe:id, low:price, high:price, price,
      source:"Recent range", origin, touches:recent.filter(b => Math.abs((origin === "support" ? b.l : b.h)-price) <= tolerance).length,
      firstAt:edge.t, lastAt:edge.t, confirmedAt:edge.t+ms });
  }
  return grouped.sort((a,b) => a.price-b.price);
}

/** Pure builder, shared by the API and deterministic tests. Missing frames
 * remain missing; no other timeframe is substituted to fill the six cards. */
export function buildAtlasMarketSnapshot(input: {
  symbol: AtlasMarketSymbol; frames: Partial<Record<AtlasFrameId, AtlasFrameInput>>;
  now: number; marketOpen: boolean;
}): AtlasMarketSnapshot {
  const { symbol, now, marketOpen }=input;
  const frames={} as Record<AtlasFrameId, AtlasFrameSummary>;
  for (const config of ATLAS_FRAMES) {
    const raw=input.frames[config.id];
    const goodClock=validPrice(now) && !!raw && validPrice(raw.fetchedAt) && raw.fetchedAt <= now+3_000;
    const dateOnly=config.id === "1d" && !!raw?.dateOnly;
    const bars=goodClock && raw ? cleanBars(raw.bars, now,dateOnly) : [];
    const timeKnown=!dateOnly && !!raw?.timeKnown && goodClock;
    const cadenceOk=cadenceMatches(bars,config.ms);
    const closeCutoff=raw ? Math.min(now,raw.fetchedAt,validPrice(raw.closedBefore)?raw.closedBefore:raw.fetchedAt) : 0;
    // Twelve Data ignores timezone=UTC for daily intervals. A later actual
    // daily row proves the preceding session finished; the newest daily row
    // remains excluded even when its date appears to be in the past.
    const completed=goodClock && cadenceOk ? dateOnly ? bars.slice(0,-1)
      : timeKnown ? bars.filter(b => b.t+config.ms<=closeCutoff) : [] : [];
    const read=completed.length ? floorMarketRead(completed,config.ms,completed[completed.length-1].t+config.ms,true) : blank();
    const points=pivots(completed,config.ms);
    const details=structuralSummary(read,points);
    const closedAt=!dateOnly && completed.length ? completed[completed.length-1].t+config.ms : null;
    const closedDate=dateOnly && completed.length ? new Date(completed[completed.length-1].t).toISOString().slice(0,10) : null;
    const historical=marketOpen && (dateOnly ? !!bars.length && now-bars[bars.length-1].t > config.ms*3
      : closedAt != null && now-closedAt > config.ms*2+60_000);
    const fetchOld=!!raw && now-raw.fetchedAt > FRAME_FETCH_AGE[config.id];
    const status: AtlasFrameStatus=!raw || !goodClock || !cadenceOk || bars.length===0 ? "unavailable"
      : (!timeKnown && !dateOnly) || completed.length<25 ? "insufficient" : historical || fetchOld || !!raw.error ? "stale" : "ready";
    frames[config.id]={ id:config.id, label:config.label, ms:config.ms, status, timeKnown,
      dateOnly,closedDate,fetchedAt:goodClock && raw ? raw.fetchedAt : null, closedAt,
      bars:cadenceOk ? bars : [], read, ...details,
      zones:read.atr != null ? mapZones(completed,config.id,config.ms,read.atr,points) : [],
      error:!cadenceOk ? "Provider interval does not match this timeframe."
        : !timeKnown && !dateOnly && raw ? "Candle timestamps are not verified UTC."
          : raw?.error ?? (status === "unavailable" ? "Market candles unavailable." : null) };
  }
  return {symbol,asOf:now,marketOpen,source:"Twelve Data · native timeframe candles",frames};
}

function frameStatus(frame: AtlasFrameSummary, now: number, marketOpen: boolean): AtlasFrameStatus {
  if (frame.status === "unavailable" || frame.status === "insufficient") return frame.status;
  if (!validPrice(now) || frame.fetchedAt == null || frame.fetchedAt > now+3_000 || (!frame.timeKnown && !frame.dateOnly)) return "unavailable";
  if (frame.status === "stale" || now-frame.fetchedAt > FRAME_FETCH_AGE[frame.id] ||
      (marketOpen && frame.closedAt != null && now-frame.closedAt > frame.ms*2+60_000)) return "stale";
  return "ready";
}
const sideOf = (zone: AtlasStructureZone, price: number): -1|0|1 => price < zone.low ? -1 : price > zone.high ? 1 : 0;
function positioned(zone: AtlasStructureZone, price: number, close: number): AtlasPositionedZone {
  const side=sideOf(zone,price), closedSide=sideOf(zone,close);
  const role=side === 1 ? "support" : side === -1 ? "resistance" : "testing";
  const establishedRole=closedSide===1?"support":closedSide===-1?"resistance":zone.origin;
  const effectiveRole=role === "testing"?establishedRole:role;
  const roleReversed=effectiveRole !== zone.origin;
  const confirmedRole=side !== 0 && side===closedSide;
  const label=role === "testing" ? roleReversed
    ? (effectiveRole === "support" ? "Former resistance · support retest" : "Former support · resistance retest")
    : (effectiveRole === "support" ? "Support zone under test" : "Resistance zone under test")
    : roleReversed ? (role === "resistance" ? "Former support · resistance watch" : "Former resistance · support watch")
      : role === "support" ? "Support below price" : "Resistance above price";
  return {...zone,role,roleReversed,confirmedRole,label};
}
type ZoneBreak = { zone: AtlasPositionedZone; direction: "above" | "below"; at: number; retestAt: number | null };
function recentBreak(zone: AtlasPositionedZone, bars: readonly TimedBar[], ms: number): ZoneBreak | null {
  let previous: -1|0|1=0, result: ZoneBreak|null=null;
  const earliest=bars[Math.max(0,bars.length-12)]?.t ?? Infinity;
  for (const bar of bars) {
    if (bar.t+ms <= zone.confirmedAt) { previous=sideOf(zone,bar.c)||previous; continue; }
    const side=sideOf(zone,bar.c);
    if (side && previous && side !== previous) {
      result={zone,direction:side===1?"above":"below",at:bar.t+ms,retestAt:null};
    } else if (result && bar.t+ms > result.at && bar.l <= zone.high && bar.h >= zone.low &&
      (result.direction === "above" ? bar.c > zone.high : bar.c < zone.low)) {
      result.retestAt=bar.t+ms;
    }
    if (side) previous=side;
  }
  return result && result.at > earliest ? result : null;
}
function higherBias(flow: AtlasFlowSummary[]): MarketDirection {
  const valid=flow.filter(f => ["1d","4h","1h"].includes(f.id) && f.status === "ready" && f.trend !== "unknown");
  if (valid.length<2) return "unknown";
  const up=valid.filter(f => f.trend === "bullish").length, down=valid.filter(f => f.trend === "bearish").length;
  return up && down ? "mixed" : up>=2 ? "bullish" : down>=2 ? "bearish" : valid.every(f => f.trend === "range") ? "range" : "mixed";
}

/** Re-run against the current, timestamp-checked quote on each tick. Levels
 * keep their original provenance, but a support above price is never displayed
 * as active support. A tick crossing cannot complete a closed-candle step. */
export function atlasMarketView(snapshot: AtlasMarketSnapshot, selected: AtlasFrameId, quote: number|null, now: number): AtlasMarketView {
  const frame=snapshot.frames[selected], read=frame.read;
  const status=frameStatus(frame,now,snapshot.marketOpen);
  const flow: AtlasFlowSummary[]=ATLAS_FRAMES.map(config => {
    const f=snapshot.frames[config.id];
    return { id:f.id,label:f.label,trend:f.read.trend,momentum:f.read.momentum,
      status:frameStatus(f,now,snapshot.marketOpen),summary:f.summary,closedAt:f.closedAt };
  });
  const higherTimeframeBias=higherBias(flow);
  const higherTimeframeLabel=higherTimeframeBias === "bullish" ? "Bullish higher frames"
    : higherTimeframeBias === "bearish" ? "Bearish higher frames" : higherTimeframeBias === "range" ? "Higher frames ranging"
      : higherTimeframeBias === "mixed" ? "Higher frames disagree" : "Higher-frame data incomplete";
  const direction: MarketDirection=read.momentum === "Rising" ? "bullish" : read.momentum === "Falling" ? "bearish"
    : read.momentum === "Flat" ? "range" : "unknown";
  const directionLabel=direction === "bullish" ? "Moving up" : direction === "bearish" ? "Moving down" : direction === "range" ? "Moving sideways" : "Awaiting direction";
  const price=validPrice(quote) ? quote : read.close;
  const zones=price != null && read.close != null ? frame.zones.map(z => positioned(z,price,read.close!)) : [];
  const support=zones.filter(z => z.role === "support").sort((a,b) => b.high-a.high)[0] ?? null;
  const resistance=zones.filter(z => z.role === "resistance").sort((a,b) => a.low-b.low)[0] ?? null;
  const activeZone=zones.filter(z => z.role === "testing").sort((a,b) => Math.abs(a.price-(price??0))-Math.abs(b.price-(price??0)))[0] ?? null;
  const dp=snapshot.symbol === "XAUUSD" ? 2 : snapshot.symbol === "EURUSD" ? 5 : 3;
  const fmt=(n: number) => n.toFixed(dp);
  const zoneText=(z: AtlasStructureZone) => z.low === z.high ? fmt(z.price) : fmt(z.low)+"–"+fmt(z.high);
  const completed=closedBars(frame,now);
  const provisional=price != null && read.close != null ? zones.filter(z => {
    const a=sideOf(z,read.close!), b=sideOf(z,price);
    return b!==0 && a!==b && (a!==0 || z.origin === (b===1?"resistance":"support"));
  }).sort((a,b) => Math.abs(a.price-price)-Math.abs(b.price-price))[0] : undefined;
  const breaks=zones.map(z => recentBreak(z,completed,frame.ms)).filter((x):x is ZoneBreak => x!==null)
    .filter(b => price != null && (b.direction === "above" ? price>=b.zone.low : price<=b.zone.high))
    .sort((a,b) => b.at-a.at || Math.abs(a.zone.price-(price??0))-Math.abs(b.zone.price-(price??0)));
  const confirmed=breaks[0] ?? null;
  let crossedLevel: AtlasMarketView["crossedLevel"]=provisional && price != null ? {
    zone:provisional,direction:price>provisional.high?"above":"below",confirmation:"provisional",closedAt:null,
  } : confirmed ? {zone:confirmed.zone,direction:confirmed.direction,confirmation:"closed",closedAt:frame.dateOnly?null:confirmed.at} : null;
  let trigger: AtlasPriceEvent|null=null, alternative: AtlasPriceEvent|null=null;
  let invalidation: AtlasMarketView["invalidation"]=null;
  let readiness: AtlasReadiness={state:"watching",label:"Waiting for a price event",summary:"No confirmed breakout and retest yet.",observational:true,steps:[]};
  const event=(zone: AtlasStructureZone, side: "above"|"below", condition: string, confirmed=false): AtlasPriceEvent => ({
    price:side === "above"?zone.high:zone.low,low:zone.low,high:zone.high,direction:side,timeframe:selected,condition,confirmed,
  });
  if (price != null && crossedLevel) {
    const cross=crossedLevel, z=cross.zone, up=cross.direction === "above";
    const boundary=up?z.high:z.low;
    const extended=read.atr!=null && Math.abs(price-boundary)>read.atr*1.5;
    const retested=cross.confirmation === "closed" && confirmed?.retestAt!=null;
    const holding=up?price>z.high:price<z.low;
    const holdText=frame.label+" candle retests "+zoneText(z)+" and closes "+(up?"above "+fmt(z.high):"below "+fmt(z.low))+".";
    trigger=event(z,cross.direction,cross.confirmation === "provisional"
      ? "Wait for a "+frame.label+" candle close "+cross.direction+" "+fmt(boundary)+", then a retest that holds."
      : holdText,retested && holding && !extended);
    invalidation={price:up?z.low:z.high,direction:up?"below":"above",
      condition:"A "+frame.label+" close "+(up?"below "+fmt(z.low):"above "+fmt(z.high))+" invalidates this breakout/retest scenario."};
    readiness=cross.confirmation === "provisional" ? {state:"awaiting_close",label:"Live crossing · close pending",
      summary:"Price has moved "+cross.direction+" "+zoneText(z)+". The latest closed candle has not confirmed this move.",observational:true,steps:[
        {label:"Price reaches the mapped zone",state:"complete"},{label:frame.label+" candle closes "+cross.direction+" the zone",state:"current"},{label:"Later closed candle retests and holds",state:"pending"},
      ]} : extended ? {state:"extended",label:"Price extended from the break",
        summary:"The closed break is more than 1.5 ATR from this zone now. Wait for a controlled retest or new structure; this is not an entry price.",observational:true,steps:[
          {label:"Break confirmed on a closed candle",state:"complete"},{label:"Price returns to the observed zone",state:"current"},{label:"Retest holds on a later closed candle",state:"pending"},
        ]} : retested && holding ? {state:"retest_confirmed",label:"Closed break and retest confirmed",
          summary:"Price action confirmed — check the Atlas signal for eligibility. This public observation is not an executable trade.",observational:true,steps:[
            {label:"Break confirmed on a closed candle",state:"complete"},{label:"Later closed candle retested and held",state:"complete"},{label:"Review the Atlas signal and entry checks",state:"current"},
          ]} : {state:"awaiting_retest",label:holding?"Break confirmed · retest pending":"Retest in progress · hold pending",
            summary:"A closed "+frame.label+" candle broke "+cross.direction+" "+zoneText(z)+". "+(holding?"Wait for a later candle to retest and hold.":"Price is back in the zone; wait for a closed-candle hold."),observational:true,steps:[
              {label:"Break confirmed on a closed candle",state:"complete"},{label:"Later candle retests the zone",state:"current"},{label:"Retest candle closes on the breakout side",state:"pending"},
            ]};
  } else if (price != null) {
    const watchingUp=direction === "bullish" || (direction !== "bearish" && read.trend === "bullish");
    const watchingDown=direction === "bearish" || (direction !== "bullish" && read.trend === "bearish");
    const neutral=!watchingUp && !watchingDown;
    const target=activeZone ?? (watchingUp ? resistance : watchingDown ? support
      : support && resistance ? price-support.high < resistance.low-price ? support : resistance : support??resistance);
    if (target) {
      const testedSupport=read.close!=null && sideOf(target,read.close)!==0 ? sideOf(target,read.close)===1 : target.origin==="support";
      const side=target.role === "support" ? "below" : target.role === "resistance" ? "above"
        : watchingUp ? "above" : watchingDown ? "below" : testedSupport ? "above" : "below";
      trigger=event(target,side,"Watch for a "+frame.label+" close "+side+" "+fmt(side === "above" ? target.high : target.low)+
        (target.role === "testing" ? " to resolve this zone test. Then check whether the next candle holds that side." : ", then a retest that holds."));
      const opposite=target.role === "testing" ? target : side === "above" ? support : resistance;
      if (opposite) {
        const otherSide=side === "above"?"below":"above";
        alternative=event(opposite,otherSide,"A "+frame.label+" close "+otherSide+" "+fmt(otherSide === "below"?opposite.low:opposite.high)+" would favor the opposite scenario.");
        invalidation={price:alternative.price,direction:otherSide,condition:alternative.condition};
      }
      const gap=price<target.low?target.low-price:price>target.high?price-target.high:0;
      const near=read.atr!=null && gap<=read.atr*.5;
      readiness={state:near?"approaching":"watching",label:activeZone?"Mapped zone under test":near?"Approaching a decision zone":"Between mapped zones",
        summary:activeZone?"Price is testing "+zoneText(target)+". Watch for a hold or a closed break; neither is assumed."
          : "Next "+(neutral?"nearby ":"")+"price event: "+zoneText(target)+". Wait for a rejection or a confirmed break and retest.",observational:true,steps:[
            {label:"Price tests "+zoneText(target),state:near?"current":"pending"},{label:frame.label+" candle confirms a hold or break",state:"pending"},{label:"Check the Atlas signal after confirmation",state:"pending"},
          ]};
    } else {
      readiness={state:"watching",label:"New structure needed",summary:watchingUp?"Price is above all mapped resistance in the loaded history. Wait for a new base or a controlled pullback."
        : watchingDown?"Price is below all mapped support in the loaded history. Wait for a new base or a controlled pullback.":"There is no reliable next zone in the available candles.",observational:true,steps:[]};
    }
  }
  if (!snapshot.marketOpen) {
    readiness={state:"market_closed",label:"Market closed",summary:"These are the last recorded closed-candle levels. Reassess after trading resumes.",observational:true,steps:[]};
    trigger=null; alternative=null; invalidation=null; crossedLevel=null;
  } else if (status !== "ready" || price == null || !validPrice(snapshot.asOf) || snapshot.asOf>now+3_000) {
    readiness={state:"unavailable",label:status === "stale"?"Waiting for fresh candles":"Market context unavailable",
      summary:status === "stale"?"The selected timeframe is delayed. Current readiness is suspended until fresh closed candles arrive.":"Not enough trustworthy closed candles are available for this timeframe.",observational:true,steps:[]};
    trigger=null; alternative=null; invalidation=null; crossedLevel=null;
  }
  const distance=trigger && price!=null ? {
    price:Math.abs(trigger.price-price),percent:Math.abs(trigger.price-price)/price*100,
    atr:read.atr!=null?Math.abs(trigger.price-price)/read.atr:null,
    label:fmt(Math.abs(trigger.price-price))+" price units · "+(Math.abs(trigger.price-price)/price*100).toFixed(2)+"%",
  } : null;
  return {frame:{...frame,status},direction,directionLabel,higherTimeframeBias,higherTimeframeLabel,
    summary:frame.label+": "+frame.summary+" "+higherTimeframeLabel+". "+readiness.summary,
    flow,support,resistance,activeZone,crossedLevel,readiness,trigger,alternative,invalidation,distance};
}
