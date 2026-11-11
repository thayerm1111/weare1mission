"use client";
import { useEffect, useRef, useState } from "react";
import { ChevronDown, Crosshair, EyeOff, MoveHorizontal, TrendingDown, TrendingUp } from "lucide-react";
import { H, fmt2 } from "./theme";
import { HudPanel, InfoPop } from "./Hud";
import type { Scenario, ScenarioRole, ScenarioStatus } from "../../../../command-center/core/atlasContract";
import { ROLE_LABEL, ROLE_ORDER, STATUS_LABEL, ageShort, scenarioSlots } from "./hudModel";
import type { PointTarget } from "./ReadCard";

/**
 * ATLAS'S SCENARIOS, BENEATH THE CHART (core/scenarios.ts) — base case, alternative, and what would change the
 * view, each with its timeframe, a status chip, the trigger and the invalidation (prices that show themselves on
 * the chart), a line of evidence, and "Show on chart", which draws the scenario as a conditional projection.
 * The recently finished ones (confirmed, invalidated, expired) fold away below, with the reason each one ended.
 * Conditional, never forecasts: no percentages, because ATLAS has no probability model.
 */
const STATUS_COL: Record<ScenarioStatus, string> = {
  watching: H.cyan2, developing: H.gold3, confirmed: H.green, invalidated: H.red, expired: H.mut,
};
const ROLE_COL: Record<ScenarioRole, string> = { base: H.gold3, alternative: H.cyan2, view_change: "#E7A0A7" };
const DirIcon = ({ s }: { s: Scenario }) => {
  const Icon = s.direction === "up" ? TrendingUp : s.direction === "down" ? TrendingDown : MoveHorizontal;
  return <Icon className="h-3.5 w-3.5 shrink-0" style={{ color: s.direction === "up" ? H.green : s.direction === "down" ? H.red : H.cyan2 }} aria-hidden />;
};
const hhmm = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

export function ScenarioCards({ scenarios, selectedId, onShow, onPoint, now, replay, className = "" }: {
  scenarios: Scenario[] | null | undefined;
  /** The scenario drawn on the chart right now (chart action or a card's button). */
  selectedId: string | null;
  /** Draw it on the chart (or, with null, take it off). */
  onShow: (id: string | null) => void;
  onPoint: (t: PointTarget) => void;
  now: number;
  replay: boolean;
  className?: string;
}) {
  const { slots, finished } = scenarioSlots(scenarios);
  const [openFinished, setOpenFinished] = useState(false);
  const cards = useRef<Record<string, HTMLDivElement | null>>({});
  const finishedRef = useRef<HTMLDivElement | null>(null);

  // A scenario ATLAS put on the chart is brought into view here, and opened if it has finished.
  useEffect(() => {
    if (!selectedId) return;
    if (finished.some((s) => s.id === selectedId)) setOpenFinished(true);
    const t = window.setTimeout(() => cards.current[selectedId]?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" }), 60);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);
  useEffect(() => {
    if (openFinished) window.setTimeout(() => finishedRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 60);
  }, [openFinished]);

  const any = ROLE_ORDER.some((r) => slots[r]);
  return (
    <HudPanel tour="scenarios" title="SCENARIOS" className={className}
      right={
        <span className="flex items-center gap-1.5">
          <span className="hidden text-[8.5px] tracking-[0.08em] sm:inline" style={{ color: H.mut }}>Conditional — not forecasts</span>
          <InfoPop title="Scenarios">
            <p>ATLAS keeps three live scenarios: the <b style={{ color: H.gold3 }}>base case</b>, the <b style={{ color: H.cyan2 }}>alternative</b>, and <b style={{ color: "#E7A0A7" }}>what would change the view</b>. Each has a trigger and an invalidation decided on a closed 15-minute or 1-hour candle.</p>
            <p>Status moves watching → developing → confirmed, or invalidated / expired. Finished scenarios are kept with the reason they ended and are never rewritten.</p>
            <p>There are no percentages: ATLAS has no probability model and does not pretend to.</p>
          </InfoPop>
          {finished.length > 0 && (
            <button type="button" onClick={() => setOpenFinished((x) => !x)} aria-expanded={openFinished}
              className="inline-flex items-center gap-1 rounded-[5px] px-1.5 py-[2px] text-[8.5px] font-bold uppercase tracking-[0.1em]"
              style={{ color: openFinished ? H.gold2 : H.mut, border: `1px solid ${openFinished ? "rgba(231,196,103,0.5)" : H.line}` }}>
              Finished · {finished.length}<ChevronDown className="h-3 w-3" style={{ transform: openFinished ? "rotate(180deg)" : "none" }} />
            </button>
          )}
        </span>
      }
      bodyClass="hud-scroll overflow-y-auto px-2 pb-2">
      {!scenarios ? (
        <p className="px-1 py-2 text-[11px]" style={{ color: H.mut }}>Waiting for ATLAS&apos;s scenarios.</p>
      ) : (
        <>
          <div className="grid gap-1.5 md:grid-cols-3">
            {ROLE_ORDER.map((role) => {
              const s = slots[role];
              if (!s) {
                return (
                  <div key={role} className="flex min-h-[64px] flex-col justify-center rounded-[8px] px-2.5 py-2" style={{ border: `1px dashed ${H.line}` }}>
                    <p className="text-[8.5px] font-bold uppercase tracking-[0.14em]" style={{ color: ROLE_COL[role] }}>{ROLE_LABEL[role]}</p>
                    <p className="mt-0.5 text-[10.5px]" style={{ color: H.mut }}>{any ? "None live right now." : "No live scenario yet."}</p>
                  </div>
                );
              }
              return <Card key={s.id} s={s} role={role} selected={selectedId === s.id} onShow={onShow} onPoint={onPoint} now={now} replay={replay}
                refCb={(el) => { cards.current[s.id] = el; }} />;
            })}
          </div>
          {openFinished && finished.length > 0 && (
            <div ref={finishedRef} className="mt-2 space-y-1" data-finished="">
              <p className="px-0.5 text-[8.5px] font-bold uppercase tracking-[0.14em]" style={{ color: H.mut }}>Recently finished</p>
              {finished.slice(0, 8).map((s) => {
                const last = s.history[s.history.length - 1];
                return (
                  <div key={s.id} ref={(el) => { cards.current[s.id] = el; }} className="flex items-start gap-2 rounded-[6px] px-2 py-1.5"
                    style={{ border: `1px solid ${selectedId === s.id ? H.cyan2 : H.lineSoft}`, background: "rgba(3,7,11,0.4)" }}>
                    <StatusChip st={s.status} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[11px] font-semibold" style={{ color: H.text }} title={s.title}>{s.title}</p>
                      {last?.reason && <p className="line-clamp-2 text-[10px] leading-snug" style={{ color: H.mut }}>{last.reason}</p>}
                    </div>
                    <span className="shrink-0 text-[9.5px] tabular-nums" style={{ color: H.mut2 }}>{hhmm(s.updatedAt)}</span>
                    <button type="button" onClick={() => onShow(selectedId === s.id ? null : s.id)} className="shrink-0 rounded-[4px] px-1 py-[1px] text-[9px]"
                      style={{ color: H.cyan2, border: `1px solid ${H.line}` }} title={selectedId === s.id ? "Take it off the chart" : "Show on the chart"}>
                      {selectedId === s.id ? <EyeOff className="h-3 w-3" /> : <Crosshair className="h-3 w-3" />}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </HudPanel>
  );
}

function StatusChip({ st }: { st: ScenarioStatus }) {
  const c = STATUS_COL[st];
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-[4px] px-1.5 py-[1px] text-[8.5px] font-bold uppercase tracking-[0.1em]"
      style={{ color: c, border: `1px solid ${c}66`, background: `${c}14` }} data-status={st}>
      {st === "developing" && <span className="h-[5px] w-[5px] rounded-full" style={{ background: c, boxShadow: `0 0 5px ${c}` }} />}
      {STATUS_LABEL[st]}
    </span>
  );
}

function Card({ s, role, selected, onShow, onPoint, now, replay, refCb }: {
  s: Scenario; role: ScenarioRole; selected: boolean; onShow: (id: string | null) => void; onPoint: (t: PointTarget) => void;
  now: number; replay: boolean; refCb: (el: HTMLDivElement | null) => void;
}) {
  const last = s.history[s.history.length - 1];
  const age = replay ? null : now ? now - s.updatedAt : null;
  return (
    <div ref={refCb} data-scenario={s.role}
      className="flex min-w-0 flex-col rounded-[8px] px-2.5 pb-1.5 pt-1.5 transition"
      style={{
        border: `1px solid ${selected ? H.cyan2 : role === "base" ? "rgba(231,196,103,0.35)" : H.line}`,
        background: selected ? "rgba(0,199,232,0.07)" : role === "base" ? "rgba(213,169,61,0.05)" : "rgba(3,7,11,0.35)",
        boxShadow: selected ? "0 0 14px rgba(0,199,232,0.18)" : "none",
      }}>
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 truncate text-[8.5px] font-bold uppercase tracking-[0.12em]" style={{ color: ROLE_COL[role] }} title={ROLE_LABEL[role]}>
          {role === "view_change" ? <><span className="min-[1536px]:hidden">Changes the view</span><span className="hidden min-[1536px]:inline">{ROLE_LABEL[role]}</span></> : ROLE_LABEL[role]}
        </span>
        <span className="ml-auto shrink-0"><StatusChip st={s.status} /></span>
      </div>
      <p className="mt-0.5 flex items-start gap-1.5 text-[11.5px] font-semibold leading-snug" style={{ color: H.text }} title={s.title}>
        <DirIcon s={s} /><span className="line-clamp-2 xl:line-clamp-1">{s.title}</span>
      </p>
      <Cond label="Trigger" col={H.cyan2} text={s.trigger.text} price={s.trigger.price}
        target={s.trigger.ref ? { ref: s.trigger.ref, label: `Trigger · ${s.title}`.slice(0, 60) } : s.trigger.price != null ? { price: s.trigger.price, label: "Scenario trigger" } : null}
        onPoint={onPoint} />
      <Cond label="Invalidation" col={H.red} text={s.invalidation.text} price={s.invalidation.price}
        target={s.invalidation.ref ? { ref: s.invalidation.ref, label: `Invalidation · ${s.title}`.slice(0, 60) } : s.invalidation.price != null ? { price: s.invalidation.price, label: "Scenario invalidation" } : null}
        onPoint={onPoint} />
      {s.evidence[0] && <p className="mt-0.5 line-clamp-1 text-[10px] leading-snug" style={{ color: H.mut }} title={s.evidence.join("\n")}>• {s.evidence[0]}</p>}
      <div className="mt-auto flex items-center gap-2 pt-0.5">
        <button type="button" onClick={() => onShow(selected ? null : s.id)}
          className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-[5px] px-1.5 py-[2px] text-[9px] font-bold uppercase tracking-[0.08em] transition hover:brightness-125"
          style={{ color: selected ? H.gold3 : H.cyan2, border: `1px solid ${selected ? "rgba(231,196,103,0.5)" : "rgba(39,215,242,0.4)"}` }}>
          {selected ? <><EyeOff className="h-3 w-3" />Hide</> : <><Crosshair className="h-3 w-3" />Show on chart</>}
        </button>
        <span className="ml-auto min-w-0 truncate text-[9px] tabular-nums" style={{ color: H.mut2 }} title={last?.reason ?? undefined}>
          {s.tf} · {age != null ? `updated ${ageShort(age)} ago` : `updated ${hhmm(s.updatedAt)}`}
        </span>
      </div>
    </div>
  );
}

/** A trigger or an invalidation: its label inline, the price first when there is one, the condition after it. */
function Cond({ label, col, text, price, target, onPoint }: {
  label: string; col: string; text: string; price: number | null; target: PointTarget | null; onPoint: (t: PointTarget) => void;
}) {
  const head = <span className="mr-1 text-[8.5px] font-bold uppercase tracking-[0.1em]" style={{ color: col }}>{label}</span>;
  // The engine's sentence usually contains the price: that figure is highlighted where it stands. When it does
  // not, the price leads.
  const px = price != null ? fmt2(price) : null;
  const at = px ? text.indexOf(px) : -1;
  const fig = (v: string) => <b className="tabular-nums underline decoration-dotted underline-offset-2" style={{ color: col }}>{v}</b>;
  return (
    <div className="mt-0.5 min-w-0 text-[10.5px] leading-snug">
      {target ? (
        <button type="button" onClick={() => onPoint(target)} title={`${text} — show on the chart`}
          className="w-full min-w-0 text-left transition hover:brightness-125" style={{ color: "#C9D3DB" }}>
          <span className="line-clamp-2">
            {head}
            {px && at >= 0 ? <>{text.slice(0, at)}{fig(px)}{text.slice(at + px.length)}</> : px ? <>{fig(px)} {text}</> : text}
            {!px && <Crosshair className="ml-1 inline h-3 w-3 align-[-2px]" style={{ color: H.cyan2 }} aria-hidden />}
          </span>
        </button>
      ) : (
        <span className="line-clamp-2 min-w-0" style={{ color: "#C9D3DB" }} title={text}>{head}{text}</span>
      )}
    </div>
  );
}
