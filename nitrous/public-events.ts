import type { Bar, Setup, Transition, VisitState } from "../rapid/core/types";
import type { NitrousTelegramEvent } from "../src/lib/nitrous-telegram";
import { readAggressiveEvidence } from "../src/lib/nitrous/aggressive-evidence";
import { aggressiveEvidenceSane } from "./aggressive-patterns";
import { isAggressiveSetup, isFastSetup } from "./config";

const MINUTE = 60_000;
const REFERENCE_MAX_AGE = 120_000;
const RETAIN_TERMINAL_MS = 24 * 60 * MINUTE;
const MAX_PUBLIC_SETUPS = 200;
const TERMINAL = new Set<VisitState>(["expired", "invalidated", "consumed"]);
const positive = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
export const publicSetupTerminal = (setup: Pick<Setup, "state">): boolean => TERMINAL.has(setup.state);

export type PublicSetupsInput = {
  /** Persist and reload the full previous output, including its terminal tombstones. */
  prior: readonly Setup[];
  current: readonly Setup[];
  /** Structurally confirmed immediate patterns waiting solely on reference price. Cannot create a new offer. */
  priceWaits?: readonly Setup[];
  /** One-minute reference candles, bucket-open epoch milliseconds; order is immaterial. */
  bars: readonly Bar[];
  referencePrice: number | null;
  now: number;
  /** Called with the FROZEN public plan, never the newly recomputed replacement. */
  triggerReady: (setup: Setup) => boolean;
  marketReady?: boolean;
};
export type PublicSetupsResult = { updatedSetups: Setup[]; events: NitrousTelegramEvent[] };

function validPlan(s: Setup): boolean {
  if (!s || !/^[A-Za-z0-9_.:-]{1,180}$/.test(s.setupId)
    || !["trend_pullback", "break_retest", "range_reaction", "sweep_reclaim", "range_edge_rejection", "compression_breakout"].includes(s.family)
    || !["buy", "sell"].includes(s.side) || !s.tolerances
    || ![s.entryBandLow,s.entryBandHigh,s.stop,s.target,s.refEntry,s.invalidation,s.expiresAt,s.createdAt].every(positive)
    || s.entryBandLow > s.entryBandHigh || s.expiresAt <= s.createdAt) return false;
  if ((s.family === "compression_breakout" || s.family === "range_edge_rejection") &&
    (!isAggressiveSetup(s) || !aggressiveEvidenceSane(s) || !readAggressiveEvidence(s.aggressiveEvidence, s.family, s.side, s.createdAt))) return false;
  if (s.family === "sweep_reclaim") {
    const e = s.sweepEvidence;
    if (!e || typeof e.pivotId !== "string" || !e.pivotId || e.pivotId.length > 180
      || ![e.pivotPrice,e.pivotTime,e.pivotKnownAt,e.candleOpenedAt,e.candleClosedAt,e.candleOpen,e.candleHigh,e.candleLow,e.candleClose,e.sweepExtreme,e.confirmationThreshold].every(positive)
      || e.pivotTime > e.pivotKnownAt || e.pivotKnownAt > e.candleOpenedAt || e.candleOpenedAt >= e.candleClosedAt || e.candleClosedAt > s.createdAt
      || e.candleHigh < Math.max(e.candleOpen,e.candleClose,e.candleLow) || e.candleLow > Math.min(e.candleOpen,e.candleClose,e.candleHigh)
      || e.confirmationThreshold !== e.pivotPrice) return false;
    if (s.side === "buy" ? e.pivotKind !== "low" || e.sweepExtreme !== e.candleLow || e.candleLow >= e.pivotPrice || e.candleClose <= e.pivotPrice
      : e.pivotKind !== "high" || e.sweepExtreme !== e.candleHigh || e.candleHigh <= e.pivotPrice || e.candleClose >= e.pivotPrice) return false;
  }
  return s.side === "buy" ? s.stop < s.entryBandLow && s.target > s.entryBandHigh
    : s.stop > s.entryBandHigh && s.target < s.entryBandLow;
}

function sameFields(a: object | null | undefined, b: object | null | undefined): boolean {
  if (a == null || b == null) return a == null && b == null;
  return Object.entries(a).every(([key, value]) => Object.hasOwn(b, key) && b[key as keyof typeof b] === value);
}

/** A recalculation cannot extend a confirmed candle's window or silently change its plan. */
function sameImmediatePlan(a: Setup, b: Setup): boolean {
  return (["setupId", "configVersion", "strategyVersion", "family", "side", "timeframe", "zoneId", "zoneVersion", "parentId",
    "expiresAt", "entryBandLow", "entryBandHigh", "refEntry", "invalidation", "stop", "target", "opposingLevelId", "opposingPrice"] as const)
    .every(key => a[key] === b[key])
    && sameFields(a.sweepEvidence, b.sweepEvidence) && sameFields(a.aggressiveEvidence, b.aggressiveEvidence)
    && sameFields(a.tolerances, b.tolerances);
}

/** Explicit public-field projection; extra account/broker properties are never carried forward. */
function copy(s: Setup): Setup {
  const t = s.tolerances;
  const transitions = (Array.isArray(s.transitions) ? s.transitions : [])
    .filter((v) => v?.evidence?.publicLifecycle === true)
    .slice(-80).map((v) => ({ from:v.from,to:v.to,at:v.at,reason:v.reason,evidence:Object.fromEntries(
      Object.entries(v.evidence).filter(([k]) => ["publicLifecycle","referencePrice","barCloseAt","source","ambiguous","invalidation","stop","target"].includes(k))) }));
  return {
    setupId:s.setupId,visitId:s.visitId,strategyVersion:s.strategyVersion,configVersion:s.configVersion,
    family:s.family,side:s.side,state:s.state,timeframe:s.timeframe,zoneId:s.zoneId,zoneVersion:s.zoneVersion,parentId:s.parentId,
    createdAt:s.createdAt,stateAt:s.stateAt,expiresAt:s.expiresAt,
    tolerances:{atrEntry:t.atrEntry,touchTolerance:t.touchTolerance,breakBuffer:t.breakBuffer,stopBuffer:t.stopBuffer,rearmDistance:t.rearmDistance,spreadAtFreeze:t.spreadAtFreeze},
    entryBandLow:s.entryBandLow,entryBandHigh:s.entryBandHigh,invalidation:s.invalidation,stop:s.stop,
    opposingLevelId:s.opposingLevelId,opposingPrice:s.opposingPrice,refEntry:s.refEntry,target:s.target,targetUsd:s.targetUsd,stopUsd:s.stopUsd,
    transitions,conditionsMet:[...(s.conditionsMet ?? [])],conditionsPending:[...(s.conditionsPending ?? [])],
    breakEvidence:s.breakEvidence ? {closedAt:s.breakEvidence.closedAt,closePrice:s.breakEvidence.closePrice,
      bodyRatio:s.breakEvidence.bodyRatio,closePositionInRange:s.breakEvidence.closePositionInRange,beyondBy:s.breakEvidence.beyondBy} : null,
    ...(isAggressiveSetup(s) ? { aggressiveEvidence: readAggressiveEvidence(s.aggressiveEvidence, s.family, s.side, s.createdAt) } : {}),
    ...(s.family === "sweep_reclaim" && s.sweepEvidence ? {sweepEvidence:{pivotId:s.sweepEvidence.pivotId,pivotKind:s.sweepEvidence.pivotKind,pivotPrice:s.sweepEvidence.pivotPrice,
      pivotTime:s.sweepEvidence.pivotTime,pivotKnownAt:s.sweepEvidence.pivotKnownAt,candleOpenedAt:s.sweepEvidence.candleOpenedAt,candleClosedAt:s.sweepEvidence.candleClosedAt,
      candleOpen:s.sweepEvidence.candleOpen,candleHigh:s.sweepEvidence.candleHigh,candleLow:s.sweepEvidence.candleLow,candleClose:s.sweepEvidence.candleClose,
      sweepExtreme:s.sweepEvidence.sweepExtreme,confirmationThreshold:s.sweepEvidence.confirmationThreshold}} : {}),
  };
}

function closedBars(input: readonly Bar[], now: number): {bars:Bar[];conflictAt:number|null} {
  const buckets = new Map<number, Bar | null>();
  for (const b of input) {
    if (!b || ![b.t,b.o,b.h,b.l,b.c].every(positive) || b.t < 1_000_000_000_000
      || b.t + MINUTE > now || b.h < Math.max(b.o,b.c) || b.l > Math.min(b.o,b.c) || b.l > b.h) continue;
    const previous = buckets.get(b.t);
    if (previous === null) continue;
    if (previous && ["o","h","l","c"].some((k) => previous[k as keyof Bar] !== b[k as keyof Bar])) buckets.set(b.t,null);
    else buckets.set(b.t,{t:b.t,o:b.o,h:b.h,l:b.l,c:b.c});
  }
  const conflicts=[...buckets].filter(([,b])=>b===null).map(([t])=>t);
  return {bars:[...buckets.values()].filter((b): b is Bar => b !== null).sort((a,b) => a.t-b.t),
    conflictAt:conflicts.length?Math.max(...conflicts):null};
}

function move(s: Setup, state: VisitState, at: number, reason: string, evidence: Transition["evidence"] = {}): Setup {
  if (s.state === state) return s;
  return {...s,state,stateAt:at,transitions:[...s.transitions.slice(-79),
    {from:s.state,to:state,at,reason,evidence:{publicLifecycle:true,source:"reference",...evidence}}]};
}

function event(s: Setup, kind: NitrousTelegramEvent["kind"], at: number): NitrousTelegramEvent {
  return {setupId:s.setupId,kind,side:s.side,family:s.family as NitrousTelegramEvent["family"],profile:isAggressiveSetup(s) || isFastSetup(s) || s.family === "sweep_reclaim" ? "nitrous" : "both",
    occurredAt:new Date(at).toISOString(),expiresAt:new Date(s.expiresAt).toISOString(),
    entryLow:s.entryBandLow,entryHigh:s.entryBandHigh,stop:s.stop,target:s.target};
}

function observedAfterTrigger(s: Setup, bars: readonly Bar[]): {setup:Setup;event:NitrousTelegramEvent}|null {
  const triggerAt = s.transitions.findLast((v) => v.to === "triggered")?.at ?? s.stateAt;
  if (!positive(triggerAt)) return null;
  let expectedStart=Math.floor(triggerAt/MINUTE)*MINUTE;
  for (const b of bars) {
    const at = b.t + MINUTE;
    if (at <= triggerAt || at > s.expiresAt) continue;
    if (b.t>expectedStart) {
      return {setup:move(s,"invalidated",at,"The reference candle path after the trigger is incomplete. No outcome is assigned.",{barCloseAt:at,ambiguous:true}),
        event:event(s,"invalidated",at)};
    }
    expectedStart=b.t+MINUTE;
    const targetTouched = s.side === "buy" ? b.h >= s.target : b.l <= s.target;
    const stopTouched = s.side === "buy" ? b.l <= s.stop : b.h >= s.stop;
    // If the bar began before observation, only its later close is known to be post-trigger.
    const target = b.t >= triggerAt ? targetTouched : s.side === "buy" ? b.c >= s.target : b.c <= s.target;
    const stop = b.t >= triggerAt ? stopTouched : s.side === "buy" ? b.c <= s.stop : b.c >= s.stop;
    if (!target && !stop) continue;
    const evidence = {barCloseAt:at,target:s.target,stop:s.stop};
    if (targetTouched && stopTouched) {
      return {setup:move(s,"invalidated",at,"The same reference candle touched stop and target; sequence is unknown. No outcome is assigned.", {...evidence,ambiguous:true}),
        event:event(s,"invalidated",at)};
    }
    return target
      ? {setup:move(s,"consumed",at,"Target observed in reference prices. This does not establish an account fill or realized profit.",evidence),event:event(s,"target_observed",at)}
      : {setup:move(s,"invalidated",at,"Stop observed in reference prices. This does not establish an account fill or realized loss.",evidence),event:event(s,"stop_observed",at)};
  }
  return null;
}

/**
 * Pure public market lifecycle. No broker/account data, dispatch, or realized P&L is involved.
 * Plan prices, identity, tolerances and expiry freeze on their first public appearance.
 * Persist full output to preserve that freeze across worker restarts. Terminal IDs never rearm;
 * create a new economic opportunity ID for a later offer. Output retains terminal states for 24h,
 * caps the full set at 200, and prioritizes active plans over recent terminal history.
 */
export function advancePublicSetups(input: PublicSetupsInput): PublicSetupsResult {
  if (!positive(input.now) || input.now > 8_640_000_000_000_000) throw new Error("invalid_public_market_time");
  const {now} = input;
  const {bars,conflictAt} = closedBars(input.bars,now);
  const latest = bars.at(-1);
  const ready = input.marketReady !== false && positive(input.referencePrice) && Boolean(latest && now-latest.t-MINUTE <= REFERENCE_MAX_AGE
    && (conflictAt===null || conflictAt<latest.t));
  const current = new Map<string,Setup>();
  for (const s of input.current) if (validPlan(s) && s.createdAt <= now && !current.has(s.setupId)) current.set(s.setupId,s);
  const priceWaits = new Map<string,Setup>();
  const price = input.referencePrice;
  if (ready && positive(price)) {
    for (const s of input.priceWaits ?? []) {
      if (!validPlan(s) || !(s.sweepEvidence || s.aggressiveEvidence) || s.createdAt > now || now >= s.expiresAt
        || publicSetupTerminal(s) || (price >= s.entryBandLow && price <= s.entryBandHigh)) continue;
      if (s.side === "buy" ? price <= s.invalidation || price >= s.target : price >= s.invalidation || price <= s.target) continue;
      priceWaits.set(s.setupId, s);
    }
  }
  const prior = new Map<string,Setup>();
  for (const s of input.prior) if (validPlan(s) && !prior.has(s.setupId)) prior.set(s.setupId,copy(s));
  const results:Setup[]=[];
  const events:NitrousTelegramEvent[]=[];
  const ids = [...prior.keys(),...current.keys()].filter((id,i,a) => a.indexOf(id)===i);
  for (const id of ids) {
    const old = prior.get(id);
    const wait = old && priceWaits.get(id);
    const candidate = current.get(id) ?? wait;
    if (old && publicSetupTerminal(old)) {
      if (now-old.stateAt <= RETAIN_TERMINAL_MS) results.push(old);
      continue;
    }
    // An outage cannot create a new offer from stale inputs or remove a previously valid offer.
    if (!old && (!ready || !candidate || publicSetupTerminal(candidate) || candidate.expiresAt <= now)) continue;
    let s = old ?? {...copy(candidate!),state:"watching" as const,stateAt:now,transitions:[]};
    if (ready && s.state === "triggered") {
      const observation = observedAfterTrigger(s,bars);
      if (observation) { results.push(observation.setup);events.push(observation.event);continue; }
    }
    if (now >= s.expiresAt) {
      s=move(s,"expired",s.expiresAt,"The frozen public entry offer expired.");
      results.push(s);events.push(event(s,"expired",s.expiresAt));continue;
    }
    if (!ready) {results.push(s);continue;}
    if (!candidate || publicSetupTerminal(candidate)) {
      s=move(s,"invalidated",now,"The setup no longer meets current market structure requirements.");
      results.push(s);events.push(event(s,"invalidated",now));continue;
    }
    // A changed side/zone under the same ID is an identity conflict, not permission to retarget.
    if (candidate.side!==s.side || candidate.family!==s.family || candidate.parentId!==s.parentId || candidate.zoneVersion!==s.zoneVersion
      || ((s.sweepEvidence || s.aggressiveEvidence) && !sameImmediatePlan(s, candidate))) {
      s=move(s,"invalidated",now,"The public opportunity identity changed; a new setup ID is required.");
      results.push(s);events.push(event(s,"invalidated",now));continue;
    }
    const price=input.referencePrice!;
    if (s.state !== "triggered" && (s.side === "buy" ? price <= s.invalidation : price >= s.invalidation)) {
      s=move(s,"invalidated",now,"A completed reference price crossed the frozen structural invalidation.",{referencePrice:price,invalidation:s.invalidation});
      results.push(s);
      if (old) events.push(event(s,"invalidated",now));
      continue;
    }
    if (!old) events.push(event(s,"setup",now));
    if (s.state !== "triggered") {
      const distance=Math.max(s.entryBandLow-price,price-s.entryBandHigh,0);
      const approach=Math.max(s.entryBandHigh-s.entryBandLow,Math.max(0,s.tolerances.touchTolerance)*2,Math.max(0,s.tolerances.atrEntry)*0.25);
      let trigger=false;
      try {trigger=input.triggerReady(copy(s))===true;} catch { /* Unknown trigger evidence cannot become ready. */ }
      const next:VisitState=distance===0&&trigger ? "triggered" : distance<=approach ? trigger ? "armed" : "approaching" : "watching";
      const reason=next==="triggered" ? "A completed reference trigger and price inside the frozen entry zone were observed. This is not a broker fill."
        : next==="armed" ? "The reference trigger is ready; price must enter the frozen entry zone."
        : next==="approaching" ? "Reference price is near the frozen entry zone; confirmation is still required."
        : "Reference price is outside the approach area.";
      s=move(s,next,now,reason,{referencePrice:price});
      if (next==="triggered") events.push(event(s,"triggered",now));
    }
    results.push(s);
  }
  const active=results.filter((s)=>!publicSetupTerminal(s)).sort((a,b)=>b.createdAt-a.createdAt);
  const terminal=results.filter(publicSetupTerminal).filter((s)=>now-s.stateAt<=RETAIN_TERMINAL_MS).sort((a,b)=>b.stateAt-a.stateAt);
  const updatedSetups=[...active,...terminal].slice(0,MAX_PUBLIC_SETUPS);
  const retained=new Set(updatedSetups.map((s)=>s.setupId));
  return {updatedSetups,events:events.filter((e)=>retained.has(e.setupId))};
}
