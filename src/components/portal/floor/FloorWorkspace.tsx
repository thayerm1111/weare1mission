"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { LayoutGrid, Sparkles, Zap, Activity, TrendingUp, Gem, Link2, Volume2, VolumeX, Maximize2, Minimize2 } from "lucide-react";
import { FloorHome } from "./FloorHome";
import { LivePlays } from "./LivePlays";
import { MarketPulse } from "./MarketPulse";
import { FlowDesk } from "./FlowDesk";
import { GenxDesk } from "./GenxDesk";
import { OmAiChat } from "../OmAiChat";
import { SignalGenerator } from "../SignalGenerator";

/* The Floor workspace — a dark trading-desk shell around the launcher (home) and
   the in-desk tools. Adds: a premium entry transition (with a tasteful WebAudio
   "ding"), a live market ticker, a sound toggle, and a desk (fullscreen) mode.
   The tools themselves are unchanged; light-themed tool views render inside a
   light "app window" so their styling stays intact. */

const C = { base: "#0B0F14", panel: "#111820", line: "rgba(255,255,255,0.07)", text: "#F1F5F9", mut: "rgba(241,245,249,0.55)", cyan: "#22D3EE", green: "#34D399", red: "#F87171" };

// Every desk tool renders INLINE on the Floor (as a `view`) so the whole workspace
// flows together — clicking GENX / OM AI / OM AI Plays / Market Pulse / Live Plays
// stays on the Floor exactly like FLOW, instead of navigating to a separate page.
const VIEW_TABS = [
  { id: "home", label: "Floor" },
  { id: "flow", label: "FLOW" },
  { id: "genx", label: "GENX" },
  { id: "omai", label: "OM AI" },
  { id: "signals", label: "OM AI Plays" },
  { id: "pulse", label: "Market Pulse" },
  { id: "plays", label: "Live Plays" },
] as const;
type TabId = (typeof VIEW_TABS)[number]["id"];

type SwitchItem = { key: string; label: string; icon: typeof LayoutGrid } & ({ view: string } | { href: string });
const SWITCHER: SwitchItem[] = [
  { key: "home", label: "Floor", icon: LayoutGrid, view: "home" },
  { key: "flow", label: "FLOW", icon: Link2, view: "flow" },
  { key: "genx", label: "GENX", icon: Gem, view: "genx" },
  { key: "omai", label: "OM AI", icon: Sparkles, view: "omai" },
  { key: "signals", label: "OM AI Plays", icon: Zap, view: "signals" },
  { key: "pulse", label: "Market Pulse", icon: Activity, view: "pulse" },
  { key: "plays", label: "Live Plays", icon: TrendingUp, view: "plays" },
];

/* short, tasteful desk-bell ding — synthesized (no asset to load) */
function playDing() {
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    void ctx.resume?.();
    const t0 = ctx.currentTime;
    ([[784, 0], [1175, 0.08]] as [number, number][]).forEach(([f, dt]) => {
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.type = "sine"; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0 + dt);
      g.gain.exponentialRampToValueAtTime(0.12, t0 + dt + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.34);
      o.connect(g); g.connect(ctx.destination);
      o.start(t0 + dt); o.stop(t0 + dt + 0.4);
    });
    setTimeout(() => { try { void ctx.close(); } catch { /* noop */ } }, 900);
  } catch { /* autoplay blocked — stay silent */ }
}

export function FloorWorkspace({ isCaller = false, followerCount = 0 }: { isCaller?: boolean; followerCount?: number }) {
  const router = useRouter();
  const params = useSearchParams();
  const raw = params.get("view");
  const tab: TabId = (VIEW_TABS.some((t) => t.id === raw) ? raw : "home") as TabId;

  const go = (id: string) => router.replace(id === "home" ? "/portal/trading" : `/portal/trading?view=${id}`, { scroll: false });

  const shellRef = useRef<HTMLDivElement>(null);
  const [soundOn, setSoundOn] = useState(true);
  const [showEntry, setShowEntry] = useState(false);
  const [deskMode, setDeskMode] = useState(false);

  // sound preference (default on)
  useEffect(() => {
    try { setSoundOn(localStorage.getItem("floorSound") !== "0"); } catch { /* noop */ }
  }, []);
  const toggleSound = () => setSoundOn((s) => { const n = !s; try { localStorage.setItem("floorSound", n ? "1" : "0"); } catch { /* noop */ } return n; });

  // entry transition — full once per browser session, then skipped
  useEffect(() => {
    let seen = false;
    try { seen = sessionStorage.getItem("floorEntrySeen") === "1"; } catch { /* noop */ }
    if (seen) return;
    setShowEntry(true);
    const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    let playSound = false;
    try { playSound = localStorage.getItem("floorSound") !== "0"; } catch { /* noop */ }
    if (playSound && !reduce) playDing();
    const dur = reduce ? 350 : 1100;
    const id = setTimeout(() => {
      setShowEntry(false);
      try { sessionStorage.setItem("floorEntrySeen", "1"); } catch { /* noop */ }
    }, dur);
    return () => clearTimeout(id);
  }, []);

  // desk mode via the Fullscreen API on the shell
  const toggleDesk = () => {
    const el = shellRef.current; if (!el) return;
    try {
      if (!document.fullscreenElement) void el.requestFullscreen?.();
      else void document.exitFullscreen?.();
    } catch { /* noop */ }
  };
  useEffect(() => {
    const onFs = () => setDeskMode(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  const pillCls = "inline-flex flex-shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-[12px] font-semibold transition-colors hover:bg-white/5";
  const pillStyle = (active: boolean) => (active ? { background: "rgba(34,211,238,0.14)", color: C.cyan } : { color: C.mut });

  return (
    <div ref={shellRef} className="relative overflow-hidden rounded-2xl border shadow-card" style={{ borderColor: C.line, background: C.base, color: C.text }}>
      {showEntry && <FloorEntryOverlay />}

      {/* slim terminal control bar */}
      <div className="flex items-center gap-2 border-b px-2.5 py-2" style={{ borderColor: C.line }}>
        <span className="hidden flex-shrink-0 items-center gap-1.5 pl-1 pr-2 text-[11px] font-black uppercase tracking-[0.15em] sm:inline-flex" style={{ color: C.cyan }}>◢ Floor</span>
        <div className="flex flex-1 gap-1 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {SWITCHER.map((s) => {
            const Icon = s.icon;
            if ("href" in s) return <Link key={s.key} href={s.href} className={pillCls} style={pillStyle(false)}><Icon className="h-3.5 w-3.5" aria-hidden="true" />{s.label}</Link>;
            const active = s.view === tab;
            return <button key={s.key} onClick={() => go(s.view)} className={pillCls} style={pillStyle(active)}><Icon className="h-3.5 w-3.5" aria-hidden="true" />{s.label}</button>;
          })}
        </div>
        <button onClick={toggleSound} aria-label={soundOn ? "Mute Floor sounds" : "Enable Floor sounds"} className="flex-shrink-0 rounded-lg p-1.5 transition-colors hover:bg-white/5" style={{ color: soundOn ? C.cyan : C.mut }}>
          {soundOn ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
        </button>
        <button onClick={toggleDesk} aria-label={deskMode ? "Exit desk mode" : "Desk mode"} className="flex-shrink-0 rounded-lg p-1.5 transition-colors hover:bg-white/5" style={{ color: C.mut }}>
          {deskMode ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
        </button>
      </div>

      {/* content */}
      <div className="p-2 sm:p-2.5">
        {tab === "home" && <FloorHome onGo={go} />}
        {tab !== "home" && (
          <div className="rounded-xl bg-cream p-2.5 text-charcoal sm:p-3">
            {tab === "flow" && <FlowDesk />}
            {tab === "genx" && <GenxDesk />}
            {tab === "omai" && <OmAiChat />}
            {tab === "signals" && <SignalGenerator />}
            {tab === "plays" && <LivePlays isCaller={isCaller} followerCount={followerCount} />}
            {tab === "pulse" && <MarketPulse />}
          </div>
        )}
      </div>

      {/* live market ticker */}
      <MarketTicker />
    </div>
  );
}

/* ── entry transition overlay ── */
function FloorEntryOverlay() {
  const feeds = ["MARKET FEED", "OM AI", "FLOW", "LIVE PLAYS"];
  const [live, setLive] = useState(false);
  useEffect(() => { const id = setTimeout(() => setLive(true), 420); return () => clearTimeout(id); }, []);
  return (
    <div className="fixed inset-0 z-[70] flex flex-col items-center justify-center" style={{ background: "#070A0E", animation: "floorFade 1.1s ease forwards", animationDelay: "0.55s" }}>
      <div className="pointer-events-none absolute inset-0 opacity-[0.07]" style={{ backgroundImage: `linear-gradient(${C.cyan}55 1px,transparent 1px),linear-gradient(90deg,${C.cyan}55 1px,transparent 1px)`, backgroundSize: "40px 40px" }} />
      <div className="pointer-events-none absolute inset-0 opacity-60" style={{ background: `radial-gradient(600px 300px at 50% 40%, ${C.cyan}18, transparent 70%)` }} />
      <div className="relative flex flex-col items-center" style={{ animation: "floorRise 0.5s ease" }}>
        <span className="text-[13px] font-black uppercase tracking-[0.4em]" style={{ color: C.cyan }}>OM</span>
        <h1 className="mt-2 text-4xl font-black tracking-tight sm:text-6xl" style={{ color: C.text, letterSpacing: "-0.02em" }}>THE FLOOR</h1>
        <p className="mt-2 text-[11px] font-semibold uppercase tracking-[0.3em]" style={{ color: C.mut }}>Live Trading Intelligence</p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
          {feeds.map((f, i) => (
            <span key={f} className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider" style={{ color: C.mut, animation: "floorFadeIn 0.4s ease forwards", animationDelay: `${0.15 + i * 0.1}s`, opacity: 0 }}>
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: live ? C.green : "rgba(241,245,249,0.3)", boxShadow: live ? `0 0 6px ${C.green}` : "none", transition: "all .3s" }} />
              {f} <span style={{ color: live ? C.green : "rgba(241,245,249,0.3)" }}>{live ? "LIVE" : "···"}</span>
            </span>
          ))}
        </div>
      </div>
      <style>{`@keyframes floorFade{to{opacity:0;visibility:hidden}}@keyframes floorRise{from{transform:translateY(8px);opacity:0}to{transform:translateY(0);opacity:1}}@keyframes floorFadeIn{to{opacity:1}}`}</style>
    </div>
  );
}

/* ── live market ticker (batched, cached /api/floor/ticker) ── */
type Tick = { label: string; price: number; percent: number | null; dp: number };
function MarketTicker() {
  const [ticks, setTicks] = useState<Tick[]>([]);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch("/api/floor/ticker", { cache: "no-store" });
        if (!r.ok) return;
        const j = await r.json();
        if (alive && Array.isArray(j.ticks)) setTicks(j.ticks as Tick[]);
      } catch { /* ticker degrades silently */ }
    };
    void load();
    const iv = setInterval(load, 45000);
    const onVis = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { alive = false; clearInterval(iv); document.removeEventListener("visibilitychange", onVis); };
  }, []);
  if (ticks.length === 0) return null;
  const row = [...ticks, ...ticks];
  return (
    <div className="flex items-stretch overflow-hidden border-t" style={{ borderColor: C.line, background: "#0A0E13" }}>
      <div className="flex flex-shrink-0 items-center gap-1.5 border-r px-3 text-[10px] font-bold uppercase tracking-wider" style={{ borderColor: C.line, color: C.mut }}>
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: C.cyan, boxShadow: `0 0 6px ${C.cyan}` }} /> Market
      </div>
      <div className="relative flex-1 overflow-hidden">
        <div className="flex w-max gap-7 whitespace-nowrap py-2 pl-7" style={{ animation: "floorTick 44s linear infinite" }}>
          {row.map((t, i) => {
            const up = (t.percent ?? 0) >= 0;
            return (
              <span key={i} className="inline-flex items-center gap-1.5 text-[12px]">
                <span className="font-bold" style={{ color: C.text }}>{t.label}</span>
                <span className="font-mono tabular-nums" style={{ color: C.mut }}>{t.price.toLocaleString(undefined, { minimumFractionDigits: t.dp, maximumFractionDigits: t.dp })}</span>
                {t.percent != null && <span className="font-mono tabular-nums" style={{ color: up ? C.green : C.red }}>{up ? "▲" : "▼"} {up ? "+" : ""}{t.percent.toFixed(2)}%</span>}
              </span>
            );
          })}
        </div>
      </div>
      <style>{`@keyframes floorTick{from{transform:translateX(0)}to{transform:translateX(-50%)}}`}</style>
    </div>
  );
}
