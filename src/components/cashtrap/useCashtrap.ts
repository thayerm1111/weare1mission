"use client";
import { useCallback, useEffect, useRef, useState } from "react";

/** Poll a JSON endpoint; `deps` restart the poll. Errors keep the last good data and report the message. */
export function usePoll<T>(url: string | null, everyMs: number, deps: unknown[] = []): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tick = useRef(0);
  const load = useCallback(async () => {
    if (!url) return;
    const me = ++tick.current;
    try {
      const r = await fetch(url, { cache: "no-store" });
      const j = await r.json().catch(() => ({}));
      if (me !== tick.current) return;
      if (!r.ok) { setError((j as { error?: string }).error ?? `HTTP ${r.status}`); return; }
      setData(j as T);
      setError(null);
    } catch (e) {
      if (me === tick.current) setError(e instanceof Error ? e.message : "network error");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, ...deps]);
  useEffect(() => {
    void load();
    if (!url) return;
    const iv = setInterval(() => void load(), everyMs);
    return () => clearInterval(iv);
  }, [load, everyMs, url]);
  return { data, error, reload: () => void load() };
}

/** A clock that ticks every second, corrected to the server's time when it is known. */
export function useServerClock(serverNow: number | null | undefined): number {
  const [offset, setOffset] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (serverNow) setOffset(serverNow - Date.now()); }, [serverNow]);
  useEffect(() => { const iv = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(iv); }, []);
  return now + offset;
}

export async function postJson(url: string, body: unknown, method = "POST"): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  const r = await fetch(url, { method, headers: { "content-type": "application/json" }, body: method === "DELETE" ? undefined : JSON.stringify(body) });
  const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: r.ok, data };
}
