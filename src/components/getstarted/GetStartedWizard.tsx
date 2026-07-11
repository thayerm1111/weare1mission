"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { X, ArrowRight, ArrowLeft, Play, Lightbulb, Check } from "lucide-react";
import { gsSteps, gsPhases, gsMeta, type GsBlock } from "@/data/gettingStarted";

type View = "welcome" | "launcher" | "step";

export function GetStartedWizard() {
  const router = useRouter();
  const total = gsSteps.length;
  const [view, setView] = useState<View>("welcome");
  const [index, setIndex] = useState(0);

  // Show the welcome card once per session; resume last step if any.
  useEffect(() => {
    let seen = false;
    try { seen = sessionStorage.getItem("1m_gs_welcome") === "1"; } catch {}
    if (seen) setView("launcher");
    try {
      const s = parseInt(localStorage.getItem("1m_gs_step") || "", 10);
      if (!Number.isNaN(s) && s >= 0 && s < total) setIndex(s);
    } catch {}
  }, [total]);

  function close() { router.push("/"); }
  function beginSetup() { setView("step"); persist(index); }
  function dismissWelcome() {
    try { sessionStorage.setItem("1m_gs_welcome", "1"); } catch {}
    setView("launcher");
  }
  function persist(i: number) { try { localStorage.setItem("1m_gs_step", String(i)); } catch {} }
  function goTo(i: number) {
    if (i < 0) { setView("launcher"); return; }
    if (i >= total) { setView("launcher"); return; }
    setIndex(i); persist(i);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  return (
    <div className="fixed inset-0 z-[120] overflow-y-auto bg-cream">
      {view === "welcome" && <Welcome onContinue={dismissWelcome} onClose={close} />}
      {view === "launcher" && <Launcher total={total} onBegin={beginSetup} onClose={close} startLabel={index > 0 ? "Resume your setup" : "Begin your setup"} />}
      {view === "step" && (
        <StepView
          index={index}
          total={total}
          onBack={() => goTo(index - 1)}
          onNext={() => goTo(index + 1)}
          onClose={close}
        />
      )}
    </div>
  );
}

/* ───────────────────────── Welcome ───────────────────────── */
function Welcome({ onContinue, onClose }: { onContinue: () => void; onClose: () => void }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-navy/40 p-5 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-3xl bg-cream p-8 text-center shadow-glow sm:p-10">
        <div className="mx-auto mb-6 grid h-14 w-14 place-items-center rounded-2xl bg-gradient-gold text-2xl">🎯</div>
        <p className="text-[11px] font-bold uppercase tracking-label text-gold">Before You Begin</p>
        <h1 className="mt-3 font-serif text-4xl font-black leading-tight text-navy">
          Welcome To <span className="gold-grad italic">The Team.</span>
        </h1>
        <p className="mx-auto mt-5 max-w-md text-[15px] leading-relaxed text-charcoal/70">{gsMeta.welcomeBody}</p>
        <button
          onClick={onContinue}
          className="mt-7 w-full rounded-full bg-gradient-primary px-6 py-4 text-sm font-bold uppercase tracking-wider text-cream shadow-glow transition-transform hover:-translate-y-0.5"
        >
          I understand, let&apos;s go
        </button>
        <button onClick={onClose} className="mt-4 text-xs font-medium text-medium hover:text-charcoal">
          This message will only appear once per visit
        </button>
      </div>
    </div>
  );
}

/* ───────────────────────── Launcher ───────────────────────── */
function Launcher({ total, onBegin, onClose, startLabel }: { total: number; onBegin: () => void; onClose: () => void; startLabel: string }) {
  return (
    <div className="relative min-h-screen">
      <button onClick={onClose} aria-label="Close" className="absolute left-5 top-5 grid h-10 w-10 place-items-center rounded-full border border-[#E4DCCB] bg-cream text-navy hover:bg-ice focus-ring">
        <X className="h-5 w-5" />
      </button>
      <div className="mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center px-5 py-20 text-center">
        <span className="inline-flex items-center gap-2 rounded-full border border-[#E4DCCB] bg-cream px-4 py-2 text-[11px] font-bold uppercase tracking-label text-medium">
          <span className="h-2 w-2 rounded-full bg-gold" /> Your Guided Setup
        </span>
        <h1 className="mt-7 font-serif text-[clamp(2.4rem,6vw,4.5rem)] font-black leading-[1.02] tracking-tight text-navy">
          Everything you need,
          <br />
          one step <span className="gold-grad italic">at a time.</span>
        </h1>
        <p className="mx-auto mt-6 max-w-xl text-lg leading-relaxed text-charcoal/70">
          No guessing, no overwhelm. We walk you through getting connected, setting up to trade, and learning how everything works. Just tap below and follow along.
        </p>

        <div className="mt-9 flex flex-wrap items-center justify-center gap-2.5">
          {gsPhases.map((p, i) => (
            <span key={p} className="inline-flex items-center gap-2 rounded-full border border-[#E4DCCB] bg-cream px-4 py-2 text-sm font-semibold text-charcoal/80">
              <span className="font-serif italic text-gold">0{i + 1}</span> {p}
            </span>
          ))}
        </div>

        <button
          onClick={onBegin}
          className="mt-10 inline-flex items-center gap-3 rounded-full bg-gradient-primary px-10 py-4 text-sm font-bold uppercase tracking-wider text-cream shadow-glow transition-transform hover:-translate-y-0.5"
        >
          <Play className="h-4 w-4 fill-current" /> {startLabel}
        </button>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm text-medium">
          <span className="inline-flex items-center gap-2"><Check className="h-4 w-4 text-gold" /> {total} guided steps</span>
          <span className="hidden sm:inline">·</span>
          <span>{gsPhases.length} simple phases</span>
          <span className="hidden sm:inline">·</span>
          <span>{gsMeta.minutes}</span>
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────── Step ───────────────────────── */
function StepView({ index, total, onBack, onNext, onClose }: { index: number; total: number; onBack: () => void; onNext: () => void; onClose: () => void }) {
  const step = gsSteps[index];
  const pct = Math.round(((index + 1) / total) * 100);
  const last = index === total - 1;

  return (
    <div className="min-h-screen pb-28">
      {/* Top bar */}
      <div className="sticky top-0 z-10 border-b border-[#E4DCCB] bg-cream/90 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center gap-4 px-5 py-3.5">
          <button onClick={onClose} aria-label="Close" className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-full border border-[#E4DCCB] text-navy hover:bg-ice focus-ring">
            <X className="h-5 w-5" />
          </button>
          <span className="inline-flex items-center gap-2 rounded-full border border-[#E4DCCB] bg-cream px-3.5 py-1.5 text-[11px] font-bold uppercase tracking-label text-medium">
            <span className="h-1.5 w-1.5 rounded-full bg-gold" /> {step.phase}
          </span>
          <span className="ml-auto font-serif text-sm italic text-medium">{index + 1} / {total}</span>
        </div>
        <div className="h-1 w-full bg-[#EAE3D4]">
          <div className="h-full bg-gradient-gold transition-all duration-500" style={{ width: `${pct}%` }} />
        </div>
      </div>

      {/* Content */}
      <div className="mx-auto max-w-3xl px-5 py-10 sm:py-14">
        <span className="inline-flex items-center gap-2 rounded-full border border-[#E4DCCB] bg-cream px-3.5 py-1.5 text-[11px] font-bold uppercase tracking-label text-charcoal/70">
          <span className="h-1.5 w-1.5 rounded-full bg-gold" /> Step {index + 1}
        </span>
        <h1 className="mt-6 font-serif text-[clamp(2.2rem,5.5vw,3.75rem)] font-black leading-[1.04] tracking-tight text-navy">
          {step.title} {step.accent && <span className="gold-grad italic">{step.accent}</span>}
        </h1>
        <p className="mt-5 max-w-2xl text-lg leading-relaxed text-charcoal/70">{step.description}</p>

        <div className="mt-9 space-y-5">
          {step.blocks.map((b, i) => <Block key={i} block={b} />)}
        </div>
      </div>

      {/* Footer nav */}
      <div className="fixed inset-x-0 bottom-0 z-10 border-t border-[#E4DCCB] bg-cream/95 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-5 py-3.5">
          <button onClick={onBack} className="inline-flex items-center gap-1.5 text-sm font-semibold text-charcoal/70 hover:text-navy">
            <ArrowLeft className="h-4 w-4" /> Back
          </button>
          {last ? (
            <Link href="/signup" className="inline-flex items-center gap-2 rounded-full bg-gradient-gold px-7 py-3 text-sm font-bold uppercase tracking-wider text-navy shadow-card transition-transform hover:-translate-y-0.5">
              Finish <Check className="h-4 w-4" />
            </Link>
          ) : (
            <button onClick={onNext} className="inline-flex items-center gap-2 rounded-full bg-gradient-primary px-7 py-3 text-sm font-bold uppercase tracking-wider text-cream shadow-card transition-transform hover:-translate-y-0.5">
              Next <ArrowRight className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────── Blocks ───────────────────────── */
function Block({ block }: { block: GsBlock }) {
  switch (block.type) {
    case "paragraph":
      return <p className="text-[15px] leading-relaxed text-charcoal/75">{block.text}</p>;

    case "note":
      return (
        <div className="flex gap-3 rounded-2xl border border-gold/30 bg-gold/5 p-4">
          <Lightbulb className="h-5 w-5 flex-shrink-0 text-gold" aria-hidden="true" />
          <p className="text-sm leading-relaxed text-charcoal/75">{block.text}</p>
        </div>
      );

    case "numbered":
      return (
        <ol className="space-y-3">
          {block.items.map((it, i) => (
            <li key={i} className="flex items-start gap-3.5 rounded-2xl border border-[#E7E0D2] bg-cream p-4 shadow-card">
              <span className="grid h-8 w-8 flex-shrink-0 place-items-center rounded-full bg-gradient-gold text-sm font-bold text-navy">{i + 1}</span>
              <span className="pt-1 text-[15px] leading-relaxed text-charcoal/80">{it}</span>
            </li>
          ))}
        </ol>
      );

    case "checklist":
      return (
        <div className="space-y-3">
          {block.items.map((it, i) => (
            <div key={i} className="rounded-2xl border border-[#E7E0D2] bg-offwhite/60 p-5">
              <h3 className="text-sm font-bold uppercase tracking-wide text-gold">{it.title}</h3>
              <p className="mt-2 text-[15px] leading-relaxed text-charcoal/75">{it.text}</p>
            </div>
          ))}
        </div>
      );

    case "video":
      return (
        <a
          href={block.video || undefined}
          target={block.video ? "_blank" : undefined}
          rel="noreferrer"
          className={`group relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-2xl border border-[#233] bg-gradient-navy ${block.video ? "cursor-pointer" : "cursor-default"}`}
        >
          <div className="absolute left-5 top-5 rounded-full border border-gold/40 px-3 py-1 text-[10px] font-bold uppercase tracking-label text-gold">
            {block.label || "Watch"}
          </div>
          <span className="grid h-16 w-16 place-items-center rounded-full bg-red-600 text-white shadow-lg transition-transform group-hover:scale-105">
            <Play className="h-6 w-6 fill-current" />
          </span>
          {!block.video && (
            <span className="absolute bottom-4 text-[11px] font-medium uppercase tracking-wider text-light/70">Paste your video link in the data file</span>
          )}
        </a>
      );

    case "apps":
      return (
        <div className="space-y-2.5">
          {block.apps.map((app) => (
            <div key={app.name} className="flex items-center justify-between gap-3 rounded-2xl border border-[#E7E0D2] bg-offwhite/60 px-5 py-4">
              <span className="font-semibold text-navy">{app.name}</span>
              <span className="flex gap-2">
                <a href={app.ios || "#"} className="rounded-lg bg-navy px-3.5 py-2 text-xs font-semibold text-cream hover:opacity-90"> iOS</a>
                <a href={app.android || "#"} className="rounded-lg bg-navy px-3.5 py-2 text-xs font-semibold text-cream hover:opacity-90">▶ Android</a>
              </span>
            </div>
          ))}
        </div>
      );

    case "cta": {
      const isInternal = block.href?.startsWith("/");
      const cls = "flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-gold px-6 py-4 text-sm font-bold uppercase tracking-wider text-navy shadow-card transition-transform hover:-translate-y-0.5";
      return isInternal ? (
        <Link href={block.href!} className={cls}>{block.label} <ArrowRight className="h-4 w-4" /></Link>
      ) : (
        <a href={block.href || "#"} className={cls}>{block.label} <ArrowRight className="h-4 w-4" /></a>
      );
    }

    case "form":
      return <SmsForm />;

    case "follow":
      return (
        <div className="grid gap-4 sm:grid-cols-2">
          {block.people.map((p) => (
            <div key={p.handle} className="rounded-2xl border border-[#E7E0D2] bg-offwhite/60 p-5 text-center">
              <div className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-gradient-gold font-serif text-xl font-bold text-navy">
                {p.handle.replace(/[@_]/g, "").slice(0, 2).toUpperCase()}
              </div>
              <p className="mt-3 font-semibold text-navy">{p.handle}</p>
              {p.tag && <p className="mt-0.5 text-[11px] font-bold uppercase tracking-wide text-gold">{p.tag}</p>}
              <a href={p.url || "#"} className="mt-4 inline-block w-full rounded-full bg-gradient-primary px-4 py-2.5 text-xs font-bold uppercase tracking-wider text-cream hover:-translate-y-0.5">
                Follow
              </a>
            </div>
          ))}
        </div>
      );

    default:
      return null;
  }
}

/* SMS opt-in — UI only. Wire this to your SMS provider before launch. */
function SmsForm() {
  const [done, setDone] = useState(false);
  function submit(e: FormEvent) {
    e.preventDefault();
    setDone(true);
  }
  const field = "w-full rounded-xl border border-[#E4DCCB] bg-cream px-4 py-3.5 text-sm outline-none focus:border-gold";
  if (done) {
    return (
      <div className="rounded-2xl border border-gold/30 bg-gold/5 p-5 text-center">
        <Check className="mx-auto h-8 w-8 text-gold" />
        <p className="mt-2 text-sm font-semibold text-navy">You&apos;re on the list (demo).</p>
        <p className="mt-1 text-xs text-charcoal/60">Connect your SMS provider in the code to make this live.</p>
      </div>
    );
  }
  return (
    <form onSubmit={submit} className="grid gap-3 rounded-2xl border border-[#E7E0D2] bg-cream p-5 shadow-card sm:grid-cols-2">
      <input className={field} placeholder="First name" autoComplete="given-name" />
      <input className={field} placeholder="Last name" autoComplete="family-name" />
      <input className={field + " sm:col-span-2"} placeholder="Email" type="email" autoComplete="email" />
      <input className={field + " sm:col-span-2"} placeholder="Mobile number" type="tel" autoComplete="tel" />
      <button type="submit" className="sm:col-span-2 rounded-full bg-gradient-primary px-6 py-3.5 text-sm font-bold uppercase tracking-wider text-cream hover:-translate-y-0.5">
        Sign Up
      </button>
    </form>
  );
}
