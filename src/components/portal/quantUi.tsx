"use client";

/**
 * Quant UI kit — the shared "trading desk" visual language used across all four
 * signal tools (Market Command, OM AI Plays, Strategy Scanner, MFXGHOST).
 * Everything here is PURELY presentational: it renders numbers the engines
 * already computed. No data is invented — a Ring shows a real score, a Sparkline
 * plots a real recent-close series, Levels shows the real entry/stop/targets.
 * Dark theme, sky-blue primary accent, to match bg-[#0a0b10] cards.
 */
import { useState } from "react";
import { Check, X, ShieldAlert, Target, Copy } from "lucide-react";

export type Tone = "sky" | "emerald" | "amber" | "red" | "violet" | "slate";

export const toneHex = (t: Tone): string =>
  t === "emerald" ? "#34d399" : t === "amber" ? "#fbbf24" : t === "red" ? "#f87171" : t === "violet" ? "#a78bfa" : t === "slate" ? "#94a3b8" : "#38bdf8";

/** A/A+ → emerald, B → sky, C → amber, D/E/F → red. */
export const gradeTone = (g?: string | null): Tone => {
  const s = String(g || "").toUpperCase();
  if (s.startsWith("A")) return "emerald";
  if (s.startsWith("B")) return "sky";
  if (s.startsWith("C")) return "amber";
  if (s.startsWith("D") || s.startsWith("E") || s.startsWith("F")) return "red";
  return "sky";
};

/** 0–100 score → tone band. */
export const scoreTone = (n?: number | null): Tone => {
  const v = typeof n === "number" ? n : 0;
  return v >= 80 ? "emerald" : v >= 65 ? "sky" : v >= 50 ? "amber" : "red";
};

/** Circular progress gauge with a value in the middle. */
export function Ring({
  value, max = 100, size = 92, stroke = 7, tone = "sky", center, sub, label,
}: {
  value: number; max?: number; size?: number; stroke?: number; tone?: Tone;
  center?: React.ReactNode; sub?: string; label?: string;
}) {
  const pct = Math.max(0, Math.min(1, (Number.isFinite(value) ? value : 0) / (max || 1)));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const dash = c * pct;
  const col = toneHex(tone);
  return (
    <div className="flex flex-col items-center">
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="-rotate-90">
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.10)" strokeWidth={stroke} />
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={col} strokeWidth={stroke} strokeLinecap="round"
            strokeDasharray={`${dash} ${c - dash}`} style={{ transition: "stroke-dasharray .6s ease" }} />
        </svg>
        <div className="absolute inset-0 grid place-items-center text-center">
          <div>
            <div className="font-serif text-2xl font-bold leading-none tabular-nums text-white">{center ?? Math.round(value)}</div>
            {sub && <div className="mt-0.5 text-[9px] uppercase tracking-[0.1em] text-white/40">{sub}</div>}
          </div>
        </div>
      </div>
      {label && <div className="mt-1.5 text-[10px] font-semibold uppercase tracking-[0.12em]" style={{ color: col }}>{label}</div>}
    </div>
  );
}

/** A letter grade inside a soft colored ring. */
export function GradeRing({ grade, size = 60 }: { grade: string; size?: number }) {
  const col = toneHex(gradeTone(grade));
  return (
    <div className="grid place-items-center rounded-full"
      style={{ width: size, height: size, border: `2px solid ${col}`, boxShadow: `0 0 0 5px ${col}1f` }}>
      <span className="font-serif font-bold leading-none" style={{ color: col, fontSize: size * 0.42 }}>{grade}</span>
    </div>
  );
}

/** Real recent-close sparkline with a soft area fill. `up` tints it. */
export function Sparkline({ data, up, w = 128, h = 40 }: { data?: number[]; up?: boolean; w?: number; h?: number }) {
  if (!data || data.length < 2) return null;
  const min = Math.min(...data), max = Math.max(...data), span = max - min || 1;
  const step = w / (data.length - 1);
  const y = (d: number) => h - ((d - min) / span) * (h - 4) - 2;
  const line = data.map((d, i) => `${(i * step).toFixed(1)},${y(d).toFixed(1)}`).join(" ");
  const col = up === true ? "#34d399" : up === false ? "#f87171" : "#38bdf8";
  const gid = `sg${Math.round(min)}${data.length}${up ? 1 : 0}`;
  return (
    <svg width={w} height={h} className="overflow-visible">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={col} stopOpacity="0.28" />
          <stop offset="100%" stopColor={col} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={`0,${h} ${line} ${w},${h}`} fill={`url(#${gid})`} />
      <polyline points={line} fill="none" stroke={col} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/** One tile in the top stat row. */
export function StatTile({ label, children, className = "" }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`flex flex-col items-center justify-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.02] px-3 py-4 text-center ${className}`}>
      <p className="text-[10px] uppercase tracking-[0.14em] text-white/40">{label}</p>
      {children}
    </div>
  );
}

export function StatRow({ children, cols = 5 }: { children: React.ReactNode; cols?: number }) {
  const c = cols >= 5 ? "sm:grid-cols-3 lg:grid-cols-5" : cols === 4 ? "sm:grid-cols-2 lg:grid-cols-4" : "sm:grid-cols-3";
  return <div className={`grid grid-cols-2 gap-2 ${c}`}>{children}</div>;
}

/** Qualification-checks strip. */
export function Checks({ items }: { items: { label: string; ok: boolean }[] }) {
  const all = items.length > 0 && items.every((i) => i.ok);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-white/10 bg-white/[0.02] px-4 py-2.5">
      {items.map((it) => (
        <span key={it.label} className={`inline-flex items-center gap-1.5 text-[12px] ${it.ok ? "text-white/75" : "text-white/35"}`}>
          {it.ok ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <X className="h-3.5 w-3.5 text-white/30" />}{it.label}
        </span>
      ))}
      <span className={`ml-auto text-[11px] font-semibold uppercase tracking-[0.1em] ${all ? "text-emerald-400" : "text-white/45"}`}>
        {all ? "All criteria met" : `${items.filter((i) => i.ok).length}/${items.length} met`}
      </span>
    </div>
  );
}

export type Level = { label: string; price: number; rr?: number };

// Instrument-appropriate precision. FX majors trade near 1.xxxxx, so 2 decimals
// collapses distinct levels into the same number (1.34965 → "1.35") — show 5.
const fmtPrice = (n: number) => {
  if (!Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1000) return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (a >= 100) return n.toFixed(2);   // JPY pairs (157.27), indices under 1000
  if (a >= 10) return n.toFixed(3);
  return n.toFixed(5);                  // FX majors, most sub-10 instruments
};

/** Trade-summary levels panel: entry / stop / R:R header, then targets, each with
 * a pip delta from entry when a pip size is supplied. */
export function Levels({
  direction, entry, stop, targets, rr, pip,
}: {
  direction?: string; entry: number; stop: number; targets: Level[]; rr?: number; pip?: number;
}) {
  const long = /long|buy/i.test(String(direction || ""));
  const delta = (p: number) => (pip && Number.isFinite(pip) && pip > 0 ? ` (${(Math.abs(p - entry) / pip).toFixed(1)})` : "");
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-3">
      <div className="grid grid-cols-3 gap-2">
        <Box label="Entry" value={fmtPrice(entry)} tint="text-white" copy={String(entry)} />
        <Box label="Stop" value={fmtPrice(stop)} delta={delta(stop)} tint="text-red-400" icon={<ShieldAlert className="h-3 w-3" />} copy={String(stop)} />
        <Box label="Risk : Reward" value={rr ? `1 : ${rr}` : "—"} tint="text-sky-300" />
      </div>
      {targets.length > 0 && (
        <div className={`mt-2 grid gap-2 ${targets.length >= 3 ? "grid-cols-3" : targets.length === 2 ? "grid-cols-2" : "grid-cols-1"}`}>
          {targets.map((t) => (
            <Box key={t.label} label={t.rr ? `${t.label} · ${t.rr}R` : t.label} value={fmtPrice(t.price)} delta={delta(t.price)}
              tint="text-emerald-400" icon={<Target className="h-3 w-3" />} copy={String(t.price)} />
          ))}
        </div>
      )}
      <p className="mt-2 px-1 text-[10px] text-white/30">{long ? "Long" : "Short"}{pip ? " · figures in parentheses are pips from entry" : ""} · tap a level to copy</p>
    </div>
  );
}

function Box({ label, value, delta, tint, icon, copy }: { label: string; value: string; delta?: string; tint: string; icon?: React.ReactNode; copy?: string }) {
  const [done, setDone] = useState(false);
  const clickable = !!copy;
  const doCopy = () => {
    if (!copy) return;
    try { void navigator.clipboard?.writeText(copy); } catch { /* ignore */ }
    setDone(true); setTimeout(() => setDone(false), 1200);
  };
  return (
    <div onClick={clickable ? doCopy : undefined} role={clickable ? "button" : undefined} tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); doCopy(); } } : undefined}
      className={`relative rounded-xl border border-white/10 bg-white/[0.02] px-2 py-2.5 text-center ${clickable ? "cursor-pointer transition hover:bg-white/[0.06] active:opacity-70" : ""}`}>
      <p className="flex items-center justify-center gap-1 text-[10px] uppercase tracking-[0.08em] text-white/40">{icon}{done ? "Copied ✓" : label}</p>
      <p className={`mt-0.5 font-serif text-base font-bold tabular-nums ${tint}`}>
        {value}{delta && <span className="ml-1 text-[10px] font-normal text-white/35">{delta}</span>}
      </p>
      {clickable && <Copy className="pointer-events-none absolute right-1.5 top-1.5 h-3 w-3 text-white/20" />}
    </div>
  );
}
