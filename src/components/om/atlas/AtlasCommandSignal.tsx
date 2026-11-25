"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, Check, ChevronRight, Loader2, Sparkles, X } from "lucide-react";
import { SignalFocusChart } from "@/components/om/chart/SignalFocusChart";
import { atlasIdeaChart } from "@/lib/atlas/ideaChart";
import { openAtlas } from "@/lib/atlas/open";
import {
  AtlasCommandSignalError, atlasCommandSignalContext, atlasCommandSignalSupported,
  loadAtlasCommandAccess, openAtlasCommandWindow, requestAtlasCommandSignal,
  type AtlasCommandAccess, type AtlasCommandSignalResult,
} from "@/lib/atlas/commandSignal";
import "./atlas-command-signal.css";

/** No generation or credit purchase occurs on mount, market change, or response refresh. */
export function useAtlasCommandSignal({ symbol, disabled = false }: { symbol: string; disabled?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AtlasCommandSignalResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [access, setAccess] = useState<AtlasCommandAccess | null>(null);
  const current = useRef({ symbol, disabled }); current.current = { symbol, disabled };
  const quotedAccess = useRef(access); quotedAccess.current = access;
  const mounted = useRef(true), sequence = useRef(0), inFlight = useRef(false);
  const abort = useRef<AbortController | null>(null);
  const supported = atlasCommandSignalSupported(symbol);
  const clear = useCallback(() => {
    sequence.current++; abort.current?.abort(); inFlight.current = false;
    setBusy(false); setResult(null); setError(null); setAccess(null);
  }, []);
  useEffect(() => { clear(); }, [symbol, disabled, clear]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; sequence.current++; abort.current?.abort(); };
  }, []);

  const run = useCallback(async (purchaseWindow: boolean) => {
    const requested = current.current;
    if (inFlight.current || requested.disabled || !atlasCommandSignalSupported(requested.symbol)) return;
    inFlight.current = true;
    const id = ++sequence.current;
    const controller = new AbortController(); abort.current = controller;
    const isCurrent = () => mounted.current && sequence.current === id && current.current.symbol === requested.symbol && !current.current.disabled;
    setBusy(true); setError(null); setResult(null); setAccess(null);
    try {
      if (purchaseWindow) {
        await openAtlasCommandWindow();
        window.dispatchEvent(new Event("credits-updated"));
        if (!isCurrent()) return;
      }
      const next = await requestAtlasCommandSignal(requested.symbol, { signal: controller.signal, isCurrent });
      if (next && isCurrent()) setResult(next);
    } catch (err) {
      if (!isCurrent()) return;
      setError(err instanceof AtlasCommandSignalError ? err.message : "The Command Center could not be reached. Check your connection and try again.");
      if (err instanceof AtlasCommandSignalError && err.code === "pass_required") {
        const gate = await loadAtlasCommandAccess({ signal: controller.signal }).catch(() => null);
        if (isCurrent()) setAccess(gate);
      }
    } finally {
      if (isCurrent()) { inFlight.current = false; setBusy(false); }
    }
  }, []);
  const generate = useCallback(() => run(false), [run]);
  const openWindowAndGenerate = useCallback(() => {
    if (!quotedAccess.current || quotedAccess.current.active) return Promise.resolve();
    return run(true);
  }, [run]);
  return { busy, result: supported && !disabled ? result : null, error, access, supported, generate, openWindowAndGenerate, clear };
}
export type AtlasCommandSignalController = ReturnType<typeof useAtlasCommandSignal>;

const price = (value: number) => value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const time = (value: number) => new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** The real Atlas call is reviewable here. Trading stays in the existing consent-protected Command Center. */
export function AtlasCommandSignalPanel({ controller }: { controller: AtlasCommandSignalController }) {
  const { result, busy, error, access, clear } = controller;
  const idea = result?.idea;
  const chart = useMemo(() => idea ? atlasIdeaChart(idea) : null, [idea]);
  if (!controller.supported || (!busy && !result && !error && !access)) return null;
  const trade = !!idea && idea.kind !== "stand_aside" && !!idea.entry && !!idea.stop;
  const insufficient = access?.balance != null && access.balance < access.cost;
  return <section className="om-atlas-command-signal" aria-label="Atlas Command Center signal" data-atlas-command-signal="">
    <header className="om-atlas-command-heading">
      <div><span>ATLAS COMMAND CENTER · GOLD</span><h3>{busy ? "Atlas is reading the market" : idea ? idea.headline : "Generate with Atlas"}</h3></div>
      <button type="button" className="om-atlas-command-close" aria-label="Dismiss Atlas signal" onClick={clear}><X size={17} aria-hidden="true" /></button>
    </header>
    {busy && <p className="om-atlas-command-loading" role="status"><Loader2 size={17} aria-hidden="true" />Checking the live feed, market structure, and the Command Center’s own setup engine…</p>}
    {error && !busy && <p className="om-atlas-command-error" role="alert">{error}</p>}
    {access && !access.active && !busy && <div className="om-atlas-command-access">
      <p>{access.cost} credits opens Command Center for {access.minutes} minutes. Atlas signals are included during that window. Nothing renews automatically.</p>
      {access.balance != null && <small>You have {access.balance} credits.</small>}
      <div className="om-atlas-command-actions">
        <button type="button" disabled={insufficient} onClick={() => void controller.openWindowAndGenerate()}><Sparkles size={15} aria-hidden="true" />Open &amp; generate · {access.cost} credits</button>
        <a href="/portal/credits">View credits<ArrowUpRight size={14} aria-hidden="true" /></a>
      </div>
    </div>}
    {idea && result && !busy && <>
      <div className="om-atlas-command-meta"><span data-side={idea.side ?? "none"}>{idea.badge}</span><span>Generated {time(result.generatedAt)} · {result.saved ? "Saved in Command Center" : "Not saved"}</span></div>
      {result.analysisAt != null && <p className="om-atlas-command-note">Market snapshot: {time(result.analysisAt)}. This call follows Atlas’s own multi-timeframe engine, independently of the chart timeframe selected above.</p>}
      {trade && <>
        <dl className="om-atlas-command-prices">
          <div><dt>{idea.kind === "enter_now" ? "Entry" : "Reference entry"}</dt><dd>{price(idea.entry!.price)}</dd></div>
          <div data-kind="stop"><dt>Stop loss</dt><dd>{price(idea.stop!.price)}</dd></div>
          {idea.targets.slice(0, 3).map((target) => <div key={target.label} data-kind="target"><dt>{target.label}</dt><dd>{price(target.price)}</dd><small>{target.r.toFixed(2)}R</small></div>)}
        </dl>
        <p className="om-atlas-command-trigger">{idea.entry!.text}</p>
      </>}
      {chart && chart.bars.length > 0 && <SignalFocusChart {...chart} priceLive={false} label="Atlas Command Center gold call, with its saved five-minute candles" />}
      <div className="om-atlas-command-reason">{idea.reasoning.split(/\n\n+/).map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div>
      {idea.waitingFor.length > 0 && <p className="om-atlas-command-condition"><b>Waiting for</b>{idea.waitingFor.join(" · ")}</p>}
      {idea.invalidation?.text && <p className="om-atlas-command-condition"><b>Invalidation</b>{idea.invalidation.text}</p>}
      {idea.confirmations.length > 0 && <details className="om-atlas-command-checks"><summary>View the engine’s confirmations<ChevronRight size={15} aria-hidden="true" /></summary><ul>{idea.confirmations.map((check, index) => <li key={index} data-confirmed={check.ok}><Check size={14} aria-hidden="true" /><span>{check.label}{check.detail && <small>{check.detail}</small>}</span></li>)}</ul></details>}
      {idea.warnings.length > 0 && <p className="om-atlas-command-note">{idea.warnings.join(" ")}</p>}
      <p className="om-atlas-command-note">{idea.execute.note} This call reflects its generation time; execution eligibility is rechecked in Command Center.</p>
      <div className="om-atlas-command-actions">
        <button type="button" onClick={() => openAtlas({ question: "Explain this Atlas Command Center gold call, its entry conditions, stop, targets and invalidation. Distinguish a confirmed setup from a conditional idea and use the time of this saved result.", context: atlasCommandSignalContext(result) })}>Explain this signal<ChevronRight size={15} aria-hidden="true" /></button>
        <a href="/command-center">Review in Command Center<ArrowUpRight size={15} aria-hidden="true" /></a>
      </div>
    </>}
  </section>;
}
