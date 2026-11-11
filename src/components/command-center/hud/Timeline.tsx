"use client";
import { useState } from "react";
import { Brain, Volume2 } from "lucide-react";
import { H } from "./theme";
import { Chip, HudPanel, LiveDot } from "./Hud";

/**
 * THE INTELLIGENCE TIMELINE — one concise, timestamped line per thing worth knowing, newest first: what the
 * engine noticed (structure, price, news), what happened to a position, and what ATLAS volunteered (the voice
 * line's commentary — marked when it was actually spoken). One line each on the desk; tap a line to read all
 * of it.
 */
export type TimelineKind = "price" | "structure" | "news" | "trade" | "atlas";
export type TimelineRow = {
  key: string; at: number; text: string; kind: TimelineKind;
  lean?: string | null; urgent?: boolean; spoken?: boolean; tag?: string;
};
export type TimelineFilter = "ALL" | "PRICE" | "STRUCTURE" | "NEWS" | "ATLAS";
const FILTERS: TimelineFilter[] = ["ALL", "PRICE", "STRUCTURE", "NEWS", "ATLAS"];

const KIND_COL: Record<TimelineKind, string> = {
  trade: H.gold2, news: H.blue, structure: "rgba(39,215,242,0.75)", price: "rgba(255,255,255,0.35)", atlas: H.gold3,
};
const KIND_WORD: Record<TimelineKind, string> = { trade: "TRADE", news: "NEWS", structure: "STRUCTURE", price: "PRICE", atlas: "ATLAS" };
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

export function Timeline({ rows, className = "", maxRows = 60 }: { rows: TimelineRow[]; className?: string; maxRows?: number }) {
  const [filter, setFilter] = useState<TimelineFilter>("ALL");
  const [openKey, setOpenKey] = useState<string | null>(null);
  const shown = rows
    .filter((r) => filter === "ALL"
      || (filter === "PRICE" && (r.kind === "price" || r.kind === "trade"))
      || (filter === "STRUCTURE" && r.kind === "structure")
      || (filter === "NEWS" && r.kind === "news")
      || (filter === "ATLAS" && r.kind === "atlas"))
    .slice(0, maxRows);
  return (
    <HudPanel tour="stream" className={className} bodyClass="flex min-h-0 flex-col">
      {/* its own header, so the filters wrap under the title on a phone instead of running off the panel */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-2 gap-y-1 px-3 pb-1 pt-2">
        <p className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap text-[10px] font-semibold uppercase tracking-[0.13em]" style={{ color: H.text }}>
          <span style={{ color: H.gold2 }}><Brain className="h-3 w-3" /></span>Intelligence timeline
        </p>
        <span className="flex flex-wrap items-center gap-[3px]" role="group" aria-label="Filter the timeline">
          {FILTERS.map((f) => <Chip key={f} active={filter === f} onClick={() => setFilter(f)} className="!px-1.5 !text-[8px]">{f}</Chip>)}
          <LiveDot size={5} />
        </span>
      </div>
      <div className="hud-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-1.5">
      {shown.length ? (
        <ul>
          {shown.map((r, i) => {
            const open = openKey === r.key;
            const col = r.urgent ? H.gold2 : r.kind === "trade" ? H.gold3 : r.kind === "atlas" ? "#F3E2B0" : r.lean === "bearish" ? "#F2B8BE" : r.lean === "bullish" ? "#B5EDD8" : "#C9D3DB";
            return (
              <li key={r.key} className={i === 0 ? "hud-in" : ""}>
                <button type="button" onClick={() => setOpenKey(open ? null : r.key)} aria-expanded={open}
                  className="flex w-full items-baseline gap-2 border-b border-l-2 py-[3px] pl-2 pr-1 text-left transition hover:bg-white/[0.02]"
                  style={{ borderBottomColor: H.lineSoft, borderLeftColor: KIND_COL[r.kind] }}
                  title={`${new Date(r.at).toLocaleString()} · ${KIND_WORD[r.kind].toLowerCase()}`}>
                  <span className="shrink-0 text-[10px] tabular-nums" style={{ color: H.mut }}>{clock(r.at)}</span>
                  <span className="w-[62px] shrink-0 text-[8px] font-bold tracking-[0.12em]" style={{ color: KIND_COL[r.kind] }}>{r.tag ?? KIND_WORD[r.kind]}</span>
                  <span className={`min-w-0 flex-1 text-[11px] leading-snug ${open ? "" : "truncate"}`} style={{ color: col }}>
                    {r.spoken && <Volume2 className="mr-1 inline h-3 w-3 align-[-2px]" style={{ color: H.gold2 }} aria-label="spoken" />}
                    {r.text}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="p-2 text-[11px]" style={{ color: H.mut }}>{filter === "ATLAS" ? "ATLAS hasn't volunteered anything yet — it speaks up only when something meaningful changes." : "Nothing worth reporting yet. ATLAS stays quiet when nothing has changed."}</p>
      )}
      </div>
    </HudPanel>
  );
}
