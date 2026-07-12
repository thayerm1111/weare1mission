"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { CalendarClock, Radio, Video, CalendarPlus, Star, Globe, Plus, Pencil, Trash2, Settings2, X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import {
  scheduleEvents as staticEvents, sourceTimeZone, whatsOnFilters, scheduleNotice,
  type ScheduleEvent, type ScheduleCategory, type ScheduleDay,
} from "@/data/schedule";

const DAY_NAMES: ScheduleDay[] = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const CATEGORIES: ScheduleCategory[] = ["Business", "Leadership", "Overview", "Comp Plan", "Trading", "Community"];

const CAT_STYLE: Record<string, string> = {
  Business: "bg-emerald-100 text-emerald-800",
  Leadership: "bg-gold/20 text-gold-deep",
  Overview: "bg-sky-100 text-sky-800",
  "Comp Plan": "bg-violet-100 text-violet-800",
  Trading: "bg-amber-100 text-amber-800",
  Community: "bg-rose-100 text-rose-800",
};

/* ---- timezone helpers ---- */
function partsInTz(date: Date, tz: string) {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", weekday: "short",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(date);
  const m: Record<string, string> = {};
  p.forEach((x) => (m[x.type] = x.value));
  const wdMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { y: +m.year, mo: +m.month, d: +m.day, wd: wdMap[m.weekday] ?? 0 };
}
function zonedToDate(y: number, mo: number, d: number, hh: number, mm: number, tz: string) {
  const utc = Date.UTC(y, mo - 1, d, hh, mm, 0);
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utc));
  const m: Record<string, string> = {};
  p.forEach((x) => (m[x.type] = x.value));
  const asTzUtc = Date.UTC(+m.year, +m.month - 1, +m.day, +m.hour, +m.minute, +m.second);
  return new Date(utc - (asTzUtc - utc));
}
function gcalUrl(ev: ScheduleEvent, start: Date) {
  const end = new Date(start.getTime() + (ev.durationMin ?? 60) * 60000);
  const f = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const details = `${ev.description ?? ""}${ev.zoomLink && ev.zoomLink !== "#" ? `\n\nJoin: ${ev.zoomLink}` : ""}`;
  const params = new URLSearchParams({
    action: "TEMPLATE", text: `1 Mission · ${ev.title}`,
    dates: `${f(start)}/${f(end)}`, details,
    location: ev.zoomLink && ev.zoomLink !== "#" ? ev.zoomLink : "1 Mission",
    recur: "RRULE:FREQ=WEEKLY",
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

function rowToEvent(r: any): ScheduleEvent {
  return {
    id: r.id, title: r.title, day: r.day, time: r.time, durationMin: r.duration_min,
    speaker: r.speaker ?? "", description: r.description ?? "",
    accessLevel: r.access_level, category: r.category, zoomLink: r.zoom_link ?? "#",
  };
}

interface Occ { ev: ScheduleEvent; start: Date; end: Date; live: boolean; }

export function WhatsOnClient({ isAdmin = false }: { isAdmin?: boolean }) {
  const [now, setNow] = useState(() => new Date());
  const [filter, setFilter] = useState<string>("All");
  const [savedOnly, setSavedOnly] = useState(false);
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [dbEvents, setDbEvents] = useState<ScheduleEvent[] | null>(null);
  const [showAdmin, setShowAdmin] = useState(false);
  const [mounted, setMounted] = useState(false);

  const load = useCallback(async () => {
    const supabase = createClient();
    if (!supabase) { setDbEvents([]); return; }
    const { data } = await supabase.from("schedule_events").select("*");
    setDbEvents((data ?? []).map(rowToEvent));
  }, []);

  useEffect(() => {
    setMounted(true);
    try { setSaved(new Set(JSON.parse(localStorage.getItem("1m_saved_calls") || "[]"))); } catch {}
    load();
    const t = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(t);
  }, [load]);

  // Live events = DB events if any exist, otherwise the editable starter set.
  const events = dbEvents && dbEvents.length ? dbEvents : staticEvents;

  function toggleSave(id: string) {
    setSaved((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      try { localStorage.setItem("1m_saved_calls", JSON.stringify([...next])); } catch {}
      return next;
    });
  }

  const week = useMemo(() => {
    const t = partsInTz(now, sourceTimeZone);
    const todayMid = zonedToDate(t.y, t.mo, t.d, 0, 0, sourceTimeZone);
    const weekStart = todayMid.getTime() - t.wd * 86400000;
    return Array.from({ length: 7 }, (_, i) => {
      const probe = new Date(weekStart + i * 86400000 + 12 * 3600000);
      const pp = partsInTz(probe, sourceTimeZone);
      return { i, y: pp.y, mo: pp.mo, d: pp.d, name: DAY_NAMES[pp.wd] };
    });
  }, [now]);

  const matchesFilter = (ev: ScheduleEvent) =>
    (filter === "All" || ev.category === filter) && (!savedOnly || saved.has(ev.id));

  const byDay: Occ[][] = useMemo(() => {
    return week.map((col) =>
      events.filter((ev) => ev.day === col.name).map((ev) => {
        const [hh, mm] = ev.time.split(":").map(Number);
        const start = zonedToDate(col.y, col.mo, col.d, hh, mm, sourceTimeZone);
        const end = new Date(start.getTime() + (ev.durationMin ?? 60) * 60000);
        return { ev, start, end, live: now >= start && now < end };
      }).sort((a, b) => a.start.getTime() - b.start.getTime())
    );
  }, [week, now, events]);

  const todayIdx = partsInTz(now, sourceTimeZone).wd;
  const todayStrip = (byDay[todayIdx] ?? []).filter((o) => matchesFilter(o.ev) && (o.live || o.end >= now));
  const liveCount = byDay.flat().filter((o) => o.live).length;
  const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const tLabel = (d: Date) => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

  // Render only after mount — the board depends on the current time, which
  // differs between the server and the browser and would break hydration.
  if (!mounted) {
    return (
      <div className="space-y-8">
        <header>
          <p className="eyebrow text-gold">Members Only</p>
          <h1 className="mt-2 flex items-center gap-2 font-serif text-4xl font-black tracking-tight text-navy">
            <CalendarClock className="h-8 w-8 text-gold" aria-hidden="true" /> What&apos;s On
          </h1>
        </header>
        <p className="text-sm text-charcoal/50">Loading the schedule…</p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow text-gold">Members Only</p>
          <h1 className="mt-2 flex items-center gap-2 font-serif text-4xl font-black tracking-tight text-navy">
            <CalendarClock className="h-8 w-8 text-gold" aria-hidden="true" /> What&apos;s On
          </h1>
          <p className="mt-2 text-charcoal/70">Every weekly call — save the ones you want, add them to Google Calendar, and jump into whatever&apos;s live.</p>
        </div>
        {isAdmin && (
          <button onClick={() => setShowAdmin((s) => !s)}
            className="inline-flex items-center gap-2 rounded-full bg-gradient-primary px-5 py-2.5 text-sm font-semibold text-cream">
            <Settings2 className="h-4 w-4" /> Manage calls
          </button>
        )}
      </header>

      {isAdmin && showAdmin && <AdminSchedule dbEvents={dbEvents ?? []} onChange={load} onClose={() => setShowAdmin(false)} />}

      {/* Live / upcoming today */}
      <section>
        <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-label text-medium">
          <Radio className="h-4 w-4 text-gold" aria-hidden="true" /> {liveCount > 0 ? "Live & up next today" : "Up next today"}
        </h2>
        <div className="mt-3 flex gap-3 overflow-x-auto pb-2">
          {todayStrip.length === 0 ? (
            <p className="rounded-xl border border-[#E4DCCB] bg-offwhite/50 p-4 text-sm text-charcoal/60">Nothing else on today. See the week below.</p>
          ) : todayStrip.map((o) => (
            <div key={o.ev.id} className={`min-w-[240px] flex-shrink-0 rounded-2xl border p-4 shadow-card ${o.live ? "border-red-300 bg-red-50/50" : "border-[#E4DCCB] bg-cream"}`}>
              <div className="flex items-center justify-between">
                <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold ${CAT_STYLE[o.ev.category]}`}>{o.ev.category}</span>
                {o.live
                  ? <span className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-red-600"><span className="h-2 w-2 animate-pulse rounded-full bg-red-600" /> Live now</span>
                  : <span className="text-xs font-semibold text-medium">{tLabel(o.start)}</span>}
              </div>
              <h3 className="mt-2 font-bold text-navy">{o.ev.title}</h3>
              <p className="text-xs text-medium">{o.ev.speaker}</p>
              <a href={o.ev.zoomLink || "#"} target="_blank" rel="noreferrer"
                className={`mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-full px-4 py-2 text-xs font-bold uppercase tracking-wider ${o.live ? "bg-red-600 text-white" : "bg-gradient-primary text-cream"}`}>
                <Video className="h-4 w-4" /> {o.live ? "Join now" : "Join"}
              </a>
            </div>
          ))}
        </div>
      </section>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        {whatsOnFilters.map((f) => (
          <button key={f} onClick={() => setFilter(f)}
            className={`rounded-full px-4 py-2 text-sm font-semibold transition-colors ${filter === f ? "bg-primary text-cream" : "border border-[#E4DCCB] text-charcoal/70 hover:bg-ice"}`}>{f}</button>
        ))}
        <button onClick={() => setSavedOnly((s) => !s)}
          className={`inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-semibold transition-colors ${savedOnly ? "bg-gold text-cream" : "border border-[#E4DCCB] text-charcoal/70 hover:bg-ice"}`}>
          <Star className={`h-4 w-4 ${savedOnly ? "fill-current" : ""}`} /> Saved
        </button>
      </div>

      {/* Weekly board */}
      <div className="-mx-1 overflow-x-auto pb-2">
        <div className="grid min-w-[900px] grid-cols-7 gap-3 px-1">
          {week.map((col, i) => {
            const items = (byDay[i] ?? []).filter((o) => matchesFilter(o.ev));
            const isToday = i === todayIdx;
            return (
              <div key={i} className="min-w-0">
                <div className={`mb-3 rounded-xl px-3 py-2 text-center ${isToday ? "bg-primary text-cream" : "bg-offwhite/70 text-navy"}`}>
                  <p className="text-xs font-bold uppercase tracking-wide">{col.name.slice(0, 3)}</p>
                  <p className={`text-[11px] ${isToday ? "text-cream/70" : "text-medium"}`}>{col.mo}/{col.d}</p>
                </div>
                <div className="space-y-3">
                  {items.length === 0 ? (
                    <p className="rounded-xl border border-dashed border-[#E4DCCB] p-3 text-center text-[11px] text-charcoal/40">—</p>
                  ) : items.map((o) => (
                    <div key={o.ev.id} className={`rounded-2xl border p-3 shadow-card ${o.live ? "border-red-300 bg-red-50/50" : "border-[#E4DCCB] bg-cream"}`}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-bold text-navy">{tLabel(o.start)}</span>
                        <button onClick={() => toggleSave(o.ev.id)} aria-label="Save call"
                          className={`rounded-full p-1 ${saved.has(o.ev.id) ? "text-gold" : "text-medium hover:text-gold"}`}>
                          <Star className={`h-4 w-4 ${saved.has(o.ev.id) ? "fill-current" : ""}`} />
                        </button>
                      </div>
                      {o.live && <span className="mt-1 inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-red-600"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-600" /> Live</span>}
                      <p className="mt-1 text-sm font-semibold leading-snug text-navy">{o.ev.title}</p>
                      <span className={`mt-1.5 inline-block rounded-full px-2 py-0.5 text-[10px] font-bold ${CAT_STYLE[o.ev.category]}`}>{o.ev.category}</span>
                      <div className="mt-2.5 flex items-center gap-2">
                        <a href={o.ev.zoomLink || "#"} target="_blank" rel="noreferrer" title="Join on Zoom"
                          className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg bg-gradient-primary px-2 py-1.5 text-[11px] font-bold uppercase tracking-wide text-cream">
                          <Video className="h-3.5 w-3.5" /> Join
                        </a>
                        <a href={gcalUrl(o.ev, o.start)} target="_blank" rel="noreferrer" title="Save to Google Calendar"
                          className="inline-flex items-center justify-center rounded-lg border border-[#E4DCCB] p-1.5 text-charcoal/70 hover:border-gold hover:text-gold">
                          <CalendarPlus className="h-4 w-4" />
                        </a>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-medium">
        <span className="inline-flex items-center gap-1.5"><Globe className="h-3.5 w-3.5" /> Times shown in your local timezone: {localTz}</span>
        <span className="inline-flex items-center gap-1.5"><CalendarPlus className="h-3.5 w-3.5 text-gold" /> The calendar icon saves a recurring event to Google Calendar</span>
      </div>

      {!dbEvents?.length && (
        <div className="flex gap-3 rounded-2xl border border-[#E4DCCB] bg-offwhite/50 p-4">
          <Radio className="h-5 w-5 flex-shrink-0 text-medium" aria-hidden="true" />
          <p className="text-sm text-charcoal/65">{scheduleNotice}</p>
        </div>
      )}
    </div>
  );
}

/* ───────── Admin: manage the schedule ───────── */
type Form = { id?: string; title: string; day: ScheduleDay; time: string; duration_min: number; category: ScheduleCategory; access_level: string; speaker: string; description: string; zoom_link: string; };
const EMPTY: Form = { title: "", day: "Monday", time: "20:00", duration_min: 60, category: "Business", access_level: "Members Only", speaker: "", description: "", zoom_link: "" };

function AdminSchedule({ dbEvents, onChange, onClose }: { dbEvents: ScheduleEvent[]; onChange: () => void; onClose: () => void }) {
  const [form, setForm] = useState<Form>(EMPTY);
  const [busy, setBusy] = useState(false);
  const editing = !!form.id;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const supabase = createClient();
    if (!supabase || !form.title.trim()) return;
    setBusy(true);
    const payload = {
      title: form.title.trim(), day: form.day, time: form.time, duration_min: form.duration_min,
      category: form.category, access_level: form.access_level,
      speaker: form.speaker || null, description: form.description || null, zoom_link: form.zoom_link || null,
    };
    if (form.id) await supabase.from("schedule_events").update(payload).eq("id", form.id);
    else await supabase.from("schedule_events").insert(payload);
    setBusy(false); setForm(EMPTY); onChange();
  }
  async function del(id: string) {
    const supabase = createClient();
    if (!supabase) return;
    await supabase.from("schedule_events").delete().eq("id", id);
    if (form.id === id) setForm(EMPTY);
    onChange();
  }
  function edit(ev: ScheduleEvent) {
    setForm({ id: ev.id, title: ev.title, day: ev.day, time: ev.time, duration_min: ev.durationMin ?? 60, category: ev.category, access_level: ev.accessLevel, speaker: ev.speaker ?? "", description: ev.description ?? "", zoom_link: ev.zoomLink === "#" ? "" : (ev.zoomLink ?? "") });
  }
  async function importStarters() {
    const supabase = createClient();
    if (!supabase) return;
    setBusy(true);
    const rows = staticEvents.map((ev) => ({
      title: ev.title, day: ev.day, time: ev.time, duration_min: ev.durationMin ?? 60,
      category: ev.category, access_level: ev.accessLevel,
      speaker: ev.speaker || null, description: ev.description || null,
      zoom_link: ev.zoomLink && ev.zoomLink !== "#" ? ev.zoomLink : null,
    }));
    await supabase.from("schedule_events").insert(rows);
    setBusy(false); onChange();
  }

  const field = "w-full rounded-xl border border-[#E4DCCB] bg-cream px-3 py-2.5 text-sm outline-none focus:border-gold";
  return (
    <section className="rounded-2xl border border-gold/40 bg-offwhite/40 p-5">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-base font-bold text-navy"><Settings2 className="h-5 w-5 text-gold" /> Manage calls (admin)</h2>
        <button onClick={onClose} className="rounded-full p-1 text-medium hover:text-navy"><X className="h-5 w-5" /></button>
      </div>

      <form onSubmit={submit} className="mt-4 grid gap-3 sm:grid-cols-2">
        <input className={field + " sm:col-span-2"} placeholder="Call title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        <select className={field} value={form.day} onChange={(e) => setForm({ ...form, day: e.target.value as ScheduleDay })}>
          {DAY_NAMES.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        <select className={field} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value as ScheduleCategory })}>
          {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <div className="flex gap-2">
          <input className={field} type="time" value={form.time} onChange={(e) => setForm({ ...form, time: e.target.value })} />
          <input className={field} type="number" min={15} step={15} value={form.duration_min} onChange={(e) => setForm({ ...form, duration_min: +e.target.value })} title="Minutes" />
        </div>
        <select className={field} value={form.access_level} onChange={(e) => setForm({ ...form, access_level: e.target.value })}>
          <option>Members Only</option><option>Public</option>
        </select>
        <input className={field + " sm:col-span-2"} placeholder="Host / speaker" value={form.speaker} onChange={(e) => setForm({ ...form, speaker: e.target.value })} />
        <input className={field + " sm:col-span-2"} placeholder="Zoom / join link" value={form.zoom_link} onChange={(e) => setForm({ ...form, zoom_link: e.target.value })} />
        <textarea className={field + " sm:col-span-2"} rows={2} placeholder="Short description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        <div className="flex gap-2 sm:col-span-2">
          <button type="submit" disabled={busy} className="inline-flex items-center gap-2 rounded-full bg-gradient-primary px-6 py-2.5 text-sm font-bold uppercase tracking-wider text-cream disabled:opacity-60">
            <Plus className="h-4 w-4" /> {editing ? "Save changes" : "Add call"}
          </button>
          {editing && <button type="button" onClick={() => setForm(EMPTY)} className="rounded-full border border-[#E4DCCB] px-5 py-2.5 text-sm font-semibold text-charcoal/70">Cancel</button>}
        </div>
      </form>

      {dbEvents.length > 0 && (
        <div className="mt-5 space-y-2">
          <p className="text-xs font-bold uppercase tracking-label text-medium">Your calls</p>
          {dbEvents.map((ev) => (
            <div key={ev.id} className="flex items-center justify-between gap-3 rounded-xl border border-[#E4DCCB] bg-cream px-4 py-2.5">
              <span className="min-w-0 truncate text-sm text-navy"><b>{ev.day}</b> {ev.time} · {ev.title} <span className="text-medium">({ev.category})</span></span>
              <span className="flex flex-shrink-0 gap-1">
                <button onClick={() => edit(ev)} className="rounded-lg p-1.5 text-medium hover:text-navy" aria-label="Edit"><Pencil className="h-4 w-4" /></button>
                <button onClick={() => del(ev.id)} className="rounded-lg p-1.5 text-medium hover:text-red-600" aria-label="Delete"><Trash2 className="h-4 w-4" /></button>
              </span>
            </div>
          ))}
        </div>
      )}
      {dbEvents.length === 0 && (
        <div className="mt-4 flex flex-col items-start gap-3 rounded-xl border border-[#E4DCCB] bg-cream p-4">
          <p className="text-sm text-charcoal/70">
            The board is showing starter placeholder calls. Import them here to make each one editable — then add your Zoom links, hosts, and details, or delete the ones you don&apos;t use.
          </p>
          <button type="button" onClick={importStarters} disabled={busy}
            className="inline-flex items-center gap-2 rounded-full border border-gold px-5 py-2.5 text-sm font-semibold text-gold-deep hover:bg-gold/10 disabled:opacity-60">
            <Plus className="h-4 w-4" /> Import starter calls
          </button>
        </div>
      )}
    </section>
  );
}
