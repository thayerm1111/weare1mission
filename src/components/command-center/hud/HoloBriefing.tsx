"use client";
import { useMemo } from "react";
import { H, fmt2 } from "./theme";
import { Gauge } from "./Gauge";
import { BrainOrb } from "./BrainOrb";
import { StructureViz, pivotsOf } from "./StructureViz";
import { GoldChart, type ChartBar, type ChartLine, type ChartZone } from "./GoldChart";
import { priceWords, moveWords, speakNumbers } from "@/lib/spokenNumbers";

/**
 * ATLAS'S HOLOGRAPHIC BRIEFING (owner 09-21).
 *
 * "After the initial breakdown, bring up a 3D breakdown of the 3 data screenshots — potential trades,
 * market structure, current market conditions. Like you see in movies where it pulls that info to the
 * front of the screen and then puts it back and then pulls up the next data piece."
 *
 * Three live panels sit on a curved shelf deep in the room. As ATLAS talks about each one it flies
 * forward, materialises, gets called out, then is pushed back while the next comes forward:
 *
 *   1 STRUCTURE    the swing map (HH/LH/HL/LL), trend, sequence, phase, where liquidity sits
 *   2 CONDITIONS   seller / buyer pressure, volatility, momentum
 *   3 THE CHART    15-minute candles, support and resistance zones, and the potential trades
 *
 * Every figure comes from the same live read the desk shows. Nothing is a forecast or a promise: the
 * potential trades are the scenarios and setup the engine is watching, worded as such.
 */

export type BriefData = {
  price?: number | null;
  bars?: ChartBar[];
  thesis?: { label?: string; confidence?: number } | null;
  setup?: { state?: string; side?: string | null; entryLow?: number | null; entryHigh?: number | null; stop?: number | null; initialObjective?: number | null; waitingFor?: string[]; metCount?: number; totalCount?: number } | null;
  intel?: {
    structure?: { trend?: string; sequence?: string; phase?: string; nextWatched?: number | null } | null;
    pressure?: { buyers: number; sellers: number; buyerLabel?: string; sellerLabel?: string } | null;
    volatility?: { atr?: number | null; label?: string; band?: string } | null;
    momentum?: { value?: number | null; label?: string; tone?: string } | null;
    liquidity?: { above?: { price: number; label: string }[]; below?: { price: number; label: string }[]; aboveZone?: [number, number] | null; belowZone?: [number, number] | null } | null;
    scenarios?: { kind: string; title: string; detail: string; rank: string }[];
  } | null;
};

function aggregate(bars: ChartBar[], minutes: number): ChartBar[] {
  const ms = minutes * 60_000, out: ChartBar[] = [];
  for (const b of bars) {
    const k = Math.floor(b.t / ms) * ms, last = out[out.length - 1];
    if (last && last.t === k) { last.h = Math.max(last.h, b.h); last.l = Math.min(last.l, b.l); last.c = b.c; }
    else out.push({ t: k, o: b.o, h: b.h, l: b.l, c: b.c });
  }
  return out;
}
const shortLabel = (l: string) => l.split("·")[0].replace(/\([^)]*\)/g, "").trim();
const zoneOf = (list: { price: number }[] | undefined, n = 3): [number, number] | null => {
  const ps = (list ?? []).slice(0, n).map((x) => x.price).filter(Number.isFinite);
  return ps.length ? [Math.min(...ps), Math.max(...ps)] : null;
};

export type BriefSeg = { key: "structure" | "conditions" | "chart"; say: string; show: string };

/** The narration for each panel — what ATLAS says (spoken form) and the caption (digits). */
export function briefingScript(d: BriefData | null): BriefSeg[] {
  if (!d || typeof d.price !== "number") return [];
  const I = d.intel ?? {};
  const out: BriefSeg[] = [];
  const bars15 = aggregate((d.bars ?? []) as ChartBar[], 15);
  const piv = pivotsOf(bars15, 2, 5);

  // 1 — structure
  const st = I.structure ?? {};
  const trend = String(st.trend ?? "").toLowerCase();
  const lastH = [...piv].reverse().find((p) => p.kind === "H");
  const lastL = [...piv].reverse().find((p) => p.kind === "L");
  const seqWord = /LH_LL|lower/i.test(String(st.sequence ?? "")) ? "lower highs and lower lows" : /HH_HL|higher/i.test(String(st.sequence ?? "")) ? "higher highs and higher lows" : "mixed swings";
  {
    const say = [`Let's break it down. Structure first.`,
      `On the fifteen-minute, gold is in ${trend.includes("down") ? "a downtrend" : trend.includes("up") ? "an uptrend" : "a range"}, printing ${seqWord}.`,
      lastH && lastL ? `The last swing high was ${priceWords(lastH.price)}, the last swing low ${priceWords(lastL.price)}.` : "",
      st.phase ? `Phase: ${String(st.phase).toLowerCase()}.` : ""].filter(Boolean).join(" ");
    const show = [`Structure · 15m: ${st.trend ?? "—"}, ${seqWord}.`, lastH && lastL ? `Last swing high ${fmt2(lastH.price)}, swing low ${fmt2(lastL.price)}.` : "", st.phase ? `Phase: ${st.phase}.` : ""].filter(Boolean).join(" ");
    out.push({ key: "structure", say, show });
  }

  // 2 — conditions
  const p = I.pressure, v = I.volatility, m = I.momentum;
  if (p || v || m) {
    const edge = p ? (p.sellers >= 60 ? "sellers are dominant" : p.sellers > 52 ? "sellers have the edge" : p.buyers >= 60 ? "buyers are dominant" : p.buyers > 52 ? "buyers have the edge" : "it's balanced") : "";
    const say = [`Current conditions.`,
      p ? `Seller pressure ${p.sellers}, buyers ${p.buyers}, so ${edge}.` : "",
      v?.atr != null ? `Volatility is ${String(v.label ?? "normal").toLowerCase()}, about ${moveWords(v.atr)} a candle on the fifteen-minute.` : "",
      m?.label ? `Momentum reads ${String(m.label).toLowerCase()}.` : ""].filter(Boolean).join(" ");
    const show = [p ? `Sellers ${p.sellers} · Buyers ${p.buyers} — ${edge}.` : "", v?.atr != null ? `Volatility ${v.label ?? ""} · 15m ATR ${v.atr.toFixed(1)}.` : "", m?.label ? `Momentum ${m.label}${m.value != null ? ` (${m.value.toFixed(2)})` : ""}.` : ""].filter(Boolean).join(" ");
    out.push({ key: "conditions", say: speakNumbers(say), show });
  }

  // 3 — chart + potential trades
  {
    const L = I.liquidity ?? {};
    const res = L.aboveZone ?? zoneOf(L.above), sup = L.belowZone ?? zoneOf(L.below);
    const sc = (I.scenarios ?? []).slice(0, 2);
    const su = d.setup;
    const parts: string[] = [`Now the chart.`];
    const shows: string[] = [];
    if (res) { parts.push(`Resistance overhead from ${priceWords(res[0])} to ${priceWords(res[1])}.`); shows.push(`Resistance ${fmt2(res[0])}–${fmt2(res[1])}.`); }
    if (sup) { parts.push(`Support underneath from ${priceWords(sup[1])} down to ${priceWords(sup[0])}.`); shows.push(`Support ${fmt2(sup[0])}–${fmt2(sup[1])}.`); }
    if (su?.side && su.entryHigh != null && su.stop != null && (su.state === "armed" || su.state === "ready" || su.state === "developing")) {
      parts.push(`The potential trade I'm tracking is a ${su.side} near ${priceWords(su.entryHigh)}, stop ${priceWords(su.stop)}${su.initialObjective != null ? `, first objective ${priceWords(su.initialObjective)}` : ""}${su.totalCount ? `, ${su.metCount} of ${su.totalCount} conditions met` : ""}.`);
      shows.push(`Potential ${su.side.toUpperCase()} ~${fmt2(su.entryHigh)} · stop ${fmt2(su.stop)}${su.initialObjective != null ? ` · objective ${fmt2(su.initialObjective)}` : ""}.`);
    } else if (sc.length) {
      parts.push(`Potential trades: the main scenario is ${sc[0].title.toLowerCase()}, ${speakNumbers(sc[0].detail.replace(/→/g, "toward").replace(/–/g, "to"))}.`);
      shows.push(`${sc[0].rank}: ${sc[0].title} — ${sc[0].detail}.`);
      if (sc[1]) { parts.push(`The alternative is ${sc[1].title.toLowerCase()}, ${speakNumbers(sc[1].detail.replace(/→/g, "toward").replace(/–/g, "to"))}.`); shows.push(`${sc[1].rank}: ${sc[1].title} — ${sc[1].detail}.`); }
    }
    if (!su?.side && su?.waitingFor?.[0]) { parts.push(`Nothing is ready yet. I'm waiting for ${speakNumbers(su.waitingFor[0])}.`); shows.push(`Waiting for ${su.waitingFor[0]}.`); }
    parts.push("None of this is guaranteed, it's what I'm watching.");
    out.push({ key: "chart", say: speakNumbers(parts.join(" ")), show: shows.join(" ") });
  }
  return out;
}

/* ── the stage ──────────────────────────────────────────────────────────────── */

const SLOT = [
  { x: -34, rot: 38 },   // shelf left
  { x: 0, rot: 0 },      // shelf centre
  { x: 34, rot: -38 },   // shelf right
];

/**
 * `active` = which panel is forward (0–2), -1 = all on the shelf (arriving), 3 = all leaving.
 * `level` = ATLAS's voice level (0–1) for the pulse on the active panel.
 */
export function HoloBriefing({ d, active, caption, phone, level }: { d: BriefData | null; active: number; caption: string; phone: boolean; level: number }) {
  const bars15 = useMemo(() => aggregate((d?.bars ?? []) as ChartBar[], 15).slice(-64), [d]);
  const piv = useMemo(() => pivotsOf(bars15, 2, 5), [bars15]);
  const I = d?.intel ?? {};
  const bearish = /down/i.test(I.structure?.trend ?? "");
  const L = I.liquidity ?? {};
  const res = L.aboveZone ?? zoneOf(L.above), sup = L.belowZone ?? zoneOf(L.below);
  const zones: ChartZone[] = [];
  if (res) zones.push({ from: res[0], to: res[1], tone: "supply", label: `Resistance ${fmt2(res[0])} – ${fmt2(res[1])}` });
  if (sup) zones.push({ from: sup[0], to: sup[1], tone: "demand", label: `Support ${fmt2(sup[0])} – ${fmt2(sup[1])}` });
  const lines: ChartLine[] = [];
  const su = d?.setup;
  if (su?.side && su.entryHigh != null && su.stop != null) {
    lines.push({ price: su.entryHigh, label: `Potential ${su.side.toUpperCase()}`, color: H.blue });
    lines.push({ price: su.stop, label: "Stop", color: H.red });
    if (su.initialObjective != null) lines.push({ price: su.initialObjective, label: "Objective", color: H.green });
  }
  if (I.structure?.nextWatched != null) lines.push({ price: I.structure.nextWatched, label: "ATLAS watch", color: H.gold2, dashed: true });

  const p = I.pressure, v = I.volatility, m = I.momentum;
  const W: number | string = phone ? 340 : "min(880px, 62vw)", Ht: number | string = phone ? 380 : "min(560px, 64vh)";

  const panels = [
    { key: "structure", title: "MARKET STRUCTURE", tag: I.structure?.trend?.toUpperCase() ?? "", tagColor: bearish ? H.red : H.green, body: (
      <div className="flex h-full flex-col">
        <div className="min-h-0 flex-1"><StructureViz pivots={piv} price={d?.price ?? null} bearish={bearish} /></div>
        <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
          {[["Trend", I.structure?.trend], ["Sequence", I.structure?.sequence?.replace("_", " / ")], ["Phase", I.structure?.phase], ["Next watched", I.structure?.nextWatched != null ? fmt2(I.structure.nextWatched) : "—"],
            ["Liquidity above", res ? `${fmt2(res[0])} – ${fmt2(res[1])}` : "—"], ["Liquidity below", sup ? `${fmt2(sup[0])} – ${fmt2(sup[1])}` : "—"]].map(([k, val]) => (
            <div key={k} className="flex justify-between gap-2 border-b py-0.5" style={{ borderColor: H.lineSoft }}><span style={{ color: H.mut }}>{k}</span><span className="text-right font-semibold tabular-nums">{val ?? "—"}</span></div>
          ))}
        </div>
      </div>
    ) },
    { key: "conditions", title: "MARKET CONDITIONS", tag: p ? (p.sellers > p.buyers ? "SELLERS IN CONTROL" : p.buyers > p.sellers ? "BUYERS IN CONTROL" : "BALANCED") : "", tagColor: p && p.sellers > p.buyers ? H.red : H.green, body: (
      <div className="grid h-full grid-cols-2 gap-2.5">
        <Gauge title="SELLER PRESSURE" display={p ? `${p.sellers}` : "—"} sub={p?.sellerLabel ?? "—"} value01={p ? p.sellers / 100 : null} color={H.red} />
        <Gauge title="BUYER PRESSURE" display={p ? `${p.buyers}` : "—"} sub={p?.buyerLabel ?? "—"} value01={p ? p.buyers / 100 : null} color={H.green} />
        <Gauge title="VOLATILITY" display={v?.atr != null ? v.atr.toFixed(1) : "—"} sub={`${v?.label ?? "—"} · 15m ATR`} value01={v?.band === "expanding" ? 0.8 : v?.band === "quiet" ? 0.25 : 0.5} color={H.gold2} />
        <Gauge title="MOMENTUM" display={m?.value != null ? `${m.value > 0 ? "+" : ""}${m.value.toFixed(2)}` : "—"} sub={m?.label ?? "—"} value01={m?.value != null ? (m.value + 3) / 6 : null} color={m?.tone === "down" ? H.red : m?.tone === "up" ? H.green : H.gold2} />
      </div>
    ) },
    { key: "chart", title: "XAUUSD · 15M · POTENTIAL TRADES", tag: su?.side ? `${su.side.toUpperCase()} SETUP` : "WATCHING", tagColor: H.gold2, body: (
      <div className="flex h-full flex-col gap-2">
        <div className="min-h-0 flex-1 overflow-hidden rounded-md">
          <GoldChart bars={bars15} price={d?.price ?? null} markers={[]} zones={zones} lines={lines} path={null} pathLabel="" showOverlays showLiquidity={false} tfLabel="XAUUSD · 15m" activityLabel="" />
        </div>
        <div className="grid gap-1 text-[10.5px]">
          {(I.scenarios ?? []).slice(0, 3).map((s) => (
            <div key={s.title} className="flex items-center justify-between gap-2 rounded px-2 py-1" style={{ background: "rgba(7,16,26,.8)", border: `1px solid ${s.rank === "PRIMARY" ? "rgba(231,196,103,.5)" : H.line}` }}>
              <span className="font-semibold" style={{ color: s.kind === "bear" ? H.red : s.kind === "bull" ? H.green : H.gold2 }}>{s.rank} · {s.title}</span>
              <span className="text-right tabular-nums" style={{ color: H.text }}>{shortLabel(s.detail)}</span>
            </div>
          ))}
        </div>
      </div>
    ) },
  ];

  return (
    <div className="pointer-events-none absolute inset-0 z-[5]" style={{ perspective: phone ? 900 : 1400, perspectiveOrigin: "50% 42%" }}>
      <style>{HOLO_CSS}</style>
      {/* ATLAS, up top, projecting the active panel */}
      <div className="hb-orb absolute left-1/2 top-[1.5%] -translate-x-1/2" style={{ opacity: active >= 3 ? 0 : 1, transition: "opacity .6s" }}>
        <BrainOrb state="speaking" intensity={60} alive size={phone ? 70 : 96} voice={{ mode: "speaking", level }} />
      </div>
      {active >= 0 && active < 3 && <div key={`beam${active}`} className="hb-beam" />}
      {panels.map((pn, i) => {
        const forward = i === active;
        const leaving = active >= 3;
        const s = SLOT[i];
        // on the shelf: small, deep, turned; forward: full size at the front
        const tf = forward
          ? `translate3d(-50%, -50%, 0) rotateY(0deg) rotateX(0deg) scale(1)`
          : leaving
          ? `translate3d(calc(-50% + ${s.x * 2.4}vw), -120%, -1400px) rotateY(${s.rot}deg) rotateX(20deg) scale(.6)`
          : `translate3d(calc(-50% + ${s.x * (phone ? 0.9 : 1)}vw), calc(-50% + ${phone ? 30 : 26}vh), -900px) rotateY(${s.rot}deg) rotateX(12deg) scale(.55)`;
        return (
          <div key={pn.key} className={`hb-panel ${forward ? "hb-forward" : ""}`}
            style={{ width: W, height: Ht, transform: tf, opacity: leaving ? 0 : forward ? 1 : 0.42, zIndex: forward ? 5 : 1,
              boxShadow: forward ? `0 0 ${40 + level * 60}px rgba(39,215,242,${0.25 + level * 0.3}), inset 0 0 40px rgba(39,215,242,.08)` : "0 0 18px rgba(39,215,242,.12)" }}>
            <span className="hb-c hb-tl" /><span className="hb-c hb-tr" /><span className="hb-c hb-bl" /><span className="hb-c hb-br" />
            {forward && <div key={`scan${active}`} className="hb-materialise" />}
            <div className="flex items-center justify-between gap-2 px-3.5 pt-3">
              <p className="font-mono text-[10.5px] font-bold tracking-[0.22em]" style={{ color: H.cyan2 }}>{`0${i + 1} // `}<span style={{ color: H.text }}>{pn.title}</span></p>
              <p className="text-[10px] font-bold tracking-[0.16em]" style={{ color: pn.tagColor }}>{pn.tag}</p>
            </div>
            <div className="h-[calc(100%-38px)] px-3.5 pb-3 pt-2">{pn.body}</div>
          </div>
        );
      })}
      {/* live caption: what ATLAS is reading off the active panel */}
      {caption && active >= 0 && active < 3 && (
        <div key={`cap${active}`} className="hb-caption absolute inset-x-0 bottom-[6%] mx-auto w-[min(92vw,720px)] rounded-lg px-4 py-2.5 text-[12.5px] leading-snug sm:text-[14px]"
          style={{ background: "rgba(3,9,15,.82)", border: "1px solid rgba(39,215,242,.35)", color: "#DDE6EE" }}>
          <span className="mr-2 font-mono text-[10px] tracking-[0.2em]" style={{ color: H.gold2 }}>ATLAS ▸</span>{caption}
        </div>
      )}
    </div>
  );
}

const HOLO_CSS = `
.hb-panel{position:absolute;left:50%;top:50%;transform-style:preserve-3d;border-radius:14px;overflow:hidden;
  background:linear-gradient(180deg,rgba(9,22,34,.92),rgba(4,11,18,.9));border:1px solid rgba(39,215,242,.45);
  backdrop-filter:blur(3px);transition:transform 1.05s cubic-bezier(.7,0,.18,1),opacity .8s ease,box-shadow .2s linear;color:#F0F4F7}
.hb-panel::before{content:"";position:absolute;inset:0;pointer-events:none;background:repeating-linear-gradient(0deg,rgba(39,215,242,.05) 0 1px,transparent 1px 3px);mix-blend-mode:screen}
.hb-forward{border-color:rgba(120,235,255,.8)}
.hb-c{position:absolute;width:16px;height:16px;border-color:#FFD875;z-index:3}
.hb-tl{left:6px;top:6px;border-left:2px solid;border-top:2px solid}.hb-tr{right:6px;top:6px;border-right:2px solid;border-top:2px solid}
.hb-bl{left:6px;bottom:6px;border-left:2px solid;border-bottom:2px solid}.hb-br{right:6px;bottom:6px;border-right:2px solid;border-bottom:2px solid}
.hb-materialise{position:absolute;inset:0;z-index:4;pointer-events:none;background:linear-gradient(180deg,transparent 0%,rgba(120,235,255,.0) 40%,rgba(160,245,255,.55) 50%,rgba(255,216,117,.25) 52%,transparent 60%);
  background-size:100% 220%;animation:hb-scan 1.3s .55s ease-out both}
@keyframes hb-scan{from{background-position:0 100%;opacity:1}to{background-position:0 -120%;opacity:.2}}
.hb-forward > div{animation:hb-rez .9s .45s both}
@keyframes hb-rez{0%{opacity:0;filter:blur(6px) brightness(2)}40%{opacity:.6}100%{opacity:1;filter:none}}
.hb-beam{position:absolute;left:50%;top:9%;width:2px;height:22%;transform:translateX(-50%);background:linear-gradient(180deg,rgba(255,216,117,0),rgba(120,235,255,.6));box-shadow:0 0 18px 4px rgba(39,215,242,.35);animation:hb-beam .9s ease-out both}
@keyframes hb-beam{from{opacity:0;transform:translateX(-50%) scaleY(.2)}to{opacity:.8;transform:translateX(-50%) scaleY(1)}}
.hb-orb{animation:hb-orb .8s cubic-bezier(.2,.9,.2,1) both}
@keyframes hb-orb{from{opacity:0;transform:translate(-50%,30vh) scale(2.4)}to{opacity:1;transform:translate(-50%,0) scale(1)}}
.hb-caption{animation:hb-cap .5s .6s both}
@keyframes hb-cap{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion: reduce){.hb-panel{transition-duration:.25s}.hb-materialise{display:none}}
`;
