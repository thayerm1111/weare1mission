import { createAdminClient } from "@/lib/supabase/admin";
import { CREDIT_COST } from "@/lib/creditConfig";
import { isFlowPass, type SubRow } from "@/lib/subscription";
import { SETUP_WINDOW_MS, SETUP_MINUTES, type SetupGate } from "@/lib/setupLock";

/**
 * WHO MAY SEE A LIVE SETUP RIGHT NOW (owner 10-05: "Make them use credits to view"). The rule and
 * the reasons are in setupLock.ts; this is the lookup.
 *
 * THE SPEND IS THE PASS, as it is for the Command Center (ccPass.ts): there is no table of windows.
 * The newest credit spent on these setups in the last 30 minutes means the window is open until that
 * spend plus 30 minutes. One source of truth — the ledgers the member already has — and nothing to
 * keep in step with them.
 *
 * WHAT COUNTS AS A SPEND ON THE SETUPS, and where it is read from:
 *   a read            credit_transactions, kind "spend", feature "genx" or "ghost", and an amount
 *                     below zero — a GENX, GEN FX or MFX Ghost read the member was charged for (all
 *                     three are the same engine's play), and "See the play" on a locked card (the
 *                     read's own 5 credits and the read's own ledger line: it is the read without
 *                     the story). Members cannot write to this ledger except by spending.
 *   a FLOW fee        flow_billing_events — a setup or trade fee FLOW charged this member. Read from
 *                     FLOW's own record of the fees it took, NOT from the ledger's "flow_autorun"
 *                     lines: a signed-in member can write one of those themselves for a single credit
 *                     (spend_credits takes the feature's name from the caller), and cannot write here.
 * A FLOW Pass covers both, so it keeps the window open. An admin is not charged for either.
 *
 * FAILS CLOSED, AND SAYS SO. If a ledger, the profile or the subscription cannot be read, that part
 * counts for nothing — the member is shown the locked card for a few seconds — and the answer is
 * marked incomplete, so that "closed" is never mistaken for "certainly has no window": the route
 * that takes credits will not charge on an incomplete answer (setupPass.ts). A locked card costs a
 * paying member one retry; an open one on an error hands the play to everyone.
 */
type Admin = NonNullable<ReturnType<typeof createAdminClient>>;

/** What "See the play" costs: one read. */
export const SETUP_COST = CREDIT_COST.genx;
/** The ledger feature the button is charged under: a read's. */
export const READ_FEATURE = "genx";
/** The ledger features that are a read of this engine's play: GENX and GEN FX ("genx"), MFX Ghost ("ghost"). */
export const READ_FEATURES = ["genx", "ghost"] as const;

const BASE = { cost: SETUP_COST, minutes: SETUP_MINUTES };
/** No window. */
export const CLOSED: SetupGate = { ...BASE, open: false, via: null, until: null };
/** Where there is no sign-in system at all (a development build) there is nobody to charge. */
export const OPEN_UNMETERED: SetupGate = { ...BASE, open: true, via: "admin", until: null };
/** GEN FX while the owner's billing switch is off: "Off = GEN FX costs nothing", and that includes looking. */
export const OPEN_FREE: SetupGate = { ...BASE, open: true, via: "free", until: null };

/** The rule itself, on facts already read. `lastSpendMs` is the newest spend on the setups, from either ledger. */
export function gateFrom(f: { admin: boolean; pass: boolean; lastSpendMs: number | null }, nowMs: number): SetupGate {
  if (f.admin) return { ...BASE, open: true, via: "admin", until: null };
  if (f.pass) return { ...BASE, open: true, via: "pass", until: null };
  const until = f.lastSpendMs != null && Number.isFinite(f.lastSpendMs) ? f.lastSpendMs + SETUP_WINDOW_MS : null;
  if (until != null && until > nowMs) return { ...BASE, open: true, via: "credits", until: new Date(until).toISOString() };
  return CLOSED;
}

/** An answer, and whether every part of it could be read. Incomplete and closed means "could not tell". */
export type SetupLook = { gate: SetupGate; complete: boolean };

/*
 * The Floor's card asks every 15 seconds. An OPEN answer is kept here, per server instance, for a
 * minute or until its window ends, whichever is sooner. A closed answer is never kept: the page that
 * takes the credits and the pages that show the play run on different servers, so a remembered
 * "closed" on one of them would tell a member who has just paid that they are still locked out. A
 * look marked `fresh` always asks the database, and an incomplete answer is never kept.
 */
const OPEN_TTL_MS = 60_000;
const SEEN = new Map<string, { gate: SetupGate; goodUntil: number }>();
/** Forget what was found for this member. */
export const forgetSetupAccess = (userId: string): void => { SEEN.delete(userId); };

export async function lookAtSetupAccess(admin: Admin | null, userId: string, opts: { fresh?: boolean; nowMs?: number } = {}): Promise<SetupLook> {
  const now = opts.nowMs ?? Date.now();
  const hit = SEEN.get(userId);
  if (!opts.fresh && hit && now < hit.goodUntil) return { gate: hit.gate, complete: true };
  if (!admin) return { gate: CLOSED, complete: false };             // cannot look at all
  const since = new Date(now - SETUP_WINDOW_MS).toISOString();
  let complete = true;
  const read = async <T>(q: PromiseLike<{ data: unknown; error: unknown }>): Promise<T | null> => {
    try { const { data, error } = await q; if (error) { complete = false; return null; } return (data ?? null) as T | null; } catch { complete = false; return null; }
  };
  const [paid, fee, prof, sub] = await Promise.all([
    read<{ created_at: string }>(admin.from("credit_transactions").select("created_at").eq("user_id", userId).eq("kind", "spend")
      .in("feature", [...READ_FEATURES]).lt("amount", 0).gte("created_at", since).order("created_at", { ascending: false }).limit(1).maybeSingle()),
    read<{ at: string }>(admin.from("flow_billing_events").select("at").eq("user_id", userId).gt("cost", 0)
      .gte("at", since).order("at", { ascending: false }).limit(1).maybeSingle()),
    read<{ role: string | null }>(admin.from("profiles").select("role").eq("id", userId).maybeSingle()),
    read<SubRow>(admin.from("user_subscriptions").select("*").eq("user_id", userId).maybeSingle()),
  ]);
  const times = [paid?.created_at, fee?.at].map((t) => (t ? Date.parse(t) : NaN)).filter((t) => Number.isFinite(t));
  const gate = gateFrom({ admin: prof?.role === "admin", pass: isFlowPass(sub), lastSpendMs: times.length ? Math.max(...times) : null }, now);
  // Remembered only when it is open and every part was read: a closed answer, or one built on a failed read, is asked for again.
  if (complete && gate.open) SEEN.set(userId, { gate, goodUntil: Math.min(now + OPEN_TTL_MS, gate.until ? Date.parse(gate.until) : Infinity) });
  else SEEN.delete(userId);
  return { gate, complete };
}

/** The window as the pages need it. (What a route that charges needs is lookAtSetupAccess.) */
export async function setupAccess(admin: Admin | null, userId: string, opts: { fresh?: boolean; nowMs?: number } = {}): Promise<SetupGate> {
  return (await lookAtSetupAccess(admin, userId, opts)).gate;
}

/*
 * IS GEN FX FREE RIGHT NOW? The owner's GEN FX billing switch (genfx_control.billing_enabled): with
 * it off a GEN FX read costs nothing, so its setups are not kept back either — a lock under a free
 * read of the same thing would only be a lie about the price. Asked of the switch itself and kept
 * for ten seconds — less than one poll of a card, so a card catches up with the switch on its next
 * look. A switch that cannot be read is not "off": the setups stay locked.
 */
const FX_FREE_TTL_MS = 10_000;
let fxFree: { free: boolean; goodUntil: number } | null = null;
export async function genfxIsFree(admin: Admin | null, nowMs = Date.now()): Promise<boolean> {
  if (fxFree && nowMs < fxFree.goodUntil) return fxFree.free;
  if (!admin) return false;
  try {
    const { data, error } = await admin.from("genfx_control").select("billing_enabled").eq("id", 1).maybeSingle();
    if (error || !data) return false;                       // not kept: asked again next time
    const free = (data as { billing_enabled?: unknown }).billing_enabled === false;
    fxFree = { free, goodUntil: nowMs + FX_FREE_TTL_MS };
    return free;
  } catch { return false; }
}
/** Forget what was read: the switch has just been changed (on this server), or a test wants a clean start. */
export const forgetGenfxFree = (): void => { fxFree = null; };
