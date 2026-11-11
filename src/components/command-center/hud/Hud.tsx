"use client";
import { useCallback, useEffect, useRef, useState, type ReactNode, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Info } from "lucide-react";
import { H, LABEL } from "./theme";

/**
 * A metric's explanation, on tap or click — what it measures, from what, and how fresh it is. Rendered into
 * document.body at a fixed position, so a panel's overflow can never clip it, and closed by Escape or a tap
 * anywhere else. Keyboard and touch work the same as a mouse: there is no hover-only information.
 */
export function InfoPop({ title, children, className = "", size = 12 }: {
  title: string; children: ReactNode; className?: string; size?: number;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; up: boolean; w: number } | null>(null);
  const btn = useRef<HTMLButtonElement | null>(null);
  const pop = useRef<HTMLDivElement | null>(null);

  const place = useCallback(() => {
    const b = btn.current;
    if (!b) return;
    const r = b.getBoundingClientRect();
    const w = Math.min(310, window.innerWidth - 16);
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2));
    const up = r.bottom + 260 > window.innerHeight && r.top > 260;
    setPos({ top: up ? r.top - 6 : r.bottom + 6, left, up, w });
  }, []);

  useEffect(() => {
    if (!open) return;
    place();
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (pop.current?.contains(t) || btn.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, place]);

  return (
    <>
      <button ref={btn} type="button" aria-label={`About: ${title}`} aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        onPointerDown={(e) => e.stopPropagation()}
        className={`inline-grid shrink-0 place-items-center rounded-full align-middle transition hover:brightness-150 ${className}`}
        style={{ color: open ? H.cyan2 : H.mut, width: size + 4, height: size + 4 }}>
        <Info style={{ width: size, height: size }} />
      </button>
      {open && pos && typeof document !== "undefined" && createPortal(
        <div ref={pop} role="dialog" aria-label={title} className="hud-in" data-infopop=""
          style={{
            position: "fixed", left: pos.left, width: pos.w, zIndex: 95,
            ...(pos.up ? { bottom: window.innerHeight - pos.top } : { top: pos.top }),
            background: `linear-gradient(180deg, ${H.panel2}, ${H.panel})`, border: `1px solid ${H.lineHi}`,
            borderRadius: 10, padding: "10px 12px", boxShadow: "0 16px 40px rgba(0,0,0,0.6)", color: H.text,
            fontFamily: "Inter, var(--font-inter), system-ui, sans-serif", textAlign: "left",
          }}>
          <p className="text-[9.5px] font-bold uppercase tracking-[0.16em]" style={{ color: H.gold3 }}>{title}</p>
          <div className="mt-1.5 space-y-1.5 text-[11.5px] leading-snug" style={{ color: "#C9D3DB" }}>{children}</div>
        </div>,
        document.body,
      )}
    </>
  );
}

/** A HUD panel: near-black navy, 1px blue-steel edge, a faint inner light. `hi` lifts the edge to cyan. */
export function HudPanel({ children, className = "", style, hi = false, title, icon, right, bodyClass = "", tour }: {
  children?: ReactNode; className?: string; style?: CSSProperties; hi?: boolean;
  title?: string; icon?: ReactNode; right?: ReactNode; bodyClass?: string;
  /** Anchor id for the guided walkthrough (HudTour). Purely additive: renders as data-tour. */
  tour?: string;
}) {
  return (
    <section
      data-tour={tour}
      className={`hud-panel relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[10px] ${className}`}
      style={{
        background: `linear-gradient(180deg, ${H.panel2} 0%, ${H.panel} 100%)`,
        border: `1px solid ${hi ? H.lineHi : H.line}`,
        boxShadow: hi
          ? `inset 0 1px 0 rgba(255,255,255,0.03), 0 0 0 1px rgba(0,199,232,0.05), 0 0 22px rgba(0,199,232,0.06)`
          : `inset 0 1px 0 rgba(255,255,255,0.025)`,
        ...style,
      }}
    >
      {title && (
        <header className="flex shrink-0 items-center justify-between gap-2 px-3 pb-1 pt-2">
          <p className={`inline-flex shrink-0 items-center gap-2 whitespace-nowrap ${LABEL}`} style={{ color: H.text, letterSpacing: "0.13em", fontSize: 10 }}>
            {icon && <span style={{ color: H.gold2 }}>{icon}</span>}
            {title}
          </p>
          <span className="shrink-0">{right}</span>
        </header>
      )}
      <div className={`relative min-h-0 flex-1 ${bodyClass}`}>{children}</div>
    </section>
  );
}

/** A tiny line of real values (never decoration: with fewer than two values it draws nothing). */
export function Sparkline({ values, color, w = 130, h = 34 }: { values: number[]; color: string; w?: number; h?: number }) {
  if (values.length < 2) return <span style={{ width: w, height: h }} className="shrink-0" />;
  const lo = Math.min(...values), hi = Math.max(...values);
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - 2 - ((v - lo) / (hi - lo || 1)) * (h - 4)}`).join(" ");
  return (
    <svg width={w} height={h} className="shrink-0" aria-hidden>
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.3} style={{ filter: `drop-shadow(0 0 3px ${color})` }} />
    </svg>
  );
}

export function LiveDot({ color = H.green, size = 6 }: { color?: string; size?: number }) {
  return (
    <span className="relative inline-flex" style={{ width: size, height: size }}>
      <span className="hud-ping absolute inset-0 rounded-full" style={{ background: color, opacity: 0.55 }} />
      <span className="relative rounded-full" style={{ width: size, height: size, background: color, boxShadow: `0 0 6px ${color}` }} />
    </span>
  );
}

export function LivePill({ label = "LIVE", color = H.green }: { label?: string; color?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-[5px] px-2 py-[3px] text-[9px] font-bold uppercase tracking-[0.14em]"
      style={{ color, background: "rgba(41,223,166,0.07)", border: `1px solid rgba(41,223,166,0.28)` }}>
      <LiveDot color={color} size={5} />{label}
    </span>
  );
}

export function Chip({ children, active = false, onClick, tone = "gold", className = "", title }: {
  children: ReactNode; active?: boolean; onClick?: () => void; tone?: "gold" | "cyan"; className?: string; title?: string;
}) {
  const c = tone === "gold" ? H.gold2 : H.cyan2;
  return (
    <button onClick={onClick} title={title}
      className={`rounded-[5px] px-2 py-[3px] text-[9px] font-bold uppercase tracking-[0.12em] transition ${className}`}
      style={{
        color: active ? c : H.mut,
        background: active ? (tone === "gold" ? "rgba(213,169,61,0.13)" : "rgba(0,199,232,0.1)") : "transparent",
        border: `1px solid ${active ? (tone === "gold" ? "rgba(231,196,103,0.55)" : "rgba(39,215,242,0.45)") : H.line}`,
      }}>
      {children}
    </button>
  );
}

/** Global keyframes for the HUD, kept in one place so nothing animates that was not meant to. */
export const HUD_CSS = `
@keyframes hudPing { 0% { transform: scale(1); opacity: .55 } 80%,100% { transform: scale(2.6); opacity: 0 } }
.hud-ping { animation: hudPing 1.8s cubic-bezier(0,0,.2,1) infinite; }
@keyframes hudSlideIn { from { transform: translateY(-6px); opacity: 0 } to { transform: none; opacity: 1 } }
.hud-in { animation: hudSlideIn .45s cubic-bezier(.22,.9,.24,1) both; }
@keyframes hudFlashUp { 0% { color: #29DFA6; text-shadow: 0 0 14px rgba(41,223,166,.6) } 100% { } }
@keyframes hudFlashDn { 0% { color: #FF5364; text-shadow: 0 0 14px rgba(255,83,100,.6) } 100% { } }
.hud-flash-up { animation: hudFlashUp .9s ease-out; }
.hud-flash-dn { animation: hudFlashDn .9s ease-out; }
@keyframes hudSpin { to { transform: rotate(360deg) } }
@keyframes hudBar { 0%,100% { transform: scaleY(.35) } 50% { transform: scaleY(1) } }
.hud-scroll::-webkit-scrollbar { width: 4px; height: 4px }
.hud-scroll::-webkit-scrollbar-thumb { background: rgba(89,175,255,.18); border-radius: 4px }
.hud-scroll { scrollbar-width: thin; scrollbar-color: rgba(89,175,255,.18) transparent; }
@media (prefers-reduced-motion: reduce) {
  .hud-ping, .hud-in, .hud-flash-up, .hud-flash-dn { animation: none !important; }
}
`;
