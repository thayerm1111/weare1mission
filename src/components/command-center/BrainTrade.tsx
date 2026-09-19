"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Brain, Check, ChevronDown, Minus, Sliders, X } from "lucide-react";

/**
 * THE BRAIN'S TRADE — the primary trading surface.
 *
 * The old surface asked the member to pick a side, a style, a stop and a target, and then had THE BRAIN
 * grade the result. That is a trade ticket with an opinion bolted on, and it puts the analysis back on
 * the person who came here precisely so they would not have to do it.
 *
 * This card inverts that. THE BRAIN says what it sees — nothing, a developing idea, or a complete trade
 * with an entry, a stop, objectives and a reason — and the member's job is to approve it or not. The
 * building-your-own path still exists, because some members want it, but it lives behind a link and it
 * is no longer what the product is about.
 *
 * NOTHING HERE COMPUTES ANYTHING. Every number on this card came from the server, from the same engine
 * that would execute the trade. A card that did its own arithmetic could disagree with the order that
 * gets sent, and the member would have no way to tell which of the two was lying.
 */

const C = {
  panel: "#0A0E15", raised: "#0E131C", line: "rgba(255,255,255,0.07)",
  text: "#E8EFF7", mut: "rgba(232,239,247,0.56)", mut2: "rgba(232,239,247,0.34)",
  gold: "#F0C475", up: "#3FD9A0", down: "#F4737B", cold: "#6FA8DC", amber: "#E9B949",
};

export type SetupView = {
  state: string;
  side: "buy" | "sell" | null;
  style: string | null;
  strategy: string | null;
  styleWhy: string | null;
  entryLow: number | null;
  entryHigh: number | null;
  stop: number | null;
  initialObjective: number | null;
  extendedObjective: number | null;
  stopPips: number | null;
  expectedMovePips: [number, number] | null;
  conditions: { id: string; text: string; met: boolean; detail: string; trigger: boolean }[];
  metCount: number;
  totalCount: number;
  confidence: number;
  thesis: string | null;
  invalidation: string | null;
  invalidationPrice: number | null;
  waitingFor: string[];
  say: string;
  headline: string;
  blockedBy: string | null;
};

export type ProfileView = {
  riskPct: number;
  allowQuick: boolean;
  allowHold: boolean;
  allowSwing: boolean;
  minConfidence: number;
  allowBreakEven: boolean;
  allowPartials: boolean;
  allowProfitProtection: boolean;
  allowFullClose: boolean;
  autoManagement: boolean;
  autoEntry: boolean;
  maxDailyLossPct: number;
  maxConsecutiveLosses: number;
  configured: boolean;
};

const STATE_TONE: Record<string, string> = {
  trade_ready: C.gold,
  waiting_for_trigger: C.cold,
  setup_developing: C.cold,
  watching: C.mut,
  no_setup: C.mut2,
  blocked: C.mut2,
  setup_expired: C.mut2,
  setup_invalidated: C.down,
};

const money = (n: number | null | undefined, cur?: string | null) =>
  n == null ? "—" : `${cur === "USD" || !cur ? "$" : `${cur} `}${Math.round(n).toLocaleString()}`;

/* ══════════════════════ THE BRAIN'S TRADE ══════════════════════ */

export function BrainTradeCard({
  setup, profile, account, idempotencyKey, marketOpen, onChanged, onOpenManual, onOpenProfile,
}: {
  setup: SetupView | null;
  profile: ProfileView | null;
  account: { equity: number | null; currency: string | null; isLive: boolean; liveAuthorized: boolean } | null;
  idempotencyKey: string | null;
  marketOpen: boolean;
  onChanged: () => void;
  onOpenManual: () => void;
  onOpenProfile: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [showWhy, setShowWhy] = useState(false);

  // The key is captured the moment a READY card first renders, not when the button is pressed — that is
  // what makes a double-tap, a retry and a refresh all mean the same single order.
  const key = useRef<string | null>(null);
  const ready = setup?.state === "trade_ready";
  useEffect(() => {
    if (ready && !key.current && idempotencyKey) key.current = idempotencyKey;
    if (!ready) { key.current = null; setResult(null); }
  }, [ready, idempotencyKey]);

  const take = useCallback(async () => {
    if (!setup?.side || !setup.stop || !key.current) return;
    setBusy(true); setResult(null);
    try {
      const r = await fetch("/api/command-center/trade", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "take_setup",
          confirm: true,
          idempotencyKey: key.current,
          approved: {
            side: setup.side, style: setup.style, stop: setup.stop,
            invalidationPrice: setup.invalidationPrice,
          },
        }),
      });
      const j = await r.json();
      const msg = j.execution?.message ?? j.message ?? (j.ok ? "Order sent." : "That didn't go through.");
      setResult({ ok: !!j.ok, message: msg });
      onChanged();
    } catch {
      setResult({ ok: false, message: "Could not reach the Command Center." });
    } finally { setBusy(false); }
  }, [setup, onChanged]);

  const pass = useCallback(async () => {
    setBusy(true);
    try {
      await fetch("/api/command-center/trade", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "pass_setup", reason: "Passed on the card." }),
      });
      setResult({ ok: true, message: "Noted — I'll keep watching." });
      onChanged();
    } catch { /* passing is a note to ourselves; a failure is not worth an alarm */ }
    finally { setBusy(false); }
  }, [onChanged]);

  const riskAmount = useMemo(() => {
    if (!profile || account?.equity == null) return null;
    return (account.equity * profile.riskPct) / 100;
  }, [profile, account]);

  const tone = STATE_TONE[setup?.state ?? "no_setup"] ?? C.mut;
  const long = setup?.side === "buy";
  const rToFirst = setup?.expectedMovePips && setup.stopPips
    ? +(setup.expectedMovePips[0] / setup.stopPips).toFixed(1) : null;

  return (
    <section className="overflow-hidden rounded-2xl border" style={{ borderColor: ready ? "rgba(240,196,117,0.30)" : C.line, background: C.panel }}>
      <div className="flex items-center justify-between gap-2 border-b px-3.5 py-2.5" style={{ borderColor: C.line }}>
        <p className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.18em]" style={{ color: tone }}>
          <Brain className="h-3.5 w-3.5" /> {setup?.headline ?? "THE BRAIN"}
        </p>
        <div className="flex items-center gap-2">
          {setup && setup.confidence > 0 && (
            <span className="text-[10px] tabular-nums uppercase tracking-[0.12em]" style={{ color: C.mut2 }}>
              conviction {setup.confidence}
            </span>
          )}
          <button onClick={onOpenProfile} aria-label="Trading profile"
            className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.1em]"
            style={{ background: "rgba(255,255,255,0.04)", color: C.mut2, border: `1px solid ${C.line}` }}>
            <Sliders className="h-3 w-3" /> {profile ? `${profile.riskPct}%` : "risk"}
          </button>
        </div>
      </div>

      {/* what THE BRAIN says — always present, whatever the state */}
      <div className="px-3.5 py-3">
        <p className="text-[13.5px] leading-relaxed" style={{ color: C.text }}>
          {marketOpen === false
            ? "Gold is closed. I'll start looking again when it reopens."
            : setup?.say ?? "Reading the market."}
        </p>

        {!!setup?.waitingFor?.length && !ready && (
          <div className="mt-2.5">
            <p className="mb-1 text-[10px] font-bold uppercase tracking-[0.16em]" style={{ color: C.mut2 }}>
              What I&#39;m waiting for
            </p>
            <ul className="space-y-0.5">
              {setup.waitingFor.map((w, i) => (
                <li key={i} className="flex gap-2 text-[12px]" style={{ color: C.mut }}>
                  <Minus className="mt-[5px] h-2.5 w-2.5 shrink-0" style={{ color: C.mut2 }} />{w}
                </li>
              ))}
            </ul>
          </div>
        )}

        {setup?.blockedBy && (
          <p className="mt-2 text-[11.5px]" style={{ color: C.amber }}>{setup.blockedBy}</p>
        )}
      </div>

      {/* the conditions ladder — the thing that makes the system feel alive while it waits */}
      {!!setup?.conditions?.length && (
        <div className="border-t px-3.5 py-3" style={{ borderColor: C.line }}>
          <div className="mb-2 flex items-baseline justify-between">
            <p className="text-[10px] font-bold uppercase tracking-[0.16em]" style={{ color: C.mut2 }}>What has to be true</p>
            <span className="text-[11px] font-bold tabular-nums" style={{ color: setup.metCount === setup.totalCount ? C.gold : C.mut2 }}>
              {setup.metCount} / {setup.totalCount} confirmed
            </span>
          </div>
          <ul className="space-y-1.5">
            {setup.conditions.map((c) => (
              <li key={c.id} className="flex items-start gap-2">
                <span className="mt-[2px] grid h-3.5 w-3.5 shrink-0 place-items-center rounded-full"
                  style={{
                    background: c.met ? "rgba(63,217,160,0.16)" : "rgba(255,255,255,0.05)",
                    border: `1px solid ${c.met ? "rgba(63,217,160,0.42)" : C.line}`,
                  }}>
                  {c.met ? <Check className="h-2.5 w-2.5" style={{ color: C.up }} /> : null}
                </span>
                <span className="min-w-0">
                  <span className="text-[12.5px]" style={{ color: c.met ? C.text : C.mut }}>{c.text}</span>
                  <span className="block text-[11px]" style={{ color: C.mut2 }}>{c.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* the trade itself */}
      {setup?.side && setup.stop != null && (
        <div className="border-t px-3.5 py-3" style={{ borderColor: C.line, background: ready ? "rgba(240,196,117,0.035)" : "transparent" }}>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-[16px] font-black tracking-tight" style={{ color: long ? C.up : C.down }}>
              {long ? "BUY" : "SELL"} XAUUSD
            </span>
            <span className="rounded-full px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.12em]"
              style={{ background: "rgba(240,196,117,0.10)", color: C.gold, border: "1px solid rgba(240,196,117,0.26)" }}>
              {String(setup.style).toUpperCase()}
            </span>
            {rToFirst != null && (
              <span className="text-[11.5px] tabular-nums" style={{ color: C.mut2 }}>{rToFirst}R to the first objective</span>
            )}
          </div>

          <div className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[12px] tabular-nums sm:grid-cols-4">
            <Stat label="Entry" value={setup.entryLow === setup.entryHigh ? setup.entryLow?.toFixed(2) : `${setup.entryLow?.toFixed(2)}–${setup.entryHigh?.toFixed(2)}`} />
            <Stat label="Stop" value={`${setup.stop.toFixed(2)}`} sub={`${setup.stopPips} pips`} tone={C.down} />
            <Stat label="First objective" value={setup.initialObjective?.toFixed(2)} sub={setup.expectedMovePips ? `${setup.expectedMovePips[0]} pips` : undefined} tone={C.up} />
            <Stat label="Extended" value={setup.extendedObjective?.toFixed(2)} sub={setup.expectedMovePips ? `${setup.expectedMovePips[1]} pips` : undefined} tone={C.up} />
          </div>

          {profile && (
            <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px]" style={{ color: C.mut2 }}>
              <span>Risk <span className="font-bold tabular-nums" style={{ color: C.text }}>{profile.riskPct}%</span></span>
              {riskAmount != null && <span>≈ <span className="font-bold tabular-nums" style={{ color: C.text }}>{money(riskAmount, account?.currency)}</span> if it stops</span>}
              {account?.equity != null && <span>on {money(account.equity, account.currency)}</span>}
              <span>Lot size calculated at the broker&#39;s own contract spec</span>
            </div>
          )}

          <button onClick={() => setShowWhy((v) => !v)}
            className="mt-2.5 inline-flex items-center gap-1 text-[11px] font-bold uppercase tracking-[0.12em]"
            style={{ color: C.mut2 }}>
            Why <ChevronDown className="h-3 w-3" style={{ transform: showWhy ? "rotate(180deg)" : "none", transition: "transform .2s" }} />
          </button>
          {showWhy && (
            <div className="mt-1.5 space-y-1.5">
              {setup.thesis && <p className="text-[12.5px] leading-relaxed" style={{ color: C.mut }}>{setup.thesis}</p>}
              {setup.styleWhy && <p className="text-[12px] leading-relaxed" style={{ color: C.mut2 }}>{setup.styleWhy}</p>}
              {setup.invalidation && (
                <p className="text-[12px] leading-relaxed" style={{ color: C.down }}>
                  What would cancel it: {setup.invalidation}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {result && (
        <div className="border-t px-3.5 py-2.5 text-[12px]" style={{
          borderColor: C.line,
          background: result.ok ? "rgba(63,217,160,0.07)" : "rgba(233,185,73,0.07)",
          color: result.ok ? C.up : C.amber,
        }}>
          {result.message}
        </div>
      )}

      {/* the action */}
      <div className="flex flex-wrap items-center gap-2 border-t px-3.5 py-3" style={{ borderColor: C.line }}>
        {ready ? (
          <>
            <button onClick={() => void take()} disabled={busy || !account || (account.isLive && !account.liveAuthorized)}
              className="flex-1 rounded-xl px-3 py-3 text-[12px] font-black uppercase tracking-[0.16em] disabled:opacity-40"
              style={{
                background: long ? "rgba(63,217,160,0.16)" : "rgba(244,115,123,0.16)",
                color: long ? C.up : C.down,
                border: `1px solid ${long ? "rgba(63,217,160,0.38)" : "rgba(244,115,123,0.38)"}`,
              }}>
              {busy ? "Sending…" : "Take this trade"}
            </button>
            <button onClick={() => void pass()} disabled={busy}
              className="rounded-xl px-3.5 py-3 text-[11px] font-bold uppercase tracking-[0.14em] disabled:opacity-40"
              style={{ background: "rgba(255,255,255,0.04)", color: C.mut2, border: `1px solid ${C.line}` }}>
              Pass
            </button>
          </>
        ) : (
          <p className="text-[11px] uppercase tracking-[0.14em]" style={{ color: C.mut2 }}>
            {setup?.state === "waiting_for_trigger" ? "Waiting for the trigger — nothing for you to do"
              : setup?.state === "setup_developing" ? "Setup developing"
              : setup?.state === "watching" ? "Watching"
              : "THE BRAIN is watching"}
          </p>
        )}
      </div>

      <div className="flex justify-end border-t px-3.5 py-2" style={{ borderColor: C.line }}>
        <button onClick={onOpenManual}
          className="text-[10.5px] font-bold uppercase tracking-[0.12em] underline decoration-dotted underline-offset-4"
          style={{ color: C.mut2 }}>
          Build my own trade
        </button>
      </div>

      {account?.isLive && !account.liveAuthorized && (
        <p className="border-t px-3.5 py-2 text-[11px]" style={{ borderColor: C.line, color: C.amber }}>
          This is a LIVE account. Authorise live trading on it before THE BRAIN can send anything.
        </p>
      )}
    </section>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value?: string | null; sub?: string; tone?: string }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-[0.14em]" style={{ color: C.mut2 }}>{label}</p>
      <p className="text-[13px] font-bold" style={{ color: tone ?? C.text }}>{value ?? "—"}</p>
      {sub && <p className="text-[10.5px]" style={{ color: C.mut2 }}>{sub}</p>}
    </div>
  );
}

/* ══════════════════════ TRADE COMPLETE ══════════════════════ */

export type CompletedView = {
  at: number; side: "buy" | "sell"; style: string; pips: number; r: number | null; money: number | null;
  mfePips: number; maePips: number; heldMs: number; entry: number; exit: number; say: string;
  grade?: {
    score: number; verdict: string; capture: number | null; lesson: string | null;
    lines: { what: string; mark: string | null; note: string }[];
  } | null;
};

const MARK_TONE: Record<string, string> = {
  excellent: C.up, good: C.up, acceptable: C.amber, poor: C.down,
};

/**
 * What happened, shown for a few minutes and then let go.
 *
 * Deliberately NOT a modal and NOT a page: the trade is over, the market is still there, and the screen
 * should say so without demanding the member dismiss something.
 */
export function TradeCompleteCard({ c }: { c: CompletedView }) {
  const won = c.pips > 0;
  const mins = Math.max(1, Math.round(c.heldMs / 60_000));
  return (
    <section className="overflow-hidden rounded-2xl border"
      style={{ borderColor: won ? "rgba(63,217,160,0.28)" : "rgba(244,115,123,0.26)", background: C.panel }}>
      <div className="border-b px-3.5 py-2.5" style={{ borderColor: C.line }}>
        <p className="text-[10px] font-bold uppercase tracking-[0.18em]" style={{ color: won ? C.up : C.down }}>Trade complete</p>
      </div>
      <div className="px-3.5 py-3">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <span className="text-[15px] font-black tracking-tight" style={{ color: c.side === "buy" ? C.up : C.down }}>
            {c.side === "buy" ? "BUY" : "SELL"} XAUUSD
          </span>
          <span className="text-2xl font-black tabular-nums" style={{ color: won ? C.up : C.down }}>
            {c.pips >= 0 ? "+" : ""}{Math.round(c.pips)} <span className="text-[11px] font-bold" style={{ color: C.mut2 }}>PIPS</span>
          </span>
          {c.r != null && <span className="text-[14px] font-bold tabular-nums" style={{ color: won ? C.up : C.down }}>{c.r >= 0 ? "+" : ""}{c.r}R</span>}
          {c.money != null && <span className="text-[14px] font-bold tabular-nums" style={{ color: won ? C.up : C.down }}>{c.money >= 0 ? "+" : "−"}${Math.abs(c.money).toFixed(0)}</span>}
          <span className="text-[11.5px] uppercase tracking-[0.12em]" style={{ color: C.mut2 }}>{String(c.style).toUpperCase()} · {mins} min</span>
        </div>
        <p className="mt-2 text-[12.5px] leading-relaxed" style={{ color: C.mut }}>{c.say}</p>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] tabular-nums" style={{ color: C.mut2 }}>
          <span>In {c.entry.toFixed(2)}</span>
          <span>Out {c.exit.toFixed(2)}</span>
          <span>Best +{Math.round(c.mfePips)}</span>
          <span>Worst {Math.round(c.maePips)}</span>
          {c.grade?.capture != null && <span>Kept {Math.round(c.grade.capture * 100)}% of the move</span>}
        </div>
      </div>

      {/*
        HOW IT WAS TRADED, which is a different question from how it turned out — and the only one worth
        carrying into the next trade. A winner with a loose process says so here.
      */}
      {c.grade && (
        <div className="border-t px-3.5 py-3" style={{ borderColor: C.line }}>
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <p className="text-[10px] font-bold uppercase tracking-[0.16em]" style={{ color: C.mut2 }}>How it was traded</p>
            <span className="text-[11px] font-bold uppercase tracking-[0.1em]" style={{ color: c.grade.score >= 70 ? C.up : c.grade.score >= 45 ? C.gold : C.amber }}>
              {c.grade.verdict} · {c.grade.score}
            </span>
          </div>
          <ul className="space-y-1">
            {c.grade.lines.filter((l) => l.mark).map((l, i) => (
              <li key={i} className="flex gap-2 text-[11.5px]">
                <span className="w-[86px] shrink-0 font-bold uppercase tracking-[0.08em]" style={{ color: MARK_TONE[l.mark!] ?? C.mut2 }}>{l.mark}</span>
                <span style={{ color: C.mut }}><span style={{ color: C.text }}>{l.what}.</span> {l.note}</span>
              </li>
            ))}
          </ul>
          {c.grade.lesson && (
            <p className="mt-2 text-[12px] leading-relaxed" style={{ color: C.gold }}>
              Next time — {c.grade.lesson.charAt(0).toLowerCase()}{c.grade.lesson.slice(1)}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

/* ══════════════════════ TRADING PROFILE ══════════════════════ */

const RISKS = [0.25, 0.5, 0.75, 1.0];

/**
 * The boundaries, set once.
 *
 * This is the screen that replaces a decision per trade with a policy. Everything on it is a consent the
 * member gives deliberately, which is why the dangerous ones — full closes, automatic management,
 * automatic entry — are grouped together, described in plain words, and default to off.
 */
export function ProfileSheet({ open, profile, onClose, onSaved }: {
  open: boolean;
  profile: ProfileView | null;
  onClose: () => void;
  onSaved: (p: ProfileView) => void;
}) {
  const [draft, setDraft] = useState<ProfileView | null>(profile);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) setDraft(profile); }, [open, profile]);

  const save = useCallback(async (patch: Partial<ProfileView>) => {
    if (!draft) return;
    const next = { ...draft, ...patch };
    setDraft(next);
    setBusy(true);
    try {
      const r = await fetch("/api/command-center/trade", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "profile", profile: next }),
      });
      const j = await r.json();
      if (j.ok && j.profile) { setDraft(j.profile); onSaved(j.profile); }
    } catch { /* the sheet keeps the draft; the next save will retry it */ }
    finally { setBusy(false); }
  }, [draft, onSaved]);

  if (!open || !draft) return null;

  const Toggle = ({ label, hint, value, onChange, danger = false }: {
    label: string; hint: string; value: boolean; onChange: (v: boolean) => void; danger?: boolean;
  }) => (
    <button onClick={() => onChange(!value)} disabled={busy}
      className="flex w-full items-start justify-between gap-3 rounded-xl px-3 py-2.5 text-left disabled:opacity-50"
      style={{ background: "rgba(255,255,255,0.025)", border: `1px solid ${value ? (danger ? "rgba(244,115,123,0.30)" : "rgba(240,196,117,0.26)") : C.line}` }}>
      <span className="min-w-0">
        <span className="block text-[12.5px] font-bold" style={{ color: value ? (danger ? C.down : C.gold) : C.text }}>{label}</span>
        <span className="block text-[11px] leading-relaxed" style={{ color: C.mut2 }}>{hint}</span>
      </span>
      <span className="mt-0.5 h-4 w-7 shrink-0 rounded-full p-[2px]" style={{ background: value ? (danger ? "rgba(244,115,123,0.34)" : "rgba(240,196,117,0.34)") : "rgba(255,255,255,0.08)" }}>
        <span className="block h-3 w-3 rounded-full transition-transform"
          style={{ background: value ? (danger ? C.down : C.gold) : C.mut2, transform: value ? "translateX(12px)" : "none" }} />
      </span>
    </button>
  );

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto p-4 sm:p-8"
      style={{ background: "rgba(3,5,9,0.72)", backdropFilter: "blur(6px)" }}>
      <div className="w-full max-w-lg rounded-2xl border" style={{ borderColor: C.line, background: C.panel, color: C.text }}>
        <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: C.line }}>
          <p className="text-[11px] font-bold uppercase tracking-[0.18em]" style={{ color: C.mut2 }}>THE BRAIN · trading profile</p>
          <button onClick={onClose} aria-label="Close"><X className="h-4 w-4" style={{ color: C.mut2 }} /></button>
        </div>

        <div className="space-y-4 px-4 py-4">
          <div>
            <p className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.16em]" style={{ color: C.mut2 }}>Risk per trade</p>
            <div className="flex flex-wrap gap-1.5">
              {RISKS.map((r) => (
                <button key={r} onClick={() => void save({ riskPct: r })} disabled={busy}
                  className="rounded-full px-3.5 py-1.5 text-[12px] font-bold tabular-nums disabled:opacity-50"
                  style={{
                    background: draft.riskPct === r ? "rgba(111,168,220,0.16)" : "rgba(255,255,255,0.04)",
                    color: draft.riskPct === r ? C.cold : C.mut2,
                    border: `1px solid ${draft.riskPct === r ? "rgba(111,168,220,0.34)" : C.line}`,
                  }}>
                  {r.toFixed(2)}%
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[11px]" style={{ color: C.mut2 }}>
              This is the only number you normally need to set. THE BRAIN sizes every trade from it and the
              broker&#39;s own contract spec.
            </p>
          </div>

          <div>
            <p className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.16em]" style={{ color: C.mut2 }}>Trades I may look for</p>
            <div className="space-y-1.5">
              <Toggle label="QUICK" hint="Fast momentum, 30 to 100 pips. 1m and 5m decide, and it fails fast."
                value={draft.allowQuick} onChange={(v) => void save({ allowQuick: v })} />
              <Toggle label="HOLD" hint="Session momentum, held for the move. 15-minute and hourly structure decide."
                value={draft.allowHold} onChange={(v) => void save({ allowHold: v })} />
              <Toggle label="SWING" hint="500 pips and up, held overnight and through news. Off unless you want that."
                value={draft.allowSwing} onChange={(v) => void save({ allowSwing: v })} />
            </div>
          </div>

          <div>
            <p className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.16em]" style={{ color: C.mut2 }}>
              What I may do to an open trade
            </p>
            <div className="space-y-1.5">
              <Toggle label="Move to break even" hint="Take the loss off the table once the trade has earned it."
                value={draft.allowBreakEven} onChange={(v) => void save({ allowBreakEven: v })} />
              <Toggle label="Take partials" hint="Bank part of the move and let the rest run."
                value={draft.allowPartials} onChange={(v) => void save({ allowPartials: v })} />
              <Toggle label="Protect profit" hint="Trail the stop when the trade starts handing back its best."
                value={draft.allowProfitProtection} onChange={(v) => void save({ allowProfitProtection: v })} />
              <Toggle label="Close the whole position" hint="End the trade without asking, when the reason for it is gone." danger
                value={draft.allowFullClose} onChange={(v) => void save({ allowFullClose: v })} />
              <Toggle label="Manage without asking" hint="Act on the permissions above by itself. Off means I ask first, every time." danger
                value={draft.autoManagement} onChange={(v) => void save({ autoManagement: v })} />
            </div>
          </div>

          <div>
            <p className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.16em]" style={{ color: C.mut2 }}>Limits for the day</p>
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className="text-[10px] uppercase tracking-[0.14em]" style={{ color: C.mut2 }}>Max daily loss</span>
                <input inputMode="decimal" defaultValue={String(draft.maxDailyLossPct)}
                  onBlur={(e) => void save({ maxDailyLossPct: Number(e.target.value) || draft.maxDailyLossPct })}
                  className="mt-1 w-full rounded-lg px-3 py-2 text-[13px] tabular-nums outline-none"
                  style={{ background: C.raised, border: `1px solid ${C.line}`, color: C.text }} />
              </label>
              <label className="block">
                <span className="text-[10px] uppercase tracking-[0.14em]" style={{ color: C.mut2 }}>Max losses in a row</span>
                <input inputMode="numeric" defaultValue={String(draft.maxConsecutiveLosses)}
                  onBlur={(e) => void save({ maxConsecutiveLosses: Number(e.target.value) || draft.maxConsecutiveLosses })}
                  className="mt-1 w-full rounded-lg px-3 py-2 text-[13px] tabular-nums outline-none"
                  style={{ background: C.raised, border: `1px solid ${C.line}`, color: C.text }} />
              </label>
            </div>
          </div>

          <div className="rounded-xl px-3 py-3" style={{ background: "rgba(244,115,123,0.05)", border: "1px solid rgba(244,115,123,0.20)" }}>
            <Toggle label="Enter trades without asking" danger
              hint="FULL BRAIN MODE. I find the setup, size it, send it and manage it. You watch, and you can step in at any moment. This still needs live trading authorised on the account itself."
              value={draft.autoEntry} onChange={(v) => void save({ autoEntry: v })} />
          </div>
        </div>
      </div>
    </div>
  );
}

export default BrainTradeCard;
