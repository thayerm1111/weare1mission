import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { allRows, type Paged } from "@/lib/floor/rows";
import { accountsFrom, pickAccount, type AccountRowIn, type ConnRowIn } from "@/lib/floor/overview";
import { flowWinningPips, genxWinningPips, unavailableWinningPips, validTimeZone,
  type WinningPipsResponse, type WinningPipsResult } from "@/lib/floor/winningPips";
import type { FlowWinRow, GenxWinRow } from "@/lib/floor/winStreaks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;
type Admin = NonNullable<ReturnType<typeof createAdminClient>>;
type Rows<T> = { rows: T[]; complete: boolean };
const READ_WAIT_MS = 20_000;
const COMMUNITY_TTL_MS = 60_000;
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{
  status,headers:{"content-type":"application/json","cache-control":"private, no-store"},
});
async function boundedRead<T>(read:(signal:AbortSignal)=>Promise<T>,fallback:T):Promise<T> {
  const controller=new AbortController();
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {return await Promise.race([
    read(controller.signal),
    new Promise<T>(resolve=>{timer=setTimeout(()=>{controller.abort();resolve(fallback);},READ_WAIT_MS);}),
  ]);}
  catch{return fallback;}
  finally{if(timer)clearTimeout(timer);}
}

/** Only the published community callout ledger is reusable between requests.
 * Member account rows are never cached or shared. */
let genxCache:{at:number;data:Rows<GenxWinRow>}|null=null;
let genxPending:Promise<Rows<GenxWinRow>>|null=null;
async function communityRows(admin:Admin):Promise<Rows<GenxWinRow>> {
  if(genxCache&&Date.now()-genxCache.at<COMMUNITY_TTL_MS)return genxCache.data;
  if(genxPending)return genxPending;
  const task=boundedRead(async(signal)=>allRows<GenxWinRow>(()=>admin.from("genx_alerts")
    .select("id,dedupe_key,mode,side,state,outcome,result_pips,created_at,resolved_at,enter_sent_at")
    .order("created_at",{ascending:true}).order("id",{ascending:true})
    .abortSignal(signal) as unknown as Paged),{rows:[],complete:false});
  genxPending=task;
  try {
    const data=await task;
    if(data.complete)genxCache={at:Date.now(),data};
    return data;
  } finally {if(genxPending===task)genxPending=null;}
}
type MemberResult={account:WinningPipsResponse["account"];flow:WinningPipsResult};
async function memberRows(admin:Admin,userId:string,req:NextRequest,asOf:string,zone:string):Promise<MemberResult> {
  const unavailable:MemberResult={account:null,flow:unavailableWinningPips("account",asOf,zone)};
  return boundedRead(async(signal):Promise<MemberResult>=>{
    const [connections,accts]=await Promise.all([
      allRows<ConnRowIn>(()=>admin.from("flow_broker_connections")
        .select("id,broker,environment,status").eq("user_id",userId)
        .order("id",{ascending:true}).abortSignal(signal) as unknown as Paged),
      allRows<AccountRowIn>(()=>admin.from("flow_broker_accounts")
        .select("account_id,acc_num,name,currency,environment,is_selected,connection_id")
        .eq("user_id",userId).order("created_at",{ascending:true})
        .order("account_id",{ascending:true}).order("connection_id",{ascending:true})
        .abortSignal(signal) as unknown as Paged),
    ]);
    if(!connections.complete||!accts.complete)return unavailable;
    const accounts=accountsFrom(connections.rows,accts.rows);
    const selected=pickAccount(accounts,req.headers.get("x-floor-account"),req.headers.get("x-floor-env"));
    const account=selected?{id:selected.id,environment:selected.environment,name:selected.name}:null;
    if(!account)return {account,flow:unavailableWinningPips("account",asOf,zone,"no_account")};
    const result=await allRows<FlowWinRow>(()=>admin.from("flow_managed_positions")
      .select("id,position_id,account_id,environment,status,outcome,result_pips,created_at,resolved_at")
      .eq("user_id",userId).eq("account_id",account.id)
      .lte("created_at",asOf)
      .order("created_at",{ascending:true}).order("id",{ascending:true})
      .abortSignal(signal) as unknown as Paged);
    const allowLegacyEnvironment=accounts.filter(a=>a.id===account.id).length===1;
    return {account,flow:flowWinningPips(result.rows,account,asOf,zone,result.complete,allowLegacyEnvironment)};
  },unavailable);
}

/**
 * Gross positive winning pips, independent sources. Auth required, no writes,
 * no broker calls, no billable requests, no account-selection side effects.
 */
export async function GET(req:NextRequest) {
  const client=createClient();
  if(!client)return json({error:"not_configured"},503);
  let userId:string;
  try {
    const {data:{user},error}=await client.auth.getUser();
    if(error||!user)return json({error:"unauthorized"},401);
    userId=user.id;
  } catch{return json({error:"unavailable"},503);}
  const admin=createAdminClient();
  if(!admin)return json({error:"not_configured"},503);
  const asOf=new Date().toISOString();
  const zone=validTimeZone(req.headers.get("x-floor-time-zone"));
  const [member,community]=await Promise.all([
    memberRows(admin,userId,req,asOf,zone),communityRows(admin),
  ]);
  const genx=genxWinningPips(community.rows,asOf,zone,community.complete);
  const answer:WinningPipsResponse={asOf,timeZone:zone,account:member.account,
    genx,flow:member.flow};
  return json(answer);
}
