/**
 * Keep signal annotations in their actual price-line order. Only the text baseline moves: clustered
 * labels are spaced forward, then brought back inside the bottom edge together, never jumped over
 * an earlier label. Very short plots reduce spacing only when the requested gap cannot fit at all.
 */
export function orderedLevelLabels<T extends { ly: number }>(
  levels: readonly T[], top: number, bottom: number, gap = 16,
): (T & { labelY: number })[] {
  const labels = levels.map((level) => ({ ...level, labelY: Math.max(top, Math.min(bottom, level.ly - 6)) }))
    .sort((a, b) => a.ly - b.ly);
  const step = labels.length > 1 ? Math.min(gap, Math.max(0, bottom - top) / (labels.length - 1)) : gap;
  for (let i = 1; i < labels.length; i++) labels[i].labelY = Math.max(labels[i].labelY, labels[i - 1].labelY + step);
  if (labels.length) labels[labels.length - 1].labelY = Math.min(bottom, labels[labels.length - 1].labelY);
  for (let i = labels.length - 2; i >= 0; i--) labels[i].labelY = Math.min(labels[i].labelY, labels[i + 1].labelY - step);
  return labels;
}

/** A compact monospace tag may shorten its name, but never its exact formatted price. */
export function levelTag(label: string, price: string, maxWidth: number): { text: string; width: number } {
  const cell = 7, padding = 18;
  const name = label.trim();
  const budget = Math.max(0, Math.floor((maxWidth - padding) / cell) - price.length - 1);
  const shortened = name.length <= budget ? name : budget > 1 ? name.slice(0, budget - 1) + "…" : "";
  const text = shortened ? `${shortened} ${price}` : price;
  return { text, width: Math.min(Math.max(0, maxWidth), text.length * cell + padding) };
}
