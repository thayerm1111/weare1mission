"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Activity, Bell, Check, Copy, Crosshair, Eye, EyeOff, RefreshCw, Sparkles, X } from "lucide-react";
import { H, fmt2, LABEL } from "./theme";
import type { AtlasIdea, IdeaFollow, IdeaState } from "../../../../command-center/engines/idea";

/**
 * GENERATE WITH ATLAS (owner 11-11: "When I click generate I want atlas to give me the trade idea and where
 * I should enter. I want the engine of atlas though to run the trade.")
 *
 * One press, one answer from ATLAS (command-center/engines/idea.ts): which way, where to enter, the stop,
 * the targets, why, and what would make it wrong. There is nothing to choose first and one answer to read
 * (owner 11-12: "not so many options just want an atlas option that goes off what atlas sees. Needs to feel
 * like it's come right from the AI. I don't want the quick, intraday, or swing versions") — so the card
 * leads with ATLAS's own words, in the first person, and the numbers sit under them.
 *
 * NOTHING HERE COMPUTES A NUMBER OR SENDS AN ORDER. Every figure on the card came from the server. Taking an
 * idea hands off to the two execution surfaces that already exist — ATLAS's own trade card when the idea is
 * the setup engine's trade, the order ticket (prefilled) when it is the member's call — so there is still
 * exactly one place an order is confirmed and sent from.
 */

type Update = {
  follow: IdeaFollow;
  now: { price: number | null; lean: string | null; leanLabel: string | null; score: number | null; engine: { state: string; headline: string; side: string | null; style: string | null } | null };
  verdict: string;
};
type ListRow = { id: string; at: number; headline: string; badge: string; kind: string; source: string | null; side: string | null; style: string | null; state: IdeaState | "new"; pips: number | null; text: string | null };
type Record_ = { graded: number; wins: number; losses: number; pips: number; open: number; untriggered: number; since: number | null; total: number };

export type IdeaPrefill = { side: "buy" | "sell"; style: "quick" | "hold" | "swing"; stop: number; takeProfit: number | null; headline: string; reason: string; invalidation: string | null; evidence: string[]; ideaId: string | null };

/** The real stages of one request, in the order the server does them — in ATLAS's words. */
const STAGES = ["Reading the live feed…", "Pulling up my read of the market…", "Checking for a confirmed setup…", "Finding the structure for the stop…", "Writing my call…"];

/**
 * ATLAS's words arrive the way it says them: typed out once, for a call that was just generated. An idea
 * opened from the list, or re-rendered by an update, is simply shown. Nothing here changes the text — the
 * whole call is already on the card for a screen reader, and one tap finishes it.
 */
function useTyped(text: string, run: boolean): { shown: string; typing: boolean; finish: () => void } {
  const [n, setN] = useState(run ? 0 : text.length);
  useEffect(() => {
    const reduce = typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (!run || reduce || !text) { setN(text.length); return; }
    setN(0);
    const started = performance.now();
    const total = Math.min(2600, Math.max(900, text.length * 4));
    let raf = 0;
    const step = (now: number) => {
      const k = Math.min(text.length, Math.ceil(((now - started) / total) * text.length));
      setN((cur) => Math.max(cur, k));
      if (k < text.length) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [text, run]);
  return { shown: text.slice(0, n), typing: n < text.length, finish: () => setN(text.length) };
}
const STATE_WORD: Record<string, { word: string; tone: "up" | "down" | "gold" | "cold" | "mut" }> = {
  new: { word: "Not followed yet", tone: "mut" }, ready: { word: "Entry valid now", tone: "gold" }, waiting: { word: "Waiting for the entry", tone: "cold" },
  in_zone: { word: "Price is in the zone", tone: "gold" }, open: { word: "Entered · undecided", tone: "cold" },
  tp1: { word: "TP1 reached", tone: "up" }, tp2: { word: "TP2 reached", tone: "up" }, tp3: { word: "TP3 reached", tone: "up" },
  stopped: { word: "Stopped", tone: "down" }, invalidated: { word: "Called off", tone: "mut" }, expired: { word: "Expired", tone: "mut" },
  missed: { word: "Entry gone", tone: "mut" }, none: { word: "No trade", tone: "mut" },
};
const toneCol = (t: string) => (t === "up" ? H.green : t === "down" ? H.red : t === "gold" ? H.gold3 : t === "cold" ? H.cyan2 : H.mut);
const hhmm = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
const hhmmss = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

export function IdeaPanel({
  endpoint, replay, runSignal, shown, onShow, onTake, onManual, onAsk, canTrade, riskPct, account,
}: {
  /** "/api/command-center/idea", or the replay endpoint. */
  endpoint: string;
  replay: boolean;
  /** Changes each time GENERATE is pressed anywhere on the desk. */
  runSignal: number;
  /** The id of the idea currently drawn on the chart. */
  shown: string | null;
  /** `byUser` is true only when the member pressed "Show on chart" — a new idea is drawn without being asked. */
  onShow: (idea: AtlasIdea | null, byUser: boolean) => void;
  /** Open ATLAS's own trade card (the setup engine's trade is taken there). */
  onTake: () => void;
  /** Open the order ticket with ATLAS's numbers in it. */
  onManual: (p: IdeaPrefill) => void;
  onAsk: (q: string) => void;
  /** False until the risk disclosure is signed. */
  canTrade: boolean;
  riskPct: number | null;
  account: { equity: number | null; currency: string | null; isLive: boolean } | null;
}) {
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState(0);
  const [idea, setIdea] = useState<AtlasIdea | null>(null);
  const [copyText, setCopyText] = useState("");
  const [meta, setMeta] = useState<{ saved: boolean; totalMs: number | null; analysisAt: number | null; provider: string | null } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [update, setUpdate] = useState<Update | null>(null);
  const [following, setFollowing] = useState<"update" | "result" | null>(null);
  const [watch, setWatch] = useState<{ ok: boolean; message: string } | null>(null);
  const [watching, setWatching] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [list, setList] = useState<{ ideas: ListRow[]; record: Record_ | null; kept: boolean } | null>(null);
  const seq = useRef(0);
  /** The idea whose words are typed out: the one this press of GENERATE just produced. */
  const [fresh, setFresh] = useState<number | null>(null);
  // The desk re-renders every second, so its callbacks are read through a ref: a new function identity
  // must never look like a new press of GENERATE.
  const onShowRef = useRef(onShow);
  onShowRef.current = onShow;
  const handled = useRef(0);

  const post = useCallback(async (body: Record<string, unknown>) => {
    const r = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok && j.ok !== false, status: r.status, j: j as Record<string, unknown> };
  }, [endpoint]);

  const loadList = useCallback(async () => {
    if (replay) return;
    try {
      const r = await fetch(endpoint, { cache: "no-store" });
      if (!r.ok) return;
      const j = await r.json();
      setList({ ideas: j.ideas ?? [], record: j.record ?? null, kept: !!j.kept });
    } catch { /* the list is a convenience */ }
  }, [endpoint, replay]);

  const generate = useCallback(async () => {
    const my = ++seq.current;
    setBusy(true); setErr(null); setUpdate(null); setWatch(null); setStage(0);
    const started = Date.now();
    // The stages advance while the request is actually in flight and stop where it stops; the measured
    // time is printed under the idea.
    const tick = window.setInterval(() => setStage((n) => Math.min(STAGES.length - 2, n + 1)), 190);
    try {
      const { ok, status, j } = await post({ action: "generate" });
      const wait = Math.max(0, 700 - (Date.now() - started));
      await new Promise((res) => window.setTimeout(res, wait));
      if (my !== seq.current) return;
      if (!ok || !j.idea) {
        setErr(status === 401 ? "Sign in to generate with ATLAS." : status === 402 ? "Generating needs an open Command Center window (5 credits for 30 minutes)." : "ATLAS could not generate an idea just now. Try again in a moment.");
        return;
      }
      setStage(STAGES.length - 1);
      const g = j as unknown as { idea: AtlasIdea; saved?: boolean; copy?: string; timings?: { totalMs: number }; analysis?: { analysisAt: number | null }; feed?: { provider: string } };
      setIdea(g.idea); setCopyText(g.copy ?? ""); setFresh(g.idea.at);
      setMeta({ saved: !!g.saved, totalMs: g.timings?.totalMs ?? null, analysisAt: g.analysis?.analysisAt ?? g.idea.snapshotAt ?? null, provider: g.feed?.provider ?? null });
      onShowRef.current(g.idea.kind === "stand_aside" ? null : g.idea, false);
      void loadList();
    } catch {
      if (my === seq.current) setErr("Can't reach the Command Center — check the connection.");
    } finally {
      window.clearInterval(tick);
      if (my === seq.current) setBusy(false);
    }
  }, [post, loadList]);

  // GENERATE pressed anywhere on the desk: one press, one idea.
  useEffect(() => {
    if (runSignal <= 0 || handled.current === runSignal) return;
    handled.current = runSignal;
    void generate();
  }, [runSignal, generate]);
  useEffect(() => { void loadList(); }, [loadList]);

  const follow = useCallback(async (which: "update" | "result", id?: string) => {
    const target = id ?? idea?.id;
    if (!target) return;
    setFollowing(which); setErr(null);
    try {
      const { ok, j } = await post({ action: "follow", id: target });
      if (!ok || !j.update) { setErr(String(j.message ?? "That idea could not be followed just now.")); return; }
      if (j.idea) { setIdea(j.idea as AtlasIdea); setCopyText(String(j.copy ?? "")); if (id) { setMeta(null); setWatch(null); onShowRef.current((j.idea as AtlasIdea).kind === "stand_aside" ? null : (j.idea as AtlasIdea), false); } }
      setUpdate(j.update as Update);
      void loadList();
    } catch { setErr("Can't reach the Command Center — check the connection."); }
    finally { setFollowing(null); }
  }, [idea?.id, post, loadList]);

  const armWatch = useCallback(async () => {
    if (!idea?.id) return;
    setWatching(true);
    try {
      const { j } = await post({ action: "watch", id: idea.id });
      setWatch({ ok: j.ok === true, message: String(j.message ?? (j.ok ? "Watching." : "That watch could not be registered.")) });
    } catch { setWatch({ ok: false, message: "Can't reach the Command Center — the watch was not registered." }); }
    finally { setWatching(false); }
  }, [idea?.id, post]);

  const copy = useCallback((label: string, text: string) => {
    void navigator.clipboard?.writeText(text).then(() => { setCopied(label); window.setTimeout(() => setCopied((c) => (c === label ? null : c)), 1400); }).catch(() => {});
  }, []);

  const trade = idea && idea.kind !== "stand_aside" && idea.entry && idea.stop ? idea : null;
  const up = trade?.side === "buy";
  const sideCol = up ? H.green : H.red;
  const isShown = !!idea && shown === (idea.id ?? "unsaved");
  const canFollow = !!idea?.id && !!trade;
  const execNow = update ? update.follow.canExecute : !!trade?.execute.now;
  const prefill = (): IdeaPrefill | null => trade?.execute.manual ? {
    // The ticket stores the call as one line of text; the paragraph breaks are for this card.
    ...trade.execute.manual, headline: trade.headline, reason: trade.reasoning.replace(/\s*\n+\s*/g, " "), invalidation: trade.invalidation?.text ?? null,
    evidence: trade.confirmations.filter((c) => c.ok).map((c) => c.label).slice(0, 6), ideaId: trade.id,
  } : null;
  const confirmed = idea?.source === "setup_engine";
  const words = useTyped(idea?.reasoning ?? "", !!idea && fresh === idea.at && !busy);
  const paragraphs = words.shown.split("\n\n");

  return (
    <div className="space-y-3" data-idea-panel="">
      {/* ask */}
      <div className="rounded-[10px] p-3" style={{ border: `1px solid ${H.lineHi}`, background: `linear-gradient(180deg, ${H.panel2}, ${H.panel})` }}>
        <p className={LABEL} style={{ color: H.gold2 }}>ATLAS · XAUUSD</p>
        <p className="mt-1 text-[12px] leading-snug" style={{ color: H.mut }}>
          Ask ATLAS what it would do with gold right now. It reads the market and answers with one call: the side, the entry, a stop behind market structure, and its targets.
        </p>
        <button onClick={() => void generate()} disabled={busy} data-generate=""
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-[9px] px-3 py-3 text-[12.5px] font-black uppercase tracking-[0.2em] transition hover:brightness-110 disabled:opacity-60"
          style={{ color: "#1A1305", background: "linear-gradient(180deg, #FFD875, #D5A93D)", boxShadow: "0 0 22px rgba(213,169,61,0.35)" }}>
          <Sparkles className="h-4 w-4" />{busy ? "ATLAS is reading gold…" : idea ? "Generate again" : "Generate"}
        </button>
        <p className="mt-1.5 text-center text-[10px]" style={{ color: H.mut2 }}>{replay ? "Replay — recorded gold, nothing can be executed." : "Included in your Command Center window — no extra credits."}</p>
      </div>

      {/* generating */}
      {busy && (
        <div className="rounded-[10px] p-4" role="status" aria-live="polite" style={{ border: `1px solid ${H.line}`, background: H.panel }} data-idea-busy="">
          <p className={LABEL} style={{ color: H.cyan2 }}>ATLAS</p>
          <p className="mt-1 text-[15px] font-semibold">Reading gold…</p>
          <ul className="mt-3 space-y-2">
            {STAGES.map((s, k) => (
              <li key={s} className="flex items-center gap-2.5 text-[12px]" style={{ color: k < stage ? H.text : k === stage ? H.gold3 : H.mut2 }}>
                <span className="grid h-4 w-4 shrink-0 place-items-center rounded-full" style={{ border: `1px solid ${k < stage ? H.green : k === stage ? H.gold2 : H.line}`, background: k < stage ? "rgba(41,223,166,0.14)" : "transparent" }}>
                  {k < stage ? <Check className="h-2.5 w-2.5" style={{ color: H.green }} /> : k === stage ? <span className="h-1.5 w-1.5 rounded-full" style={{ background: H.gold3 }} /> : null}
                </span>
                {s}
              </li>
            ))}
          </ul>
        </div>
      )}

      {err && !busy && <p role="alert" className="rounded-[8px] px-3 py-2 text-[12px]" style={{ color: H.red, border: `1px solid ${H.red}55`, background: "rgba(255,83,100,0.07)" }}>{err}</p>}

      {/* the idea */}
      {idea && !busy && (
        <div className="hud-in overflow-hidden rounded-[10px]" style={{ border: `1px solid ${trade ? `${sideCol}66` : H.line}`, background: H.panel }} data-idea-kind={idea.kind} data-idea-source={idea.source ?? ""}>
          <div className="px-3 pb-2 pt-3" style={{ background: trade ? `linear-gradient(180deg, ${sideCol}12, transparent)` : "transparent" }}>
            <p className="inline-block rounded-[5px] px-2 py-[3px] text-[8.5px] font-bold uppercase tracking-[0.14em]" data-idea-badge=""
              style={confirmed ? { color: "#1A1305", border: "1px solid rgba(231,196,103,0.9)", background: "linear-gradient(180deg, #FFD875, #D5A93D)" }
                : { color: H.gold3, border: "1px solid rgba(231,196,103,0.6)", background: "rgba(213,169,61,0.12)" }}>
              {idea.badge}
            </p>
            <p className="mt-2 flex flex-wrap items-center gap-2 text-[17px] font-semibold leading-tight" data-idea-headline="">
              {trade && <span className="rounded-[5px] px-2 py-[2px] text-[11px] font-black tracking-[0.12em]" style={{ color: sideCol, border: `1px solid ${sideCol}`, background: `${sideCol}14` }}>{up ? "LONG" : "SHORT"}</span>}
              {idea.headline}
            </p>
            {/* ATLAS, in its own words */}
            <div className="mt-2.5 rounded-[9px] p-3" onClick={words.typing ? words.finish : undefined}
              style={{ border: `1px solid ${H.line}`, borderLeft: `2px solid ${H.gold2}`, background: "rgba(3,7,11,0.55)", cursor: words.typing ? "pointer" : "auto" }}
              data-idea-reasoning="" data-typing={words.typing ? "1" : "0"}>
              <p className="flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-[0.16em]" style={{ color: H.gold2 }}>
                <Sparkles className="h-3 w-3" />ATLAS<span className="font-semibold normal-case tracking-normal" style={{ color: H.mut2 }}>· {hhmm(idea.at)}</span>
              </p>
              <p className="sr-only">{idea.reasoning}</p>
              <div aria-hidden="true" className="mt-1.5 space-y-2 text-[13px] leading-relaxed" style={{ color: "#E4EAF0" }}>
                {paragraphs.map((para, k) => (
                  <p key={k}>
                    {para}
                    {words.typing && k === paragraphs.length - 1 && <span className="ml-[1px] inline-block h-[13px] w-[6px] translate-y-[2px] animate-pulse" style={{ background: H.gold3 }} />}
                  </p>
                ))}
              </div>
            </div>
            {trade && <p className="mt-2 text-[12px] leading-snug" style={{ color: H.mut }} data-idea-entry-text="">{trade.entry!.text}</p>}
          </div>

          {trade && (
            <div className="px-3 pb-3">
              {/* the levels */}
              <div className="grid grid-cols-3 gap-1.5" data-idea-levels="">
                <Cell k="Entry" v={trade.entry!.type === "market" ? fmt2(trade.entry!.price) : `${fmt2(trade.entry!.low)} – ${fmt2(trade.entry!.high)}`}
                  sub={trade.entry!.type === "market" ? "at market" : trade.entry!.confirm === "close_15m" ? "after a 15m close" : trade.entry!.confirm === "touch" ? "on the break" : "the zone"}
                  onCopy={() => copy("Entry", trade.entry!.price.toFixed(2))} copied={copied === "Entry"} />
                <Cell k="Stop" v={fmt2(trade.stop!.price)} sub={`${trade.stop!.pips} pips`} tone={H.red} onCopy={() => copy("Stop", trade.stop!.price.toFixed(2))} copied={copied === "Stop"} />
                <Cell k="Risk : reward" v={trade.rr ? `1 : ${trade.rr.first}` : "—"} sub={trade.rr && trade.rr.best !== trade.rr.first ? `to TP1 · up to 1 : ${trade.rr.best}` : "to TP1"} tone={H.gold3} />
                {trade.targets.map((t) => (
                  <Cell key={t.label} k={t.label} v={fmt2(t.price)} sub={`${t.pips} pips${t.basis === "measured" ? " · measured" : ""}`} tone={H.green} title={t.what}
                    onCopy={() => copy(t.label, t.price.toFixed(2))} copied={copied === t.label} />
                ))}
              </div>
              <p className="mt-1.5 text-[10px]" style={{ color: H.mut2 }}>
                {up ? "Long" : "Short"} · pips are measured from {trade.entry!.type === "market" ? "the entry" : "the worst price in the entry zone"} · tap a level to copy
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <Btn onClick={() => copy("all", copyText)} icon={copied === "all" ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}>{copied === "all" ? "Copied" : "Copy all"}</Btn>
                <Btn onClick={() => onShow(isShown ? null : idea, true)} icon={isShown ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />} active={isShown} data-idea-show="">{isShown ? "Hide on chart" : "Show on chart"}</Btn>
                {canFollow && <Btn onClick={() => void follow("update")} busy={following === "update"} icon={<Activity className="h-3 w-3" />} tone="cyan" data-idea-update="">Get update</Btn>}
                {canFollow && <Btn onClick={() => void follow("result")} busy={following === "result"} icon={<RefreshCw className="h-3 w-3" />} data-idea-result="">Check result</Btn>}
              </div>

              {update && (
                <div className="hud-in mt-2.5 rounded-[8px] p-2.5" style={{ border: `1px solid ${toneCol(STATE_WORD[update.follow.state]?.tone ?? "mut")}55`, background: "rgba(3,7,11,0.5)" }} data-idea-follow={update.follow.state}>
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="rounded-[4px] px-1.5 py-[1px] text-[9px] font-bold uppercase tracking-[0.1em]" style={{ color: toneCol(STATE_WORD[update.follow.state]?.tone ?? "mut"), border: `1px solid ${toneCol(STATE_WORD[update.follow.state]?.tone ?? "mut")}66` }}>{STATE_WORD[update.follow.state]?.word ?? update.follow.state}</span>
                    {update.follow.pips != null && <b className="text-[12px] tabular-nums" style={{ color: update.follow.pips >= 0 ? H.green : H.red }}>{update.follow.pips >= 0 ? "+" : ""}{update.follow.pips} pips</b>}
                    <span className="text-[10px]" style={{ color: H.mut2 }}>as of {hhmmss(update.follow.at)}</span>
                  </p>
                  <p className="mt-1.5 text-[12px] leading-snug" style={{ color: H.text }}>{update.verdict}</p>
                  {update.follow.basis && <p className="mt-1 text-[10px] leading-snug" style={{ color: H.mut2 }}>{update.follow.basis}</p>}
                </div>
              )}

              {/* execute — through ATLAS's own trade flow, never from here */}
              <div className="mt-3 rounded-[9px] p-3" style={{ border: "1px solid rgba(231,196,103,0.3)", background: "rgba(213,169,61,0.04)" }} data-idea-execute={trade.execute.via ?? "none"}>
                <p className={LABEL} style={{ color: H.gold2 }}>Take it · through ATLAS</p>
                <p className="mt-1 text-[11px] leading-snug" style={{ color: H.mut }}>{trade.execute.note}</p>
                {!replay && (riskPct != null || account) && (
                  <p className="mt-1.5 text-[11px] tabular-nums" style={{ color: H.mut }}>
                    {riskPct != null && <>Risk <b style={{ color: H.text }}>{riskPct}%</b> from your ATLAS profile</>}
                    {account?.equity != null && <> · equity <b style={{ color: H.text }}>{account.currency === "USD" || !account.currency ? "$" : `${account.currency} `}{Math.round(account.equity).toLocaleString()}</b>{account.isLive ? <span style={{ color: H.red }}> · LIVE</span> : null}</>}
                    <> · the lot size is worked out when the order is checked</>
                  </p>
                )}
                <div className="mt-2.5 flex flex-wrap gap-2">
                  {replay ? (
                    <span className="text-[11px]" style={{ color: H.gold2 }}>Replay — nothing can be executed or watched here.</span>
                  ) : !canTrade ? (
                    <span className="text-[11px]" style={{ color: H.red }}>Sign the risk disclosure (the red notice at the top) before trading.</span>
                  ) : trade.execute.via === "take_setup" && execNow ? (
                    <button onClick={onTake} data-idea-take="" className="flex-1 rounded-[8px] px-3 py-2.5 text-[11.5px] font-black uppercase tracking-[0.14em]"
                      style={{ color: sideCol, border: `1px solid ${sideCol}`, background: `${sideCol}1A` }}>
                      Take this {up ? "buy" : "sell"} with ATLAS ▸
                    </button>
                  ) : trade.execute.via === "manual" && execNow && prefill() ? (
                    <button onClick={() => { const p = prefill(); if (p) onManual(p); }} data-idea-ticket="" className="flex-1 rounded-[8px] px-3 py-2.5 text-[11.5px] font-black uppercase tracking-[0.14em]"
                      style={{ color: sideCol, border: `1px solid ${sideCol}`, background: `${sideCol}1A` }}>
                      Open the {up ? "buy" : "sell"} ticket, prefilled ▸
                    </button>
                  ) : trade.kind === "enter_now" && !update ? (
                    // An entry at the price with no ticket: the note above says why (gold closed, or the order checks refusing).
                    <span className="inline-flex items-center gap-1.5 rounded-[8px] px-3 py-2 text-[11px] font-semibold" style={{ color: H.mut, border: `1px dashed ${H.line}` }}>
                      <Crosshair className="h-3.5 w-3.5" />No ticket for this one right now
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 rounded-[8px] px-3 py-2 text-[11px] font-semibold" style={{ color: H.mut, border: `1px dashed ${H.line}` }}>
                      <Crosshair className="h-3.5 w-3.5" />Not executable yet — the entry is not here
                    </span>
                  )}
                  {!replay && trade.watch && trade.id && !execNow && (
                    <button onClick={() => void armWatch()} disabled={watching || watch?.ok === true} data-idea-watch="" className="inline-flex items-center gap-1.5 rounded-[8px] px-3 py-2 text-[11px] font-bold uppercase tracking-[0.1em] disabled:opacity-70"
                      style={{ color: H.cyan2, border: "1px solid rgba(39,215,242,0.45)", background: "rgba(0,199,232,0.06)" }}>
                      {watch?.ok ? <Check className="h-3.5 w-3.5" /> : <Bell className="h-3.5 w-3.5" />}{watch?.ok ? "Watching" : watching ? "Registering…" : `Watch ${fmt2(trade.watch.price)}`}
                    </button>
                  )}
                </div>
                {watch && <p className="mt-1.5 text-[11px]" style={{ color: watch.ok ? H.green : H.red }}>{watch.message}</p>}
                <p className="mt-2 text-[10px] leading-snug" style={{ color: H.mut2 }}>
                  Orders are market orders, confirmed on the next screen. The stop and the first target are attached, and ATLAS manages the position by your profile.
                </p>
              </div>

              {/* how sure, where it is aiming, what makes it wrong */}
              <p className="mt-3 text-[11px]" style={{ color: H.mut }} title={trade.confidence?.basis}>
                {confirmed ? "Confidence" : "Conviction"} <b style={{ color: H.text }}>{trade.confidence?.label}</b>
                <span style={{ color: H.mut2 }}> · {trade.confidence?.score}/100 — {confirmed ? "from the evidence and the reward on offer" : "how one-sided the evidence is"}, not a win probability</span>
              </p>
              <div className="mt-2 space-y-1 text-[11.5px]" style={{ color: H.mut }}>
                <p title={trade.stop!.what}><span style={{ color: H.mut2 }}>Stop:</span> {trade.stop!.what}</p>
                {trade.targeting && <p><span style={{ color: H.mut2 }}>Targets:</span> {trade.targeting}</p>}
                {trade.invalidation && <p><span style={{ color: H.mut2 }}>Wrong if:</span> {trade.invalidation.text}</p>}
              </div>

              {trade.confirmations.length > 0 && (
                <div className="mt-3 rounded-[8px] p-2.5" style={{ border: `1px solid ${H.line}` }}>
                  <p className="flex items-center justify-between text-[9px] font-semibold uppercase tracking-[0.14em]" style={{ color: H.mut }}>
                    <span>{confirmed ? "What I needed to see" : "What I'm weighing"}</span>
                    <span style={{ color: H.text }}>{trade.confirmations.filter((c) => c.ok).length} {confirmed ? `of ${trade.confirmations.length} met` : `for · ${trade.confirmations.filter((c) => !c.ok).length} against`}</span>
                  </p>
                  <ul className="mt-1.5 space-y-1">
                    {trade.confirmations.map((c, k) => (
                      <li key={k} className="flex items-start gap-2 text-[11.5px]" title={c.detail ?? undefined}>
                        <span className="mt-[2px] grid h-3.5 w-3.5 shrink-0 place-items-center rounded-full" style={{ background: c.ok ? "rgba(41,223,166,0.14)" : "rgba(255,255,255,0.05)", color: c.ok ? H.green : H.mut2 }}>
                          {c.ok ? <Check className="h-2.5 w-2.5" /> : <X className="h-2.5 w-2.5" />}
                        </span>
                        <span style={{ color: c.ok ? H.text : H.mut }}>{c.label}{c.detail ? <span style={{ color: H.mut2 }}> — {c.detail}</span> : null}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* no trade: where one would be */}
          {!trade && (
            <div className="px-3 pb-3">
              {idea.paths.length > 0 && (
                <div className="mt-1 rounded-[8px] p-2.5" style={{ border: `1px solid ${H.line}` }} data-idea-paths="">
                  <p className="text-[9px] font-semibold uppercase tracking-[0.14em]" style={{ color: H.gold2 }}>Where a trade would be</p>
                  <ul className="mt-1.5 space-y-1.5">
                    {idea.paths.map((p) => (
                      <li key={p.side} className="flex items-start gap-2 text-[11.5px]">
                        <span className="mt-[1px] shrink-0 rounded-[4px] px-1.5 text-[9px] font-bold" style={{ color: p.side === "buy" ? H.green : H.red, border: `1px solid ${p.side === "buy" ? H.green : H.red}66` }}>{p.side === "buy" ? "BUY" : "SELL"}</span>
                        <span className="min-w-0 flex-1" style={{ color: H.text }}>{p.text}</span>
                        {!replay && <button onClick={() => onAsk(`Watch ${p.price.toFixed(2)} and tell me if it breaks ${p.direction}.`)} className="shrink-0 text-[10px] font-bold uppercase tracking-[0.08em]" style={{ color: H.cyan2 }}>Watch</button>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {idea.waitingFor.length > 0 && (
                <div className="mt-2.5">
                  <p className="text-[9px] font-semibold uppercase tracking-[0.14em]" style={{ color: H.mut }}>What ATLAS needs</p>
                  <ul className="mt-1 space-y-0.5 text-[11.5px]" style={{ color: H.text }}>{idea.waitingFor.map((w, k) => <li key={k}>— {w}</li>)}</ul>
                </div>
              )}
              {idea.bias && <p className="mt-2.5 text-[11.5px]" style={{ color: H.mut }}><span style={{ color: H.mut2 }}>HTF bias:</span> {idea.bias}</p>}
            </div>
          )}

          {idea.warnings.length > 0 && (
            <div className="space-y-1 border-t px-3 py-2.5" style={{ borderColor: H.lineSoft }} data-idea-warnings="">
              {idea.warnings.map((w, k) => <p key={k} className="text-[11px] leading-snug" style={{ color: H.gold2 }}>⚠ {w}</p>)}
            </div>
          )}
          <p className="border-t px-3 py-2 text-[10px] leading-snug" style={{ borderColor: H.lineSoft, color: H.mut2 }}>
            {replay ? "REPLAY · recorded gold · " : ""}Gold {idea.price != null ? fmt2(idea.price) : "—"}{meta?.analysisAt ? ` · analysis ${hhmmss(meta.analysisAt)}` : idea.snapshotAt ? ` · analysis ${hhmmss(idea.snapshotAt)}` : ""}
            {meta?.provider ? ` · ${meta.provider} XAU/USD` : ""}{meta?.totalMs != null ? ` · generated in ${meta.totalMs} ms` : ""}
            {idea.expiresAt ? ` · on offer until ${hhmm(idea.expiresAt)}` : ""}{meta && !meta.saved && !replay ? " · not saved, so it can't be followed later" : ""}
            . ATLAS&apos;s analysis — not financial advice.
          </p>
        </div>
      )}

      {/* the record */}
      {!replay && list && list.kept && (list.ideas.length > 0) && (
        <div className="rounded-[10px] p-3" style={{ border: `1px solid ${H.line}`, background: H.panel }} data-idea-list="">
          <p className={LABEL} style={{ color: H.gold2 }}>ATLAS&apos;s calls for you</p>
          {list.record && list.record.graded > 0 ? (
            <p className="mt-1 text-[12px]" data-idea-record="">
              <b className="tabular-nums" style={{ color: H.text }}>{list.record.wins}W · {list.record.losses}L</b>
              <b className="ml-2 tabular-nums" style={{ color: list.record.pips >= 0 ? H.green : H.red }}>{list.record.pips >= 0 ? "+" : ""}{list.record.pips} pips</b>
              <span style={{ color: H.mut2 }}> · {list.record.open} still open · {list.record.untriggered} never entered</span>
            </p>
          ) : (
            <p className="mt-1 text-[11.5px]" style={{ color: H.mut }}>No graded results yet — the record builds as these calls reach a target or a stop.</p>
          )}
          <p className="mt-0.5 text-[10px]" style={{ color: H.mut2 }}>Graded on real candles — a target before the stop is a win. It is the call&apos;s levels against price, not your fills.</p>
          <ul className="mt-2 divide-y" style={{ borderColor: H.lineSoft }}>
            {list.ideas.map((r) => {
              const sw = STATE_WORD[r.state] ?? STATE_WORD.new;
              return (
                <li key={r.id} style={{ borderColor: H.lineSoft }}>
                  <button onClick={() => (r.kind === "stand_aside" ? null : void follow("result", r.id))} disabled={r.kind === "stand_aside"}
                    className="flex w-full items-center gap-2 py-1.5 text-left text-[11.5px] disabled:cursor-default">
                    <span className="w-[74px] shrink-0 tabular-nums" style={{ color: H.mut2 }}>{new Date(r.at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })}</span>
                    <span className="min-w-0 flex-1 truncate" style={{ color: r.kind === "stand_aside" ? H.mut : H.text }}>{r.headline}</span>
                    <span className="shrink-0 text-[10px] font-semibold" style={{ color: toneCol(sw.tone) }}>{sw.word}{r.pips != null ? ` ${r.pips >= 0 ? "+" : ""}${r.pips}` : ""}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

function Cell({ k, v, sub, tone, onCopy, copied, title }: { k: string; v: string; sub?: string; tone?: string; onCopy?: () => void; copied?: boolean; title?: string }) {
  return (
    <button type="button" onClick={onCopy} disabled={!onCopy} title={title ?? (onCopy ? "Tap to copy" : undefined)}
      className="rounded-[8px] px-2.5 py-2 text-left transition enabled:hover:brightness-125 disabled:cursor-default"
      style={{ border: `1px solid ${copied ? H.cyan2 : H.line}`, background: "rgba(3,7,11,0.55)" }}>
      <span className="block text-[8.5px] font-semibold uppercase tracking-[0.14em]" style={{ color: H.mut }}>{copied ? "Copied" : k}</span>
      <span className="mt-0.5 block text-[13.5px] font-semibold tabular-nums leading-tight" style={{ color: tone ?? H.text }}>{v}</span>
      {sub && <span className="block text-[9.5px] tabular-nums" style={{ color: H.mut2 }}>{sub}</span>}
    </button>
  );
}

function Btn({ children, onClick, icon, busy, active, tone = "gold", ...rest }: { children: ReactNode; onClick: () => void; icon?: ReactNode; busy?: boolean; active?: boolean; tone?: "gold" | "cyan" } & Record<`data-${string}`, string>) {
  const c = tone === "cyan" ? H.cyan2 : H.gold2;
  return (
    <button onClick={onClick} disabled={busy} {...rest}
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10.5px] font-semibold transition hover:brightness-125 disabled:opacity-60"
      style={{ color: active ? "#1A1305" : c, border: `1px solid ${c}66`, background: active ? c : `${c}0F` }}>
      {busy ? <RefreshCw className="h-3 w-3 animate-spin" /> : icon}{children}
    </button>
  );
}

export default IdeaPanel;
