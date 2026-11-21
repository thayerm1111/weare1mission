/**
 * THE ONE MISSION APP (owner 11-21: "Need to make mobile version and app also" — the One Mission app, rebuilt on
 * the new design; "Just me first").
 *
 * The new design IS the app. The same pages are installed from the website to a phone's home screen or a
 * computer's dock and open full screen, with the destinations under the thumb. Nothing comes from an app store
 * and nothing is kept on the device: every screen is the live site, so a price, an account or a play is never a
 * stale copy, and there is no second version of anything to keep in step.
 *
 * Who is offered it: every member (owner 11-21: "push live to everyone"). Pages in the new shell say they can be
 * installed (the manifest link, and "Install the app" in the account menu). The members' older app at /app/ is
 * untouched and keeps working.
 *
 * Pure: no server or browser imports.
 */
export const APP_NAME = "One Mission";
export const APP_MANIFEST = "/om-app/manifest.webmanifest";
/** The canvas colour of the default look (Stone): the browser's own bars and the splash screen match the page under them. */
export const APP_THEME = "#f5f4f1";
/** Atlas keeps its own dark frame in either look (the Command Center's identity), and its bar colour with it. */
export const ATLAS_THEME = "#08090e";

export type InstallKind = "prompt" | "ios" | "android" | "mac-safari" | "desktop" | "none";
export type InstallGuide = { kind: InstallKind; intro: string; steps: string[]; note?: string };

const ON_A_PHONE = "It opens from your home screen like an app: full screen, with your tabs under your thumb.";
const ON_A_COMPUTER = "It opens in its own window, like an app, from your dock or taskbar.";

/**
 * How this browser installs the app. Where the browser can show its own install dialog ("prompt") nothing needs
 * explaining; everywhere else the steps are the browser's own words, in the order the member meets them.
 * `touchPoints` tells an iPad (which reports itself as a Mac) from a Mac.
 */
export function installGuide(ua: string, touchPoints: number, canPrompt: boolean): InstallGuide {
  if (canPrompt) return { kind: "prompt", intro: ON_A_PHONE, steps: [] };
  const ios = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && touchPoints > 1);
  if (ios) {
    return {
      kind: "ios",
      intro: ON_A_PHONE,
      steps: [
        "Tap the Share button: at the bottom of the screen in Safari, or beside the address bar in Chrome.",
        "Choose “Add to Home Screen”. You may need to scroll down the list to find it.",
        "Tap Add. One Mission is on your home screen and opens full screen.",
      ],
      // iPhone keeps a home-screen app's sign-in apart from Safari's, so the first open asks once.
      note: "The first time it opens, sign in once. Your iPhone keeps the app’s sign-in separate from Safari’s.",
    };
  }
  if (/Android/i.test(ua)) {
    return {
      kind: "android",
      intro: ON_A_PHONE,
      steps: [
        "Open the browser’s menu: the three dots at the top right.",
        "Tap “Install app” or “Add to Home screen”.",
        "Confirm. One Mission appears with your other apps and opens full screen.",
      ],
    };
  }
  if (/Firefox\//i.test(ua)) {
    return {
      kind: "none",
      intro: "It opens like an app, in its own window or from a phone's home screen.",
      steps: ["This browser can’t install web apps. Open weare1mission.com in Chrome, Edge or Safari and choose “Install the app” from this menu there."],
    };
  }
  if (/Macintosh/i.test(ua) && /Safari\//i.test(ua) && !/Chrome\/|Chromium\/|Edg\/|OPR\//i.test(ua)) {
    return {
      kind: "mac-safari",
      intro: ON_A_COMPUTER,
      steps: ["In the menu bar, choose File, then “Add to Dock”.", "Click Add. One Mission opens from your Dock in its own window."],
    };
  }
  return {
    kind: "desktop",
    intro: ON_A_COMPUTER,
    steps: [
      "Click the install icon at the right end of the address bar, or open the browser’s menu and choose “Install One Mission” (in Edge it is under Apps).",
      "Click Install. One Mission opens in its own window, and from your dock or taskbar after that.",
    ],
  };
}

/** A same-site path to land on after the preview switch, or null. Never another site: no scheme, no "//". */
export function landingPath(raw: string | null | undefined): string | null {
  const p = String(raw ?? "");
  if (!p.startsWith("/") || p.startsWith("//") || p.startsWith("/\\") || /[\r\n]/.test(p)) return null;
  return p.length > 512 ? null : p;
}

/**
 * Runs before the first paint on the new shell's pages: holds the browser's install offer for "Install the app"
 * instead of letting it pop up on its own, so the member chooses when.
 */
export const APP_INSTALL_SCRIPT =
  "(function(){try{window.addEventListener('beforeinstallprompt',function(e){e.preventDefault();window.__omInstall=e;window.dispatchEvent(new Event('om-install-ready'));});" +
  "window.addEventListener('appinstalled',function(){window.__omInstall=null;window.dispatchEvent(new Event('om-install-ready'));});}catch(e){}})();";
