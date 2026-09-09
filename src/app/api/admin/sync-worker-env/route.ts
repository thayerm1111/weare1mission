import { type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * WORKER ENV SYNC (owner 09-09). The Railway worker needs the same six env values
 * this Vercel deployment already holds — but Vercel stores secrets as "sensitive"
 * (write-only, can never be revealed in any UI), so the owner cannot copy them out
 * by hand. This admin-only route pushes them SERVER-TO-SERVER instead: it reads its
 * own process.env and upserts each value into the Railway service over Railway's
 * GraphQL API, using a Railway API token the OWNER supplies per request.
 *
 * Security properties:
 *   • Admin-authed (same gate as every admin route).
 *   • The Railway token arrives in the request body, is used for the API calls,
 *     and is never stored or logged.
 *   • Secret VALUES never appear in the response, in logs, or on any screen —
 *     the response carries only each name, whether it was set, and its length.
 *   • Fixed allowlist of variable names; nothing else can be exfiltrated.
 */
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });

// The Railway service this platform's worker runs in (created 09-09).
const RAILWAY_PROJECT_ID = "54eeb48f-59aa-4065-8b61-c9ebc1fe12e4";
const RAILWAY_ENVIRONMENT_ID = "95526865-5c28-4f86-8a28-a7a897e1b450";
const RAILWAY_SERVICE_ID = "d5aa7a23-3b2c-44a2-8cdb-1b6968030d49";
const RAILWAY_GQL = "https://backboard.railway.com/graphql/v2";

// ONLY these names can ever be synced. Adding a name here is a code change.
const SYNC_NAMES = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "FLOW_ENC_KEY",
  "TWELVEDATA_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHANNEL_ID",
] as const;

async function gql(token: string, query: string, variables: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch(RAILWAY_GQL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ query, variables }),
    });
    const d = (await r.json().catch(() => null)) as { errors?: Array<{ message?: string }> } | null;
    if (!r.ok) return { ok: false, error: `http_${r.status}` };
    if (d?.errors?.length) return { ok: false, error: String(d.errors[0]?.message ?? "graphql_error").slice(0, 120) };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e instanceof Error ? e.message : "fetch_failed").slice(0, 120) };
  }
}

export async function POST(req: NextRequest) {
  const supabase = createClient();
  if (!supabase) return json({ ok: false, error: "not_configured" }, 500);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ ok: false, error: "unauthorized" }, 401);
  const { data: me } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (!me || me.role !== "admin") return json({ ok: false, error: "forbidden" }, 403);

  let body: { railwayToken?: unknown } = {};
  try { body = await req.json(); } catch { return json({ ok: false, error: "bad_request" }, 400); }
  const token = typeof body.railwayToken === "string" ? body.railwayToken.trim() : "";
  if (!token || token.length < 10) return json({ ok: false, error: "missing_railway_token" }, 400);

  const results: Array<{ name: string; set: boolean; len: number; error?: string }> = [];
  for (const name of SYNC_NAMES) {
    const value = process.env[name];
    if (!value) { results.push({ name, set: false, len: 0, error: "not_set_on_vercel" }); continue; }
    const r = await gql(token, `mutation up($input: VariableUpsertInput!) { variableUpsert(input: $input) }`, {
      input: { projectId: RAILWAY_PROJECT_ID, environmentId: RAILWAY_ENVIRONMENT_ID, serviceId: RAILWAY_SERVICE_ID, name, value },
    });
    results.push({ name, set: r.ok, len: value.length, ...(r.ok ? {} : { error: r.error }) });
  }

  // Apply the new variables by redeploying the service instance (best-effort — if the
  // API shape differs the owner just clicks Deploy/Restart in the Railway dashboard).
  let redeployed = false; let redeployError: string | undefined;
  const rd = await gql(token, `mutation rd($environmentId: String!, $serviceId: String!) { serviceInstanceRedeploy(environmentId: $environmentId, serviceId: $serviceId) }`, {
    environmentId: RAILWAY_ENVIRONMENT_ID, serviceId: RAILWAY_SERVICE_ID,
  });
  redeployed = rd.ok; if (!rd.ok) redeployError = rd.error;

  return json({ ok: results.every((r) => r.set), results, redeployed, ...(redeployError ? { redeployError } : {}) });
}
