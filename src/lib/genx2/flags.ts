/**
 * GENX 2.0 feature flags.
 *
 * Every NEW setup family ships DISABLED and is turned on only after the shared
 * safeguards are verified in production (owner spec: "Enable the completed new
 * families only once the shared safeguards are active and verified").
 *
 * The one-entry account RESERVATION defaults ON, because it can only PREVENT a
 * second concurrent gold entry — it can never create a trade. It is also written
 * fail-open (a reservation read/RPC error allows the entry rather than freezing the
 * desk), so enabling it cannot halt trading.
 *
 * All flags are read from env at call time (no caching) so they can be flipped via
 * Vercel/Railway env without a code change. Values are parsed permissively:
 * "1"/"true"/"on"/"yes" → true; anything else (incl. unset) → the documented default.
 */

function envBool(name: string, dflt: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw === "") return dflt;
  const v = String(raw).trim().toLowerCase();
  if (v === "1" || v === "true" || v === "on" || v === "yes") return true;
  if (v === "0" || v === "false" || v === "off" || v === "no") return false;
  return dflt;
}

/** Master kill-switch for every GENX 2.0 addition. OFF → engine behaves exactly as v1. */
export const genx2Enabled = (): boolean => envBool("GENX2_ENABLED", false);

/** New deterministic setup families (local-range / compression-breakout / breakout-retest).
 *  Requires genx2Enabled() too. Default OFF. */
export const genx2FamiliesEnabled = (): boolean => genx2Enabled() && envBool("GENX2_FAMILIES", false);

/** Per-account one-entry-at-a-time reservation (Rule #1). Default ON, fail-open.
 *  Independent of genx2Enabled so the safeguard can be active before the families. */
export const genx2ReservationEnabled = (): boolean => envBool("GENX2_RESERVATION", true);

/** Cancel a resting GTC entry on signal invalidation/expiry (fast-exec hardening).
 *  Default ON — it only removes an order that is no longer wanted. */
export const genx2CancelOnInvalidation = (): boolean => envBool("GENX2_CANCEL_ON_INVALIDATION", true);

/** Snapshot for logging/handoff — never used to gate logic. */
export function genx2FlagsSnapshot(): Record<string, boolean> {
  return {
    GENX2_ENABLED: genx2Enabled(),
    GENX2_FAMILIES: genx2FamiliesEnabled(),
    GENX2_RESERVATION: genx2ReservationEnabled(),
    GENX2_CANCEL_ON_INVALIDATION: genx2CancelOnInvalidation(),
  };
}
