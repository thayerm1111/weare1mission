import { type NextRequest } from "next/server";
import { gateAdmin, sportsDb } from "@/lib/sports/gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Settings + usage panel. Owner/admin-gated. Lets the admin connect a sports-
 * data provider key WITHOUT it ever reaching the browser afterward: the key is
 * written to the admin-only sports_admin_settings table (service-role, RLS
 * admin-only) and is NEVER read back to the client — GET only reports whether a
 * key is present (masked), plus refresh intervals, enabled leagues, confidence
 * weights, and usage counters. Prefer the ODDS_API_KEY env var in production.
 */
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" },
  });
}

const KEYS = ["provider_key", "refresh_intervals", "leagues_enabled", "confidence_weights", "usage"] as const;

export async function GET() {
  const gate = await gateAdmin();
  if (!gate.ok) return json({ error: "not_found" }, 404);
  const db = sportsDb();
  if (!db) return json({ error: "db_unavailable" }, 500);

  const { data } = await db.from("sports_admin_settings").select("key,value").in("key", KEYS as unknown as string[]);
  const map: Record<string, unknown> = {};
  for (const row of data ?? []) map[(row as { key: string }).key] = (row as { value: unknown }).value;

  const providerKeyVal = map["provider_key"] as { odds_api_key?: string } | undefined;
  const envConfigured = !!(process.env.ODDS_API_KEY || process.env.THE_ODDS_API_KEY);
  const settingsKeyPresent = !!providerKeyVal?.odds_api_key;
  const mask = settingsKeyPresent ? `••••••••${(providerKeyVal!.odds_api_key as string).slice(-4)}` : null;

  return json({
    ok: true,
    provider: {
      name: "the-odds-api",
      envConfigured,               // key set via Vercel env (preferred)
      settingsKeyPresent,          // key stored in DB (fallback)
      maskedSettingsKey: mask,
      active: envConfigured || settingsKeyPresent,
    },
    refresh_intervals: map["refresh_intervals"] ?? { pregame_seconds: 900, live_seconds: 30 },
    leagues_enabled: map["leagues_enabled"] ?? ["NFL", "NBA", "MLB"],
    confidence_weights: map["confidence_weights"] ?? null,
    usage: map["usage"] ?? { api_calls: 0, ai_tokens_in: 0, ai_tokens_out: 0 },
    aiConfigured: !!process.env.ANTHROPIC_API_KEY,
  });
}

export async function POST(req: NextRequest) {
  const gate = await gateAdmin();
  if (!gate.ok) return json({ error: "not_found" }, 404);
  const db = sportsDb();
  if (!db) return json({ error: "db_unavailable" }, 500);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const action = String(body.action || "");

  if (action === "set_key") {
    const key = String(body.odds_api_key || "").trim();
    if (!key || key.length < 8) return json({ error: "bad_key", message: "Enter a valid Odds API key." }, 400);
    const { error } = await db.from("sports_admin_settings").upsert({
      key: "provider_key", value: { odds_api_key: key }, updated_at: new Date().toISOString(),
    });
    if (error) return json({ error: "save_failed", message: error.message }, 500);
    return json({ ok: true, message: "Provider key saved (server-side only)." });
  }

  if (action === "clear_key") {
    const { error } = await db.from("sports_admin_settings").upsert({
      key: "provider_key", value: {}, updated_at: new Date().toISOString(),
    });
    if (error) return json({ error: "clear_failed", message: error.message }, 500);
    return json({ ok: true, message: "Provider key cleared." });
  }

  if (action === "set_intervals") {
    const pregame = Number(body.pregame_seconds);
    const live = Number(body.live_seconds);
    const value = {
      pregame_seconds: Number.isFinite(pregame) ? Math.max(60, pregame) : 900,
      live_seconds: Number.isFinite(live) ? Math.max(10, live) : 30,
    };
    const { error } = await db.from("sports_admin_settings").upsert({ key: "refresh_intervals", value, updated_at: new Date().toISOString() });
    if (error) return json({ error: "save_failed", message: error.message }, 500);
    return json({ ok: true, refresh_intervals: value });
  }

  if (action === "reset_usage") {
    const { error } = await db.from("sports_admin_settings").upsert({
      key: "usage", value: { api_calls: 0, ai_tokens_in: 0, ai_tokens_out: 0 }, updated_at: new Date().toISOString(),
    });
    if (error) return json({ error: "reset_failed", message: error.message }, 500);
    return json({ ok: true });
  }

  return json({ error: "unknown_action" }, 400);
}
