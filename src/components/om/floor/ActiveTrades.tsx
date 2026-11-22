"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { ArrowUpRight, Check, ChevronDown, Loader2, RefreshCw, Scissors, ShieldCheck, X } from "lucide-react";
import { useFlowAccount } from "../FlowAccount";
import { priceFor, pairName } from "@/lib/flow/display";
import {
  ACTIVE_TRADE_FRESH_MS,
  type ActiveTrade, type ActiveTradePlan, type ActiveTradesSnapshot,
  type ActiveTradeActionRequest, type ActiveTradeActionResponse,
} from "@/lib/floor/activeTradeTypes";
import "./active-trades.css";

const POLL_MS = 15_000;
const READ_TIMEOUT_MS = 25_000;
const ACTION_TIMEOUT_MS = 65_000;
const RiskConsent = dynamic(() => import("@/components/command-center/RiskConsent").then((module) => module.RiskConsent), { ssr: false });
type Kind = "close" | "partial" | "breakeven";
type Fraction = 0.25 | 0.5;
type Review = {
  scope: string; request: ActiveTradeActionRequest; symbol: string; side: "buy" | "sell";
  account: string; beforeQty: number; qty: number | null; stop: number | null;
};
type Notice = { tone: "good" | "attention"; text: string };
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const lotsText = (qty: number | null) => finite(qty) && qty >= 0 ? `${qty.toLocaleString(undefined, { maximumFractionDigits: 10 })} ${qty === 1 ? "lot" : "lots"}` : "—";
const exactPrice = (symbol: string, value: number | null | undefined) => {
  if (!finite(value)) return "—";
  const usual = priceFor(symbol, value);
  return Number(usual.replace(/,/g, "")) === value ? usual : value.toLocaleString(undefined, { maximumFractionDigits: 10 });
};
const freshAt = (at: string | null | undefined, now: number) => {
  const age = at ? now - Date.parse(at) : NaN;
  return Number.isFinite(age) && age >= -5000 && age <= ACTIVE_TRADE_FRESH_MS;
};
const ago = (at: string | null | undefined, now: number) => {
  const elapsed = at ? now - Date.parse(at) : NaN;
  if (!Number.isFinite(elapsed)) return "time unavailable";
  const seconds = Math.max(0, Math.floor(elapsed / 1000));
  return seconds < 60 ? `${seconds}s ago` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ago` : `${Math.floor(seconds / 3600)}h ago`;
};
const signedPips = (pips: number) => {
  const rounded = Math.round(pips * 100) / 100;
  return `${rounded > 0 ? "+" : rounded < 0 ? "−" : ""}${Math.abs(rounded).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
};
const planShape = (value: unknown): boolean => !!value && typeof value === "object" && typeof (value as ActiveTradePlan).allowed === "boolean";
function positionShape(trade: ActiveTrade): boolean {
  return !!trade && typeof trade.id === "string" && !!trade.id && typeof trade.symbol === "string" && !!trade.symbol
    && (trade.side === "buy" || trade.side === "sell") && finite(trade.qty) && trade.qty > 0
    && typeof trade.revision === "string" && !!trade.revision && !!trade.quote && ["live", "unavailable"].includes(trade.quote.state)
    && !!trade.actions && planShape(trade.actions.close) && planShape(trade.actions.breakeven)
    && Array.isArray(trade.actions.partial) && trade.actions.partial.every((plan) => planShape(plan) && (plan.fraction === 0.25 || plan.fraction === 0.5));
}
function planFor(trade: ActiveTrade, action: Kind, fraction?: Fraction): ActiveTradePlan | null {
  return action === "partial" ? trade.actions.partial.find((plan) => plan.fraction === fraction) ?? null : trade.actions[action];
}
function samePlan(review: Review, trade: ActiveTrade): boolean {
  const plan = planFor(trade, review.request.action, review.request.fraction);
  return trade.revision === review.request.revision && !!plan?.allowed
    && (review.request.action !== "partial" || plan.qty === review.qty)
    && (review.request.action !== "breakeven" || plan.stop === review.stop);
}
function reflected(review: Review, snapshot: ActiveTradesSnapshot): boolean {
  const trade = snapshot.positions.find((item) => item.id === review.request.positionId);
  if (!trade) return true;
  if (review.request.action === "partial") return finite(review.qty) && trade.qty <= review.beforeQty - review.qty + 1e-9;
  if (review.request.action === "breakeven" && finite(trade.stop) && finite(review.stop)) return trade.side === "buy" ? trade.stop >= review.stop : trade.stop <= review.stop;
  return false;
}

/** The selected account's broker positions. Reading and reviewing never send a trade change. */
export function ActiveTrades() {
  const account = useFlowAccount();
  const selected = account?.ov?.account ?? null;
  const scope = selected ? `${selected.environment}:${selected.id}` : "";
  const enabled = !!selected && selected.connection === "connected" && !account?.switching && account?.state !== "off";
  const current = useRef({ scope, enabled, selected });
  current.current = { scope, enabled, selected };
  const mounted = useRef(true), sequence = useRef(0);
  const readRequest = useRef<{ scope: string; controller: AbortController; cancel: () => void } | null>(null);
  const mutation = useRef<{ scope: string; id: string; cancel?: () => void } | null>(null);
  const [stored, setStored] = useState<{ scope: string; data: ActiveTradesSnapshot } | null>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  const [review, setReview] = useState<Review | null>(null);
  const [partialChoice, setPartialChoice] = useState<string | null>(null);
  const [busy, setBusy] = useState<{ scope: string; id: string } | null>(null);
  const [pending, setPending] = useState<Review[]>([]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [needsConsent, setNeedsConsent] = useState(false), [consentOpen, setConsentOpen] = useState(false);
  const data = enabled && stored?.scope === scope ? stored.data : null;
  const dataRef = useRef(data), reviewRef = useRef(review), errorRef = useRef(error), pendingRef = useRef(pending), consentRef = useRef(needsConsent);
  dataRef.current = data; reviewRef.current = review; errorRef.current = error; pendingRef.current = pending; consentRef.current = needsConsent;
  const isCurrent = (key: string) => mounted.current && current.current.enabled && current.current.scope === key;

  const load = useCallback(async (force = false) => {
    const owner = current.current;
    if (!owner.enabled || !owner.selected || !mounted.current) return;
    if (!force && (readRequest.current?.scope === owner.scope || mutation.current?.scope === owner.scope)) return;
    readRequest.current?.cancel();
    const controller = new AbortController(), mine = ++sequence.current;
    setReading(true);
    let timeout: ReturnType<typeof setTimeout> | null = null, timedOut = false;
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => { timedOut = true; controller.abort(); reject(new Error("Broker read timed out")); }, READ_TIMEOUT_MS);
      readRequest.current = { scope: owner.scope, controller, cancel: () => { if (timeout != null) clearTimeout(timeout); controller.abort(); reject(new Error("Read cancelled")); } };
    });
    try {
      const response = await Promise.race([fetch("/api/floor/active-trades", {
        cache: "no-store", signal: controller.signal,
        headers: { "x-floor-account": owner.selected.id, "x-floor-env": owner.selected.environment },
      }), deadline]);
      const answer = await Promise.race([response.json().catch(() => null), deadline]) as ActiveTradesSnapshot | null;
      if (!isCurrent(owner.scope) || mine !== sequence.current) return;
      if (!response.ok || !answer?.ok || answer.accountId !== owner.selected.id || answer.environment !== owner.selected.environment
        || !Array.isArray(answer.positions) || !answer.positions.every(positionShape)
        || new Set(answer.positions.map((trade) => trade.id)).size !== answer.positions.length
        || !["live", "stale", "unavailable"].includes(answer.state)) throw new Error("The selected account’s trades could not be verified.");
      setStored({ scope: owner.scope, data: answer }); setError(null); setNow(Date.now());
      const armed = reviewRef.current;
      if (armed?.scope === owner.scope) {
        const position = answer.positions.find((item) => item.id === armed.request.positionId);
        if (!position || !samePlan(armed, position)) {
          setReview(null); setNotice({ tone: "attention", text: position ? "This trade changed. Review its latest details before confirming." : "The broker no longer lists this trade as open." });
        }
      }
      if (answer.state === "live" && freshAt(answer.observedAt, Date.now())) {
        if (pendingRef.current.some((item) => item.scope === owner.scope && reflected(item, answer))) setNotice({ tone: "good", text: "The broker position has updated. Review the latest trade details before making another change." });
        setPending((before) => before.filter((item) => item.scope !== owner.scope || !reflected(item, answer)));
      }
    } catch {
      if (!isCurrent(owner.scope) || mine !== sequence.current || controller.signal.aborted && !timedOut) return;
      setError(timedOut ? "The broker took too long to respond. Refresh before making a change." : "Could not refresh your broker’s trades. Refresh before making a change.");
    } finally {
      if (timeout != null) clearTimeout(timeout);
      if (readRequest.current?.controller === controller) readRequest.current = null;
      if (isCurrent(owner.scope) && mine === sequence.current) setReading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    setNow(Date.now());
    const clock = setInterval(() => setNow(Date.now()), 5000);
    return () => { mounted.current = false; sequence.current += 1; readRequest.current?.cancel(); mutation.current?.cancel?.(); clearInterval(clock); };
  }, []);
  useEffect(() => {
    sequence.current += 1; readRequest.current?.cancel(); readRequest.current = null;
    setStored(null); setReview(null); setPartialChoice(null); setNotice(null); setError(null); setReading(false); setNeedsConsent(false); setConsentOpen(false);
    if (!enabled) return;
    void load(true);
    const poll = setInterval(() => { if (document.visibilityState === "visible") void load(); }, POLL_MS);
    const visible = () => { if (document.visibilityState === "visible") { setNow(Date.now()); void load(); } };
    document.addEventListener("visibilitychange", visible);
    return () => { sequence.current += 1; readRequest.current?.cancel(); clearInterval(poll); document.removeEventListener("visibilitychange", visible); };
  }, [scope, enabled, load]);

  const snapshotFresh = !!data && data.state === "live" && freshAt(data.observedAt, now) && !error;
  const busyHere = busy?.scope === scope ? busy.id : null;
  const pendingFor = (id: string) => pending.find((item) => item.scope === scope && item.request.positionId === id);
  const canReview = (trade: ActiveTrade, kind: Kind, fraction?: Fraction) => {
    const plan = planFor(trade, kind, fraction);
    return snapshotFresh && !busyHere && !needsConsent && !pendingFor(trade.id) && !!plan?.allowed
      && (kind !== "partial" || finite(plan.qty) && plan.qty > 0 && plan.qty < trade.qty)
      && (kind !== "breakeven" || finite(plan.stop))
      && (kind === "close" || trade.quote.state === "live" && freshAt(trade.quote.at, now));
  };
  function prepare(trade: ActiveTrade, kind: Kind, fraction?: Fraction) {
    if (!selected || !isCurrent(scope) || !canReview(trade, kind, fraction) || !freshAt(data?.observedAt, Date.now())
      || (kind !== "close" && !freshAt(trade.quote.at, Date.now()))) return;
    const plan = planFor(trade, kind, fraction)!;
    setPartialChoice(null); setNotice(null);
    setReview({
      scope, symbol: trade.symbol, side: trade.side, beforeQty: trade.qty,
      account: `${selected.name} · ${selected.environment === "live" ? "Live" : "Demo"} · ${selected.masked}`,
      qty: kind === "close" ? trade.qty : finite(plan.qty) ? plan.qty : null,
      stop: finite(plan.stop) ? plan.stop : null,
      request: { accountId: selected.id, environment: selected.environment, positionId: trade.id, action: kind, ...(fraction ? { fraction } : {}), revision: trade.revision, confirm: true },
    });
  }
  async function confirm(approved: Review) {
    const snapshot = dataRef.current, owner = current.current;
    const position = snapshot?.positions.find((item) => item.id === approved.request.positionId);
    if (!isCurrent(approved.scope) || reviewRef.current !== approved || mutation.current?.scope === approved.scope || !snapshot || snapshot.state !== "live"
      || errorRef.current || consentRef.current || !freshAt(snapshot.observedAt, Date.now()) || !position || !samePlan(approved, position)
      || pendingRef.current.some((item) => item.scope === approved.scope && item.request.positionId === approved.request.positionId)
      || (approved.request.action !== "close" && (position.quote.state !== "live" || !freshAt(position.quote.at, Date.now())))) return;
    const operation: { scope: string; id: string; cancel?: () => void } = { scope: approved.scope, id: approved.request.positionId };
    mutation.current = operation; setBusy(operation); setNotice(null);
    let result: ActiveTradeActionResponse | null = null;
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => { controller.abort(); reject(new Error("Action answer timed out")); }, ACTION_TIMEOUT_MS);
      operation.cancel = () => { if (timeout != null) clearTimeout(timeout); controller.abort(); reject(new Error("View closed")); };
    });
    try {
      const response = await Promise.race([fetch("/api/floor/active-trades/action", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(approved.request), signal: controller.signal,
      }), deadline]);
      result = await Promise.race([response.json().catch(() => null), deadline]) as ActiveTradeActionResponse | null;
      // Authentication/configuration can refuse before the route has parsed a position identity.
      if (!response.ok && result?.ok === false && result.state === "refused" && !result.accountId && [400, 401, 403, 503].includes(response.status)) {
        result = { ...approved.request, ok: false, state: "refused", message: result.message || "The request was refused before reaching the broker.", needsConsent: result.needsConsent };
      } else if (result?.accountId !== approved.request.accountId || result.environment !== approved.request.environment
        || result.positionId !== approved.request.positionId || result.action !== approved.request.action
        || result.state === "confirmed" && (!response.ok || result.ok !== true)) result = null;
    } catch { /* A lost answer may follow a successful broker operation. Do not repeat it. */ }
    finally {
      if (timeout != null) clearTimeout(timeout);
      if (mutation.current === operation) mutation.current = null;
      if (isCurrent(owner.scope)) setBusy((value) => value === operation ? null : value);
    }
    if (!mounted.current) return;
    if (!result || result.state === "pending" || result.state !== "confirmed" && result.state !== "refused") {
      setPending((before) => [...before.filter((item) => item.scope !== approved.scope || item.request.positionId !== approved.request.positionId), approved]);
    }
    if (!isCurrent(approved.scope)) return;
    setReview(null);
    if (result?.ok && result.state === "confirmed") {
      setNotice({ tone: "good", text: result.message || "The broker confirmed this trade change." });
      setStored((before) => before?.scope === approved.scope ? { ...before, data: { ...before.data, state: "stale", note: "Updating broker positions…" } } : before);
      window.dispatchEvent(new CustomEvent("om:flow-trades-changed"));
      void account?.refresh();
    } else if (result?.state === "refused") {
      setNotice({ tone: "attention", text: result.message || "The broker did not accept this change. Refresh and review the trade again." });
      setError("Refresh this trade before making another change.");
      if (result.needsConsent) setNeedsConsent(true);
    } else {
      setNotice({ tone: "attention", text: result?.message || "The request was sent, but its outcome is not confirmed. Refresh to check the broker; this request will not be sent again automatically." });
    }
    void load(true);
  }

  if (!account || account.state === "off") return null;
  const waiting = account.switching || account.state === "loading" || enabled && !data && !error;
  const scopeLabel = selected ? `${selected.name} · ${selected.environment === "live" ? "Live" : "Demo"} · ${selected.masked}` : "Your selected FLOW account";
  return (
    <section className="om-active-trades" aria-label="Active trades" aria-busy={waiting}>
      <header className="om-active-heading">
        <div><span className="om-active-kicker">Your account</span><h2>Active trades{snapshotFresh && <span>{data!.positions.length}</span>}</h2><p data-no-i18n translate="no">{scopeLabel}</p></div>
        <button type="button" className="om-active-refresh" aria-label="Refresh active trades" disabled={!enabled || reading || !!busyHere} onClick={() => void load(true)}>{reading ? <Loader2 className="animate-spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}</button>
      </header>
      {notice && <p className="om-active-notice" data-tone={notice.tone} role="status">{notice.tone === "good" && <Check aria-hidden="true" />}{notice.text}</p>}
      {needsConsent && <button type="button" className="om-active-consent-link" onClick={() => setConsentOpen(true)}>Review risk disclosure<ArrowUpRight aria-hidden="true" /></button>}
      {error && <p className="om-active-notice" data-tone="attention" role="alert">{error}</p>}
      {waiting ? <p className="om-active-empty" role="status">{account.switching ? "Reading the selected account…" : "Reading your broker’s open trades…"}</p>
        : !selected ? <p className="om-active-empty">Connect an account in <a href="/portal/trading?view=flow">FLOW<ArrowUpRight aria-hidden="true" /></a> to see its active trades.</p>
          : !enabled ? <p className="om-active-empty">Reconnect this account in <a href="/portal/trading?view=flow">FLOW<ArrowUpRight aria-hidden="true" /></a> to read its trades.</p>
            : data && data.positions.length === 0 ? <p className="om-active-empty">{snapshotFresh ? "No open trades on this account." : "Open trades could not be confirmed. Refresh the broker reading."}</p> : null}
      {data && data.positions.length > 0 && <>
        <div className="om-active-feed"><span>{snapshotFresh ? `Broker updated ${ago(data.observedAt, now)}` : `Last broker reading · ${ago(data.observedAt, now)}`}</span>{data.note && <span>{data.note}</span>}</div>
        <div className="om-active-grid">
          {data.positions.map((trade) => {
            const quoteFresh = snapshotFresh && trade.quote.state === "live" && freshAt(trade.quote.at, now);
            const currentPrice = trade.side === "buy" ? trade.quote.bid : trade.quote.ask;
            const hasPips = finite(trade.pips) && finite(currentPrice) && currentPrice > 0 && !!trade.quote.at && Number.isFinite(Date.parse(trade.quote.at)), pendingTrade = pendingFor(trade.id);
            const pipsTone = quoteFresh && hasPips ? trade.pips! > 0 ? "positive" : trade.pips! < 0 ? "negative" : "neutral" : "neutral";
            const partials = trade.actions.partial.filter((plan) => plan.fraction === 0.25 || plan.fraction === 0.5);
            const partialEnabled = partials.some((plan) => canReview(trade, "partial", plan.fraction));
            const reasons = new Map<string, string[]>();
            const explain = (label: string, reason: string | null | undefined) => { if (reason) reasons.set(reason, [...(reasons.get(reason) ?? []), label]); };
            if (!partials.some((plan) => plan.allowed)) explain("Partial", partials.find((plan) => plan.reason)?.reason || "Partial closing is unavailable for this position.");
            else if (snapshotFresh && !quoteFresh) explain("Partial", "A fresh broker quote is required.");
            if (!trade.actions.breakeven.allowed) explain("Breakeven", trade.actions.breakeven.reason);
            else if (snapshotFresh && !quoteFresh) explain("Breakeven", "A fresh broker quote is required.");
            if (!trade.actions.close.allowed) explain("Close", trade.actions.close.reason);
            const armed = review?.scope === scope && review.request.positionId === trade.id ? review : null;
            const reviewAllowed = !!armed && canReview(trade, armed.request.action, armed.request.fraction) && samePlan(armed, trade);
            const operationLabel = armed?.request.action === "close" ? "Close trade" : armed?.request.action === "partial" ? `Take ${Math.round((armed.request.fraction ?? 0) * 100)}% partial` : "Move stop to breakeven";
            return <article className="om-active-card" key={trade.id} aria-label={`${pairName(trade.symbol)} ${trade.side} trade ${trade.id.slice(-6)}`} aria-busy={busyHere === trade.id}>
              <header><div><h3 data-no-i18n translate="no">{pairName(trade.symbol)}</h3><span className="om-active-side" data-side={trade.side}>{trade.side === "buy" ? "BUY" : "SELL"}</span></div><span data-no-i18n translate="no">{lotsText(trade.qty)}<small>Trade · {trade.id.slice(-6)}</small></span></header>
              <div className="om-active-running" data-tone={pipsTone}>
                <strong data-no-i18n translate="no">{account.hide ? "••••" : hasPips ? signedPips(trade.pips!) : "—"}<span>pips</span></strong>
                <span>{quoteFresh && hasPips ? "Running · before costs" : hasPips ? "Last quote · not live" : "Pips unavailable"}</span>
              </div>
              <dl className="om-active-levels" data-no-i18n translate="no">
                <div><dt>Entry</dt><dd>{exactPrice(trade.symbol, trade.entry)}</dd></div>
                <div><dt>{trade.side === "buy" ? "Bid" : "Ask"}{!quoteFresh ? " · last" : ""}</dt><dd>{exactPrice(trade.symbol, currentPrice)}</dd></div>
                <div><dt>Stop</dt><dd>{exactPrice(trade.symbol, trade.stop)}</dd></div>
                <div><dt>Target</dt><dd>{exactPrice(trade.symbol, trade.target)}</dd></div>
              </dl>
              <p className="om-active-quote">{trade.quote.state === "live" && trade.quote.at ? `${quoteFresh ? "Broker quote" : "Last quote"} · ${ago(trade.quote.at, now)}` : "Live broker quote unavailable"}</p>
              {pendingTrade ? <p className="om-active-pending" role="status">Waiting for broker confirmation. Refresh to check this trade before making another change.</p> : <>
                <div className="om-active-actions">
                  <button type="button" disabled={!partialEnabled} aria-expanded={partialChoice === trade.id} onClick={() => { if (partialEnabled) { setReview(null); setPartialChoice((value) => value === trade.id ? null : trade.id); } }}><Scissors aria-hidden="true" />Take partial<ChevronDown aria-hidden="true" /></button>
                  <button type="button" disabled={!canReview(trade, "breakeven")} aria-expanded={armed?.request.action === "breakeven"} title={trade.actions.breakeven.reason ?? undefined} onClick={() => prepare(trade, "breakeven")}><ShieldCheck aria-hidden="true" />Breakeven</button>
                  <button type="button" data-danger disabled={!canReview(trade, "close")} aria-expanded={armed?.request.action === "close"} title={trade.actions.close.reason ?? undefined} onClick={() => prepare(trade, "close")}><X aria-hidden="true" />Close trade</button>
                </div>
                {partialChoice === trade.id && <div className="om-active-partials" role="group" aria-label={`Partial size for ${pairName(trade.symbol)}`}>
                  {partials.map((plan) => <button key={plan.fraction} type="button" disabled={!canReview(trade, "partial", plan.fraction)} title={plan.reason ?? undefined} onClick={() => prepare(trade, "partial", plan.fraction)}>Take {Math.round(plan.fraction * 100)}%<span>{finite(plan.qty) ? lotsText(plan.qty) : plan.reason || "Unavailable"}</span></button>)}
                </div>}
                {[...reasons.entries()].map(([reason, labels]) => <p className="om-active-help" key={reason}>{labels.length === 3 ? "Trade changes" : labels.join(" / ")}: {reason}</p>)}
              </>}
              {armed && <section className="om-active-review" aria-label={`Review ${operationLabel.toLowerCase()}`}>
                <h4>{operationLabel}</h4><p data-no-i18n translate="no">{armed.account}</p>
                <p>{armed.request.action === "breakeven" ? <>Set the stop on this {armed.side.toUpperCase()} {pairName(armed.symbol)} trade to <strong>{exactPrice(armed.symbol, armed.stop)}</strong>. This includes the 5-pip protection buffer, before costs. The target stays unchanged.</>
                  : <>Close <strong>{lotsText(armed.qty)}</strong> of this {armed.side.toUpperCase()} {pairName(armed.symbol)} trade at the broker’s available market price.{armed.request.action === "partial" && <> Remaining: <strong>{lotsText(Math.max(0, armed.beforeQty - (armed.qty ?? 0)))}</strong>.</>}</>}</p>
                {!reviewAllowed && !busyHere && <p className="om-active-review-warning">Refresh the trade and review its current details before confirming.</p>}
                <div><button type="button" className="om-active-confirm" data-danger={armed.request.action === "close" || undefined} disabled={!reviewAllowed || !!busyHere} onClick={() => void confirm(armed)}>{busyHere === trade.id ? <><Loader2 className="animate-spin" aria-hidden="true" />Sending…</> : `Confirm ${armed.request.action === "close" ? "close" : armed.request.action === "partial" ? `${Math.round((armed.request.fraction ?? 0) * 100)}% partial` : "breakeven"}`}</button><button type="button" disabled={!!busyHere} onClick={() => setReview(null)}>Cancel</button></div>
              </section>}
            </article>;
          })}
        </div>
      </>}
      {consentOpen && <div className="om-active-consent"><RiskConsent open onClose={() => setConsentOpen(false)} onSigned={() => { setNeedsConsent(false); setConsentOpen(false); setReview(null); setNotice({ tone: "good", text: "Disclosure saved. Review the trade again when you are ready." }); void load(true); }} /></div>}
    </section>
  );
}
