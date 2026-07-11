/**
 * Membership tiers & role-based access control for the member portal.
 * Tiers are ordered — a member can see any content at or below their tier.
 * Admins can see everything.
 *
 * Edit the tier labels/order here to match your real membership levels.
 */
export const TIERS = ["starter", "core", "elite"] as const;
export type Tier = (typeof TIERS)[number];
export type Role = "member" | "admin";

export const TIER_LABELS: Record<Tier, string> = {
  starter: "Starter",
  core: "Core",
  elite: "Elite",
};

/** Numeric rank of a tier (higher = more access). */
export function tierRank(tier: string | null | undefined): number {
  const i = TIERS.indexOf((tier ?? "starter") as Tier);
  return i === -1 ? 0 : i;
}

/** Can a member with `userTier`/`role` access content requiring `requiredTier`? */
export function canAccess(
  userTier: string | null | undefined,
  role: string | null | undefined,
  requiredTier: string | null | undefined
): boolean {
  if (role === "admin") return true;
  return tierRank(userTier) >= tierRank(requiredTier);
}
