import { type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { gateAdmin } from "@/lib/sports/gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * ADMIN KILL SWITCH — global on/off for FLOW, GENX and THE BRAIN, owner-gated.
 *
 *   GET  → { flow: boolean, genx: boolean, brain: boolean }
 *   POST → { flow?: boolean, genx?: boolean, brain?: boolean } sets any of them.
 *
 * Backed by the single-row flow_switches table (id=1). When OFF, the executor stops
 * placing NEW trades for that engine (open trades keep being managed). Owner only —
 * gateAdmin returns 404 to everyone else so the endpoint's existence isn't leaked.
 *
 * THE BRAIN reads this on every pass of its worker loop, so switching it off here takes effect within
 * a tick — no deploy, no restart. Its reader is deliberately stickier than FLOW's: once it has seen
 * OFF it stays off through a database failure, because the moment right after somebody hits a kill
 * switch is exactly the wrong moment to fail open. See command-center/engines/killSwitch.ts.
 */
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });

async function readSwitches() {
  const admin = createAdminClient();
  if (!admin) return { flow: true, genx: true, brain: true };
  const { data } = await admin.from("flow_switches").select("flow_enabled, genx_enabled, brain_enabled").eq("id", 1).maybeSingle();
  const r = data as { flow_enabled?: boolean | null; genx_enabled?: boolean | null; brain_enabled?: boolean | null } | null;
  return { flow: r?.flow_enabled !== false, genx: r?.genx_enabled !== false, brain: r?.brain_enabled !== false };
}

export async function GET() {
  const gate = await gateAdmin();
  if (!gate.ok) return json({ error: "not_found" }, 404);
  return json({ ok: true, ...(await readSwitches()) });
}

export async function POST(req: NextRequest) {
  const gate = await gateAdmin();
  if (!gate.ok) return json({ error: "not_found" }, 404);
  const admin = createAdminClient();
  if (!admin) return json({ error: "server_not_configured" }, 500);

  let body: { flow?: unknown; genx?: unknown; brain?: unknown } = {};
  try { body = (await req.json()) as { flow?: unknown; genx?: unknown; brain?: unknown }; } catch { /* */ }

  const row: Record<string, unknown> = { id: 1, updated_at: new Date().toISOString() };
  if (typeof body.flow === "boolean") row.flow_enabled = body.flow;
  if (typeof body.genx === "boolean") row.genx_enabled = body.genx;
  if (typeof body.brain === "boolean") row.brain_enabled = body.brain;

  const { error } = await admin.from("flow_switches").upsert(row, { onConflict: "id" });
  if (error) return json({ ok: false, error: error.message }, 200);
  return json({ ok: true, ...(await readSwitches()) });
}
