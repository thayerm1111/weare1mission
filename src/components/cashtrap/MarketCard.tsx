"use client";
import { Check, Minus, X, Clock3, Radio } from "lucide-react";
import type { Snapshot } from "@/lib/cashtrap/snapshot";
import type { Checklist } from "@/lib/cashtrap/engine";
import type { SymbolSpec } from "@/lib/cashtrap/symbols";
import { C, STATUS_STYLE, countdown, fmtPx, localTime, type Status } from "./theme";

/** The five conditions, worded for the direction shown. */
export function checklistRows(dir: "BUY" | "SELL" | null, cl: Checklist | null): Array<{ label: string; state: boolean | null }> {
  const buy = dir !== "SELL";
  return [
    { label: buy ? "Low below the lower Bollinger Band" : "High above the upper Bollinger Band", state: cl ? cl.band : null },
    { label: buy ? "RSI(4) below 20" : "RSI(4) above 80", state: cl ? cl.rsi : null },
    { label: buy ? "Stochastic %K below 20" : "Stochastic %K above 80", state: cl ? cl.stoch : null },
    { label: buy ? "Reacting at a support zone" : "Reacting at a resistance zone", state: cl ? cl.zone : null },
    { label: buy ? "Fresh DMI-Stochastic B" : "Fresh DMI-Stochastic S", state: cl ? cl.dmi : null },
  ];
}

export function CheckIcon({ state }: { state: boolean | null }) {
  if (state === true) return <Check className="h-3.5 w-3.5" style={{ color: C.green }} aria-label="met" />;
  if (state === false) return <X className="h-3.5 w-3.5" style={{ color: C.faint }} aria-label="not met" />;
  return <Minus className="h-3.5 w-3.5" style={{ color: C.faint }} aria-label="unavailable" />;
}

export function StatusBadge({ status, small }: { status: Status; small?: boolean }) {
  const s = STATUS_STYLE[status];
  return (
    <span className={`inline-flex items-center rounded-full border font-semibold tracking-wide ${small ? "px-2 py-0.5 text-[10px]" : "px-2.5 py-1 text-[11px]"}`} style={{ color: s.fg, background: s.bg, borderColor: s.border }}>
      {s.label}
    </span>
  );
}

export function MarketCard({ spec, snap, now, nextCloseAt, selected, onSelect, stale }: { spec: SymbolSpec; snap: Snapshot | null; now: number; nextCloseAt: number; selected: boolean; onSelect: () => void; stale: boolean }) {
  const status: Status = snap ? (snap.status as Status) : "DATA_UNAVAILABLE";
  const priceAge = snap?.price ? now - snap.price.at : null;
  const fresh = priceAge != null && priceAge < 20_000 ? "fresh" : priceAge != null && priceAge < 90_000 ? "delayed" : "stale";
  const dot = !snap?.feed.open ? C.faint : fresh === "fresh" ? C.green : fresh === "delayed" ? C.amber : C.red;
  const rows = checklistRows(snap?.direction ?? null, snap?.checklist ?? null);
  const sig = snap?.signal;
  const closeIn = (snap?.nextCloseAt && snap.nextCloseAt > now ? snap.nextCloseAt : nextCloseAt) - now;
  return (
    <button type="button" onClick={onSelect} aria-pressed={selected}
      className="flex w-full flex-col gap-3 rounded-2xl border p-4 text-left transition-shadow hover:shadow-md focus:outline-none focus-visible:ring-2"
      style={{ background: C.card, borderColor: selected ? C.blue : C.line, boxShadow: selected ? `0 0 0 1px ${C.blue}` : "0 1px 2px rgba(28,35,64,0.04)" }}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold" style={{ color: C.ink }}>{spec.label}</p>
          <p className="text-[11px]" style={{ color: C.faint }}>5-minute · {spec.feedSymbol}</p>
        </div>
        <StatusBadge status={status} />
      </div>
      <div className="flex items-end justify-between gap-2">
        <p className="font-mono text-2xl font-semibold tabular-nums" style={{ color: C.ink }}>{fmtPx(snap?.price?.px, spec.precision)}</p>
        <div className="text-right text-[11px] leading-tight" style={{ color: C.muted }}>
          <p className="flex items-center justify-end gap-1"><span className="inline-block h-2 w-2 rounded-full" style={{ background: dot }} />{!snap ? "no data yet" : !snap.feed.open ? "market closed" : priceAge == null ? "no quote" : `${Math.round(priceAge / 1000)}s old`}</p>
          <p className="mt-0.5 flex items-center justify-end gap-1"><Clock3 className="h-3 w-3" />{snap?.feed.open === false ? "—" : `close in ${countdown(closeIn)}`}</p>
        </div>
      </div>
      {sig && (status === "CALL" || status === "PUT" || status === "ACTIVE") && (
        <div className="rounded-xl px-3 py-2 text-[12px]" style={{ background: sig.direction === "CALL" ? C.greenSoft : C.redSoft, color: C.ink }}>
          {status === "ACTIVE" && sig.expiryAt
            ? <span className="inline-flex items-center gap-1"><Radio className="h-3 w-3" /> {sig.direction} from {fmtPx(sig.referencePrice, spec.precision)} · expires in <b className="font-mono">{countdown(sig.expiryAt - now)}</b></span>
            : <span>{sig.direction} · reference entry window closes in <b className="font-mono">{countdown(sig.entryDeadline - now)}</b></span>}
        </div>
      )}
      <ul className="space-y-1">
        {rows.map((r) => (
          <li key={r.label} className="flex items-center gap-2 text-[12px]" style={{ color: r.state ? C.ink : C.muted }}>
            <CheckIcon state={r.state} /> {r.label}
          </li>
        ))}
      </ul>
      <p className="text-[11px] font-semibold" style={{ color: C.purple }}>
        {snap?.checklist ? `${snap.met}/5 conditions met` : "—"} <span className="font-normal" style={{ color: C.faint }}>· confluence, not a win probability</span>
      </p>
      <p className="line-clamp-4 text-[12px] leading-snug" style={{ color: C.muted }}>{stale && snap ? `(Updated ${localTime(snap.updatedAt)}.) ` : ""}{snap?.reason ?? "Waiting for the first pass of the Cashtrap runner."}</p>
    </button>
  );
}
