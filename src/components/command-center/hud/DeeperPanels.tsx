"use client";
import { useState } from "react";
import { AlertTriangle, Globe2, LineChart, Radar } from "lucide-react";
import { H, fmt2, toneColor } from "./theme";
import { Chip, HudPanel, InfoPop, Sparkline } from "./Hud";
import { LiquidityRadar, RADAR_KIND_WORD, blipRgb, radarRead, type RadarBlip } from "./LiquidityRadar";
import { StructureViz, pivotsOf } from "./StructureViz";
import type { ChartBar } from "./GoldChart";
import type { Live } from "../CommandCenterLive";

/**
 * THE DEEPER PANELS — candidate liquidity zones, market structure and global context. Demoted from the main
 * desk into the ANALYSIS drawer (owner 11-11: "don't delete features, demote them"), each with an honest name:
 * liquidity is inferred from structure (there is no order book), and a context source that is not connected
 * says so instead of printing a dash that looks like data.
 */

export type CtxRow = {
  key: string; label: string; instrument: string; source: string; note: string;
  value: number | null; change: number | null; changePct: number | null;
  period: string; asOf: string | null; status: "live" | "delayed" | "stale" | "not_connected";
};
export type CtxState = { rows: CtxRow[]; history: { t: number; v: number }[]; at: number | null; error?: string | null } | null;

/* ── candidate liquidity zones ────────────────────────────────────────────────────────────────────── */

export function LiquidityPanel({ d, blips, alive, liquidity, onToggleLiquidity, pinned, onPin, freshness }: {
  d: Live | null; blips: RadarBlip[]; alive: boolean;
  liquidity: boolean; onToggleLiquidity: () => void;
  pinned: { price: number; label: string } | null;
  onPin: (p: { price: number; label: string } | null) => void;
  freshness: string;
}) {
  const [hover, setHover] = useState<RadarBlip | null>(null);
  const [help, setHelp] = useState(false);
  const px = d?.price ?? 0;
  const pin = (b: RadarBlip) => onPin(pinned && Math.abs(pinned.price - b.price) < 0.01 ? null : { price: b.price, label: b.label });
  const read = radarRead(blips, d?.price ?? null);
  return (
    <HudPanel tour="liquidity" title="CANDIDATE LIQUIDITY ZONES" icon={<Radar className="h-3.5 w-3.5" />}
      right={
        <span className="flex items-center gap-1.5">
          <InfoPop title="Candidate liquidity zones">
            <p><b style={{ color: H.gold3 }}>Inferred from structure, not an order book.</b> Gold is traded over the counter and no feed here carries resting orders. These are prices where stops and resting interest are LIKELY to sit: old swing highs and lows, equal highs/lows, and the busiest recent price.</p>
            <p>Inputs: the engine&apos;s levels and confirmed swings from closed candles (present/intel.ts).</p>
            <p style={{ color: H.mut }}>Freshness: {freshness}.</p>
          </InfoPop>
          <Chip active={liquidity} onClick={onToggleLiquidity} title="Draw the nearest candidate zones on the chart">{liquidity ? "On chart ✓" : "Show on chart"}</Chip>
        </span>
      }
      bodyClass="flex flex-col gap-2 px-2.5 pb-2.5 sm:flex-row sm:items-start">
      <div className="mx-auto shrink-0 pt-1"><LiquidityRadar price={d?.price ?? null} blips={blips} size={150} alive={alive} onHover={setHover} onPick={pin} /></div>
      <div className="w-full min-w-0 flex-1 text-[11px]">
        <p className="mb-1.5 text-[10px] leading-snug" style={{ color: H.mut }}>Inferred from structure — not an order book.</p>
        {hover ? (
          <div className="mb-2 rounded-[6px] p-2 text-[10.5px] leading-snug" style={{ border: `1px solid rgba(${blipRgb(hover, d?.price ?? null)},0.55)`, background: "rgba(3,7,11,0.7)" }}>
            <p className="flex items-baseline justify-between gap-1">
              <b className="text-[12px] tabular-nums" style={{ color: H.text }}>{fmt2(hover.price)}</b>
              <span style={{ color: H.mut }}>{hover.side === "above" ? "above" : "below"}{hover.distance != null ? ` · ${hover.distance.toFixed(2)}` : ""}</span>
            </p>
            <p style={{ color: `rgb(${blipRgb(hover, d?.price ?? null)})` }}>{RADAR_KIND_WORD[hover.kind]}{hover.swept ? " · swept" : ""}</p>
            <p className="mt-0.5" style={{ color: H.mut }}>{hover.meaning ?? hover.label}</p>
          </div>
        ) : read ? (
          <div className="mb-2 rounded-[6px] px-2 py-1.5 text-[10.5px] leading-snug" style={{ background: "rgba(255,216,117,0.06)", border: `1px solid ${H.lineSoft}` }}>
            <p className="mb-0.5 text-[8.5px] font-bold tracking-[0.16em]" style={{ color: H.gold2 }}>WHAT IT&apos;S SAYING</p>
            <p style={{ color: H.text }}>{read}</p>
          </div>
        ) : null}
        {(["above", "below"] as const).map((side) => {
          const list = blips.filter((b) => (b.side ?? (b.price >= px ? "above" : "below")) === side)
            .sort((a, b) => Math.abs(a.price - px) - Math.abs(b.price - px)).slice(0, 3);
          return (
            <div key={side} className="mb-1.5">
              <p className="mb-0.5 text-[8.5px] font-bold tracking-[0.16em]" style={{ color: side === "above" ? H.green : H.red }}>{side === "above" ? "ABOVE PRICE" : "BELOW PRICE"}</p>
              {list.length ? list.map((b) => (
                <button key={`${side}${b.price}`} onClick={() => pin(b)} className="flex w-full items-center gap-2 border-b py-[3px] text-left" style={{ borderColor: H.lineSoft }}>
                  <span className="h-[7px] w-[7px] shrink-0 rounded-full" style={{ background: b.swept ? "transparent" : `rgb(${blipRgb(b, px)})`, border: `1.5px solid rgb(${blipRgb(b, px)})`, transform: b.kind === "equal_high" || b.kind === "equal_low" ? "rotate(45deg) scale(0.9)" : undefined, borderRadius: b.kind === "equal_high" || b.kind === "equal_low" ? 1 : undefined }} />
                  <b className="w-[64px] shrink-0 tabular-nums" style={{ color: H.text }}>{fmt2(b.price)}</b>
                  <span className="min-w-0 flex-1 truncate" style={{ color: H.mut }}>{RADAR_KIND_WORD[b.kind].replace(" (estimated liquidity)", "").replace(" (estimated)", "")}{b.swept ? " · swept" : ""}</span>
                  <span className="shrink-0 tabular-nums" style={{ color: side === "above" ? H.green : H.red }}>{side === "above" ? "+" : "−"}{Math.abs(b.price - px).toFixed(2)}</span>
                </button>
              )) : <p style={{ color: H.mut2 }}>None mapped</p>}
            </div>
          );
        })}
        <button onClick={() => setHelp((x) => !x)} className="mb-1 text-[9px] font-bold tracking-[0.12em]" style={{ color: H.gold2 }}>{help ? "HIDE HOW TO READ ▴" : "HOW TO READ IT ▾"}</button>
        {help && (
          <ul className="mb-1.5 grid gap-[3px] text-[10px] leading-snug" style={{ color: H.mut }}>
            <li><b style={{ color: H.gold2 }}>Gold centre</b> = gold&apos;s price right now.</li>
            <li><b style={{ color: H.text }}>Up = above price, down = below.</b> The farther from the centre, the farther away. Each ring is the dollar distance printed on it. Left/right means nothing — dots are spread out so they don&apos;t overlap.</li>
            <li><b style={{ color: "rgb(41,223,166)" }}>Green</b> = candidate liquidity above: stops from sellers tend to sit over old highs.</li>
            <li><b style={{ color: "rgb(255,83,100)" }}>Red</b> = candidate liquidity below: stops from buyers tend to sit under old lows.</li>
            <li><b style={{ color: "rgb(89,175,255)" }}>Blue</b> = the busiest price lately — where gold has traded most. It tends to pull price back.</li>
            <li><b style={{ color: H.text }}>◆ Diamond</b> = equal highs/lows: price stopped at the same spot more than once, so stops are likely stacked there.</li>
            <li><b style={{ color: H.text }}>Hollow</b> = already swept. Bright dots are the nearest three each side; faint dots are farther back.</li>
          </ul>
        )}
        <p className="text-[9px] leading-tight" style={{ color: H.mut2 }}>Tap a level to pin it on the chart. {freshness}.</p>
      </div>
    </HudPanel>
  );
}

/* ── market structure ─────────────────────────────────────────────────────────────────────────────── */

export function StructurePanel({ d, bars, freshness }: { d: Live | null; bars: ChartBar[]; freshness: string }) {
  const intel = d?.intel ?? null;
  const tr = intel?.structure.trend ?? "";
  const col = /down/i.test(tr) ? H.red : /up/i.test(tr) ? H.green : H.gold2;
  const pivots = pivotsOf(bars, 3, 5);
  const rows: [string, string | null | undefined, string][] = [
    ["Trend", intel?.structure.trend, intel?.structure.trend === "Downtrend" ? H.red : intel?.structure.trend === "Uptrend" ? H.green : H.text],
    ["Market structure", intel?.structure.sequence, intel?.structure.sequence?.startsWith("Lower") ? H.red : intel?.structure.sequence?.startsWith("Higher") ? H.green : H.text],
    ["Market mode (regime)", intel?.mode.label, toneColor(intel?.mode.tone)],
    ["Candidate liquidity above", intel?.liquidity.aboveZone ? `${fmt2(intel.liquidity.aboveZone[0])} – ${fmt2(intel.liquidity.aboveZone[1])}` : null, H.text],
    ["Candidate liquidity below", intel?.liquidity.belowZone ? `${fmt2(intel.liquidity.belowZone[0])} – ${fmt2(intel.liquidity.belowZone[1])}` : null, H.text],
    ["Current phase", intel?.structure.phase, H.gold2],
    ["Next watched", intel?.structure.nextWatched != null ? fmt2(intel.structure.nextWatched) : null, H.gold2],
  ];
  return (
    <HudPanel tour="structure" title="MARKET STRUCTURE" icon={<LineChart className="h-3.5 w-3.5" />}
      right={<span className="text-[9px] font-bold tracking-[0.12em]" style={{ color: col }}>{(tr || "NO READ").toUpperCase()}</span>}
      bodyClass="grid grid-cols-1 gap-2 px-2.5 pb-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
      <div className="relative h-[190px]">
        <StructureViz pivots={pivots} price={d?.price ?? null} bearish={/down/i.test(intel?.structure.trend ?? "")} />
      </div>
      <dl className="grid content-start gap-[3px] text-[10.5px]">
        {rows.map(([k, v, c]) => (
          <div key={k} className="flex items-baseline justify-between gap-2 border-b pb-[3px]" style={{ borderColor: H.lineSoft }}>
            <dt style={{ color: H.mut }}>{k}</dt><dd className="truncate text-right font-medium tabular-nums" style={{ color: v ? c : H.mut2 }}>{v ?? "no read"}</dd>
          </div>
        ))}
        <p className="pt-1 text-[9px] leading-snug" style={{ color: H.mut2 }}>HH higher high · LH lower high · HL higher low · LL lower low. Swings from the chart&apos;s closed candles; the rows from the engine. {freshness}.</p>
      </dl>
    </HudPanel>
  );
}

/* ── global context ───────────────────────────────────────────────────────────────────────────────── */

const ST_COL = (st: CtxRow["status"]) => (st === "live" ? H.green : st === "delayed" ? H.gold2 : st === "stale" ? H.mut : H.red);
const ST_WORD: Record<CtxRow["status"], string> = { live: "live", delayed: "delayed", stale: "stale", not_connected: "not connected" };

export function ContextPanel({ ctx, replay, news }: { ctx: CtxState; replay: boolean; news: NonNullable<Live["intel"]>["news"] | null | undefined }) {
  // Only rows the route actually integrates. A source that is wired but answering nothing says "not connected";
  // a row the route never returned is not invented here.
  const rows = ctx?.rows ?? [];
  return (
    <HudPanel tour="context" title="GLOBAL CONTEXT" icon={<Globe2 className="h-3 w-3" />}
      right={<span className="text-[8.5px] tracking-[0.1em]" style={{ color: H.mut }} title="Shown for context only. ATLAS and the setup engine do not read these — nothing here changes a trade.">DISPLAY ONLY{ctx?.at ? ` · ${new Date(ctx.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}</span>}
      bodyClass="flex flex-col gap-1.5 px-2.5 pb-2.5">
      {replay ? (
        <p className="text-[11px]" style={{ color: H.mut }}>Not connected in the replay — the recorded session has no context quotes.</p>
      ) : !ctx ? (
        <p className="text-[11px]" style={{ color: H.mut }}>Checking the context feed…</p>
      ) : !rows.length ? (
        <p className="text-[11px]" style={{ color: H.red }}>Context feed not connected{ctx.error ? ` — ${ctx.error}` : ""}. Nothing is shown rather than placeholders.</p>
      ) : (
        <table className="w-full text-[11px] tabular-nums">
          <tbody>
            {rows.map((q) => (
              <tr key={q.key} className="border-b" style={{ borderColor: H.lineSoft }} title={q.note ? `${q.instrument} · ${q.source} — ${q.note}` : undefined}>
                <td className="py-[3px]" style={{ color: H.text }}>
                  {q.label}<span className="ml-1 text-[9.5px]" style={{ color: H.mut2 }}>{q.instrument}</span>
                  {q.key === "dxy" && (ctx.history?.length ?? 0) > 1 && (
                    <span className="ml-2 inline-block align-middle"><Sparkline values={ctx.history.map((h) => h.v)} color={(q.changePct ?? 0) >= 0 ? H.green : H.red} w={46} h={16} /></span>
                  )}
                </td>
                {q.status === "not_connected" || q.value == null ? (
                  <td colSpan={2} className="text-right text-[10.5px]" style={{ color: H.red }}>not connected</td>
                ) : (
                  <>
                    <td className="text-right" style={{ color: H.text }}>{q.value.toLocaleString("en-US", { maximumFractionDigits: 2 })}</td>
                    <td className="w-[58px] text-right" style={{ color: q.changePct == null ? H.mut2 : q.changePct >= 0 ? H.green : H.red }}>{q.changePct == null ? "no change data" : `${q.changePct >= 0 ? "+" : ""}${q.changePct.toFixed(2)}%`}</td>
                  </>
                )}
                <td className="w-[86px] text-right text-[9.5px]" style={{ color: ST_COL(q.status) }}>
                  <span className="mr-1 inline-block h-[5px] w-[5px] rounded-full align-middle" style={{ background: ST_COL(q.status) }} />{ST_WORD[q.status]}
                  {q.asOf && q.status !== "not_connected" ? <span className="block text-[8.5px]" style={{ color: H.mut2 }}>{new Date(q.asOf).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="mt-1 flex items-center gap-2 rounded-[6px] px-2 py-[5px]" style={{ border: `1px solid ${H.line}` }}>
        <AlertTriangle className="h-3 w-3 shrink-0" style={{ color: news?.lockout ? H.red : H.gold2 }} />
        <p className="min-w-0 flex-1 text-[10.5px] leading-tight" style={{ color: H.text }}>
          {news
            ? <>{news.name}<span className="block text-[9px]" style={{ color: H.mut }}>{news.lockout ? "Release lockout active" : news.minutesTo != null ? `in ${Math.round(news.minutesTo)} min · ${news.importance} impact` : news.importance}</span></>
            : <>No high-impact release scheduled<span className="block text-[9px]" style={{ color: H.mut }}>ATLAS reads the economic calendar; the quotes above never reach a trade.</span></>}
        </p>
      </div>
    </HudPanel>
  );
}
