import { OWNER_EMAIL, OWNER_ID } from "@/lib/sports/gate";

/**
 * Who may operate the FX Scalper: the owner's own account (it trades his live account), plus any email
 * listed in FX_SCALPER_OPERATOR_EMAILS (comma-separated). Being an admin is not enough.
 */
export function isOperator(user: { id: string; email?: string | null }): boolean {
  const email = (user.email ?? "").toLowerCase();
  if (user.id === OWNER_ID || email === OWNER_EMAIL) return true;
  const extra = (process.env.FX_SCALPER_OPERATOR_EMAILS ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  return email !== "" && extra.includes(email);
}
