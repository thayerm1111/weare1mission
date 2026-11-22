"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpFromLine, Check, Ellipsis, PlusSquare, WifiOff, X } from "lucide-react";
import { installGuide, type InstallGuide } from "@/lib/floor/app";
import "./app-install.css";

/**
 * INSTALLING THE ONE MISSION APP from the profile menu (lib/floor/app.ts).
 *
 * Where the browser can show its own install dialog, "Install the app" opens it. Everywhere else (an iPhone, or a
 * browser that has no dialog to offer) it opens a short card with that browser's own steps. Running as the
 * installed app, the item is not shown at all.
 */
type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };
type InstallWindow = Window & { __omInstall?: InstallEvent | null };

/**
 * Running as an installed app: an iPhone home-screen app, any browser's standalone window, or the members' earlier
 * installed app, which shows the site inside a frame (public/app/index.html).
 */
export function runningAsApp(): boolean {
  try {
    if (window.top !== window.self) return true;
    return (window.navigator as Navigator & { standalone?: boolean }).standalone === true || window.matchMedia("(display-mode: standalone)").matches;
  } catch { return true; }
}

export function useInstall() {
  // null until measured in the browser: nothing is offered, and nothing is hidden, on a guess.
  const [asApp, setAsApp] = useState<boolean | null>(null);
  const [installed, setInstalled] = useState(false);
  const [canPrompt, setCanPrompt] = useState(false);
  useEffect(() => {
    const w = window as InstallWindow;
    const mode = window.matchMedia("(display-mode: standalone)");
    const measure = () => setAsApp(runningAsApp());
    measure();
    const sync = () => setCanPrompt(!!w.__omInstall);
    sync();
    // The layout's early listener usually holds the offer already; this one covers an offer made later.
    const offer = (e: Event) => { e.preventDefault(); w.__omInstall = e as InstallEvent; sync(); };
    const done = () => { w.__omInstall = null; setInstalled(true); sync(); };
    window.addEventListener("beforeinstallprompt", offer);
    window.addEventListener("appinstalled", done);
    window.addEventListener("om-install-ready", sync);
    mode.addEventListener("change", measure);
    return () => {
      window.removeEventListener("beforeinstallprompt", offer);
      window.removeEventListener("appinstalled", done);
      window.removeEventListener("om-install-ready", sync);
      mode.removeEventListener("change", measure);
    };
  }, []);

  /** Opens the browser's own dialog when there is one; otherwise returns the steps to show. */
  const install = useCallback(async (): Promise<InstallGuide | null> => {
    const w = window as InstallWindow;
    const offer = w.__omInstall;
    if (offer) {
      let failed = false;
      try {
        await offer.prompt();
        const choice = await offer.userChoice;
        if (choice.outcome === "accepted") setInstalled(true);
      } catch { failed = true; }
      w.__omInstall = null;
      setCanPrompt(false);
      // A spent offer cannot be retried. Show the real browser steps if its dialog failed.
      return failed ? installGuide(navigator.userAgent, navigator.maxTouchPoints || 0, false) : null;
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
  const dismiss = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const active = document.activeElement as HTMLElement | null;
    // The profile menu unmounts before this sheet opens. Its stable account button is the return point.
    const from = active && active !== document.body && active !== document.documentElement && active.isConnected
      ? active : document.querySelector<HTMLButtonElement>("[data-om-account-trigger]");
    const body = document.body;
    const html = document.documentElement;
    const scroll = { x: window.scrollX, y: window.scrollY };
    const saved = { position: body.style.position, top: body.style.top, left: body.style.left, width: body.style.width, overflow: body.style.overflow, htmlOverflow: html.style.overflow };
    body.style.position = "fixed";
    body.style.top = `-${scroll.y}px`;
    body.style.left = `-${scroll.x}px`;
    body.style.width = "100%";
    body.style.overflow = "hidden";
    html.style.overflow = "hidden";
    dismiss.current?.focus({ preventScroll: true });
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") close.current();
      if (e.key !== "Tab") return;
      const items = Array.from(card.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], summary, [tabindex="0"]') ?? []);
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && (document.activeElement === first || !card.current?.contains(document.activeElement))) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !card.current?.contains(document.activeElement))) {
        e.preventDefault(); first.focus();
      }
    };
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("keydown", esc);
      Object.assign(body.style, { position: saved.position, top: saved.top, left: saved.left, width: saved.width, overflow: saved.overflow });
      html.style.overflow = saved.htmlOverflow;
      window.scrollTo({ left: scroll.x, top: scroll.y, behavior: "instant" });
      const returnTo = from?.isConnected ? from : document.querySelector<HTMLButtonElement>("[data-om-account-trigger]");
      returnTo?.focus({ preventScroll: true });
    };
  }, []);
  const icons = guide.kind === "ios" ? [ArrowUpFromLine, PlusSquare, Check] : [Ellipsis, PlusSquare, Check];
  return (
    <div className="om-install" role="dialog" aria-modal="true" aria-labelledby="om-install-title" aria-describedby="om-install-description" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={card} className="om-install-card">
        <span className="om-install-handle" aria-hidden="true" />
        <button ref={dismiss} type="button" className="om-install-x" aria-label="Close install guide" onClick={onClose}><X aria-hidden="true" /></button>
        <div className="om-install-head">
          <span className="om-install-icon"><Mark /></span>
          <div style={{ minWidth: 0 }}>
            <span className="om-install-eyebrow">One Mission OS</span>
            <h2 id="om-install-title">Make it your app.</h2>
          </div>
        </div>
        <p id="om-install-description" className="om-install-description">{guide.intro}</p>
        {guide.browser && <span className="om-install-browser">{guide.browser}</span>}
        <ol className="om-install-steps">
          {guide.steps.map((s, i) => {
            const Icon = icons[i] || Check;
            return <li key={i}><span className="om-install-step-icon" aria-hidden="true"><Icon /></span><p>{s}</p></li>;
          })}
        </ol>
        {guide.help && <details className="om-install-help"><summary>Can’t find the option?</summary><p>{guide.help}</p></details>}
        {guide.note && <p className="om-install-note">{guide.note}</p>}
        <button type="button" className="om-install-done" onClick={onClose}>Got it</button>
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
  return <div className="om-offline" role="status"><WifiOff aria-hidden="true" /><span>Offline · Showing the last update</span></div>;
}
