import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runAutoExecAll, runAutoExecForUser, runFlowWatch, type AutoSettings } from "@/lib/flow/autoExec";
import { manageOpenPositions, acquireManageLock, releaseManageLock } from "@/lib/flow/flowManage";
import { beat } from "@/lib/flow/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Headroom for the rare tick that actually PLACES across many accounts: outbound
// broker calls are now paced (150ms/host) + retried on a rate-limit, so a heavy
// fan-out can take longer than the old 60s. Overlap with the next minute's cron is
// harmless — the per-symbol cooldown guard de-dupes placement.
export const maxDuration = 120;

/**
 * FLOW AUTO-EXECUTOR endpoint.
 *
 *  • Scheduled (GitHub Actions) with a shared key → runs for EVERY armed member:
 *      POST /api/cron/flow-exec?key=<FLOW_CRON_KEY | GENX_CRON_KEY | CRON_SECRET>
 *  • Member-authenticated (no key) → runs once for THAT member only, so a member
 *    (or support) can prove their own auto-exec path on demand.
 *
 * Placing orders is gated by flow_auto_settings.enabled — a member who hasn't
 * armed FLOW is a no-op. All real order placement flows through executor.ts.
 */
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });

function keyAuthorized(req: NextRequest): boolean {
  const url = new URL(req.url);
  const qp = url.searchParams.get("key") || "";
  const hdr = req.headers.get("authorization") || "";
  for (const k of [process.env.FLOW_CRON_KEY, process.env.GENX_CRON_KEY, process.env.CRON_SECRET]) {
    if (k && (qp === k || hdr === `Bearer ${k}`)) return true;
  }
  return false;
}

async function run(req: NextRequest): Promise<Response> {
  const mdKey = process.env.TWELVEDATA_API_KEY;
  if (!mdKey) return json({ error: "no_market_data_key" }, 500);

  // 1) Cron / key path → every armed member.
  if (keyAuthorized(req)) {
    // Fast-watch tier: re-confirm at-zone setups on 1-min candles (cheap, runs
    // every ~30s). Full scan otherwise (heavy, runs every ~5 min).
    if (new URL(req.url).searchParams.get("watch") === "1") {
      // Fast tick does two jobs: (1) catch at-zone entries on 1-min candles, and
      // (2) manage OPEN positions (break-even + partial at +1R, then trail).
      // `manage=0` runs ONLY the entry check — used by the 30-second GitHub
      // watcher so it can't race the once-a-minute Vercel cron into a double
      // partial. The trade-manager therefore runs on exactly one scheduler.
      const doManage = new URL(req.url).searchParams.get("manage") !== "0";
      const w = await runFlowWatch(mdKey);
      // Management runs continuously on /api/cron/flow-manage. This minute-tick only manages as
      // a FALLBACK, and only if it can grab the lock (i.e. the continuous loop isn't running) —
      // so the two schedulers can never race into a double partial.
      let m: unknown = null;
      if (doManage) {
        const adminMgr = createAdminClient();
        if (adminMgr) {
          const holder = (globalThis.crypto?.randomUUID?.() ?? `fx-${Date.now()}`);
          if (await acquireManageLock(adminMgr, holder)) {
            try { m = await manageOpenPositions(); await beat(adminMgr, "manager", { via: "flow-exec-fallback" }); } finally { await releaseManageLock(adminMgr, holder); }
          } else { m = { skipped: "locked" }; }
        }
      }
      { const a = createAdminClient(); if (a) await beat(a, "exec", { scope: "watch" }); }
      return json({ ok: true, scope: "watch", asOf: new Date().toISOString(), ...w, manage: m }, 200);
    }
    const out = await runAutoExecAll(mdKey);
    { const a = createAdminClient(); if (a) await beat(a, "exec", { scope: "all" }); }
    return json({ ok: true, scope: "all", asOf: new Date().toISOString(), ...out }, 200);
  }

  // 2) Member path → just this member (must be signed in AND armed).
  const supabase = createClient();
  const { data: { user } } = supabase ? await supabase.auth.getUser() : { data: { user: null } };
  if (!user) return json({ error: "unauthorized" }, 401);

  const admin = createAdminClient();
  if (!admin) return json({ error: "no_admin_client" }, 500);
  const { data: row } = await admin.from("flow_auto_settings").select("*").eq("user_id", user.id).maybeSingle();
  if (!row) return json({ ok: true, scope: "self", armed: false, detail: "Auto-execute isn't set up for this account." }, 200);
  const settings = { ...(row as AutoSettings), email: user.email };
  if (!settings.enabled) return json({ ok: true, scope: "self", armed: false, detail: "Auto-execute is switched off." }, 200);

  const res = await runAutoExecForUser(settings, mdKey);
  return json({ ok: true, scope: "self", armed: true, asOf: new Date().toISOString(), ...res }, 200);
}

export async function GET(req: NextRequest) { return run(req); }
export async function POST(req: NextRequest) { return run(req); }
