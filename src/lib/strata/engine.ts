/**
 * STRATA / Price Action AI — deterministic, closed-candle structure analysis.
 * Three possible market regimes plus an honest transition state.
 *
 * A pivot needs TWO CLOSED candles to its right. A break needs a CLOSED candle
 * through that known pivot; a retest needs a LATER rejecting candle. It never
 * changes the past to make a pattern look good. Every suggested number follows
 * from recorded OHLC and ATR; no LLM generates trade prices.
 */
export type Bar = { t: number; o: number; h: number; l: number; c: number };
export type Regime = "uptrend" | "downtrend" | "range" | "transition";
export type Direction = "buy" | "sell";
export type Stage = "watch" | "breakout" | "retest" | "ready";
export type Pivot = { t: number; index: number; price: number; side: "high" | "low" };
export type Zone = { low: number; high: number; label: string; kind: "support" | "resistance" | "break" | "retest" };
export type Scenario = {
  id: string; type: "break_retest" | "range_fade"; side: Direction; stage: Stage; title: string;
  level: number; entry: number | null; stop: number | null; targets: number[];
  riskReward: number | null; score: number; zone: Zone; reference: boolean;
  trigger: string; invalidation: string; startedAt: number;
  checks: { label: string; done: boolean; detail: string }[];
};
export type Analysis = {
  regime: Regime; regimeLabel: string; structure: string; asOf: number;
  atr: number; momentum: "Rising" | "Falling" | "Balanced"; efficiency: number;
  swings: { highs: Pivot[]; lows: Pivot[]; hh: boolean; hl: boolean; lh: boolean; ll: boolean };
  range: { high: number; low: number; topTouches: number; bottomTouches: number };
  quality: number; status: "WAIT" | "BREAKOUT" | "RETEST" | "READY" | "CLOSED" | "NO_SETUP";
  primary: Scenario | null; secondary: Scenario | null;
  reasons: string[]; warnings: string[];
};
type Input = { m5: Bar[]; m15: Bar[]; h1: Bar[]; h4: Bar[]; now: number; open: boolean };
const ok = (n: number): boolean => Number.isFinite(n);
const n2 = (n: number) => Math.round(n * 100) / 100;
const mean = (xs: readonly number[]) => xs.reduce((s, n) => s + n, 0) / Math.max(1, xs.length);
const abs = (a: number, b: number) => Math.abs(a - b);

/** Never trust candle ordering, duplicate bars, a negative price or inverted wicks. */
export function validBars(input: readonly Bar[] | null | undefined): Bar[] {
  const unique = new Map<number, Bar>();
  for (const bar of Array.isArray(input) ? input : []) {
    if (!bar || ![bar.t,bar.o,bar.h,bar.l,bar.c].every(ok) || bar.t < 1 ||
        bar.o <= 0 || bar.c <= 0 || bar.l <= 0 ||
        bar.h < Math.max(bar.o,bar.c,bar.l) || bar.l > Math.min(bar.o,bar.c,bar.h)) continue;
    unique.set(bar.t, { t:bar.t,o:bar.o,h:bar.h,l:bar.l,c:bar.c });
  }
  return [...unique.values()].sort((a,b) => a.t-b.t);
}
export function completedBars(input: readonly Bar[], intervalMs: number, nowMs: number): Bar[] {
  return validBars(input).filter((b) => b.t + intervalMs <= nowMs - 1500);
}
export function atrOf(bars: readonly Bar[], len = 14): number {
  if (bars.length < len + 1) return 0;
  const range: number[] = [];
  for (let i=bars.length-len;i<bars.length;i++) {
    const b=bars[i], p=bars[i-1];
    range.push(Math.max(b.h-b.l, abs(b.h,p.c), abs(b.l,p.c)));
  }
  return mean(range);
}
/** A swing is NEVER known until the confirming right-hand candles close. */
export function pivotsOf(bars: readonly Bar[], half=2): Pivot[] {
  const list: Pivot[]=[];
  for(let i=half;i<bars.length-half;i++) {
    let high=true,low=true;
    for(let j=1;j<=half;j++) {
      if(bars[i].h<=bars[i-j].h || bars[i].h<=bars[i+j].h) high=false;
      if(bars[i].l>=bars[i-j].l || bars[i].l>=bars[i+j].l) low=false;
    }
    if(high) list.push({t:bars[i].t,index:i,price:bars[i].h,side:"high"});
    if(low) list.push({t:bars[i].t,index:i,price:bars[i].l,side:"low"});
  }
  return list.sort((a,b)=>a.index-b.index);
}
function efficiency(bars:readonly Bar[],span=20):number {
  if(bars.length<=span) return 0;
  const last=bars.slice(-span-1);
  let sum=0;
  for(let i=1;i<last.length;i++) sum+=abs(last[i].c,last[i-1].c);
  return sum?Math.min(1,abs(last[last.length-1].c,last[0].c)/sum):0;
}
function touches(bars:readonly Bar[],level:number,tol:number,which:"high"|"low"):number {
  let count=0,previous=-10;
  for(let i=0;i<bars.length;i++) {
    if(i-previous<4)continue;
    if(Math.abs((which==="high"?bars[i].h:bars[i].l)-level)<=tol){count++;previous=i;}
  }
  return count;
}
function zone(level:number,atr:number,kind:Zone["kind"],label:string):Zone {
  return {low:n2(level-atr*.24),high:n2(level+atr*.24),kind,label};
}
function makeScenario(o: {
  type:Scenario["type"]; side:Direction; stage:Stage; title:string; level:number;
  entry:number|null; stop:number|null; tp1:number|null; tp2:number|null; atr:number;
  startedAt:number; score:number; trigger:string; invalidation:string; checks:Scenario["checks"];
  zoneKind:Zone["kind"];
}):Scenario {
  const risk=o.entry!==null&&o.stop!==null?Math.abs(o.entry-o.stop):0;
  const reward=o.entry!==null&&o.tp1!==null?Math.abs(o.tp1-o.entry):0;
  const valid=o.entry!==null&&o.stop!==null&&o.tp1!==null&&risk>0 &&
    (o.side==="buy"?o.stop<o.entry&&o.tp1>o.entry:o.stop>o.entry&&o.tp1<o.entry);
  const rr=valid?n2(reward/risk):null;
  // Risk geometry matters more than a pretty-looking retest.
  const ready=o.stage==="ready"&&valid&&rr!==null&&rr>=1.45 &&
    risk>=Math.max(.35,o.atr*.28)&&risk<=o.atr*3;
  const stage=o.stage==="ready"&&!ready?"retest":o.stage;
  return {
    id:[o.type,o.side,Math.round(o.level*10),o.startedAt].join(":"),
    type:o.type,side:o.side,stage,title:o.title,startedAt:o.startedAt,
    level:n2(o.level),entry:o.entry===null?null:n2(o.entry),stop:o.stop===null?null:n2(o.stop),
    targets:[o.tp1,o.tp2].filter((n):n is number=>n!==null).map(n2),
    score:Math.round(Math.max(0,Math.min(100,o.score))),riskReward:rr,
    zone:zone(o.level,o.atr,o.zoneKind,o.title),reference:stage!=="ready",
    trigger:o.trigger,invalidation:o.invalidation,checks:o.checks
  };
}
function breakAndRetest(bars:Bar[],side:Direction,atr:number):Scenario {
  const rising=side==="buy", dir=rising?1:-1;
  const piv=pivotsOf(bars), reference=piv.filter((x)=>x.side===(rising?"high":"low"));
  const opposites=piv.filter((x)=>x.side===(rising?"low":"high"));
  const n=bars.length,buffer=Math.max(.18,atr*.13);
  let broken:{index:number;level:number;time:number}|null=null;
  for(let i=n-1;i>=Math.max(22,n-12);i--) {
    const p=reference.filter((x)=>x.index<=i-3).at(-1);
    if(!p)continue;
    const before=(bars[i-1].c-p.price)*dir<=buffer*.4;
    const after=(bars[i].c-p.price)*dir>=buffer;
    if(before&&after&&Math.abs(bars[i].c-bars[i].o)>=atr*.18) {
      broken={index:i,level:p.price,time:bars[i].t}; break;
    }
  }
  const key=broken?.level??reference.at(-1)?.price??(rising
    ?Math.max(...bars.slice(-25,-1).map(x=>x.h)):Math.min(...bars.slice(-25,-1).map(x=>x.l)));
  const swing=opposites.at(-1)?.price??(rising
    ?Math.min(...bars.slice(-25).map(x=>x.l)):Math.max(...bars.slice(-25).map(x=>x.h)));
  let retested=false, confirmed=-1,invalid=false,extreme=swing;
  if(broken)for(let i=broken.index+1;i<n;i++){
    const bar=bars[i];
    if((bar.c-key)*dir< -atr*.46){invalid=true;break;}
    const touch=rising?bar.l<=key+atr*.26:bar.h>=key-atr*.26;
    if(!touch)continue;
    retested=true;extreme=rising?Math.min(extreme,bar.l):Math.max(extreme,bar.h);
    const goodBody=rising?bar.c>bar.o:bar.c<bar.o;
    const closeInDirection=rising?(bar.c-bar.l)/Math.max(.01,bar.h-bar.l):
      (bar.h-bar.c)/Math.max(.01,bar.h-bar.l);
    if(goodBody&&closeInDirection>=.57&&(bar.c-key)*dir>=0) confirmed=i;
  }
  if(invalid){broken=null;retested=false;confirmed=-1;}
  const stage:Stage=broken&&confirmed===n-1?"ready":broken&&retested?"retest":broken?"breakout":"watch";
  const entry=stage==="ready"?bars[n-1].c:broken?key:null;
  const stop=entry===null?null:(rising?Math.min(extreme-atr*.22,entry-atr*.45):
    Math.max(extreme+atr*.22,entry+atr*.45));
  const risk=entry!==null&&stop!==null?Math.abs(entry-stop):0;
  const sideWord=rising?"high":"low",sideOpp=rising?"below":"above";
  return makeScenario({
    type:"break_retest",side,stage,level:key,
    title:rising?"Broken high → support retest":"Broken low → resistance retest",
    entry,stop,tp1:risk?entry!+dir*risk*1.8:null,tp2:risk?entry!+dir*risk*2.8:null,atr,
    startedAt:broken?.time??reference.at(-1)?.t??0,
    score:42+(broken?18:0)+(retested?18:0)+(confirmed===n-1?22:0),
    trigger:broken
      ?"A closed 15m candle must retest "+n2(key)+" and close "+(rising?"bullishly above":"bearishly below")+" the level."
      :"First close "+(rising?"above the swing high ":"below the swing low ")+n2(key)+", then wait for its retest.",
    invalidation:"A 15m close "+sideOpp+" "+n2(key-dir*atr*.46)+" invalidates this break.",
    checks:[
      {label:"Confirmed swing",done:reference.length>=1,detail:"A pivot formed using two closed candles on each side."},
      {label:"Break and close",done:!!broken,detail:"Price closed beyond the swing, not merely wicked through it."},
      {label:"Retest",done:retested,detail:"A later 15m candle returned to the broken level."},
      {label:"Directional reaction",done:confirmed===n-1,detail:"A bullish/bearish acceptance candle CLOSED at the retest."}
    ],zoneKind:broken?"retest":"break"
  });
}
function rangeFade(bars:Bar[],side:Direction,atr:number,high:number,low:number,qualified:boolean):Scenario {
  const buy=side==="buy",level=buy?low:high,last=bars.at(-1)!;
  const atEdge=buy?last.l<=low+atr*.38:last.h>=high-atr*.38;
  const rejected=atEdge&&(buy?last.c>low+atr*.20&&last.c>last.o:last.c<high-atr*.20&&last.c<last.o);
  const stage:Stage=rejected&&qualified?"ready":atEdge?"retest":"watch";
  const stop=buy?low-Math.max(atr*.32,(high-low)*.05):high+Math.max(atr*.32,(high-low)*.05);
  const entry=rejected?last.c:null;
  const mid=(high+low)/2;
  return makeScenario({
    type:"range_fade",side,stage,title:buy?"Range floor · buy rejection":"Range ceiling · sell rejection",
    level,entry,stop:entry===null?null:stop,tp1:entry===null?null:mid,
    tp2:entry===null?null:buy?high-atr*.2:low+atr*.2,
    atr,startedAt:last.t,score:44+(qualified?16:0)+(atEdge?18:0)+(rejected?22:0),
    trigger:"Wait for "+(buy?"bullish rejection at support ":"bearish rejection at resistance ")+n2(level)+" on a CLOSED 15m candle.",
    invalidation:"A 15m close "+(buy?"below ":"above ")+n2(level+(buy?-1:1)*atr*.35)+" invalidates the range fade.",
    checks:[
      {label:"Balanced range",done:qualified,detail:"At least two separated touches on both boundaries."},
      {label:"Range edge",done:atEdge,detail:"Price has reached the relevant outer quarter of the range."},
      {label:"Rejection",done:rejected,detail:"Price closed back inside the range with a reversal candle."},
      {label:"Risk/reward",done:entry!==null&&Math.abs(mid-entry)/Math.abs(entry-stop)>=1.45,detail:"The midpoint must reward enough relative to the invalidation."}
    ],zoneKind:buy?"support":"resistance"
  });
}
export function analyzePriceAction(data:Input):Analysis|null {
  const m5=validBars(data.m5),m15=validBars(data.m15),h1=validBars(data.h1),h4=validBars(data.h4);
  if(m5.length<30||m15.length<80||h1.length<50||h4.length<25)return null;
  const atr=atrOf(m15),h1atr=atrOf(h1);
  if(atr<=0||h1atr<=0)return null;
  const piv=pivotsOf(h1), highs=piv.filter(p=>p.side==="high"),lows=piv.filter(p=>p.side==="low");
  const a=highs.at(-1),b=highs.at(-2),c=lows.at(-1),d=lows.at(-2);
  const delta=Math.max(.2,h1atr*.05);
  const hh=!!a&&!!b&&a.price>b.price+delta,hl=!!c&&!!d&&c.price>d.price+delta;
  const lh=!!a&&!!b&&a.price<b.price-delta,ll=!!c&&!!d&&c.price<d.price-delta;
  const h4closes=h4.map(x=>x.c),h4avg=mean(h4closes.slice(-12)),h4prev=mean(h4closes.slice(-17,-5));
  const h4up=h4closes.at(-1)!>h4avg&&h4avg>=h4prev;
  const h4down=h4closes.at(-1)!<h4avg&&h4avg<=h4prev;
  const eff=efficiency(h1);
  const prior=m15.slice(-43,-3),high=Math.max(...prior.map(x=>x.h)),low=Math.min(...prior.map(x=>x.l));
  const band=Math.max(atr*.38,(high-low)*.04);
  const top=touches(prior,high,band,"high"),bottom=touches(prior,low,band,"low");
  const balanced=top>=2&&bottom>=2&&eff<=.52&&high-low>atr*2.2;
  const uptrend=hh&&hl&&h4up&&eff>=.16;
  const downtrend=lh&&ll&&h4down&&eff>=.16;
  const regime:Regime=uptrend?"uptrend":downtrend?"downtrend":balanced?"range":"transition";
  const recent=m15.slice(-5),change=recent.at(-1)!.c-recent[0].c;
  const momentum=change>atr*.2?"Rising":change< -atr*.2?"Falling":"Balanced";
  let primary:Scenario|null=null,secondary:Scenario|null=null;
  if(regime==="uptrend")primary=breakAndRetest(m15,"buy",atr);
  else if(regime==="downtrend")primary=breakAndRetest(m15,"sell",atr);
  else if(regime==="range"){
    const long=rangeFade(m15,"buy",atr,high,low,balanced),short=rangeFade(m15,"sell",atr,high,low,balanced);
    const close=m15.at(-1)!.c;
    const chooseLong=long.stage==="ready"?true:short.stage==="ready"?false:
      Math.abs(close-low)<=Math.abs(close-high);
    primary=chooseLong?long:short;
    secondary=chooseLong?short:long;
  }
  const warnings:string[]=[];
  if(!data.open)warnings.push("Gold is closed. Levels refer to the last available session; no new entry is active.");
  if(regime==="transition")warnings.push("Structure is mixed. No forced trade bias.");
  if(primary?.stage==="retest")warnings.push("A level touch is not sufficient for entry.");
  if(primary?.stage==="ready"&&!data.open)primary={...primary,stage:"watch",reference:true};
  const reasons=regime==="uptrend"?[
    "Higher highs and higher lows on 1H align with the 4H slope.",
    "A trade requires a close through a known high and a subsequent bullish retest.",
    "The broken high should act as support; a close underneath invalidates it."
  ]:regime==="downtrend"?[
    "Lower highs and lower lows on 1H align with the 4H slope.",
    "A trade requires a close below a known low and a subsequent bearish retest.",
    "The broken low should act as resistance; a close above invalidates it."
  ]:regime==="range"?[
    "Price has revisited both range boundaries without sustained directional progress.",
    "Only look for sell reactions near resistance and buy reactions near support.",
    "An outside close invalidates the range fade; do not blindly trade a wick."
  ]:[
    "Higher-timeframe structure is not a clean uptrend, downtrend or balanced range.",
    "Wait for new confirmed pivots and an orderly break/retest or range edge.",
    "No trade is a valid analysis when structure conflicts."
  ];
  const status:Analysis["status"]=!data.open?"CLOSED":!primary?"NO_SETUP":
    primary.stage==="ready"?"READY":primary.stage==="breakout"?"BREAKOUT":
      primary.stage==="retest"?"RETEST":"WAIT";
  return {
    regime,regimeLabel:regime==="uptrend"?"Trending up":regime==="downtrend"?"Trending down":
      regime==="range"?"Moving sideways":"Transition / mixed",
    structure:regime==="uptrend"?"HH · HL":regime==="downtrend"?"LH · LL":
      regime==="range"?"Range extremes":"Unconfirmed swings",
    asOf:m15.at(-1)!.t,atr:n2(atr),momentum,efficiency:n2(eff),
    swings:{highs:highs.slice(-8),lows:lows.slice(-8),hh,hl,lh,ll},
    range:{high:n2(high),low:n2(low),topTouches:top,bottomTouches:bottom},
    quality:primary?.score??0,status,primary,secondary,reasons,warnings
  };
}
