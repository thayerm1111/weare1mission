"use client";

/**
 * Light / dark toggle for the member portal only. The `.om-dark` class lives on
 * <html> (so a pre-paint script can set it with no flash), but this control adds
 * it on mount and REMOVES it on unmount — so navigating out of the portal to a
 * public marketing page drops back to light automatically. Preference is saved
 * per-browser in localStorage.
 */
import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";

export function ThemeToggle() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    let pref = false;
    try { pref = localStorage.getItem("om-theme") === "dark"; } catch { /* ignore */ }
    document.documentElement.classList.toggle("om-dark", pref);
    setDark(pref);
    // Leaving the portal (this component unmounts) → back to light everywhere.
    return () => { document.documentElement.classList.remove("om-dark"); };
  }, []);

  function toggle() {
    const next = !document.documentElement.classList.contains("om-dark");
    document.documentElement.classList.toggle("om-dark", next);
    try { localStorage.setItem("om-theme", next ? "dark" : "light"); } catch { /* ignore */ }
    setDark(next);
  }

  return (
    <button
      onClick={toggle}
      title={dark ? "Switch to light mode" : "Switch to dark mode"}
      aria-label="Toggle dark mode"
      className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-full border border-[#E7E4DD] bg-white text-charcoal/70 transition-colors hover:bg-offwhite focus-ring"
    >
      {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  );
}
