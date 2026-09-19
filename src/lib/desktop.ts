/**
 * THE DESKTOP BRIDGE.
 *
 * The desktop application is a SHELL, not a second application. It opens the deployed Command Center in
 * native windows, which means this code runs unchanged on the web and in the app — the only difference
 * is whether the native APIs are there to answer.
 *
 * That is the whole architectural decision, and it is worth being explicit about why. The alternative —
 * a separate client-side build bundled into the binary — means two UIs, two deploys, two sets of bugs,
 * and an installed copy that silently falls behind the website. It would also have to solve
 * authentication again from scratch, because a bundled app has no cookie jar for weare1mission.com.
 * Pointing the window at the real origin makes the session, the API routes and the voice socket work
 * exactly as they already do, and a fix shipped to the web is a fix in the app the moment it reloads.
 *
 * Tauri injects its IPC bridge into remote pages, but the Rust side grants nothing this origin has not
 * been given a capability for. So every call here is a request that can be refused, and every one of
 * them is written to fail into the web behaviour rather than into an error.
 */

/** True only inside the native shell. Tauri defines this on the window it loads. */
export function isDesktop(): boolean {
  return typeof window !== "undefined" && (window as { isTauri?: boolean }).isTauri === true;
}

/**
 * The API module is imported ONLY when running inside the shell.
 *
 * A static import would pull the whole package into the web bundle for the overwhelming majority of
 * members who will never install the desktop app, to do nothing.
 */
async function api() {
  if (!isDesktop()) return null;
  try { return await import("@tauri-apps/api/window"); }
  catch { return null; }
}

export const WINDOW_MAIN = "main";
export const WINDOW_COMPANION = "companion";

export async function setAlwaysOnTop(on: boolean): Promise<boolean> {
  const m = await api();
  if (!m) return false;
  try { await m.getCurrentWindow().setAlwaysOnTop(on); return true; } catch { return false; }
}

/** Resize the floating window to match what it is currently showing. */
export async function setCompanionSize(width: number, height: number): Promise<void> {
  const m = await api();
  if (!m) return;
  try { await m.getCurrentWindow().setSize(new m.LogicalSize(width, height)); } catch { /* refused */ }
}

/**
 * Bring the full Command Center forward.
 *
 * On the web this is a navigation; in the shell the Command Center is a window that already exists and
 * already holds the member's session, their account and the current market state, so it is raised
 * rather than reloaded. That is what makes "open Command Center" feel like one application instead of
 * two — §13 of the specification, and the reason the two windows share an origin.
 */
export async function openCommandCenter(): Promise<void> {
  const m = await api();
  if (!m) {
    if (typeof window !== "undefined") window.location.href = "/command-center";
    return;
  }
  try {
    const w = await m.Window.getByLabel(WINDOW_MAIN);
    if (w) { await w.show(); await w.setFocus(); return; }
  } catch { /* fall through */ }
  if (typeof window !== "undefined") window.location.href = "/command-center";
}

/** Keep the floater visible across desktops and over full-screen apps. Best effort. */
export async function followEverywhere(on: boolean): Promise<void> {
  const m = await api();
  if (!m) return;
  try { await m.getCurrentWindow().setVisibleOnAllWorkspaces(on); } catch { /* refused */ }
}

/**
 * The shell raised this window because the member pressed the shortcut.
 *
 * It is a separate signal from "the window became visible", because only this one means they reached
 * for it deliberately — which is the moment to open the line rather than wait to be asked twice.
 */
export async function onSummoned(fn: () => void): Promise<() => void> {
  if (!isDesktop()) return () => {};
  try {
    const { listen } = await import("@tauri-apps/api/event");
    return await listen("companion://summoned", () => fn());
  } catch {
    return () => {};
  }
}
