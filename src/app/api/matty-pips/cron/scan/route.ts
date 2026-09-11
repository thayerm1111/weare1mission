import { type NextRequest } from "next/server";
import { runMattyScan } from "@/lib/matty-pips/scan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * MATTY PIPS AUTO — scan tick (key-gated cron, every minute). Thin wrapper: the
 * scan core lives in @/lib/matty-pips/scan so the always-on worker runs the SAME
 * code every ~20s (owner 09-11 audit: entries fire immediately, not on the next
 * minute boundary). Per-signal claims (unique index) make double-fills impossible
 * across the overlapping cron + worker runs. Completely inert when nobody has
 * auto ON. FLOW/GENX are never consulted or modified.
 */
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
function authorized(req: NextRequest): boolean {
  const key = process.env.GENX_CRON_KEY, secret = process.env.CRON_SECRET;
  const qp = new URL(req.url).searchParams.get("key") || "";
  const hdr = req.headers.get("authorization") || "";
  if (key && (qp === key || hdr === `Bearer ${key}`)) return true;
  if (secret && (qp === secret || hdr === `Bearer ${secret}`)) return true;
  return false;
}

async function run(): Promise<Response> {
  const r = await runMattyScan();
  if (!r.ok) return json({ ok: false, error: r.error }, 500);
  if (r.skipped) return json({ ok: true, skipped: r.skipped });
  return json({ ok: true, ...(r.result ?? {}) });
}

export async function GET(req: NextRequest) { if (!authorized(req)) return json({ error: "unauthorized" }, 401); return run(); }
export async function POST(req: NextRequest) { if (!authorized(req)) return json({ error: "unauthorized" }, 401); return run(); }
