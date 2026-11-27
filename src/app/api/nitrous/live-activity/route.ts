import { json, requireUser, unavailable } from "../_shared";

export const dynamic = "force-dynamic";

// The authenticated shell only needs an expiring signal. Keep balances, trades
// and account identifiers inside the Nitrous workspace.
export async function GET() {
  try {
    const auth = await requireUser();
    if ("error" in auth) return auth.error;
    const now = Date.now();
    const { data, error } = await auth.admin.from("nitrous_accounts")
      .select("nitrous_broker_connections!inner(status),nitrous_positions(live_observed_at,close_request_state)")
      .eq("user_id", auth.user.id).eq("environment", "live").neq("status", "disabled")
      .eq("nitrous_broker_connections.user_id", auth.user.id)
      .not("nitrous_broker_connections.status", "in", "(revoked,reconnect_required)")
      .eq("nitrous_positions.user_id", auth.user.id)
      .eq("nitrous_positions.status", "open").is("nitrous_positions.close_requested_at", null)
      .gt("nitrous_positions.current_qty", 0).gt("nitrous_positions.entry", 0)
      .gt("nitrous_positions.live_observed_at", new Date(now - 30_000).toISOString())
      .lte("nitrous_positions.live_observed_at", new Date(now + 5_000).toISOString());
    if (error) return unavailable();
    let activeForMs = 0;
    for (const account of data ?? []) {
      for (const position of account.nitrous_positions ?? []) {
        if (position.close_request_state && position.close_request_state !== "rejected") continue;
        const remaining = Date.parse(position.live_observed_at) + 30_000 - Date.now();
        if (Number.isFinite(remaining)) activeForMs = Math.max(activeForMs, Math.min(30_000, remaining));
      }
    }
    return json({ linked: Boolean(data?.length), activeForMs });
  } catch { return unavailable(); }
}
