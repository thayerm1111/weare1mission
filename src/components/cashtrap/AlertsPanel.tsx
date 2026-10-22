"use client";
import { useEffect, useRef, useState } from "react";
import { Bell } from "lucide-react";
import { postJson, usePoll } from "./useCashtrap";
import { C, localDateTime } from "./theme";

type AlertsPayload = {
  alerts: Array<{ id: number; kind: string; symbol: string | null; title: string; body: string; created_at: string; unread: boolean }>;
  unread: number;
  prefs: { kinds: Record<string, boolean>; sound: boolean };
  channels: Array<{ name: string; configured: boolean; active: boolean }>;
};
const KIND_LABEL: Record<string, string> = { armed: "Setup armed", signal: "CALL/PUT published", entry: "Reference entry", missed: "Missed entry", outcome: "Outcome", data: "Data problems" };

/** In-app alerts (created once per event by the runner) and this member's choices. */
export function AlertsPanel() {
  const [open, setOpen] = useState(false);
  const { data, reload } = usePoll<AlertsPayload>("/api/cashtrap/alerts", 15_000);
  const lastTop = useRef<number | null>(null);
  useEffect(() => {
    const top = data?.alerts[0]?.id ?? null;
    if (top != null && lastTop.current != null && top !== lastTop.current && data?.prefs.sound && data.alerts[0].unread) {
      try { const ctx = new AudioContext(); const o = ctx.createOscillator(); o.frequency.value = 880; o.connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.12); } catch { /* no audio */ }
    }
    lastTop.current = top;
  }, [data]);
  const markSeen = async () => { await postJson("/api/cashtrap/alerts", { seen: true }); reload(); };
  const setKind = async (k: string, v: boolean) => { if (!data) return; await postJson("/api/cashtrap/alerts", { prefs: { kinds: { ...data.prefs.kinds, [k]: v }, sound: data.prefs.sound } }); reload(); };
  const setSound = async (v: boolean) => { if (!data) return; await postJson("/api/cashtrap/alerts", { prefs: { kinds: data.prefs.kinds, sound: v } }); reload(); };
  return (
    <div className="relative">
      <button type="button" onClick={() => { setOpen((o) => !o); if (!open) void markSeen(); }} className="relative inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px]" style={{ borderColor: C.line, background: C.card, color: C.ink }} aria-expanded={open}>
        <Bell className="h-3.5 w-3.5" /> Alerts
        {!!data?.unread && <span className="rounded-full px-1.5 text-[10px] font-semibold text-white" style={{ background: C.purple }}>{data.unread}</span>}
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-2 w-[min(92vw,380px)] rounded-2xl border p-3 shadow-lg" style={{ borderColor: C.line, background: C.card }}>
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide" style={{ color: C.faint }}>Recent alerts</p>
          <ul className="max-h-72 space-y-2 overflow-y-auto">
            {data?.alerts.map((a) => (
              <li key={a.id} className="rounded-lg p-2 text-[12px]" style={{ background: a.unread ? C.purpleSoft : "#FAFAFC" }}>
                <p className="font-semibold" style={{ color: C.ink }}>{a.title}</p>
                <p style={{ color: C.muted }}>{a.body}</p>
                <p className="mt-0.5 text-[10px]" style={{ color: C.faint }}>{localDateTime(Date.parse(a.created_at))}</p>
              </li>
            ))}
            {!data?.alerts.length && <li className="text-[12px]" style={{ color: C.faint }}>No alerts yet.</li>}
          </ul>
          <div className="mt-3 border-t pt-2" style={{ borderColor: C.line }}>
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide" style={{ color: C.faint }}>Notify me about</p>
            <div className="grid grid-cols-2 gap-1 text-[12px]" style={{ color: C.ink }}>
              {Object.keys(KIND_LABEL).map((k) => (
                <label key={k} className="inline-flex items-center gap-1.5"><input type="checkbox" checked={data?.prefs.kinds[k] ?? false} onChange={(e) => void setKind(k, e.target.checked)} />{KIND_LABEL[k]}</label>
              ))}
              <label className="inline-flex items-center gap-1.5"><input type="checkbox" checked={data?.prefs.sound ?? true} onChange={(e) => void setSound(e.target.checked)} />Sound</label>
            </div>
            <p className="mt-2 text-[11px]" style={{ color: C.faint }}>
              Channels: {data?.channels.map((c) => `${c.name} ${c.active ? "(on)" : c.configured ? "(ready — off)" : "(not set up)"}`).join(" · ")}. Channel credentials are kept on the server only.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
