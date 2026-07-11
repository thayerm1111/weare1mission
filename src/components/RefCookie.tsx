"use client";
import { useEffect } from "react";

/** Stores the referring member's username in a cookie so it survives navigation to /signup. */
export function RefCookie({ username }: { username: string }) {
  useEffect(() => {
    try {
      document.cookie = `1m_ref=${encodeURIComponent(username)}; path=/; max-age=${60 * 60 * 24 * 30}; SameSite=Lax`;
    } catch {}
  }, [username]);
  return null;
}
