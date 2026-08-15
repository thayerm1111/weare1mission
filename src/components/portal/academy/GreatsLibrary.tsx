"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import {
  ChevronLeft, Check, Search, Star, Flame, ArrowRight, ExternalLink, PlayCircle,
  BookOpen, Headphones, FileText, Sparkles, MessageCircle, Loader2, X, Trophy,
  ListChecks, PenLine, GraduationCap, Send, CheckCircle2, Circle, Target, Calendar,
  Settings, Clock,
} from "lucide-react";
import type { Masterclass, GreatLesson, Workbook } from "@/data/greats";

/* ─────────────────────────── types ─────────────────────────── */
type Resource = {
  id: string; masterclass_id: string | null; lesson_id: string | null; kind: string;
  title: string; description: string | null; storage_path: string | null;
  external_url: string | null; sort: number; published: boolean;
};
type ChallengeRow = { challenge_id: string; goal: string | null; start_date: string | null; days_done: number[]; active: boolean };
type Track = { id: string; label: string; steps: string[] };

type View =
  | { v: "home" } | { v: "mc"; id: string } | { v: "lesson"; mc: string; id: string }
  | { v: "quiz"; mc: string; id: string } | { v: "workbook"; mc: string }
  | { v: "study"; mc: string; id: string } | { v: "roleplay"; mc: string; id: string; scenario: string }
  | { v: "audio"; path: string; title: string } | { v: "pdf"; path: string; title: string }
  | { v: "search" } | { v: "favorites" } | { v: "challenge" } | { v: "admin" };

const BLUE = "#2563eb";
const todayStr = () => new Date().toISOString().slice(0, 10);

/* ─────────────────────────── data hook ─────────────────────────── */
function useLibrary() {
  const [loaded, setLoaded] = useState(false);
  const [mcs, setMcs] = useState<Masterclass[]>([]);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [resources, setResources] = useState<Resource[]>([]);
  const [completed, setCompleted] = useState<Set<string>>(new Set());
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [favs, setFavs] = useState<Set<string>>(new Set());
  const [quiz, setQuiz] = useState<Record<string, { score: number; total: number }>>({});
  const [workbook, setWorkbook] = useState<Record<string, Record<string, string>>>({});
  const [streak, setStreak] = useState(0);
  const [totalDays, setTotalDays] = useState(0);
  const [lastLesson, setLastLesson] = useState<string | null>(null);
  const [challenge, setChallenge] = useState<ChallengeRow[]>([]);
  const [role, setRole] = useState("member");

  useEffect(() => {
    let alive = true;
    Promise.all([
      fetch("/api/greats/content", { cache: "no-store" }).then((r) => r.json()).catch(() => null),
      fetch("/api/greats", { cache: "no-store" }).then((r) => r.json()).catch(() => null),
    ]).then(([c, s]) => {
      if (!alive) return;
      if (c?.ok) { setMcs(c.masterclasses || []); setTracks(c.tracks || []); setResources(c.resources || []); }
      if (s?.ok) {
        setCompleted(new Set((s.progress || []).map((p: { lessonId: string }) => p.lessonId)));
        setNotes(s.notes || {});
        setFavs(new Set((s.favorites || []).map((f: { type: string; id: string }) => `${f.type}:${f.id}`)));
        setQuiz(s.quiz || {});
        setWorkbook(s.workbook || {});
        setStreak(s.state?.streak || 0);
        setTotalDays(s.state?.total_days || 0);
        setLastLesson(s.state?.last_lesson || null);
        setChallenge(Array.isArray(s.challenge) ? s.challenge : []);
        setRole(s.role || "member");
      }
      setLoaded(true);
    });
    return () => { alive = false; };
  }, []);

  const post = useCallback((body: Record<string, unknown>) => {
    fetch("/api/greats", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => {});
  }, []);

  const toggleComplete = useCallback((mc: string, id: string, on: boolean) => {
    setCompleted((prev) => { const n = new Set(prev); if (on) n.add(id); else n.delete(id); return n; });
    if (on) setStreak((s) => s); // streak recomputed server-side; refetch not needed for UI feel
    post({ kind: "progress", masterclassId: mc, lessonId: id, completed: on });
  }, [post]);

  const saveNote = useCallback((mc: string, id: string, body: string) => {
    setNotes((p) => ({ ...p, [id]: body }));
    post({ kind: "note", masterclassId: mc, lessonId: id, body });
  }, [post]);

  const toggleFav = useCallback((type: "masterclass" | "lesson", id: string) => {
    const key = `${type}:${id}`;
    setFavs((prev) => { const n = new Set(prev); const on = !n.has(key); if (on) n.add(key); else n.delete(key); post({ kind: "favorite", itemType: type, itemId: id, on }); return n; });
  }, [post]);

  const saveQuiz = useCallback((id: string, score: number, total: number) => {
    setQuiz((p) => ({ ...p, [id]: { score, total } }));
    post({ kind: "quiz", lessonId: id, score, total });
  }, [post]);

  const saveWorkbook = useCallback((workbookId: string, answers: Record<string, string>) => {
    setWorkbook((p) => ({ ...p, [workbookId]: answers }));
    post({ kind: "workbook", workbookId, answers });
  }, [post]);

  const setLast = useCallback((mc: string, id: string) => {
    setLastLesson(`${mc}/${id}`);
    post({ kind: "lastLesson", masterclassId: mc, lessonId: id });
  }, [post]);

  const saveChallenge = useCallback((body: Record<string, unknown>) => {
    post({ kind: "challenge", ...body });
  }, [post]);

  return {
    loaded, mcs, tracks, resources, completed, notes, favs, quiz, workbook, streak, totalDays, lastLesson, challenge, role,
    setChallenge, toggleComplete, saveNote, toggleFav, saveQuiz, saveWorkbook, setLast, saveChallenge,
  };
}

type Lib = ReturnType<typeof useLibrary>;

/* ─────────────────────────── root ─────────────────────────── */
export function GreatsLibrary({ firstName = "there" }: { firstName?: string }) {
  const lib = useLibrary();
  const [view, setView] = useState<View>({ v: "home" });
  const go = useCallback((v: View) => { window.scrollTo(0, 0); setView(v); }, []);

  const mcById = useMemo(() => Object.fromEntries(lib.mcs.map((m) => [m.id, m])), [lib.mcs]);

  return (
    <div className="text-charcoal">
      {view.v !== "home" && (
        <button onClick={() => go({ v: "home" })} className="mb-3 inline-flex items-center gap-1.5 text-sm font-semibold text-charcoal/60 hover:text-charcoal">
          <ChevronLeft className="h-4 w-4" /> Library home
        </button>
      )}

      {view.v === "home" && <Home firstName={firstName} lib={lib} go={go} />}
      {view.v === "mc" && mcById[view.id] && <McPath mc={mcById[view.id]} lib={lib} go={go} />}
      {view.v === "lesson" && mcById[view.mc] && <LessonView mc={mcById[view.mc]} id={view.id} lib={lib} go={go} />}
      {view.v === "quiz" && mcById[view.mc] && <QuizView mc={mcById[view.mc]} id={view.id} lib={lib} go={go} />}
      {view.v === "workbook" && mcById[view.mc]?.workbook && <WorkbookView mc={mcById[view.mc]} lib={lib} />}
      {view.v === "study" && mcById[view.mc] && <AiChat mode="study" mc={mcById[view.mc]} id={view.id} />}
      {view.v === "roleplay" && mcById[view.mc] && <AiChat mode="roleplay" mc={mcById[view.mc]} id={view.id} scenario={view.scenario} />}
      {view.v === "audio" && <MediaAudio path={view.path} title={view.title} />}
      {view.v === "pdf" && <MediaPdf path={view.path} title={view.title} />}
      {view.v === "search" && <SearchView lib={lib} go={go} />}
      {view.v === "favorites" && <Favorites lib={lib} go={go} />}
      {view.v === "challenge" && <ChallengeView lib={lib} go={go} />}
      {view.v === "admin" && lib.role === "admin" && <AdminCms lib={lib} />}
    </div>
  );
}

/* ─────────────────────────── HOME ─────────────────────────── */
function mcProgress(mc: Masterclass, completed: Set<string>) {
  const done = mc.lessons.filter((l) => completed.has(l.id)).length;
  return { done, total: mc.lessons.length, pct: Math.round((done / mc.lessons.length) * 100) };
}

function Home({ firstName, lib, go }: { firstName: string; lib: Lib; go: (v: View) => void }) {
  const cats = useMemo(() => {
    const map = new Map<string, Masterclass[]>();
    for (const m of lib.mcs) { const a = map.get(m.category) || []; a.push(m); map.set(m.category, a); }
    return [...map.entries()];
  }, [lib.mcs]);

  // Continue / Today's PD
  const cont = useMemo(() => {
    if (lib.lastLesson) {
      const [mc, id] = lib.lastLesson.split("/");
      const m = lib.mcs.find((x) => x.id === mc);
      const l = m?.lessons.find((x) => x.id === id);
      if (m && l && !lib.completed.has(l.id)) return { m, l };
    }
    for (const m of lib.mcs) { const l = m.lessons.find((x) => !lib.completed.has(x.id)); if (l) return { m, l }; }
    return null;
  }, [lib.lastLesson, lib.mcs, lib.completed]);

  const totalLessons = lib.mcs.reduce((n, m) => n + m.lessons.length, 0);
  const doneLessons = lib.mcs.reduce((n, m) => n + m.lessons.filter((l) => lib.completed.has(l.id)).length, 0);

  return (
    <div className="space-y-5">
      {/* Hero */}
      <div className="overflow-hidden rounded-2xl border border-ice bg-white p-5 shadow-card sm:p-6" style={{ backgroundImage: "radial-gradient(120% 90% at 100% 0%, rgba(37,99,235,0.07), transparent 55%)" }}>
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em]" style={{ color: BLUE }}>One Mission Personal Development Library</p>
        <h2 className="mt-1 text-2xl font-extrabold tracking-tight text-navy sm:text-3xl">Learn From the Greats</h2>
        <p className="mt-1 text-sm text-charcoal/60">Full masterclasses on the timeless skills of building, mindset, money, and leadership — taught as original One Mission training, then put straight to work in your business.</p>

        {cont && (
          <div className="mt-4 rounded-xl border border-ice bg-offwhite/60 p-4">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-charcoal/45">{lib.lastLesson ? "Continue learning" : "Start here"}</p>
            <p className="mt-0.5 text-lg font-bold text-navy">{cont.l.title}</p>
            <p className="text-[13px] text-charcoal/55">{cont.m.title} · Lesson {cont.l.num} · {cont.l.minutes} min</p>
            <button onClick={() => go({ v: "lesson", mc: cont.m.id, id: cont.l.id })} className="mt-3 inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold text-white" style={{ background: BLUE }}>
              {lib.lastLesson ? "Continue" : "Begin"} <ArrowRight className="h-4 w-4" />
            </button>
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-2.5">
          <span className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold text-white" style={{ background: "linear-gradient(90deg,#c2410c,#f97316)" }}>
            <Flame className="h-3.5 w-3.5" /> {lib.streak}-day PD streak
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-ice px-3 py-1 text-xs font-bold text-navy"><GraduationCap className="h-3.5 w-3.5" /> {doneLessons}/{totalLessons} lessons</span>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-ice px-3 py-1 text-xs font-bold text-navy"><Clock className="h-3.5 w-3.5" /> {lib.totalDays} days studied</span>
        </div>
      </div>

      {/* quick tiles */}
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <Tile icon={Search} label="Search" sub="Find anything" onClick={() => go({ v: "search" })} />
        <Tile icon={Star} label="Favorites" sub="Your saved" onClick={() => go({ v: "favorites" })} />
        <Tile icon={Calendar} label="30-Day Challenge" sub="Nightingale" onClick={() => go({ v: "challenge" })} />
        {lib.role === "admin"
          ? <Tile icon={Settings} label="Manage Library" sub="Admin CMS" onClick={() => go({ v: "admin" })} />
          : <Tile icon={Headphones} label="Audio & PDFs" sub="Media library" onClick={() => go({ v: "search" })} />}
      </div>

      {/* Learning tracks */}
      {lib.tracks.length > 0 && (
        <div className="rounded-2xl border border-ice bg-white p-4 shadow-card">
          <p className="flex items-center gap-2 text-sm font-extrabold text-navy"><ListChecks className="h-4 w-4" style={{ color: BLUE }} /> Learning Tracks</p>
          <p className="mt-0.5 text-[12px] text-charcoal/50">Curated paths. Follow one from top to bottom.</p>
          <div className="mt-2.5 flex gap-2 overflow-x-auto pb-1">
            {lib.tracks.map((t) => (
              <div key={t.id} className="min-w-[190px] flex-shrink-0 rounded-xl border border-ice bg-offwhite/50 p-3">
                <p className="text-[13px] font-bold text-navy">{t.label}</p>
                <ol className="mt-1.5 space-y-1">{t.steps.slice(0, 5).map((s, i) => <li key={i} className="flex gap-1.5 text-[11.5px] text-charcoal/60"><span className="font-bold" style={{ color: BLUE }}>{i + 1}.</span> {s}</li>)}</ol>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* category rails */}
      {cats.map(([cat, list]) => (
        <div key={cat}>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-extrabold uppercase tracking-wide text-charcoal/50">{cat}</h3>
          </div>
          <div className="flex gap-3 overflow-x-auto pb-2">
            {list.map((m) => {
              const p = mcProgress(m, lib.completed);
              const accent = m.accent || BLUE;
              return (
                <button key={m.id} onClick={() => go({ v: "mc", id: m.id })} className="min-w-[230px] max-w-[230px] flex-shrink-0 overflow-hidden rounded-2xl border border-ice bg-white text-left shadow-card transition hover:shadow-lg">
                  <div className="p-4 text-white" style={{ background: `linear-gradient(135deg, ${accent}, ${accent}cc)` }}>
                    <p className="text-[10.5px] font-semibold uppercase tracking-[0.16em] opacity-85">{m.teacher}</p>
                    <p className="mt-1 text-[15px] font-extrabold leading-snug">{m.title}</p>
                    {m.book && <p className="mt-1 text-[11px] italic opacity-85">based on “{m.book}”</p>}
                  </div>
                  <div className="p-3">
                    <p className="line-clamp-2 text-[12px] text-charcoal/60">{m.subtitle}</p>
                    <div className="mt-2 flex items-center justify-between">
                      <span className="text-[11px] font-semibold text-charcoal/45">{m.lessons.length} lessons · {m.minutes}</span>
                      {p.done > 0 && <span className="text-[11px] font-bold" style={{ color: accent }}>{p.pct}%</span>}
                    </div>
                    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-ice"><div className="h-full rounded-full" style={{ width: `${p.pct}%`, background: accent }} /></div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function Tile({ icon: Icon, label, sub, onClick }: { icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>; label: string; sub: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="rounded-2xl border border-ice bg-white p-3.5 text-left shadow-card transition hover:bg-blue-50/40">
      <Icon className="h-5 w-5" style={{ color: BLUE }} />
      <p className="mt-2 text-[13px] font-extrabold text-navy">{label}</p>
      <p className="text-[11px] text-charcoal/50">{sub}</p>
    </button>
  );
}

/* ─────────────────────────── MASTERCLASS PATH ─────────────────────────── */
function McPath({ mc, lib, go }: { mc: Masterclass; lib: Lib; go: (v: View) => void }) {
  const accent = mc.accent || BLUE;
  const p = mcProgress(mc, lib.completed);
  const isFav = lib.favs.has(`masterclass:${mc.id}`);
  const media = lib.resources.filter((r) => r.masterclass_id === mc.id && !r.lesson_id);

  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-2xl text-white shadow-card" style={{ background: `linear-gradient(135deg, ${accent}, ${accent}bb)` }}>
        <div className="p-5">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] opacity-85">{mc.teacher}{mc.book ? ` · ${mc.book}` : ""}</p>
              <h2 className="mt-1 text-2xl font-extrabold">{mc.title}</h2>
              <p className="mt-1 text-[13.5px] opacity-90">{mc.subtitle}</p>
            </div>
            <button onClick={() => lib.toggleFav("masterclass", mc.id)} className="rounded-full bg-white/15 p-2" aria-label="Favorite">
              <Star className="h-5 w-5" fill={isFav ? "white" : "none"} />
            </button>
          </div>
          <div className="mt-3 flex items-center gap-3 text-[12px] font-semibold opacity-90">
            <span>{mc.lessons.length} lessons</span><span>·</span><span>{mc.minutes}</span><span>·</span><span>{p.done}/{p.total} done</span>
          </div>
        </div>
      </div>

      <p className="text-[14px] leading-relaxed text-charcoal/75">{mc.overview}</p>

      {/* lesson list */}
      <div className="rounded-2xl border border-ice bg-white p-3 shadow-card">
        {mc.lessons.map((l) => {
          const done = lib.completed.has(l.id);
          return (
            <button key={l.id} onClick={() => go({ v: "lesson", mc: mc.id, id: l.id })} className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-left transition hover:bg-offwhite">
              {done ? <CheckCircle2 className="h-5 w-5 flex-shrink-0" style={{ color: accent }} /> : <Circle className="h-5 w-5 flex-shrink-0 text-charcoal/25" />}
              <span className="flex-1">
                <span className="block text-[14px] font-bold text-navy">{l.num}. {l.title}</span>
                <span className="block text-[12px] text-charcoal/50">{l.minutes} min · {l.quiz.length} quiz Q{lib.quiz[l.id] ? ` · scored ${lib.quiz[l.id].score}/${lib.quiz[l.id].total}` : ""}</span>
              </span>
              <ArrowRight className="h-4 w-4 text-charcoal/30" />
            </button>
          );
        })}
      </div>

      {/* actions */}
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
        {mc.workbook && <Tile icon={PenLine} label="Workbook" sub={`${mc.workbook.sections.length} sections`} onClick={() => go({ v: "workbook", mc: mc.id })} />}
        <Tile icon={Sparkles} label="AI Study Mode" sub="Ask & apply" onClick={() => go({ v: "study", mc: mc.id, id: mc.lessons[0].id })} />
        {mc.id === "strangest-secret" && <Tile icon={Calendar} label="30-Day Challenge" sub="The test" onClick={() => go({ v: "challenge" })} />}
      </div>

      {/* uploaded media for this masterclass */}
      {media.length > 0 && (
        <Section label="Audio & PDF library" accent={accent}>
          <div className="space-y-2">{media.map((r) => <MediaRow key={r.id} r={r} go={go} accent={accent} />)}</div>
        </Section>
      )}

      {/* original resources */}
      {mc.original && mc.original.length > 0 && (
        <Section label="Get the real thing (official sources)" accent={accent}>
          <div className="space-y-1.5">{mc.original.map((o, i) => (
            <a key={i} href={o.url} target="_blank" rel="noreferrer" className="flex items-center gap-2 text-sm font-semibold hover:underline" style={{ color: accent }}>
              <ExternalLink className="h-4 w-4" /> {o.label}
            </a>
          ))}</div>
          <p className="mt-2 text-[11.5px] text-charcoal/45">We teach original training built on these ideas — we don&apos;t copy anyone&apos;s book or course. Support the authors by getting their work.</p>
        </Section>
      )}
    </div>
  );
}

function MediaRow({ r, go, accent }: { r: Resource; go: (v: View) => void; accent: string }) {
  const Icon = r.kind === "audio" ? Headphones : r.kind === "pdf" || r.kind === "workbook" ? FileText : r.kind === "video" ? PlayCircle : ExternalLink;
  const open = () => {
    if (r.external_url) { window.open(r.external_url, "_blank"); return; }
    if (!r.storage_path) return;
    if (r.kind === "audio") go({ v: "audio", path: r.storage_path, title: r.title });
    else go({ v: "pdf", path: r.storage_path, title: r.title });
  };
  return (
    <button onClick={open} className="flex w-full items-center gap-3 rounded-xl border border-ice bg-offwhite/40 p-3 text-left transition hover:bg-blue-50/40">
      <Icon className="h-5 w-5 flex-shrink-0" style={{ color: accent }} />
      <span className="flex-1">
        <span className="block text-[13.5px] font-bold text-navy">{r.title}</span>
        {r.description && <span className="block text-[12px] text-charcoal/55">{r.description}</span>}
      </span>
      <span className="text-[10px] font-bold uppercase tracking-wide text-charcoal/40">{r.kind}</span>
    </button>
  );
}

/* ─────────────────────────── LESSON VIEWER ─────────────────────────── */
function LessonView({ mc, id, lib, go }: { mc: Masterclass; id: string; lib: Lib; go: (v: View) => void }) {
  const accent = mc.accent || BLUE;
  const idx = mc.lessons.findIndex((l) => l.id === id);
  const l = mc.lessons[idx];
  const next = mc.lessons[idx + 1];
  const done = lib.completed.has(id);
  const isFav = lib.favs.has(`lesson:${id}`);
  const [showFive, setShowFive] = useState(false);
  const media = lib.resources.filter((r) => r.lesson_id === id);

  useEffect(() => { lib.setLast(mc.id, id); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [mc.id, id]);
  if (!l) return null;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em]" style={{ color: accent }}>{mc.teacher} · Lesson {l.num} · {l.minutes} min</p>
          <h2 className="mt-1 text-2xl font-extrabold tracking-tight text-navy">{l.title}</h2>
        </div>
        <button onClick={() => lib.toggleFav("lesson", id)} className="rounded-full border border-ice p-2" aria-label="Favorite"><Star className="h-5 w-5" style={{ color: accent }} fill={isFav ? accent : "none"} /></button>
      </div>

      {/* The lesson in 5 minutes */}
      <div className="rounded-2xl border-2 p-4" style={{ borderColor: accent, background: `${accent}0a` }}>
        <button onClick={() => setShowFive((s) => !s)} className="flex w-full items-center justify-between">
          <span className="flex items-center gap-2 text-[13px] font-extrabold" style={{ color: accent }}><Sparkles className="h-4 w-4" /> The Lesson in 5 Minutes</span>
          <span className="text-[12px] font-bold" style={{ color: accent }}>{showFive ? "Hide" : "Show"}</span>
        </button>
        {showFive && (
          <div className="mt-3 space-y-2.5 text-[14px] leading-relaxed text-charcoal/80">
            <p><b className="text-navy">Big idea:</b> {l.five.bigIdea}</p>
            <div><b className="text-navy">3 core principles:</b><ul className="mt-1 space-y-1">{l.five.principles.map((p, i) => <li key={i} className="flex gap-2"><span className="font-bold" style={{ color: accent }}>{i + 1}.</span> {p}</li>)}</ul></div>
            <p><b className="text-navy">What most get wrong:</b> {l.five.wrong}</p>
            <p><b className="text-navy">In One Mission:</b> {l.five.oneMission}</p>
            <p><b className="text-navy">Do today:</b> {l.five.today}</p>
          </div>
        )}
      </div>

      <Section label="Why this matters" accent={accent}><p className="text-[15px] leading-relaxed text-charcoal/80">{l.why}</p></Section>
      <Section label="The principle" accent={accent}><p className="text-[15px] leading-relaxed text-charcoal/80">{l.principle}</p></Section>
      <Section label="Explained simply" accent={accent}><p className="text-[15px] leading-relaxed text-charcoal/80">{l.beginner}</p></Section>
      <Section label="Real-life example" accent={accent}><p className="rounded-xl border border-ice bg-offwhite/60 p-3.5 text-[15px] italic leading-relaxed text-charcoal/75">{l.example}</p></Section>

      {l.whatToSay && l.whatToSay.length > 0 && (
        <Section label="What to say — copy & use" accent={accent}>
          <div className="space-y-2">{l.whatToSay.map((s, i) => <ScriptCard key={i} label={s.label} text={s.text} accent={accent} />)}</div>
        </Section>
      )}
      {l.whatNotToSay && l.whatNotToSay.length > 0 && (
        <Section label="What NOT to say" accent={accent}>
          <ul className="space-y-1.5">{l.whatNotToSay.map((m, i) => <li key={i} className="flex gap-2 text-[14px] text-charcoal/75"><X className="mt-0.5 h-4 w-4 flex-shrink-0 text-red-400" />{m}</li>)}</ul>
        </Section>
      )}

      <Section label="Common mistakes" accent={accent}>
        <ul className="space-y-1.5">{l.mistakes.map((m, i) => <li key={i} className="flex gap-2 text-[14px] text-charcoal/75"><X className="mt-0.5 h-4 w-4 flex-shrink-0 text-red-400" />{m}</li>)}</ul>
      </Section>

      <div className="rounded-2xl border-2 p-4" style={{ borderColor: accent, background: `${accent}0a` }}>
        <p className="text-[11px] font-bold uppercase tracking-[0.14em]" style={{ color: accent }}>Apply it in One Mission</p>
        <p className="mt-1 text-[15px] leading-relaxed text-navy">{l.application}</p>
      </div>

      <Section label="Practice" accent={accent}><p className="text-[15px] leading-relaxed text-charcoal/80">{l.practice}</p></Section>

      {/* AI + roleplay */}
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        <button onClick={() => go({ v: "study", mc: mc.id, id })} className="flex items-center justify-between rounded-xl border-2 px-4 py-3 text-left" style={{ borderColor: accent }}>
          <span><span className="flex items-center gap-2 text-sm font-extrabold text-navy"><Sparkles className="h-4 w-4" style={{ color: accent }} /> Study this with AI</span><span className="text-[12px] text-charcoal/55">Ask questions, get quizzed, apply it</span></span>
          <ArrowRight className="h-4 w-4" style={{ color: accent }} />
        </button>
        {l.roleplay && (
          <button onClick={() => go({ v: "roleplay", mc: mc.id, id, scenario: l.roleplay!.scenario })} className="flex items-center justify-between rounded-xl border-2 px-4 py-3 text-left" style={{ borderColor: accent }}>
            <span><span className="flex items-center gap-2 text-sm font-extrabold text-navy"><MessageCircle className="h-4 w-4" style={{ color: accent }} /> Role-play: {l.roleplay.scenario}</span><span className="text-[12px] text-charcoal/55">Practice the conversation live</span></span>
            <ArrowRight className="h-4 w-4" style={{ color: accent }} />
          </button>
        )}
      </div>

      <div className="rounded-2xl border-2 p-4" style={{ borderColor: accent, background: `${accent}0a` }}>
        <p className="text-[11px] font-bold uppercase tracking-[0.14em]" style={{ color: accent }}>Take action today</p>
        <p className="mt-1 text-[15px] font-semibold text-navy">{l.action}</p>
      </div>

      {/* quiz + notes */}
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        <button onClick={() => go({ v: "quiz", mc: mc.id, id })} className="flex items-center justify-between rounded-xl border border-ice bg-white px-4 py-3 text-left shadow-card">
          <span className="flex items-center gap-2 text-sm font-extrabold text-navy"><ListChecks className="h-4 w-4" style={{ color: accent }} /> Take the quiz ({l.quiz.length} Q)</span>
          {lib.quiz[id] && <span className="text-[12px] font-bold" style={{ color: accent }}>{lib.quiz[id].score}/{lib.quiz[id].total}</span>}
        </button>
      </div>

      <NoteBox value={lib.notes[id] || ""} onSave={(v) => lib.saveNote(mc.id, id, v)} accent={accent} />

      {media.length > 0 && <Section label="Resources for this lesson" accent={accent}><div className="space-y-2">{media.map((r) => <MediaRow key={r.id} r={r} go={go} accent={accent} />)}</div></Section>}

      {l.resource && l.resource.length > 0 && (
        <Section label="Original resource" accent={accent}>
          <div className="space-y-1.5">{l.resource.map((o, i) => <a key={i} href={o.url} target="_blank" rel="noreferrer" className="flex items-center gap-2 text-sm font-semibold hover:underline" style={{ color: accent }}><ExternalLink className="h-4 w-4" /> {o.label}</a>)}</div>
        </Section>
      )}

      {/* complete + next */}
      <div className="flex flex-wrap items-center gap-3 border-t border-ice pt-4">
        {done ? (
          <>
            <span className="inline-flex items-center gap-1.5 rounded-xl bg-green-50 px-4 py-2.5 text-sm font-bold text-green-700"><Check className="h-4 w-4" /> Completed</span>
            <button onClick={() => lib.toggleComplete(mc.id, id, false)} className="text-sm font-semibold text-charcoal/45">Mark incomplete</button>
          </>
        ) : (
          <button onClick={() => lib.toggleComplete(mc.id, id, true)} className="inline-flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-bold text-white" style={{ background: accent }}><Check className="h-4 w-4" /> Mark complete</button>
        )}
        {next
          ? <button onClick={() => go({ v: "lesson", mc: mc.id, id: next.id })} className="ml-auto inline-flex items-center gap-2 text-sm font-bold" style={{ color: accent }}>Next: {next.title} <ArrowRight className="h-4 w-4" /></button>
          : <button onClick={() => go({ v: "mc", id: mc.id })} className="ml-auto inline-flex items-center gap-2 text-sm font-bold" style={{ color: accent }}>Back to masterclass <ArrowRight className="h-4 w-4" /></button>}
      </div>
    </div>
  );
}

function Section({ label, accent = BLUE, children }: { label: string; accent?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-ice bg-white p-4 shadow-card">
      <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.14em]" style={{ color: accent }}>{label}</p>
      {children}
    </div>
  );
}

function ScriptCard({ label, text, accent }: { label: string; text: string; accent: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-xl border border-ice bg-offwhite/50 p-3">
      <div className="flex items-center justify-between">
        <p className="text-[12px] font-bold text-navy">{label}</p>
        <button onClick={() => { navigator.clipboard?.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1200); }} className="text-[11px] font-bold" style={{ color: accent }}>{copied ? "Copied ✓" : "Copy"}</button>
      </div>
      <p className="mt-1 text-[13.5px] leading-relaxed text-charcoal/75">{text}</p>
    </div>
  );
}

function NoteBox({ value, onSave, accent }: { value: string; onSave: (v: string) => void; accent: string }) {
  const [v, setV] = useState(value);
  const [saved, setSaved] = useState(false);
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => setV(value), [value]);
  const change = (nv: string) => {
    setV(nv);
    if (t.current) clearTimeout(t.current);
    t.current = setTimeout(() => { onSave(nv); setSaved(true); setTimeout(() => setSaved(false), 1200); }, 700);
  };
  return (
    <Section label="My notes" accent={accent}>
      <textarea value={v} onChange={(e) => change(e.target.value)} rows={3} placeholder="Write what stood out and what you'll do…" className="w-full resize-y rounded-xl border border-ice bg-offwhite/40 p-3 text-[14px] outline-none focus:border-charcoal/30" />
      <p className="mt-1 text-[11px] text-charcoal/40">{saved ? "Saved ✓" : "Autosaves as you type."}</p>
    </Section>
  );
}

/* ─────────────────────────── QUIZ ─────────────────────────── */
function QuizView({ mc, id, lib, go }: { mc: Masterclass; id: string; lib: Lib; go: (v: View) => void }) {
  const accent = mc.accent || BLUE;
  const l = mc.lessons.find((x) => x.id === id)!;
  const [answers, setAnswers] = useState<Record<number, number>>({});
  const [submitted, setSubmitted] = useState(false);
  const score = l.quiz.reduce((n, q, i) => n + (answers[i] === q.correct ? 1 : 0), 0);

  const submit = () => { setSubmitted(true); lib.saveQuiz(id, score, l.quiz.length); };

  return (
    <div className="space-y-4">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em]" style={{ color: accent }}>Quiz · {l.title}</p>
        <h2 className="mt-1 text-xl font-extrabold text-navy">Check your understanding</h2>
      </div>
      {l.quiz.map((q, i) => (
        <div key={i} className="rounded-2xl border border-ice bg-white p-4 shadow-card">
          <p className="text-[14.5px] font-bold text-navy">{i + 1}. {q.q}</p>
          <div className="mt-2.5 space-y-2">
            {q.options.map((opt, oi) => {
              const chosen = answers[i] === oi;
              const correct = submitted && oi === q.correct;
              const wrong = submitted && chosen && oi !== q.correct;
              return (
                <button key={oi} disabled={submitted} onClick={() => setAnswers((a) => ({ ...a, [i]: oi }))}
                  className="flex w-full items-center gap-2.5 rounded-xl border-2 px-3.5 py-2.5 text-left text-[14px] transition"
                  style={{ borderColor: correct ? "#16a34a" : wrong ? "#ef4444" : chosen ? accent : "#e5edf6", background: correct ? "#f0fdf4" : wrong ? "#fef2f2" : chosen ? `${accent}0c` : "white" }}>
                  <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border-2 text-[11px] font-bold" style={{ borderColor: correct ? "#16a34a" : wrong ? "#ef4444" : chosen ? accent : "#cbd5e1", color: correct ? "#16a34a" : wrong ? "#ef4444" : chosen ? accent : "#94a3b8" }}>{String.fromCharCode(65 + oi)}</span>
                  <span className="text-charcoal/80">{opt}</span>
                </button>
              );
            })}
          </div>
          {submitted && <p className="mt-2 rounded-lg bg-offwhite/70 p-2.5 text-[13px] text-charcoal/70"><b className="text-navy">Why:</b> {q.why}</p>}
        </div>
      ))}
      {!submitted ? (
        <button onClick={submit} disabled={Object.keys(answers).length < l.quiz.length} className="inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-bold text-white disabled:opacity-40" style={{ background: accent }}>Submit answers</button>
      ) : (
        <div className="rounded-2xl border-2 p-4 text-center" style={{ borderColor: accent, background: `${accent}0a` }}>
          <p className="text-2xl font-extrabold text-navy">{score}/{l.quiz.length}</p>
          <p className="mt-1 text-[13px] text-charcoal/60">{score === l.quiz.length ? "Perfect — you've got it." : "Review the explanations and try again anytime."}</p>
          <div className="mt-3 flex justify-center gap-3">
            <button onClick={() => { setSubmitted(false); setAnswers({}); }} className="rounded-xl border border-ice px-4 py-2 text-sm font-bold text-navy">Retake</button>
            <button onClick={() => go({ v: "lesson", mc: mc.id, id })} className="rounded-xl px-4 py-2 text-sm font-bold text-white" style={{ background: accent }}>Back to lesson</button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────── WORKBOOK ─────────────────────────── */
function WorkbookView({ mc, lib }: { mc: Masterclass; lib: Lib }) {
  const accent = mc.accent || BLUE;
  const wb = mc.workbook as Workbook;
  const [answers, setAnswers] = useState<Record<string, string>>(lib.workbook[wb.id] || {});
  const [saved, setSaved] = useState(false);
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { setAnswers(lib.workbook[wb.id] || {}); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [wb.id]);

  const change = (fid: string, v: string) => {
    const na = { ...answers, [fid]: v };
    setAnswers(na);
    if (t.current) clearTimeout(t.current);
    t.current = setTimeout(() => { lib.saveWorkbook(wb.id, na); setSaved(true); setTimeout(() => setSaved(false), 1200); }, 700);
  };
  const filled = wb.sections.reduce((n, s) => n + s.fields.filter((f) => (answers[f.id] || "").trim()).length, 0);
  const totalFields = wb.sections.reduce((n, s) => n + s.fields.length, 0);

  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-2xl p-5 text-white shadow-card" style={{ background: `linear-gradient(135deg, ${accent}, ${accent}bb)` }}>
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] opacity-85">Interactive Workbook</p>
        <h2 className="mt-1 text-xl font-extrabold">{wb.title}</h2>
        <p className="mt-1 text-[12.5px] opacity-90">{filled}/{totalFields} answered · autosaves as you type</p>
      </div>
      {wb.sections.map((s, si) => (
        <div key={si} className="rounded-2xl border border-ice bg-white p-4 shadow-card">
          <p className="text-[13px] font-extrabold text-navy">{si + 1}. {s.title}</p>
          {s.fields.map((f) => (
            <div key={f.id} className="mt-2">
              <label className="text-[12.5px] font-semibold text-charcoal/60">{f.label}</label>
              {f.hint && <p className="text-[11px] text-charcoal/40">{f.hint}</p>}
              <textarea value={answers[f.id] || ""} onChange={(e) => change(f.id, e.target.value)} rows={2} className="mt-1 w-full resize-y rounded-xl border border-ice bg-offwhite/40 p-2.5 text-[14px] outline-none focus:border-charcoal/30" />
            </div>
          ))}
        </div>
      ))}
      <p className="text-center text-[12px] text-charcoal/45">{saved ? "Saved ✓" : "Your answers save automatically and stay private to you."}</p>
    </div>
  );
}

/* ─────────────────────────── AI CHAT (study + roleplay) ─────────────────────────── */
function lessonContext(mc: Masterclass, l: GreatLesson): string {
  return [
    `Masterclass: ${mc.title} (${mc.teacher}${mc.book ? `, based on "${mc.book}"` : ""}).`,
    `Lesson ${l.num}: ${l.title}.`,
    `Big idea: ${l.five.bigIdea}`,
    `Principle: ${l.principle}`,
    `Explained simply: ${l.beginner}`,
    `One Mission application: ${l.application}`,
    `Common mistakes: ${l.mistakes.join(" | ")}`,
    `Action: ${l.action}`,
  ].join("\n");
}

function AiChat({ mode, mc, id, scenario }: { mode: "study" | "roleplay"; mc: Masterclass; id: string; scenario?: string }) {
  const accent = mc.accent || BLUE;
  const l = mc.lessons.find((x) => x.id === id) || mc.lessons[0];
  const ctx = useMemo(() => lessonContext(mc, l), [mc, l]);
  const [msgs, setMsgs] = useState<{ role: "user" | "assistant"; content: string }[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [notConfigured, setNotConfigured] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { boxRef.current?.scrollTo(0, boxRef.current.scrollHeight); }, [msgs, busy]);

  const suggestions = mode === "study"
    ? ["Explain this like I'm brand new", "Quiz me on this lesson", "How do I apply this in One Mission today?"]
    : [];

  const send = async (text: string) => {
    const t = text.trim(); if (!t || busy) return;
    const next = [...msgs, { role: "user" as const, content: t }];
    setMsgs(next); setInput(""); setBusy(true);
    try {
      const r = await fetch("/api/greats/coach", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode, scenario, context: ctx, messages: next }) });
      const d = await r.json();
      if (d?.notConfigured) { setNotConfigured(true); setBusy(false); return; }
      setMsgs([...next, { role: "assistant", content: d?.reply || "…" }]);
    } catch { setMsgs([...next, { role: "assistant", content: "Something went wrong. Try again." }]); }
    setBusy(false);
  };

  return (
    <div className="flex h-[70vh] flex-col rounded-2xl border border-ice bg-white shadow-card">
      <div className="border-b border-ice p-4">
        <p className="flex items-center gap-2 text-sm font-extrabold text-navy">
          {mode === "study" ? <Sparkles className="h-4 w-4" style={{ color: accent }} /> : <MessageCircle className="h-4 w-4" style={{ color: accent }} />}
          {mode === "study" ? "AI Study Mode" : `Role-play · ${scenario}`}
        </p>
        <p className="text-[12px] text-charcoal/50">{mode === "study" ? `Grounded in “${l.title}.” Ask anything; end with an action.` : "The AI plays a realistic person. Practice, then send [SCORE] for feedback."}</p>
      </div>
      <div ref={boxRef} className="flex-1 space-y-3 overflow-y-auto p-4">
        {msgs.length === 0 && (
          <div className="text-center text-[13px] text-charcoal/45">
            {mode === "study" ? "Ask a question to begin." : `Say your opening line for “${scenario}.”`}
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2.5 text-[14px] leading-relaxed ${m.role === "user" ? "text-white" : "bg-offwhite text-charcoal/85"}`} style={m.role === "user" ? { background: accent } : undefined}>{m.content}</div>
          </div>
        ))}
        {busy && <div className="flex justify-start"><div className="rounded-2xl bg-offwhite px-3.5 py-2.5"><Loader2 className="h-4 w-4 animate-spin text-charcoal/40" /></div></div>}
        {notConfigured && <div className="rounded-xl bg-amber-50 p-3 text-[13px] text-amber-800">AI study mode isn&apos;t available right now. You can still read the lesson and use the workbook.</div>}
      </div>
      {suggestions.length > 0 && msgs.length === 0 && (
        <div className="flex flex-wrap gap-2 border-t border-ice p-3">
          {suggestions.map((s) => <button key={s} onClick={() => send(s)} className="rounded-full border border-ice bg-offwhite px-3 py-1.5 text-[12px] font-semibold text-charcoal/70">{s}</button>)}
        </div>
      )}
      <div className="flex items-center gap-2 border-t border-ice p-3">
        <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") send(input); }} placeholder={mode === "roleplay" ? "Type what you'd say…" : "Ask a question…"} className="flex-1 rounded-xl border border-ice bg-offwhite/40 px-3.5 py-2.5 text-[14px] outline-none focus:border-charcoal/30" />
        {mode === "roleplay" && <button onClick={() => send("[SCORE]")} disabled={busy || msgs.length === 0} className="rounded-xl border border-ice px-3 py-2.5 text-[12px] font-bold text-navy disabled:opacity-40">Score me</button>}
        <button onClick={() => send(input)} disabled={busy || !input.trim()} className="rounded-xl px-3.5 py-2.5 text-white disabled:opacity-40" style={{ background: accent }}><Send className="h-4 w-4" /></button>
      </div>
    </div>
  );
}

/* ─────────────────────────── MEDIA players ─────────────────────────── */
function useSignedUrl(path: string) {
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let alive = true;
    fetch(`/api/greats/file?path=${encodeURIComponent(path)}`, { cache: "no-store" }).then((r) => r.json()).then((d) => { if (alive) { if (d?.ok) setUrl(d.url); else setErr(true); } }).catch(() => alive && setErr(true));
    return () => { alive = false; };
  }, [path]);
  return { url, err };
}

function MediaAudio({ path, title }: { path: string; title: string }) {
  const { url, err } = useSignedUrl(path);
  return (
    <div className="space-y-3">
      <h2 className="flex items-center gap-2 text-xl font-extrabold text-navy"><Headphones className="h-5 w-5" style={{ color: BLUE }} /> {title}</h2>
      {err && <p className="text-sm text-charcoal/50">This audio isn&apos;t available.</p>}
      {url && <div className="rounded-2xl border border-ice bg-white p-4 shadow-card"><audio controls src={url} className="w-full" /></div>}
      {!url && !err && <div className="rounded-2xl border border-ice bg-white p-6 text-center shadow-card"><Loader2 className="mx-auto h-5 w-5 animate-spin text-charcoal/30" /></div>}
    </div>
  );
}

function MediaPdf({ path, title }: { path: string; title: string }) {
  const { url, err } = useSignedUrl(path);
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-xl font-extrabold text-navy"><FileText className="h-5 w-5" style={{ color: BLUE }} /> {title}</h2>
        {url && <a href={url} target="_blank" rel="noreferrer" className="text-sm font-bold" style={{ color: BLUE }}>Open ↗</a>}
      </div>
      {err && <p className="text-sm text-charcoal/50">This document isn&apos;t available.</p>}
      {url && <iframe src={url} title={title} className="h-[75vh] w-full rounded-2xl border border-ice bg-white shadow-card" />}
      {!url && !err && <div className="rounded-2xl border border-ice bg-white p-6 text-center shadow-card"><Loader2 className="mx-auto h-5 w-5 animate-spin text-charcoal/30" /></div>}
    </div>
  );
}

/* ─────────────────────────── SEARCH ─────────────────────────── */
function SearchView({ lib, go }: { lib: Lib; go: (v: View) => void }) {
  const [q, setQ] = useState("");
  const ql = q.trim().toLowerCase();
  const lessons = ql ? lib.mcs.flatMap((m) => m.lessons.map((l) => ({ m, l }))).filter(({ m, l }) => (l.title + " " + l.principle + " " + l.beginner + " " + m.teacher + " " + m.title).toLowerCase().includes(ql)) : [];
  const media = ql ? lib.resources.filter((r) => (r.title + " " + (r.description || "") + " " + r.kind).toLowerCase().includes(ql)) : [];
  const mcs = ql ? lib.mcs.filter((m) => (m.title + " " + m.teacher + " " + (m.book || "") + " " + m.category).toLowerCase().includes(ql)) : [];
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 rounded-xl border border-ice bg-white px-3 py-2.5 shadow-card">
        <Search className="h-4 w-4 text-charcoal/40" />
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search lessons, teachers, audio, PDFs…" className="flex-1 text-sm outline-none" />
      </div>
      {!ql && <p className="text-sm text-charcoal/40">Try “persistence”, “assets”, “identity”, or a teacher&apos;s name.</p>}
      {ql && mcs.length + lessons.length + media.length === 0 && <p className="text-sm text-charcoal/40">No matches. Try a different word.</p>}
      {mcs.length > 0 && <Group label="Masterclasses">{mcs.map((m) => <button key={m.id} onClick={() => go({ v: "mc", id: m.id })} className="block w-full rounded-lg border border-ice bg-white px-3 py-2 text-left text-sm font-semibold text-navy hover:bg-offwhite">{m.title} · <span className="text-charcoal/50">{m.teacher}</span></button>)}</Group>}
      {lessons.length > 0 && <Group label="Lessons">{lessons.slice(0, 40).map(({ m, l }) => <button key={m.id + l.id} onClick={() => go({ v: "lesson", mc: m.id, id: l.id })} className="block w-full rounded-lg border border-ice bg-white px-3 py-2 text-left text-sm text-charcoal/75 hover:bg-offwhite"><b className="text-navy">{l.title}</b> — {m.title}</button>)}</Group>}
      {media.length > 0 && <Group label="Audio & PDFs">{media.map((r) => <MediaRow key={r.id} r={r} go={go} accent={BLUE} />)}</Group>}
    </div>
  );
}
function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><p className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.14em] text-charcoal/40">{label}</p><div className="space-y-1.5">{children}</div></div>;
}

/* ─────────────────────────── FAVORITES ─────────────────────────── */
function Favorites({ lib, go }: { lib: Lib; go: (v: View) => void }) {
  const favMcs = lib.mcs.filter((m) => lib.favs.has(`masterclass:${m.id}`));
  const favLessons = lib.mcs.flatMap((m) => m.lessons.map((l) => ({ m, l }))).filter(({ l }) => lib.favs.has(`lesson:${l.id}`));
  const empty = favMcs.length + favLessons.length === 0;
  return (
    <div className="space-y-4">
      <h2 className="flex items-center gap-2 text-xl font-extrabold text-navy"><Star className="h-5 w-5" style={{ color: BLUE }} /> Your favorites</h2>
      {empty && <p className="text-sm text-charcoal/45">Tap the star on any masterclass or lesson to save it here.</p>}
      {favMcs.length > 0 && <Group label="Masterclasses">{favMcs.map((m) => <button key={m.id} onClick={() => go({ v: "mc", id: m.id })} className="block w-full rounded-lg border border-ice bg-white px-3 py-2 text-left text-sm font-semibold text-navy hover:bg-offwhite">{m.title} · <span className="text-charcoal/50">{m.teacher}</span></button>)}</Group>}
      {favLessons.length > 0 && <Group label="Lessons">{favLessons.map(({ m, l }) => <button key={m.id + l.id} onClick={() => go({ v: "lesson", mc: m.id, id: l.id })} className="block w-full rounded-lg border border-ice bg-white px-3 py-2 text-left text-sm text-charcoal/75 hover:bg-offwhite"><b className="text-navy">{l.title}</b> — {m.title}</button>)}</Group>}
    </div>
  );
}

/* ─────────────────────────── 30-DAY CHALLENGE ─────────────────────────── */
function ChallengeView({ lib, go }: { lib: Lib; go: (v: View) => void }) {
  const accent = "#0891b2";
  const cid = "strangest-secret-30";
  const existing = lib.challenge.find((c) => c.challenge_id === cid);
  const [goal, setGoal] = useState(existing?.goal || "");
  const [days, setDays] = useState<number[]>(existing?.days_done || []);
  const [start, setStart] = useState<string | null>(existing?.start_date || null);
  useEffect(() => {
    const e = lib.challenge.find((c) => c.challenge_id === cid);
    if (e) { setGoal(e.goal || ""); setDays(e.days_done || []); setStart(e.start_date || null); }
  }, [lib.challenge]);

  const dayNum = start ? Math.min(30, Math.floor((Date.parse(todayStr()) - Date.parse(start)) / 86400000) + 1) : 0;
  const saveGoalStart = () => {
    const s = start || todayStr();
    setStart(s);
    lib.saveChallenge({ challengeId: cid, goal, start: s });
  };
  const toggleDay = (d: number) => {
    if (!start) return;
    const on = !days.includes(d);
    const nd = on ? [...days, d].sort((a, b) => a - b) : days.filter((x) => x !== d);
    setDays(nd);
    lib.saveChallenge({ challengeId: cid, dayDone: d });
  };
  const doneCount = days.length;
  const mcExists = lib.mcs.some((m) => m.id === "strangest-secret");

  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-2xl p-5 text-white shadow-card" style={{ background: `linear-gradient(135deg, ${accent}, ${accent}bb)` }}>
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] opacity-85">Earl Nightingale · The Strangest Secret</p>
        <h2 className="mt-1 text-2xl font-extrabold">The 30-Day Challenge</h2>
        <p className="mt-1 text-[13px] opacity-90">For 30 days: hold your one goal in mind, act on it daily, and each time a negative thought shows up, replace it with your goal. Slip up? Start fresh the next day. Prove to yourself that you become what you think about.</p>
      </div>

      <Section label="Step 1 — Your one goal" accent={accent}>
        <textarea value={goal} onChange={(e) => setGoal(e.target.value)} rows={2} placeholder="The one goal you'll hold in mind for 30 days…" className="w-full resize-y rounded-xl border border-ice bg-offwhite/40 p-3 text-[14px] outline-none focus:border-charcoal/30" />
        <button onClick={saveGoalStart} className="mt-2 rounded-xl px-4 py-2 text-sm font-bold text-white" style={{ background: accent }}>{start ? "Save goal" : "Start my 30 days"}</button>
      </Section>

      {start && (
        <Section label={`Step 2 — Mark each day (Day ${dayNum} of 30 · ${doneCount} done)`} accent={accent}>
          <div className="grid grid-cols-6 gap-2 sm:grid-cols-10">
            {Array.from({ length: 30 }, (_, i) => i + 1).map((d) => {
              const done = days.includes(d);
              const reachable = d <= dayNum;
              return (
                <button key={d} disabled={!reachable} onClick={() => toggleDay(d)}
                  className="flex aspect-square items-center justify-center rounded-lg border-2 text-[12px] font-bold transition disabled:opacity-30"
                  style={{ borderColor: done ? accent : "#e5edf6", background: done ? accent : "white", color: done ? "white" : "#64748b" }}>{d}</button>
              );
            })}
          </div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-ice"><div className="h-full rounded-full" style={{ width: `${Math.round((doneCount / 30) * 100)}%`, background: accent }} /></div>
          {doneCount >= 30 && <p className="mt-3 rounded-xl bg-green-50 p-3 text-center text-[14px] font-bold text-green-700">🎉 30 days complete. You proved the secret. What changed?</p>}
        </Section>
      )}

      {mcExists && <button onClick={() => go({ v: "mc", id: "strangest-secret" })} className="inline-flex items-center gap-2 text-sm font-bold" style={{ color: accent }}>Read the full masterclass <ArrowRight className="h-4 w-4" /></button>}
    </div>
  );
}

/* ─────────────────────────── ADMIN CMS ─────────────────────────── */
type AdminRes = Resource & { created_at?: string };
function AdminCms({ lib }: { lib: Lib }) {
  const [rows, setRows] = useState<AdminRes[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [msg, setMsg] = useState("");
  const load = useCallback(() => {
    fetch("/api/greats/admin", { cache: "no-store" }).then((r) => r.json()).then((d) => { if (d?.ok) setRows(d.resources || []); setLoaded(true); }).catch(() => setLoaded(true));
  }, []);
  useEffect(() => { load(); }, [load]);

  const mcOptions = lib.mcs.map((m) => ({ id: m.id, title: m.title, lessons: m.lessons.map((l) => ({ id: l.id, title: `${l.num}. ${l.title}` })) }));

  return (
    <div className="space-y-4">
      <h2 className="flex items-center gap-2 text-xl font-extrabold text-navy"><Settings className="h-5 w-5" style={{ color: BLUE }} /> Manage Library</h2>
      <p className="text-[13px] text-charcoal/55">Upload audio, PDFs, and workbooks, attach them to a masterclass or lesson, and publish. Only published items appear for members.</p>
      {msg && <p className="rounded-lg bg-blue-50 p-2.5 text-[13px] text-blue-700">{msg}</p>}

      <AdminUpload mcOptions={mcOptions} onDone={(m) => { setMsg(m); load(); }} />

      <div className="space-y-2">
        <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-charcoal/40">All resources ({rows.length})</p>
        {!loaded && <Loader2 className="h-5 w-5 animate-spin text-charcoal/30" />}
        {loaded && rows.length === 0 && <p className="text-sm text-charcoal/40">Nothing uploaded yet.</p>}
        {rows.map((r) => (
          <div key={r.id} className="flex items-center gap-3 rounded-xl border border-ice bg-white p-3 shadow-card">
            <span className="flex-1">
              <span className="block text-[13.5px] font-bold text-navy">{r.title} <span className="text-[11px] font-normal text-charcoal/40">· {r.kind}</span></span>
              <span className="block text-[11.5px] text-charcoal/50">{r.masterclass_id || "—"}{r.lesson_id ? ` / ${r.lesson_id}` : ""}{r.storage_path ? " · file" : r.external_url ? " · link" : ""}</span>
            </span>
            <button onClick={() => { fetch("/api/greats/admin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "publish", id: r.id, published: !r.published }) }).then(load); }}
              className="rounded-full px-2.5 py-1 text-[11px] font-bold" style={{ background: r.published ? "#dcfce7" : "#f1f5f9", color: r.published ? "#15803d" : "#64748b" }}>{r.published ? "Published" : "Draft"}</button>
            <button onClick={() => { if (confirm("Delete this resource?")) fetch("/api/greats/admin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "delete", id: r.id }) }).then(load); }} className="text-charcoal/30 hover:text-red-500"><X className="h-4 w-4" /></button>
          </div>
        ))}
      </div>
    </div>
  );
}

function AdminUpload({ mcOptions, onDone }: { mcOptions: { id: string; title: string; lessons: { id: string; title: string }[] }[]; onDone: (msg: string) => void }) {
  const [kind, setKind] = useState("pdf");
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [mc, setMc] = useState("");
  const [lesson, setLesson] = useState("");
  const [externalUrl, setExternalUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const lessons = mcOptions.find((m) => m.id === mc)?.lessons || [];

  const submit = async () => {
    if (!title.trim()) { onDone("Add a title first."); return; }
    setBusy(true);
    try {
      let storagePath = "";
      if (file && kind !== "link") {
        const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
        const path = `${mc || "general"}/${Date.now()}_${safe}`;
        const sign = await fetch("/api/greats/admin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "signedUpload", path, contentType: file.type }) }).then((r) => r.json());
        if (!sign?.ok || !sign.signedUrl) { onDone("Could not get an upload URL."); setBusy(false); return; }
        const up = await fetch(sign.signedUrl, { method: "PUT", headers: { "content-type": file.type || "application/octet-stream" }, body: file });
        if (!up.ok) { onDone("Upload failed."); setBusy(false); return; }
        storagePath = sign.path;
      }
      const create = await fetch("/api/greats/admin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "create", kind, title, description: desc, masterclassId: mc || null, lessonId: lesson || null, externalUrl: externalUrl || null, storagePath: storagePath || null, published: true }) }).then((r) => r.json());
      if (create?.ok) { onDone("Added ✓"); setTitle(""); setDesc(""); setExternalUrl(""); setFile(null); }
      else onDone("Could not save the resource.");
    } catch { onDone("Something went wrong."); }
    setBusy(false);
  };

  return (
    <div className="rounded-2xl border border-ice bg-white p-4 shadow-card">
      <p className="text-[13px] font-extrabold text-navy">Add a resource</p>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <select value={kind} onChange={(e) => setKind(e.target.value)} className="rounded-lg border border-ice bg-offwhite/40 px-2.5 py-2 text-sm">
          <option value="pdf">PDF</option><option value="audio">Audio</option><option value="video">Video</option><option value="workbook">Workbook</option><option value="link">External link</option>
        </select>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" className="rounded-lg border border-ice bg-offwhite/40 px-2.5 py-2 text-sm outline-none" />
        <select value={mc} onChange={(e) => { setMc(e.target.value); setLesson(""); }} className="rounded-lg border border-ice bg-offwhite/40 px-2.5 py-2 text-sm">
          <option value="">— Masterclass (optional) —</option>
          {mcOptions.map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}
        </select>
        <select value={lesson} onChange={(e) => setLesson(e.target.value)} disabled={!mc} className="rounded-lg border border-ice bg-offwhite/40 px-2.5 py-2 text-sm disabled:opacity-40">
          <option value="">— Whole masterclass —</option>
          {lessons.map((l) => <option key={l.id} value={l.id}>{l.title}</option>)}
        </select>
      </div>
      <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Short description (optional)" className="mt-2 w-full rounded-lg border border-ice bg-offwhite/40 px-2.5 py-2 text-sm outline-none" />
      {kind === "link"
        ? <input value={externalUrl} onChange={(e) => setExternalUrl(e.target.value)} placeholder="https://…" className="mt-2 w-full rounded-lg border border-ice bg-offwhite/40 px-2.5 py-2 text-sm outline-none" />
        : <input type="file" onChange={(e) => setFile(e.target.files?.[0] || null)} className="mt-2 w-full text-sm" accept={kind === "audio" ? "audio/*" : kind === "video" ? "video/*" : "application/pdf"} />}
      <button onClick={submit} disabled={busy} className="mt-3 inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-bold text-white disabled:opacity-40" style={{ background: BLUE }}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Add & publish</button>
    </div>
  );
}
