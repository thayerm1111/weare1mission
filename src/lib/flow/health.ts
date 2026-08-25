/**
 * SYSTEM HEALTH + HEARTBEATS — the always-on watchdog layer.
 *
 * Every scheduled component (the continuous trade-manager, the FLOW executor, the
 * GENX scanner) writes a heartbeat each time it runs, so liveness is unambiguous
 * even when there's nothing to trade. `computeHealth` reads those heartbeats plus
 * the live position table and returns a single OK / DEGRADED / DOWN verdict with
 * the detail behind it. Two things consume it:
 *   • /api/health          — public, non-sensitive status (external uptime monitor)
 *   • /api/cron/flow-watchdog — self-heals stalled components and logs incidents
 *
 * Severity model (conservative — real money is the priority):
 *   DOWN     = something that risks live trades: manager stalled WHILE positions
 *              are open, a position left unmanaged/stale, or a break-even stop
 *              parked at a loss.
 *   DEGRADED = a component is lagging but nothing open is at risk (manager stalled
 *              while flat, executor/GENX behind schedule).
 *   OK       = everything within its expected cadence.
 */
import { createAdminClient } from "@/lib/supabase/admin";

type Admin = NonNullable<ReturnType<typeof createAdminClient>>;

export type Health = "OK" | "DEGRADED" | "DOWN";
export type ComponentName = "manager" | "exec" | "genx";

// How long a component may go silent before it's considered stalled (seconds).
// The manager beats every ~4s while looping and restarts each minute, so 120s is
// a wide, false-alarm-proof bar. exec runs a full scan every 5m + watch every 1m.
export const STALE_SEC: Record<ComponentName, number> = { manager: 120, exec: 210, genx: 420 };

// A position the manager hasn't touched in this long is a red flag (the loop runs
// every ~4s, so anything past ~150s means it isn't being managed).
const POSITION_STALE_SEC = 160;

/** Write a component's heartbeat. Best-effort — never throws into the caller. */
export async function beat(admin: Admin, component: ComponentName, detail?: Record<string, unknown>): Promise<void> {
  try {
    await admin.from("flow_heartbeat").upsert(
      { component, last_run: new Date().toISOString(), detail: detail ?? {} },
      { onConflict: "component" },
    );
  } catch { /* heartbeat is best-effort */ }
}

/** Record an incident (a stall detected, a self-heal fired, an anomaly). */
export async function logIncident(admin: Admin, component: string, kind: string, detail?: Record<string, unknown>): Promise<void> {
  try {
    await admin.from("flow_incidents").insert({ component, kind, detail: detail ?? {} });
  } catch { /* incident logging is best-effort */ }
}

export type ComponentStatus = {
  component: ComponentName;
  lastRun: string | null;
  ageSec: number | null;   // seconds since last heartbeat (null = never seen)
  stale: boolean;
  configured: boolean;     // false = never beat (e.g. GENX before Telegram is set)
};

export type HealthReport = {
  status: Health;
  generatedAt: string;
  components: ComponentStatus[];
  checks: {
    openPositions: number;
    stalePositions: number;      // open, not touched in POSITION_STALE_SEC
    beStopAtLoss: number;        // be_done but stop parked at a loss (should be 0)
    withError: number;
    managerLockAgeSec: number | null; // secs until lock expiry (negative = expired/idle)
  };
  reasons: string[];             // human-readable why-not-OK lines
};

/** Read heartbeats + live positions and produce the health verdict. */
export async function computeHealth(admin: Admin): Promise<HealthReport> {
  const now = Date.now();
  const generatedAt = new Date().toISOString();
  const reasons: string[] = [];

  // 1) Heartbeats.
  const { data: hbRows } = await admin.from("flow_heartbeat").select("component,last_run");
  const hbMap = new Map<string, string>();
  for (const r of (hbRows ?? []) as { component: string; last_run: string }[]) hbMap.set(r.component, r.last_run);

  const components: ComponentStatus[] = (["manager", "exec", "genx"] as ComponentName[]).map((c) => {
    const last = hbMap.get(c) ?? null;
    const ageSec = last ? Math.round((now - Date.parse(last)) / 1000) : null;
    const configured = last != null;
    const stale = configured && ageSec != null && ageSec > STALE_SEC[c];
    return { component: c, lastRun: last, ageSec, stale, configured };
  });

  // 2) Live position checks.
  let openPositions = 0, stalePositions = 0, beStopAtLoss = 0, withError = 0, managerLockAgeSec: number | null = null;
  try {
    const { data: pos } = await admin
      .from("flow_managed_positions")
      .select("status,be_done,side,entry,init_stop,cur_stop,updated_at,last_error")
      .eq("status", "open")
      .neq("environment", "demo");   // LIVE-ONLY health: demo test accounts are still managed,
                                      // but never drive the OK/DEGRADED/DOWN verdict or the counts.
    for (const p of (pos ?? []) as Array<{ status: string; be_done: boolean; side: string; entry: number; init_stop: number; cur_stop: number; updated_at: string; last_error: string | null }>) {
      openPositions += 1;
      const ageSec = (now - Date.parse(p.updated_at)) / 1000;
      if (ageSec > POSITION_STALE_SEC) stalePositions += 1;
      if (p.last_error) withError += 1;
      const rDist = Math.abs(p.entry - p.init_stop);
      const eps = rDist * 0.02;
      if (p.be_done && ((p.side === "buy" && p.cur_stop < p.entry - eps) || (p.side === "sell" && p.cur_stop > p.entry + eps))) beStopAtLoss += 1;
    }
  } catch { reasons.push("Could not read positions table."); }

  try {
    const { data: lock } = await admin.from("flow_manage_lock").select("expires_at").eq("id", 1).maybeSingle();
    if (lock?.expires_at) managerLockAgeSec = Math.round((Date.parse(lock.expires_at) - now) / 1000);
  } catch { /* lock read best-effort */ }

  // 3) Verdict.
  let status: Health = "OK";
  const manager = components.find((c) => c.component === "manager")!;

  if (beStopAtLoss > 0) { status = "DOWN"; reasons.push(`${beStopAtLoss} break-even stop(s) parked at a loss.`); }
  if (stalePositions > 0) { status = "DOWN"; reasons.push(`${stalePositions} open position(s) not managed in ${POSITION_STALE_SEC}s.`); }
  if (manager.stale && openPositions > 0) { status = "DOWN"; reasons.push(`Trade-manager stalled (${manager.ageSec}s) with ${openPositions} position(s) open.`); }

  if (status !== "DOWN") {
    if (manager.stale) { status = "DEGRADED"; reasons.push(`Trade-manager heartbeat stale (${manager.ageSec}s) — no open positions at risk.`); }
    for (const c of components) {
      if (c.component === "manager") continue;
      if (c.stale) { status = status === "OK" ? "DEGRADED" : status; reasons.push(`${c.component} heartbeat stale (${c.ageSec}s).`); }
    }
  }

  return {
    status, generatedAt, components,
    checks: { openPositions, stalePositions, beStopAtLoss, withError, managerLockAgeSec },
    reasons,
  };
}

/** Which components look stalled and should be re-kicked. */
export function stalledComponents(report: HealthReport): ComponentName[] {
  return report.components.filter((c) => c.stale).map((c) => c.component);
}
