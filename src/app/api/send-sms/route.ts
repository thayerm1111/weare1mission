import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { isSmsConfigured, sendTexts } from "@/lib/messaging";

/** Sends an SMS to selected members of the caller's downline (verified server-side). */
export async function POST(request: NextRequest) {
  const supabase = createClient();
  if (!supabase) return NextResponse.json({ ok: false, error: "not-configured" }, { status: 503 });

  const profile = await getProfile();
  if (!profile) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (profile.status !== "active" && profile.role !== "admin")
    return NextResponse.json({ ok: false, error: "not-approved" }, { status: 403 });

  if (!isSmsConfigured)
    return NextResponse.json({ ok: false, error: "sms-not-configured" }, { status: 200 });

  const { toIds, message } = await request.json().catch(() => ({}));
  if (!Array.isArray(toIds) || !toIds.length || !message)
    return NextResponse.json({ ok: false, error: "bad-request" }, { status: 400 });

  const { data: downline } = await supabase.rpc("get_my_downline");
  const allowed = new Map<string, string>();
  (downline ?? []).forEach((d: { id: string; phone: string | null }) => {
    if (d.phone) allowed.set(d.id, d.phone);
  });
  const phones = (toIds as string[]).map((id) => allowed.get(id)).filter(Boolean) as string[];
  if (!phones.length) return NextResponse.json({ ok: false, error: "no-valid-recipients" }, { status: 400 });

  const sent = await sendTexts(phones, message);
  return NextResponse.json({ ok: sent > 0, sent });
}
