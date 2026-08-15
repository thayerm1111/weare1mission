"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowRight, LineChart, Zap, Users2, GraduationCap, Video, Network,
  Trophy,
} from "lucide-react";
import { DailyEngagement } from "./DailyEngagement";
import { Watchlist } from "./Watchlist";
import { Achievements } from "./Achievements";
import { MarketBrief } from "./MarketBrief";
import { WinsWall } from "./WinsWall";
import { CreditsBadge } from "./CreditsBadge";

type Side = "ones" | "builders";
type Tile = { href: string; icon: typeof LineChart; label: string; desc: string };

/**
 * PathHub — the side-aware member home. Reads the same `portal_side` the sidebar
 * uses and stays in sync via the "portal-side" event PortalNav dispatches, so the
 * dashboard becomes a distinct experience for The One vs The Builder.
 */
export function PathHub({ firstName }: { firstName: string }) {
  const [side, setSide] = useState<Side>("ones");

  useEffect(() => {
    try {
      const s = localStorage.getItem("portal_side");
      if (s === "ones" || s === "builders") setSide(s);
    } catch { /* ignore */ }
    const onSide = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (d === "ones" || d === "builders") setSide(d);
    };
    window.addEventListener("portal-side", onSide as EventListener);
    return () => window.removeEventListener("portal-side", onSide as EventListener);
  }, []);

  return side === "builders" ? <BuilderHub firstName={firstName} /> : <OneHub firstName={firstName} />;
}

function HubTile({ t }: { t: Tile }) {
  const Icon = t.icon;
  return (
    <Link
      href={t.href}
      className="group flex flex-col rounded-2xl border border-[#E7E4DD] bg-white p-5 transition-all hover:-translate-y-0.5 hover:shadow-card"
    >
      <span className="grid h-10 w-10 place-items-center rounded-xl bg-primary text-white" aria-hidden="true">
        <Icon className="h-5 w-5" />
      </span>
      <h3 className="mt-4 flex items-center gap-1 font-serif text-sm font-semibold uppercase tracking-[0.12em] text-navy">
        {t.label}
        <ArrowRight className="h-3.5 w-3.5 opacity-0 transition-opacity group-hover:opacity-100" aria-hidden="true" />
      </h3>
      <p className="mt-1 text-sm text-charcoal/60">{t.desc}</p>
    </Link>
  );
}

function Banner({
  eyebrow, line1, line2, body, ctaLabel, ctaHref, altLabel, altHref,
}: {
  eyebrow: string; line1: string; line2: string; body: string;
  ctaLabel: string; ctaHref: string; altLabel: string; altHref: string;
}) {
  return (
    <div className="relative overflow-hidden rounded-2xl bg-navy p-8 sm:p-10">
      <span className="eyebrow text-gold-light">{eyebrow}</span>
      <h1 className="mt-4 font-serif text-3xl font-semibold uppercase leading-[1.05] tracking-[0.02em] text-white sm:text-4xl">
        {line1}
        <br />
        <span className="text-gold-light">{line2}</span>
      </h1>
      <p className="mt-4 max-w-xl text-light/80">{body}</p>
      <div className="mt-7 flex flex-wrap gap-3">
        <Link
          href={ctaHref}
          className="group inline-flex items-center gap-2.5 rounded-none bg-white px-7 py-3.5 text-[13px] font-medium uppercase tracking-[0.14em] text-navy transition-colors hover:bg-ice"
        >
          {ctaLabel}
          <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
        </Link>
        <Link
          href={altHref}
          className="inline-flex items-center gap-2 rounded-none border border-white/25 px-7 py-3.5 text-[13px] font-medium uppercase tracking-[0.14em] text-white transition-colors hover:bg-white/10"
        >
          {altLabel}
        </Link>
      </div>
    </div>
  );
}

/* ─────────────────────────── The One (customer) ─────────────────────────── */
function OneHub({ firstName }: { firstName: string }) {
  const tiles: Tile[] = [
    { href: "/portal/trading", icon: LineChart, label: "The Floor", desc: "The live trading room" },
    { href: "/portal/trading?view=plays", icon: Zap, label: "Live Setups", desc: "Today's plays, shared" },
    { href: "/portal/leadership", icon: Users2, label: "Featured Traders", desc: "Learn from the ones ahead" },
    { href: "/portal/training", icon: GraduationCap, label: "Creator Launchpad", desc: "Trading & mindset training" },
  ];
  return (
    <div className="space-y-8">
      <Banner
        eyebrow="The One · Your Path"
        line1={`Welcome back, ${firstName}.`}
        line2="Master the markets. Master your mind."
        body="The floor is open. Show up, put in the reps, and trade alongside a room that has your back."
        ctaLabel="Enter The Floor"
        ctaHref="/portal/trading"
        altLabel="Continue Onboarding"
        altHref="/portal/start-here"
      />

      <div className="flex justify-end">
        <CreditsBadge />
      </div>

      <DailyEngagement side="ones" />

      <MarketBrief />

      <Watchlist />

      <WinsWall />

      <Achievements />

      <div>
        <span className="eyebrow">Your Focus</span>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {tiles.map((t) => <HubTile key={t.href} t={t} />)}
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────── The Builder (affiliate) ─────────────────────── */
function BuilderHub({ firstName }: { firstName: string }) {
  const tiles: Tile[] = [
    { href: "/portal/training", icon: GraduationCap, label: "Affiliate Academy", desc: "Your build roadmap & PD library" },
    { href: "/portal/prospects", icon: Video, label: "Next Up", desc: "Your prospect pipeline" },
    { href: "/portal/team", icon: Network, label: "My Circle", desc: "Your growing team" },
    { href: "/portal/comp-plan", icon: Trophy, label: "The Comp Plan", desc: "Ranks, pay & bonuses" },
  ];
  return (
    <div className="space-y-8">
      <Banner
        eyebrow="The Builder · Your Path"
        line1={`Let's build, ${firstName}.`}
        line2="Build the business. Become the leader."
        body="Champions are made in the boring reps. Do the work today that your future self will thank you for."
        ctaLabel="Open the Affiliate Academy"
        ctaHref="/portal/training"
        altLabel="See The Comp Plan"
        altHref="/portal/comp-plan"
      />

      {/* Featured — the Affiliate Academy, front and center on the business side */}
      <Link
        href="/portal/training"
        className="group relative block overflow-hidden rounded-2xl border border-[#E7E4DD] bg-white p-6 shadow-card transition-all hover:-translate-y-0.5 hover:shadow-lg sm:p-8"
        style={{ backgroundImage: "radial-gradient(120% 100% at 100% 0%, rgba(37,99,235,0.08), transparent 55%)" }}
      >
        <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-4">
            <span className="grid h-14 w-14 flex-shrink-0 place-items-center rounded-2xl bg-navy text-white" aria-hidden="true">
              <GraduationCap className="h-7 w-7" />
            </span>
            <div>
              <span className="eyebrow text-primary">Start Here · The Business</span>
              <h2 className="mt-1 font-serif text-2xl font-semibold uppercase tracking-[0.02em] text-navy sm:text-[28px]">
                The Affiliate Academy
              </h2>
              <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-charcoal/65">
                Your step-by-step roadmap to build One Mission — the daily method, invite &amp; presentation skills,
                an AI coach and role-play, plus the full <span className="font-semibold text-navy">Learn From the Greats</span> personal-development library.
              </p>
            </div>
          </div>
          <span className="inline-flex flex-shrink-0 items-center gap-2.5 self-start rounded-none bg-navy px-7 py-3.5 text-[13px] font-medium uppercase tracking-[0.14em] text-white transition-colors group-hover:bg-primary sm:self-center">
            Enter the Academy
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
          </span>
        </div>
      </Link>

      <DailyEngagement side="builders" />

      <div>
        <span className="eyebrow">Your Focus</span>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {tiles.map((t) => <HubTile key={t.href} t={t} />)}
        </div>
      </div>
    </div>
  );
}
