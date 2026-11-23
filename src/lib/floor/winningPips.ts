/**
 * Winning Pips — gross POSITIVE pips on verified completed results only.
 *
 * GENX = one graded community callout, not its follower accounts.
 * FLOW = one finalized managed position on the member's selected account.
 * These sources are deliberately never added together: FLOW can copy GENX.
 *
 * Losses add ZERO (not negative) to a gross-winners-only display; zeros,
 * still-open trades, targets not yet hit, and ungraded outcomes also add ZERO.
 * The existing win-streak engine remains responsible for win/run chronology.
 */
import type { FlowWinRow, GenxWinRow, WinStreakAccount } from "./winStreaks";

export type WinningPeriod = "today" | "week" | "month" | "year" | "all";
export const WINNING_PERIODS: { id: WinningPeriod; label: string; note: string }[] = [
  { id: "today", label: "Today", note: "Since local midnight" },
  { id: "week", label: "Week", note: "Since Monday" },
  { id: "month", label: "Month", note: "This calendar month" },
  { id: "year", label: "Year", note: "This calendar year" },
  { id: "all", label: "All time", note: "All retained records" },
];
export type WinningTotal = {
  pips: number | null;
  wins: number | null;
};
export type WinningPipsResult = {
  state: "ready" | "unavailable" | "no_account";
  scope: "genx_calls" | "account";
  asOf: string;
  timeZone: string;
  /** The first retained, dated finalized record available to this display. */
  firstRecordedAt: string | null;
  totals: Record<WinningPeriod, WinningTotal>;
  /** Excluded invalid, inconsistent, missing-date or ungraded source rows, never guessed results. */
  unverified: number | null;
};
export type WinningPipsResponse = {
  asOf: string; timeZone: string;
  account: { id: string; environment: "live" | "demo"; name: string } | null;
  genx: WinningPipsResult;
  flow: WinningPipsResult;
};
type Verified = { key: string; at: number | null; pips: number | null; invalid: boolean };
const number=(v:unknown):number|null=>{
  if(typeof v!=="number" && (typeof v!=="string" || !v.trim()))return null;
  const n=Number(v);
  return Number.isFinite(n)?n:null;
};
const text=(v:unknown):string=>typeof v==="string"?v.trim():typeof v==="number"&&Number.isFinite(v)?String(v):"";
const date=(v:unknown):number|null=>{
  const n=typeof v==="string"&&v.trim()?Date.parse(v):NaN;
  return Number.isFinite(n)?n:null;
};
const round=(n:number)=>Math.round((n+Number.EPSILON)*100)/100;

export function validTimeZone(zone:unknown):string {
  const tz=typeof zone==="string"&&zone.length<85?zone:"UTC";
  try { new Intl.DateTimeFormat("en-US",{timeZone:tz}).format();return tz; }
  catch { return "UTC"; }
}
type ClockParts={year:number;month:number;day:number;hour:number;minute:number;second:number};
function clockParts(when:number,zone:string):ClockParts {
  const formatter=new Intl.DateTimeFormat("en-US",{timeZone:zone,
    year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",
    second:"2-digit",hourCycle:"h23"});
  const values=formatter.formatToParts(new Date(when));
  const part=(name:string)=>Number(values.find(p=>p.type===name)?.value??"0");
  return {year:part("year"),month:part("month"),day:part("day"),
    hour:part("hour"),minute:part("minute"),second:part("second")};
}
/** Find local midnight for an IANA timezone (including DST changes). */
function localMidnight(year:number,month:number,day:number,zone:string):number {
  const wanted=Date.UTC(year,month-1,day),clamp=Date.UTC(year,month-1,day,12);
  let at=clamp;
  for(let i=0;i<5;i++) {
    const p=clockParts(at,zone);
    const shown=Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second);
    const correction=wanted-shown;
    if(Math.abs(correction)<1000)break;
    at+=correction;
  }
  return at;
}
export function winningPeriodStarts(now:number,timeZone:string):Record<WinningPeriod,number> {
  const tz=validTimeZone(timeZone),p=clockParts(now,tz);
  const day=Date.UTC(p.year,p.month-1,p.day);
  const weekDays=(new Date(day).getUTCDay()+6)%7;
  const monday=new Date(day-weekDays*86_400_000);
  return {
    today:localMidnight(p.year,p.month,p.day,tz),
    week:localMidnight(monday.getUTCFullYear(),monday.getUTCMonth()+1,monday.getUTCDate(),tz),
    month:localMidnight(p.year,p.month,1,tz),
    year:localMidnight(p.year,1,1,tz),
    all:Number.NEGATIVE_INFINITY,
  };
}
function blank():Record<WinningPeriod,WinningTotal> {
  return {today:{pips:null,wins:null},week:{pips:null,wins:null},
    month:{pips:null,wins:null},year:{pips:null,wins:null},all:{pips:null,wins:null}};
}
export function unavailableWinningPips(scope:WinningPipsResult["scope"],
  asOf:string,timeZone:string,state:"unavailable"|"no_account"="unavailable"):WinningPipsResult {
  return {state,scope,asOf,timeZone,firstRecordedAt:null,totals:blank(),unverified:null};
}
function fold(rows:Verified[],scope:WinningPipsResult["scope"],asOf:string,
  timeZone:string,complete:boolean,forcedInvalid=false):WinningPipsResult {
  if(!complete||forcedInvalid)return unavailableWinningPips(scope,asOf,timeZone);
  const now=Date.parse(asOf);
  if(!Number.isFinite(now))return unavailableWinningPips(scope,asOf,timeZone);
  const bounds=winningPeriodStarts(now,timeZone);
  const buckets=Object.fromEntries(WINNING_PERIODS.map(p=>[p.id,{wins:0,pips:0}])) as Record<WinningPeriod,{wins:number;pips:number}>;
  const seen=new Map<string,Verified>();
  let unverified=0;
  for(const row of rows) {
    if(!row.key){unverified++;continue;}
    const old=seen.get(row.key);
    if(!old){seen.set(row.key,{...row});continue;}
    // Identical copies count once. A conflicting duplicate never takes the
    // most profitable copy or creates a second entry.
    if(old.at!==row.at||old.pips!==row.pips||old.invalid!==row.invalid) {
      old.invalid=true;old.pips=null;old.at=null;
    }
  }
  let first:number|null=null;
  for(const row of seen.values()) {
    if(row.invalid||row.at==null||row.at>now||row.pips==null){
      unverified++;continue;
    }
    first=first==null?row.at:Math.min(first,row.at);
    if(row.pips<=0)continue;
    for(const p of WINNING_PERIODS) {
      if(row.at>=bounds[p.id]&&row.at<=now){
        buckets[p.id].wins++;
        buckets[p.id].pips+=row.pips;
      }
    }
  }
  return {state:"ready",scope,asOf,timeZone,
    firstRecordedAt:first==null?null:new Date(first).toISOString(),
    totals:Object.fromEntries(WINNING_PERIODS.map(p=>[
      p.id,{pips:round(buckets[p.id].pips),wins:buckets[p.id].wins},
    ])) as Record<WinningPeriod,WinningTotal>,
    unverified};
}

/** Positive realized broker outcomes, AFTER the final close. Partials are pre-weighted in result_pips. */
export function flowWinningPips(rows:FlowWinRow[],account:Pick<WinStreakAccount,"id"|"environment">,
  asOf:string,timeZone:string,complete:boolean,allowLegacyEnvironment=true):WinningPipsResult {
  const verified:Verified[]=[];
  let invalid=false;
  for(const row of rows) {
    if(text(row.account_id)!==account.id)continue;
    const env=text(row.environment).toLowerCase();
    if(env&&env!==account.environment)continue;
    if(text(row.status).toLowerCase()!=="closed")continue;
    if(!env&&!allowLegacyEnvironment){invalid=true;continue;}
    const at=date(row.resolved_at),created=date(row.created_at);
    verified.push({
      key:text(row.position_id)|| (text(row.id)?"row:"+text(row.id):""),
      at, pips:text(row.outcome)==="excluded"?null:number(row.result_pips),
      invalid:at==null||created==null||at<created,
    });
  }
  return fold(verified,"account",asOf,timeZone,complete,invalid);
}

/** One real graded entered GENX callout is one opportunity, not every follower's copied execution. */
export function genxWinningPips(rows:GenxWinRow[],asOf:string,timeZone:string,complete:boolean):WinningPipsResult {
  const verified:Verified[]=[];
  for(const row of rows) {
    if(text(row.state)!=="entered")continue;
    // Non-finalized entries are not in a win or a loss tally yet.
    if(!row.outcome&&row.resolved_at==null)continue;
    const at=date(row.resolved_at),created=date(row.created_at),entered=date(row.enter_sent_at);
    const pips=number(row.result_pips),outcome=text(row.outcome).toLowerCase();
    const coherent=(outcome==="win"&&pips!=null&&pips>=0)||
      (outcome==="loss"&&pips!=null&&pips<=0)||
      ((outcome==="breakeven"||outcome==="be")&&pips===0);
    verified.push({
      key:text(row.dedupe_key)||(text(row.id)?"row:"+text(row.id):""),
      at,pips:coherent?pips:null,
      invalid:at==null||created==null||entered==null||
        at<created||at<entered||!coherent,
    });
  }
  return fold(verified,"genx_calls",asOf,timeZone,complete);
}
