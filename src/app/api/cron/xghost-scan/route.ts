import { type NextRequest } from "next/server";
import { scanXghost, logXghostSignals } from "@/lib/xghost/scan";
import { resolveXghostOpen } from "@/lib/xghostResolve";
import { resolveGenxOpen } from "@/lib/genxResolve";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * xGhost AUTOMATIC scan (Stage 3 continuous capture).
 *
 * Runs the exact same five-pair scan as the member button, logs any tradeable
 * setup into signal_log (deduped by fingerprint so it isn't double-counted with a
 * member's manual scan of the same setup), then grades any now-resolvable open
 * signals. No auth session, no credits — this is trusted system work.
 *
 * Triggered on a schedule by a GitHub Actions workflow (plan-independent, since
 * the Vercel Hobby plan caps native crons at once-per-day). Protected by a shared
 * key: `?key=<XGHOST_CRON_KEY>` or `Authorization: Bearer <XGHOST_CRON_KEY>`. A
 * Vercel-native cron (or manual trigger) using CRON_SECRET is also accepted.
 */
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

function authorized(req: NextRequest): boolean {
  const key = process.env.XGHOST_CRON_KEY;
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

  const scan = await scanXghost(mdKey, false);
  if (scan.status === "ratelimit") return json({ ok: false, error: "ratelimit", note: "market data busy — will retry next cycle" }, 200);

  const logged = await logXghostSignals(scan.best, scan.second, scan.dxy, null);

  let resolved: { checked: number; resolved: number; breakdown: Record<string, number> } = { checked: 0, resolved: 0, breakdown: {} };
  try { resolved = await resolveXghostOpen(mdKey); } catch { /* grading is best-effort */ }

  // GENX outcome tracking (spec §28) rides this same trusted 15-min cycle — grades
  // any resolvable Gold signals. Best-effort; never blocks the xGhost result.
  let genx: { checked: number; resolved: number; breakdown: Record<string, number> } = { checked: 0, resolved: 0, breakdown: {} };
  try { genx = await resolveGenxOpen(mdKey); } catch { /* grading is best-effort */ }

  return json({
    ok: true, asOf: scan.asOf, session: scan.session,
    dxy: { state: scan.dxy.state, score: scan.dxy.score, source: scan.dxy.source },
    anyTradeable: scan.anyTradeable, logged, resolved, genx,
    best: scan.best ? { symbol: scan.best.label, execState: scan.best.execState, score: scan.best.score } : null,
  }, 200);
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return json({ error: "unauthorized" }, 401);
  try { return await run(); } catch (e) { return json({ error: "scan_failed", detail: String(e).slice(0, 200) }, 500); }
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return json({ error: "unauthorized" }, 401);
  try { return await run(); } catch (e) { return json({ error: "scan_failed", detail: String(e).slice(0, 200) }, 500); }
}
