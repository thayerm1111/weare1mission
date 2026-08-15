import { type NextRequest } from "next/server";
import { resolveGenxOpen } from "@/lib/genxResolve";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GENX AUTOMATIC outcome tracking (spec §28).
 *
 * Grades any now-resolvable open genx_signals rows against the candles that
 * printed after each was issued (win / loss / expired). Fills ONLY the outcome_*
 * columns — the decision fields stay immutable (spec §27).
 *
 * Triggered on a schedule (GitHub Actions, since Vercel Hobby caps native crons at
 * once/day) and also runnable on demand from the GENX Lab. Protected by a shared
 * key: `?key=<GENX_CRON_KEY>` or `Authorization: Bearer <GENX_CRON_KEY>`. The
 * platform-wide CRON_SECRET is also accepted.
 */
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

function authorized(req: NextRequest): boolean {
  const key = process.env.GENX_CRON_KEY;
  const secret = process.env.CRON_SECRET;
  const url = new URL(req.url);
  const qp = url.searchParams.get("key") || "";
  const hdr = req.headers.get("authorization") || "";
  if (key && (qp === key || hdr === `Bearer ${key}`)) return true;
  if (secret && (qp === secret || hdr === `Bearer ${secret}`)) return true;
  return false;
}

async function run(): Promise<Response> {
  const mdKey = process.env.TWELVEDATA_API_KEY;
  if (!mdKey) return json({ error: "no_market_data_key" }, 500);
  const resolved = await resolveGenxOpen(mdKey);
  return json({ ok: true, ...resolved }, 200);
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return json({ error: "unauthorized" }, 401);
  try { return await run(); } catch (e) { return json({ error: "resolver_failed", detail: String(e).slice(0, 200) }, 500); }
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return json({ error: "unauthorized" }, 401);
  try { return await run(); } catch (e) { return json({ error: "resolver_failed", detail: String(e).slice(0, 200) }, 500); }
}
