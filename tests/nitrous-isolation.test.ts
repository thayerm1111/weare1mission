import { test } from "node:test";
import assert from "node:assert/strict";
import { namespacedClient, tradingNamespace, withNitrousDb, withRapidDb } from "../rapid/db";
import { requireAccount } from "../src/app/api/nitrous/_shared";

test("simultaneous Rapid and Nitrous requests retain their own async namespace", async () => {
  const seen: string[] = [];
  const fake = { identity: "service", from(name: string) { assert.equal(this.identity,"service"); return name; },
    rpc(name: string, args: unknown) { assert.equal(this.identity,"service"); return { name,args }; } };
  const one = (scope: "rapid" | "nitrous") => async () => {
    const client = namespacedClient(fake,tradingNamespace());
    assert.equal(tradingNamespace(),scope);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(tradingNamespace(),scope);
    seen.push(client.from("rapid_accounts"));
    assert.equal(client.from("profiles"),"profiles");
    assert.equal(client.from("flow_broker_accounts"),"flow_broker_accounts");
    assert.equal(client.rpc("rapid_reserve_intent",{p_account:"owned"}).name,`${scope}_reserve_intent`);
  };
  await withRapidDb(async () => {
    await Promise.all([withNitrousDb(one("nitrous")),withRapidDb(one("rapid")),withNitrousDb(one("nitrous"))]);
    assert.equal(tradingNamespace(),"rapid");
  });
  assert.deepEqual(seen.sort(),["nitrous_accounts","nitrous_accounts","rapid_accounts"]);
});

test("temporary cross-product lookup and exceptions restore the originating scope", async () => {
  await withNitrousDb(async () => {
    assert.equal(await withRapidDb(async () => { await Promise.resolve(); return tradingNamespace(); }),"rapid");
    assert.equal(tradingNamespace(),"nitrous");
    await assert.rejects(withRapidDb(async () => { throw new Error("lookup failed"); }));
    assert.equal(tradingNamespace(),"nitrous");
  });
});

test("member account reads filter both the submitted ID and the authenticated owner", async () => {
  const id="11111111-1111-4111-8111-111111111111";
  const owner="22222222-2222-4222-8222-222222222222";
  const stranger="33333333-3333-4333-8333-333333333333";
  const observed: Array<Record<string,unknown>>=[];
  const fake = { from(table: string) {
    assert.equal(table,"nitrous_accounts"); const filters:Record<string,unknown>={};
    const query={select(){return query;},eq(k:string,v:unknown){filters[k]=v;return query;},async maybeSingle(){
      observed.push(filters);
      return {error:null,data:filters.id===id&&filters.user_id===owner?{id,user_id:owner}:null};
    }}; return query;
  }} as unknown as Parameters<typeof requireAccount>[0];
  const mine=await requireAccount(fake,owner,id);
  assert.ok("account" in mine);
  const other=await requireAccount(fake,stranger,id);
  assert.ok("error" in other);
  if("error" in other)assert.equal(other.error?.status,404);
  assert.deepEqual(observed,[{id,user_id:owner},{id,user_id:stranger}]);
});

test("an ownership lookup failure cannot become permission to use an account", async () => {
  const query={select(){return query;},eq(){return query;},async maybeSingle(){return {data:null,error:{message:"unavailable"}};}};
  const fake={from(){return query;}} as unknown as Parameters<typeof requireAccount>[0];
  const result=await requireAccount(fake,"member","11111111-1111-4111-8111-111111111111");
  assert.ok("error" in result);
  if("error" in result)assert.equal(result.error?.status,503);
});
