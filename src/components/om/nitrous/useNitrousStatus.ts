"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { NitrousStatus } from "@/lib/nitrous/types";
import { validStatus } from "./presentation";

export function useNitrousStatus() {
  const [data, setData] = useState<NitrousStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [receivedAt, setReceivedAt] = useState(0);
  const [now, setNow] = useState(0);
  const pending = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    pending.current?.abort();
    const controller = new AbortController(); pending.current = controller;
    try {
      const res = await fetch("/api/nitrous/status", { cache: "no-store", signal: controller.signal });
      const body = await res.json().catch(() => null);
      if (!res.ok || !validStatus(body)) throw new Error(res.status === 401 ? "Sign in to view your Nitrous accounts." : body?.detail ?? body?.reason ?? "Account status is temporarily unavailable.");
      if (!controller.signal.aborted) { setData(body); setError(""); setReceivedAt(Date.now()); setNow(Date.now()); }
    } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Unable to refresh account status."); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }, []);
  useEffect(() => {
    setNow(Date.now()); void refresh();
    const poll = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 20_000);
    const clock = setInterval(() => setNow(Date.now()), 5_000);
    const visible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("nitrous-account-updated", visible);
    return () => { pending.current?.abort(); clearInterval(poll); clearInterval(clock);
      document.removeEventListener("visibilitychange", visible); window.removeEventListener("nitrous-account-updated", visible); };
  }, [refresh]);
  return { data, loading, error, receivedAt, now, refresh };
}
