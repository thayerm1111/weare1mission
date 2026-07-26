"use client";

/**
 * earnMission — auto-complete a daily mission from anywhere in the app when the
 * member actually performs the action (asks OM AI, generates a play, etc.).
 *
 * Works whether or not the dashboard is mounted:
 *  - Tries the server (/api/game). In Supabase mode this is the source of truth.
 *  - Falls back to the same localStorage the per-device engine uses.
 * Then dispatches an "om-xp" event so a mounted dashboard updates live.
 * Idempotent per day (the engine ignores a mission already completed today).
 */
import { MISSION_XP } from "./gameData";

const KEY = "om_game_v1";

function ymd(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export async function earnMission(missionId: string) {
  if (typeof window === "undefined") return;
  if (!MISSION_XP[missionId]) return;

  // 1) Try the server (authoritative when Supabase is set up).
  try {
    const res = await fetch("/api/game", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ missionId }),
    });
    const j = await res.json().catch(() => null);
    if (j?.enabled) {
      notify(missionId);
      return;
    }
  } catch { /* fall through to local */ }

  // 2) Local fallback — update the per-device store directly.
  try {
    const raw = localStorage.getItem(KEY);
    const s = raw ? JSON.parse(raw) : { xp: 0, lastLogin: "", streak: 0, best: 0, days: {} };
    const t = ymd(new Date());
    const days = s.days && typeof s.days === "object" ? s.days : {};
    const done: string[] = Array.isArray(days[t]) ? days[t] : [];
    if (!done.includes(missionId)) {
      days[t] = [...done, missionId];
      s.days = days;
      s.xp = (s.xp || 0) + MISSION_XP[missionId];
      localStorage.setItem(KEY, JSON.stringify(s));
    }
  } catch { /* ignore */ }

  notify(missionId);
}

function notify(missionId: string) {
  try { window.dispatchEvent(new CustomEvent("om-xp", { detail: { missionId } })); } catch { /* ignore */ }
}
