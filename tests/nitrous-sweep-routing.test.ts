import assert from "node:assert/strict";
import test from "node:test";
import type { Bar, Regime, Setup, Timeframe } from "../rapid/core/types";
import { NITROUS_CONFIG, NITROUS_FAST_CONFIG, NITROUS_SWEEP_CONFIG, configFor } from "../nitrous/config";
import { mergeNitrousSetups, opportunityId, setupAllowedForAccount, sweepCandidateEligible, triggerConfirmed } from "../nitrous/logic";
import { NITROUS_CONSENT_VERSION, NITROUS_FAST_CONSENT_VERSION, NITROUS_SWEEP_CONSENT_VERSION } from "../src/lib/nitrous/policy";

const CLOSE = Date.parse("2026-11-25T23:55:00Z");
const MS = 300_000;
function fixture(side: "buy" | "sell" = "buy") {
  const reflect = (value: number) => side === "buy" ? value : 8400 - value;
  const candle: Bar = {t: CLOSE-MS, o: reflect(4200.25), h: reflect(side === "buy" ? 4202 : 4198),
    l: reflect(side === "buy" ? 4198 : 4202), c: reflect(4201.5)};
  const previous: Bar = {t: CLOSE-2*MS,o:4200,h:4201,l:4199,c:reflect(4200.5)};
  const extreme = side === "buy" ? candle.l : candle.h;
  const setup: Setup = {
    setupId: "sweep-test",visitId:"",strategyVersion:NITROUS_SWEEP_CONFIG.version,configVersion:NITROUS_SWEEP_CONFIG.configVersion,
    family:"sweep_reclaim",side,state:"watching",timeframe:"M5",zoneId:"known-level",zoneVersion:1,parentId:"known-parent",
    createdAt:CLOSE+1000,stateAt:CLOSE+1000,expiresAt:CLOSE+MS,
    tolerances:{atrEntry:2,touchTolerance:0.5,breakBuffer:0.2,stopBuffer:0.5,rearmDistance:1,spreadAtFreeze:0},
    entryBandLow:candle.c-0.5,entryBandHigh:candle.c+0.5,refEntry:candle.c,invalidation:extreme,
    stop:reflect(4197.5),target:reflect(4211.5),stopUsd:4,targetUsd:10,opposingLevelId:null,opposingPrice:null,
    transitions:[],conditionsMet:[],conditionsPending:[],breakEvidence:null,
    sweepEvidence:{pivotId:"known-pivot",pivotKind:side === "buy" ? "low":"high",pivotPrice:4200,pivotTime:CLOSE-8*MS,
      pivotKnownAt:CLOSE-5*MS,candleOpenedAt:candle.t,candleClosedAt:CLOSE,candleOpen:candle.o,candleHigh:candle.h,
      candleLow:candle.l,candleClose:candle.c,sweepExtreme:extreme,confirmationThreshold:4200},
  };
  const direction = side === "buy" ? "up":"down";
  const regimes = {M5:direction,M15:"sideways",H1:direction,H4:direction,D1:direction,W1:"unknown"} as Record<Timeframe,Regime>;
  return {setup,bars:[previous,candle],regimes,now:CLOSE+1000};
}

test("confirmed sweeps route in both directions near their completed close, with compatible higher-timeframe structure", () => {
  for (const side of ["buy","sell"] as const) {
    const f = fixture(side);
    assert.equal(triggerConfirmed(f.setup,f.bars,f.now),true);
    assert.equal(sweepCandidateEligible(f.setup,f.regimes,f.setup.refEntry,f.now),true);
    assert.equal(sweepCandidateEligible(f.setup,{...f.regimes,H1:"sideways"},f.setup.refEntry,f.now),false);
    assert.equal(sweepCandidateEligible(f.setup,{...f.regimes,M15:side === "buy"?"down":"up"},f.setup.refEntry,f.now),false);
    assert.equal(sweepCandidateEligible(f.setup,f.regimes,f.setup.entryBandHigh+0.01,f.now),false);
    assert.equal(sweepCandidateEligible(f.setup,f.regimes,f.setup.target,f.now),false);
  }
});

test("forming, expired, missing, revised and hindsight sweep evidence cannot confirm an entry", () => {
  const f = fixture();
  assert.equal(triggerConfirmed(f.setup,f.bars,CLOSE),false);
  assert.equal(triggerConfirmed(f.setup,f.bars,f.setup.expiresAt),false);
  assert.equal(triggerConfirmed({...f.setup,sweepEvidence:null},f.bars,f.now),false);
  assert.equal(triggerConfirmed(f.setup,[f.bars[1]],f.now),false);
  assert.equal(triggerConfirmed(f.setup,[f.bars[0],{...f.bars[1],c:4201.75}],f.now),false);
  assert.equal(triggerConfirmed({...f.setup,sweepEvidence:{...f.setup.sweepEvidence!,pivotKnownAt:CLOSE}},f.bars,f.now),false);
  assert.equal(triggerConfirmed({...f.setup,stop:4198.1},f.bars,f.now),false,"a stop inside the swept wick is not valid evidence");
  assert.equal(triggerConfirmed({...f.setup,expiresAt:CLOSE+2*MS},f.bars,f.now),false,"the original confirmation window cannot be extended");
});

test("a sweep requires its own explicit capability; old consent remains usable for its original strategies", () => {
  const {setup} = fixture();
  for (const consent of [null,NITROUS_CONSENT_VERSION,NITROUS_FAST_CONSENT_VERSION]) {
    assert.equal(setupAllowedForAccount(setup,"nitrous",consent),false);
  }
  assert.equal(setupAllowedForAccount(setup,"nitrous",NITROUS_SWEEP_CONSENT_VERSION),true);
  assert.equal(setupAllowedForAccount(setup,"slow_drip",NITROUS_SWEEP_CONSENT_VERSION),false);
  const old = {...setup,family:"trend_pullback" as const,configVersion:NITROUS_FAST_CONFIG.configVersion};
  assert.equal(setupAllowedForAccount(old,"nitrous",NITROUS_FAST_CONSENT_VERSION),true);
  assert.equal(setupAllowedForAccount(old,"nitrous",NITROUS_SWEEP_CONSENT_VERSION),true);
  assert.equal(setupAllowedForAccount({...setup,configVersion:NITROUS_FAST_CONFIG.configVersion},"nitrous",NITROUS_FAST_CONSENT_VERSION),false);
  const cfg=configFor("nitrous","sweep");
  assert.equal(cfg.configVersion,NITROUS_SWEEP_CONFIG.configVersion);
  assert.equal(cfg.protection.stopCapUsd,12);
  assert.equal(cfg.target.minUsd,6);
  assert.equal(cfg.target.minNetRewardRisk,1.25);
  assert.equal(cfg.risk.sessionLossCeilingPct,configFor("nitrous","fast").risk.sessionLossCeilingPct);
});

test("the confirmed reclaim identity survives later scans and UTC midnight, while a later reclaim gets its own identity", () => {
  const {setup} = fixture();
  const id=opportunityId(setup);
  assert.equal(opportunityId({...setup,createdAt:CLOSE+10*MS}),id);
  assert.notEqual(opportunityId({...setup,sweepEvidence:{...setup.sweepEvidence!,candleClosedAt:CLOSE+MS}}),id);
  assert.notEqual(opportunityId({...setup,configVersion:NITROUS_FAST_CONFIG.configVersion}),id);
});

test("a new sweep does not hide legacy authorization alternatives or duplicate its own event", () => {
  const {setup}=fixture();
  const baseline={...setup,setupId:"baseline",family:"break_retest" as const,configVersion:NITROUS_CONFIG.configVersion};
  const fast={...baseline,setupId:"fast",configVersion:NITROUS_FAST_CONFIG.configVersion};
  const merged=mergeNitrousSetups([baseline],[fast],[setup,{...setup}]);
  assert.deepEqual(merged.map(s=>s.setupId),["baseline","sweep-test"]);
  assert.equal(merged[0].parentId,merged[1].parentId,"the account-level economic identity remains shared");
  assert.deepEqual(merged.filter(s=>setupAllowedForAccount(s,"nitrous",NITROUS_FAST_CONSENT_VERSION)).map(s=>s.setupId),["baseline"]);
});
