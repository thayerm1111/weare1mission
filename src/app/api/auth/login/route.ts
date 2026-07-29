import { type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * weare1mission unified sign-in gate.
 *
 * One branded login. Two doors in:
 *   1. ACTIVE MEMBERSHIP — the member's ID / username / email plus their
 *      Conectiv password is checked live against ConectivGlobal/Kuvera. An
 *      active member is signed in, and their weare1mission account is created
 *      (and kept in password-sync) silently the first time. This is re-checked
 *      on EVERY sign-in, so a lapsed membership loses access automatically.
 *   2. ADMIN-APPROVED — anyone the admin approved in the portal (a normal
 *      weare1mission email + password account) signs in the standard way.
 *
 * The member never sees "Kuvera" — to them it's just the 1 Mission login. The
 * Conectiv password is only ever sent server-side over HTTPS to Conectiv (and,
 * for an active member, used to set their own weare1mission password); it is
 * never stored in plaintext, never logged, and never returned to the client.
 */
// Requests go through the static-IP relay proxy (proxy.weare1mission.com),
// which is the single address ConectivGlobal whitelists — Vercel's own IPs
// rotate and would be blocked. The proxy requires the X-Relay-Key header
// (KUVERA_RELAY_KEY) so it's not an open relay. Override the whole URL with
// KUVERA_VERIFY_URL if the endpoint ever changes.
const BASE = process.env.KUVERA_VERIFY_URL || "https://proxy.weare1mission.com/coneqtx/qkuvera/hmember.dhtml";
const RELAY_KEY = process.env.KUVERA_RELAY_KEY;

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

// Read a value from the upstream JSON tolerant of key casing/spacing/underscores.
function pick(obj: Record<string, unknown>, ...names: string[]): string {
  const norm = (s: string) => s.toLowerCase().replace(/[\s_]+/g, "");
  const keys = Object.keys(obj);
  for (const n of names) {
    const k = keys.find((key) => norm(key) === norm(n));
    if (k != null && obj[k] != null) return String(obj[k]);
  }
  return "";
}

type Verdict =
  | { state: "active"; email: string; name: string }
  | { state: "inactive" }
  | { state: "physical_only" }
  | { state: "not_member" } // valid check, but not an active-membership login → try local
  | { state: "unconfigured" }; // membership check off or unreachable → try local

async function verifyConectiv(login: string, password: string): Promise<Verdict> {
  const appkey = process.env.KUVERA_APPKEY;
  const fromapi = process.env.KUVERA_FROMAPI;
  const fromapiuser = process.env.KUVERA_FROMAPIUSER;
  if (!appkey || !fromapi || !fromapiuser) return { state: "unconfigured" };

  const url = new URL(BASE);
  url.searchParams.set("appkey", appkey);
  url.searchParams.set("fromapi", fromapi);
  url.searchParams.set("fromapiuser", fromapiuser);
  url.searchParams.set("action", "verifylogin");
  url.searchParams.set("distid", login);
  url.searchParams.set("password", password);

  let data: Record<string, unknown> | null = null;
  try {
    const r = await fetch(url.toString(), {
      cache: "no-store",
      headers: RELAY_KEY ? { "X-Relay-Key": RELAY_KEY } : undefined,
    });
    const text = await r.text();
    try {
      data = JSON.parse(text);
    } catch {
      const m = text.match(/\{[\s\S]*\}/); // tolerate stray wrapping text
      if (m) {
        try {
          data = JSON.parse(m[0]);
        } catch {
          data = null;
        }
      }
    }
  } catch {
    // Couldn't reach Conectiv — fall back to local rather than lock everyone out.
    return { state: "unconfigured" };
  }
  if (!data || typeof data !== "object") return { state: "not_member" };

  const success = /success/i.test(pick(data, "Result"));
  if (!success) return { state: "not_member" };
  if (/^yes$/i.test(pick(data, "Physical access only", "PhysicalAccessOnly").trim())) return { state: "physical_only" };
  if (!/^active$/i.test(pick(data, "Active_Level", "ActiveLevel").trim())) return { state: "inactive" };

  const email = pick(data, "Email");
  const name = [pick(data, "First"), pick(data, "Last")].filter(Boolean).join(" ").trim();
  return { state: "active", email, name };
}

export async function POST(req: NextRequest) {
  let body: { login?: unknown; password?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ action: "error", message: "Bad request." }, 400);
  }
  const login = typeof body?.login === "string" ? body.login.trim() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  if (!login || !password) return json({ action: "error", message: "Enter your member ID or email and your password." }, 400);

  const v = await verifyConectiv(login, password);

  if (v.state === "inactive") return json({ action: "blocked", reason: "inactive" });
  if (v.state === "physical_only") return json({ action: "blocked", reason: "physical_only" });

  if (v.state === "active") {
    // Active membership confirmed — provision / refresh their weare1mission
    // account, then tell the client to sign in with the returned email.
    const admin = createAdminClient();
    const email = (v.email || (login.includes("@") ? login : "")).toLowerCase();
    if (!admin || !email) return json({ action: "blocked", reason: "provision_unavailable" });
    try {
      let uid: string | null = null;
      const { data: found } = await admin.rpc("w1m_uid_by_email", { p_email: email });
      uid = (found as string) || null;
      if (!uid) {
        const { data: created, error } = await admin.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
          user_metadata: v.name ? { full_name: v.name } : {},
        });
        if (error || !created?.user) return json({ action: "blocked", reason: "provision_failed" });
        uid = created.user.id;
      } else {
        await admin.auth.admin.updateUserById(uid, { password, email_confirm: true });
      }
      // Active member = approved automatically.
      await admin.from("profiles").update({ status: "active" }).eq("id", uid);
      return json({ action: "signin", email });
    } catch {
      return json({ action: "blocked", reason: "provision_failed" });
    }
  }

  // not_member OR membership check unconfigured/unreachable → let the client try
  // a normal admin-approved email + password sign-in.
  return json({ action: "try_local" });
}
