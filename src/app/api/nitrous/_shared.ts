import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { allowedWriteOrigin } from "@/lib/nitrous/policy";
import { getNitrousAddonAccess } from "@/lib/nitrous/addon";

export const json = (body: unknown, status = 200) => NextResponse.json(body, {
  status, headers: { "Cache-Control": "no-store, private", "Vary": "Cookie, Authorization" },
});

export async function requireUser(req?: Request) {
  if (req && req.method !== "GET" && !allowedWriteOrigin(req)) return { error: json({ error: "origin_not_allowed" }, 403) } as const;
  const supabase = createClient();
  const admin = createAdminClient();
  if (!supabase || !admin) return { error: json({ error: "service_unavailable" }, 503) } as const;
  const { data, error } = await supabase.auth.getUser();
  if (error || !data?.user) return { error: json({ error: "unauthorized" }, 401) } as const;
  const user = data.user;
  const profile = await admin.from("profiles").select("status, role, access_expires_at").eq("id", user.id).maybeSingle();
  const p = profile.data as { status?: string; role?: string; access_expires_at?: string | null } | null;
  const expiry = p?.access_expires_at ? Date.parse(p.access_expires_at) : null;
  const active = !profile.error && Boolean(p && (p.role === "admin" || (p.status === "active" && (expiry === null || (Number.isFinite(expiry) && expiry > Date.now())))));
  return { user, admin, active } as const;
}

export async function requireAccount(admin: NonNullable<ReturnType<typeof createAdminClient>>, userId: string, id: string) {
  if (!/^[a-f0-9-]{36}$/i.test(id)) return { error: json({ error: "not_found" }, 404) } as const;
  const r = await admin.from("nitrous_accounts").select("*").eq("id", id).eq("user_id", userId).maybeSingle();
  if (r.error) return { error: json({ error: "account_unavailable" }, 503) } as const;
  if (!r.data) return { error: json({ error: "not_found" }, 404) } as const;
  return { account: r.data as Record<string, unknown> } as const;
}

/** Only new product use needs the add-on. Account recovery and position controls stay available. */
export async function requireNitrousAddon(admin: NonNullable<ReturnType<typeof createAdminClient>>, userId: string) {
  try {
    const addon = await getNitrousAddonAccess(admin, userId);
    if (!addon.entitled) return { error: json({ error: "nitrous_addon_required",
      detail: "Enable the Nitrous add-on to view setups, connect an account, or start new entries." }, 403) } as const;
    return { addon } as const;
  } catch { return { error: unavailable() } as const; }
}

export async function bodyOf(req: Request): Promise<Record<string, unknown> | null> {
  if (!req.headers.get("content-type")?.toLowerCase().includes("application/json")) return null;
  try {
    const raw = await req.text();
    if (raw.length > 16_384) return null;
    const body = JSON.parse(raw);
    return body && typeof body === "object" && !Array.isArray(body) ? body : null;
  } catch { return null; }
}

export async function audit(admin: NonNullable<ReturnType<typeof createAdminClient>>, userId: string, accountId: string | null, code: string, evidence: Record<string, unknown>) {
  return admin.from("nitrous_journal").insert({ user_id: userId, account_id: accountId, stage: "member_settings", code,
    decision: "applied", reason: code.replaceAll("_", " "), evidence });
}

export const unavailable = () => json({ error: "service_unavailable", detail: "Nitrous could not complete that request. Please refresh and try again." }, 503);
