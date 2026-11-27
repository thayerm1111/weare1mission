"use client";

import { useEffect, useState } from "react";

export function useNitrousLiveAccent(memberId: string | null) {
  const [activeMember, setActiveMember] = useState<string | null>(null);
  useEffect(() => {
    setActiveMember(null);
    if (!memberId) return;
    let controller: AbortController | undefined;
    let poll: ReturnType<typeof setTimeout>;
    let expiry: ReturnType<typeof setTimeout>;
    const cancel = () => {
      clearTimeout(poll);
      clearTimeout(expiry);
      controller?.abort();
      setActiveMember(null);
    };
    const refresh = async () => {
      clearTimeout(poll);
      controller?.abort();
      if (document.visibilityState !== "visible") { cancel(); return; }
      const request = new AbortController();
      controller = request;
      const started = performance.now();
      const timeout = setTimeout(() => request.abort(), 8000);
      let delay = 10_000;
      try {
        const res = await fetch("/api/nitrous/live-activity", { cache: "no-store", signal: request.signal });
        if (!res.ok) throw new Error("unavailable");
        const body = await res.json();
        if (request.signal.aborted) return;
        clearTimeout(expiry);
        const remaining = Number.isFinite(body.activeForMs) ? Math.min(30_000, body.activeForMs) - (performance.now() - started) : 0;
        setActiveMember(remaining > 0 ? memberId : null);
        if (remaining > 0) expiry = setTimeout(() => setActiveMember(null), remaining);
        delay = body.linked ? 10_000 : 120_000;
      } catch {
        if (controller === request) setActiveMember(null);
      } finally {
        clearTimeout(timeout);
        if (controller === request && document.visibilityState === "visible") poll = setTimeout(refresh, delay);
      }
    };
    const wake = () => { void refresh(); };
    wake();
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("nitrous-account-updated", wake);
    return () => {
      controller?.abort();
      controller = undefined;
      clearTimeout(poll);
      clearTimeout(expiry);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("nitrous-account-updated", wake);
    };
  }, [memberId]);
  return !!memberId && activeMember === memberId;
}
