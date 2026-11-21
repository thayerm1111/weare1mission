/**
 * THE TRADING PLATFORM'S DESTINATIONS (owner 11-20) — one list, read by the bar across the top and by the
 * phone's tabs, so the two can never disagree.
 *
 *   The Floor · OM AI Plays · GENX · Market Pulse · FLOW · Atlas
 *
 * Nothing else is a destination: no community, no courses, no events, no leaderboards. Account, credits,
 * support and sign-out live in the profile menu. Tools the platform no longer features (GEN FX, Cashtrap,
 * MFXGHOST, AURIC, Rapid, the standalone OM AI) are simply not listed here — their pages, records and
 * workers are untouched, and a link straight to one still opens it.
 *
 * Pure: no server or browser imports.
 */
export type NavKey = "floor" | "plays" | "genx" | "pulse" | "flow" | "atlas";

export type NavItem = {
  key: NavKey; label: string; href: string;
  /** The phone tab's word. Absent: reached through "Tools" on a phone. */
  tab?: string;
  /** Opened as a full page load: the Command Center brings its own frame and first-open introduction. */
  hard?: boolean;
};

export const NAV: NavItem[] = [
  { key: "floor", label: "The Floor", href: "/portal/trading", tab: "Floor" },
  { key: "plays", label: "OM AI Plays", href: "/portal/signals", tab: "Plays" },
  { key: "genx", label: "GENX", href: "/portal/genx" },
  { key: "pulse", label: "Market Pulse", href: "/portal/trading?view=pulse" },
  { key: "flow", label: "FLOW", href: "/portal/trading?view=flow", tab: "FLOW" },
  { key: "atlas", label: "Atlas", href: "/command-center", tab: "Atlas", hard: true },
];

/** The phone's tabs, in the order the thumb meets them: Floor, Plays, Atlas, FLOW — then Tools. */
export const TAB_ORDER: NavKey[] = ["floor", "plays", "atlas", "flow"];

/** What "Tools" opens on a phone. */
export const TOOLS_SHEET: { key: NavKey; label: string; line: string; href: string }[] = [
  { key: "genx", label: "GENX", line: "Analyze gold", href: "/portal/genx" },
  { key: "pulse", label: "Market Pulse", line: "Scan the markets", href: "/portal/trading?view=pulse" },
];

/** Which destination a page belongs to. An inline Floor view (?view=) lights the tool it shows. */
export function activeKey(pathname: string, view: string | null | undefined): NavKey | null {
  const p = (pathname || "").replace(/\/+$/, "") || "/";
  if (p === "/command-center" || p.startsWith("/command-center/") || p.startsWith("/portal/command-center")) return "atlas";
  if (p === "/portal/signals" || p.startsWith("/portal/signals/")) return "plays";
  if (p === "/portal/genx" || p.startsWith("/portal/genx/")) return "genx";
  if (p === "/portal/trading" || p === "/portal" || p === "/floor-preview") {
    const v = String(view ?? "").toLowerCase();
    if (v === "flow") return "flow";
    if (v === "pulse") return "pulse";
    if (v === "genx") return "genx";
    if (v === "signals") return "plays";
    return "floor";
  }
  return null;
}

/* ── who sees the new shell ────────────────────────────────────────────────────────────────────── */

export const SHELL_COOKIE = "om_shell";

/**
 * The redesign is a PREVIEW until the owner has reviewed it: only an admin who has switched it on sees
 * it. A member's cookie alone does nothing — the role is read on the server — so nobody can put
 * themselves into an unfinished screen, and the classic portal keeps working for everyone meanwhile.
 */
export function wantsNextShell(cookieValue: string | null | undefined, isAdmin: boolean): boolean {
  return isAdmin === true && cookieValue === "next";
}

/* ── stepping the public site's chrome aside ───────────────────────────────────────────────────── */

/**
 * Applied while the shell is on screen (class on <html>, as the Command Center does it). The page behind the shell is
 * the chosen look's canvas: Stone by default, Graphite with its class (lib/floor/look.ts).
 */
export const SHELL_CSS =
  "html.om-shell,html.om-shell body{background:#f5f4f1!important}" +
  "html.om-shell.om-look-graphite,html.om-shell.om-look-graphite body{background:#1a1a1d!important}" +
  "html.om-shell body>header,html.om-shell body>footer{display:none!important}" +
  "html.om-shell [data-om-splash],html.om-shell [data-om-chrome]{display:none!important}" +
  "html.om-shell body>div[data-no-i18n].fixed{display:none!important}" +     // language moves into the account menu
  "html.om-shell #main{flex:1 1 auto}" +
  "html.om-shell{color-scheme:light}html.om-shell.om-look-graphite{color-scheme:dark}" +
  ".om-app .om-bell>button{width:42px!important;height:42px!important;border-color:var(--om-edge-2)!important;background:rgb(var(--om-fg) / .06)!important;color:var(--om-text)!important}";

/**
 * Runs before the first paint, so the public header never flashes above the shell and the page never shows the other
 * look first: the member's look (Stone unless they chose Graphite) and the browser's bar colour to match it.
 */
export const SHELL_SCRIPT =
  "(function(){try{var d=document.documentElement;d.classList.add('om-shell');var g=false;try{g=localStorage.getItem('om-look')==='graphite';}catch(e){}" +
  "d.classList.toggle('om-look-graphite',g);d.classList.toggle('om-dark',g);" +
  "var m=document.querySelector('meta[name=\"theme-color\"]');if(m)m.setAttribute('content',g?'#1a1a1d':'#f5f4f1');}catch(e){}})();";
