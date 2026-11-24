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
  const trs = closed.slice(-15).slice(1).map((b,i)=>{
    const before = closed[closed.length-15+i] ?? closed[Math.max(0,closed.length-15+i+1)];
    return Math.max(b.h-b.l,Math.abs(b.h-(before?.c??b.o)),Math.abs(b.l-(before?.c??b.o)));
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
