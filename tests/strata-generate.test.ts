import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generatePossibleEntry } from "../src/lib/strata/generate";
import { atrOf, type Analysis, type Bar, type Scenario } from "../src/lib/strata/engine";

const start = Date.parse("2026-11-20T00:00:00Z");
const m15 = Array.from({ length: 100 }, (_, i): Bar => {
  const c = 3600 + Math.sin(i * .35) * 6 + i * .035;
  return { t: start + i * 900_000, o: c - .18, h: c + 1.1, l: c - 1.1, c };
});
const asOf = m15[m15.length - 1].t;
const now = asOf + 900_000 + 10_000;
const base: Analysis = {
  regime: "transition", regimeLabel: "Transition / mixed", structure: "Unconfirmed swings",
  asOf, atr: 3.2, momentum: "Rising", efficiency: .33,
  swings: { highs: [], lows: [], hh: false, hl: false, lh: false, ll: false },
  range: { high: 3610, low: 3590, topTouches: 2, bottomTouches: 2 },
  quality: 0, status: "NO_SETUP", primary: null, secondary: null,
  reasons: ["Mixed market."], warnings: [],
};
const input = (analysis: Analysis = base) => ({
  analysis, bars: m15, price: 3603, generatedAt: now,
  marketOpen: true, quoteFresh: true, dataStale: false,
});
const isProper = (plan: Scenario) => {
  assert.notEqual(plan.entry, null);
  assert.notEqual(plan.stop, null);
  assert.equal(plan.targets.length, 2);
  const entry = plan.entry!, stop = plan.stop!;
  assert.ok(Number.isFinite(entry) && Number.isFinite(stop));
  if (plan.side === "buy") {
    assert.ok(stop < entry && entry < plan.targets[0] && plan.targets[0] < plan.targets[1]);
  } else {
    assert.ok(stop > entry && entry > plan.targets[0] && plan.targets[0] > plan.targets[1]);
  }
  assert.ok(plan.riskReward !== null && plan.riskReward >= 1.4);
};

test("Mixed structure generates an aggressive WATCH, never a fake ready signal", () => {
  const idea = generatePossibleEntry(input());
  assert.equal(idea.tier, "aggressive");
  assert.equal(idea.label, "Aggressive watchlist");
  assert.ok(idea.scenario);
  assert.equal(idea.scenario?.stage, "watch");
  assert.equal(idea.scenario?.reference, true);
  assert.ok(idea.confirmationNeeded.length > 1);
  isProper(idea.scenario!);
});
test("Uptrend produces a conditional buy break-and-retest plan with real geometry", () => {
  const idea = generatePossibleEntry(input({ ...base, regime: "uptrend", regimeLabel: "Trending up" }));
  assert.equal(idea.tier, "conditional");
  assert.equal(idea.direction, "buy");
  assert.ok(idea.scenario);
  assert.equal(idea.scenario?.type, "break_retest");
  assert.match(idea.scenario!.trigger, /completed 15m close above/);
  isProper(idea.scenario!);
});
test("Downtrend produces a conditional sell break-and-retest plan", () => {
  const idea = generatePossibleEntry(input({ ...base, regime: "downtrend", regimeLabel: "Trending down", momentum: "Falling" }));
  assert.equal(idea.tier, "conditional");
  assert.equal(idea.direction, "sell");
  assert.ok(idea.scenario);
  isProper(idea.scenario!);
});
test("A verified range produces a conditional range-edge reversal", () => {
  const idea = generatePossibleEntry({ ...input({ ...base, regime: "range", regimeLabel: "Moving sideways" }), price: 3591.6 });
  assert.equal(idea.tier, "conditional");
  assert.equal(idea.direction, "buy");
  assert.ok(idea.scenario);
  assert.equal(idea.scenario?.type, "range_fade");
  assert.match(idea.scenario!.trigger, /bullish rejection/);
  isProper(idea.scenario!);
});
test("Only qualified original engine signals can show Ready, never guessed price levels", () => {
  const trade: Scenario = {
    id:"original:ready",type:"break_retest",side:"buy",stage:"ready",title:"Confirmed break",
    level:3600,entry:3602,stop:3598,targets:[3609.2,3616],riskReward:1.8,score:80,
    zone:{low:3599.5,high:3600.5,kind:"retest",label:"Retest"},
    reference:false,trigger:"Confirmed",invalidation:"Below 3598",startedAt:asOf,
    checks:[{label:"Retest",done:true,detail:"Confirmed"}],
  };
  const state = { ...base, regime:"uptrend" as const, status:"READY" as const, primary:trade };
  const ready = generatePossibleEntry({ ...input(state), price: 3602 });
  assert.equal(ready.tier, "ready");
  assert.equal(ready.scenario?.id, trade.id);
  const noFreshTick = generatePossibleEntry({ ...input(state), price:3602, quoteFresh:false });
  assert.notEqual(noFreshTick.tier, "ready");
});
test("Market closed cannot create a ready setup", () => {
  const idea = generatePossibleEntry({ ...input({ ...base,regime:"uptrend" }), marketOpen:false });
  assert.notEqual(idea.tier, "ready");
  assert.match(idea.reasons.join(" "), /closed/i);
});
test("Stale or missing candles result in no high-quality setup, never invented entries", () => {
  const stale = generatePossibleEntry({ ...input(), dataStale:true });
  assert.equal(stale.tier,"none"); assert.equal(stale.scenario,null);
  const missing = generatePossibleEntry({ ...input(), bars: [] });
  assert.equal(missing.tier,"none"); assert.equal(missing.scenario,null);
});

function sustainedTrend(side: "buy"|"sell"): Bar[] {
  const direction=side==="buy"?1:-1;
  return Array.from({length:100},(_,i) => {
    const c=i<35?3600+Math.sin(i*Math.PI/4)*2:3600+direction*(i-35)*.6;
    return {t:start+i*900_000,o:c-.18,h:c+.55,l:c-.55,c};
  });
}
test("a sustained trend can use a current observed extreme after its last confirmed pivot is left far behind", () => {
  for (const side of ["buy","sell"] as const) {
    const bars=sustainedTrend(side);
    const analysis: Analysis={...base,regime:side==="buy"?"uptrend":"downtrend",
      momentum:side==="buy"?"Rising":"Falling",atr:atrOf(bars)};
    const original=structuredClone(analysis);
    const idea=generatePossibleEntry({...input(analysis),bars,price:bars.at(-1)!.c});
    assert.equal(idea.tier,"conditional");
    assert.equal(idea.direction,side);
    assert.ok(idea.scenario);
    assert.equal(idea.scenario.stage,"watch");
    assert.equal(idea.scenario.reference,true);
    assert.match(idea.reasons.join(" "),/range extreme/i);
    isProper(idea.scenario);
    assert.deepEqual(analysis,original,"manual generation does not alter automatic readiness");
  }
});

test("a closed break outside a recorded range cannot generate an already invalidated range fade", () => {
  const bars=m15.map(b => ({...b}));
  bars[bars.length-1]={...bars.at(-1)!,o:3611,h:3612.5,l:3610.5,c:3612};
  const idea=generatePossibleEntry({...input({...base,regime:"range"}),bars,price:3612});
  assert.equal(idea.tier,"none");
  assert.equal(idea.scenario,null);
  assert.match(idea.reasons.join(" "),/outside|broken/i);
});

test("a live quote beyond range invalidation cannot manufacture a fade at an already crossed stop", () => {
  const idea=generatePossibleEntry({...input({...base,regime:"range"}),price:3613});
  assert.equal(idea.tier,"none");
  assert.equal(idea.scenario,null);
  assert.match(idea.reasons.join(" "),/quote.*invalidation/i);
});

test("generation excludes forming candles and requires the same completed snapshot as the analysis", () => {
  const bars=sustainedTrend("buy");
  const analysis: Analysis={...base,regime:"uptrend",momentum:"Rising",atr:atrOf(bars)};
  const request={...input(analysis),bars,price:bars.at(-1)!.c};
  const plan=generatePossibleEntry(request);
  assert.equal(plan.tier,"conditional");
  const forming={t:asOf+900_000,o:3700,h:5000,l:3500,c:4000};
  const future={t:asOf+1_800_000,o:4000,h:6000,l:3500,c:5000};
  assert.deepEqual(generatePossibleEntry({...request,bars:[...bars,forming,future]}),plan);
  const missingLast=generatePossibleEntry({...request,bars:bars.slice(0,-1)});
  assert.equal(missingLast.tier,"none");
  assert.match(missingLast.reasons.join(" "),/does not match/);
  const futureAnalysis=generatePossibleEntry({...request,analysis:{...analysis,asOf:forming.t},bars:[...bars,forming]});
  assert.equal(futureAnalysis.tier,"none");
});

test("an unusably distant quote still returns no plan instead of forcing reference prices", () => {
  const bars=sustainedTrend("buy");
  const analysis: Analysis={...base,regime:"uptrend",momentum:"Rising",atr:atrOf(bars)};
  const idea=generatePossibleEntry({...input(analysis),bars,price:bars.at(-1)!.c+analysis.atr*20});
  assert.equal(idea.tier,"none");
  assert.equal(idea.scenario,null);
});
test("On-demand generator is isolated from automatic paper and broker trade paths", () => {
  const route = readFileSync("src/app/api/strata/generate/route.ts","utf8");
  assert.match(route,/getStrataState/);
  assert.match(route,/generatePossibleEntry/);
  assert.doesNotMatch(route,/placeOnActiveAccounts|placeMarketOrder|createOrder|strata_paper_positions/);
  const worker = readFileSync("worker/strata.ts","utf8");
  assert.doesNotMatch(worker,/generatePossibleEntry|api\/strata\/generate/);
});
