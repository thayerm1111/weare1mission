import assert from "node:assert/strict";
import test from "node:test";
import { NITROUS_AGGRESSIVE_CONFIG, NITROUS_CONFIG } from "../nitrous/config";
import { aggressiveCandidateEligible, aggressiveSetups, mergeNitrousSetups, opportunityId, setupAllowedForAccount } from "../nitrous/logic";
import { advancePublicSetups } from "../nitrous/public-events";
import { noSetupReason } from "../nitrous/waiting-diagnostics";
import type { MarketSnapshot, Regime, Setup, Timeframe } from "../rapid/core/types";
import { formatNitrousTelegramEvent } from "../src/lib/nitrous-telegram";
import { NITROUS_AGGRESSIVE_CONSENT_VERSION, NITROUS_SWEEP_CONSENT_VERSION } from "../src/lib/nitrous/policy";
import { publicNitrousScenario } from "../src/lib/nitrous/scenarios";
import { rankedSetups } from "../src/lib/nitrous/market-story";

const ms = 300_000;
const close = Date.UTC(2026, 10, 26, 0, 0);
const now = close + 1500;
const regimes = { H1: "sideways", M15: "sideways" } as Record<Timeframe, Regime>;

function frozen(family: "compression_breakout" | "range_edge_rejection"): Setup {
  const breakout = family === "compression_breakout";
  const b = breakout ? { o:101.6, h:103.1, l:101.5, c:102.9 } : { o:100.6, h:102.7, l:99.95, c:102.5 };
  const invalidation = b.l;
  return {
    setupId: family, family, side:"buy", timeframe:"M5", visitId:"", strategyVersion:NITROUS_CONFIG.version,
    configVersion:NITROUS_AGGRESSIVE_CONFIG.configVersion, state:"watching", createdAt:now, stateAt:now,
    zoneId:"edge", zoneVersion:1, parentId:"parent", expiresAt:close+ms,
    tolerances:{atrEntry:1.5,breakBuffer:.2,touchTolerance:.25,stopBuffer:.5,rearmDistance:1,spreadAtFreeze:0},
    entryBandLow:b.c-.25,entryBandHigh:b.c+.25,refEntry:b.c,invalidation,stop:invalidation-.5,target:b.c+8,
    stopUsd:b.c-invalidation+.5,targetUsd:8,opposingLevelId:null,opposingPrice:null,conditionsMet:[],conditionsPending:[],
    breakEvidence:null,transitions:[], aggressiveEvidence:{
      rangeLow:100,rangeHigh:breakout ? 102 : 114,rangeStartedAt:close-(breakout?7:25)*ms,rangeEndedAt:close-ms,edgeTime:close-4*ms,
      candleOpenedAt:close-ms,candleClosedAt:close,candleOpen:b.o,candleHigh:b.h,candleLow:b.l,candleClose:b.c,
    },
  };
}

test("additional confirmed patterns route on a ranging hour while legacy profiles retain their own candidates", () => {
  for (const family of ["range_edge_rejection", "compression_breakout"] as const) {
    const s = frozen(family);
    assert.equal(aggressiveCandidateEligible(s, regimes, s.refEntry, now), true);
    assert.equal(aggressiveCandidateEligible(s, { ...regimes, M15:"down" }, s.refEntry, now), false);
    assert.equal(aggressiveCandidateEligible(s, regimes, s.entryBandHigh+.01, now), false);
    assert.equal(aggressiveCandidateEligible(s, regimes, s.refEntry, s.expiresAt), false);
    assert.equal(setupAllowedForAccount(s,"nitrous",NITROUS_SWEEP_CONSENT_VERSION),false);
    assert.equal(setupAllowedForAccount(s,"nitrous",NITROUS_AGGRESSIVE_CONSENT_VERSION),true);
    assert.equal(setupAllowedForAccount(s,"slow_drip",NITROUS_AGGRESSIVE_CONSENT_VERSION),false);
    const plans = aggressiveSetups({scenarios:[s]} as MarketSnapshot);
    const baseline = {...s,setupId:"old",family:"break_retest" as const,configVersion:NITROUS_CONFIG.configVersion};
    const merged = mergeNitrousSetups([baseline],[],[],[...plans,...plans]);
    assert.deepEqual(merged.map(s=>s.setupId),["old",opportunityId(s)]);
    assert.deepEqual(merged.filter(s=>setupAllowedForAccount(s,"nitrous",NITROUS_SWEEP_CONSENT_VERSION)),[baseline]);
    assert.equal(opportunityId(s),opportunityId({...s,createdAt:now+20_000}));
    assert.notEqual(opportunityId(s),opportunityId({...s,aggressiveEvidence:{...s.aggressiveEvidence!,candleClosedAt:close+ms}}));
  }
  assert.match(noSetupReason("sideways","sideways",true,true),/rejection at a range edge or a confirmed breakout/);
  assert.match(noSetupReason("sideways","sideways",true,false),/need a confirmed hourly trend/);
});

test("both public lifecycle plans retain verifiable evidence, alert once on restart and stay out of Slow Drip", () => {
  for (const family of ["range_edge_rejection", "compression_breakout"] as const) {
    const s = frozen(family);
    const input = {prior:[],current:[s],now,referencePrice:s.refEntry,triggerReady:()=>true,
      bars:[{t:close-60_000,o:s.refEntry,h:s.refEntry+.2,l:s.refEntry-.2,c:s.refEntry}]};
    const result = advancePublicSetups(input);
    assert.deepEqual(result.events.map(e=>e.kind),["setup","triggered"]);
    assert.ok(result.events.every(e=>e.profile==="nitrous" && e.family===family));
    assert.match(formatNitrousTelegramEvent(result.events[0]),/(Range edge rejection|Compression breakout)/);
    const restarted = advancePublicSetups({...input,prior:JSON.parse(JSON.stringify(result.updatedSetups)),now:now+10_000});
    assert.deepEqual(restarted.events,[]);
    const safe = publicNitrousScenario({...restarted.updatedSetups[0],aggressiveEvidence:{...s.aggressiveEvidence,secret:"drop"}},now,false);
    assert.ok(safe);
    assert.deepEqual(safe.aggressiveEvidence,s.aggressiveEvidence);
    assert.equal(rankedSetups([safe],s.refEntry,now,true,"nitrous").length,1);
    assert.equal(rankedSetups([safe],s.refEntry,now,true,"slow_drip").length,0);
    assert.equal(publicNitrousScenario({...s,aggressiveEvidence:{...s.aggressiveEvidence,candleClosedAt:now+ms}},now,false),null);
  }
});
