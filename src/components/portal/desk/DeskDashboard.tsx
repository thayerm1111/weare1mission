"use client";

/**
 * DESK DASHBOARD — the redesigned authenticated home for The Ones (owner spec 09-04).
 *
 * Information hierarchy: Trading technology → Personal development → Community →
 * Business. Desktop/tablet-first; every section stacks cleanly on mobile without
 * touching the existing mobile navigation or page architecture. The Builders side
 * keeps its existing hub (PathHub) untouched.
 *
 * PRODUCT RULE (owner): FLOW and GENX are NOT redesigned or duplicated here — the
 * cards explain each product and route into the existing tools. FLOW's card shows
 * the member's REAL connection state from /api/flow/broker; nothing is fabricated.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { PathHub } from "../PathHub";
import { DailyEngagement } from "../DailyEngagement";
import { WinsWall } from "../WinsWall";
import { DeskResults } from "../DeskResults";
import { TIERS, TIER_XP } from "@/lib/gameData";
import { fmtDateTime } from "@/lib/format";
import {
  ArrowRight, LineChart, Zap, Sparkles, Ghost, Activity, Gem, Users2,
  CalendarClock, Megaphone, GraduationCap, FolderOpen, Medal, Hammer,
} from "lucide-react";

type Side = "ones" | "builders";
type SessionRow = { id: string; title: string; host: string | null; starts_at: string; join_url: string | null };
type UpdateRow = { id: string; title: string; body: string; category: string | null; pinned: boolean | null; created_at: string };

/* ── shared design atoms (premium dark tech, self-contained so both themes work) ── */
const CARD = "relative overflow-hidden rounded-2xl border border-white/[0.08] bg-[#0B0E14]";
const MICRO = "font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-[#5E708E]";
const H_CARD = "text-[19px] font-bold tracking-tight text-[#EDF2FA]";
const BODY_TXT = "text-[13.5px] leading-relaxed text-[#8FA0BC]";
const CTA = "group/cta mt-auto inline-flex items-center gap-2 pt-5 text-[12px] font-bold uppercase tracking-[0.16em] text-[#8FC6FF]";
const CTA_ARROW = "transition-transform group-hover/cta:translate-x-1";

function SectionHead({ label, title, sub }: { label: string; title: string; sub?: string }) {
  return (
    <div className="mb-5">
      <p className={MICRO}>{label}</p>
      <h2 className="mt-1.5 font-serif text-[22px] font-semibold uppercase tracking-[0.04em] text-navy">{title}</h2>
      {sub && <p className="mt-1 text-sm text-charcoal/55">{sub}</p>}
    </div>
  );
}

function Illum({ x = "85%" }: { x?: string }) {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0"
      style={{ background: `radial-gradient(480px 220px at ${x} -10%, rgba(93,158,224,0.13), transparent 62%)` }}
    />
  );
}

/* ─────────────────────────────── HERO ─────────────────────────────── */
function DeskHero({ firstName }: { firstName: string }) {
  const [greet, setGreet] = useState("WELCOME BACK");
  useEffect(() => {
    const h = new Date().getHours();
    setGreet(h < 5 ? "TRADING LATE" : h < 12 ? "GOOD MORNING" : h < 17 ? "GOOD AFTERNOON" : "GOOD EVENING");
  }, []);
  return (
    <section className={`${CARD} px-7 py-8 sm:px-9 sm:py-9`}>
      <Illum x="90%" />
      <div className="relative flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className={MICRO}>{greet}, {firstName.toUpperCase()}.</p>
          <h1 className="mt-2.5 text-[30px] font-bold leading-[1.05] tracking-tight text-[#F2F6FC] sm:text-[36px]">
            Your trading desk.
          </h1>
          <p className="mt-3 max-w-md text-[14px] leading-relaxed text-[#8FA0BC]">
            Everything you need to analyze, execute and stay connected to the market.
          </p>
        </div>
        <div className="flex flex-col items-start gap-3 lg:items-end">
          <span className="inline-flex items-center gap-2 rounded-full border border-emerald-400/25 bg-emerald-400/[0.07] px-3 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-emerald-300">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" /> Desk live
          </span>
          <Link
            href="/portal/trading"
            className="group inline-flex items-center gap-2.5 rounded-none bg-[#EDF2FA] px-7 py-3.5 text-[12.5px] font-bold uppercase tracking-[0.16em] text-[#0B0E14] transition-colors hover:bg-[#8FC6FF]"
          >
            Enter The Floor
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
          </Link>
        </div>
      </div>
    </section>
  );
}

/* ──────────────────────────── TRADING DESK ────────────────────────── */
type BrokerAcct = {
  name?: string | null; accNum?: string | number | null; environment?: string | null;
  riskPct?: number | null; riskMode?: string | null; autotradeEnabled?: boolean;
  beEnabled?: boolean; partialsEnabled?: boolean; manageTrades?: boolean;
};

function FlowCard() {
  const [state, setState] = useState<{ loaded: boolean; connected: boolean; accts: BrokerAcct[] }>({ loaded: false, connected: false, accts: [] });
  useEffect(() => {
    let alive = true;
    fetch("/api/flow/broker", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => { if (alive) setState({ loaded: true, connected: !!d?.connected, accts: Array.isArray(d?.accounts) ? d.accounts : [] }); })
      .catch(() => { if (alive) setState({ loaded: true, connected: false, accts: [] }); });
    return () => { alive = false; };
  }, []);

  const a = state.accts.find((x) => x.autotradeEnabled !== false) ?? state.accts[0];
  const last4 = a?.accNum != null ? String(a.accNum).slice(-4) : null;
  const mgmt = a ? (a.manageTrades !== false && (a.beEnabled !== false || a.partialsEnabled !== false)) : false;
  const activeN = state.accts.filter((x) => x.autotradeEnabled !== false).length;

  return (
    <article className={`${CARD} flex flex-col p-6 sm:p-7`}>
      <Illum />
      <div className="relative flex flex-col" style={{ minHeight: "100%" }}>
        <p className={MICRO}>Automated trade execution</p>
        <h3 className={`mt-2 ${H_CARD}`}>FLOW</h3>
        <p className={`mt-2 ${BODY_TXT}`}>
          Connect your trading account and allow Flow to execute qualified trade setups based on your selected settings.
        </p>

        {!state.loaded ? (
          <div className="mt-5 h-[104px] animate-pulse rounded-xl border border-white/[0.06] bg-white/[0.02]" />
        ) : state.connected ? (
          <div className="mt-5 rounded-xl border border-emerald-400/20 bg-emerald-400/[0.04] p-4">
            <p className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-emerald-300">● Connected</p>
            <dl className="mt-3 space-y-2 text-[13px]">
              <div className="flex items-center justify-between gap-3">
                <dt className="text-[#6B7D9B]">Trading account</dt>
                <dd className="font-semibold text-[#DCE6F5]">{a?.name || "TradeLocker"}{last4 ? ` ••••${last4}` : ""}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-[#6B7D9B]">Risk</dt>
                <dd className="font-semibold text-[#DCE6F5]">{a?.riskPct != null ? `${a.riskPct}%` : "Default"}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-[#6B7D9B]">Mode</dt>
                <dd className="font-semibold capitalize text-[#DCE6F5]">{a?.riskMode === "aggressive" ? "Aggressive" : "Conservative"}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-[#6B7D9B]">Trade management</dt>
                <dd className={`font-semibold ${mgmt ? "text-emerald-300" : "text-[#DCE6F5]"}`}>{mgmt ? "Active" : "Off"}</dd>
              </div>
              {state.accts.length > 1 && (
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-[#6B7D9B]">Accounts</dt>
                  <dd className="font-semibold text-[#DCE6F5]">{activeN} of {state.accts.length} trading</dd>
                </div>
              )}
            </dl>
          </div>
        ) : (
          <div className="mt-5 rounded-xl border border-white/[0.07] bg-white/[0.02] p-4">
            <p className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-[#FF9AA6]">○ Not connected</p>
            <p className="mt-2 text-[12.5px] leading-relaxed text-[#8FA0BC]">Connect your TradeLocker account to activate Flow.</p>
            <ol className="mt-3 space-y-1.5">
              {["Connect account", "Select risk", "Select mode", "Activate Flow"].map((s, i) => (
                <li key={s} className="flex items-center gap-2.5 text-[12px] text-[#6B7D9B]">
                  <span className="font-mono text-[10px] font-bold text-[#5E708E]">{String(i + 1).padStart(2, "0")}</span>
                  <span className="uppercase tracking-[0.1em]">{s}</span>
                </li>
              ))}
            </ol>
          </div>
        )}

        <Link href="/portal/trading?view=flow" className={CTA}>
          {state.connected ? "Manage Flow" : "Connect Flow"} <ArrowRight className={`h-3.5 w-3.5 ${CTA_ARROW}`} aria-hidden="true" />
        </Link>
      </div>
    </article>
  );
}

function GenxCard() {
  return (
    <article className={`${CARD} flex flex-col p-6 sm:p-7`}>
      <Illum x="15%" />
      <div className="relative flex flex-1 flex-col">
        <p className={MICRO}>AI gold intelligence</p>
        <h3 className={`mt-2 ${H_CARD}`}>GENX</h3>
        <p className={`mt-2 ${BODY_TXT}`}>
          Real-time XAUUSD market analysis built to help traders understand structure, levels and potential opportunities.
        </p>
        <div className="mt-5 flex flex-wrap gap-2">
          {["Market structure", "Key levels", "Trade setups"].map((c) => (
            <span key={c} className="rounded-md border border-white/[0.09] bg-white/[0.03] px-2.5 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-[#9DB2D4]">
              {c}
            </span>
          ))}
        </div>
        <Link href="/portal/genx" className={CTA}>
          Open GENX <ArrowRight className={`h-3.5 w-3.5 ${CTA_ARROW}`} aria-hidden="true" />
        </Link>
      </div>
    </article>
  );
}

function FloorCard() {
  return (
    <article className={`${CARD} p-7 sm:p-9 lg:col-span-2`}>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{ background: "radial-gradient(720px 300px at 12% -20%, rgba(93,158,224,0.16), transparent 60%), radial-gradient(500px 260px at 95% 115%, rgba(93,158,224,0.08), transparent 60%)" }}
      />
      <div className="relative flex flex-col gap-7 lg:flex-row lg:items-center lg:justify-between">
        <div className="max-w-xl">
          <p className={MICRO}>Where the community trades</p>
          <h3 className="mt-2 text-[26px] font-bold tracking-tight text-[#F2F6FC] sm:text-[30px]">THE FLOOR</h3>
          <p className={`mt-3 ${BODY_TXT}`}>
            Charts. Trading tools. Live market analysis. Live sessions. Community. Market opportunities. All in one environment.
          </p>
          <div className="mt-5 flex flex-wrap gap-x-5 gap-y-2">
            {["GENX", "FLOW", "Matty Pips", "OM AI", "Market Pulse", "Live Plays"].map((t) => (
              <span key={t} className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-[#5E708E]">{t}</span>
            ))}
          </div>
        </div>
        <Link
          href="/portal/trading"
          className="group inline-flex flex-shrink-0 items-center gap-2.5 self-start rounded-none border border-[#8FC6FF]/40 bg-[#8FC6FF]/[0.08] px-8 py-4 text-[12.5px] font-bold uppercase tracking-[0.16em] text-[#BFE0FF] transition-colors hover:bg-[#8FC6FF]/[0.16] lg:self-center"
        >
          Enter The Floor
          <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
        </Link>
      </div>
    </article>
  );
}

function TradingDesk() {
  return (
    <section>
      <SectionHead label="01 · Trading technology" title="Your Trading Desk" sub="The core One Mission trading stack — each tool opens in its full environment." />
      <div className="grid gap-4 lg:grid-cols-2">
        <FloorCard />
        <FlowCard />
        <GenxCard />
      </div>
    </section>
  );
}

/* ───────────────────────────── AI TOOLKIT ─────────────────────────── */
const TOOLKIT = [
  { href: "/portal/om-ai", icon: Sparkles, name: "OM AI", tag: "AI market assistant", desc: "Your AI market assistant — ask anything about any market.", cta: "Ask OM AI" },
  { href: "/portal/signals", icon: Zap, name: "OM AI PLAYS", tag: "AI opportunities", desc: "Discover AI-powered market opportunities, built play by play.", cta: "Explore plays" },
  { href: "/portal/xaughost", icon: Ghost, name: "MFXGHOST", tag: "Deep instrument desk", desc: "Additional trading intelligence and full-plan market setups.", cta: "Open MFXGHOST" },
  { href: "/portal/trading?view=pulse", icon: Activity, name: "MARKET PULSE", tag: "Conditions & sentiment", desc: "Understand current market conditions and sentiment at a glance.", cta: "View Market Pulse" },
];

function AiToolkit() {
  return (
    <section>
      <SectionHead label="02 · Intelligence suite" title="AI Toolkit" sub="A connected suite of One Mission AI trading technology." />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {TOOLKIT.map((t) => {
          const Icon = t.icon;
          return (
            <Link key={t.href} href={t.href} className={`${CARD} group flex flex-col p-5 transition-transform hover:-translate-y-0.5 sm:p-6`}>
              <Illum />
              <div className="relative flex flex-1 flex-col">
                <span className="grid h-10 w-10 place-items-center rounded-xl border border-white/[0.09] bg-white/[0.03] text-[#8FC6FF]" aria-hidden="true">
                  <Icon className="h-5 w-5" />
                </span>
                <p className={`mt-4 ${MICRO}`}>{t.tag}</p>
                <h3 className="mt-1 text-[15px] font-bold tracking-tight text-[#EDF2FA]">{t.name}</h3>
                <p className="mt-1.5 text-[12.5px] leading-relaxed text-[#8FA0BC]">{t.desc}</p>
                <span className={CTA}>{t.cta} <ArrowRight className={`h-3.5 w-3.5 ${CTA_ARROW}`} aria-hidden="true" /></span>
              </div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

/* ─────────────────────────── YOUR PROGRESS ────────────────────────── */
function MissionProgress({ side }: { side: Side }) {
  const [g, setG] = useState<{ xp: number; streak: number } | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("/api/game", { cache: "no-store" }).then((r) => r.json())
      .then((d) => { if (alive && d && typeof d.xp === "number") setG({ xp: d.xp, streak: d.streak ?? 0 }); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const xp = g?.xp ?? 0;
  const tiers = TIERS[side];
  let level = 0;
  for (let i = 0; i < TIER_XP.length && i < tiers.length; i++) if (xp >= TIER_XP[i]) level = i;
  const name = tiers[level];
  const next = level + 1 < tiers.length ? tiers[level + 1] : null;
  const nextAt = level + 1 < TIER_XP.length ? TIER_XP[level + 1] : null;
  const toNext = nextAt != null ? Math.max(0, nextAt - xp) : 0;
  const base = TIER_XP[level] ?? 0;
  const pct = nextAt != null ? Math.min(100, Math.round(((xp - base) / Math.max(1, nextAt - base)) * 100)) : 100;

  return (
    <section>
      <SectionHead label="03 · Personal development" title="Your Progress" sub="Master the markets. Master yourself." />
      <div className={`${CARD} p-6 sm:p-7`}>
        <Illum x="8%" />
        <div className="relative grid gap-6 lg:grid-cols-[1fr_auto] lg:items-center">
          <div>
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <h3 className="text-[22px] font-bold uppercase tracking-tight text-[#F2F6FC]">{g ? name : "—"}</h3>
              <span className={MICRO}>Level {level + 1}</span>
              <span className={MICRO}>{g ? `${xp.toLocaleString()} XP` : ""}</span>
              {g && g.streak > 0 && <span className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-amber-300/90">{g.streak}-day streak</span>}
            </div>
            <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-white/[0.07]">
              <div className="h-full rounded-full bg-gradient-to-r from-[#4C8FE0] to-[#8FC6FF] transition-[width] duration-700" style={{ width: `${g ? pct : 0}%` }} />
            </div>
            {g && next && (
              <p className="mt-2 font-mono text-[10.5px] uppercase tracking-[0.14em] text-[#5E708E]">
                {toNext.toLocaleString()} XP to {next}
              </p>
            )}
          </div>
          <Link href="/portal/start-here" className="group inline-flex items-center gap-2 self-start rounded-none border border-white/[0.14] px-6 py-3 text-[12px] font-bold uppercase tracking-[0.16em] text-[#DCE6F5] transition-colors hover:bg-white/[0.06]">
            Continue The One <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
          </Link>
        </div>
      </div>
      <div className="mt-4">
        <DailyEngagement side={side} />
      </div>
    </section>
  );
}

/* ───────────────────────────── COMMUNITY ──────────────────────────── */
function CommunitySection({ sessions }: { sessions: SessionRow[] }) {
  return (
    <section>
      <SectionHead label="04 · The community" title="Trade With People Behind You" sub="Serious technology, and a real room of people using it with you." />
      <div className="grid gap-4 lg:grid-cols-3">
        <Link href="/portal/leadership" className={`${CARD} group flex flex-col p-6 transition-transform hover:-translate-y-0.5`}>
          <Illum />
          <div className="relative flex flex-1 flex-col">
            <Users2 className="h-5 w-5 text-[#8FC6FF]" aria-hidden="true" />
            <h3 className="mt-3 text-[15px] font-bold text-[#EDF2FA]">THE INNER CIRCLE</h3>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-[#8FA0BC]">The leaders and featured traders — learn from the ones ahead.</p>
            <span className={CTA}>Meet the circle <ArrowRight className={`h-3.5 w-3.5 ${CTA_ARROW}`} aria-hidden="true" /></span>
          </div>
        </Link>

        <div className={`${CARD} p-6 lg:col-span-2`}>
          <Illum x="90%" />
          <div className="relative">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <CalendarClock className="h-5 w-5 text-[#8FC6FF]" aria-hidden="true" />
                <h3 className="text-[15px] font-bold text-[#EDF2FA]">LIVE SESSIONS</h3>
              </div>
              <Link href="/portal/schedule" className="font-mono text-[10.5px] font-bold uppercase tracking-[0.16em] text-[#8FC6FF] hover:text-[#BFE0FF]">Full schedule →</Link>
            </div>
            <div className="mt-4 space-y-2.5">
              {sessions.length === 0 ? (
                <p className="text-[12.5px] text-[#6B7D9B]">No upcoming sessions at your tier right now — check the schedule for replays.</p>
              ) : (
                sessions.slice(0, 3).map((s) => (
                  <div key={s.id} className="flex items-center justify-between gap-4 rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-[13.5px] font-semibold text-[#DCE6F5]">{s.title}</p>
                      <p className="mt-0.5 font-mono text-[10.5px] uppercase tracking-[0.1em] text-[#5E708E]">{fmtDateTime(s.starts_at)}{s.host ? ` · ${s.host}` : ""}</p>
                    </div>
                    {s.join_url && (
                      <a href={s.join_url} target="_blank" rel="noopener noreferrer" className="flex-shrink-0 rounded-none bg-[#EDF2FA] px-4 py-2 text-[11px] font-bold uppercase tracking-[0.14em] text-[#0B0E14] hover:bg-[#8FC6FF]">Join</a>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
      <div className="mt-4">
        <WinsWall />
      </div>
    </section>
  );
}

/* ────────────────────────── BUILD THE MISSION ─────────────────────── */
function BuildSection({ updates }: { updates: UpdateRow[] }) {
  const switchToBuilders = () => {
    try {
      localStorage.setItem("portal_side", "builders");
      window.dispatchEvent(new CustomEvent("portal-side", { detail: "builders" }));
      window.scrollTo({ top: 0 });
    } catch { /* ignore */ }
  };
  const tiles = [
    { href: "/portal/training", icon: GraduationCap, name: "BUSINESS TRAINING", desc: "The Affiliate Academy — your build roadmap." },
    { href: "/portal/resources", icon: FolderOpen, name: "RESOURCES", desc: "Tools and assets for building One Mission." },
    { href: "/portal/leaderboard", icon: Medal, name: "RECOGNITION", desc: "Leaderboard, ranks and community wins." },
  ];
  return (
    <section>
      <SectionHead label="05 · The opportunity" title="Build The Mission" sub="An additional opportunity available inside the same ecosystem." />
      <div className="grid gap-4 lg:grid-cols-3">
        <button onClick={switchToBuilders} className={`${CARD} group flex flex-col p-6 text-left transition-transform hover:-translate-y-0.5`}>
          <Illum />
          <div className="relative flex flex-1 flex-col">
            <Hammer className="h-5 w-5 text-[#8FC6FF]" aria-hidden="true" />
            <h3 className="mt-3 text-[15px] font-bold text-[#EDF2FA]">THE BUILDERS</h3>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-[#8FA0BC]">Switch to the builder side of the portal — team, pipeline and the comp plan.</p>
            <span className={CTA}>Open the builder side <ArrowRight className={`h-3.5 w-3.5 ${CTA_ARROW}`} aria-hidden="true" /></span>
          </div>
        </button>

        <div className={`${CARD} p-6 lg:col-span-2`}>
          <Illum x="90%" />
          <div className="relative">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <Megaphone className="h-5 w-5 text-[#8FC6FF]" aria-hidden="true" />
                <h3 className="text-[15px] font-bold text-[#EDF2FA]">MISSION UPDATES</h3>
              </div>
              <Link href="/portal/updates" className="font-mono text-[10.5px] font-bold uppercase tracking-[0.16em] text-[#8FC6FF] hover:text-[#BFE0FF]">View all →</Link>
            </div>
            <div className="mt-4 space-y-2.5">
              {updates.length === 0 ? (
                <p className="text-[12.5px] text-[#6B7D9B]">No updates yet.</p>
              ) : (
                updates.slice(0, 2).map((u) => (
                  <div key={u.id} className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3">
                    <p className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-[#5E708E]">{u.category || "Update"} · {fmtDateTime(u.created_at)}</p>
                    <p className="mt-1 text-[13.5px] font-semibold text-[#DCE6F5]">{u.title}</p>
                    <p className="mt-0.5 line-clamp-2 text-[12.5px] leading-relaxed text-[#8FA0BC]">{u.body}</p>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ─────────────────────────── ROOT SWITCH ──────────────────────────── */
export function DeskDashboard({ firstName, sessions, updates }: { firstName: string; sessions: SessionRow[]; updates: UpdateRow[] }) {
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

  // The Builders keep their existing hub untouched (plus the original updates +
  // sessions lists that used to render below it on the old dashboard).
  if (side === "builders") {
    return (
      <div className="space-y-10">
        <PathHub firstName={firstName} />
        <section>
          <div className="flex items-center justify-between">
            <h2 className="font-serif text-base font-semibold uppercase tracking-[0.14em] text-navy">Latest Updates</h2>
            <Link href="/portal/updates" className="text-[12px] font-medium uppercase tracking-[0.12em] text-primary hover:text-medium">View all</Link>
          </div>
          <div className="mt-4 space-y-3">
            {updates.length === 0 ? (
              <p className="rounded-xl border border-[#E7E4DD] bg-offwhite/60 p-4 text-sm text-charcoal/60">No updates yet.</p>
            ) : (
              updates.map((u) => (
                <article key={u.id} className="rounded-2xl border border-[#E7E4DD] bg-white p-5 shadow-card">
                  <div className="flex items-center gap-2">
                    <span className="rounded-full bg-ice px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-navy">{u.category}</span>
                    <span className="text-xs text-medium">{fmtDateTime(u.created_at)}</span>
                  </div>
                  <h3 className="mt-2 font-bold text-navy">{u.title}</h3>
                  <p className="mt-1 text-sm leading-relaxed text-charcoal/70">{u.body}</p>
                </article>
              ))
            )}
          </div>
        </section>
        <section>
          <div className="flex items-center justify-between">
            <h2 className="font-serif text-base font-semibold uppercase tracking-[0.14em] text-navy">Upcoming Live Sessions</h2>
            <Link href="/portal/live" className="text-[12px] font-medium uppercase tracking-[0.12em] text-primary hover:text-medium">Full schedule</Link>
          </div>
          <div className="mt-4 space-y-3">
            {sessions.length === 0 ? (
              <p className="rounded-xl border border-[#E7E4DD] bg-offwhite/60 p-4 text-sm text-charcoal/60">No upcoming sessions available at your tier right now.</p>
            ) : (
              sessions.map((s) => (
                <article key={s.id} className="flex items-center justify-between gap-4 rounded-2xl border border-[#E7E4DD] bg-white p-5 shadow-card">
                  <div>
                    <h3 className="font-bold text-navy">{s.title}</h3>
                    <p className="mt-0.5 text-xs text-medium">{fmtDateTime(s.starts_at)}{s.host ? ` · ${s.host}` : ""}</p>
                  </div>
                  {s.join_url && (
                    <a href={s.join_url} target="_blank" rel="noopener noreferrer" className="flex-shrink-0 rounded-none bg-primary px-5 py-2.5 text-[12px] font-medium uppercase tracking-[0.12em] text-white hover:bg-black">Join</a>
                  )}
                </article>
              ))
            )}
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="space-y-12">
      <DeskHero firstName={firstName} />
      <DeskResults />
      <TradingDesk />
      <AiToolkit />
      <MissionProgress side="ones" />
      <CommunitySection sessions={sessions} />
      <BuildSection updates={updates} />
    </div>
  );
}
