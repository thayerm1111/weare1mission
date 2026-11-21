"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { installGuide, type InstallGuide } from "@/lib/floor/app";

/**
 * INSTALLING THE ONE MISSION APP from the profile menu (lib/floor/app.ts).
 *
 * Where the browser can show its own install dialog, "Install the app" opens it. Everywhere else (an iPhone, or a
 * browser that has no dialog to offer) it opens a short card with that browser's own steps. Running as the
 * installed app, the item is not shown at all.
 */
type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };
type InstallWindow = Window & { __omInstall?: InstallEvent | null };

/** Running as the installed app: an iPhone home-screen app, or any browser's standalone window. */
export function runningAsApp(): boolean {
  try {
    return (window.navigator as Navigator & { standalone?: boolean }).standalone === true || window.matchMedia("(display-mode: standalone)").matches;
  } catch { return false; }
}

export function useInstall() {
  // null until measured in the browser: nothing is offered, and nothing is hidden, on a guess.
  const [asApp, setAsApp] = useState<boolean | null>(null);
  const [installed, setInstalled] = useState(false);
  const [canPrompt, setCanPrompt] = useState(false);
  useEffect(() => {
    const w = window as InstallWindow;
    setAsApp(runningAsApp());
    const sync = () => setCanPrompt(!!w.__omInstall);
    sync();
    // The layout's early listener usually holds the offer already; this one covers an offer made later.
    const offer = (e: Event) => { e.preventDefault(); w.__omInstall = e as InstallEvent; sync(); };
    const done = () => { w.__omInstall = null; setInstalled(true); sync(); };
    window.addEventListener("beforeinstallprompt", offer);
    window.addEventListener("appinstalled", done);
    window.addEventListener("om-install-ready", sync);
    return () => {
      window.removeEventListener("beforeinstallprompt", offer);
      window.removeEventListener("appinstalled", done);
      window.removeEventListener("om-install-ready", sync);
    };
  }, []);

  /** Opens the browser's own dialog when there is one; otherwise returns the steps to show. */
  const install = useCallback(async (): Promise<InstallGuide | null> => {
    const w = window as InstallWindow;
    const offer = w.__omInstall;
    if (offer) {
      try {
        await offer.prompt();
        const choice = await offer.userChoice;
        if (choice.outcome === "accepted") setInstalled(true);
      } catch { /* the dialog could not open; the offer is spent either way */ }
      w.__omInstall = null;
      setCanPrompt(false);
      return null;
    }
    return installGuide(navigator.userAgent, navigator.maxTouchPoints || 0, false);
  }, []);

  return { asApp, offer: asApp === false && !installed, canPrompt, install };
}

function Mark() {
  return (
    <svg viewBox="0 0 58 28" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="14" r="9.6" />
      <path d="M22.5 24 30.5 5.2c.5-1.2 2.2-1.2 2.7 0l5 12.3c.5 1.2 2.2 1.2 2.7 0l5-12.3c.5-1.2 2.2-1.2 2.7 0L56.8 24" />
    </svg>
  );
}

export function InstallSheet({ guide, onClose }: { guide: InstallGuide; onClose: () => void }) {
  const done = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const from = document.activeElement as HTMLElement | null;
    done.current?.focus();
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("keydown", esc); from?.focus?.(); };
  }, [onClose]);
  return (
    <div className="om-install" role="dialog" aria-modal="true" aria-labelledby="om-install-title" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="om-install-card">
        <div className="om-install-head">
          <span className="om-install-icon"><Mark /></span>
          <div style={{ minWidth: 0 }}>
            <h2 id="om-install-title">Install One Mission</h2>
            <p>{guide.intro}</p>
          </div>
          <button type="button" className="om-install-x" aria-label="Close" onClick={onClose}><X aria-hidden="true" /></button>
        </div>
        <ol className="om-install-steps">
          {guide.steps.map((s, i) => <li key={i}>{guide.steps.length > 1 && <span className="om-num" aria-hidden="true">{i + 1}</span>}<p>{s}</p></li>)}
        </ol>
        {guide.note && <p className="om-install-note">{guide.note}</p>}
        <button ref={done} type="button" className="om-install-done" onClick={onClose}>Done</button>
      </div>
    </div>
  );
}

/** A quiet line while the device has no connection: every figure on screen is the last one that arrived. */
export function OfflineNotice() {
  const [off, setOff] = useState(false);
  useEffect(() => {
    const read = () => setOff(navigator.onLine === false);
    read();
    window.addEventListener("online", read);
    window.addEventListener("offline", read);
    return () => { window.removeEventListener("online", read); window.removeEventListener("offline", read); };
  }, []);
  if (!off) return null;
  return <div className="om-offline" role="status">You’re offline. What’s on screen is the last that arrived; it updates when you’re back online.</div>;
}
