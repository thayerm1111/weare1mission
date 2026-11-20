/**
 * A QUESTION HANDED OVER FROM THE FLOOR (owner 11-20: The Floor's Atlas panel has an "Ask Atlas…" box and
 * prompt suggestions; "preserve the Command Center's full experience and its first-open introduction").
 *
 * The Floor does not answer for ATLAS. It leaves the member's question in the browser tab's own session
 * storage and opens the Command Center; the desk asks it — through the same `ask` its own chips use — once
 * the member is inside and the entrance has finished. So ATLAS's window, its price and its confirmation
 * stay where they have always been (PassGate), and the entrance plays exactly as before.
 *
 * It is asked ONCE: taking the question removes it, so a reload, a renewed window or coming back later
 * cannot ask it a second time. A question older than ten minutes is dropped — it was asked about a market
 * that has moved on. Nothing here touches the microphone.
 *
 * Pure apart from the storage it is handed, so the rules are tested without a browser.
 */
export const FLOOR_ASK_KEY = "om:atlas:ask";
/** Fired by PassGate when the member is inside and no entrance is on screen (it finished, or was not due). */
export const ATLAS_ENTERED_EVENT = "om-atlas-entered";
export const FLOOR_ASK_MAX_AGE_MS = 10 * 60_000;
export const FLOOR_ASK_MAX_LEN = 400;

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Leave a question for the Command Center — or, with none, clear any that was waiting. */
export function leaveFloorQuestion(store: Store, question: string | null, nowMs: number): void {
  const q = (question ?? "").trim().slice(0, FLOOR_ASK_MAX_LEN);
  if (!q) { store.removeItem(FLOOR_ASK_KEY); return; }
  store.setItem(FLOOR_ASK_KEY, JSON.stringify({ q, at: nowMs }));
}

/** The waiting question, removed as it is read. Null when there is none, it is too old, or it is not a question. */
export function takeFloorQuestion(store: Store, nowMs: number): string | null {
  const raw = store.getItem(FLOOR_ASK_KEY);
  if (raw == null) return null;
  store.removeItem(FLOOR_ASK_KEY);
  try {
    const j = JSON.parse(raw) as { q?: unknown; at?: unknown };
    if (typeof j.q !== "string" || typeof j.at !== "number" || !Number.isFinite(j.at)) return null;
    const age = nowMs - j.at;
    if (age < -60_000 || age > FLOOR_ASK_MAX_AGE_MS) return null;
    const q = j.q.trim().slice(0, FLOOR_ASK_MAX_LEN);
    return q ? q : null;
  } catch { return null; }
}
