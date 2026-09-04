/**
 * MATTY PIPS — persistence (best-effort, isolated). Writes ONLY to
 * matty_pips_* tables; if they don't exist yet, everything still works and
 * the analyze call simply isn't archived. Never throws into a caller.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import type { DecisionObject } from "./types";

/** Archive one FIND ME A TRADE result. */
export async function saveAnalysis(userId: string, d: DecisionObject): Promise<void> {
  try {
    const admin = createAdminClient();
    if (!admin) return;
    await admin.from("matty_pips_analysis").insert({
      user_id: userId,
      symbol: d.symbol,
      mode: d.mode,
      status: d.status,
      verdict: d.trade ? "TRADE" : "NO_TRADE",
      score: d.score.total,
      price: d.price,
      decision: d as unknown as Record<string, unknown>,
    });
  } catch { /* table may not exist yet — analysis archive is best-effort */ }
}

/** Append one decision to the audit log (used heavily by auto-trade later). */
export async function logDecision(o: {
  userId: string | null;
  symbol: string;
  kind: string;               // e.g. "analyze", "auto_take", "auto_skip"
  detail: Record<string, unknown>;
}): Promise<void> {
  try {
    const admin = createAdminClient();
    if (!admin) return;
    await admin.from("matty_pips_logs").insert({
      user_id: o.userId, symbol: o.symbol, kind: o.kind, detail: o.detail,
    });
  } catch { /* best-effort */ }
}
