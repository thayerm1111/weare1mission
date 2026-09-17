/**
 * GOLD READINESS CHECK (owner 09-17: "some users are telling me their accounts aren't taking the trades — double
 * check that everybody's account is taking the trades"). Read-only: for members with autotrade on who are NOT
 * credit-paused but took no GENX gold trade in the last 24h, it logs in, reads each enabled account from the broker
 * and records what would stop a placement (no broker login, account not returned / no equity, size) as a
 * flow_auto_events 'readiness' row. No orders are placed.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { activeAccounts } from "@/lib/flow/connection";
import { sizeFromRisk } from "@/lib/flow/sizing";

type Admin = NonNullable<ReturnType<typeof createAdminClient>>;
export async function goldReadinessCheck(admin: Admin, opts: { maxMembers?: number; gapMs?: number } = {}): Promise<{ checked: number; ok: number; problems: number }> {
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const { data: accts } = await admin.from("flow_broker_accounts").select("user_id, account_id, flow_credit_paused").eq("autotrade_enabled", true);
  const rows = (accts ?? []) as { user_id: string; account_id: string; flow_credit_paused: boolean | null }[];
  const users = [...new Set(rows.filter((r) => !r.flow_credit_paused).map((r) => r.user_id))];
  const { data: placed } = await admin.from("flow_auto_events").select("user_id").eq("symbol", "XAUUSD").eq("status", "placed").like("reason", "genx%").gte("created_at", since).limit(5000);
  const took = new Set(((placed ?? []) as { user_id: string }[]).map((r) => r.user_id));
  const targets = users.filter((u) => !took.has(u)).slice(0, opts.maxMembers ?? 60);
  let ok = 0, problems = 0;
  const log = async (userId: string, reason: string, accountId?: string) => { try { await admin.from("flow_auto_events").insert({ user_id: userId, symbol: "XAUUSD", status: "readiness", reason: reason.slice(0, 160), ...(accountId ? { account_id: accountId } : {}) }); } catch { /* best-effort */ } };
  for (const uid of targets) {
    try {
      const list = await activeAccounts(uid);
      const enabled = rows.filter((r) => r.user_id === uid).map((r) => String(r.account_id));
      if (!list.length) { problems++; await log(uid, `readiness: PROBLEM no usable autotrade account (broker login failed or no enabled accounts on a live connection) — enabled ids ${enabled.join(",")}`); }
      for (const id of enabled) {
        const a = list.find((x) => String(x.accountId) === id);
        if (!a) { if (list.length) { problems++; await log(uid, `readiness: PROBLEM account ${id} not returned by its broker connection`, id); } continue; }
        if (a.equity == null) { problems++; await log(uid, `readiness: PROBLEM account ${id} has no equity from the broker (not listed under this login)`, id); continue; }
        const s = sizeFromRisk({ canonical: "XAUUSD", entry: 4300, stop: 4290, equity: a.equity, riskPct: a.riskPct ?? 1, floorToMinLot: true });
        if (!s.ok || !(s.lots > 0)) { problems++; await log(uid, `readiness: PROBLEM account ${id} can't size a $10-stop trade (equity ${a.equity}): ${s.reason ?? "size"}`, id); continue; }
        ok++; await log(uid, `readiness: OK account ${id} equity ${Math.round(a.equity)} lots ${s.lots} at a $10 stop`, id);
      }
    } catch (e) { problems++; await log(uid, `readiness: PROBLEM check failed: ${String(e).slice(0, 100)}`); }
    await new Promise((r) => setTimeout(r, opts.gapMs ?? 1500));
  }
  return { checked: targets.length, ok, problems };
}
