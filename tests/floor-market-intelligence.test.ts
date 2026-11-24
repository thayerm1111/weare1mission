import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { floorMarketRead, marketPosition } from "../src/lib/floor/marketIntelligence";
import type { TimedBar } from "../src/lib/chart/candleTime";

const TF=300_000, BASE=1_700_000_000_000;
const bars=(n:number,fn:(i:number)=>number):TimedBar[]=>Array.from({length:n},(_,i)=>{
  const c=fn(i);
  return {t:BASE+i*TF,o:c-.1,h:c+.5,l:c-.5,c};
});
const read=(b:TimedBar[])=>floorMarketRead(b,TF,BASE+b.length*TF,true);

test("Atlas public trend and momentum come from closed market candles",()=>{
  const up=read(bars(60,i=>100+i*.5));
  const down=read(bars(60,i=>150-i*.5));
  assert.equal(up.trend,"bullish");
  assert.equal(down.trend,"bearish");
  assert.equal(up.momentum,"Rising");
  assert.equal(down.momentum,"Falling");
  assert.ok(up.support!.price<up.close!);
  assert.ok(up.resistance!.price>up.close!);
  assert.ok(down.support!.price<down.close!);
  assert.ok(down.resistance!.price>down.close!);
});
test("Both sides of a ranging market are actual observed levels",()=>{
  const b=bars(65,i=>100+Math.sin(i*Math.PI/4)*2);
  const r=read(b);
  assert.equal(r.trend,"range");
  assert.equal(r.support?.source,"Confirmed swing");
  assert.equal(r.resistance?.source,"Confirmed swing");
  assert.equal(r.support?.price,97.5);
  assert.equal(r.resistance?.price,102.5);
  assert.match(marketPosition(r,103),/above the last mapped resistance/);
  assert.match(marketPosition(r,97),/below the last mapped support/);
  assert.match(marketPosition(r,100),/between support and resistance/);
});
test("A forming candle cannot change the trend, levels or momentum",()=>{
  const b=bars(60,i=>100+i*.5);
  const next={t:BASE+60*TF,o:130,h:500,l:2,c:300};
  const live=floorMarketRead([...b,next],TF,next.t+10,true);
  assert.deepEqual(live,read(b));
  assert.deepEqual(floorMarketRead([...b,next],TF,0,false),read(b));
});
test("Unavailable, malformed and short histories never fabricate levels",()=>{
  const b=bars(9,i=>100+i);
  assert.equal(read(b).trend,"unknown");
  assert.equal(read(b).support,null);
  assert.equal(read(b).resistance,null);
  assert.equal(marketPosition(read([]),100),"Awaiting market data.");
  const good=bars(60,i=>100+i);
  const invalid={...good[0],t:BASE+60*TF,l:999};
  assert.equal(floorMarketRead([...good,invalid],TF,BASE+61*TF,true).barsUsed,60);
  const short=read(bars(12,i=>100+i*.1));
  assert.ok(short.atr!=null&&Number.isFinite(short.atr));
});
test("Floor chart uses full real candles and keeps paid plans separate from public watch",()=>{
  const floor=readFileSync("src/components/om/floor/AtlasLiveDesk.tsx","utf8");
  assert.match(floor,/<OmChart bars=\{candleData\.bars\}/);
  assert.doesNotMatch(floor,/<SignalFocusChart/);
  assert.match(floor,/floorMarketRead\(candleData\.bars/);
  assert.match(floor,/view\.open && usable \? view\.levels/);
  assert.match(floor,/const inPlay = usable && view\.open/);
  assert.match(floor,/marketRead: \{ timeframe: currentFrame\.label/);
  assert.match(floor,/What to watch next/);
  assert.match(floor,/symbol === "XAUUSD" \? "genx" : "plays"/);
});
