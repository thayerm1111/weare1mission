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
/** The canvas colour of the default look (Graphite): the browser's bars and the splash screen match the page. */
export const APP_THEME = "#08090b";
/** Atlas keeps its own dark frame in either look (the Command Center's identity), and its bar colour with it. */
export const ATLAS_THEME = "#08090e";

export type InstallKind = "prompt" | "ios" | "android" | "mac-safari" | "desktop" | "none";
export type InstallGuide = { kind: InstallKind; intro: string; steps: string[]; note?: string; browser?: string; help?: string };

const ON_A_PHONE = "Your trading workspace, one tap from your home screen.";
const ON_A_COMPUTER = "Your trading workspace in its own window.";

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
      browser: /CriOS/i.test(ua) ? "Chrome" : /FxiOS/i.test(ua) ? "Firefox" : "Safari",
      steps: [
        "Tap Share in your browser’s toolbar or menu.",
        "Choose “Add to Home Screen”.",
        "Keep “Open as Web App” on if shown, then tap Add.",
      ],
      note: "You may need to sign in once when you first open the app.",
      help: "In Safari, scroll down the Share menu. If Add to Home Screen is missing, tap Edit Actions to add it. You can also open this page in Safari and try again.",
    };
  }
  if (/Android/i.test(ua)) {
    return {
      kind: "android",
      intro: ON_A_PHONE,
      browser: "Android",
      steps: [
        "Open your browser’s three-dot menu.",
        "Tap “Install app” or “Add to Home screen”.",
        "Confirm, then open One Mission from your home screen.",
      ],
    };
  }
  if (/Firefox\//i.test(ua)) {
    return {
      kind: "none",
      intro: ON_A_COMPUTER,
      browser: "Another browser needed",
      steps: ["Open weare1mission.com in Chrome, Edge or Safari, then choose “Install the app” in your account menu."],
    };
  }
  if (/Macintosh/i.test(ua) && /Safari\//i.test(ua) && !/Chrome\/|Chromium\/|Edg\/|OPR\//i.test(ua)) {
    return {
      kind: "mac-safari",
      intro: ON_A_COMPUTER,
      browser: "Safari on Mac",
      steps: ["Choose File → Add to Dock in Safari.", "Click Add, then open One Mission from your Dock."],
    };
  }
  return {
    kind: "desktop",
    intro: ON_A_COMPUTER,
    browser: /Edg\//i.test(ua) ? "Microsoft Edge" : "Your browser",
    steps: [
      "Click the install icon in the address bar, or choose “Install One Mission” from the browser menu.",
      "Click Install, then open One Mission from your dock or taskbar.",
    ],
    help: "In Edge, open the browser menu, then Apps. Installation options depend on your browser and device.",
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
