/**
 * Is a box wholly on screen — and clear of what the site keeps pinned over the edges of it (the header
 * along the top; the language button in the bottom-left corner, which on a phone sits exactly where
 * a card's left-hand button would be)?
 *
 * Used where something a member has to answer opens BELOW the thing they tapped. On a desktop that is
 * in view. On a phone it is usually under the bottom of the screen: they tap, and as far as they can
 * see nothing happens (owner 10-07: "people can't set up the auto feature for Gen FX" — the question
 * that switch asks opened 210 pixels below it). The caller brings the box into view when this says no.
 */
export const PINNED = { top: 96, bottom: 72 };

export function clearlyInView(box: { top: number; bottom: number }, viewportHeight: number, pinned: { top: number; bottom: number } = PINNED): boolean {
  if (!Number.isFinite(box.top) || !Number.isFinite(box.bottom) || !Number.isFinite(viewportHeight) || viewportHeight <= 0) return false;
  return box.top >= pinned.top && box.bottom <= viewportHeight - pinned.bottom;
}
