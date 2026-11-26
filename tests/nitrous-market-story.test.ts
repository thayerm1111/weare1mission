import test from "node:test";
import assert from "node:assert/strict";
import { buildMarketStory, marketAge, marketUpdate, rankedSetups, watchBoundary } from "../src/lib/nitrous/market-story";
import type { NitrousAnalyze, NitrousScenario, NitrousWatchLevel } from "../src/lib/nitrous/types";

const NOW = Date.parse("2026-11-26T03:00:00Z");
const at = (age: number) => new Date(NOW - age).toISOString();
const level = (role: "support" | "resistance", low: number, high: number, over = {}): NitrousWatchLevel => ({ role, low, high, origin: "M5", knownAt: NOW - 120_000, ...over });
const snapshot = (over: Partial<NitrousAnalyze> = {}): NitrousAnalyze => ({
  available: true, asOf: at(60_000), generatedAt: at(10_000), ageMs: 10_000, stale: false,
  price: 3592.53035, symbol: "XAUUSD", source: "reference", bars: [], scenarios: [],
  flow: [ {timeframe:"D",direction:"down",label:"Downtrend"}, {timeframe:"4H",direction:"down",label:"Downtrend"},
    {timeframe:"1H",direction:"range",label:"Range"}, {timeframe:"15M",direction:"range",label:"Range"}, {timeframe:"5M",direction:"up",label:"Uptrend"} ],
  explanation: "", health: { state: "ok", reasons: [] }, strategyVersion: "test",
  diagnostics: { watchLevels: [level("support",3589.20,3589.33), level("resistance",3547.37,3595.51,{origin:"H1"})], baselineChecks: [], fastChecks: [], baselineCandidates: 0, fastCandidates: 0 },
  ...over,
});
const buy = (over: Partial<NitrousScenario> = {}): NitrousScenario => ({
  setupId: "buy", family: "trend_pullback", side: "buy", timeframe: "M5", state: "watching", profile: "both",
  entryBandLow: 3590, entryBandHigh: 3591, refEntry: 3590.5, stop: 3585, invalidation: 3586, target: 3603,
  stopUsd: 5.5, targetUsd: 12.5, expiresAt: NOW + 60_000,
  conditionsMet: [], conditionsPending: ["A completed entry candle rejects the pullback zone.", "Broker price returns inside the entry zone with affordable size, spread and margin."],
  ...over,
});
const sell = (over: Partial<NitrousScenario> = {}): NitrousScenario => buy({ setupId: "sell", side: "sell", entryBandLow:3595, entryBandHigh:3596,
  refEntry:3595.5, stop:3601, invalidation:3600, target:3583, ...over });

test("market narrative explains short-term rally versus daily/4h downtrend and hourly range", () => {
  const story = buildMarketStory(snapshot(), { fresh:true, now:NOW });
  assert.equal(story.headline, "Short-term rally, broader downtrend");
  assert.match(story.summary, /5-minute structure points up/);
  assert.match(story.summary, /1-hour chart remains range-bound/);
  assert.match(story.summary, /Daily and 4-hour structure still point lower/);
  assert.equal(story.tone, "neutral");
  assert.equal(story.quoteAgeMs, 60_000); assert.equal(story.analysisAgeMs, 10_000);
});

test("wide containing supply keeps the full zone but names the nearby upper edge", () => {
  const story = buildMarketStory(snapshot(), { fresh:true, now:NOW });
  const next = story.opportunity;
  assert.equal(next.kind, "watch"); assert.equal(next.title, "Inside supply zone");
  assert.deepEqual(next.range, {low:3547.37,high:3595.51});
  assert.equal(next.boundary,3595.51); assert.match(next.boundaryText,/Upper supply boundary · \$2.98 above reference/);
  assert.equal(next.distance,0); assert.match(next.distanceText,/inside/);
  assert.equal(next.detail,"Gold is inside a 1-hour supply area. No entry is confirmed here.");
  assert.ok(!next.boundaryText.includes("3,595.51"),"boundary caption does not duplicate the adjacent display price");
  assert.equal(next.target,null); assert.equal(next.stop,null); assert.equal(next.invalidationText,null);
  assert.match(next.trigger,/hourly chart needs a directional trend/);
  assert.equal(story.zones[1].high,3589.33);
});

test("containing demand is not relabeled as support above price and a nearer edge wins", () => {
  const demand = level("support",3580,3620);
  assert.equal(watchBoundary(demand,3602),3580);
  const story=buildMarketStory(snapshot({price:3602,diagnostics:{...snapshot().diagnostics!,watchLevels:[demand,level("resistance",3604,3605)]}}),{fresh:true,now:NOW});
  assert.equal(story.opportunity.title,"Supply above price");
  assert.equal(story.opportunity.boundary,3604);
  const alone=buildMarketStory(snapshot({price:3602,diagnostics:{...snapshot().diagnostics!,watchLevels:[demand]}}),{fresh:true,now:NOW});
  assert.equal(alone.opportunity.title,"Inside demand zone"); assert.equal(alone.opportunity.boundary,3580);
  assert.match(alone.opportunity.boundaryText,/Lower demand boundary/);
});

test("stale, missing, unhealthy and future-dated data cannot produce an actionable setup", () => {
  const plan=buy();
  for (const data of [null,snapshot({stale:true}),snapshot({asOf:at(120_001)}),snapshot({generatedAt:at(45_001)}),snapshot({generatedAt:at(-5001)}),snapshot({price:NaN}),snapshot({health:{state:"ok",reasons:["Session closed"]}})]) {
    const story=buildMarketStory(data,{fresh:true,now:NOW,plan});
    assert.equal(story.opportunity.kind,"stale"); assert.deepEqual(story.zones,[]); assert.equal(story.opportunity.plan,null);
  }
  assert.equal(buildMarketStory(snapshot(),{fresh:false,now:NOW,plan}).opportunity.kind,"stale");
  assert.equal(marketAge(at(-5001),NOW),null); assert.equal(marketAge(at(-4000),NOW),0);
});

test("unknown or invalidated/out-of-side zones do not become invented watch setups", () => {
  const diagnostics={...snapshot().diagnostics!,watchLevels:[level("support",3600,3601),level("resistance",3580,3581),level("support",3590,3591,{knownAt:NOW+1}),level("support",3590,3591,{invalidatedAt:NOW}),level("support",3589,NaN),level("support",3500,3501)]};
  const story=buildMarketStory(snapshot({diagnostics}),{fresh:true,now:NOW});
  assert.equal(story.opportunity.kind,"none"); assert.deepEqual(story.zones,[]);
  assert.equal(story.opportunity.range,null); assert.equal(story.opportunity.target,null);
});

test("nearest coherent engine plan is ranked first and profile boundaries are preserved", () => {
  const near=buy({setupId:"near",entryBandLow:3592,entryBandHigh:3593,refEntry:3592.5});
  const fast=buy({setupId:"fast",profile:"nitrous",entryBandLow:3592,entryBandHigh:3593,refEntry:3592.5,state:"armed"});
  assert.deepEqual(rankedSetups([sell(),buy(),near,fast],3592.53,NOW,true,"slow_drip").map(s=>s.setupId),["near","buy","sell"]);
  assert.equal(rankedSetups([near,fast],3592.53,NOW,true,"nitrous")[0].setupId,"fast");
  assert.deepEqual(rankedSetups([near],3592.53,NOW,false,"nitrous"),[]);
  assert.deepEqual(rankedSetups([near],NaN,NOW,true,"nitrous"),[]);
});

test("expired, crossed-target, invalidated and malformed buy/sell plans are suppressed", () => {
  assert.equal(rankedSetups([buy()],3586,NOW,true,"nitrous").length,0);
  assert.equal(rankedSetups([buy()],3603,NOW,true,"nitrous").length,0);
  assert.equal(rankedSetups([sell()],3600,NOW,true,"nitrous").length,0);
  assert.equal(rankedSetups([sell()],3583,NOW,true,"nitrous").length,0);
  for(const plan of [buy({expiresAt:NOW}),buy({state:"invalidated"}),buy({stop:3595}),buy({target:3580}),buy({invalidation:NaN}),buy({refEntry:3620}),sell({stop:3580}),sell({target:3610})])
    assert.equal(rankedSetups([plan],3592.53,NOW,true,"nitrous").length,0);
});

test("setup narrates engine confirmation and exact invalidation without calling a reference trigger a fill", () => {
  const plan=buy();
  const story=buildMarketStory(snapshot({scenarios:[plan]}),{fresh:true,now:NOW,plan});
  assert.equal(story.opportunity.kind,"setup"); assert.equal(story.opportunity.trigger,plan.conditionsPending[0]);
  assert.match(story.opportunity.invalidationText!,/3,586.00 or lower/);
  const short=sell();
  assert.match(buildMarketStory(snapshot({scenarios:[short]}),{fresh:true,now:NOW,plan:short}).opportunity.invalidationText!,/3,600.00 or higher/);
  const armed=buy({state:"armed"});
  assert.match(buildMarketStory(snapshot({scenarios:[armed]}),{fresh:true,now:NOW,plan:armed}).opportunity.trigger,/reference trigger is confirmed/);
  const triggered=buy({state:"triggered"});
  const active=buildMarketStory(snapshot({scenarios:[triggered]}),{fresh:true,now:NOW,plan:triggered}).opportunity;
  assert.match(active.status,/not a broker fill/); assert.match(active.trigger,/Broker execution still needs its own confirmation/);
  assert.equal(buildMarketStory(snapshot(),{fresh:true,now:NOW,plan}).opportunity.kind,"watch","a retained selected plan cannot survive removal from the current payload");
});

test("latest change deduplicates poll timestamps and only reports observed source changes", () => {
  const before=snapshot({generatedAt:at(20_000)}), current=snapshot();
  assert.equal(marketUpdate(before,current,NOW),null);
  assert.equal(marketUpdate(before,{...current,price:3592.54},NOW),null,"a price tick alone does not invent a new analysis event");
  const changed=snapshot({flow:current.flow.map(f=>f.timeframe==="1H"?{...f,direction:"up"}:f)});
  assert.match(marketUpdate(before,changed,NOW)!,/1H structure changed from range-bound to up/);
  assert.equal(marketUpdate(before,{...changed,stale:true},NOW),null);
  assert.equal(marketUpdate(current,before,NOW),null,"out-of-order reads do not create events");
  assert.match(marketUpdate(before,snapshot({scenarios:[buy()]}),NOW)!,/New buy pullback/);
  assert.equal(marketUpdate(null,current,NOW),null);
});

test("zone visit changes need an actual price crossing of an already-known area", () => {
  const zones=[level("resistance",3595,3596)];
  const before=snapshot({price:3594,generatedAt:at(20_000),diagnostics:{...snapshot().diagnostics!,watchLevels:zones}});
  const current=snapshot({price:3595.2,diagnostics:{...snapshot().diagnostics!,watchLevels:zones}});
  assert.match(marketUpdate(before,current,NOW)!,/entered the supply zone/);
  assert.equal(marketUpdate({...before,diagnostics:{...before.diagnostics!,watchLevels:[]}},current,NOW),null);
});


test("activity respects the selected profile for new plans and reference triggers", () => {
  const before=snapshot({generatedAt:at(20_000)});
  const fast=buy({setupId:"fast-only",profile:"nitrous"});
  const current=snapshot({scenarios:[fast]});
  assert.equal(marketUpdate(before,current,NOW,"slow_drip"),null);
  assert.match(marketUpdate(before,current,NOW,"nitrous")!,/New buy pullback/);
  const known=snapshot({generatedAt:at(20_000),scenarios:[fast]});
  const triggered=snapshot({scenarios:[{...fast,state:"triggered"}]});
  assert.equal(marketUpdate(known,triggered,NOW,"slow_drip"),null);
  assert.match(marketUpdate(known,triggered,NOW,"nitrous")!,/reference trigger/);
  const baseline=buy();
  assert.match(marketUpdate(before,snapshot({scenarios:[baseline]}),NOW,"slow_drip")!,/New buy pullback/);
});

test("opportunity copy explains chart location and pattern without implementation jargon", () => {
  const plan=buy();
  const detail=buildMarketStory(snapshot({scenarios:[plan]}),{fresh:true,now:NOW,plan}).opportunity.detail;
  assert.match(detail,/5-minute pullback into support/);
  assert.doesNotMatch(detail,/engine|frozen/);
  const watch=buildMarketStory(snapshot({diagnostics:{...snapshot().diagnostics!,watchLevels:[level("support",3589.20,3589.33)]}}),{fresh:true,now:NOW}).opportunity;
  assert.equal(watch.detail,"Gold is above a 5-minute demand area. No entry is confirmed here.");
});


test("activity retires expired, removed and invalidated offers without inventing trade outcomes", () => {
  const expiring=buy({expiresAt:NOW-5_000});
  const expiredBefore=snapshot({generatedAt:at(20_000),scenarios:[expiring]});
  assert.match(marketUpdate(expiredBefore,snapshot(),NOW)!,/previous buy pullback setup has expired/);
  const before=snapshot({generatedAt:at(20_000),scenarios:[buy()]});
  const removed=marketUpdate(before,snapshot(),NOW)!;
  assert.equal(removed,"The previous buy pullback setup is no longer in the current read.");
  assert.match(marketUpdate(before,snapshot({scenarios:[buy({state:"invalidated"})]}),NOW)!,/marked invalidated in the current read/);
  assert.match(marketUpdate(before,snapshot({scenarios:[buy({state:"expired"})]}),NOW)!,/has expired/);
  for (const message of [removed,marketUpdate(before,snapshot({price:3586}),NOW)!,marketUpdate(before,snapshot({price:3603}),NOW)!])
    assert.doesNotMatch(message,/profit|trade clos|closed trade|fill/i);
  assert.equal(marketUpdate(before,snapshot({scenarios:[buy()]}),NOW),null,"unchanged current plan does not create a retirement event");
  assert.equal(marketUpdate(snapshot({generatedAt:at(20_000)}),snapshot(),NOW),null,"an absent plan with no previously valid offer produces no event");
});

test("removal events distinguish reference invalidation and target crossings for each side", () => {
  const buyBefore=snapshot({generatedAt:at(20_000),scenarios:[buy()]});
  assert.match(marketUpdate(buyBefore,snapshot({price:3586}),NOW)!,/invalidation at 3,586.00/);
  assert.match(marketUpdate(buyBefore,snapshot({price:3603}),NOW)!,/target at 3,603.00/);
  const sellBefore=snapshot({generatedAt:at(20_000),scenarios:[sell()]});
  assert.match(marketUpdate(sellBefore,snapshot({price:3600}),NOW)!,/invalidation at 3,600.00/);
  assert.match(marketUpdate(sellBefore,snapshot({price:3583}),NOW)!,/target at 3,583.00/);
});

test("replacement plans take priority, removals precede unrelated flow changes, and profile applies", () => {
  const before=snapshot({generatedAt:at(20_000),scenarios:[buy()]});
  assert.match(marketUpdate(before,snapshot({scenarios:[sell()]}),NOW)!,/^New sell/);
  const changed=snapshot({flow:snapshot().flow.map(f=>f.timeframe==="1H"?{...f,direction:"up"}:f)});
  assert.equal(marketUpdate(before,changed,NOW),"The previous buy pullback setup is no longer in the current read.");
  const fast=buy({profile:"nitrous"});
  assert.equal(marketUpdate({...before,scenarios:[fast]},snapshot(),NOW,"slow_drip"),null);
  assert.match(marketUpdate({...before,scenarios:[fast]},snapshot(),NOW,"nitrous")!,/no longer in the current read/);
  assert.equal(marketUpdate({...before,scenarios:[buy({state:"invalidated"})]},snapshot(),NOW),null,"a previously invalid plan is not announced as newly removed");
});
