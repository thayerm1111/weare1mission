"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import {
  GraduationCap, ChevronLeft, Check, Lock, Circle, Sparkles, MessageCircle,
  Target, Zap, Flame, Search, Copy, Send, Loader2, BookOpen, ArrowRight,
  LifeBuoy, Trophy, X, PlayCircle, ExternalLink,
} from "lucide-react";
import {
  MODULES, PHASES, LEVELS, levelForCompleted, PRINCIPLES, DAILY_PLANS, LAUNCH_ITEMS,
  HELP_NOW, ROLEPLAY_SCENARIOS, GREATS, type Module, type ToolKey,
} from "@/data/academy";

/* ───────────────────────── state / persistence ───────────────────────── */
type Activity = { conversations: number; invites: number; presentations: number; followups: number; enrollments: number; events: number; training_days: number };
type View =
  | { v: "home" } | { v: "lesson"; id: string } | { v: "coach" } | { v: "roleplay" }
  | { v: "tool"; key: ToolKey } | { v: "resources" } | { v: "search" } | { v: "first" };

const BLUE = "#2563eb"; // deeper blue accent

export function AffiliateAcademy({ firstName = "there" }: { firstName?: string }) {
  const [view, setView] = useState<View>({ v: "home" });
  const [helpOpen, setHelpOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // persisted
  const [completed, setCompleted] = useState<Set<string>>(new Set());
  const [why, setWhy] = useState<Record<string, string>>({});
  const [prospects, setProspects] = useState<{ name: string; category: string }[]>([]);
  const [launch, setLaunch] = useState<Set<string>>(new Set());
  const [daily, setDaily] = useState<{ dates: string[] }>({ dates: [] });
  const [activity, setActivity] = useState<Activity>({ conversations: 0, invites: 0, presentations: 0, followups: 0, enrollments: 0, events: 0, training_days: 0 });

  useEffect(() => {
    let alive = true;
    fetch("/api/academy", { cache: "no-store" }).then((r) => r.json()).then((d) => {
      if (!alive || !d?.ok) { setLoaded(true); return; }
      const s = d.state || {};
      setCompleted(new Set(s.completed_lessons || []));
      setWhy(s.why || {});
      setProspects(Array.isArray(s.prospects) ? s.prospects : []);
      setLaunch(new Set(s.launch?.done || []));
      setDaily(s.daily || { dates: [] });
      const a = d.activity || {};
      setActivity({ conversations: a.conversations || 0, invites: a.invites || 0, presentations: a.presentations || 0, followups: a.followups || 0, enrollments: a.enrollments || 0, events: a.events || 0, training_days: a.training_days || 0 });
      setLoaded(true);
    }).catch(() => setLoaded(true));
    return () => { alive = false; };
  }, []);

  const save = useCallback((patch: Record<string, unknown>) => {
    fetch("/api/academy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ patch }) }).catch(() => {});
  }, []);
  const saveActivity = useCallback((a: Activity) => {
    fetch("/api/academy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ activity: a }) }).catch(() => {});
  }, []);

  const level = levelForCompleted(completed.size);
  const nextLevel = LEVELS.find((l) => l.n === level.n + 1);

  function complete(id: string) {
    setCompleted((prev) => {
      const next = new Set(prev); next.add(id);
      const arr = [...next];
      save({ completed_lessons: arr, level: levelForCompleted(arr.length).n });
      return next;
    });
  }
  function uncomplete(id: string) {
    setCompleted((prev) => {
      const next = new Set(prev); next.delete(id);
      const arr = [...next];
      save({ completed_lessons: arr, level: levelForCompleted(arr.length).n });
      return next;
    });
  }

  const nextModule = MODULES.find((m) => !completed.has(m.id)) || MODULES[0];

  function resolveHelp(item: (typeof HELP_NOW)[number]) {
    setHelpOpen(false);
    if (item.type === "module") setView({ v: "lesson", id: item.id });
    else if (item.type === "tool") setView({ v: "tool", key: item.id as ToolKey });
    else if (item.type === "roleplay") setView({ v: "roleplay" });
    else setView({ v: "coach" });
  }

  /* ───────────────────────── render ───────────────────────── */
  return (
    <div className="text-charcoal">
      {view.v !== "home" && (
        <button onClick={() => setView({ v: "home" })} className="mb-3 inline-flex items-center gap-1.5 text-sm font-semibold text-charcoal/60 hover:text-charcoal">
          <ChevronLeft className="h-4 w-4" /> Academy home
        </button>
      )}

      {view.v === "home" && (
        <Home
          firstName={firstName} loaded={loaded} completed={completed} level={level} nextLevel={nextLevel}
          nextModule={nextModule} activity={activity} daily={daily}
          onOpen={(vw) => setView(vw)} onHelp={() => setHelpOpen(true)}
        />
      )}
      {view.v === "first" && <FirstMission onStart={() => setView({ v: "lesson", id: "why" })} onHome={() => setView({ v: "home" })} />}
      {view.v === "lesson" && (
        <Lesson
          module={MODULES.find((m) => m.id === view.id)!} done={completed.has(view.id)}
          onComplete={() => complete(view.id)} onUncomplete={() => uncomplete(view.id)}
          onTool={(k) => setView({ v: "tool", key: k })} onNext={(id) => setView({ v: "lesson", id })}
        />
      )}
      {view.v === "coach" && <Coach mode="coach" />}
      {view.v === "roleplay" && <Coach mode="roleplay" />}
      {view.v === "resources" && <Resources />}
      {view.v === "search" && <SearchView onOpen={(vw) => setView(vw)} />}
      {view.v === "tool" && (
        <Tools
          which={view.key}
          why={why} setWhy={(w) => { setWhy(w); save({ why: w }); }}
          prospects={prospects} setProspects={(p) => { setProspects(p); save({ prospects: p }); }}
          launch={launch} setLaunch={(l) => { setLaunch(l); save({ launch: { done: [...l] } }); }}
          daily={daily} setDaily={(d) => { setDaily(d); save({ daily: d }); }}
          activity={activity} setActivity={(a) => { setActivity(a); saveActivity(a); }}
          onRoleplay={() => setView({ v: "roleplay" })}
        />
      )}

      {helpOpen && <HelpNow onClose={() => setHelpOpen(false)} onPick={resolveHelp} />}
    </div>
  );
}

/* ───────────────────────── HOME / ROADMAP ───────────────────────── */
function Home({ firstName, loaded, completed, level, nextLevel, nextModule, activity, daily, onOpen, onHelp }: {
  firstName: string; loaded: boolean; completed: Set<string>; level: { n: number; name: string };
  nextLevel?: { n: number; name: string; need: number }; nextModule: Module; activity: Activity; daily: { dates: string[] };
  onOpen: (v: View) => void; onHelp: () => void;
}) {
  const pct = Math.round((completed.size / MODULES.length) * 100);
  const isNew = completed.size === 0;
  const today = new Date().toISOString().slice(0, 10);
  const streak = streakFrom(daily.dates);

  return (
    <div className="space-y-5">
      {/* Welcome + next mission */}
      <div className="overflow-hidden rounded-2xl border border-ice bg-white p-5 shadow-card sm:p-6" style={{ backgroundImage: "radial-gradient(120% 90% at 100% 0%, rgba(37,99,235,0.06), transparent 55%)" }}>
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em]" style={{ color: BLUE }}>One Mission Affiliate Academy</p>
        <h2 className="mt-1 text-2xl font-extrabold tracking-tight text-navy sm:text-3xl">Welcome back, {firstName}.</h2>
        <p className="mt-1 text-sm text-charcoal/60">You don&apos;t have to know everything. You just need to know what to do next.</p>

        <div className="mt-4 rounded-xl border border-ice bg-offwhite/60 p-4">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-charcoal/45">Your next mission</p>
          <p className="mt-0.5 text-lg font-bold text-navy">{isNew ? "Discover Your Why" : nextModule.title}</p>
          <p className="text-[13px] text-charcoal/55">{isNew ? "Start with the reason you're building." : nextModule.blurb}</p>
          <button onClick={() => onOpen(isNew ? { v: "first" } : { v: "lesson", id: nextModule.id })}
            className="mt-3 inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold text-white" style={{ background: BLUE }}>
            {isNew ? "Begin My First Mission" : "Continue Training"} <ArrowRight className="h-4 w-4" />
          </button>
        </div>

        {/* level + progress */}
        <div className="mt-4 flex items-center gap-3">
          <span className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold text-white" style={{ background: "linear-gradient(90deg,#1e3a8a,#2563eb)" }}>
            <Trophy className="h-3.5 w-3.5" /> Level {level.n} · {level.name}
          </span>
          <div className="flex-1">
            <div className="h-2 overflow-hidden rounded-full bg-ice">
              <div className="h-full rounded-full" style={{ width: `${pct}%`, background: BLUE }} />
            </div>
            <p className="mt-1 text-[11px] text-charcoal/45">
              {completed.size}/{MODULES.length} modules{nextLevel ? ` · ${Math.max(0, nextLevel.need - completed.size)} more to ${nextLevel.name}` : " · top level reached"}
            </p>
          </div>
        </div>
      </div>

      {/* I need help right now */}
      <button onClick={onHelp} className="flex w-full items-center justify-between rounded-2xl border-2 px-5 py-4 text-left transition hover:bg-blue-50/40" style={{ borderColor: BLUE }}>
        <span className="flex items-center gap-2.5">
          <LifeBuoy className="h-5 w-5" style={{ color: BLUE }} />
          <span><span className="block text-sm font-extrabold text-navy">I Need Help Right Now</span><span className="block text-[12px] text-charcoal/55">Skip the course — get the answer fast.</span></span>
        </span>
        <ArrowRight className="h-5 w-5" style={{ color: BLUE }} />
      </button>

      {/* quick tiles */}
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <Tile icon={Sparkles} label="Ask OM Coach" sub="Get unstuck" onClick={() => onOpen({ v: "coach" })} />
        <Tile icon={MessageCircle} label="Role-Play" sub="Practice live" onClick={() => onOpen({ v: "roleplay" })} />
        <Tile icon={Zap} label="48-Hour Launch" sub="New affiliate" onClick={() => onOpen({ v: "tool", key: "launch" })} />
        <Tile icon={BookOpen} label="Learn From Greats" sub="Free resources" onClick={() => onOpen({ v: "resources" })} />
      </div>

      {/* daily + activity */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-2xl border border-ice bg-white p-4 shadow-card">
          <div className="flex items-center justify-between">
            <p className="flex items-center gap-1.5 text-sm font-bold text-navy"><Flame className="h-4 w-4" style={{ color: "#f97316" }} /> Daily Development</p>
            <span className="text-xs font-semibold text-charcoal/50">{streak}-day streak</span>
          </div>
          <p className="mt-1 text-[13px] text-charcoal/55">10 minutes a day compounds. {daily.dates.includes(today) ? "Done today ✓" : "Not done today."}</p>
          <button onClick={() => onOpen({ v: "tool", key: "daily" })} className="mt-2 text-sm font-bold" style={{ color: BLUE }}>Open ONE MISSION DAILY →</button>
        </div>
        <div className="rounded-2xl border border-ice bg-white p-4 shadow-card">
          <p className="flex items-center gap-1.5 text-sm font-bold text-navy"><Target className="h-4 w-4" style={{ color: BLUE }} /> This Week&apos;s Activity</p>
          <p className="mt-1 text-[13px] text-charcoal/55">{activity.conversations} convos · {activity.invites} invites · {activity.presentations} presentations</p>
          <button onClick={() => onOpen({ v: "tool", key: "activity" })} className="mt-2 text-sm font-bold" style={{ color: BLUE }}>Log activity →</button>
        </div>
      </div>

      {/* roadmap */}
      <div className="rounded-2xl border border-ice bg-white p-5 shadow-card">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-lg font-extrabold text-navy"><GraduationCap className="h-5 w-5" style={{ color: BLUE }} /> Your Roadmap</h3>
          <button onClick={() => onOpen({ v: "search" })} className="inline-flex items-center gap-1.5 rounded-full border border-ice bg-offwhite px-3 py-1.5 text-xs font-semibold text-charcoal/60"><Search className="h-3.5 w-3.5" /> Search</button>
        </div>
        <div className="space-y-4">
          {PHASES.map((ph, pi) => {
            const mods = MODULES.filter((m) => m.phase === ph.id);
            const prevDone = MODULES.filter((m) => PHASES.findIndex((p) => p.id === m.phase) < pi).every((m) => completed.has(m.id));
            return (
              <div key={ph.id}>
                <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-charcoal/40">{ph.label} <span className="font-medium normal-case tracking-normal text-charcoal/35">· {ph.sub}</span></p>
                <div className="mt-1.5 space-y-1">
                  {mods.map((m) => {
                    const done = completed.has(m.id);
                    const locked = !done && !prevDone && pi > 0; // soft lock = recommended order (still clickable)
                    return (
                      <button key={m.id} onClick={() => onOpen({ v: "lesson", id: m.id })} className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition hover:bg-offwhite">
                        <span className={`grid h-6 w-6 flex-shrink-0 place-items-center rounded-full ${done ? "text-white" : "bg-ice text-charcoal/40"}`} style={done ? { background: BLUE } : undefined}>
                          {done ? <Check className="h-3.5 w-3.5" /> : locked ? <Lock className="h-3 w-3" /> : <Circle className="h-3 w-3" />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-semibold text-navy">{m.num}. {m.title}</span>
                          <span className="block truncate text-[12px] text-charcoal/50">{m.blurb}</span>
                        </span>
                        <span className="text-[11px] text-charcoal/35">{m.minutes}m</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* principle */}
      <p className="px-2 text-center text-sm font-medium italic text-charcoal/50">“{PRINCIPLES[completed.size % PRINCIPLES.length]}”</p>
    </div>
  );
}

function Tile({ icon: Icon, label, sub, onClick }: { icon: typeof Zap; label: string; sub: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="rounded-2xl border border-ice bg-white p-3.5 text-left shadow-card transition hover:-translate-y-0.5 hover:shadow-cardhover">
      <Icon className="h-5 w-5" style={{ color: BLUE }} />
      <p className="mt-2 text-sm font-bold text-navy">{label}</p>
      <p className="text-[11px] text-charcoal/50">{sub}</p>
    </button>
  );
}

/* ───────────────────────── FIRST MISSION (new affiliate) ───────────────────────── */
function FirstMission({ onStart, onHome }: { onStart: () => void; onHome: () => void }) {
  const steps = ["Discover your WHY.", "Build your list.", "Send your first invitations.", "Get someone exposed to the information.", "Attend the next community event."];
  return (
    <div className="rounded-2xl border border-ice bg-white p-6 shadow-card">
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em]" style={{ color: BLUE }}>New Affiliate Mode</p>
      <h2 className="mt-1 text-2xl font-extrabold text-navy">Don&apos;t try to learn everything today.</h2>
      <p className="mt-1 text-sm text-charcoal/60">Your first mission is simple. Do these five things — that&apos;s it.</p>
      <ol className="mt-4 space-y-2">
        {steps.map((s, i) => (
          <li key={i} className="flex items-center gap-3 rounded-xl border border-ice bg-offwhite/60 px-3.5 py-2.5">
            <span className="grid h-6 w-6 place-items-center rounded-full text-xs font-bold text-white" style={{ background: BLUE }}>{i + 1}</span>
            <span className="text-sm font-semibold text-navy">{s}</span>
          </li>
        ))}
      </ol>
      <button onClick={onStart} className="mt-5 inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-bold text-white" style={{ background: BLUE }}>Begin My First Mission <ArrowRight className="h-4 w-4" /></button>
      <button onClick={onHome} className="ml-3 text-sm font-semibold text-charcoal/50">Not now</button>
    </div>
  );
}

/* ───────────────────────── LESSON VIEWER ───────────────────────── */
function Lesson({ module, done, onComplete, onUncomplete, onTool, onNext }: {
  module: Module; done: boolean; onComplete: () => void; onUncomplete: () => void; onTool: (k: ToolKey) => void; onNext: (id: string) => void;
}) {
  const idx = MODULES.findIndex((m) => m.id === module.id);
  const next = MODULES[idx + 1];
  return (
    <div className="space-y-4">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em]" style={{ color: BLUE }}>Module {module.num} · {module.minutes} min</p>
        <h2 className="mt-1 text-2xl font-extrabold tracking-tight text-navy">{module.title}</h2>
      </div>

      <Section label="Why this matters"><p className="text-[15px] leading-relaxed text-charcoal/80">{module.why}</p></Section>
      <Section label="Learn">{module.learn.map((p, i) => <p key={i} className="text-[15px] leading-relaxed text-charcoal/80">{p}</p>)}</Section>
      {module.example && <Section label="Example"><p className="rounded-xl border border-ice bg-offwhite/60 p-3.5 text-[15px] italic leading-relaxed text-charcoal/75">{module.example}</p></Section>}

      {module.scripts && module.scripts.length > 0 && (
        <Section label="What to say — copy & use">
          <div className="space-y-2">{module.scripts.map((s) => <ScriptCard key={s.id} label={s.label} channel={s.channel} text={s.text} />)}</div>
          <p className="mt-2 text-[12px] text-charcoal/45">Scripts are training wheels — use them, then learn to say it naturally.</p>
        </Section>
      )}

      {module.mistakes && (
        <Section label="Common mistakes">
          <ul className="space-y-1.5">{module.mistakes.map((m, i) => <li key={i} className="flex gap-2 text-[14px] text-charcoal/75"><X className="mt-0.5 h-4 w-4 flex-shrink-0 text-red-400" />{m}</li>)}</ul>
        </Section>
      )}

      <div className="rounded-2xl border-2 p-4" style={{ borderColor: BLUE, background: "rgba(37,99,235,0.04)" }}>
        <p className="text-[11px] font-bold uppercase tracking-[0.14em]" style={{ color: BLUE }}>Take action</p>
        <p className="mt-1 text-[15px] font-semibold text-navy">{module.action}</p>
        {module.tool && <button onClick={() => onTool(module.tool!)} className="mt-3 inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold text-white" style={{ background: BLUE }}>Open the tool <ArrowRight className="h-4 w-4" /></button>}
      </div>

      {module.deeper && module.deeper.length > 0 && (
        <Section label="Go deeper (free public resources)">
          <div className="space-y-1.5">{module.deeper.map((d, i) => (
            <a key={i} href={d.url} target="_blank" rel="noreferrer" className="flex items-center gap-2 text-sm font-semibold hover:underline" style={{ color: BLUE }}>
              <PlayCircle className="h-4 w-4" /> {d.label} <ExternalLink className="h-3.5 w-3.5 opacity-60" />
            </a>
          ))}</div>
        </Section>
      )}

      <div className="flex flex-wrap items-center gap-3 border-t border-ice pt-4">
        {done ? (
          <>
            <span className="inline-flex items-center gap-1.5 rounded-xl bg-green-50 px-4 py-2.5 text-sm font-bold text-green-700"><Check className="h-4 w-4" /> Completed</span>
            <button onClick={onUncomplete} className="text-sm font-semibold text-charcoal/45">Mark incomplete</button>
          </>
        ) : (
          <button onClick={onComplete} className="inline-flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-bold text-white" style={{ background: BLUE }}><Check className="h-4 w-4" /> Complete Lesson</button>
        )}
        {next && <button onClick={() => onNext(next.id)} className="inline-flex items-center gap-1.5 text-sm font-bold text-navy">Next: {next.title} <ArrowRight className="h-4 w-4" /></button>}
      </div>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.14em] text-charcoal/40">{label}</p>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function ScriptCard({ label, channel, text }: { label: string; channel: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-xl border border-ice bg-white p-3">
      <div className="flex items-center justify-between">
        <p className="text-[13px] font-bold text-navy">{label} <span className="font-medium text-charcoal/40">· {channel}</span></p>
        <button onClick={() => { navigator.clipboard?.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1400); }} className="inline-flex items-center gap-1 text-[12px] font-bold" style={{ color: BLUE }}>
          {copied ? <><Check className="h-3.5 w-3.5" /> Copied</> : <><Copy className="h-3.5 w-3.5" /> Copy</>}
        </button>
      </div>
      <p className="mt-1 text-[14px] leading-relaxed text-charcoal/75">{text}</p>
    </div>
  );
}

/* ───────────────────────── AI COACH / ROLE-PLAY ───────────────────────── */
function Coach({ mode }: { mode: "coach" | "roleplay" }) {
  const [scenario, setScenario] = useState<string | null>(mode === "coach" ? "on" : null);
  const [scenarioLabel, setScenarioLabel] = useState("");
  const [msgs, setMsgs] = useState<{ role: "user" | "assistant"; content: string }[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs, busy]);

  async function send(text: string, hidden = false) {
    if (!text.trim() || busy) return;
    const nextMsgs = hidden ? msgs : [...msgs, { role: "user" as const, content: text }];
    if (!hidden) setMsgs(nextMsgs);
    setInput(""); setBusy(true);
    try {
      const payload = hidden ? [...msgs, { role: "user" as const, content: text }] : nextMsgs;
      const r = await fetch("/api/affiliate-coach", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode, scenario: scenarioLabel, messages: payload }) });
      const d = await r.json();
      if (d?.notConfigured) setMsgs((m) => [...m, { role: "assistant", content: "The coach isn't configured yet — ask an admin to add the AI key." }]);
      else if (!r.ok || !d?.ok) setMsgs((m) => [...m, { role: "assistant", content: "Something went wrong — try again." }]);
      else setMsgs((m) => [...m, { role: "assistant", content: d.reply }]);
    } catch { setMsgs((m) => [...m, { role: "assistant", content: "Couldn't reach the coach — try again." }]); }
    finally { setBusy(false); }
  }

  // role-play scenario picker
  if (mode === "roleplay" && !scenario) {
    return (
      <div className="rounded-2xl border border-ice bg-white p-5 shadow-card">
        <h2 className="flex items-center gap-2 text-xl font-extrabold text-navy"><MessageCircle className="h-5 w-5" style={{ color: BLUE }} /> Role-Play Practice</h2>
        <p className="mt-1 text-sm text-charcoal/60">Pick a scenario. The AI plays the prospect. Practice, then get a coaching score.</p>
        <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
          {ROLEPLAY_SCENARIOS.map((s) => (
            <button key={s.id} onClick={() => { setScenario(s.id); setScenarioLabel(s.label); setMsgs([{ role: "assistant", content: s.opener }]); }}
              className="rounded-xl border border-ice bg-offwhite/60 px-3 py-3 text-sm font-bold text-navy transition hover:bg-blue-50/50">{s.label}</button>
          ))}
        </div>
      </div>
    );
  }

  const quick = mode === "coach"
    ? ["Give me my tasks for today", "Help me invite my old coworker", "What do I say if they say it's a pyramid?", "Grade my invitation", "How do I follow up?"]
    : [];

  return (
    <div className="flex h-[70vh] flex-col rounded-2xl border border-ice bg-white shadow-card">
      <div className="flex items-center justify-between border-b border-ice px-4 py-3">
        <p className="flex items-center gap-2 text-sm font-extrabold text-navy">
          {mode === "coach" ? <><Sparkles className="h-4 w-4" style={{ color: BLUE }} /> OM Affiliate Coach</> : <><MessageCircle className="h-4 w-4" style={{ color: BLUE }} /> Role-Play · {scenarioLabel}</>}
        </p>
        {mode === "roleplay" && <button onClick={() => send("[SCORE]", true)} disabled={busy || msgs.length < 3} className="rounded-full px-3 py-1.5 text-xs font-bold text-white disabled:opacity-40" style={{ background: BLUE }}>End &amp; Score</button>}
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {mode === "coach" && msgs.length === 0 && (
          <div className="rounded-xl border border-ice bg-offwhite/60 p-3 text-[13px] text-charcoal/60">Ask me anything about building One Mission — inviting, follow-up, objections, launching your new person, or your plan for today.</div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2.5 text-[14px] leading-relaxed ${m.role === "user" ? "text-white" : "border border-ice bg-offwhite/70 text-charcoal/85"}`} style={m.role === "user" ? { background: BLUE } : undefined}>{m.content}</div>
          </div>
        ))}
        {busy && <div className="flex justify-start"><div className="rounded-2xl border border-ice bg-offwhite/70 px-3.5 py-2.5 text-charcoal/50"><Loader2 className="h-4 w-4 animate-spin" /></div></div>}
        <div ref={endRef} />
      </div>

      {quick.length > 0 && msgs.length === 0 && (
        <div className="flex flex-wrap gap-1.5 border-t border-ice px-3 py-2">
          {quick.map((q) => <button key={q} onClick={() => send(q)} className="rounded-full border border-ice bg-offwhite px-2.5 py-1 text-[12px] font-semibold text-charcoal/60 hover:bg-blue-50/50">{q}</button>)}
        </div>
      )}

      <form onSubmit={(e) => { e.preventDefault(); send(input); }} className="flex items-center gap-2 border-t border-ice p-3">
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder={mode === "coach" ? "Ask your coach…" : "Your reply to the prospect…"} className="flex-1 rounded-xl border border-ice bg-offwhite/50 px-3.5 py-2.5 text-sm outline-none focus:border-blue-400" />
        <button type="submit" disabled={busy || !input.trim()} className="grid h-10 w-10 place-items-center rounded-xl text-white disabled:opacity-40" style={{ background: BLUE }}><Send className="h-4 w-4" /></button>
      </form>
    </div>
  );
}

/* ───────────────────────── TOOLS ───────────────────────── */
function Tools({ which, why, setWhy, prospects, setProspects, launch, setLaunch, daily, setDaily, activity, setActivity, onRoleplay }: {
  which: ToolKey; why: Record<string, string>; setWhy: (w: Record<string, string>) => void;
  prospects: { name: string; category: string }[]; setProspects: (p: { name: string; category: string }[]) => void;
  launch: Set<string>; setLaunch: (l: Set<string>) => void; daily: { dates: string[] }; setDaily: (d: { dates: string[] }) => void;
  activity: Activity; setActivity: (a: Activity) => void; onRoleplay: () => void;
}) {
  if (which === "why") return <WhyTool why={why} setWhy={setWhy} />;
  if (which === "list") return <ListTool prospects={prospects} setProspects={setProspects} />;
  if (which === "launch") return <LaunchTool launch={launch} setLaunch={setLaunch} />;
  if (which === "daily") return <DailyTool daily={daily} setDaily={setDaily} />;
  if (which === "activity") return <ActivityTool activity={activity} setActivity={setActivity} />;
  if (which === "objections") return <ObjectionsTool onRoleplay={onRoleplay} />;
  return null;
}

const WHY_Q = [
  { k: "want", q: "What do you want?" }, { k: "whyWant", q: "Why do you want it?" },
  { k: "who", q: "Who are you doing this for?" }, { k: "change", q: "What would extra income change?" },
  { k: "ideal", q: "What would your ideal day look like?" }, { k: "ifNothing", q: "What happens if nothing changes?" },
  { k: "committed", q: "What are you willing to do consistently?" },
];
function WhyTool({ why, setWhy }: { why: Record<string, string>; setWhy: (w: Record<string, string>) => void }) {
  const statement = `I am building One Mission because ${why.whyWant || "________"}. My goal is ${why.want || "________"}. I am committed to ${why.committed || "________"}.`;
  return (
    <div className="rounded-2xl border border-ice bg-white p-5 shadow-card">
      <h2 className="text-xl font-extrabold text-navy">Build Your Why</h2>
      <p className="mt-1 text-sm text-charcoal/60">Answer honestly. We&apos;ll turn it into your One Mission Why Statement.</p>
      <div className="mt-4 space-y-3">
        {WHY_Q.map(({ k, q }) => (
          <div key={k}><label className="text-[12px] font-semibold text-charcoal/55">{q}</label>
            <textarea value={why[k] || ""} onChange={(e) => setWhy({ ...why, [k]: e.target.value })} rows={2} className="mt-1 w-full rounded-xl border border-ice bg-offwhite/50 px-3 py-2 text-sm outline-none focus:border-blue-400" /></div>
        ))}
      </div>
      <div className="mt-4 rounded-xl border-2 p-4" style={{ borderColor: BLUE, background: "rgba(37,99,235,0.04)" }}>
        <p className="text-[11px] font-bold uppercase tracking-wide" style={{ color: BLUE }}>Your One Mission Why Statement</p>
        <p className="mt-1 text-[15px] font-semibold leading-relaxed text-navy">{statement}</p>
      </div>
      <p className="mt-2 text-[12px] text-charcoal/45">Saved automatically. Read it out loud when it gets hard.</p>
    </div>
  );
}

const LIST_CATS = ["Family", "Friends", "Coworkers (now)", "Coworkers (past)", "Business owners", "Entrepreneurs", "Into trading", "Wants extra income", "Social media", "Classmates", "Sports/community", "People I respect", "Well-connected", "Looking for more"];
function ListTool({ prospects, setProspects }: { prospects: { name: string; category: string }[]; setProspects: (p: { name: string; category: string }[]) => void }) {
  const [name, setName] = useState(""); const [cat, setCat] = useState(LIST_CATS[0]);
  const add = () => { if (!name.trim()) return; setProspects([...prospects, { name: name.trim(), category: cat }]); setName(""); };
  return (
    <div className="rounded-2xl border border-ice bg-white p-5 shadow-card">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-extrabold text-navy">100 Person List</h2>
        <span className="rounded-full px-3 py-1 text-sm font-bold text-white" style={{ background: BLUE }}>{prospects.length} / 100</span>
      </div>
      <p className="mt-1 text-sm text-charcoal/60">Just identify people. Don&apos;t prejudge — write everyone.</p>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-ice"><div className="h-full rounded-full" style={{ width: `${Math.min(100, prospects.length)}%`, background: BLUE }} /></div>
      <div className="mt-4 flex flex-wrap gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} placeholder="Name" className="flex-1 rounded-xl border border-ice bg-offwhite/50 px-3 py-2.5 text-sm outline-none focus:border-blue-400" />
        <select value={cat} onChange={(e) => setCat(e.target.value)} className="rounded-xl border border-ice bg-offwhite/50 px-3 py-2.5 text-sm outline-none">{LIST_CATS.map((c) => <option key={c}>{c}</option>)}</select>
        <button onClick={add} className="rounded-xl px-4 py-2.5 text-sm font-bold text-white" style={{ background: BLUE }}>Add</button>
      </div>
      <div className="mt-4 space-y-1.5">
        {prospects.length === 0 && <p className="text-sm text-charcoal/40">No names yet. Start with the five people you talk to most.</p>}
        {prospects.map((p, i) => (
          <div key={i} className="flex items-center justify-between rounded-lg border border-ice bg-offwhite/40 px-3 py-2">
            <span className="text-sm font-semibold text-navy">{p.name} <span className="font-medium text-charcoal/40">· {p.category}</span></span>
            <button onClick={() => setProspects(prospects.filter((_, j) => j !== i))} className="text-charcoal/30 hover:text-red-400"><X className="h-4 w-4" /></button>
          </div>
        ))}
      </div>
    </div>
  );
}

function LaunchTool({ launch, setLaunch }: { launch: Set<string>; setLaunch: (l: Set<string>) => void }) {
  const windows = [...new Set(LAUNCH_ITEMS.map((i) => i.window))];
  const toggle = (id: string) => { const n = new Set(launch); n.has(id) ? n.delete(id) : n.add(id); setLaunch(n); };
  const pct = Math.round((launch.size / LAUNCH_ITEMS.length) * 100);
  return (
    <div className="rounded-2xl border border-ice bg-white p-5 shadow-card">
      <h2 className="text-xl font-extrabold text-navy">48-Hour Launch</h2>
      <p className="mt-1 text-sm text-charcoal/60">Momentum through action — not income promises. Run it for yourself or someone you just enrolled.</p>
      <div className="mt-3 flex items-center gap-3">
        <div className="h-2 flex-1 overflow-hidden rounded-full bg-ice"><div className="h-full rounded-full" style={{ width: `${pct}%`, background: BLUE }} /></div>
        <span className="text-sm font-bold" style={{ color: BLUE }}>{pct}%</span>
      </div>
      <div className="mt-4 space-y-4">
        {windows.map((w) => (
          <div key={w}>
            <p className="text-[11px] font-bold uppercase tracking-wide text-charcoal/40">{w}</p>
            <div className="mt-1 space-y-1">
              {LAUNCH_ITEMS.filter((i) => i.window === w).map((i) => (
                <button key={i.id} onClick={() => toggle(i.id)} className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-offwhite">
                  <span className={`grid h-6 w-6 flex-shrink-0 place-items-center rounded-full ${launch.has(i.id) ? "text-white" : "border border-ice text-transparent"}`} style={launch.has(i.id) ? { background: BLUE } : undefined}><Check className="h-3.5 w-3.5" /></span>
                  <span className={`text-sm ${launch.has(i.id) ? "font-semibold text-charcoal/50 line-through" : "font-semibold text-navy"}`}>{i.label}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      {pct === 100 && <p className="mt-4 rounded-xl bg-green-50 px-4 py-3 text-sm font-bold text-green-700">Launch complete — that&apos;s activity, confidence, and momentum. 🎯</p>}
    </div>
  );
}

function DailyTool({ daily, setDaily }: { daily: { dates: string[] }; setDaily: (d: { dates: string[] }) => void }) {
  const [plan, setPlan] = useState(DAILY_PLANS[0]);
  const today = new Date().toISOString().slice(0, 10);
  const doneToday = daily.dates.includes(today);
  const streak = streakFrom(daily.dates);
  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-ice bg-white p-5 shadow-card">
        <h2 className="text-xl font-extrabold text-navy">One Mission Daily</h2>
        <p className="mt-1 text-sm text-charcoal/60">Pick your mode. Consistent focused activity beats scrolling all day pretending to work.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {DAILY_PLANS.map((p) => <button key={p.id} onClick={() => setPlan(p)} className={`rounded-xl border px-3 py-2 text-sm font-bold ${plan.id === p.id ? "text-white" : "border-ice bg-offwhite text-charcoal/60"}`} style={plan.id === p.id ? { background: BLUE, borderColor: BLUE } : undefined}>{p.name}</button>)}
        </div>
        <p className="mt-3 text-[12px] font-semibold text-charcoal/45">{plan.name} · {plan.total}</p>
        <div className="mt-2 space-y-1.5">
          {plan.blocks.map((b, i) => (
            <div key={i} className="flex items-center gap-3 rounded-lg border border-ice bg-offwhite/40 px-3 py-2">
              <span className="w-16 flex-shrink-0 text-sm font-extrabold" style={{ color: BLUE }}>{b.minutes} min</span>
              <span className="text-sm font-semibold text-navy">{b.label}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="rounded-2xl border border-ice bg-white p-5 shadow-card">
        <div className="flex items-center justify-between">
          <p className="flex items-center gap-1.5 text-sm font-bold text-navy"><Flame className="h-4 w-4" style={{ color: "#f97316" }} /> 10-Minutes-a-Day Challenge</p>
          <span className="text-sm font-bold text-charcoal/50">{streak}-day streak</span>
        </div>
        <button disabled={doneToday} onClick={() => setDaily({ dates: [...daily.dates, today] })} className="mt-3 inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold text-white disabled:opacity-50" style={{ background: doneToday ? "#16a34a" : BLUE }}>
          {doneToday ? <><Check className="h-4 w-4" /> Done today</> : "Mark today complete"}
        </button>
      </div>
    </div>
  );
}

const ACT_ROWS: { k: keyof Activity; label: string }[] = [
  { k: "conversations", label: "New Conversations" }, { k: "invites", label: "Invitations" }, { k: "presentations", label: "Presentations" },
  { k: "followups", label: "Follow-Ups" }, { k: "enrollments", label: "Enrollments" }, { k: "events", label: "Event Attendance" }, { k: "training_days", label: "Personal Dev (days)" },
];
function ActivityTool({ activity, setActivity }: { activity: Activity; setActivity: (a: Activity) => void }) {
  const bump = (k: keyof Activity, d: number) => setActivity({ ...activity, [k]: Math.max(0, (activity[k] || 0) + d) });
  const coaching = coachActivity(activity);
  return (
    <div className="rounded-2xl border border-ice bg-white p-5 shadow-card">
      <h2 className="text-xl font-extrabold text-navy">One Mission Activity Score</h2>
      <p className="mt-1 text-sm text-charcoal/60">Track what you control — activity, not outcomes. Resets weekly.</p>
      <div className="mt-4 space-y-1.5">
        {ACT_ROWS.map(({ k, label }) => (
          <div key={k} className="flex items-center justify-between rounded-lg border border-ice bg-offwhite/40 px-3 py-2">
            <span className="text-sm font-semibold text-navy">{label}</span>
            <div className="flex items-center gap-2">
              <button onClick={() => bump(k, -1)} className="grid h-7 w-7 place-items-center rounded-lg border border-ice text-charcoal/50">–</button>
              <span className="w-8 text-center text-sm font-extrabold" style={{ color: BLUE }}>{activity[k]}</span>
              <button onClick={() => bump(k, 1)} className="grid h-7 w-7 place-items-center rounded-lg text-white" style={{ background: BLUE }}>+</button>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-4 rounded-xl border border-ice bg-offwhite/60 p-3.5">
        <p className="text-[11px] font-bold uppercase tracking-wide" style={{ color: BLUE }}>Coaching</p>
        <p className="mt-1 text-[14px] leading-relaxed text-charcoal/75">{coaching}</p>
      </div>
    </div>
  );
}

function ObjectionsTool({ onRoleplay }: { onRoleplay: () => void }) {
  return (
    <div className="rounded-2xl border border-ice bg-white p-5 shadow-card">
      <h2 className="text-xl font-extrabold text-navy">Objection Trainer</h2>
      <p className="mt-1 text-sm text-charcoal/60">The framework: <b>Listen → Acknowledge → Ask → Respond → Confirm.</b> Understand the real objection before you answer.</p>
      <div className="mt-3 space-y-2">
        {MODULES.find((m) => m.id === "objections")?.scripts?.map((s) => <ScriptCard key={s.id} label={s.label} channel={s.channel} text={s.text} />)}
      </div>
      <button onClick={onRoleplay} className="mt-4 inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold text-white" style={{ background: BLUE }}><MessageCircle className="h-4 w-4" /> Practice objections with the AI</button>
    </div>
  );
}

/* ───────────────────────── RESOURCES ───────────────────────── */
function Resources() {
  const teachers = [...new Set(GREATS.map((g) => g.teacher))];
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-extrabold text-navy">Learn From The Greats</h2>
        <p className="mt-1 text-sm text-charcoal/60">Free, public resources from respected educators. We link their official sources — we don&apos;t copy their material.</p>
      </div>
      {teachers.map((t) => (
        <div key={t} className="rounded-2xl border border-ice bg-white p-4 shadow-card">
          <p className="text-sm font-extrabold text-navy">{t}</p>
          <div className="mt-2 space-y-2">
            {GREATS.filter((g) => g.teacher === t).map((g, i) => (
              <a key={i} href={g.url} target="_blank" rel="noreferrer" className="block rounded-xl border border-ice bg-offwhite/40 p-3 transition hover:bg-blue-50/40">
                <div className="flex items-center justify-between">
                  <p className="text-[14px] font-bold text-navy">{g.title}</p>
                  <ExternalLink className="h-3.5 w-3.5 text-charcoal/40" />
                </div>
                <p className="text-[12px] font-semibold" style={{ color: BLUE }}>{g.topic}{g.length ? ` · ${g.length}` : ""} · {g.kind}</p>
                <p className="mt-0.5 text-[13px] text-charcoal/60">{g.why}</p>
              </a>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ───────────────────────── SEARCH ───────────────────────── */
function SearchView({ onOpen }: { onOpen: (v: View) => void }) {
  const [q, setQ] = useState("");
  const ql = q.trim().toLowerCase();
  const mods = ql ? MODULES.filter((m) => (m.title + " " + m.blurb + " " + m.why + " " + m.learn.join(" ")).toLowerCase().includes(ql)) : [];
  const scripts = ql ? MODULES.flatMap((m) => (m.scripts || []).map((s) => ({ m, s }))).filter(({ s }) => (s.label + " " + s.text).toLowerCase().includes(ql)) : [];
  const res = ql ? GREATS.filter((g) => (g.title + " " + g.teacher + " " + g.topic).toLowerCase().includes(ql)) : [];
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 rounded-xl border border-ice bg-white px-3 py-2.5 shadow-card">
        <Search className="h-4 w-4 text-charcoal/40" />
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search: invite, objection, follow up, launch…" className="flex-1 text-sm outline-none" />
      </div>
      {!ql && <p className="text-sm text-charcoal/40">Try “objection”, “invite”, “launch”, or a teacher&apos;s name.</p>}
      {ql && mods.length === 0 && scripts.length === 0 && res.length === 0 && <p className="text-sm text-charcoal/40">No matches. Try a different word.</p>}
      {mods.length > 0 && <SearchGroup label="Lessons">{mods.map((m) => <button key={m.id} onClick={() => onOpen({ v: "lesson", id: m.id })} className="block w-full rounded-lg border border-ice bg-white px-3 py-2 text-left text-sm font-semibold text-navy hover:bg-offwhite">{m.num}. {m.title}</button>)}</SearchGroup>}
      {scripts.length > 0 && <SearchGroup label="Scripts">{scripts.map(({ m, s }, i) => <button key={i} onClick={() => onOpen({ v: "lesson", id: m.id })} className="block w-full rounded-lg border border-ice bg-white px-3 py-2 text-left text-sm text-charcoal/70 hover:bg-offwhite"><b className="text-navy">{s.label}</b> — in {m.title}</button>)}</SearchGroup>}
      {res.length > 0 && <SearchGroup label="Resources">{res.map((g, i) => <a key={i} href={g.url} target="_blank" rel="noreferrer" className="block rounded-lg border border-ice bg-white px-3 py-2 text-sm font-semibold text-navy hover:bg-offwhite">{g.title} · <span className="text-charcoal/50">{g.teacher}</span></a>)}</SearchGroup>}
    </div>
  );
}
function SearchGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><p className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.14em] text-charcoal/40">{label}</p><div className="space-y-1.5">{children}</div></div>;
}

/* ───────────────────────── HELP NOW overlay ───────────────────────── */
function HelpNow({ onClose, onPick }: { onClose: () => void; onPick: (i: (typeof HELP_NOW)[number]) => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-3 sm:items-center" onClick={onClose}>
      <div className="w-full max-w-lg rounded-2xl bg-white p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-lg font-extrabold text-navy"><LifeBuoy className="h-5 w-5" style={{ color: BLUE }} /> I need to…</h3>
          <button onClick={onClose} className="text-charcoal/40"><X className="h-5 w-5" /></button>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          {HELP_NOW.map((i) => (
            <button key={i.label} onClick={() => onPick(i)} className="rounded-xl border border-ice bg-offwhite/60 px-3 py-3 text-left text-sm font-bold text-navy transition hover:bg-blue-50/50">{i.label}</button>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────── helpers ───────────────────────── */
function streakFrom(dates: string[]): number {
  if (!dates || dates.length === 0) return 0;
  const set = new Set(dates);
  let n = 0; const d = new Date();
  // allow today missing (streak still counts up to yesterday)
  if (!set.has(d.toISOString().slice(0, 10))) d.setUTCDate(d.getUTCDate() - 1);
  while (set.has(d.toISOString().slice(0, 10))) { n++; d.setUTCDate(d.getUTCDate() - 1); }
  return n;
}
function coachActivity(a: Activity): string {
  if (a.conversations + a.invites === 0) return "You haven't logged activity yet this week. Start with conversations — everything begins there.";
  if (a.invites > 0 && a.presentations === 0) return "Your invitations are happening, but no presentations yet. Focus on turning invites into exposures — get people in front of a tool or leader.";
  if (a.presentations > 0 && a.followups === 0) return "You're getting people to look — now the money is in the follow-up. Schedule follow-ups on every open conversation.";
  if (a.conversations > 0 && a.invites === 0) return "Lots of conversations, few invites. Practice the invite so more chats turn into 'would you be open to a look?'";
  return "Strong, balanced week. Keep the activity consistent — consistency is what compounds.";
}
