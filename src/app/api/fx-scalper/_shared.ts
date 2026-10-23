import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isOperator } from "@/lib/fxscalper/owner";

/**
 * The FX Scalper trades the OWNER's own live account, so every route is OWNER ONLY — not every admin:
 * the signed-in user must be the owner's account (id or email), checked on the server from the session.
 * Additional operators can be allowed by email with FX_SCALPER_OPERATOR_EMAILS (comma-separated).
 * The service-role client is used only after that check.
 */
export const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

export async function requireOwner() {
  const supabase = createClient();
  const db = createAdminClient();
  if (!supabase || !db) return { error: json({ error: "not_configured" }, 503) } as const;
  const { data } = await supabase.auth.getUser();
  const user = data?.user;
  if (!user) return { error: json({ error: "unauthorized" }, 401) } as const;
  if (!isOperator(user)) return { error: json({ error: "forbidden" }, 403) } as const;
  return { user, db } as const;
}

export async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const b = await req.json();
    return b && typeof b === "object" ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
