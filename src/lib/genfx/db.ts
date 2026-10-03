/**
 * GEN FX — ASKING THE DATABASE ABOUT A LONG LIST.
 *
 * A filter like "id is one of these two hundred" travels in the request's address, and an address has a
 * length limit: past it the request is refused, and a reader that treats a refusal as "no rows" quietly
 * finds nobody. So a long list is asked for a hundred at a time. If any part fails, the whole answer is
 * marked not ok — part of a list is not the list.
 */
export async function byIds<T>(ids: string[], run: (chunk: string[]) => PromiseLike<{ data: unknown; error: unknown }>, size = 100): Promise<{ rows: T[]; ok: boolean }> {
  const rows: T[] = [];
  const all = [...new Set(ids)];
  for (let i = 0; i < all.length; i += size) {
    try {
      const { data, error } = await run(all.slice(i, i + size));
      if (error || !Array.isArray(data)) return { rows, ok: false };
      rows.push(...(data as T[]));
    } catch { return { rows, ok: false }; }
  }
  return { rows, ok: true };
}
