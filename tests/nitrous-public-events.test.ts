import test from "node:test";
import assert from "node:assert/strict";
import type { Bar, Setup } from "../rapid/core/types";
import { advancePublicSetups, publicSetupTerminal, type PublicSetupsInput } from "../nitrous/public-events";
import { validNitrousTelegramEvent } from "../src/lib/nitrous-telegram";

const NOW=Date.UTC(2026,10,25,23,0,0);
const MINUTE=60_000;
const plan=(over:Partial<Setup>={}):Setup=>({
  setupId:"nitrous:opportunity",visitId:"public-visit",strategyVersion:"nitrous_v1",configVersion:"nitrous_v1.cfg.1",
  family:"trend_pullback",side:"buy",state:"watching",timeframe:"M5",zoneId:"support",zoneVersion:1,parentId:"swing-support",
  createdAt:NOW-10_000,stateAt:NOW-10_000,expiresAt:NOW+10*MINUTE,
  tolerances:{atrEntry:4,touchTolerance:.25,breakBuffer:.3,stopBuffer:.5,rearmDistance:2,spreadAtFreeze:null},
  entryBandLow:4200,entryBandHigh:4201,invalidation:4197,stop:4194,opposingLevelId:"resistance",opposingPrice:4215,
  refEntry:4200.5,target:4212,targetUsd:11.5,stopUsd:6.5,transitions:[],conditionsMet:["Aligned structure"],conditionsPending:["Closed trigger"],breakEvidence:null,
  ...over,
});
const bar=(at:number,price:number,over:Partial<Bar>={}):Bar=>({t:at-MINUTE,o:price,h:price+.1,l:price-.1,c:price,...over});
const input=(over:Partial<PublicSetupsInput>={}):PublicSetupsInput=>({prior:[],current:[plan()],bars:[bar(NOW,4205)],referencePrice:4205,now:NOW,triggerReady:()=>false,...over});
const triggered=()=>advancePublicSetups(input({referencePrice:4200.5,bars:[bar(NOW,4200.5)],triggerReady:()=>true})).updatedSetups;

test("reference lifecycle distinguishes approach, ready-to-enter and observed trigger without claiming a fill",()=>{
  const initial=advancePublicSetups(input());
  assert.equal(initial.updatedSetups[0].state,"watching");assert.deepEqual(initial.events.map(e=>e.kind),["setup"]);
  const near=advancePublicSetups(input({prior:initial.updatedSetups,referencePrice:4201.5}));
  assert.equal(near.updatedSetups[0].state,"approaching");assert.equal(near.events.length,0);
  const armed=advancePublicSetups(input({prior:near.updatedSetups,referencePrice:4201.5,triggerReady:()=>true}));
  assert.equal(armed.updatedSetups[0].state,"armed");assert.equal(armed.events.length,0);
  const hit=advancePublicSetups(input({prior:armed.updatedSetups,referencePrice:4200.5,triggerReady:()=>true}));
  assert.equal(hit.updatedSetups[0].state,"triggered");assert.deepEqual(hit.events.map(e=>e.kind),["triggered"]);
  assert.match(hit.updatedSetups[0].transitions.at(-1)!.reason,/not a broker fill/);
  assert.equal(advancePublicSetups(input({prior:hit.updatedSetups,referencePrice:4200.5,triggerReady:()=>true})).events.length,0);
});

test("public prices, expiry and trigger input remain frozen while the engine recomputes the same ID",()=>{
  const first=advancePublicSetups(input());
  const altered=plan({entryBandLow:4220,entryBandHigh:4221,refEntry:4220.5,invalidation:4217,stop:4214,target:4232,expiresAt:NOW+30*MINUTE});
  let frozen:Setup|undefined;
  const next=advancePublicSetups(input({prior:first.updatedSetups,current:[altered],referencePrice:4200.5,
    triggerReady:s=>{frozen=s;s.target=9999;return true;}}));
  assert.equal(frozen?.entryBandLow,4200);
  assert.equal(next.updatedSetups[0].target,4212);
  assert.equal(next.updatedSetups[0].expiresAt,plan().expiresAt);
  assert.equal(next.events[0].target,4212);
  assert.equal(next.updatedSetups[0].state,"triggered");
});

test("removed and expired offers terminate once and cannot silently revive with the same opportunity ID",()=>{
  const initial=advancePublicSetups(input());
  const removed=advancePublicSetups(input({prior:initial.updatedSetups,current:[]}));
  assert.equal(removed.updatedSetups[0].state,"invalidated");assert.equal(removed.events[0].kind,"invalidated");
  const revived=advancePublicSetups(input({prior:removed.updatedSetups,triggerReady:()=>true,referencePrice:4200.5}));
  assert.equal(revived.updatedSetups[0].state,"invalidated");assert.equal(revived.events.length,0);
  const now=plan().expiresAt;
  const expired=advancePublicSetups(input({prior:initial.updatedSetups,current:[plan({expiresAt:now+MINUTE})],now,bars:[bar(now,4200.5)],referencePrice:4200.5,triggerReady:()=>true}));
  assert.equal(expired.updatedSetups[0].state,"expired");assert.equal(expired.events[0].kind,"expired");
  assert.equal(expired.events[0].expiresAt,new Date(now).toISOString());
});

test("stale or unavailable market inputs cannot create, trigger, remove or score setups",()=>{
  assert.equal(advancePublicSetups(input({marketReady:false,triggerReady:()=>true})).updatedSetups.length,0);
  const initial=triggered();
  const stale=advancePublicSetups(input({prior:initial,current:[],marketReady:false,now:NOW+MINUTE,
    referencePrice:4212,bars:[bar(NOW+MINUTE,4212,{h:4213})]}));
  assert.equal(stale.updatedSetups[0].state,"triggered");assert.equal(stale.events.length,0);
  const timedOut=advancePublicSetups(input({prior:initial,current:[],now:NOW+4*MINUTE,referencePrice:4200.5,triggerReady:()=>true}));
  assert.equal(timedOut.updatedSetups[0].state,"triggered");assert.equal(timedOut.events.length,0);
  const expired=advancePublicSetups(input({prior:initial,now:plan().expiresAt,marketReady:false}));
  assert.equal(expired.events[0].kind,"expired");
});

test("target observations consume only the public setup and never report account profit",()=>{
  const result=advancePublicSetups(input({prior:triggered(),now:NOW+MINUTE,referencePrice:4212,
    bars:[bar(NOW+MINUTE,4212,{o:4201,h:4213,l:4200})]}));
  assert.equal(result.updatedSetups[0].state,"consumed");assert.equal(result.events[0].kind,"target_observed");
  assert.match(result.updatedSetups[0].transitions.at(-1)!.reason,/does not establish an account fill or realized profit/);
  assert.equal(advancePublicSetups(input({prior:result.updatedSetups,now:NOW+MINUTE})).events.length,0);
});

test("bars are processed chronologically and the first observed stop prevents a later target claim",()=>{
  const stop=bar(NOW+MINUTE,4194,{o:4200,h:4201,l:4193});
  const target=bar(NOW+2*MINUTE,4212,{o:4201,h:4213,l:4200});
  const result=advancePublicSetups(input({prior:triggered(),now:NOW+2*MINUTE,referencePrice:4212,bars:[target,stop]}));
  assert.equal(result.events[0].kind,"stop_observed");assert.equal(result.updatedSetups[0].state,"invalidated");
  assert.equal(result.events[0].occurredAt,new Date(NOW+MINUTE).toISOString());
});

test("one candle touching stop and target stays ambiguous and receives no scored outcome",()=>{
  const result=advancePublicSetups(input({prior:triggered(),now:NOW+MINUTE,referencePrice:4205,
    bars:[bar(NOW+MINUTE,4205,{o:4200,h:4213,l:4193})]}));
  assert.equal(result.updatedSetups[0].state,"invalidated");assert.deepEqual(result.events.map(e=>e.kind),["invalidated"]);
  assert.equal(result.updatedSetups[0].transitions.at(-1)!.evidence.ambiguous,true);
  assert.match(result.updatedSetups[0].transitions.at(-1)!.reason,/sequence is unknown/);
});

test("pre-trigger extremes, forming candles and conflicting duplicate candles cannot invent an outcome",()=>{
  const initial=advancePublicSetups(input({now:NOW+15_000,referencePrice:4200.5,triggerReady:()=>true})).updatedSetups;
  const straddles=bar(NOW+MINUTE,4205,{o:4200,h:4213,l:4193});
  const first=advancePublicSetups(input({prior:initial,now:NOW+MINUTE,referencePrice:4205,bars:[straddles]}));
  assert.equal(first.updatedSetups[0].state,"triggered");assert.equal(first.events.length,0);
  const after=bar(NOW+2*MINUTE,4212,{o:4205,h:4213,l:4204});
  const forming=advancePublicSetups(input({prior:first.updatedSetups,now:NOW+MINUTE,referencePrice:4205,bars:[straddles,after]}));
  assert.equal(forming.events.length,0);
  const conflicted=advancePublicSetups(input({prior:first.updatedSetups,now:NOW+2*MINUTE,referencePrice:4205,bars:[straddles,after,{...after,h:4206,c:4205}]}));
  assert.equal(conflicted.events.length,0);
  const closed=advancePublicSetups(input({prior:first.updatedSetups,now:NOW+2*MINUTE,referencePrice:4212,bars:[after,straddles]}));
  assert.equal(closed.events[0].kind,"target_observed");
});

test("short observations use the same direction-correct rules",()=>{
  const short=plan({side:"sell",invalidation:4204,stop:4207,target:4188});
  const prior=advancePublicSetups(input({current:[short],referencePrice:4200.5,triggerReady:()=>true})).updatedSetups;
  const result=advancePublicSetups(input({prior,current:[short],now:NOW+MINUTE,referencePrice:4188,
    bars:[bar(NOW+MINUTE,4188,{o:4200,h:4201,l:4187})]}));
  assert.equal(result.events[0].kind,"target_observed");assert.equal(result.updatedSetups[0].state,"consumed");
  assert.ok(result.events.every(validNitrousTelegramEvent));
});

test("a missing post-trigger candle cannot conceal a stop before a later target",()=>{
  const result=advancePublicSetups(input({prior:triggered(),now:NOW+2*MINUTE,referencePrice:4212,
    bars:[bar(NOW+2*MINUTE,4212,{o:4205,h:4213,l:4204})]}));
  assert.equal(result.updatedSetups[0].state,"invalidated");
  assert.deepEqual(result.events.map(e=>e.kind),["invalidated"]);
  assert.match(result.updatedSetups[0].transitions.at(-1)!.reason,/path after the trigger is incomplete/);
});

test("identity conflicts invalidate rather than replace a frozen public direction",()=>{
  const first=advancePublicSetups(input());
  const short=plan({side:"sell",invalidation:4204,stop:4207,target:4188});
  const result=advancePublicSetups(input({prior:first.updatedSetups,current:[short]}));
  assert.equal(result.updatedSetups[0].state,"invalidated");assert.equal(result.events[0].side,"buy");
  assert.equal(result.events[0].stop,4194);
});

test("public projection is pure, excludes extra broker/account properties and validates emitted event geometry",()=>{
  const original={...plan(),accountId:"private-account",balance:999999,email:"private@example.test"};
  const before=JSON.stringify(original);
  const result=advancePublicSetups(input({current:[original],referencePrice:4200.5,triggerReady:()=>true}));
  assert.equal(JSON.stringify(original),before);
  assert.doesNotMatch(JSON.stringify(result),/private-account|999999|private@example/);
  assert.ok(result.events.every(validNitrousTelegramEvent));
  const bad=advancePublicSetups(input({current:[plan({target:4199})]}));
  assert.equal(bad.events.length,0);assert.equal(bad.updatedSetups.length,0);
});

test("terminal history is limited to 24 hours and 200 setups while active plans retain priority",()=>{
  const prior=Array.from({length:205},(_,i)=>plan({setupId:`nitrous:old-${i}`,state:"invalidated",stateAt:NOW-i*1000}));
  prior.push(plan({setupId:"nitrous:too-old",state:"expired",stateAt:NOW-24*60*MINUTE-1}));
  const result=advancePublicSetups(input({prior}));
  assert.equal(result.updatedSetups.length,200);
  assert.equal(result.updatedSetups[0].setupId,plan().setupId);
  assert.equal(publicSetupTerminal(result.updatedSetups[0]),false);
  assert.equal(result.updatedSetups.some(s=>s.setupId==="nitrous:too-old"),false);
  assert.equal(result.updatedSetups.some(s=>s.setupId==="nitrous:old-204"),false);
});
