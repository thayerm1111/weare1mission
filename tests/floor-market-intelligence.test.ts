import test from "node:test";
import assert from "node:assert/strict";
import {
  floorMarketRead, marketPosition, ATLAS_FRAMES, buildAtlasMarketSnapshot, atlasMarketView,
  type AtlasFrameId, type AtlasFrameInput, type AtlasPositionedZone,
} from "../src/lib/floor/marketIntelligence";
import { atlasChartFocus } from "../src/lib/floor/atlasChartFocus";
import { createAtlasSnapshotFeed } from "../src/lib/floor/marketSnapshotFeed";
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

const NOW=1_780_000_000_000;
function frameBars(id: AtlasFrameId, n=65, close=(i:number)=>100+Math.sin(i*Math.PI/4)*2, end=NOW): TimedBar[] {
  const ms=ATLAS_FRAMES.find(f => f.id===id)!.ms;
  return Array.from({length:n},(_,i) => {
    const c=close(i);
    return {t:end-(n-i)*ms,o:c-.1,h:c+.5,l:c-.5,c};
  });
}
function inputFor(b: TimedBar[], fetchedAt=NOW): AtlasFrameInput {
  return {bars:b,fetchedAt,timeKnown:true};
}
function snapshotFor(b: TimedBar[], now=NOW, open=true) {
  return buildAtlasMarketSnapshot({symbol:"XAUUSD",frames:{"5m":inputFor(b,now)},now,marketOpen:open});
}

test("six timeframe cards use distinct provider intervals and never fill missing daily data",()=>{
  assert.deepEqual(ATLAS_FRAMES.map(f => f.interval),["1day","4h","1h","30min","15min","5min"]);
  const frames=Object.fromEntries(ATLAS_FRAMES.filter(f => f.id!=="1d").map(f => [f.id,inputFor(frameBars(f.id))]));
  const snapshot=buildAtlasMarketSnapshot({symbol:"EURUSD",frames,now:NOW,marketOpen:true});
  assert.equal(Object.keys(snapshot.frames).length,6);
  assert.equal(snapshot.frames["1d"].status,"unavailable");
  assert.deepEqual(snapshot.frames["1d"].bars,[]);
  for (const f of ATLAS_FRAMES.filter(f => f.id!=="1d")) {
    assert.equal(snapshot.frames[f.id].status,"ready");
    assert.equal(snapshot.frames[f.id].closedAt,NOW);
    assert.equal(snapshot.frames[f.id].timeKnown,true);
  }
  const fabricated=buildAtlasMarketSnapshot({symbol:"XAUUSD",frames:{"1d":inputFor(frameBars("5m"))},now:NOW,marketOpen:true});
  assert.equal(fabricated.frames["1d"].status,"unavailable");
  assert.equal(fabricated.frames["1d"].read.close,null);
  assert.match(fabricated.frames["1d"].error!,/interval does not match/);
  const wrongFast=buildAtlasMarketSnapshot({symbol:"XAUUSD",frames:{"5m":inputFor(frameBars("1h"))},now:NOW,marketOpen:true});
  assert.equal(wrongFast.frames["5m"].status,"unavailable","1h bars cannot masquerade as a 5m stream either");
});

test("forming daily and intraday candles cannot change closed direction or structural zones",()=>{
  for (const id of ["1d","5m"] as const) {
    const b=frameBars(id), forming={t:NOW,o:100,h:999,l:1,c:500};
    const before=buildAtlasMarketSnapshot({symbol:"XAUUSD",frames:{[id]:inputFor(b)},now:NOW+10_000,marketOpen:true}).frames[id];
    const after=buildAtlasMarketSnapshot({symbol:"XAUUSD",frames:{[id]:inputFor([...b,forming])},now:NOW+10_000,marketOpen:true}).frames[id];
    assert.deepEqual(after.read,before.read);
    assert.deepEqual(after.zones,before.zones);
    assert.equal(after.bars.length,before.bars.length+1,"chart may still show the actual forming bar");
  }
});

test("daily session dates use a later real daily row as closure evidence, never an invented UTC close",()=>{
  const b=frameBars("1d"), latest=b[b.length-1];
  const partial={...latest,h:999,l:1,c:500};
  const daily=buildAtlasMarketSnapshot({symbol:"XAUUSD",frames:{"1d":{
    bars:[...b.slice(0,-1),partial],fetchedAt:NOW,timeKnown:false,dateOnly:true,
  }},now:NOW,marketOpen:true});
  const f=daily.frames["1d"];
  assert.equal(f.status,"ready");
  assert.equal(f.dateOnly,true);
  assert.equal(f.timeKnown,false);
  assert.equal(f.closedAt,null);
  assert.equal(f.closedDate,new Date(b[b.length-2].t).toISOString().slice(0,10));
  assert.equal(f.read.close,b[b.length-2].c);
  assert.equal(f.bars.length,b.length);
  assert.notEqual(atlasMarketView(daily,"1d",100,NOW).readiness.state,"unavailable");
  const advanced=atlasMarketView(daily,"1d",100,NOW+60_000);
  assert.equal(advanced.frame.read.close,f.read.close,"time passing cannot close the newest daily row");
});

test("stored forming candles never become confirmed merely because wall-clock time crosses a boundary",()=>{
  const b=frameBars("5m"), partial={t:NOW,o:100,h:104,l:99.7,c:103.3};
  const captured=NOW+TF-10_000, later=NOW+TF+1_000;
  const input={symbol:"XAUUSD" as const,frames:{"5m":inputFor([...b,partial],captured)},marketOpen:true};
  const first=buildAtlasMarketSnapshot({...input,now:captured});
  const reused=buildAtlasMarketSnapshot({...input,now:later});
  assert.deepEqual(reused.frames["5m"].read,first.frames["5m"].read);
  assert.equal(reused.frames["5m"].closedAt,NOW);
  for (const snapshot of [first,reused]) {
    const v=atlasMarketView(snapshot,"5m",partial.c,later);
    assert.equal(v.crossedLevel?.confirmation,"provisional");
    assert.equal(v.readiness.state,"awaiting_close");
  }
});

test("a zone widened by a later pivot cannot credit breaks before its final bounds were confirmed",()=>{
  const b=frameBars("5m");
  // The final resistance swing is only slightly higher and belongs to the
  // existing cluster, but its new high did not exist at the first touch.
  b[58]={...b[58],h:b[58].h+.1};
  const frame=snapshotFor(b).frames["5m"];
  const zone=frame.zones.find(z => z.origin==="resistance" && z.high===102.6)!;
  assert.ok(zone);
  assert.equal(zone.confirmedAt,b[60].t+TF);
  assert.ok(zone.confirmedAt>zone.firstAt+3*TF);
  const view=atlasMarketView(snapshotFor(b),"5m",100,NOW);
  if (view.crossedLevel?.zone.id===zone.id && view.crossedLevel.confirmation==="closed")
    assert.ok(view.crossedLevel.closedAt!>zone.confirmedAt);
});

test("a live support crossing reclassifies the former support and waits for a candle close",()=>{
  const snapshot=snapshotFor(frameBars("5m"));
  const view=atlasMarketView(snapshot,"5m",97,NOW);
  assert.ok(view.support===null || view.support.high<97);
  assert.ok(view.resistance && view.resistance.low>97);
  assert.equal(view.resistance.roleReversed,true);
  assert.match(view.resistance.label,/Former support/);
  assert.equal(view.resistance.confirmedRole,false);
  assert.equal(view.crossedLevel?.confirmation,"provisional");
  assert.equal(view.crossedLevel?.direction,"below");
  assert.equal(view.readiness.state,"awaiting_close");
  assert.equal(view.trigger?.confirmed,false);
  assert.equal(view.readiness.observational,true);
});

test("zones containing current price are explicitly under test, never support above price",()=>{
  const snapshot=snapshotFor(frameBars("5m"));
  const support=snapshot.frames["5m"].zones.find(z => z.origin==="support" && z.source==="Confirmed swing")!;
  const quote=(support.low+support.high)/2;
  const view=atlasMarketView(snapshot,"5m",quote,NOW);
  assert.equal(view.activeZone?.role,"testing");
  assert.ok(view.support===null || view.support.high<quote);
  assert.ok(view.resistance===null || view.resistance.low>quote);
  assert.equal(view.readiness.state,"approaching");
  assert.ok(view.distance?.atr!=null && Number.isFinite(view.distance.atr));
  assert.equal(view.trigger?.price,support.high,"holding above the tested support is the primary range scenario");
  assert.equal(view.alternative?.price,support.low,"breaking below it is the explicitly separate alternative");
});

test("closed breakout needs a later closed retest; a forming retest does not qualify",()=>{
  const b=frameBars("5m");
  const breakout={t:NOW,o:100,h:104,l:99.7,c:103.3};
  const retest={t:NOW+TF,o:103.3,h:103.6,l:102.2,c:103.1};
  const during=NOW+TF+TF/2;
  const pending=atlasMarketView(snapshotFor([...b,breakout,retest],during),"5m",retest.c,during);
  assert.equal(pending.crossedLevel?.confirmation,"closed");
  assert.equal(pending.readiness.state,"awaiting_retest");
  assert.equal(pending.trigger?.confirmed,false);
  const after=NOW+2*TF;
  const confirmed=atlasMarketView(snapshotFor([...b,breakout,retest],after),"5m",retest.c,after);
  assert.equal(confirmed.readiness.state,"retest_confirmed");
  assert.equal(confirmed.trigger?.confirmed,true);
  assert.match(confirmed.readiness.summary,/check the Atlas signal/);
  assert.equal(confirmed.readiness.observational,true);
  assert.ok(confirmed.invalidation!.price<retest.c);
  const failed={t:NOW+2*TF,o:103.1,h:103.3,l:100.8,c:101.3};
  const failedAt=NOW+3*TF;
  const failedView=atlasMarketView(snapshotFor([...b,breakout,retest,failed],failedAt),"5m",failed.c,failedAt);
  assert.notEqual(failedView.readiness.state,"retest_confirmed");
});

test("downside break and retest are symmetric and formerly broken support stays above current price",()=>{
  const b=frameBars("5m");
  const breakdown={t:NOW,o:100,h:100.3,l:96,c:96.7};
  const retest={t:NOW+TF,o:96.7,h:97.8,l:96.4,c:96.9};
  const at=NOW+2*TF;
  const view=atlasMarketView(snapshotFor([...b,breakdown,retest],at),"5m",retest.c,at);
  assert.equal(view.readiness.state,"retest_confirmed");
  assert.equal(view.crossedLevel?.direction,"below");
  assert.equal(view.resistance?.origin,"support");
  assert.equal(view.resistance?.roleReversed,true);
  assert.equal(view.resistance?.confirmedRole,true);
  assert.ok(view.resistance!.low>retest.c);
  assert.ok(view.invalidation!.price>retest.c);
});

test("price extended from a confirmed break is not described as a current entry",()=>{
  const b=frameBars("5m");
  const after=[
    {t:NOW,o:100,h:104,l:99.7,c:103.3},
    {t:NOW+TF,o:103.3,h:103.6,l:102.2,c:103.1},
    {t:NOW+2*TF,o:103.1,h:108.5,l:103,c:108},
  ];
  const at=NOW+3*TF;
  const view=atlasMarketView(snapshotFor([...b,...after],at),"5m",108,at);
  assert.equal(view.readiness.state,"extended");
  assert.equal(view.trigger?.confirmed,false);
  assert.match(view.readiness.summary,/not an entry price/);
  assert.ok(view.distance!.atr!>1.5);
});

test("near-term direction is separate from a ranging trend and higher-timeframe bias",()=>{
  const frames=Object.fromEntries(ATLAS_FRAMES.map(f => [f.id,inputFor(frameBars(f.id,65,
    f.id==="5m" ? i => 100+Math.sin((i+2)*Math.PI/4)*2 : i => 100+i*.5))]));
  const snapshot=buildAtlasMarketSnapshot({symbol:"XAUUSD",frames,now:NOW,marketOpen:true});
  const view=atlasMarketView(snapshot,"5m",102,NOW);
  assert.equal(view.frame.read.trend,"range");
  assert.equal(view.direction,"bullish");
  assert.equal(view.higherTimeframeBias,"bullish");
  assert.match(view.frame.summary,/Sideways structure/);
  assert.match(view.frame.summary,/moving up inside that broader range/);
  assert.doesNotMatch(snapshot.frames["1d"].structure,/swing highs/,
    "monotonic candles lack confirmed pivot pairs, so HH/HL must not be claimed");
});

test("stale, unverified, future-dated and closed-market observations cannot advance readiness",()=>{
  const snapshot=snapshotFor(frameBars("5m"));
  const stale=atlasMarketView(snapshot,"5m",97,NOW+121_000);
  assert.equal(stale.frame.status,"stale");
  assert.equal(stale.readiness.state,"unavailable");
  assert.equal(stale.trigger,null);
  assert.equal(stale.crossedLevel,null);
  const unknown=buildAtlasMarketSnapshot({symbol:"XAUUSD",frames:{"5m":{...inputFor(frameBars("5m")),timeKnown:false}},now:NOW,marketOpen:true});
  assert.equal(unknown.frames["5m"].status,"insufficient");
  assert.equal(unknown.frames["5m"].read.close,null);
  const future=buildAtlasMarketSnapshot({symbol:"XAUUSD",frames:{"5m":inputFor(frameBars("5m"),NOW+60_000)},now:NOW,marketOpen:true});
  assert.equal(future.frames["5m"].status,"unavailable");
  const closed=atlasMarketView(snapshotFor(frameBars("5m"),NOW,false),"5m",97,NOW);
  assert.equal(closed.readiness.state,"market_closed");
  assert.equal(closed.trigger,null);
});

test("malformed OHLC, duplicate timestamps and future bars cannot poison the snapshot",()=>{
  const b=frameBars("5m"), original=snapshotFor(b);
  const contaminated=snapshotFor([...b,b[20],{...b[40],t:NOW+TF},{...b[42],l:999},{...b[43],c:NaN}]);
  assert.deepEqual(contaminated.frames["5m"].read,original.frames["5m"].read);
  assert.deepEqual(contaminated.frames["5m"].zones,original.frames["5m"].zones);
  assert.equal(contaminated.frames["5m"].bars.length,b.length);
});

test("snapshot feed coalesces concurrent readers, caches each real interval, and isolates symbols",async()=>{
  let now=NOW, calls:{symbol:string;interval:string;timezone:string}[]=[];
  const feed=createAtlasSnapshotFeed(async (symbol,interval,count,timezone) => {
    calls.push({symbol,interval,timezone});
    assert.equal(count,140);
    const config=ATLAS_FRAMES.find(f => f.interval===interval)!;
    return frameBars(config.id).map(b => ({datetime:new Date(b.t).toISOString(),open:String(b.o),high:String(b.h),low:String(b.l),close:String(b.c)}));
  },()=>now);
  const [first,second]=await Promise.all([feed.get("XAUUSD",true),feed.get("XAUUSD",true)]);
  assert.equal(calls.length,6);
  assert.deepEqual(second,first);
  assert.ok(calls.every(c => c.timezone==="UTC"));
  assert.deepEqual(calls.map(c => c.interval),ATLAS_FRAMES.map(f => f.interval));
  await feed.get("XAUUSD",true);
  assert.equal(calls.length,6);
  await feed.get("EURUSD",true);
  assert.equal(calls.length,12);
  assert.equal(calls[6].symbol,"EUR/USD");
  now+=31_000;
  await feed.get("XAUUSD",true);
  assert.equal(calls.length,14,"only 5m and 15m need a new provider read before the next larger boundary");
});

test("provider failures preserve original data age and do not replace a missing frame",async()=>{
  let now=NOW, fail=false;
  const feed=createAtlasSnapshotFeed(async (_symbol,interval) => {
    if (interval==="1day" || fail) return null;
    const config=ATLAS_FRAMES.find(f => f.interval===interval)!;
    return frameBars(config.id).map(b => ({datetime:new Date(b.t).toISOString(),open:String(b.o),high:String(b.h),low:String(b.l),close:String(b.c)}));
  },()=>now);
  const first=await feed.get("USDJPY",true);
  assert.equal(first.frames["1d"].status,"unavailable");
  assert.equal(first.frames["5m"].status,"ready");
  fail=true; now+=31_000;
  const failed=await feed.get("USDJPY",true);
  assert.equal(failed.frames["5m"].fetchedAt,NOW);
  assert.equal(failed.frames["5m"].status,"stale");
  assert.deepEqual(failed.frames["5m"].bars,first.frames["5m"].bars);
  assert.equal(atlasMarketView(failed,"5m",97,now).readiness.state,"unavailable");
});

test("community-cache close grace excludes a possible pre-close payload after the interval ends",async()=>{
  const at=NOW+TF+1_000;
  const partial={t:NOW,o:100,h:104,l:99.7,c:103.3};
  const feed=createAtlasSnapshotFeed(async (_symbol,interval) => {
    if (interval!=="5min") return null;
    return [...frameBars("5m"),partial].map(b => ({datetime:new Date(b.t).toISOString(),open:String(b.o),high:String(b.h),low:String(b.l),close:String(b.c)}));
  },()=>at,30_000);
  const snapshot=await feed.get("XAUUSD",true);
  assert.equal(snapshot.frames["5m"].closedAt,NOW);
  assert.equal(atlasMarketView(snapshot,"5m",partial.c,at).readiness.state,"awaiting_close");
});

test("a delayed provider response cannot advance the closed-candle cutoff past request start",async()=>{
  // This request may hit a 30s-old shared payload captured just before the
  // close. An additional 8s response delay must not turn that partial row into
  // a closed candle merely because retrieval completed later.
  const requestStarted=NOW+TF+27_000;
  let clock=requestStarted;
  const partial={t:NOW,o:100,h:104,l:99.7,c:103.3};
  const feed=createAtlasSnapshotFeed(async (_symbol,interval) => {
    if (interval!=="5min") return null;
    clock+=8_000;
    return [...frameBars("5m"),partial].map(b => ({datetime:new Date(b.t).toISOString(),open:String(b.o),high:String(b.h),low:String(b.l),close:String(b.c)}));
  },()=>clock,30_000);
  const snapshot=await feed.get("XAUUSD",true);
  assert.equal(snapshot.frames["5m"].fetchedAt,requestStarted+8_000);
  assert.equal(snapshot.frames["5m"].closedAt,NOW);
  assert.equal(snapshot.frames["5m"].read.close,frameBars("5m").at(-1)!.c);
  assert.equal(atlasMarketView(snapshot,"5m",partial.c,clock).readiness.state,"awaiting_close");
});


test("the chart locates the quote inside the tested band's current role and keeps only nearby context", () => {
  const tested: AtlasPositionedZone = {
    id: "retest", timeframe: "5m", low: 99, high: 101, price: 100, origin: "resistance",
    role: "testing", roleReversed: true, confirmedRole: true, label: "Former resistance",
    firstAt: BASE, lastAt: BASE, confirmedAt: BASE, touches: 2, source: "Confirmed swing",
  };
  const near: AtlasPositionedZone = { ...tested, id: "near", low: 101.3, high: 101.5, price: 101.4, role: "resistance" };
  const far: AtlasPositionedZone = { ...near, id: "far", low: 150, high: 151, price: 150.5 };
  const candles = bars(20, () => 100);
  const result = atlasChartFocus(tested, [far, near], 100.5, candles, true);
  assert.deepEqual(result.meter, { low: 99, high: 101, role: "support", percent: 75 });
  assert.deepEqual(result.zones, [{ low: 99, high: 101, kind: "support", label: "Support band" }]);
  assert.deepEqual(result.levels.map(l => [l.kind, l.price]), [["support", 100], ["resistance", 101.3]]);
  assert.deepEqual(atlasChartFocus(tested, [near], 100.5, candles, false), { levels: [], zones: [], meter: null });
  assert.equal(atlasChartFocus(tested, [near], 101.1, candles, true).meter, null);
  assert.equal(atlasChartFocus({ ...tested, low: 100, high: 100 }, [], 100, candles, true).meter, null);
});
