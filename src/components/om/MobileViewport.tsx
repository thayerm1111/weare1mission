"use client";

import { useEffect } from "react";

/** Keep the app's fixed controls out of a phone's software keyboard. No account or trading state lives here. */
export function MobileViewport() {
  useEffect(() => {
    const root = document.documentElement;
    const viewport = window.visualViewport;
    let frame = 0;
    let restingHeight = window.innerHeight;
    let width = window.innerWidth;
    const measure = () => {
      frame = 0;
      const active = document.activeElement;
      const editing = active instanceof HTMLElement && (active.matches("input:not([type=checkbox]):not([type=radio]):not([type=range]),textarea") || active.isContentEditable);
      // An orientation change starts a new baseline. Browser chrome alone is not a keyboard.
      if (Math.abs(window.innerWidth - width) > 80) {
        width = window.innerWidth;
        restingHeight = window.innerHeight;
      }
      if (!editing) restingHeight = window.innerHeight;
      const height = viewport?.height ?? window.innerHeight;
      const loss = Math.max(0, restingHeight - height);
      const inset = Math.max(0, window.innerHeight - height - (viewport?.offsetTop ?? 0));
      const touchLayout = window.innerWidth <= 980 || window.matchMedia("(any-pointer: coarse)").matches;
      const keyboard = touchLayout && editing && loss > 140 && (viewport?.scale ?? 1) < 1.15;
      root.classList.toggle("om-keyboard-open", keyboard);
      root.style.setProperty("--om-viewport-height", `${Math.round(height)}px`);
      root.style.setProperty("--om-viewport-top", `${Math.round(viewport?.offsetTop ?? 0)}px`);
      root.style.setProperty("--om-keyboard-inset", `${keyboard ? Math.round(inset) : 0}px`);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    measure();
    viewport?.addEventListener("resize", schedule);
    viewport?.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule);
    document.addEventListener("focusin", schedule);
    document.addEventListener("focusout", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      document.removeEventListener("focusin", schedule);
      document.removeEventListener("focusout", schedule);
      root.classList.remove("om-keyboard-open");
      root.style.removeProperty("--om-viewport-height");
      root.style.removeProperty("--om-viewport-top");
      root.style.removeProperty("--om-keyboard-inset");
    };
  }, []);
  return null;
}
