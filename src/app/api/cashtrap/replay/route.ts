import { type NextRequest } from "next/server";
import { cashtrapAccess, json } from "@/lib/cashtrap/access";
import { parseReplayParams } from "@/lib/cashtrap/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Replay/backtest runs: GET lists them with their reports; POST (admin) queues one — the runner picks it up within five minutes. */
export async function GET() {
  const a = await cashtrapAccess();
  if (!a.ok) return json({ error: a.error }, a.status);
  const r = await a.db.from("cashtrap_replay_runs").select("id, status, params, report, error, created_at, started_at, finished_at").order("created_at", { ascending: false }).limit(10);
  return json({ runs: r.data ?? [] });
}

export async function POST(req: NextRequest) {
  const a = await cashtrapAccess({ admin: true });
  if (!a.ok) return json({ error: a.error }, a.status);
  const p = parseReplayParams(await req.json().catch(() => ({})));
  if (!p.ok) return json({ error: p.error }, 400);
  const busy = await a.db.from("cashtrap_replay_runs").select("id", { count: "exact", head: true }).in("status", ["queued", "running"]);
  if ((busy.count ?? 0) >= 3) return json({ error: "three runs are already waiting; let them finish first" }, 429);
  const r = await a.db.from("cashtrap_replay_runs").insert({ params: p.value, requested_by: a.userId }).select("id, status, params, created_at");
  if (r.error) return json({ error: r.error.message }, 500);
  return json({ run: (r.data ?? [])[0] });
}
