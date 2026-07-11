/** Shared date/time formatting for the member portal. */
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return "";
  }
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "";
  try {
    return new Intl.DateTimeFormat(undefined, { month: "long", day: "numeric", year: "numeric" }).format(new Date(iso));
  } catch {
    return "";
  }
}
