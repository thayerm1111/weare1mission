"use client";

/**
 * GENX Market Flow Map — the premium visual layer under a GENX signal.
 *
 * This is a VISUALIZATION layer only. Every price (entry, stop, TP1/2/3,
 * support, resistance, invalidation, current price) and every state (action,
 * bias, structure, confidence, pressure, projected path) comes straight from
 * the GENX analysis response — nothing is manufactured here. "Ghost" projected
 * candles and structure labels are visual derivations of the engine's real
 * projected_path / real candles; they are clearly marked as projection, never
 * shown as confirmed history.
 */
import { useMemo, useState } from "react";
import { HelpCircle } from "lucide-react";

type Candle = { t: string; o: number; h: number; l: number; c: number };
type PathPt = { label: string; price: number | null; kind: string };
type Genx = {
  action: string; directional_bias: string; market_structure: string; market_regime: string;
  momentum: string; session: string; confidence_score: number;
  entry: number | null; entry_low: number | null; entry_high: number | null;
  stop_loss: number | null; tp1: number | null; tp2: number | null; tp3: number | null;
  stop_pips: number | null; tp1_pips: number | null; tp2_pips: number | null; tp3_pips: number | null;
  closest_support: number | null; closest_resistance: number | null;
  invalidation_price: number | null; invalidation_reason: string; trigger_condition: string;
  buyer_control: number; seller_control: number;
  projected_path: PathPt[]; trade_reasoning: string[];
  trigger_tf: string; context_tf: string;
};

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const BULL = "#2ee88f", BEAR = "#ff5d6c", GOLD = "#ffc24b", MUTE = "#8b94a7";

function sideOf(a: string): "buy" | "sell" | "wait" {
  if (a.startsWith("BUY") || a.includes("BUY")) return "buy";
  if (a.startsWith("SELL") || a.includes("SELL")) return "sell";
  return "wait";
}

/* ── Market Flow header: the trade thesis as a readable step sequence ──────── */
type Step = { t: string; s?: string; tone: "now" | "wait" | "buy" | "sell" | "muted" };
function buildSteps(g: Genx, price: number | null): Step[] {
  const side = sideOf(g.action);
  const p = (v: number | null) => (v != null ? `$${fmtPrice(v)}` : undefined);
  const now: Step = { t: "NOW", s: price != null ? `$${fmtPrice(price)}` : undefined, tone: "now" };
  const t1: Step | null = g.tp1 != null ? { t: "TP1", s: p(g.tp1), tone: side === "sell" ? "sell" : "buy" } : null;
  const t2: Step | null = g.tp2 != null ? { t: "TP2", s: p(g.tp2), tone: side === "sell" ? "sell" : "buy" } : null;
  const watch = g.closest_support ?? g.entry ?? null;
  const watchR = g.closest_resistance ?? g.entry ?? null;
  const enter: Step = { t: "ENTER", s: g.entry_low != null && g.entry_high != null ? `$${fmtPrice(g.entry_low)}` : p(g.entry), tone: side === "sell" ? "sell" : "buy" };

  if (g.action === "WAIT_FOR_BUY_TRIGGER") {
    return [now, { t: "PULLBACK", tone: "muted" }, { t: "WATCH", s: p(watch), tone: "wait" }, { t: "CONFIRM BUYERS", tone: "wait" }, enter, ...(t1 ? [t1] : []), ...(t2 ? [t2] : [])];
  }
  if (g.action === "WAIT_FOR_SELL_TRIGGER") {
    return [now, { t: "RALLY", tone: "muted" }, { t: "WATCH", s: p(watchR), tone: "wait" }, { t: "CONFIRM SELLERS", tone: "wait" }, { ...enter }, ...(t1 ? [t1] : []), ...(t2 ? [t2] : [])];
  }
  if (side === "buy" || side === "sell") {
    return [now, enter, ...(t1 ? [t1] : []), ...(t2 ? [t2] : []), ...(g.tp3 != null ? [{ t: "TP3", s: p(g.tp3), tone: side === "sell" ? "sell" : "buy" } as Step] : [])];
  }
  // No clean trade / neutral wait
  return [now, { t: g.market_regime ? g.market_regime.toUpperCase() : "RANGE", tone: "muted" }, { t: "WAIT FOR BREAK", tone: "wait" }, ...(watchR != null ? [{ t: "WATCH", s: p(watchR), tone: "wait" } as Step] : [])];
}

function toneClass(t: Step["tone"]): string {
  switch (t) {
    case "now": return "text-white";
    case "buy": return "text-emerald-300";
    case "sell": return "text-red-300";
    case "wait": return "text-amber-300";
    default: return "text-white/45";
  }
}

function MarketFlowHeader({ g, price }: { g: Genx; price: number | null }) {
  const steps = buildSteps(g, price);
  return (
    <div className="-mx-1 flex items-stretch gap-1 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {steps.map((s, i) => (
        <div key={i} className="flex items-center gap-1">
          <div className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-center whitespace-nowrap">
            <p className={`text-[11px] font-bold leading-tight ${toneClass(s.tone)}`}>{s.t}</p>
            {s.s && <p className="text-[10px] leading-tight text-white/45 tabular-nums">{s.s}</p>}
          </div>
          {i < steps.length - 1 && <span className="text-white/25">→</span>}
        </div>
      ))}
    </div>
  );
}

/* ── the SVG Market Flow Map ───────────────────────────────────────────────── */
function fmtPrice(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function FlowMap({ candles, g, price, live }: { candles: Candle[]; g: Genx; price: number | null; live: boolean }) {
  const cs = (candles || []).filter((c) => num(c.o) != null && num(c.h) != null && num(c.l) != null && num(c.c) != null).slice(-70);
  const side = sideOf(g.action);
  const dir = side === "buy" ? BULL : side === "sell" ? BEAR : GOLD;

  const raw = (g.projected_path || []).filter((p) => num(p.price) != null).map((p) => ({ label: p.label, price: p.price as number }));
  const nowPrice = price ?? (cs.length ? cs[cs.length - 1].c : raw[0]?.price ?? 0);
  const seq = raw.length && /now/i.test(raw[0].label) ? raw : [{ label: "Now", price: nowPrice }, ...raw];

  const W = 1000, H = 452, padT = 30, padB = 34, padL = 14, gutterW = 104;
  const plotR = W - gutterW;
  const splitX = Math.round(padL + (plotR - padL) * 0.54);

  const levels = [g.entry, g.entry_low, g.entry_high, g.stop_loss, g.tp1, g.tp2, g.tp3, g.closest_support, g.closest_resistance, g.invalidation_price, price]
    .map(num).filter((n): n is number => n != null);
  const prices = [...cs.flatMap((c) => [c.h, c.l]), ...seq.map((s) => s.price), ...levels];
  const min = Math.min(...prices), max = Math.max(...prices);
  const pad = ((max - min) || 1) * 0.07;
  const lo = min - pad, hi = max + pad, sp = (hi - lo) || 1;
  const y = (p: number) => padT + (1 - (p - lo) / sp) * (H - padT - padB);

  const n = cs.length;
  const cw = n ? (splitX - padL - 8) / n : 8;
  const bodyW = Math.max(2.5, Math.min(11, cw * 0.62));

  // Projection x + interpolation
  const projStart = splitX, projEnd = plotR - 10, pn = seq.length;
  const spx = (i: number) => projStart + (pn > 1 ? (i / (pn - 1)) * (projEnd - projStart) : 0);
  const interp = (f: number) => {
    const t = f * (pn - 1), i = Math.min(pn - 2, Math.max(0, Math.floor(t))), fr = t - i;
    return pn > 1 ? seq[i].price + (seq[i + 1].price - seq[i].price) * fr : seq[0].price;
  };
  // Ghost candles that trace the thesis (visual only)
  const GC = Math.min(13, Math.max(7, pn * 2));
  const ghost = useMemo(() => {
    const out: { x: number; open: number; close: number; up: boolean; hi: number; lo: number }[] = [];
    let prev = interp(0);
    for (let k = 1; k <= GC; k++) {
      const f = k / GC, p = interp(f), up = p >= prev;
      const wig = Math.abs(Math.sin(k * 1.7)) * (hi - lo) * 0.012;
      const x = projStart + f * (projEnd - projStart);
      out.push({ x, open: prev, close: p, up, hi: Math.max(p, prev) + wig + (hi - lo) * 0.008, lo: Math.min(p, prev) - wig * 0.6 - (hi - lo) * 0.004 });
      prev = p;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [g.action, seq.length, hi, lo]);
  const gcw = Math.max(3, ((projEnd - projStart) / GC) * 0.55);

  const traj = seq.map((s, i) => `${spx(i)},${y(s.price)}`).join(" ");

  // Pivot structure labels (derived from real candles) — minimal.
  const pivots: { x: number; y: number; tag: string; low: boolean }[] = [];
  {
    const win = 2; let lastHigh: number | null = null, lastLow: number | null = null; const picks: typeof pivots = [];
    for (let i = win; i < cs.length - win; i++) {
      const c = cs[i]; let isHigh = true, isLow = true;
      for (let j = i - win; j <= i + win; j++) { if (cs[j].h > c.h) isHigh = false; if (cs[j].l < c.l) isLow = false; }
      const x = padL + 2 + i * cw + cw / 2;
      if (isHigh) { const tag = lastHigh != null ? (c.h >= lastHigh ? "HH" : "LH") : "HH"; lastHigh = c.h; picks.push({ x, y: y(c.h) - 8, tag, low: false }); }
      else if (isLow) { const tag = lastLow != null ? (c.l >= lastLow ? "HL" : "LL") : "HL"; lastLow = c.l; picks.push({ x, y: y(c.l) + 14, tag, low: true }); }
    }
    pivots.push(...picks.slice(-4));
  }

  // Zones
  const eLow = num(g.entry_low), eHigh = num(g.entry_high), eMid = num(g.entry);
  const entryTop = eHigh ?? (eMid != null ? eMid + (hi - lo) * 0.01 : null);
  const entryBot = eLow ?? (eMid != null ? eMid - (hi - lo) * 0.01 : null);
  const stop = num(g.stop_loss) ?? num(g.invalidation_price);
  const zoneColor = side === "buy" ? BULL : side === "sell" ? BEAR : GOLD;
  const isWait = g.action.startsWith("WAIT");

  const targets = [
    { p: num(g.tp1), pips: num(g.tp1_pips), lbl: "TP1" },
    { p: num(g.tp2), pips: num(g.tp2_pips), lbl: "TP2" },
    { p: num(g.tp3), pips: num(g.tp3_pips), lbl: "TP3" },
  ].filter((t) => t.p != null);
  const tgtY = declutter(targets.map((t) => y(t.p as number)), 15, padT + 6, H - padB - 6);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ minHeight: 300 }} preserveAspectRatio="xMidYMid meet" role="img" aria-label="GENX market flow map">
      <defs>
        <filter id="gxglow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="3.2" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
        <linearGradient id="gxproj" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor={dir} stopOpacity="0.18" /><stop offset="1" stopColor={dir} stopOpacity="0" /></linearGradient>
      </defs>

      {/* projection backdrop */}
      <rect x={splitX} y={padT} width={plotR - splitX} height={H - padT - padB} fill="url(#gxproj)" opacity={0.5} />

      {/* target bands + right badges */}
      {targets.map((t, i) => (
        <g key={`tg${i}`}>
          <line x1={padL} x2={plotR} y1={y(t.p as number)} y2={y(t.p as number)} stroke={BULL} strokeWidth={1} strokeDasharray="1 7" opacity={0.28} />
          <rect x={splitX} y={y(t.p as number) - 6} width={plotR - splitX} height={12} fill={BULL} opacity={0.05} />
          <line x1={plotR} x2={plotR + 8} y1={y(t.p as number)} y2={tgtY[i]} stroke={BULL} strokeWidth={1} opacity={0.35} />
          <rect x={plotR + 10} y={tgtY[i] - 10} width={gutterW - 14} height={20} rx={4} fill="#0e2a1e" stroke={BULL} strokeOpacity={0.35} />
          <text x={plotR + 16} y={tgtY[i] - 1} fill={BULL} fontSize={10} fontWeight={700}>{t.lbl} {fmtPrice(t.p as number)}</text>
          {t.pips != null && <text x={plotR + 16} y={tgtY[i] + 9} fill="#9fe9c6" fontSize={8.5}>+{t.pips}p</text>}
        </g>
      ))}

      {/* entry / reaction zone */}
      {entryTop != null && entryBot != null && (
        <g>
          <rect x={splitX} y={y(entryTop)} width={plotR - splitX} height={Math.max(6, y(entryBot) - y(entryTop))} fill={zoneColor} opacity={isWait ? 0.1 : 0.16} />
          <rect x={splitX} y={y(entryTop)} width={plotR - splitX} height={Math.max(6, y(entryBot) - y(entryTop))} fill="none" stroke={zoneColor} strokeOpacity={0.45} strokeDasharray="4 4" />
          <line x1={padL} x2={splitX} y1={y((entryTop + entryBot) / 2)} y2={y((entryTop + entryBot) / 2)} stroke={zoneColor} strokeWidth={1} strokeDasharray="2 6" opacity={0.2} />
          <text x={splitX + 6} y={y(entryTop) - 4} fill={zoneColor} fontSize={9.5} fontWeight={700}>
            {isWait ? (side === "sell" ? "SELL REACTION ZONE" : "BUY REACTION ZONE") : "ENTRY"} {eLow != null && eHigh != null ? `${fmtPrice(eLow)}–${fmtPrice(eHigh)}` : eMid != null ? fmtPrice(eMid) : ""}
          </text>
          {isWait && <text x={splitX + 6} y={y(entryBot) + 12} fill={zoneColor} fontSize={8.5} opacity={0.85}>{side === "sell" ? "BEARISH CONFIRMATION REQUIRED" : "WAIT FOR CONFIRMATION"}</text>}
        </g>
      )}

      {/* invalidation band */}
      {stop != null && (
        <g>
          <rect x={splitX} y={Math.min(y(stop), H - padB - 16)} width={plotR - splitX} height={16} fill={BEAR} opacity={0.12} />
          <line x1={padL} x2={plotR} y1={y(stop)} y2={y(stop)} stroke={BEAR} strokeWidth={1} strokeDasharray="4 4" opacity={0.45} />
          <text x={splitX + 6} y={y(stop) + 12} fill={BEAR} fontSize={9} fontWeight={700}>INVALIDATION {fmtPrice(stop)}</text>
        </g>
      )}

      {/* real candles */}
      {cs.map((c, i) => {
        const x = padL + 2 + i * cw + cw / 2;
        const up = c.c >= c.o, col = up ? BULL : BEAR;
        const yo = y(c.o), yc = y(c.c);
        return (
          <g key={i}>
            <line x1={x} x2={x} y1={y(c.h)} y2={y(c.l)} stroke={col} strokeWidth={1} opacity={0.6} />
            <rect x={x - bodyW / 2} y={Math.min(yo, yc)} width={bodyW} height={Math.max(1, Math.abs(yc - yo))} rx={0.7} fill={col} opacity={0.92} />
          </g>
        );
      })}

      {/* structure labels */}
      {pivots.map((p, i) => (
        <text key={`pv${i}`} x={p.x} y={p.y} fill={MUTE} fontSize={8.5} fontWeight={700} textAnchor="middle" opacity={0.7}>{p.tag}</text>
      ))}

      {/* ghost / projected candles */}
      {ghost.map((c, i) => {
        const col = c.up ? BULL : BEAR;
        const yo = y(c.open), yc = y(c.close);
        return (
          <g key={`gc${i}`} opacity={0}>
            <animate attributeName="opacity" from="0" to="1" dur="0.42s" begin={`${0.25 + i * 0.05}s`} fill="freeze" />
            <line x1={c.x} x2={c.x} y1={y(c.hi)} y2={y(c.lo)} stroke={col} strokeWidth={1} opacity={0.32} />
            <rect x={c.x - gcw / 2} y={Math.min(yo, yc)} width={gcw} height={Math.max(1.5, Math.abs(yc - yo))} rx={0.7} fill={col} opacity={0.26} stroke={col} strokeOpacity={0.4} />
          </g>
        );
      })}

      {/* projected trajectory (glow + animated dotted draw) */}
      {seq.length > 1 && (
        <>
          <polyline points={traj} fill="none" stroke={dir} strokeWidth={4} opacity={0.28} filter="url(#gxglow)" />
          <polyline points={traj} fill="none" stroke={dir} strokeWidth={2.2} strokeDasharray="1" strokeDashoffset="1" pathLength={1} strokeLinecap="round">
            <animate attributeName="stroke-dashoffset" from="1" to="0" dur="1.15s" begin="0.15s" fill="freeze" />
          </polyline>
        </>
      )}
      {seq.map((s, i) => {
        if (i === 0) return null;
        const anchor: "start" | "middle" | "end" = i === seq.length - 1 ? "end" : "middle";
        return (
          <g key={`sp${i}`} opacity={0}>
            <animate attributeName="opacity" from="0" to="1" dur="0.4s" begin={`${0.5 + i * 0.12}s`} fill="freeze" />
            <circle cx={spx(i)} cy={y(s.price)} r={3.5} fill={dir} />
            <text x={i === seq.length - 1 ? spx(i) - 4 : spx(i)} y={y(s.price) - 9} fill={dir} fontSize={9.5} fontWeight={700} textAnchor={anchor}>{s.label}</text>
          </g>
        );
      })}

      {/* NOW divider + current price line + right badge */}
      <line x1={splitX} x2={splitX} y1={padT - 4} y2={H - padB} stroke="#ffffff" strokeWidth={1} strokeDasharray="2 5" opacity={0.16} />
      <rect x={splitX - 22} y={padT - 20} width={44} height={16} rx={4} fill={GOLD} />
      <text x={splitX} y={padT - 8} fill="#1a1204" fontSize={9.5} fontWeight={800} textAnchor="middle">NOW</text>
      {price != null && (
        <g>
          <line x1={padL} x2={plotR} y1={y(price)} y2={y(price)} stroke="#ffffff" strokeWidth={1} strokeDasharray="1 4" opacity={0.28} />
          <rect x={plotR + 10} y={y(price) - 11} width={gutterW - 14} height={22} rx={5} fill="#1a1204" stroke={GOLD} strokeOpacity={0.6} />
          <text x={plotR + 16} y={y(price) + 4} fill={GOLD} fontSize={11} fontWeight={800}>${fmtPrice(price)}</text>
          {live && <><circle cx={plotR + gutterW - 12} cy={y(price)} r={3} fill={BULL}><animate attributeName="opacity" values="1;0.3;1" dur="1.6s" repeatCount="indefinite" /></circle></>}
        </g>
      )}
    </svg>
  );
}

/** Order-preserving vertical de-collision for right-edge labels. */
function declutter(ys: number[], gap: number, top: number, bottom: number): number[] {
  const out = ys.slice(), order = ys.map((_, i) => i).sort((a, b) => ys[a] - ys[b]);
  let prev = -Infinity;
  for (const i of order) { const v = Math.max(ys[i], prev + gap); out[i] = v; prev = v; }
  const over = out[order[order.length - 1]] - bottom; if (over > 0) for (const i of order) out[i] -= over;
  const under = top - out[order[0]]; if (under > 0) for (const i of order) out[i] += under;
  return out;
}

/* ── pressure + context strip ─────────────────────────────────────────────── */
function PressureRow({ g }: { g: Genx }) {
  const b = num(g.buyer_control) ?? 0, s = num(g.seller_control) ?? 0;
  const tot = b + s;
  const pct = tot > 0 ? (b / tot) * 100 : 50;
  const biasTxt = g.directional_bias === "bullish" ? "Bullish" : g.directional_bias === "bearish" ? "Bearish" : "Neutral";
  const biasCls = g.directional_bias === "bullish" ? "text-emerald-300" : g.directional_bias === "bearish" ? "text-red-300" : "text-amber-300";
  const tf = [g.trigger_tf, g.context_tf].filter(Boolean).join(" · ");
  return (
    <div className="mt-3 grid gap-2.5 sm:grid-cols-[1.4fr_1fr]">
      <div className="rounded-xl border border-white/10 bg-white/[0.02] px-3.5 py-2.5">
        <div className="flex items-center justify-between text-[9.5px] uppercase tracking-wide text-white/40">
          <span>Selling pressure</span><span>Buying pressure</span>
        </div>
        <div className="relative mt-1.5 h-2 rounded-full" style={{ background: "linear-gradient(90deg,#ff5d6c33,#ffc24b33,#2ee88f33)" }}>
          <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${pct}%`, background: "linear-gradient(90deg,#ff5d6c66,#2ee88f88)" }} />
          <div className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[#0b0d14] bg-white shadow" style={{ left: `${pct}%` }} />
        </div>
        {tot > 0 && <p className="mt-1 text-[10px] text-white/45 tabular-nums">Buyers {Math.round(pct)}% · Sellers {Math.round(100 - pct)}%</p>}
      </div>
      <div className="grid grid-cols-3 gap-2 text-center">
        <div className="rounded-xl border border-white/10 bg-white/[0.02] px-2 py-2"><p className="text-[9px] uppercase tracking-wide text-white/40">Bias</p><p className={`text-[13px] font-bold ${biasCls}`}>{biasTxt}</p></div>
        <div className="rounded-xl border border-white/10 bg-white/[0.02] px-2 py-2"><p className="text-[9px] uppercase tracking-wide text-white/40">Momentum</p><p className="text-[13px] font-bold text-white/85 capitalize">{g.momentum || "—"}</p></div>
        <div className="rounded-xl border border-white/10 bg-white/[0.02] px-2 py-2"><p className="text-[9px] uppercase tracking-wide text-white/40">Session</p><p className="text-[13px] font-bold text-white/85">{g.session || "—"}{tf ? "" : ""}</p></div>
      </div>
    </div>
  );
}

/* ── bottom context tiles ─────────────────────────────────────────────────── */
function FlowTiles({ g }: { g: Genx }) {
  const side = sideOf(g.action);
  const tiles: { k: string; v: string; sub?: string; tone?: string }[] = [
    { k: "Trend", v: g.directional_bias === "bullish" ? "Bullish" : g.directional_bias === "bearish" ? "Bearish" : "Neutral", sub: g.market_structure, tone: g.directional_bias === "bullish" ? "text-emerald-300" : g.directional_bias === "bearish" ? "text-red-300" : "text-amber-300" },
    { k: "Right now", v: g.market_regime || g.momentum || "—", sub: "Live read" },
    { k: "GENX wants", v: g.trigger_condition ? shortStr(g.trigger_condition) : (side === "buy" ? "Enter now" : "Setup forming"), sub: "Trigger", tone: "text-amber-300" },
    { k: "Invalidation", v: g.stop_loss != null ? fmtPrice(g.stop_loss) : "—", sub: g.invalidation_reason ? shortStr(g.invalidation_reason) : "Setup is off", tone: "text-red-300" },
    { k: "Targets", v: [g.tp1, g.tp2].filter((x) => x != null).map((x) => fmtPrice(x as number)).join(" · ") || "—", sub: [g.tp1_pips, g.tp2_pips].filter((x) => x != null).map((x) => `+${x}p`).join(" · "), tone: "text-emerald-300" },
  ];
  return (
    <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
      {tiles.map((t, i) => (
        <div key={i} className="rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2.5">
          <p className="text-[9.5px] uppercase tracking-wide text-white/40">{t.k}</p>
          <p className={`mt-0.5 text-[14px] font-bold leading-tight ${t.tone || "text-white/90"}`}>{t.v}</p>
          {t.sub && <p className="mt-0.5 text-[10px] leading-tight text-white/40">{t.sub}</p>}
        </div>
      ))}
    </div>
  );
}
function shortStr(s: string): string { return s.length > 34 ? s.slice(0, 32).trimEnd() + "…" : s; }

/* ── the exported experience ──────────────────────────────────────────────── */
export function GenxFlow({ candles, g, price, live }: { candles: Candle[]; g: Genx; price: number | null; live: boolean }) {
  const [why, setWhy] = useState(false);
  const rr = useMemo(() => {
    const risk = num(g.stop_pips);
    const r2 = num(g.tp2_pips) ?? num(g.tp1_pips);
    return risk && r2 ? (r2 / risk).toFixed(1) : null;
  }, [g.stop_pips, g.tp1_pips, g.tp2_pips]);
  const reasons = (g.trade_reasoning || []).slice(0, 5);

  return (
    <section className="mt-5 rounded-2xl border border-white/10 bg-black/40 p-3.5 sm:p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-white/40">Market Flow</p>
        {rr && <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2.5 py-0.5 text-[11px] font-bold text-amber-200">R:R 1:{rr}</span>}
      </div>

      <MarketFlowHeader g={g} price={price} />

      <div className="relative mt-2">
        <FlowMap candles={candles} g={g} price={price} live={live} />
        <div className="pointer-events-none absolute left-2 top-1 flex items-center gap-2">
          <span className="rounded-md bg-white/[0.06] px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-white/45">GENX projected path</span>
          {reasons.length > 0 && (
            <button onClick={() => setWhy((v) => !v)} className="pointer-events-auto inline-flex items-center gap-1 rounded-md border border-amber-400/25 bg-amber-400/10 px-2 py-0.5 text-[9.5px] font-semibold text-amber-200 hover:bg-amber-400/20">
              <HelpCircle className="h-3 w-3" /> WHY?
            </button>
          )}
        </div>
      </div>

      {why && reasons.length > 0 && (
        <div className="mt-2 rounded-xl border border-amber-400/20 bg-amber-400/[0.05] px-3.5 py-3">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-amber-300/80">Why this path</p>
          <ul className="mt-1.5 space-y-1 text-[12.5px] text-white/75">
            {reasons.map((r, i) => <li key={i} className="flex gap-2"><span className="text-amber-400">›</span>{r}</li>)}
          </ul>
        </div>
      )}

      <PressureRow g={g} />
      <FlowTiles g={g} />
    </section>
  );
}
