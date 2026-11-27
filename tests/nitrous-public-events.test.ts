import test from "node:test";
import assert from "node:assert/strict";
import type { Bar, Setup } from "../rapid/core/types";
import { advancePublicSetups, publicSetupTerminal, type PublicSetupsInput } from "../nitrous/public-events";
import { validNitrousTelegramEvent } from "../src/lib/nitrous-telegram";
import { NITROUS_CONFIG, NITROUS_FAST_CONFIG, NITROUS_SWEEP_CONFIG, configFor } from "../nitrous/config";
import { referenceAllowsEntry, fastCandidateEligible, setupAllowedForAccount, mergeNitrousSetups, triggerConfirmed } from "../nitrous/logic";
import { accountVisitId, baselineCandidateEligible } from "../nitrous/candidate-selection";
import { buildSnapshot } from "../rapid/engine/snapshot";
import { NITROUS_CONSENT_VERSION, NITROUS_FAST_CONSENT_VERSION } from "../src/lib/nitrous/policy";

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

test("fast scan allows M15 consolidation but requires hourly direction, nearby structure and closed break evidence", () => {
  const s = plan({ configVersion: NITROUS_FAST_CONFIG.configVersion, family: "break_retest",
    breakEvidence: { closedAt: NOW-60_000, closePrice: 4201, bodyRatio:.55, closePositionInRange:.8, beyondBy:.3 } });
  const regimes = { W1:"unknown", D1:"up", H4:"up", H1:"up", M15:"sideways", M5:"sideways" } as const;
  assert.equal(fastCandidateEligible(s, regimes, null, 4205, NOW), true);
  assert.equal(fastCandidateEligible(s, {...regimes,H1:"down"}, null, 4205, NOW), false);
  assert.equal(fastCandidateEligible(s, {...regimes,M15:"down"}, null, 4205, NOW), false);
  assert.equal(fastCandidateEligible(s, regimes, null, 4250, NOW), false);
  assert.equal(fastCandidateEligible({...s,breakEvidence:null}, regimes, null, 4205, NOW), false);
  assert.equal(fastCandidateEligible({...s,family:"range_reaction"}, regimes, null, 4205, NOW), false);
});
test("fast plans are Nitrous-only and require consent without changing baseline risk rules", () => {
  const strict = plan({configVersion:NITROUS_CONFIG.configVersion});
  const fast = plan({setupId:"nitrous:fast", configVersion:NITROUS_FAST_CONFIG.configVersion});
  assert.equal(setupAllowedForAccount(fast,"slow_drip",NITROUS_FAST_CONSENT_VERSION), false);
  assert.equal(setupAllowedForAccount(fast,"nitrous",NITROUS_CONSENT_VERSION), false);
  assert.equal(setupAllowedForAccount(fast,"nitrous",NITROUS_FAST_CONSENT_VERSION), true);
  assert.equal(setupAllowedForAccount(strict,"slow_drip",NITROUS_CONSENT_VERSION), true);
  assert.equal(setupAllowedForAccount(strict,"nitrous",NITROUS_CONSENT_VERSION), true);
  assert.deepEqual(mergeNitrousSetups([strict],[fast]), [strict]);
  assert.equal(advancePublicSetups(input({current:[fast]})).events[0].profile, "nitrous");
  assert.equal(advancePublicSetups(input({current:[strict]})).events[0].profile, "both");
  assert.equal(configFor("slow_drip",true).protection.stopCapUsd,10);
  assert.equal(configFor("nitrous",true).protection.stopCapUsd,12);
  assert.equal(configFor("nitrous",true).risk.sessionLossCeilingPct,15);
  assert.equal(configFor("nitrous",true).target.minNetRewardRisk,NITROUS_CONFIG.target.minNetRewardRisk);
});
test("a higher-ranked short cannot suppress an authorized long in aligned hourly and 15-minute structure", () => {
  const rising = (ms: number) => Array.from({ length: 80 }, (_, i) => {
    const c = 4200 + i * .2 + 4 * Math.sin(i * Math.PI / 4);
    return { t: NOW - (80 - i) * ms, l: c - .5, h: c + .5, o: c, c };
  });
  const buy = plan({setupId:"eligible-buy",configVersion:NITROUS_CONFIG.configVersion});
  const sell = plan({setupId:"high-ranked-sell",side:"sell",timeframe:"M15",configVersion:NITROUS_CONFIG.configVersion});
  const input = {asOf:NOW,cfg:NITROUS_CONFIG,tick:.01,contractSize:null,minStopDistance:null,m1:[],quote:null,
    higher:{H1:rising(60*MINUTE),M15:rising(15*MINUTE)},candidateBuilder:()=>({setups:[buy,sell],rejections:[]})};
  const generic = buildSnapshot(input);
  assert.equal(generic.regimes.H1,"up");
  assert.equal(generic.regimes.M15,"up");
  assert.deepEqual(generic.scenarios.map(s=>s.setupId),["high-ranked-sell"]);
  assert.deepEqual(buildSnapshot({...input,candidateFilter:baselineCandidateEligible}).scenarios.map(s=>s.setupId),["eligible-buy"]);
});
test("one level can retain a distinct confirmed fast entry while the baseline entry still waits", () => {
  const strict = plan({configVersion:NITROUS_CONFIG.configVersion});
  const fast = plan({setupId:"nitrous:fast",configVersion:NITROUS_FAST_CONFIG.configVersion,entryBandHigh:4202});
  const candle = { t: NOW-300_000, o:4201.1, l:4201.05, h:4202, c:4201.9 };
  assert.equal(triggerConfirmed(strict,[candle],NOW),false);
  assert.equal(triggerConfirmed(fast,[candle],NOW),true);
  assert.deepEqual(mergeNitrousSetups([strict],[fast]),[strict,fast]);
  assert.equal(accountVisitId("one-account",strict,NOW),"one-account|swing-support|1|buy|2026-11-25");
  assert.equal(accountVisitId("one-account",strict,NOW),accountVisitId("one-account",fast,NOW));
  assert.deepEqual(mergeNitrousSetups([strict],[{...fast,zoneVersion:strict.zoneVersion+1}]),[strict],
    "conflicting zone versions cannot reserve the same economic level under two different keys");
  assert.equal(setupAllowedForAccount(fast,"nitrous",NITROUS_CONSENT_VERSION),false);
  assert.equal(setupAllowedForAccount(fast,"nitrous",NITROUS_FAST_CONSENT_VERSION),true);
});
test("range reaction requires a completed rejection candle", () => {
  const s=plan({family:"range_reaction",configVersion:NITROUS_FAST_CONFIG.configVersion});
  const bars=[{t:NOW-300_000,o:4200.1,l:4199.8,h:4202,c:4201.8}];
  assert.equal(triggerConfirmed(s,bars,NOW),true);
  assert.equal(triggerConfirmed({...s,configVersion:NITROUS_CONFIG.configVersion},bars,NOW),false);
  assert.equal(triggerConfirmed(s,[{...bars[0],t:NOW}],NOW),false);
});

const sweepPlan = (over: Partial<Setup> = {}): Setup => plan({ family: "sweep_reclaim", configVersion: NITROUS_SWEEP_CONFIG.configVersion,
  expiresAt: NOW + 4*MINUTE, sweepEvidence: {
    pivotId: "confirmed-low", pivotKind: "low", pivotPrice: 4200, pivotTime: NOW-20*MINUTE, pivotKnownAt: NOW-10*MINUTE,
    candleOpenedAt: NOW-6*MINUTE, candleClosedAt: NOW-MINUTE, candleOpen: 4198.5, candleHigh: 4200.7, candleLow: 4197, candleClose: 4200.5,
    sweepExtreme: 4197, confirmationThreshold: 4200,
  }, ...over });

test("sweep lifecycle freezes and copies exact public reclaim evidence across reads and reloads", () => {
  const original = sweepPlan();
  const withPrivateField = { ...original, sweepEvidence: { ...original.sweepEvidence!, brokerAccountId: "private-sweep-account" } };
  const first = advancePublicSetups(input({ current: [withPrivateField] }));
  assert.equal(first.updatedSetups.length, 1);
  assert.deepEqual(first.updatedSetups[0].sweepEvidence, original.sweepEvidence);
  assert.notEqual(first.updatedSetups[0].sweepEvidence, original.sweepEvidence);
  assert.doesNotMatch(JSON.stringify(first), /private-sweep-account|brokerAccountId/);
  assert.equal(first.events[0].profile, "nitrous");
  assert.ok(first.events.every(validNitrousTelegramEvent));
  const changed = sweepPlan({ sweepEvidence: { ...original.sweepEvidence!, candleClose: 4200.6 } });
  let observedClose = 0;
  const conflict = advancePublicSetups(input({ prior: first.updatedSetups, current: [changed], referencePrice: 4200.5, triggerReady: () => true }));
  assert.equal(conflict.updatedSetups[0].state, "invalidated", "a revised confirmation candle cannot trigger the earlier frozen offer");
  const next = advancePublicSetups(input({ prior: JSON.parse(JSON.stringify(first.updatedSetups)), current: [withPrivateField], referencePrice: 4200.5,
    triggerReady: frozen => { observedClose = frozen.sweepEvidence!.candleClose; frozen.sweepEvidence!.candleClose = 9999; return true; } }));
  assert.equal(observedClose, 4200.5);
  assert.equal(next.updatedSetups[0].state, "triggered");
  assert.deepEqual(next.updatedSetups[0].sweepEvidence, original.sweepEvidence);
  assert.equal(next.events[0].family, "sweep_reclaim");
  assert.equal(original.sweepEvidence!.candleClose, 4200.5);
});

test("a frozen sweep survives a temporary price excursion, re-enters only its original band, and expires on schedule", () => {
  const s = sweepPlan();
  const reference = s.entryBandHigh + 1;
  const check = (over: Partial<PublicSetupsInput>) => advancePublicSetups(input({ current: [], priceWaits: [s],
    referencePrice: reference, triggerReady: () => true, ...over }));
  assert.deepEqual(check({}).updatedSetups, [], "waiting evidence alone never publishes a new setup");
  const first = check({ current: [s], referencePrice: s.refEntry });
  assert.equal(first.updatedSetups[0].state, "triggered");
  const outside = check({ prior: first.updatedSetups, now: NOW+1000 });
  assert.deepEqual(outside.events, []);
  assert.equal(outside.updatedSetups[0].state, "triggered");
  assert.equal(outside.updatedSetups[0].expiresAt, s.expiresAt);
  assert.equal(referenceAllowsEntry(s, reference), false);
  const back = check({ prior: JSON.parse(JSON.stringify(outside.updatedSetups)), current: [s], referencePrice: s.refEntry, now: NOW+2000 });
  assert.deepEqual(back.events, [], "a return to the band does not send another setup or trigger alert");
  assert.equal(referenceAllowsEntry(back.updatedSetups[0], s.refEntry), true);
  assert.equal(check({ prior: outside.updatedSetups, priceWaits: [] }).updatedSetups[0].state, "invalidated");
  assert.equal(check({ prior: outside.updatedSetups, priceWaits: [{ ...s, target: s.target+1 }] }).updatedSetups[0].state, "invalidated");
  assert.equal(check({ prior: outside.updatedSetups, priceWaits: [{ ...s, zoneVersion: 2 }] }).updatedSetups[0].state, "invalidated");
  assert.equal(check({ prior: outside.updatedSetups, referencePrice: s.invalidation }).updatedSetups[0].state, "invalidated");
  assert.equal(check({ prior: outside.updatedSetups, now: s.expiresAt }).updatedSetups[0].state, "expired");
  const hit = check({ prior: outside.updatedSetups, now: NOW+MINUTE, bars: [bar(NOW+MINUTE, s.target)] });
  assert.equal(hit.events[0].kind, "target_observed", "reference outcomes remain observable independently of entry eligibility");
  assert.equal(check({ prior: hit.updatedSetups, current: [s], referencePrice: s.refEntry }).updatedSetups[0].state, "consumed");
});

test("sweep lifecycle rejects missing, future or unreclaimed public evidence", () => {
  const original = sweepPlan();
  for (const invalid of [
    sweepPlan({ sweepEvidence: null }),
    sweepPlan({ sweepEvidence: { ...original.sweepEvidence!, candleClosedAt: NOW+MINUTE } }),
    sweepPlan({ sweepEvidence: { ...original.sweepEvidence!, pivotKnownAt: NOW-5*MINUTE } }),
    sweepPlan({ sweepEvidence: { ...original.sweepEvidence!, candleClose: 4199 } }),
  ]) {
    const result = advancePublicSetups(input({ current: [invalid], referencePrice: 4200.5, triggerReady: () => true }));
    assert.equal(result.updatedSetups.length, 0);
    assert.equal(result.events.length, 0);
  }
});
