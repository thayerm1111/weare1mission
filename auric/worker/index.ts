/**
 * auric-engine — the always-on Railway service. `npm run auric-engine`.
 *
 * Every 1s: refresh the set of accounts that need a runner (consented account, active credit session, open AURIC position
 * OR unresolved intent), tick each runner (serialized per account), flush telemetry, heartbeat.
 * Never touches GENX / FLOW / ATLAS tables except the read-only ownership look-up.
 */
import { hostname } from "node:os";
import { admin, flushTelemetry, setting } from "../db";
import { AccountRunner, type AccountRow, type SessionRow } from "../exec/runner";
import type { ConnRow } from "../broker/session";

const WORKER = `auric-${hostname()}-${process.pid}`;
const TICK_MS = Number(process.env.AURIC_TICK_MS ?? 1000);
const runners = new Map<string, AccountRunner>();
let shuttingDown = false;

async function heartbeat(info: unknown) {
  await admin().from("auric_worker_heartbeat").upsert({ worker: WORKER, at: new Date().toISOString(), info });
}

async function activeAccounts(): Promise<Array<{ acct: AccountRow; conn: ConnRow; session: SessionRow | null }>> {
  const db = admin();
  const nowIso = new Date().toISOString();
  const [{ data: sessions }, { data: open }, { data: inflight }] = await Promise.all([
    db.from("auric_sessions").select("*").eq("status", "active").gt("expires_at", nowIso),
    db.from("auric_positions").select("account_id").in("status", ["open", "closing", "orphan_review"]),
    db.from("auric_intents").select("account_id").in("status", ["submitting", "submitted", "unknown"]),
  ]);
  // Auto-renew (explicit opt-in only) then expire sessions whose time has passed (positions keep being managed by the open-position rule).
  const { data: due } = await db.from("auric_sessions").select("id, account_id, auto_renew_price").eq("status", "active").eq("auto_renew", true).lte("expires_at", nowIso);
  for (const s of due ?? []) {
    const { data: r } = await db.rpc("auric_renew_session", { p_session: s.id, p_allowance: Number(process.env.NEXT_PUBLIC_DAILY_FREE_CREDITS ?? 5) });
    await db.from("auric_events").insert({ account_id: s.account_id, session_id: r?.session_id ?? s.id, kind: "session", state: r?.ok ? "OBSERVING" : "PAUSED", message: r?.ok ? `Session auto-renewed: ${r.charged} credits (until ${r.expires_at}).` : `Auto-renew did not run (${r?.error ?? "error"}): new entries stopped, open positions still managed.` });
  }
  await db.from("auric_sessions").update({ status: "expired" }).eq("status", "active").lte("expires_at", nowIso);
  // Consented, linked accounts are observed too (read-only: quotes, bars, regime, account state) so the member sees
  // AURIC working before paying. Orders need an active credit session — the runner's NO_SESSION gate enforces that.
  const { data: watch } = await db.from("auric_accounts").select("id").eq("status", "linked").not("consent_at", "is", null);
  const ids = new Set<string>([...(sessions ?? []).map((s) => s.account_id), ...(open ?? []).map((p) => p.account_id), ...(inflight ?? []).map((i) => i.account_id), ...(watch ?? []).map((w) => w.id)]);
  if (!ids.size) return [];
  const { data: accts } = await db.from("auric_accounts").select("*").in("id", [...ids]).in("status", ["linked", "blocked"]);
  const connIds = [...new Set((accts ?? []).map((a) => a.connection_id))];
  const { data: conns } = await db.from("auric_broker_connections").select("*").in("id", connIds);
  const cmap = new Map((conns ?? []).map((c) => [c.id, c as ConnRow]));
  const smap = new Map((sessions ?? []).map((s) => [s.account_id, s as SessionRow]));
  return (accts ?? []).filter((a) => cmap.has(a.connection_id)).map((a) => ({ acct: a as AccountRow, conn: cmap.get(a.connection_id)!, session: smap.get(a.id) ?? null }));
}

async function pendingCommands(accountId: string) {
  const db = admin();
  const { data } = await db.from("auric_commands").select("id, command, requested_by").eq("account_id", accountId).is("done_at", null);
  const rows = (data ?? []).map((c) => ({ id: c.id, command: c.command, by: c.requested_by }));
  if (rows.length) await db.from("auric_commands").update({ done_at: new Date().toISOString() }).in("id", rows.map((r) => r.id));
  return rows;
}

async function loop() {
  let lastDiscover = 0, lastBeat = 0;
  let active: Awaited<ReturnType<typeof activeAccounts>> = [];
  while (!shuttingDown) {
    const t0 = Date.now();
    try {
      const enabled = await setting<boolean>("engine_enabled", false);
      if (t0 - lastDiscover > 5000) { lastDiscover = t0; active = enabled ? await activeAccounts() : []; }
      const live = new Set(active.map((x) => x.acct.id));
      for (const [id, r] of runners) if (!live.has(id)) { r.stopped = true; runners.delete(id); console.log(`[auric] runner stopped ${id.slice(0, 8)}`); }
      await Promise.all(active.map(async ({ acct, conn, session }) => {
        let r = runners.get(acct.id);
        if (!r) { r = new AccountRunner(acct, conn, WORKER); await r.loadPersisted(); runners.set(acct.id, r); console.log(`[auric] runner started ${acct.id.slice(0, 8)} (${conn.env})`); }
        else { r.acct = acct; r.conn = conn; }
        await r.tick(session, await pendingCommands(acct.id));
      }));
      await flushTelemetry();
      if (t0 - lastBeat > 10_000) { lastBeat = t0; await heartbeat({ engineEnabled: enabled, runners: [...runners.keys()], tickMs: TICK_MS, version: process.env.RAILWAY_GIT_COMMIT_SHA ?? null }); }
    } catch (e) { console.error("[auric] loop error", e instanceof Error ? e.message : e); }
    const wait = Math.max(50, TICK_MS - (Date.now() - t0));
    await new Promise((r) => setTimeout(r, wait));
  }
}

async function main() {
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) if (!process.env[k]) { console.error(`[auric] ${k} missing`); process.exit(1); }
  if (!process.env.AURIC_ENC_KEY && !process.env.FLOW_ENC_KEY) { console.error("[auric] AURIC_ENC_KEY missing"); process.exit(1); }
  console.log(`[auric] ${WORKER} starting; tick ${TICK_MS}ms`);
  await heartbeat({ starting: true });
  process.on("SIGTERM", () => { shuttingDown = true; }); process.on("SIGINT", () => { shuttingDown = true; });
  await loop();
  await flushTelemetry();
  console.log("[auric] stopped");
}
main().catch((e) => { console.error(e); process.exit(1); });
