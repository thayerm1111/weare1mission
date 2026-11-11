"use client";
import { useState, type ReactNode } from "react";
import { ChevronDown, Compass, Crosshair, Zap } from "lucide-react";
import { H } from "./theme";
import { HudPanel, InfoPop } from "./Hud";
import { LEAN_LABEL, type AtlasRead, type Evidence, type EvidenceRef } from "../../../../command-center/core/atlasContract";
import { ENTRY_WORD, LEAN_TONE, SETUP_STAGE_WORD, ageShort, balanceWords } from "./hudModel";

/**
 * ATLAS'S READ — the directional read (core/read.ts), in place of the old market-pulse paragraph.
 *
 * Laid out the way the contract separates it: the LEAN and its strength first, then the evidence that built it,
 * then — boxed apart — the setup stage and the entry, because a lean is never an entry. Every piece of evidence
 * that points at something real (a level, a zone, a confirmed swing, a closed candle) is a button that shows it
 * on the chart. The balance is "evidence balance", never a probability; with too little data it is a dash.
 */
export type PointTarget = { ref?: EvidenceRef | null; price?: number | null; label: string };

const tone = (t: "green" | "red" | "cyan" | "gold" | "mut") =>
  t === "green" ? H.green : t === "red" ? H.red : t === "cyan" ? H.cyan2 : t === "gold" ? H.gold2 : H.mut;

const hhmm = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

const TREND_WORD = { up: "Up", down: "Down", range: "Range", unknown: "Unknown" } as const;
const MOM_WORD = { rising: "Rising", falling: "Falling", flat: "Flat", unknown: "Unknown" } as const;
const dirTone = (s: string) => (s === "up" || s === "rising" ? H.green : s === "down" || s === "falling" ? H.red : s === "range" || s === "flat" ? H.cyan2 : H.mut);

export function ReadCard({ read, analysisAt, analysisAgeMs, replay, onPoint, onExplain, className = "" }: {
  read: AtlasRead | null | undefined;
  /** The snapshot the read was computed from, and its age now (null in the replay: recorded time has no age). */
  analysisAt: number | null;
  analysisAgeMs: number | null;
  replay: boolean;
  onPoint: (t: PointTarget) => void;
  onExplain: () => void;
  className?: string;
}) {
  // On a stacked (phone/tablet) layout the evidence folds away behind one tap; on the desk it is always open.
  const [more, setMore] = useState(false);
  const r = read ?? null;
  const horizon = r ? `Intraday · ${r.horizonTf === "1h" ? "1h/4h" : "15m/1h"} structure` : "Intraday";
  const leanCol = r ? tone(LEAN_TONE[r.lean] ?? "mut") : H.mut;
  const fresh = analysisAt != null
    ? `Read from the snapshot of ${hhmm(analysisAt)}${replay ? " (recorded)" : analysisAgeMs != null ? ` · ${ageShort(analysisAgeMs)} old` : ""}`
    : "No snapshot yet";

  return (
    <HudPanel tour="read" title="ATLAS'S READ" icon={<Compass className="h-3.5 w-3.5" />} className={className}
      right={
        <span className="inline-flex items-center gap-1 rounded-[5px] px-1.5 py-[2px] text-[8.5px] font-semibold tracking-[0.08em]" style={{ color: H.mut, border: `1px solid ${H.lineSoft}` }}
          title="What the lean is about. Changing the chart's timeframe never turns it into a 5-minute forecast.">
          {horizon}
        </span>
      }
      bodyClass="hud-scroll flex flex-col overflow-y-auto px-3 pb-2.5 [&>*]:shrink-0">
      {!r ? (
        <p className="py-3 text-[12px]" style={{ color: H.mut }}>Waiting for ATLAS&apos;s first read of gold.</p>
      ) : (
        <>
          {/* the lean */}
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[18px] font-semibold leading-tight" style={{ color: leanCol }} data-lean={r.lean}>{LEAN_LABEL[r.lean]}</p>
            {r.strength && (
              <span className="rounded-[4px] px-1.5 py-[2px] text-[8.5px] font-bold tracking-[0.14em]"
                style={{ color: leanCol, border: `1px solid ${leanCol}73`, background: `${leanCol}14` }}>{r.strength.toUpperCase()}</span>
            )}
            <span className="ml-auto text-[10px] tabular-nums" style={{ color: H.mut }} title={`This lean began at ${new Date(r.since).toLocaleString()}`}>since {hhmm(r.since)}</span>
          </div>
          {r.previous && (
            <p className="mt-0.5 line-clamp-2 text-[10.5px] leading-snug" style={{ color: H.mut }} title={r.previous.reason || undefined}>
              Was <b style={{ color: tone(LEAN_TONE[r.previous.lean] ?? "mut"), fontWeight: 600 }}>{LEAN_LABEL[r.previous.lean]}</b> until {hhmm(r.previous.until)}
              {r.previous.reason ? <> — {r.previous.reason}</> : null}
            </p>
          )}
          <p className="mt-1.5 text-[12px] leading-[1.5]" style={{ color: "#D3DDE5" }}>{r.summary}</p>

          {/* context: the bigger trend and the immediate push */}
          <div className="mt-2 grid grid-cols-2 gap-1.5">
            <Fact k={`Higher-TF trend · ${r.htfTrend.tf}`} v={TREND_WORD[r.htfTrend.state]} col={dirTone(r.htfTrend.state)} title={r.htfTrend.text} />
            <Fact k={`Momentum · ${r.momentum.tf}`} v={MOM_WORD[r.momentum.state]} col={dirTone(r.momentum.state)} title={r.momentum.text} />
          </div>

          {/* the trade status — boxed apart, because a lean is never an entry */}
          <div className="mt-1.5 rounded-[7px] px-2 py-1" style={{ border: `1px dashed ${H.line}`, background: "rgba(3,7,11,0.45)" }} data-box="trade-status"
            title="The setup stage and the entry come from the setup engine alone. No lean, however strong, confirms an entry.">
            <p className="text-[8px] font-bold uppercase tracking-[0.14em]" style={{ color: H.mut2 }}>Trade status — a lean is not an entry</p>
            <div className="mt-0.5 grid grid-cols-2 gap-1.5">
              <Fact k="Setup stage" v={SETUP_STAGE_WORD[r.setupStage]} col={r.setupStage === "ready" || r.setupStage === "in_trade" ? H.gold3 : r.setupStage === "none" ? H.mut : H.text} bare />
              <Fact k="Entry" v={ENTRY_WORD[r.entry]} col={r.entry === "confirmed" ? H.gold3 : r.entry === "none" ? H.mut : H.text} bare />
            </div>
          </div>

          {/* the evidence: folded on a phone, open on the desk */}
          <button type="button" onClick={() => setMore((x) => !x)} className="mt-2 inline-flex items-center gap-1 self-start text-[9.5px] font-bold uppercase tracking-[0.12em] xl:hidden"
            style={{ color: H.gold2 }} aria-expanded={more}>
            Evidence · {r.evidenceFor.length} for · {r.evidenceAgainst.length} against
            <ChevronDown className="h-3 w-3" style={{ transform: more ? "rotate(180deg)" : "none" }} />
          </button>
          <div className={more ? "" : "max-xl:hidden"}>
            <EvidenceList title="For" items={r.evidenceFor} sign="+" col={H.green} onPoint={onPoint} />
            <EvidenceList title="Against" items={r.evidenceAgainst} sign="−" col={H.red} onPoint={onPoint} />
          </div>

          {r.nextWatch && (
            <Line label="Next" col={H.cyan2}>
              <Pointable text={r.nextWatch.text} target={r.nextWatch.ref ? { ref: r.nextWatch.ref, label: "ATLAS is watching" } : null} onPoint={onPoint} />
            </Line>
          )}
          {r.invalidation && (
            <Line label="Wrong if" col={H.red}>
              <Pointable text={r.invalidation.text}
                target={r.invalidation.ref ? { ref: r.invalidation.ref, label: "Invalidation" } : r.invalidation.price != null ? { price: r.invalidation.price, label: "Invalidation" } : null}
                onPoint={onPoint} />
            </Line>
          )}

          {/* the balance — a measure of agreement, not a chance of anything */}
          <div className="mt-auto pt-2">
            <div className="flex items-center gap-2">
              <span className="text-[9px] font-semibold uppercase tracking-[0.12em]" style={{ color: H.mut }}>Evidence balance</span>
              <b className="text-[12px] tabular-nums" style={{ color: r.lean === "insufficient_data" ? H.mut : r.score > 0 ? H.green : r.score < 0 ? H.red : H.text }} data-balance="">
                {balanceWords(r.score, r.lean)}
              </b>
              <BalanceBar score={r.lean === "insufficient_data" ? null : r.score} />
              <InfoPop title="Evidence balance">
                <p>The signed sum of the evidence weights above, from −100 (all bearish) to +100 (all bullish): how much the evidence agrees, and on which side.</p>
                <p><b style={{ color: H.gold3 }}>It is not a probability</b> of a move or of a trade winning.</p>
                <p>A lean needs the balance to clear a threshold on two consecutive closed 5-minute readings, so noise cannot flip it; only a decisive close changes it at once. With too little clean data it shows “—”.</p>
                <p style={{ color: H.mut }}>Freshness: {fresh}.</p>
              </InfoPop>
            </div>
            <div className="mt-1.5 flex items-center justify-between gap-2">
              <button onClick={onExplain}
                className="inline-flex items-center gap-1.5 rounded-[5px] px-2 py-[3px] text-[9px] font-bold tracking-[0.12em]"
                style={{ color: H.gold2, border: "1px solid rgba(231,196,103,0.45)" }}><Zap className="h-3 w-3" />EXPLAIN FURTHER</button>
              <span className="truncate text-[9.5px] tabular-nums" style={{ color: H.mut }} title={`Engine ${r.version}${r.snapshotId != null ? ` · snapshot #${r.snapshotId}` : ""}`}>{fresh}</span>
            </div>
          </div>
        </>
      )}
    </HudPanel>
  );
}

function Fact({ k, v, col, title, bare = false }: { k: string; v: string; col: string; title?: string; bare?: boolean }) {
  return (
    <div className={`min-w-0 rounded-[6px] ${bare ? "py-0.5" : "px-2 py-[3px]"}`} title={title} style={bare ? undefined : { border: `1px solid ${H.lineSoft}`, background: "rgba(3,7,11,0.35)" }}>
      <p className="truncate text-[8.5px] font-semibold uppercase tracking-[0.1em]" style={{ color: H.mut }}>{k}</p>
      <p className="truncate text-[11.5px] font-semibold leading-tight" style={{ color: col }}>{v}</p>
    </div>
  );
}

function EvidenceList({ title, items, sign, col, onPoint }: { title: string; items: Evidence[]; sign: string; col: string; onPoint: (t: PointTarget) => void }) {
  const top = [...items].sort((a, b) => b.weight - a.weight).slice(0, 3);
  return (
    <div className="mt-2">
      <p className="text-[8.5px] font-bold uppercase tracking-[0.14em]" style={{ color: col }}>
        Evidence {title.toLowerCase()} <span style={{ color: H.mut2 }}>· {items.length ? `top ${top.length} of ${items.length}` : "none"}</span>
      </p>
      {top.length ? (
        <ul className="mt-0.5 space-y-[3px]">
          {top.map((e, i) => (
            <li key={i} className="flex gap-1.5 text-[11px] leading-snug">
              <span className="w-2.5 shrink-0 text-center font-bold" style={{ color: col }} aria-hidden>{sign}</span>
              <Pointable text={e.text} target={e.ref ? { ref: e.ref, label: e.text.slice(0, 48) } : null} onPoint={onPoint} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-0.5 text-[10.5px]" style={{ color: H.mut2 }}>Nothing on this side right now.</p>
      )}
    </div>
  );
}

function Line({ label, col, children }: { label: string; col: string; children: ReactNode }) {
  return (
    <p className="mt-1.5 text-[11px] leading-snug">
      <span className="mr-1 text-[9px] font-bold uppercase tracking-[0.12em]" style={{ color: col }}>{label}</span>
      {children}
    </p>
  );
}

/** Text that shows its subject on the chart when it has one; plain text when it does not. */
export function Pointable({ text, target, onPoint }: { text: string; target: PointTarget | null; onPoint: (t: PointTarget) => void }) {
  if (!target) return <span style={{ color: "#C9D3DB" }}>{text}</span>;
  return (
    <button type="button" onClick={() => onPoint(target)} title="Show this on the chart"
      className="text-left underline decoration-dotted underline-offset-2 transition hover:brightness-125" style={{ color: "#DCE6EE", textDecorationColor: "rgba(39,215,242,0.5)" }}>
      {text}<Crosshair className="ml-1 inline h-3 w-3 align-[-2px]" style={{ color: H.cyan2 }} aria-hidden />
    </button>
  );
}

function BalanceBar({ score }: { score: number | null }) {
  const v = score == null ? 0 : Math.max(-100, Math.min(100, score));
  const w = Math.abs(v) / 2;
  return (
    <span className="relative h-[5px] min-w-[48px] flex-1 overflow-hidden rounded-full" style={{ background: "rgba(255,255,255,0.07)" }} aria-hidden>
      <span className="absolute top-0 h-full w-px" style={{ left: "50%", background: H.mut2 }} />
      {score != null && (
        <span className="absolute top-0 h-full rounded-full" style={{ left: v >= 0 ? "50%" : `${50 - w}%`, width: `${w}%`, background: v >= 0 ? H.green : H.red, boxShadow: `0 0 6px ${v >= 0 ? H.green : H.red}` }} />
      )}
    </span>
  );
}
