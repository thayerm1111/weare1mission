"use client";

import { EASE, useSectionProgress, stepOf } from "./motion";

/**
 * HOW IT WORKS — the section the whole page is built around.
 *
 * THE PROBLEM IT SOLVES. Five products is four too many to explain in a grid of cards. A grid says
 * "here are five things"; it never says which comes first, what hands off to what, or why any of it
 * is one system rather than five purchases. A visitor leaves knowing the names and not the shape.
 *
 * THE MECHANIC. The section pins for five screens of scroll, and the scroll that would have moved
 * the page instead moves the story through it. The visitor is not watching an animation — they are
 * driving one, at their own pace, and can stop on any step. That is the difference between a video
 * they endure and a demonstration they conduct.
 *
 * WHY THAT IS THE RIGHT MECHANIC HERE. The system's defining property is that it is SEQUENTIAL: find,
 * judge, explain, execute, manage. Scroll is itself a sequence. Binding one to the other means the
 * page's structure teaches the product's structure before any copy is read — which is the only kind of
 * storytelling that survives somebody skimming.
 *
 * MOBILE DOES NOT PIN. A sticky scene on a short viewport, with a browser chrome that grows and
 * shrinks as you scroll, is how this technique becomes motion sickness. Below the breakpoint the same
 * five steps become five honest cards that rise as they arrive — same content, same order, none of
 * the fragility.
 */

type Step = {
  n: string; product: string; title: string; body: string;
  panel: React.ReactNode;
};

/* ── the little product panels ────────────────────────────────────────────
 * Drawn, not screenshotted. A screenshot dates the moment the product changes,
 * carries whatever happened to be on screen that day, and weighs a hundred times
 * more. These say what the surface DOES, which is the durable part.
 */

const Panel = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div className="w-full overflow-hidden rounded-2xl border shadow-[0_24px_60px_-28px_rgba(11,13,18,0.28)]"
    style={{ borderColor: "var(--h3-line)", background: "#FFFFFF" }}>
    <div className="flex items-center gap-2 border-b px-4 py-2.5" style={{ borderColor: "var(--h3-line)" }}>
      <span className="h-2 w-2 rounded-full" style={{ background: "#4C7DF0" }} />
      <span className="text-[10px] font-bold uppercase tracking-[0.18em]" style={{ color: "var(--h3-faint)" }}>{title}</span>
    </div>
    <div className="px-4 py-4">{children}</div>
  </div>
);

const Row = ({ k, v, tone }: { k: string; v: string; tone?: string }) => (
  <div className="flex items-baseline justify-between gap-4 py-1.5">
    <span className="text-[11.5px]" style={{ color: "var(--h3-faint)" }}>{k}</span>
    <span className="text-[12.5px] font-semibold tabular-nums" style={{ color: tone ?? "var(--h3-ink)" }}>{v}</span>
  </div>
);

const STEPS: Step[] = [
  {
    n: "01", product: "OM AI Plays", title: "It finds the opportunity.",
    body: "Scanning without stopping, so the setup that forms at four in the morning is not a setup you missed. Most of what it finds, it discards.",
    panel: (
      <Panel title="Scanning">
        <Row k="Candidates examined" v="1,284" />
        <Row k="Survived structure" v="37" />
        <Row k="Survived confluence" v="4" />
        <Row k="Worth your attention" v="1" tone="#2F7D5B" />
        <p className="mt-3 border-t pt-3 text-[11.5px] leading-relaxed" style={{ borderColor: "var(--h3-line)", color: "var(--h3-faint)" }}>
          Discipline is mostly refusal. The number that matters is the one it threw away.
        </p>
      </Panel>
    ),
  },
  {
    n: "02", product: "GENX", title: "It decides whether the trade is real.",
    body: "The brain behind FLOW. It reads gold across every timeframe at once, forms a view, and holds that view accountable to the evidence that produced it.",
    panel: (
      <Panel title="Reading gold">
        {[["1D", "uptrend", 0.82], ["4H", "uptrend", 0.71], ["1H", "pullback", 0.44], ["15M", "compressing", 0.31], ["5M", "breakout retest", 0.66]].map(([tf, state, w]) => (
          <div key={String(tf)} className="py-1.5">
            <div className="flex items-baseline justify-between">
              <span className="text-[11px] font-bold tracking-[0.08em]" style={{ color: "var(--h3-ink)" }}>{tf}</span>
              <span className="text-[11px]" style={{ color: "var(--h3-faint)" }}>{state}</span>
            </div>
            <div className="mt-1 h-[3px] w-full overflow-hidden rounded-full" style={{ background: "rgba(11,13,18,0.07)" }}>
              <div className="h-full rounded-full" style={{ width: `${Number(w) * 100}%`, background: "#4C7DF0", opacity: 0.55 }} />
            </div>
          </div>
        ))}
      </Panel>
    ),
  },
  {
    n: "03", product: "Command Center", title: "It tells you what it sees, in words.",
    body: "Ask it anything about gold and it answers from live measurement — not from a template. Ask why, and it shows you the evidence it used.",
    panel: (
      <Panel title="Talking">
        <p className="text-[11px] font-bold uppercase tracking-[0.16em]" style={{ color: "#4C7DF0" }}>You</p>
        <p className="mt-1 text-[13px]" style={{ color: "var(--h3-ink)" }}>Why don&rsquo;t you trust that breakout?</p>
        <p className="mt-3 text-[11px] font-bold uppercase tracking-[0.16em]" style={{ color: "#C9A961" }}>The Brain</p>
        <p className="mt-1 text-[13px] leading-relaxed" style={{ color: "var(--h3-ink)" }}>
          Price cleared the level but never spent time above it — one wick, then back inside.
          Volume didn&rsquo;t confirm. I&rsquo;d want acceptance before I call it a break.
        </p>
      </Panel>
    ),
  },
  {
    n: "04", product: "FLOW", title: "It takes the trade.",
    body: "Sized from your own risk setting, on your own account, at the price that exists when you approve it — never the one you were shown a minute ago.",
    panel: (
      <Panel title="Execution">
        <Row k="Direction" v="Buy XAUUSD" tone="#2F7D5B" />
        <Row k="Style" v="Rapid" />
        <Row k="Risk" v="0.5% · $125" />
        <Row k="Stop" v="38 pips" />
        <p className="mt-3 border-t pt-3 text-[11.5px] leading-relaxed" style={{ borderColor: "var(--h3-line)", color: "var(--h3-faint)" }}>
          Recomputed against a fresh price at the moment you approve. If anything drifted, it refuses.
        </p>
      </Panel>
    ),
  },
  {
    n: "05", product: "The Floor", title: "And it manages it, while you get on with your day.",
    body: "Break-even, partials, protecting a move that has turned — to the permissions you set, on a server that keeps working when your laptop is shut.",
    panel: (
      <Panel title="In the trade">
        <Row k="Open" v="+74 pips" tone="#2F7D5B" />
        <Row k="R multiple" v="+0.81R" tone="#2F7D5B" />
        <Row k="Stop" v="moved to break-even" />
        <Row k="Health" v="Holding" />
        <p className="mt-3 border-t pt-3 text-[11.5px] leading-relaxed" style={{ borderColor: "var(--h3-line)", color: "var(--h3-faint)" }}>
          Everything lives in one place. Close the laptop; the position is still managed.
        </p>
      </Panel>
    ),
  },
];

export function HowItWorks() {
  const { ref, progress } = useSectionProgress<HTMLDivElement>();
  const { index, within } = stepOf(progress, STEPS.length);

  return (
    <section id="how" style={{ background: "var(--h3-page)" }}>
      {/* ── the pinned scene (desktop) ───────────────────────────────── */}
      <div ref={ref} className="relative hidden lg:block" style={{ height: `${STEPS.length * 100}vh` }}>
        <div className="sticky top-0 flex h-screen items-center overflow-hidden">
          <div aria-hidden className="pointer-events-none absolute inset-0"
            style={{ background: "radial-gradient(760px 460px at 72% 50%, rgba(76,125,240,0.09), transparent 70%)" }} />

          <div className="relative mx-auto grid w-full max-w-6xl grid-cols-[0.95fr_1.05fr] items-center gap-16 px-6">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[0.22em]" style={{ color: "var(--h3-faint)" }}>
                How it works
              </p>

              {/*
                * The five titles are all present in the DOM and stacked; only opacity and a small
                * translate change. Nothing mounts or unmounts as you scroll, so there is no layout
                * work at all on a scroll frame — the browser composites and nothing else.
                */}
              <div className="relative mt-5 h-[290px]">
                {STEPS.map((s, i) => {
                  const on = i === index;
                  return (
                    <div key={s.n} aria-hidden={!on}
                      className="absolute inset-0"
                      style={{
                        opacity: on ? 1 : 0,
                        transform: `translate3d(0, ${on ? 0 : i < index ? -18 : 18}px, 0)`,
                        transition: `opacity 620ms ${EASE}, transform 620ms ${EASE}`,
                        pointerEvents: on ? "auto" : "none",
                      }}>
                      <p className="text-[12px] font-bold tracking-[0.2em]" style={{ color: "#4C7DF0" }}>
                        {s.n} · {s.product.toUpperCase()}
                      </p>
                      <h3 className="mt-3 text-[clamp(1.9rem,3.1vw,2.7rem)] font-black leading-[1.04] tracking-[-0.03em]"
                        style={{ color: "var(--h3-ink)" }}>
                        {s.title}
                      </h3>
                      <p className="mt-4 max-w-md text-[16px] leading-relaxed" style={{ color: "var(--h3-muted)" }}>
                        {s.body}
                      </p>
                    </div>
                  );
                })}
              </div>

              {/* Progress, as five segments. The current one fills as you scroll through it — so the
                  visitor always knows how much of the story is left, which is what stops a pinned
                  section feeling like a trap. */}
              <div className="mt-8 flex gap-2">
                {STEPS.map((s, i) => (
                  <div key={s.n} className="h-[3px] flex-1 overflow-hidden rounded-full" style={{ background: "rgba(11,13,18,0.08)" }}>
                    <div className="h-full rounded-full"
                      style={{
                        width: i < index ? "100%" : i === index ? `${within * 100}%` : "0%",
                        background: "#4C7DF0",
                        transition: i === index ? "none" : `width 400ms ${EASE}`,
                      }} />
                  </div>
                ))}
              </div>
            </div>

            <div className="relative h-[360px]">
              {STEPS.map((s, i) => {
                const on = i === index;
                return (
                  <div key={s.n} aria-hidden={!on} className="absolute inset-0 flex items-center"
                    style={{
                      opacity: on ? 1 : 0,
                      // The panel arrives from slightly further away than the text and a touch later.
                      // That parallax is what reads as depth rather than as two things fading together.
                      transform: `translate3d(0, ${on ? 0 : i < index ? -30 : 30}px, 0) scale(${on ? 1 : 0.985})`,
                      transition: `opacity 700ms ${EASE} 60ms, transform 700ms ${EASE} 60ms`,
                      pointerEvents: on ? "auto" : "none",
                    }}>
                    {s.panel}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* ── the same story, unpinned (mobile) ────────────────────────── */}
      <div className="lg:hidden">
        <div className="mx-auto max-w-2xl px-6 py-16">
          <p className="text-[11px] font-bold uppercase tracking-[0.22em]" style={{ color: "var(--h3-faint)" }}>
            How it works
          </p>
          <div className="mt-8 space-y-12">
            {STEPS.map((s) => (
              <div key={s.n}>
                <p className="text-[12px] font-bold tracking-[0.2em]" style={{ color: "#4C7DF0" }}>
                  {s.n} · {s.product.toUpperCase()}
                </p>
                <h3 className="mt-2.5 text-[clamp(1.6rem,7vw,2.1rem)] font-black leading-[1.06] tracking-[-0.03em]"
                  style={{ color: "var(--h3-ink)" }}>
                  {s.title}
                </h3>
                <p className="mt-3 text-[15.5px] leading-relaxed" style={{ color: "var(--h3-muted)" }}>{s.body}</p>
                <div className="mt-5">{s.panel}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

export default HowItWorks;
