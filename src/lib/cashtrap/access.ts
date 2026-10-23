import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { SupabaseStore, type Admin } from "./supabaseStore";
import type { CashtrapSettings } from "./store";
import { lookAtSetupAccess } from "@/lib/setupAccess";
import { SETUP_MINUTES, type SetupGate } from "@/lib/setupLock";
import { CREDIT_COST } from "@/lib/creditConfig";

/**
 * WHO MAY SEE CASHTRAP. Visibility is a Cashtrap setting: "admin" (default — until the owner opens it)
 * or "members" (any active member). Admins always may; only admins may change anything.
 */
export type Access =
  | { ok: true; userId: string; isAdmin: boolean; db: Admin; store: SupabaseStore; settings: CashtrapSettings }
  | { ok: false; status: number; error: string };

export async function cashtrapAccess(opts: { admin?: boolean } = {}): Promise<Access> {
  const supabase = createClient();
  const db = createAdminClient();
  if (!supabase || !db) return { ok: false, status: 503, error: "not_configured" };
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, status: 401, error: "unauthorized" };
  const { data: me } = await db.from("profiles").select("role, status").eq("id", user.id).maybeSingle();
  const isAdmin = (me as { role?: string } | null)?.role === "admin";
  const active = (me as { status?: string } | null)?.status === "active";
  const store = new SupabaseStore(db);
  let settings: CashtrapSettings;
  try { settings = await store.getSettings(); }
  catch { return { ok: false, status: 503, error: "settings_unavailable" }; }   // never fall back to defaults
  if (opts.admin && !isAdmin) return { ok: false, status: 403, error: "forbidden" };
  if (!isAdmin && !(settings.visibility === "members" && active)) return { ok: false, status: 403, error: "forbidden" };
  return { ok: true, userId: user.id, isAdmin, db, store, settings };
}

/**
 * This viewer's window on the live setups (the site's rule — lock.ts): an admin always; a member while a
 * 5-credit spend, a FLOW Pass or a FLOW fee has it open. Closed when it cannot be read (fails closed).
 */
export async function cashtrapGate(a: Extract<Access, { ok: true }>): Promise<SetupGate> {
  if (a.isAdmin) return { open: true, via: "admin", until: null, cost: CREDIT_COST.genx, minutes: SETUP_MINUTES };
  return (await lookAtSetupAccess(a.db, a.userId)).gate;
}

export function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
