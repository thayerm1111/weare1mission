"use client";

/**
 * useProgress — localStorage-backed completion tracking for onboarding & training.
 *
 * Version 1 stores progress on the device only. When you add Supabase later,
 * this is the single place to swap localStorage for a database:
 *   1. Read initial state from Supabase (per authenticated user) instead of localStorage.
 *   2. On toggle, upsert the completed ids to a `progress` table.
 * The component API (completed set, toggle, reset, percent) can stay identical.
 */
import { useCallback, useEffect, useState } from "react";

export function useProgress(storageKey: string, totalItems: number) {
  const [completed, setCompleted] = useState<Set<string>>(new Set());
  const [hydrated, setHydrated] = useState(false);

  // Load once on mount (client only) to avoid hydration mismatch.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw) setCompleted(new Set(JSON.parse(raw) as string[]));
    } catch {
      /* ignore corrupt/unavailable storage */
    }
    setHydrated(true);
  }, [storageKey]);

  const persist = useCallback(
    (next: Set<string>) => {
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(Array.from(next)));
      } catch {
        /* storage may be unavailable (private mode) — fail silently */
      }
    },
    [storageKey]
  );

  const toggle = useCallback(
    (id: string) => {
      setCompleted((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        persist(next);
        return next;
      });
    },
    [persist]
  );

  const setComplete = useCallback(
    (id: string, value: boolean) => {
      setCompleted((prev) => {
        const next = new Set(prev);
        if (value) next.add(id);
        else next.delete(id);
        persist(next);
        return next;
      });
    },
    [persist]
  );

  const reset = useCallback(() => {
    setCompleted(new Set());
    try {
      window.localStorage.removeItem(storageKey);
    } catch {
      /* ignore */
    }
  }, [storageKey]);

  const count = completed.size;
  const percent = totalItems > 0 ? Math.round((count / totalItems) * 100) : 0;

  return { completed, hydrated, toggle, setComplete, reset, count, percent };
}
