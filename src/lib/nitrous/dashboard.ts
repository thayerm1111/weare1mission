import type { NitrousDiagnostics, NitrousScanCheck, NitrousWatchLevel, NitrousPosition, NitrousCandle, NitrousScenario } from "./types";
const record = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string,unknown> : {};
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const positive = (n: unknown): n is number => finite(n) && n > 0;
const clamp = (n:number) => Math.max(0,Math.min(1,n));
export function selectWatchLevels(input: unknown, reference: number | null, at: number): NitrousWatchLevel[] {
  if (!Array.isArray(input) || !positive(reference) || !finite(at)) return [];
  const distance = (z: NitrousWatchLevel) => Math.max(z.low-reference,reference-z.high,0);
  const zones: NitrousWatchLevel[] = [];
  for (const v of input) {
    const z = record(v);
    if ((z.role !== "support" && z.role !== "resistance") || !positive(z.low) || !positive(z.high) || z.high <= z.low
      || !finite(z.knownAt) || z.knownAt > at || z.invalidatedAt != null) continue;
    const item = {low:z.low,high:z.high,role:z.role,origin:typeof z.origin === "string" ? z.origin.slice(0,8) : "",knownAt:z.knownAt} as NitrousWatchLevel;
    if (distance(item)<=30 && (item.role==="support" ? item.low<=reference : item.high>=reference)) zones.push(item);
  }
  return (["support","resistance"] as const).flatMap(role=>zones.filter(z=>z.role===role).sort((a,b)=>distance(a)-distance(b)||(a.high-a.low)-(b.high-b.low)).slice(0,1));
}
export function countScanChecks(input: unknown): NitrousScanCheck[] {
  if (!Array.isArray(input)) return [];
  const counts = new Map<string,number>();
  for (const item of input) { const code=record(item).code; if(typeof code==="string" && /^[a-z_]{1,50}$/.test(code)) counts.set(code,(counts.get(code)??0)+1); }
  return [...counts].map(([code,count])=>({code,count})).sort((a,b)=>b.count-a.count||a.code.localeCompare(b.code)).slice(0,8);
}
function safeCounts(input: unknown, fallback: unknown): NitrousScanCheck[] {
  if (!Array.isArray(input)) return countScanChecks(fallback);
  return input.flatMap(v=>{const r=record(v);return typeof r.code==="string"&&/^[a-z_]{1,50}$/.test(r.code)&&finite(r.count)&&Number.isInteger(r.count)&&r.count>0?[{code:r.code,count:r.count}]:[];}).slice(0,8);
}
export function scanDiagnostics(payload: Record<string,unknown>, reference:number|null, at:number): NitrousDiagnostics {
  return {watchLevels:selectWatchLevels(payload.watchLevels??payload.levels,reference,at),
    baselineChecks:safeCounts(payload.baselineChecks,payload.rejections),fastChecks:safeCounts(payload.fastChecks,payload.fastRejections),
    sweepChecks:safeCounts(payload.sweepChecks,payload.sweepRejections),
    baselineCandidates:finite(payload.baselineCandidates)&&payload.baselineCandidates>=0?payload.baselineCandidates:null,
    fastCandidates:finite(payload.fastCandidates)&&payload.fastCandidates>=0?payload.fastCandidates:null,
    sweepCandidates:finite(payload.sweepCandidates)&&payload.sweepCandidates>=0?payload.sweepCandidates:null};
}
export function isObservedTrade(p: NitrousPosition, now: number): boolean {
  const at=Date.parse(p.liveObservedAt??"");
  return (p.status==="open"||p.status==="closing")&&positive(p.quantity)&&positive(p.entry)&&finite(now)&&now>0&&finite(at)&&now-at>=-5000&&now-at<=30000;
}
/** The latest reference trigger and a verified broker position are independent observations. */
export function chartProgressStage(marketFresh: boolean, plan: NitrousScenario | null, chartPosition: NitrousPosition | null, accountNow: number) {
  if (chartPosition) return isObservedTrade(chartPosition, accountNow) ? "Filled" : null;
  if (!marketFresh) return null;
  return plan?.state === "triggered" ? "Confirmed" : "Watching";
}

export function insideBothZones(zones: NitrousWatchLevel[], reference: number | null) {
  if (!positive(reference)) return false;
  const contains = (z: NitrousWatchLevel) => z.low <= reference && reference <= z.high;
  return zones.some(z => z.role === "support" && contains(z)) && zones.some(z => z.role === "resistance" && contains(z));
}

/** Reference-only progress; neither a fill prediction nor a P&L calculation. */
export function tradeProgress(p: NitrousPosition, reference: number|null) {
  if (!positive(reference)||!positive(p.entry)||!positive(p.target)) return null;
  const d=p.side==="buy"?1:-1, targetMove=d*(p.target-p.entry);
  const original=positive(p.initialStop)?p.initialStop:p.stop;
  if(!positive(original)||targetMove<=0||d*(p.entry-original)<=0)return null;
  const risk=d*(p.entry-original), span=risk+targetMove;
  return {entry:clamp(risk/span)*100,current:clamp((risk+d*(reference-p.entry))/span)*100,
    stop:positive(p.stop)?clamp((risk+d*(p.stop-p.entry))/span)*100:null,
    towardTarget:d*(reference-p.entry)>=0, moved:d*(reference-p.entry)};
}
export function pricePulse(bars: NitrousCandle[]) {
  const closes=bars.slice(-24).filter(b=>positive(b.c)).map(b=>b.c);
  if(closes.length<2)return null;
  const min=Math.min(...closes),max=Math.max(...closes),span=max-min;
  return {points:closes.map((v,i)=>`${(i*120/(closes.length-1)).toFixed(2)},${(span?32-26*(v-min)/span:19).toFixed(2)}`).join(" "),
    change:(closes.at(-1)!-closes[0])/closes[0]*100};
}

/** Presentation only: an expired or already-crossed reference offer is not a new entry opportunity. */
export function displayableSetup(s: NitrousScenario, reference:number|null, now:number, fresh:boolean):boolean {
  if (!fresh||!positive(reference)||!finite(now)||!finite(s.expiresAt)||s.expiresAt<=now||
    !["watching","approaching","armed","triggered"].includes(s.state)||
    ![s.entryBandLow,s.entryBandHigh,s.refEntry,s.stop,s.target,s.invalidation].every(positive)||s.entryBandLow>s.entryBandHigh) return false;
  return s.side==="buy"? reference>s.invalidation&&reference<s.target :
    s.side==="sell"?reference<s.invalidation&&reference>s.target:false;
}
