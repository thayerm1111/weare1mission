/** A durable reservation must commit before dispatch. Unknown outcomes stay reserved.
 * Database transactions cannot make a broker HTTP request atomic. This deliberately
 * prefers a missed partial over repeating a potentially executed close after a crash. */
export type PartialIntent = { before_qty: number; requested_qty: number };
export interface PartialStore {
  reserve(intent: PartialIntent): Promise<{ created: boolean; intent: PartialIntent }>;
}
export async function partialOnce(
  store: PartialStore, intent: PartialIntent,
  send: () => Promise<{ ok: boolean; error?: string }>,
  readQuantity: () => Promise<number | null>,
): Promise<{ state: 'confirmed'; remaining: number } | { state: 'pending'; error?: string }> {
  if (!(intent.before_qty > 0 && intent.requested_qty > 0 && intent.requested_qty < intent.before_qty)) throw new Error('invalid_partial_quantity');
  const reservation = await store.reserve(intent);
  let error: string | undefined;
  if (reservation.created) {
    try { const r = await send(); if (!r.ok) error = r.error ?? 'partial_rejected'; }
    catch { error = 'partial_outcome_unknown'; }
  }
  let remaining: number | null = null;
  try { remaining = await readQuantity(); } catch { /* keep durable reservation */ }
  const target = reservation.intent.before_qty - reservation.intent.requested_qty;
  if (remaining != null && Number.isFinite(remaining) && remaining > 0 && remaining <= target + 1e-8) return { state: 'confirmed', remaining };
  return { state: 'pending', error };
}
