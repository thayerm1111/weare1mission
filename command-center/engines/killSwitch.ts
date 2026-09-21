/**
 * THE OFF SWITCH.
 *
 * `CC_AUTOPILOT=live` decides whether the trading loop exists at all, and changing it means a Railway
 * deploy and a worker restart. That is the wrong instrument for the thing an owner actually needs at
 * two in the morning, which is to stop it NOW, from a phone, without waiting for a build.
 *
 * So Atlas shares the switch FLOW and GENX already use — the same single `flow_switches` row, read
 * on the same cadence, with the same meaning:
 *
 *   OFF stops NEW entries. Open positions keep being managed.
 *
 * That distinction is the whole design. A switch that also flattened would turn "pause this" into "take
 * every open loss right now at market", which is a decision about money disguised as a safety control.
 * Stops keep moving to break-even, targets keep being taken, and nothing new is opened.
 *
 * STICKY OFF — THE PART THAT MATTERS.
 *
 * FLOW's reader fails OPEN: it cannot read the row, it assumes enabled. That is defensible for an
 * engine that has run for months. It is not defensible one second after somebody has hit the kill
 * switch, because the next database hiccup would quietly resume trading. So once this has seen OFF, it
 * stays OFF until it successfully reads ON again. A failed read never re-enables anything.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let admin: SupabaseClient | null = null;
function db(): SupabaseClient | null {
  if (admin) return admin;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  admin = createClient(url, key, { auth: { persistSession: false } });
  return admin;
}

/** How long a reading is trusted. Short enough that "off" means off within a tick or two. */
const TTL_MS = 10_000;

let cached: { at: number; on: boolean } | null = null;
/** Set the first time OFF is ever seen. A read failure after this point can never answer "on". */
let latchedOff = false;

export type SwitchState = { on: boolean; reason: string };

/**
 * THE LATCH, AS ARITHMETIC.
 *
 * Separated from the database call so the one rule that matters can be tested without one: a failed
 * read must never be able to turn Atlas back on after somebody has switched it off.
 *
 * `reading` is what the database said — `null` when it could not be reached or the query threw.
 */
export function nextSwitchState(
  prev: { latchedOff: boolean; lastKnownOn: boolean | null },
  reading: boolean | null,
): { on: boolean; latchedOff: boolean; reason: string } {
  if (reading === false) {
    return { on: false, latchedOff: true, reason: "Switched off from the admin panel." };
  }
  if (reading === true) {
    // An explicit, successful ON is the only thing that clears the latch.
    return { on: true, latchedOff: false, reason: "" };
  }
  // The read failed.
  if (prev.latchedOff) {
    return { on: false, latchedOff: true, reason: "Switched off, and the switch cannot be re-read." };
  }
  return { on: prev.lastKnownOn ?? true, latchedOff: false, reason: "" };
}

/**
 * May Atlas open new positions right now?
 *
 * Never throws. A caller on the trading path must always get an answer, and the answer when nothing is
 * known is the conservative one.
 */
export async function brainEnabled(): Promise<SwitchState> {
  const now = Date.now();
  if (cached && now - cached.at < TTL_MS) {
    return { on: cached.on, reason: cached.on ? "" : "Switched off from the admin panel." };
  }

  let reading: boolean | null = null;
  const c = db();
  if (c) {
    try {
      const { data, error } = await c
        .from("flow_switches")
        .select("brain_enabled")
        .eq("id", 1)
        .maybeSingle();
      if (error) throw new Error(error.message);
      // A missing row or a null column means nobody has ever switched it off — the FLOW convention.
      reading = (data as { brain_enabled?: boolean | null } | null)?.brain_enabled !== false;
    } catch {
      reading = null;
    }
  }

  const next = nextSwitchState({ latchedOff, lastKnownOn: cached?.on ?? null }, reading);
  latchedOff = next.latchedOff;
  // Only a real reading refreshes the cache clock; a failure must not extend a stale "on".
  if (reading !== null) cached = { at: now, on: next.on };

  return { on: next.on, reason: next.reason };
}

/** For tests and for the worker's boot line. Does not read the database. */
export function killSwitchLatched(): boolean {
  return latchedOff;
}

/** Test seam only — resets the module's memory between cases. */
export function __resetKillSwitch(): void {
  cached = null;
  latchedOff = false;
}
