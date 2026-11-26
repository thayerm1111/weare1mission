import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { selectWatchLevels, scanDiagnostics, isObservedTrade, tradeProgress, pricePulse } from "../src/lib/nitrous/dashboard";
import type { NitrousPosition } from "../src/lib/nitrous/types";
const NOW=Date.parse("2026-11-25T23:00:00Z");
const zone=(role:string,low:number,high:number,over={})=>({role,low,high,knownAt:NOW-1000,origin:"M5",invalidatedAt:null,...over});
const position:NitrousPosition={id:"p",side:"sell",entry:3500,stop:3505,initialStop:3505,target:3490,quantity:1,openedAt:new Date(NOW-60_000).toISOString(),status:"open",protectionState:"protected",managementEnabled:true,closeRequestedAt:null,closeRequestState:null,closeRequestError:null,liveObservedAt:new Date(NOW-1000).toISOString(),unrealizedPnl:0};
test("watch zones are factual, nearby, non-invalidated and known at scan time",()=>{
 const levels=selectWatchLevels([zone("support",3490,3495),zone("support",3498,3499),zone("resistance",3501,3503),zone("resistance",3500,3501,{knownAt:NOW+1}),zone("resistance",3500,3501,{invalidatedAt:NOW}),zone("resistance",3800,3801)],3500,NOW);
 assert.deepEqual(levels.map(z=>[z.role,z.low,z.high]),[["support",3498,3499],["resistance",3501,3503]]);
 assert.deepEqual(selectWatchLevels([],null,NOW),[]);
 assert.deepEqual(scanDiagnostics({rejections:[{code:"no_zone"},{code:"no_zone"},{code:"stop_too_wide"}]},3500,NOW).baselineChecks,[{code:"no_zone",count:2},{code:"stop_too_wide",count:1}]);
});
test("open trade status expires and unknown or unconfirmed positions are never live",()=>{
 assert.equal(isObservedTrade(position,NOW),true);assert.equal(isObservedTrade(position,NOW+31_000),false);
 assert.equal(isObservedTrade({...position,status:"orphan_review"},NOW),false);assert.equal(isObservedTrade({...position,liveObservedAt:null},NOW),false);assert.equal(isObservedTrade({...position,quantity:0},NOW),false);
});
test("trade progress handles long/short, moved stop and missing reference without fabricated P&L",()=>{
 const sell=tradeProgress(position,3495)!;assert.ok(sell.current>sell.entry);assert.equal(sell.towardTarget,true);
 assert.equal(tradeProgress(position,3505)?.current,0);assert.equal(tradeProgress(position,3490)?.current,100);
 assert.equal(tradeProgress(position,null),null);assert.equal(tradeProgress({...position,target:null},3495),null);
 const buy={...position,side:"buy" as const,stop:3501,initialStop:3495,target:3510};assert.ok(tradeProgress(buy,3505)!.current>tradeProgress(buy,3505)!.entry);
});
test("pulse uses real completed close values, never a random readiness score",()=>{
 assert.equal(pricePulse([]),null);const result=pricePulse([3500,3501,3499].map((c,i)=>({t:NOW+i*300000,o:c,h:c,l:c,c})))!;
 assert.equal(result.points.split(" ").length,3);assert.ok(result.change<0);
});
test("market redesign preserves existing connection, settings, close and Telegram paths",()=>{
 const workspace=readFileSync("src/components/om/nitrous/NitrousWorkspace.tsx","utf8");
 for(const literal of ["NitrousConnect","/api/nitrous/connect","/api/nitrous/settings","/api/nitrous/position","NitrousAddonPanel","NitrousTelegramPanel","NitrousLiveTrades","NitrousMarketDesk","Enable faster Nitrous"])assert.ok(workspace.includes(literal),literal);
 const desk=readFileSync("src/components/om/nitrous/NitrousMarketDesk.tsx","utf8");assert.ok(desk.includes("Broker reported"));assert.ok(desk.includes("not an executable quote"));
});
