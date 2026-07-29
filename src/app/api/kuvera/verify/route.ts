import { type NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * ConectivGlobal / Kuvera membership verification.
 *
 * Given a member's Kuvera login (distributor id, username, or email) plus their
 * Conectiv password, we ask Conectiv's verifylogin API whether the login is
 * valid and the membership is active, then decide whether to grant access.
 *
 * SECURITY: the password is sent server-side over HTTPS to Conectiv ONLY — it is
 * never stored, never logged, and never returned to the client. The app key and
 * token are read from environment variables, never hard-coded in the repo.
 *
 * Access rule: allow when the login SUCCEEDS *and* Active_Level is "Active" *and*
 * "Physical access only" is not "Yes". Everything else is denied (with a reason).
 */
// Requests go through the static-IP relay proxy (proxy.weare1mission.com),
// which is the single address ConectivGlobal whitelists — Vercel's own IPs
// rotate and would be blocked. The proxy requires the X-Relay-Key header
// (KUVERA_RELAY_KEY) so it's not an open relay. Override the whole URL with
// KUVERA_VERIFY_URL if the endpoint ever changes.
const BASE = process.env.KUVERA_VERIFY_URL || "https://proxy.weare1mission.com/coneqtx/qkuvera/hmember.dhtml";
const RELAY_KEY = process.env.KUVERA_RELAY_KEY;

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

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export async function POST(req: NextRequest) {
  const appkey = process.env.KUVERA_APPKEY;
  const fromapi = process.env.KUVERA_FROMAPI;
  const fromapiuser = process.env.KUVERA_FROMAPIUSER;
  if (!appkey || !fromapi || !fromapiuser) {
    return json({ error: "notConfigured", reason: "Membership verification isn't connected yet." }, 200);
  }

  let body: { login?: unknown; password?: unknown };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const login = typeof body?.login === "string" ? body.login.trim() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  if (!login || !password) {
    return json({ error: "missing_fields", reason: "Enter your Kuvera ID / username / email and your Conectiv password." }, 400);
  }

  // Build the verify URL server-side. Never logged.
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
      if (m) { try { data = JSON.parse(m[0]); } catch { data = null; } }
    }
  } catch {
    return json({ error: "upstream_unreachable", reason: "Couldn't reach the membership service — try again shortly." }, 502);
  }

  if (!data || typeof data !== "object") {
    return json({ ok: true, allowed: false, reason: "invalid_login", detail: "That login wasn't recognised." }, 200);
  }

  const result = pick(data, "Result");
  const activeLevel = pick(data, "Active_Level", "ActiveLevel");
  const physicalOnlyRaw = pick(data, "Physical access only", "PhysicalAccessOnly");
  const regProduct = pick(data, "Reg Product", "RegProduct");

  const success = /success/i.test(result);
  const active = /^active$/i.test(activeLevel.trim());
  const physicalOnly = /^yes$/i.test(physicalOnlyRaw.trim());

  const allowed = success && active && !physicalOnly;
  const reason = !success ? "invalid_login" : physicalOnly ? "physical_access_only" : !active ? "inactive_membership" : "ok";

  const membership = {
    distid: pick(data, "Distid", "distid"),
    username: pick(data, "Username"),
    email: pick(data, "Email"),
    name: [pick(data, "First"), pick(data, "Last")].filter(Boolean).join(" ").trim(),
    regProduct,
    activeLevel,
    userType: pick(data, "User Type", "UserType"),
    enrollerId: pick(data, "Enroller ID", "EnrollerID"),
    physicalOnly,
    phone: pick(data, "Phone"),
    site: pick(data, "Site"),
  };

  return json({ ok: true, allowed, reason, membership }, 200);
}
