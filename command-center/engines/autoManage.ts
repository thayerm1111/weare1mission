/**
 * ATLAS, LOOKING AFTER A TRADE IT IS IN.
 *
 * Finding a trade is the easy half. What separates a day trader from a signal caller is the hours
 * afterwards — moving the stop when the trade has earned it, taking something off when the move has
 * paid, tightening when it starts handing back, and getting out when the reason for being in it has
 * gone. Until now Command Center could do all of that, but only when a human pressed the button.
 *
 * Everything this file needs already existed and had no caller:
 *
 *   `protectionFor()` in brain/trade.ts decides what should happen to an open position, and it is
 *   ALREADY STYLE-AWARE — break-even at 0.6R for a QUICK trade, 0.9R for a HOLD, 1.2R for a SWING;
 *   partials at 0.9R / 1.3R / 1.8R; trails at 1.0 / 1.8 / 2.6 ATR. That is the three-styles behaviour
 *   the product promised, sitting in a pure function nothing autonomous ever called.
 *
 *   `manage(..., actor: "brain")` in engines/executor.ts sends the order and refuses anything the
 *   account has not permitted. Its "brain" branch has been unreachable dead code since it was written.
 *
 * So this file is deliberately thin. It reads the position, asks what should happen, and does that —
 * and every interesting decision stays in the two places that already own it. A manager that
 * re-derived its own opinion would be a second brain disagreeing with the first in front of a member.
 *
 * THE RULES IT ADDS:
 *   • It never widens risk. `move_stop` is only ever sent in the direction that reduces exposure.
 *   • It acts on one position at a time and re-reads state between actions, because the price moved.
 *   • It obeys `ai_management` per position and the per-account permissions, both enforced downstream.
 *   • In shadow mode it decides and writes down what it would have done, and sends nothing.
 *   • It manages positions ATLAS opened. FLOW's positions are FLOW's, in this file too.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { MarketSnapshot } from "../core/types";
import { tradeState } from "./tradeLive";
import { manage, type ManageAction } from "./executor";
import { autopilotMode } from "./autopilot";
import { brainOwnsPosition } from "./interlock";

let admin: SupabaseClient | null = null;
function db(): SupabaseClient | null {
  if (admin) return admin;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  admin = createClient(url, key, { auth: { persistSession: false } });
  return admin;
}

/** Don't re-send the same action on the same position inside this window. */
const ACTION_COOLDOWN_MS = 60_000;
const lastAction = new Map<string, { kind: string; at: number }>();

async function note(row: {
  user_id: string; position_id: string; code: string; detail: string;
}) {
  const c = db();
  if (!c) return;
  try {
    await c.from("cc_position_events").insert({
      user_id: row.user_id, position_id: row.position_id,
      code: row.code, detail: row.detail, channel: "stream",
    });
  } catch { /* the log is evidence, not a gate */ }
}

/** Every open Command Center position whose owner left AI management on. */
async function managedPositions(): Promise<{ id: string; user_id: string }[]> {
  const c = db();
  if (!c) return [];
  const { data, error } = await c
    .from("cc_positions")
    .select("id, user_id")
    .is("closed_at", null)
    .eq("ai_management", true)
    .limit(100);
  if (error) return [];
  return (data ?? []) as { id: string; user_id: string }[];
}

/**
 * One management pass across every position ATLAS is allowed to look after.
 *
 * Called from the Command Center worker on the same tick as perception, so a trade is reconsidered
 * as often as the market read is.
 */
export async function autoManageTick(snapshot: MarketSnapshot | null): Promise<string | null> {
  const mode = autopilotMode();
  if (mode === "off") return null;
  if (!snapshot) return null;

  const rows = await managedPositions();
  if (!rows.length) return null;

  const notes: string[] = [];

  for (const r of rows) {
    // Re-read the whole trade for THIS member: metrics, character, health and the style-aware
    // protection call all come back together and all come from the current snapshot.
    /*
     * NEVER TOUCH A TRADE THIS ENGINE DID NOT OPEN.
     *
     * FLOW may be in gold on the same account, running its own strategy and managing its own
     * position. Both engines sharing an account is allowed; one reaching into the other's trade is
     * not, and this is the check that says so out loud rather than relying on the two of them
     * happening to use different tables.
     */
    if (!(await brainOwnsPosition(r.user_id, r.id))) continue;

    let st;
    try { st = await tradeState(r.user_id, snapshot); }
    catch { continue; }
    if (!st.active || !st.positionId || st.positionId !== r.id) continue;

    const prot = st.protection;
    if (!prot || prot.action === "hold") continue;

    const cooldownKey = `${r.id}:${prot.action}`;
    const prev = lastAction.get(cooldownKey);
    if (prev && Date.now() - prev.at < ACTION_COOLDOWN_MS) continue;

    // Translate the decision into an order. Anything without a usable price or fraction is skipped
    // rather than guessed at.
    let action: ManageAction | null = null;
    if (prot.action === "break_even") {
      action = { kind: "break_even" };
    } else if (prot.action === "protect_stop" && prot.price != null) {
      // NEVER WIDEN. A protective stop that sits further from price than the current one is not
      // protection, and this is the last place that can catch it.
      const cur = st.stop;
      const side = st.side;
      const improves =
        cur == null || side == null ? false
        : side === "buy" ? prot.price > cur
        : prot.price < cur;
      if (improves) action = { kind: "move_stop", price: prot.price };
    } else if (prot.action === "partial" && prot.fraction != null && prot.fraction > 0) {
      action = { kind: "partial", fraction: prot.fraction };
    } else if (prot.action === "close") {
      action = { kind: "close" };
    }
    if (!action) continue;

    if (mode === "shadow") {
      lastAction.set(cooldownKey, { kind: prot.action, at: Date.now() });
      await note({
        user_id: r.user_id, position_id: r.id, code: "AUTO_MANAGE_SHADOW",
        detail: `Would ${prot.action.replace("_", " ")}: ${prot.say}`,
      });
      notes.push(`shadow ${prot.action}`);
      continue;
    }

    lastAction.set(cooldownKey, { kind: prot.action, at: Date.now() });
    try {
      const res = await manage(r.user_id, r.id, action, "brain");
      await note({
        user_id: r.user_id, position_id: r.id,
        code: res.ok ? "AUTO_MANAGE" : "AUTO_MANAGE_REFUSED",
        detail: res.ok ? `${prot.action.replace("_", " ")} — ${prot.say}` : res.message,
      });
      notes.push(res.ok ? `${prot.action}` : `refused ${prot.action}`);
    } catch (e) {
      await note({
        user_id: r.user_id, position_id: r.id, code: "AUTO_MANAGE_ERROR",
        detail: String(e).slice(0, 200),
      });
    }
  }

  return notes.length ? `automanage(${mode}) ${notes.join(" · ")}` : null;
}
