const LOGIN_FALLBACK = "/portal";
const VALIDATION_ORIGIN = "https://one-mission.invalid";

/** Accept one root-relative destination, without allowing URL normalization to leave this site. */
export function safeLoginRedirect(redirect: unknown): string {
  if (typeof redirect !== "string" || !redirect.startsWith("/") || redirect.startsWith("//")) return LOGIN_FALLBACK;
  // Browsers treat backslashes as slashes in URL paths and discard some control characters.
  if (/[\\\u0000-\u001f\u007f]/.test(redirect)) return LOGIN_FALLBACK;
  try {
    const target = new URL(redirect, VALIDATION_ORIGIN);
    if (target.origin !== VALIDATION_ORIGIN || target.pathname.startsWith("//")) return LOGIN_FALLBACK;
    return target.pathname + target.search + target.hash;
  } catch {
    return LOGIN_FALLBACK;
  }
}
