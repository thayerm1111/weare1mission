import test from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { selectWatchLevels, scanDiagnostics, isObservedTrade, chartProgressStage, insideBothZones, tradeProgress, pricePulse, displayableSetup } from "../src/lib/nitrous/dashboard";
import type { NitrousPosition, NitrousScenario } from "../src/lib/nitrous/types";
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
test("the Nitrous chart separates a market trigger from a fresh broker fill", () => {
  const plan = { state: "triggered" } as NitrousScenario;
  assert.equal(chartProgressStage(true, null, null, 0), "Watching");
  assert.equal(chartProgressStage(true, { ...plan, state: "armed" }, null, NOW), "Watching");
  assert.equal(chartProgressStage(true, plan, null, NOW), "Confirmed");
  assert.equal(chartProgressStage(false, plan, null, NOW), null);
  assert.equal(chartProgressStage(false, null, position, NOW), "Filled");
  assert.equal(chartProgressStage(true, plan, position, 0), null);
  assert.equal(chartProgressStage(true, plan, position, NOW+31_000), null);
});
test("zone overlap requires the current price to be inside both reported zones", () => {
  const zones=selectWatchLevels([zone("support",3561.88,3572.28),zone("resistance",3550.6,3575.65)],3571.01,NOW);
  assert.equal(insideBothZones(zones,3571.01),true);
  assert.equal(insideBothZones(zones,3573),false);
  assert.equal(insideBothZones(zones.slice(0,1),3571.01),false);
  assert.equal(insideBothZones(zones,null),false);
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

test("desk hides expired, invalidated and already-crossed offers; it never displays a missed target as a new entry",()=>{
 const plan={setupId:"test",family:"break_retest",side:"sell" as const,timeframe:"M5",state:"watching",entryBandLow:3500,entryBandHigh:3501,refEntry:3500,stop:3505,target:3490,stopUsd:5,targetUsd:10,invalidation:3504,expiresAt:NOW+60000,conditionsMet:[],conditionsPending:[]};
 assert.equal(displayableSetup(plan,3498,NOW,true),true);
 assert.equal(displayableSetup(plan,3489,NOW,true),false);
 assert.equal(displayableSetup(plan,3504,NOW,true),false);
 assert.equal(displayableSetup(plan,3498,NOW,false),false);
 assert.equal(displayableSetup({...plan,expiresAt:NOW},3498,NOW,true),false);
 assert.equal(displayableSetup({...plan,state:"invalidated"},3498,NOW,true),false);
});
test("Simple leads with the chart and Advanced with the full setup details, retaining broker position access",()=>{
 (globalThis as unknown as { React: typeof React }).React = React;
 const previousCss = require.extensions[".css"];
 require.extensions[".css"] = () => {};
 const { NitrousMarketDesk } = require("../src/components/om/nitrous/NitrousMarketDesk") as typeof import("../src/components/om/nitrous/NitrousMarketDesk");
 if (previousCss) require.extensions[".css"] = previousCss; else delete require.extensions[".css"];
 const render = (simple:boolean) => renderToStaticMarkup(React.createElement(NitrousMarketDesk, {
   simple, data:null, loading:false, error:"", fresh:false, now:NOW, accountNow:0,
   account:null, onRefresh() {}, mode:"nitrous", busy:false, onClose() {},
 }));
 const simple=render(true), advanced=render(false);
 const chart='aria-label="Gold market chart"', details='id="nitrous-next-title"';
 for (const html of [simple,advanced]) {
   assert.ok(html.includes(chart) && html.includes(details));
   assert.doesNotMatch(html, /aria-current="step"/, "a delayed market and unavailable account cannot assert progress");
 }
 assert.ok(simple.indexOf(chart)<simple.indexOf(details));
 assert.ok(advanced.indexOf(details)<advanced.indexOf(chart));
 const desk=readFileSync("src/components/om/nitrous/NitrousMarketDesk.tsx","utf8");
 for(const s of ["nt-market-brief","nt-tf-strip","NEXT AREA TO WATCH","What confirms the entry","No active trade","onClose={onClose} embedded"])assert.ok(desk.includes(s),s);
 const workspace=readFileSync("src/components/om/nitrous/NitrousWorkspace.tsx","utf8");
 assert.ok(workspace.includes("!entitled && account && <NitrousLiveTrades"),"existing positions remain visible after membership lapses");
 const route=readFileSync("src/app/api/admin/nitrous-telegram/route.ts","utf8");
 assert.ok(route.includes("export async function GET(req: Request)"),"Next.js route exports require a nonoptional Request");
});
