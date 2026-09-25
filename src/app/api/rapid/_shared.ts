import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/** Shared plumbing for the Rapid routes. Authentication first, ownership second, work third. */

export const json = (body: unknown, status = 200) => NextResponse.json(body, { status });

export async function requireUser() {
  const supabase = createClient();
  if (!supabase) return { error: json({ error: "not_configured" }, 503) } as const;
  const { data } = await supabase.auth.getUser();
  const user = data?.user;
  if (!user) return { error: json({ error: "unauthorized" }, 401) } as const;
  return { user, supabase } as const;
}

/**
 * Ownership is verified server-side on EVERY operation, against the account row, not against
 * whatever id the client sent. A client-supplied account id is a request, not a claim.
 */
export async function requireAccount(userId: string, accountId: string) {
  const admin = createAdminClient();
  if (!admin) return { error: json({ error: "not_configured" }, 503) } as const;
  const { data } = await admin.from("rapid_accounts").select("*").eq("id", accountId).maybeSingle();
  const row = data as Record<string, unknown> | null;
  if (!row || row.user_id !== userId) return { error: json({ error: "not_found" }, 404) } as const;
  return { admin, account: row } as const;
}

export const RISK_PRESETS = [0.25, 0.5, 1, 2];
export const MAX_RISK_PCT = Number(process.env.RAPID_MAX_RISK_PCT || 2);

/** The operator ceiling is enforced here, server-side. A larger number from the client is clamped. */
export function clampRisk(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(n, MAX_RISK_PCT);
}
