"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { DEFAULT_EXPERIENCE, EXPERIENCE_KEY, experienceModeOf, type ExperienceMode } from "@/lib/floor/experience";

export type ExperienceValue = {
  mode: ExperienceMode;
  isSimple: boolean;
  setMode: (mode: ExperienceMode) => void;
};

/** Classic pages retain their full view. OM OS provides the member's saved choice. */
export const ExperienceContext = createContext<ExperienceValue>({
  mode: "advanced", isSimple: false, setMode: () => {},
});
export const useExperienceMode = (): ExperienceValue => useContext(ExperienceContext);

/** One saved display choice shared by all tools; no network or account mutation. */
export function useExperiencePreference(): ExperienceValue {
  const [mode, setMode] = useState<ExperienceMode>(DEFAULT_EXPERIENCE);
  useEffect(() => {
    try { setMode(experienceModeOf(localStorage.getItem(EXPERIENCE_KEY))); } catch { /* this visit only */ }
    const sync = (event: StorageEvent) => {
      if (event.key === EXPERIENCE_KEY || event.key === null) setMode(experienceModeOf(event.newValue));
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  const choose = useCallback((value: ExperienceMode) => {
    const next = experienceModeOf(value);
    setMode(next);
    try { localStorage.setItem(EXPERIENCE_KEY, next); } catch { /* keep the choice for this visit */ }
  }, []);
  return { mode, isSimple: mode === "simple", setMode: choose };
}

/** Always visible in the top app bar, independently of a tool's own settings. */
export function ExperienceSwitch() {
  const { mode, setMode } = useExperienceMode();
  return <div className="om-experience-switch" role="group" aria-label="Workspace detail">
    <button type="button" aria-pressed={mode === "simple"} onClick={() => setMode("simple")}
      title="Essential entries and clear charts">Simple</button>
    <button type="button" aria-pressed={mode === "advanced"} onClick={() => setMode("advanced")}
      title="Full market analysis and tools">Advanced</button>
  </div>;
}
