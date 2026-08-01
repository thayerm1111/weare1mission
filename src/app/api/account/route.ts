import { type NextRequest } from "next/server";
import { authedContext } from "@/lib/supabase/bearer";

/**
 * DELETE /api/account — App Store-required in-app account deletion.
 *
 * The native app calls this with the member's Bearer token. It authenticates the
 * caller here, but the actual, IRREVERSIBLE erase is intentionally NOT wired yet:
 * deleting an auth user requires the Supabase SERVICE ROLE key (a server-only
 * secret) and a decision about whether "delete" removes the whole One Mission
 * account or only app data. Until that's decided and the key is set, this returns
 * 501 so the app shows a clear "couldn't delete" message rather than a false
 * success. See backend-patch notes in the app repo for the wiring.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "DELETE, OPTIONS",
};
const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS } });

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function DELETE(req: NextRequest) {
  const { user, configured } = await authedContext(req);
  if (!configured) return json({ error: "not_configured" }, 500);
  if (!user) return json({ error: "unauthorized" }, 401);

  // TODO(one-mission): perform deletion with the service role, e.g.
  //   const admin = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  //   await admin.from("profiles").delete().eq("id", user.id);
  //   ...delete related rows (trade_chats, signal_log, ...) per your schema...
  //   await admin.auth.admin.deleteUser(user.id);
  //   return json({ ok: true });
  return json({ error: "not_implemented", note: "Wire deletion to the service role key before shipping." }, 501);
}
