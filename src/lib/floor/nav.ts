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
export type NavKey = "floor" | "plays" | "genx" | "pulse" | "flow" | "atlas" | "strata";

export type NavItem = {
  key: NavKey; label: string; href: string;
  /** The short, always-visible label in the phone's app bar. */
  tab?: string;
  /** Opened as a full page load: the Command Center brings its own frame and first-open introduction. */
  hard?: boolean;
};

export const NAV: NavItem[] = [
  { key: "floor", label: "The Floor", href: "/portal/trading", tab: "Floor" },
  { key: "plays", label: "OM AI Plays", href: "/portal/signals", tab: "Plays" },
  { key: "genx", label: "GENX", href: "/portal/genx", tab: "GENX" },
  { key: "strata", label: "STRATA", href: "/portal/strata", tab: "Strata" },
  { key: "pulse", label: "Market Pulse", href: "/portal/trading?view=pulse", tab: "Pulse" },
  { key: "flow", label: "FLOW", href: "/portal/trading?view=flow", tab: "FLOW" },
  { key: "atlas", label: "Atlas Command Center", href: "/command-center", tab: "Atlas", hard: true },
];

/** Four stable places on a phone. The individual engines keep their canonical destinations. */
export type AppTabKey = "floor" | "atlas" | "tools" | "flow";
export const TAB_ORDER: AppTabKey[] = ["floor", "atlas", "tools", "flow"];
export const APP_TABS: { key: AppTabKey; label: string; href: string; hard?: boolean }[] = [
  { key: "floor", label: "Floor", href: "/portal/trading" },
  // Atlas opens the full gold workspace; Ask Atlas remains a separate assistant action.
  { key: "atlas", label: "Atlas", href: "/command-center", hard: true },
  { key: "tools", label: "Tools", href: "/portal/tools" },
  { key: "flow", label: "FLOW", href: "/portal/trading?view=flow" },
];

export function activeTabKey(pathname: string, view: string | null | undefined): AppTabKey | null {
  if ((pathname || "").replace(/\/+$/, "") === "/portal/tools") return "tools";
  const key = activeKey(pathname, view);
  return key === "genx" || key === "plays" || key === "pulse" || key === "strata" ? "tools" : key;
}

/** Which destination a page belongs to. An inline Floor view (?view=) lights the tool it shows. */
export function activeKey(pathname: string, view: string | null | undefined): NavKey | null {
  const p = (pathname || "").replace(/\/+$/, "") || "/";
  if (p === "/command-center" || p.startsWith("/command-center/") || p.startsWith("/portal/command-center")) return "atlas";
  if (p === "/portal/signals" || p.startsWith("/portal/signals/")) return "plays";
  if (p === "/portal/genx" || p.startsWith("/portal/genx/")) return "genx";
  if (p === "/portal/strata" || p.startsWith("/portal/strata/")) return "strata";
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

/** The value of SHELL_COOKIE with which an admin has chosen the classic portal. */
export const CLASSIC_SHELL = "classic";

type ShellRequestHeaders = { get: (name: string) => string | null };

/** A phone or embedded app must not inherit an admin's desktop support view. */
export function prefersAppShell(request?: ShellRequestHeaders): boolean {
  if (!request) return false;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(request.get("user-agent") ?? "")
    || request.get("sec-ch-ua-mobile") === "?1"
    || /^(iframe|frame)$/.test(request.get("sec-fetch-dest") ?? "");
}

/**
 * WHO SEES THE NEW DESIGN (owner 11-20: a preview, "just me first"; 11-21: "push live to everyone").
 *
 * Every member sees it. The one way back to the classic portal is an admin's own desktop-browser choice from the account menu
 * (/api/floor/preview?on=0 sets the cookie to "classic"), kept for support: a member's cookie does nothing, because
 * the role is read on the server. A member who is pending or suspended keeps the classic portal's notice — that is
 * decided in the portal layout, before this. Phones and embedded apps always retain the new app, even when
 * an earlier admin support session left the long-lived classic cookie behind.
 */
export function wantsNextShell(cookieValue: string | null | undefined, isAdmin: boolean, request?: ShellRequestHeaders): boolean {
  return prefersAppShell(request) || !(isAdmin === true && cookieValue === CLASSIC_SHELL);
}

/**
 * A standalone window and an iPad using a desktop user-agent cannot always be identified by HTTP headers.
 * Only emitted for an admin who still has the classic cookie. Clear that display preference through the
 * existing admin switch, preserving the exact current page; authentication and account settings are unchanged.
 * Clearing also keeps subsequent client-side requests inside a legacy /app iframe on the same shell.
 */
export const APP_SHELL_RECOVERY_SCRIPT =
  "(function(){try{var ua=navigator.userAgent||'';var app=navigator.standalone===true||window.top!==window.self||/Android|iPhone|iPad|iPod|Mobile/i.test(ua)||(/Macintosh/i.test(ua)&&navigator.maxTouchPoints>1)||!!(window.matchMedia&&window.matchMedia('(display-mode: standalone)').matches);" +
  "if(app)location.replace('/api/floor/preview?on=1&to='+encodeURIComponent(location.pathname+location.search+location.hash));}catch(e){}})();";

/* ── stepping the public site's chrome aside ───────────────────────────────────────────────────── */

/**
 * Applied while the shell is on screen (class on <html>, as the Command Center does it). The page behind the shell is
 * the chosen look's canvas: Graphite by default, or a previously chosen Stone look (lib/floor/look.ts).
 */
export const SHELL_CSS =
  "html.om-shell,html.om-shell body{background:#f5f4f1!important}" +
  "html.om-shell.om-look-graphite,html.om-shell.om-look-graphite body{background:#08090b!important}" +
  "html.om-shell body>header,html.om-shell body>footer{display:none!important}" +
  "html.om-shell [data-om-splash],html.om-shell [data-om-chrome]{display:none!important}" +
  "html.om-shell body>div[data-no-i18n].fixed{display:none!important}" +     // language moves into the account menu
  "html.om-shell #main{flex:1 1 auto}" +
  "html.om-shell{color-scheme:light}html.om-shell.om-look-graphite{color-scheme:dark}" +
  ".om-app .om-bell>button{width:42px!important;height:42px!important;border-color:var(--om-edge-2)!important;background:rgb(var(--om-fg) / .06)!important;color:var(--om-text)!important}";

/**
 * Runs before the first paint, so the public header never flashes above the shell and the page never shows the other
 * look first: the member's look (Graphite unless they chose Stone) and the browser's bar colour to match it. And
 * whether this is the installed app — a Home Screen or standalone window, or the earlier app's frame (/app/) — which
 * is drawn as an app (`om-standalone`, om.css): an app bar and a tab bar, not a website's header.
 */
export const SHELL_SCRIPT =
  "(function(){try{var d=document.documentElement;d.classList.add('om-shell');var g=true;try{g=localStorage.getItem('om-look')!=='stone';}catch(e){}" +
  "d.classList.toggle('om-look-graphite',g);d.classList.toggle('om-dark',g);" +
  "var a=false;try{a=window.navigator.standalone===true||!!(window.matchMedia&&window.matchMedia('(display-mode: standalone)').matches)||window.top!==window.self;}catch(e){a=true;}" +
  "d.classList.toggle('om-standalone',a);" +
  "var m=document.querySelector('meta[name=\"theme-color\"]');if(m)m.setAttribute('content',g?'#08090b':'#f5f4f1');}catch(e){}})();";
