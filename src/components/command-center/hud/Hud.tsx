"use client";
import type { ReactNode, CSSProperties } from "react";
import { H, LABEL } from "./theme";

/** A HUD panel: near-black navy, 1px blue-steel edge, a faint inner light. `hi` lifts the edge to cyan. */
export function HudPanel({ children, className = "", style, hi = false, title, icon, right, bodyClass = "" }: {
  children?: ReactNode; className?: string; style?: CSSProperties; hi?: boolean;
  title?: string; icon?: ReactNode; right?: ReactNode; bodyClass?: string;
}) {
  return (
    <section
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
