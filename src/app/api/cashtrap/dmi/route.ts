import { type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { cashtrapAccess, json } from "@/lib/cashtrap/access";
import { parseDmiEvent, secretMatches } from "@/lib/cashtrap/dmiIngest";
import { DMI_SOURCE, dmiStatus } from "@/lib/cashtrap/dmi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET: the DMI source status (viewers). POST: receive a timestamped B/S event (dmiIngest.ts has the contract). */
export async function GET() {
  const a = await cashtrapAccess();
  if (!a.ok) return json({ error: a.error }, a.status);
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const r = await a.db.from("cashtrap_dmi_events").select("id", { count: "exact", head: true }).gte("received_at", since);
  return json({ status: dmiStatus(a.settings.dmiMode, a.settings.dmiFeedVerified), source: DMI_SOURCE, feedEventsLast24h: r.count ?? 0, feedConfigured: !!process.env.CASHTRAP_DMI_FEED_SECRET });
}

export async function POST(req: NextRequest) {
  const configured = process.env.CASHTRAP_DMI_FEED_SECRET;
  if (!configured) return json({ error: "the DMI event feed is not configured (CASHTRAP_DMI_FEED_SECRET)" }, 503);
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const presented = new URL(req.url).searchParams.get("key") ?? (typeof body?.secret === "string" ? body.secret : null);
  if (!secretMatches(presented, configured)) return json({ error: "unauthorized" }, 401);
  const p = parseDmiEvent(body);
  if (!p.ok) return json({ error: p.error }, 400);
  const db = createAdminClient();
  if (!db) return json({ error: "not_configured" }, 503);
  const e = p.event;
  const r = await db.from("cashtrap_dmi_events").upsert({ symbol: e.symbol, candle_t: new Date(e.candleT).toISOString(), type: e.type, source: e.source, source_version: e.sourceVersion, payload: body ? { ...body, secret: undefined } : null }, { onConflict: "symbol,candle_t,type,source", ignoreDuplicates: true }).select("id");
  if (r.error) return json({ error: r.error.message }, 500);
  return json({ ok: true, stored: (r.data ?? []).length > 0, duplicate: (r.data ?? []).length === 0 });
}
