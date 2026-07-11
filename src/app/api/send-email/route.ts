import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { isEmailConfigured, sendEmails } from "@/lib/messaging";

/**
 * Sends an email to selected members of the caller's downline.
 * Recipients are verified server-side to actually be in the caller's downline,
 * so a member can only message people who signed up under them.
 */
export async function POST(request: NextRequest) {
  const supabase = createClient();
  if (!supabase) return NextResponse.json({ ok: false, error: "not-configured" }, { status: 503 });

  const profile = await getProfile();
  if (!profile) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (profile.status !== "active" && profile.role !== "admin")
    return NextResponse.json({ ok: false, error: "not-approved" }, { status: 403 });

  if (!isEmailConfigured)
    return NextResponse.json({ ok: false, error: "email-not-configured" }, { status: 200 });

  const { toIds, subject, message } = await request.json().catch(() => ({}));
  if (!Array.isArray(toIds) || !toIds.length || !subject || !message)
    return NextResponse.json({ ok: false, error: "bad-request" }, { status: 400 });

  // Restrict to the caller's actual downline.
  const { data: downline } = await supabase.rpc("get_my_downline");
  const allowed = new Map<string, string>();
  (downline ?? []).forEach((d: { id: string; email: string | null }) => {
    if (d.email) allowed.set(d.id, d.email);
  });
  const emails = (toIds as string[]).map((id) => allowed.get(id)).filter(Boolean) as string[];
  if (!emails.length) return NextResponse.json({ ok: false, error: "no-valid-recipients" }, { status: 400 });

  const sent = await sendEmails(emails, subject, message, profile.email ?? undefined);
  return NextResponse.json({ ok: sent > 0, sent });
}
