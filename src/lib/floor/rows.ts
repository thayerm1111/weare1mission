/**
 * EVERY ROW OF A QUERY, A THOUSAND AT A TIME.
 *
 * The site's API returns at most 1,000 rows however large a `limit` is asked for, and says nothing when
 * it cuts the rest off — so a record folded from one request is a record of the newest thousand rows.
 * (That is how the desk record came to count from early November instead of from its October restart.)
 * `make` must build a fresh, deterministically ordered query each time it is called.
 *
 * A page that fails leaves the list short, and that is SAID (`complete: false`), not hidden: a record
 * built on part of the rows is not the record.
 */
export type Paged = { range: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }> };

export async function allRows<T>(make: () => Paged, maxPages = 30): Promise<{ rows: T[]; complete: boolean }> {
  const rows: T[] = [];
  for (let page = 0; page < maxPages; page++) {
    const { data, error } = await make().range(page * 1000, page * 1000 + 999);
    if (error || !Array.isArray(data)) return { rows, complete: false };
    rows.push(...(data as T[]));
    if (data.length < 1000) return { rows, complete: true };
  }
  return { rows, complete: false };
}
