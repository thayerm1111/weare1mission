import { type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * 14-DAY FREE TRIAL — self-serve registration (owner directive 09-05).
 *
 * The /join page posts here. One call does everything a trial needs:
 *   1. Creates the auth user with the email pre-confirmed (no verification
 *      email, no friction — the member is signing in seconds later).
 *   2. AUTO-APPROVES the profile: status 'active' + access_expires_at set
 *      14 days out. Expiry is enforced on READ by getProfile()'s existing
 *      accessExpired() logic — the day the trial lapses the portal pauses
 *      the account automatically. No cron, no schema change.
 *   3. Grants the 200 trial credits through add_purchased_credits, guarded
 *      by the credit_transactions ledger (feature 'trial_welcome') so the
 *      grant is idempotent — nobody can be granted twice.
 *
 * Referral attribution: ?ref=<username> on /join flows through the same
 * user_metadata key (referred_by_username) the standard signup uses, so the
 * existing profile trigger credits the referrer exactly as it always has.
 */
const TRIAL_DAYS = 14;
const TRIAL_CREDITS = 200;
const TRIAL_FEATURE = "trial_welcome";

const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Light abuse brake — best-effort per-instance: N sign-ups per IP per window.
const hits = new Map<string, { n: number; at: number }>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now - h.at > 15 * 60_000) { hits.set(ip, { n: 1, at: now }); return false; }
  h.n += 1;
  return h.n > 5;
}

export async function POST(req: NextRequest) {
  let body: { name?: string; email?: string; password?: string; ref?: string; website?: string } = {};
  try { body = await req.json(); } catch { /* validated below */ }

  // Honeypot: real people never fill the invisible "website" field.
  if (typeof body.website === "string" && body.website.trim() !== "") return json({ ok: true }, 200);

  const name = String(body.name ?? "").trim().slice(0, 120);
  const email = String(body.email ?? "").trim().toLowerCase().slice(0, 200);
  const password = String(body.password ?? "");
  const ref = String(body.ref ?? "").trim().toLowerCase().slice(0, 80);

  if (!name) return json({ ok: false, error: "Please enter your name." }, 200);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ ok: false, error: "Please enter a valid email address." }, 200);
  if (password.length < 8) return json({ ok: false, error: "Your password needs at least 8 characters." }, 200);

  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  if (rateLimited(ip)) return json({ ok: false, error: "Too many sign-ups from this connection — try again in a few minutes." }, 200);

  const admin = createAdminClient();
  if (!admin) return json({ ok: false, error: "Registration isn't available right now — please try again soon." }, 200);

  // 1) Create the auth user, email pre-confirmed. Same metadata keys as the
  //    standard signup so the existing profile trigger does its usual work.
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: name, ...(ref ? { referred_by_username: ref } : {}) },
  });
  if (createErr || !created?.user) {
    const msg = String(createErr?.message ?? "").toLowerCase();
    if (msg.includes("already") || msg.includes("registered") || msg.includes("exists")) {
      return json({ ok: false, error: "already_registered", detail: "That email already has an account — log in instead." }, 200);
    }
    return json({ ok: false, error: "Couldn't create your account — please try again." }, 200);
  }
  const userId = created.user.id;
  const accessExpiresAt = new Date(Date.now() + TRIAL_DAYS * 86400_000).toISOString();

  // 2) AUTO-APPROVE with the trial window. The signup trigger normally creates
  //    the profile row; give it a moment, then update — or create the row
  //    ourselves if the trigger didn't (belt and braces, never both-lost).
  let approved = false;
  for (let i = 0; i < 4 && !approved; i++) {
    const { data: row } = await admin.from("profiles").select("id").eq("id", userId).maybeSingle();
    if (row) {
      const { error: upErr } = await admin.from("profiles")
        .update({ status: "active", access_expires_at: accessExpiresAt, full_name: name })
        .eq("id", userId);
      approved = !upErr;
      break;
    }
    await sleep(500);
  }
  if (!approved) {
    const { error: insErr } = await admin.from("profiles").insert({
      id: userId, email, full_name: name, role: "member", tier: "starter",
      status: "active", access_expires_at: accessExpiresAt,
    });
    if (insErr) {
      // Retry the update once more — the trigger may have landed between checks.
      const { error: upErr2 } = await admin.from("profiles")
        .update({ status: "active", access_expires_at: accessExpiresAt, full_name: name })
        .eq("id", userId);
      approved = !upErr2;
    } else approved = true;
  }
  if (!approved) return json({ ok: false, error: "Your account was created but couldn't be activated — contact support and we'll fix it right away." }, 200);

  // 3) The 200 trial credits — ledger-guarded so it can never double-grant.
  try {
    const { data: prior } = await admin.from("credit_transactions")
      .select("id").eq("user_id", userId).eq("feature", TRIAL_FEATURE).limit(1).maybeSingle();
    if (!prior) {
      await admin.rpc("add_purchased_credits", { p_user: userId, p_amount: TRIAL_CREDITS, p_feature: TRIAL_FEATURE });
    }
  } catch { /* credits are best-effort — the account itself is live either way */ }

  return json({ ok: true, trialDays: TRIAL_DAYS, credits: TRIAL_CREDITS, accessExpiresAt }, 200);
}
