import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  connect, disconnect, listForUser, selectAccount, authorizeLive, setPermissions, setAutoTrading,
  session, goldInstrument, syncAccountState, PERMISSION_KEYS, type PermissionKey,
} from "../../../../../command-center/engines/broker";
import { encryptionAvailable } from "../../../../../command-center/core/crypto";
import { hasDeveloperKey } from "../../../../../command-center/adapters/tradelocker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 45;

/**
 * BROKER CONNECTION — one member's own TradeLocker accounts.
 *
 * Every action is scoped to the signed-in user. There is no parameter anywhere in this file that can
 * address somebody else's connection: the user id comes from the session, never from the request body.
 *
 * The password is used once, to sign in, and is never stored. Only the refresh token is kept, encrypted.
 */
function json(o: unknown, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

/**
 * Servers this member has already signed into elsewhere on the desk.
 *
 * TradeLocker server names are brand strings with no discoverable list and unforgiving spelling —
 * "GenFX" is not "Genx" — so making somebody retype one from memory is a trap. We surface the ones they
 * have demonstrably used, with the matching email. NOTHING secret is read: no tokens, no passwords.
 */
async function knownServers(userId: string): Promise<{ server: string; email: string; env: string }[]> {
  const admin = createAdminClient();
  if (!admin) return [];
  try {
    const { data } = await admin
      .from("flow_broker_connections")
      .select("server, email, environment, updated_at")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false })
      .limit(20);
    const seen = new Set<string>();
    const out: { server: string; email: string; env: string }[] = [];
    for (const r of (data ?? []) as { server: string | null; email: string | null; environment: string | null }[]) {
      if (!r.server || !r.email) continue;
      const env = r.environment === "live" ? "live" : "demo";
      const k = `${r.server.toLowerCase()}|${r.email.toLowerCase()}|${env}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ server: r.server, email: r.email, env });
    }
    return out.slice(0, 6);
  } catch { return []; }
}

export async function GET() {
  const supabase = createClient();
  if (!supabase) return json({ error: "not_configured" }, 503);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  const [accounts, known] = await Promise.all([listForUser(user.id), knownServers(user.id)]);
  return json({
    ok: true,
    accounts,
    known,
    ready: encryptionAvailable(),
    developerKey: hasDeveloperKey(),
    notice: encryptionAvailable() ? null : "Broker connections are unavailable until an encryption key is configured on the server.",
  });
}

export async function POST(req: Request) {
  const supabase = createClient();
  if (!supabase) return json({ error: "not_configured" }, 503);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const action = String(body.action ?? "");

  switch (action) {
    case "connect": {
      const env = body.env === "live" ? "live" : "demo";
      const server = String(body.server ?? "").trim();
      const email = String(body.email ?? "").trim();
      const password = String(body.password ?? "");
      if (!server || !email || !password) return json({ ok: false, reason: "Server, email and password are all required." }, 400);
      const r = await connect(user.id, { env, server, email, password, label: body.label ? String(body.label) : undefined });
      return json(r, r.ok ? 200 : 400);
    }

    case "disconnect": {
      await disconnect(user.id, String(body.connectionId ?? ""));
      return json({ ok: true });
    }

    case "select": {
      await selectAccount(user.id, String(body.accountRowId ?? ""));
      return json({ ok: true, accounts: await listForUser(user.id) });
    }

    case "refresh": {
      const s = await session(user.id, String(body.accountRowId ?? ""));
      if (!s.ok) return json({ ok: false, reason: s.reason, needsReconnect: s.needsReconnect }, 400);
      const state = await syncAccountState(s.session);
      const inst = await goldInstrument(s.session, body.force === true);
      return json({
        ok: true,
        state,
        instrument: inst.ok
          ? { name: inst.spec.name, pipSize: inst.resolved.pipSize, minLot: inst.resolved.instrument.minLot, lotStep: inst.resolved.instrument.lotStep, source: inst.resolved.source, warnings: inst.resolved.warnings }
          : null,
        instrumentProblem: inst.ok ? null : inst.reason,
      });
    }

    /**
     * Turning on live trading is its own deliberate step. Connecting an account and being willing for
     * real money to move are two different decisions, and the product treats them that way.
     */
    case "authorize_live": {
      if (body.confirm !== true) return json({ ok: false, reason: "Live trading must be confirmed explicitly." }, 400);
      const ok = await authorizeLive(user.id, String(body.accountRowId ?? ""));
      return json({ ok, accounts: await listForUser(user.id) });
    }

    case "permissions": {
      const patch: Partial<Record<PermissionKey, boolean>> = {};
      for (const k of PERMISSION_KEYS) if (typeof body[k] === "boolean") patch[k] = body[k] as boolean;
      const next = await setPermissions(user.id, String(body.accountRowId ?? ""), patch);
      return json({ ok: next != null, permissions: next });
    }

    case "auto_trading": {
      const on = body.on === true;
      const ok = await setAutoTrading(user.id, String(body.accountRowId ?? ""), on);
      return json({
        ok,
        reason: ok ? null : "Automatic trading cannot be enabled on a live account until live trading is authorised on it.",
        accounts: await listForUser(user.id),
      });
    }

    default:
      return json({ error: "unknown_action" }, 400);
  }
}
