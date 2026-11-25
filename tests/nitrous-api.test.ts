import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  allowedWriteOrigin, finiteNumber, freshAt, hasFreshWorkerReadiness, NITROUS_CONSENT_VERSION, readinessBlockers,
  recordedStats, validRisk, validateSettingsChange, verifiedOwnedPosition,
} from "../src/lib/nitrous/policy";

const NOW = Date.UTC(2026,10,25,23,0,0);
const AT = new Date(NOW).toISOString();
const account = { profile: "slow_drip", risk_pct: 0.5, automation_enabled: false, status: "linked",
  instrument_spec: { contractSize: 100 }, spec_missing: [], equity: 500, equity_at: AT,
  ownership_check: { ok: true, checkedAt: AT } };
const ready = () => ({ account: { ...account }, connection: { status: "connected" }, workerAt: AT,
  control: { mode: "live", entries_paused: false }, unresolved: 0, now: NOW });

test("cookie-backed mutations cannot be submitted cross-origin or without an Origin", () => {
  const request = (origin?: string, authorization?: string) => new Request("https://weare1mission.com/api/nitrous/settings", {
    method: "POST", headers: { ...(origin ? { origin } : {}), ...(authorization ? { authorization } : {}) },
  });
  assert.equal(allowedWriteOrigin(request("https://weare1mission.com")),true);
  assert.equal(allowedWriteOrigin(request("https://attacker.example")),false);
  assert.equal(allowedWriteOrigin(request("null")),false);
  assert.equal(allowedWriteOrigin(request()),false);
  assert.equal(allowedWriteOrigin(request(undefined,"Bearer native-token")),true);
  assert.equal(allowedWriteOrigin(request("https://attacker.example","Bearer native-token")),false);
});

test("risk is a supported numeric preset, never a silent upward clamp", () => {
  assert.equal(validRisk("slow_drip",0.5),0.5);
  assert.equal(validRisk("slow_drip",1),1);
  assert.equal(validRisk("slow_drip",5),null);
  assert.equal(validRisk("nitrous",3),3);
  assert.equal(validRisk("nitrous",5),5);
  assert.equal(validRisk("nitrous",10),null);
  assert.equal(validRisk("nitrous","5"),null);
  assert.equal(validRisk("nitrous",Infinity),null);
});

test("choosing a profile or linking an account cannot grant automation consent", () => {
  const change = validateSettingsChange(account,{mode:"nitrous",riskPct:5},true);
  assert.equal(change.ok,true);
  if (!change.ok) return;
  assert.equal(change.arming,false);
  assert.equal(change.patch.automation_enabled,undefined);
  assert.equal(change.patch.consent_version,undefined);
  assert.equal(change.patch.risk_pct,5);
});

test("arming requires an active member, exact displayed settings, and current explicit consent", () => {
  const confirm = {mode:"nitrous",riskPct:5,automationEnabled:true,acknowledgedRisk:true,consentVersion:NITROUS_CONSENT_VERSION};
  assert.equal(validateSettingsChange(account,confirm,true).ok,true);
  assert.equal(validateSettingsChange(account,confirm,false).ok,false);
  for (const altered of [
    {...confirm,acknowledgedRisk:false}, {...confirm,consentVersion:"old"},
    {...confirm,mode:undefined}, {...confirm,riskPct:undefined}, {...confirm,automationEnabled:"true"},
  ]) assert.equal(validateSettingsChange(account,altered,true).ok,false);
});

test("changing an armed account's risk requires a separate pause; inactive members can always pause", () => {
  const armed = {...account,automation_enabled:true};
  assert.equal(validateSettingsChange(armed,{mode:"nitrous",riskPct:5},true).ok,false);
  assert.equal(validateSettingsChange(armed,{mode:"nitrous",riskPct:5,automationEnabled:false},true).ok,false);
  const pause=validateSettingsChange(armed,{automationEnabled:false},false);
  assert.equal(pause.ok,true);
  if(pause.ok) assert.equal(pause.patch.automation_enabled,false);
  assert.equal(validateSettingsChange({...armed,profile:"obsolete",risk_pct:2},{automationEnabled:false},false).ok,true);
});

test("freshness and execution readiness fail closed on missing or old evidence", () => {
  assert.deepEqual(readinessBlockers(ready()),[]);
  for(const scenario of [
    {...ready(),connection:null}, {...ready(),connection:{status:"reconnect_required"}},
    {...ready(),workerAt:null}, {...ready(),workerAt:new Date(NOW-61_000).toISOString()},
    {...ready(),control:null}, {...ready(),control:{mode:"live",entries_paused:true}},
    {...ready(),unresolved:1}, {...ready(),account:{...account,ownership_check:null}},
    {...ready(),account:{...account,equity:null}}, {...ready(),account:{...account,equity_at:new Date(NOW-121_000).toISOString()}},
    {...ready(),account:{...account,instrument_spec:null}}, {...ready(),account:{...account,spec_missing:["lotStep"]}},
    {...ready(),account:{...account,profile:"nitrous",risk_pct:10}},
    {...ready(),account:{...account,block_reason:"Contract mismatch"}},
    {...ready(),account:{...account,execution_block_reason:"Daily loss limit reached"}},
  ]) assert.ok(readinessBlockers(scenario).length>0);
  assert.equal(freshAt("invalid",NOW,60_000),false);
  assert.equal(freshAt(new Date(NOW+60_000).toISOString(),NOW,60_000),false);
});

test("activation reuses only recent connection-scoped worker proof, never missing margin or stale exposure", () => {
  const verified = { ...account, connection_id: "conn-1", ownership_check: {
    ok: true, checkedAt: AT, workerVerified: true, workerConnectionId: "conn-1",
  } };
  const context = { ...ready(), account: verified };
  assert.equal(hasFreshWorkerReadiness(context), true);
  assert.deepEqual(readinessBlockers(context), []);
  for (const patch of [
    { workerVerified: false }, { workerVerified: undefined }, { workerConnectionId: "conn-2" },
    { ok: false }, { checkedAt: new Date(NOW - 31_000).toISOString() },
  ]) assert.equal(hasFreshWorkerReadiness({ ...context, account: { ...verified, ownership_check: { ...verified.ownership_check, ...patch } } }), false);
  assert.equal(hasFreshWorkerReadiness({ ...context, account: { ...verified, equity_at: new Date(NOW-31_000).toISOString() } }), false);
  assert.equal(hasFreshWorkerReadiness({ ...context, account: { ...verified, equity: 0 } }), false);
  assert.equal(hasFreshWorkerReadiness({ ...context, workerAt: null }), false);
  assert.equal(hasFreshWorkerReadiness(ready()), false);
  // Reusing proof does not bypass other blockers.
  assert.ok(readinessBlockers({ ...context, unresolved: 1 }).length > 0);
  assert.ok(readinessBlockers({ ...context, connection: null }).length > 0);
  assert.ok(readinessBlockers({ ...context, control: { mode: "live", entries_paused: true } }).length > 0);
  assert.ok(readinessBlockers({ ...context, account: { ...verified, execution_block_reason: "Broker read failed." } }).length > 0);
});

test("missing money and unknown closes never become zero-profit trades or wins", () => {
  for(const v of [null,undefined,"",NaN,Infinity])assert.equal(finiteNumber(v),null);
  const stats=recordedStats([
    {status:"open",realised_pnl:99,realised_pnl_source:"broker_net",fees_verified:true},
    {status:"closed",realised_pnl:25,realised_pnl_source:"calculated_gross"},
    {status:"closed",realised_pnl:-30,realised_pnl_source:"broker_net",fees_verified:true},
    {status:"closed",realised_pnl:null,realised_pnl_source:"unknown"},
    {status:"closed",realised_pnl:50,realised_pnl_source:"unknown"},
  ]);
  assert.equal(stats.closed,4);
  assert.equal(stats.wins,1);assert.equal(stats.losses,1);assert.equal(stats.unresolved,2);
  assert.equal(stats.recordedPnl,-5);assert.equal(stats.netPnl,null);assert.equal(stats.grossPnl,25);
  assert.equal(stats.pnlVerified,false);assert.equal(stats.verifiedClosed,1);
});

test("net P&L is exposed only when every closed trade is broker-net and fees verified", () => {
  const rows=[{status:"closed",realised_pnl:23,realised_pnl_source:"broker_net",fees_verified:true},
    {status:"closed",realised_pnl:-30,realised_pnl_source:"broker_net",fees_verified:true}];
  const verified=recordedStats(rows);
  assert.equal(verified.pnlVerified,true);assert.equal(verified.netPnl,-7);
  assert.equal(recordedStats(rows.map(r=>({...r,fees_verified:false}))).netPnl,null);
  assert.equal(recordedStats([]).netPnl,null);
});

test("manual close must match both a saved broker position ID and the exact Nitrous tag", () => {
  const ledger={broker_position_id:"123",broker_strategy_id:"NITROUS:owned"};
  assert.equal(verifiedOwnedPosition(ledger,{positionId:"123",strategyId:"NITROUS:owned"}),true);
  for(const broker of [undefined,{positionId:"124",strategyId:"NITROUS:owned"},{positionId:"123",strategyId:"NITROUS:other"},
    {positionId:"123",strategyId:"RAPID:owned"},{positionId:"123",strategyId:null}])assert.equal(verifiedOwnedPosition(ledger,broker),false);
});

test("database gates isolate credentials, consent, ownership, version and risk without arming on migration", () => {
  const sql=readFileSync("scripts/sql/nitrous-schema.sql","utf8");
  assert.ok(sql.includes("automation_enabled boolean not null default false"));
  assert.ok(sql.includes("mode              text not null default 'off'"));
  assert.ok(sql.includes("v_account.consent_version is distinct from 'nitrous-consent-v1'"));
  assert.ok(sql.includes("where id=p_account and user_id=p_user for update"));
  assert.ok(sql.includes("p_estimated_risk>v_account.equity*p_risk_pct/100"));
  assert.ok(sql.includes("revoke all on table public.%I from public,anon,authenticated"));
  assert.ok(sql.includes("revoke all on function %s from public,anon,authenticated"));
  assert.equal(/create policy/i.test(sql),false);
  assert.ok(sql.includes("public.nitrous_risk_days"));
});

test("account selection revalidates broker membership and close endpoint only queues", () => {
  const connect=readFileSync("src/app/api/nitrous/connect/route.ts","utf8");
  assert.ok(connect.includes("const remote = await listAccounts(conn.environment, tok.token)"));
  assert.ok(connect.includes("remote.data.find((a) => a.accountId === brokerAccountId && a.accNum)"));
  assert.ok(connect.includes("enc_password: null"));
  assert.ok(connect.includes("automation_enabled: false"));
  const close=readFileSync("src/app/api/nitrous/position/route.ts","utf8");
  assert.equal(/\.close\(|closePosition\(/.test(close),false);
  assert.ok(close.includes('"nitrous_request_close"'));
  assert.ok(close.includes("verifiedOwnedPosition(pos, broker)"));
});
