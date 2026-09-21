"use client";

import Link from "next/link";
import { Rise } from "./motion";

/**
 * THE REMAINING SECTIONS.
 *
 * One file because they share a vocabulary — the same rhythm of eyebrow, statement, proof — and
 * splitting them across five files would hide that rhythm rather than express it.
 *
 * THE RULE RUNNING THROUGH ALL OF THEM: nothing claims a result. There are no win rates, no returns,
 * no testimonials, because none of those exist in a form anybody has permission to publish. The
 * previous homepage carried a note to that effect and it was right. Credibility here comes from
 * describing how the machine actually behaves — which is checkable, and which a competitor copying
 * the page cannot fake.
 */

const Eyebrow = ({ children }: { children: React.ReactNode }) => (
  <p className="text-[11px] font-bold uppercase tracking-[0.22em]" style={{ color: "var(--h3-faint)" }}>{children}</p>
);

/* ══════════════════════════ ECOSYSTEM ══════════════════════════ */

const PRODUCTS = [
  { name: "OM AI Plays", role: "Discovery", line: "Scans continuously and discards almost everything.", accent: "#4C7DF0" },
  { name: "GENX", role: "Intelligence", line: "The brain. Reads gold across every timeframe and forms a view.", accent: "#4C7DF0" },
  { name: "Command Center", role: "Understanding", line: "Ask it anything about gold. It answers from live measurement.", accent: "#C9A961" },
  { name: "FLOW", role: "Execution", line: "Takes the trade and manages it to the permissions you set.", accent: "#2F7D5B" },
  { name: "The Floor", role: "Home", line: "Where all of it lives, in one place.", accent: "#0B0D12" },
];

export function Ecosystem() {
  return (
    <section className="border-y" style={{ background: "var(--h3-surface)", borderColor: "var(--h3-line)" }}>
      <div className="mx-auto max-w-6xl px-6 py-20 lg:py-24">
        <Rise>
          <Eyebrow>The ecosystem</Eyebrow>
          <h2 className="mt-4 max-w-2xl text-[clamp(1.9rem,4vw,2.9rem)] font-black leading-[1.04] tracking-[-0.03em]"
            style={{ color: "var(--h3-ink)" }}>
            Five systems. One instrument. Built to hand off to each other.
          </h2>
        </Rise>

        {/*
          * A list, not a card grid. Cards imply five equivalent things you choose between; a numbered
          * sequence with a rule down the side implies an order, which is the actual truth of it.
          */}
        <ul className="mt-12 divide-y" style={{ borderColor: "var(--h3-line)" }}>
          {PRODUCTS.map((p, i) => (
            <li key={p.name} className="border-t" style={{ borderColor: "var(--h3-line)" }}>
              <Rise delay={i * 70}>
                <div className="group grid grid-cols-[auto_1fr] items-baseline gap-x-6 gap-y-1.5 py-6 md:grid-cols-[auto_minmax(0,220px)_1fr]">
                  <span className="text-[11px] font-bold tabular-nums tracking-[0.18em]" style={{ color: p.accent }}>
                    0{i + 1}
                  </span>
                  <h3 className="text-[20px] font-bold tracking-[-0.02em]" style={{ color: "var(--h3-ink)" }}>
                    {p.name}
                    <span className="ml-3 align-middle text-[10.5px] font-bold uppercase tracking-[0.16em]" style={{ color: "var(--h3-faint)" }}>
                      {p.role}
                    </span>
                  </h3>
                  <p className="col-start-2 text-[15px] leading-relaxed md:col-start-3" style={{ color: "var(--h3-muted)" }}>
                    {p.line}
                  </p>
                </div>
              </Rise>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/* ══════════════════════════ COMMAND CENTER ══════════════════════════ */

/**
 * The one dark section on the page.
 *
 * Used exactly once, and for the product that earns it. A page where every other section inverts is
 * a page with no emphasis left to give; a single inversion, two thirds of the way down, lands like a
 * held note. This is also the product that is genuinely hardest to explain in a sentence, so it gets
 * the room and the contrast to be shown rather than described.
 */
export function CommandCenterMoment() {
  const QA = [
    ["What are you seeing on gold?", "Buyers have held the London high twice. The hourly is still up but the five-minute is compressing — that usually resolves within the hour."],
    ["What would change your mind?", "A close back under forty-three twenty with acceptance. That invalidates the read I've had since the open."],
    ["How's my trade?", "Seventy-four pips up, nought point eight R. Stop is at break-even. Structure still favours you."],
  ];
  return (
    <section className="relative overflow-hidden" style={{ background: "#0A0C10" }}>
      <div aria-hidden className="pointer-events-none absolute inset-0"
        style={{ background: "radial-gradient(800px 480px at 22% 20%, rgba(201,169,97,0.14), transparent 68%)" }} />

      <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-6 py-24 lg:grid-cols-2 lg:gap-16 lg:py-32">
        <Rise>
          <p className="text-[11px] font-bold uppercase tracking-[0.22em]" style={{ color: "rgba(255,255,255,0.42)" }}>
            Command Center
          </p>
          <h2 className="mt-4 text-[clamp(2rem,4.4vw,3.2rem)] font-black leading-[1.02] tracking-[-0.035em] text-white">
            Say it out loud.
            <br />
            It answers from the market.
          </h2>
          <p className="mt-6 max-w-md text-[16.5px] leading-relaxed" style={{ color: "rgba(255,255,255,0.62)" }}>
            Open one line and talk normally. No button before each sentence, no scripts.
            Interrupt it mid-word and it stops. Ask it why it thinks something and it
            shows you the evidence rather than repeating the conclusion.
          </p>
          <p className="mt-5 max-w-md text-[13.5px] leading-relaxed" style={{ color: "rgba(255,255,255,0.40)" }}>
            It refuses to invent a price. If the feed is down or the market is shut, it says so.
          </p>
        </Rise>

        <Rise delay={120}>
          <div className="rounded-3xl border p-5 backdrop-blur-xl"
            style={{ borderColor: "rgba(255,255,255,0.10)", background: "rgba(255,255,255,0.045)" }}>
            {QA.map(([q, a], i) => (
              <div key={q} className={i ? "mt-5 border-t pt-5" : ""} style={{ borderColor: "rgba(255,255,255,0.08)" }}>
                <p className="text-[10.5px] font-bold uppercase tracking-[0.18em]" style={{ color: "rgba(255,255,255,0.40)" }}>You</p>
                <p className="mt-1 text-[14.5px] text-white">{q}</p>
                <p className="mt-3 text-[10.5px] font-bold uppercase tracking-[0.18em]" style={{ color: "#C9A961" }}>Atlas</p>
                <p className="mt-1 text-[14.5px] leading-relaxed" style={{ color: "rgba(255,255,255,0.80)" }}>{a}</p>
              </div>
            ))}
          </div>
        </Rise>
      </div>
    </section>
  );
}

/* ══════════════════════════ THE FLOOR ══════════════════════════ */

export function TheFloorSection() {
  return (
    <section style={{ background: "var(--h3-page)" }}>
      <div className="mx-auto max-w-6xl px-6 py-20 lg:py-28">
        <Rise>
          <Eyebrow>The Floor</Eyebrow>
          <h2 className="mt-4 max-w-2xl text-[clamp(1.9rem,4vw,2.9rem)] font-black leading-[1.04] tracking-[-0.03em]"
            style={{ color: "var(--h3-ink)" }}>
            Everything in one place, running whether you are watching or not.
          </h2>
          <p className="mt-5 max-w-xl text-[16px] leading-relaxed" style={{ color: "var(--h3-muted)" }}>
            Your accounts, your risk settings, what each one is permitted to do, and every
            tool in the ecosystem. Close the laptop and the position is still managed —
            the work happens on a server, not in your browser tab.
          </p>
        </Rise>

        <Rise delay={120}>
          <div className="mt-12 grid gap-px overflow-hidden rounded-3xl border sm:grid-cols-2 lg:grid-cols-4"
            style={{ borderColor: "var(--h3-line)", background: "var(--h3-line)" }}>
            {[
              ["Your accounts", "Connect one or several. Each keeps its own risk, its own styles, its own permissions."],
              ["Your permissions", "Decide what may happen without asking you. Nothing outside that ever does."],
              ["Your styles", "Rapid, Normal and Swing. Take the fast ones and leave the ones that hold overnight."],
              ["Your record", "Every call it made, scored against what the market actually did afterwards."],
            ].map(([t, b]) => (
              <div key={t} className="p-6" style={{ background: "var(--h3-surface)" }}>
                <h3 className="text-[14px] font-bold tracking-[-0.01em]" style={{ color: "var(--h3-ink)" }}>{t}</h3>
                <p className="mt-2 text-[13.5px] leading-relaxed" style={{ color: "var(--h3-muted)" }}>{b}</p>
              </div>
            ))}
          </div>
        </Rise>
      </div>
    </section>
  );
}

/* ══════════════════════════ CREDIBILITY ══════════════════════════ */

/**
 * Trust without a single claimed result.
 *
 * Every one of these is a statement about how the system BEHAVES, which is verifiable by using it and
 * which a page that copied this one could not honestly repeat. Returns and win rates would be louder
 * and would mean nothing — and there are none that anybody has permission to publish.
 */
export function Credibility() {
  const FACTS = [
    ["It refuses more than it takes", "Most of what the scanner finds is discarded before you ever see it. Refusal is the product."],
    ["It will tell you it does not know", "No live feed, no answer. It will not invent a price to fill a silence."],
    ["It cannot exceed your permissions", "Every action is checked on the server. A modified browser gets the same refusal."],
    ["It keeps its own score", "Every call is recorded with the price at the time and judged later against what happened."],
    ["It runs without you", "Monitoring and management live on a server. Your laptop sleeping changes nothing."],
    ["It fails closed", "Stale data, a broken feed or an unclear market ends in no trade, not a guess."],
  ];
  return (
    <section className="border-y" style={{ background: "var(--h3-surface)", borderColor: "var(--h3-line)" }}>
      <div className="mx-auto max-w-6xl px-6 py-20 lg:py-24">
        <Rise>
          <Eyebrow>How it behaves</Eyebrow>
          <h2 className="mt-4 max-w-2xl text-[clamp(1.9rem,4vw,2.9rem)] font-black leading-[1.04] tracking-[-0.03em]"
            style={{ color: "var(--h3-ink)" }}>
            We would rather show you the guardrails than a screenshot of a good week.
          </h2>
        </Rise>
        <div className="mt-12 grid gap-x-10 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
          {FACTS.map(([t, b], i) => (
            <Rise key={t} delay={i * 60}>
              <h3 className="text-[15px] font-bold tracking-[-0.01em]" style={{ color: "var(--h3-ink)" }}>{t}</h3>
              <p className="mt-2 text-[14px] leading-relaxed" style={{ color: "var(--h3-muted)" }}>{b}</p>
            </Rise>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ══════════════════════════ CLOSE ══════════════════════════ */

export function Close() {
  return (
    <section style={{ background: "var(--h3-page)" }}>
      <div className="mx-auto max-w-3xl px-6 py-24 text-center lg:py-32">
        <Rise>
          <h2 className="text-[clamp(2.1rem,5vw,3.4rem)] font-black leading-[1.02] tracking-[-0.035em]"
            style={{ color: "var(--h3-ink)" }}>
            One market, taken seriously.
          </h2>
          <p className="mx-auto mt-6 max-w-lg text-[17px] leading-relaxed" style={{ color: "var(--h3-muted)" }}>
            Gold, watched continuously by a system that explains itself and keeps its own
            score. Start with the intelligence; turn on execution when you trust it.
          </p>
          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <Link href="/signup" className="h3-cta rounded-full px-7 py-3.5 text-[13.5px] font-bold"
              style={{ background: "var(--h3-ink)", color: "#FFFFFF" }}>
              Start with One Mission
            </Link>
            <Link href="/command-center" className="rounded-full border px-7 py-3.5 text-[13.5px] font-bold"
              style={{ borderColor: "var(--h3-line)", color: "var(--h3-ink)", background: "var(--h3-surface)" }}>
              See the Command Center
            </Link>
          </div>
          <p className="mx-auto mt-8 max-w-md text-[12px] leading-relaxed" style={{ color: "var(--h3-faint)" }}>
            Trading involves risk and you can lose money using this software. It is a tool,
            not a promise, and nothing here is a guarantee of profit or financial advice.
          </p>
        </Rise>
      </div>
    </section>
  );
}
