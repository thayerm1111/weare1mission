import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  validTimeZone, winningPeriodStarts, flowWinningPips, genxWinningPips,
  type WinningPeriod,
} from "../src/lib/floor/winningPips";
import type { FlowWinRow, GenxWinRow } from "../src/lib/floor/winStreaks";

const NOW="2026-11-23T17:39:00.000Z";
const AT=Date.parse(NOW), ZONE="America/Chicago";
const acct={id:"my-account",environment:"live" as const};
const flow=(id:string,pips:unknown,closed:string,extra:Partial<FlowWinRow>={}):FlowWinRow=>({
  id,position_id:id,account_id:acct.id,environment:"live",
  status:"closed",outcome:Number(pips)<0?"stop":"target",result_pips:pips,
  created_at:new Date(Date.parse(closed)-60_000).toISOString(),resolved_at:closed,...extra
});
const genx=(id:string,pips:unknown,closed:string,extra:Partial<GenxWinRow>={}):GenxWinRow=>({
  id,dedupe_key:id,mode:"quick",side:"buy",state:"entered",
  outcome:Number(pips)<0?"loss":"win",result_pips:pips,
  created_at:new Date(Date.parse(closed)-60_000).toISOString(),
  enter_sent_at:new Date(Date.parse(closed)-50_000).toISOString(),
  resolved_at:closed,...extra
});
const totals=(records:FlowWinRow[],period:WinningPeriod)=>flowWinningPips(records,acct,NOW,ZONE,true).totals[period];
const mon="2026-11-23T06:10:00.000Z"; // Monday 00:10 Chicago
const sunday="2026-11-23T05:50:00.000Z"; // Sunday 23:50 Chicago
const earlierMonth="2026-11-15T12:00:00.000Z";
const previousMonth="2026-10-31T21:00:00.000Z";
const previousYear="2025-12-23T17:00:00.000Z";

test("periods are calendar days, Monday weeks, calendar months and years in member time zone",()=>{
  const starts=winningPeriodStarts(AT,ZONE);
  assert.equal(starts.today,Date.parse("2026-11-23T06:00:00Z"));
  assert.equal(starts.week,starts.today,"Monday is the first day of a week");
  assert.equal(starts.month,Date.parse("2026-11-01T05:00:00Z"),"DST before November fallback");
  assert.equal(starts.year,Date.parse("2026-01-01T06:00:00Z"));
  assert.equal(starts.all,Number.NEGATIVE_INFINITY);
  assert.equal(validTimeZone("not/a/timezone"),"UTC");
  assert.equal(validTimeZone("America/Chicago"),ZONE);
});

test("spring and autumn DST changes do not change the actual local midnight",()=>{
  const spring=winningPeriodStarts(Date.parse("2026-03-08T18:00:00Z"),ZONE);
  assert.equal(spring.today,Date.parse("2026-03-08T06:00:00Z"));
  const fall=winningPeriodStarts(Date.parse("2026-11-01T19:00:00Z"),ZONE);
  assert.equal(fall.today,Date.parse("2026-11-01T05:00:00Z"));
});

test("wins only: a +10 and +100 add 110 winning pips; losses/flat add zero",()=>{
  const r=[
    flow("small",10,mon),flow("loss",-45,mon),flow("big",100,mon),
    flow("flat",0,mon,{outcome:"breakeven"}),
  ];
  for(const period of ["today","week","month","year","all"] as WinningPeriod[]) {
    assert.deepEqual(totals(r,period),{wins:2,pips:110});
  }
  assert.deepEqual(totals([flow("loss",-10,mon)],"today"),{wins:0,pips:0});
});

test("weekly, monthly, yearly and all-time totals use the verified CLOSE, not entry date",()=>{
  const r=[flow("monday",10,mon),flow("sunday",20,sunday),
    flow("month",30,earlierMonth),flow("previous-month",40,previousMonth),
    flow("last-year",50,previousYear)];
  assert.deepEqual(totals(r,"today"),{pips:10,wins:1});
  assert.deepEqual(totals(r,"week"),{pips:10,wins:1});
  assert.deepEqual(totals(r,"month"),{pips:60,wins:3});
  assert.deepEqual(totals(r,"year"),{pips:100,wins:4});
  assert.deepEqual(totals(r,"all"),{pips:150,wins:5});
  const crosses=flow("cross-midnight",35,mon,{
    created_at:new Date(Date.parse(mon)-90*60_000).toISOString()
  });
  assert.deepEqual(totals([crosses],"today"),{pips:35,wins:1});
});

test("FLOW only sums closed, nonexcluded, dated positions for the exact account/environment",()=>{
  const rows=[
    flow("partial",15.25,mon,{outcome:"breakeven"}),
    flow("open",200,mon,{status:"open"}),
    flow("excluded",300,mon,{outcome:"excluded"}),
    flow("no-result",null,mon),
    flow("other-account",1000,mon,{account_id:"other"}),
    flow("demo-twin",2000,mon,{environment:"demo"}),
    flow("invalid-close",4000,mon,{resolved_at:null}),
  ];
  const result=flowWinningPips(rows,acct,NOW,ZONE,true);
  assert.deepEqual(result.totals.today,{pips:15.25,wins:1});
  assert.ok(result.unverified!>=3);
  assert.equal(flowWinningPips(rows,acct,NOW,ZONE,false).totals.all.pips,null);
  assert.equal(flowWinningPips(rows,acct,NOW,ZONE,true,false).totals.all.pips,15.25);
  const legacy=flow("legacy",200,mon,{environment:null});
  assert.equal(flowWinningPips([legacy],acct,NOW,ZONE,true,false).state,"unavailable");
});

test("duplicate records for a single position never inflate, and conflicts are not cherry-picked",()=>{
  const a=flow("same",12,mon);
  assert.deepEqual(totals([a,{...a,id:"another-db-row"}],"today"),{pips:12,wins:1});
  assert.deepEqual(totals([a,flow("same",34,mon)],"today"),{pips:0,wins:0});
});

test("GENX counts entered, resolved and coherently graded community callouts ONCE",()=>{
  const r=[
    genx("a",10,mon),genx("b",100,mon),
    genx("loss",-20,mon),
    genx("expired",null,mon,{outcome:"expired"}),
    genx("forming",400,mon,{state:"forming",enter_sent_at:null}),
    genx("wrong",500,mon,{outcome:"loss"}),
    genx("untimed",600,mon,{enter_sent_at:null}),
    genx("ongoing",null,mon,{outcome:null,resolved_at:null}),
    {...genx("a",10,mon),id:"duplicated-db-row"},
  ];
  const data=genxWinningPips(r,NOW,ZONE,true);
  assert.deepEqual(data.totals.today,{pips:110,wins:2});
  assert.ok(data.unverified!>=3);
  assert.equal(genxWinningPips(r,NOW,ZONE,false).totals.today.pips,null);
});

test("partial pages, missing account and future-dated results cannot be marketed as verified",()=>{
  const future="2026-11-24T07:00:00Z";
  const outcome=flowWinningPips([flow("tomorrow",999,future)],acct,NOW,ZONE,true);
  assert.deepEqual(outcome.totals.all,{pips:0,wins:0});
  assert.equal(outcome.unverified,1);
  assert.equal(flowWinningPips([],acct,NOW,ZONE,false).state,"unavailable");
});

test("winning-pips API has no broker orders, community/member scope is isolated and the panel retains the streak",()=>{
  const route=readFileSync("src/app/api/floor/winning-pips/route.ts","utf8");
  const panel=readFileSync("src/components/om/floor/WinningPipsPanel.tsx","utf8");
  const floor=readFileSync("src/components/om/floor/Floor.tsx","utf8");
  assert.match(route,/client\.auth\.getUser\(\)/);
  assert.match(route,/\.eq\("user_id",userId\)\.eq\("account_id",account\.id\)/);
  assert.match(route,/genxCache/);
  assert.doesNotMatch(route,/placeMarketOrder|placeOnActiveAccounts|createOrder|fetch\("https:\/\/api\.tradelocker/);
  assert.match(panel,/hideAccountPips/);
  assert.match(panel,/WINNING_PERIODS/);
  assert.match(floor,/<WinStreaks/);
  assert.match(floor,/<WinningPipsPanel/);
  assert.ok(floor.indexOf("<WinningPipsPanel")<floor.indexOf("<WinStreaks"));
  assert.doesNotMatch(panel,/data\.flow\.totals.*\+.*data\.genx\.totals/);
});
