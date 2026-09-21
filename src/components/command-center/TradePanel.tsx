"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Crosshair, Shield, X } from "lucide-react";

/**
 * CALL TRADE, and TRADE INTELLIGENCE MODE.
 *
 * Both live inside the approved screen rather than replacing any of it. The call sheet is an overlay in
 * the same palette; the trade panel is one more section in the centre column, and it only exists while a
 * position does.
 */

const C = {
  panel: "#0A0E15", raised: "#0E131C", line: "rgba(255,255,255,0.07)",
  text: "#E8EFF7", mut: "rgba(232,239,247,0.56)", mut2: "rgba(232,239,247,0.34)",
  gold: "#F0C475", up: "#3FD9A0", down: "#F4737B", cold: "#6FA8DC", amber: "#E9B949",
};

const STYLES = [
  { id: "quick", label: "QUICK", sub: "30–100 pips.", hint: "1m and 5m decide. Fast to protect, fast to admit failure." },
  { id: "hold", label: "HOLD", sub: "300 pips and up.", hint: "15m and 1h structure decide, with the 4h as the frame." },
  { id: "swing", label: "SWING", sub: "500–1000 pips.", hint: "1h, 4h and daily decide. Five-minute noise is ignored." },
] as const;
type StyleId = (typeof STYLES)[number]["id"];

export type TradeStateView = {
  active: boolean;
  positionId: string | null;
  side: "buy" | "sell" | null;
  style: string | null;
  entry: number | null;
  qty: number | null;
  initQty: number | null;
  stop: number | null;
  initStop: number | null;
  takeProfit: number | null;
  openedAt: number | null;
  metrics: { pips: number; money: number | null; r: number | null; mfePips: number; maePips: number; riskPips: number; distanceToStopPips: number; distanceToTargetPips: number | null; heldMs: number; beyondBreakEven: boolean; remainingFraction: number } | null;
  character: { state: string; headline: string; explanation: string } | null;
  health: { score: number; verdict: string; drivers: { label: string; delta: number }[] } | null;
  protection: { action: string; price: number | null; fraction: number | null; urgency: string; say: string } | null;
  thesisState: string | null;
  thesis: { reason?: string; invalidationPrice?: number } | null;
  partials: { at: number; fraction: number; qty: number; price?: number }[];
  aiManagement: boolean;
  permissions: Record<string, boolean>;
  events: { at: number; code: string; detail: string; channel: string }[];
  unmanaged: { brokerPositionId: string; side: "buy" | "sell"; qty: number; entry: number | null }[];
};

const fmt = (n: number | null | undefined, dp = 2) => (n == null ? "—" : n.toFixed(dp));
const held = (ms: number) => {
  const m = Math.floor(ms / 60_000), s = Math.floor((ms % 60_000) / 1000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m ${s}s`;
};
const tone = (n: number | null | undefined) => (n == null ? C.mut : n > 0 ? C.up : n < 0 ? C.down : C.mut);

/* ══════════════════════════ CALL TRADE ══════════════════════════ */

export function CallTradeSheet({ price, levels, open, onClose, onDone }: {
  price: number | null;
  levels: { price: number; label: string }[];
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [style, setStyle] = useState<StyleId>("hold");
  const [risk, setRisk] = useState(0.5);
  const [stop, setStop] = useState("");
  const [target, setTarget] = useState("");
  const [prep, setPrep] = useState<Record<string, unknown> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ state: string; message: string } | null>(null);
  // Generated once when the sheet opens, NOT when the button is clicked — that is what makes a
  // double-click, a retry and a refresh all mean the same single order.
  const idemKey = useRef<string>("");
  useEffect(() => { if (open) idemKey.current = crypto.randomUUID(); }, [open]);

  // Pre-populate a sensible stop from the market ATLAS is already reading: the nearest level on the
  // protective side, if there is one, otherwise a style-appropriate distance.
  useEffect(() => {
    if (!open || !price || stop) return;
    const below = levels.filter((l) => l.price < price).sort((a, b) => b.price - a.price)[0];
    const above = levels.filter((l) => l.price > price).sort((a, b) => a.price - b.price)[0];
    const pick = side === "buy" ? below?.price : above?.price;
    const fallback = side === "buy" ? price - 4 : price + 4;
    setStop((pick ?? fallback).toFixed(2));
  }, [open, price, side, levels, stop]);

  const reset = () => { setPrep(null); setErr(null); setResult(null); };

  const doPrepare = useCallback(async () => {
    setBusy(true); setErr(null); setPrep(null);
    try {
      const r = await fetch("/api/command-center/trade", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "prepare", side, style, stop: Number(stop), takeProfit: target ? Number(target) : null, riskPct: risk }),
      });
      const j = await r.json();
      if (j.ok) setPrep(j); else setErr(j.reason ?? "That trade could not be prepared.");
    } catch { setErr("Could not reach the Command Center."); }
    finally { setBusy(false); }
  }, [side, style, stop, target, risk]);

  const doExecute = useCallback(async () => {
    if (!prep) return;
    setBusy(true); setErr(null);
    try {
      const r = await fetch("/api/command-center/trade", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "execute", intentId: prep.intentId, idempotencyKey: idemKey.current, confirm: true }),
      });
      const j = await r.json();
      setResult({ state: j.state ?? "error", message: j.message ?? "" });
      if (j.state === "position_open") { onDone(); setTimeout(() => { onClose(); reset(); }, 1400); }
    } catch { setErr("Could not reach the Command Center."); }
    finally { setBusy(false); }
  }, [prep, onClose, onDone]);

  if (!open) return null;
  const sizing = prep?.sizing as { qty: number; riskAmount: number; stopPips: number; riskPctUsed: number; rMultipleToTp: number | null } | undefined;
  const acct = prep?.account as { equity: number | null; currency: string | null; isLive: boolean } | undefined;
  const warnings = (prep?.warnings as string[] | undefined) ?? [];

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto p-4 sm:p-8" style={{ background: "rgba(3,5,9,0.72)", backdropFilter: "blur(6px)" }}>
      <div className="w-full max-w-lg rounded-2xl border" style={{ borderColor: C.line, background: C.panel, color: C.text }}>
        <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: C.line }}>
          <p className="text-[11px] font-bold uppercase tracking-[0.18em]" style={{ color: C.mut2 }}>Call trade · XAUUSD</p>
          <button onClick={() => { onClose(); reset(); }} aria-label="Close"><X className="h-4 w-4" style={{ color: C.mut2 }} /></button>
        </div>

        <div className="space-y-3.5 px-4 py-3.5">
          <div className="grid grid-cols-2 gap-2">
            {(["buy", "sell"] as const).map((sd) => (
              <button key={sd} onClick={() => { setSide(sd); setStop(""); reset(); }}
                className="rounded-xl py-2.5 text-[12px] font-black uppercase tracking-[0.14em]"
                style={{
                  background: side === sd ? (sd === "buy" ? "rgba(63,217,160,0.14)" : "rgba(244,115,123,0.14)") : "rgba(255,255,255,0.03)",
                  color: side === sd ? (sd === "buy" ? C.up : C.down) : C.mut2,
                  border: `1px solid ${side === sd ? (sd === "buy" ? "rgba(63,217,160,0.34)" : "rgba(244,115,123,0.34)") : C.line}`,
                }}>
                {sd}
              </button>
            ))}
          </div>

          <div>
            <p className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.16em]" style={{ color: C.mut2 }}>Style</p>
            <div className="grid gap-1.5">
              {STYLES.map((s) => (
                <button key={s.id} onClick={() => { setStyle(s.id); reset(); }}
                  className="rounded-xl px-3 py-2 text-left"
                  style={{
                    background: style === s.id ? "rgba(240,196,117,0.07)" : "rgba(255,255,255,0.025)",
                    border: `1px solid ${style === s.id ? "rgba(240,196,117,0.30)" : C.line}`,
                  }}>
                  <p className="text-[12px] font-black tracking-[0.06em]" style={{ color: style === s.id ? C.gold : C.text }}>
                    {s.label} <span className="font-normal tracking-normal" style={{ color: C.mut2 }}>· {s.sub}</span>
                  </p>
                  {style === s.id && <p className="mt-0.5 text-[11px] leading-relaxed" style={{ color: C.mut }}>{s.hint}</p>}
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.16em]" style={{ color: C.mut2 }}>Risk (of account)</p>
            <div className="flex flex-wrap gap-1.5">
              {[0.25, 0.5, 0.75, 1].map((r) => (
                <button key={r} onClick={() => { setRisk(r); reset(); }}
                  className="rounded-full px-3 py-1 text-[11px] font-bold tabular-nums"
                  style={{
                    background: risk === r ? "rgba(111,168,220,0.14)" : "rgba(255,255,255,0.04)",
                    color: risk === r ? C.cold : C.mut2,
                    border: `1px solid ${risk === r ? "rgba(111,168,220,0.30)" : C.line}`,
                  }}>
                  {r.toFixed(2)}%
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-[10px] uppercase tracking-[0.14em]" style={{ color: C.mut2 }}>Stop</span>
              <input value={stop} onChange={(e) => { setStop(e.target.value); reset(); }} inputMode="decimal"
                className="mt-1 w-full rounded-lg px-3 py-2 text-[13px] tabular-nums outline-none"
                style={{ background: C.raised, border: `1px solid ${C.line}`, color: C.text }} />
            </label>
            <label className="block">
              <span className="text-[10px] uppercase tracking-[0.14em]" style={{ color: C.mut2 }}>Target (optional)</span>
              <input value={target} onChange={(e) => { setTarget(e.target.value); reset(); }} inputMode="decimal"
                className="mt-1 w-full rounded-lg px-3 py-2 text-[13px] tabular-nums outline-none"
                style={{ background: C.raised, border: `1px solid ${C.line}`, color: C.text }} />
            </label>
          </div>
          <p className="text-[10.5px]" style={{ color: C.mut2 }}>
            Entry is at market{price ? ` — gold is ${price.toFixed(2)} right now` : ""}. ATLAS suggested the stop from the nearest level it is watching; change it if you disagree.
          </p>

          {err && <p className="text-[12px]" style={{ color: C.down }}>{err}</p>}

          {sizing && (
            <div className="rounded-xl px-3 py-3" style={{ background: C.raised, border: `1px solid ${C.line}` }}>
              <div className="grid grid-cols-2 gap-y-1.5 text-[12px] tabular-nums">
                <span style={{ color: C.mut2 }}>Risk</span><span className="text-right font-bold">${sizing.riskAmount.toFixed(2)}</span>
                <span style={{ color: C.mut2 }}>Lot size</span><span className="text-right font-bold">{sizing.qty}</span>
                <span style={{ color: C.mut2 }}>Stop distance</span><span className="text-right font-bold">{sizing.stopPips} pips</span>
                <span style={{ color: C.mut2 }}>Account risk</span><span className="text-right font-bold">{sizing.riskPctUsed}%</span>
                {sizing.rMultipleToTp != null && (<><span style={{ color: C.mut2 }}>Reward</span><span className="text-right font-bold">{sizing.rMultipleToTp}R</span></>)}
                {acct?.equity != null && (<><span style={{ color: C.mut2 }}>Equity</span><span className="text-right">{acct.currency ?? "$"}{acct.equity.toLocaleString()}</span></>)}
              </div>
              {warnings.map((w, i) => <p key={i} className="mt-1.5 text-[11px]" style={{ color: C.amber }}>{w}</p>)}
              {acct?.isLive && (
                <p className="mt-2 text-[11px] font-bold uppercase tracking-[0.1em]" style={{ color: C.down }}>This is a LIVE account — real money.</p>
              )}
            </div>
          )}

          {result && (
            <div className="rounded-xl px-3 py-2.5 text-[12px]" style={{
              background: result.state === "position_open" ? "rgba(63,217,160,0.08)" : "rgba(233,185,73,0.08)",
              border: `1px solid ${result.state === "position_open" ? "rgba(63,217,160,0.28)" : "rgba(233,185,73,0.28)"}`,
              color: result.state === "position_open" ? C.up : C.amber,
            }}>
              <p className="font-bold uppercase tracking-[0.12em]">{result.state.replace(/_/g, " ")}</p>
              <p className="mt-0.5" style={{ color: C.mut }}>{result.message}</p>
            </div>
          )}

          {!prep ? (
            <button onClick={() => void doPrepare()} disabled={busy || !stop}
              className="w-full rounded-xl px-3 py-2.5 text-[11px] font-bold uppercase tracking-[0.14em] disabled:opacity-40"
              style={{ background: "rgba(240,196,117,0.14)", color: C.gold, border: "1px solid rgba(240,196,117,0.32)" }}>
              {busy ? "Checking…" : "Check this trade"}
            </button>
          ) : (
            <button onClick={() => void doExecute()} disabled={busy || result?.state === "position_open"}
              className="w-full rounded-xl px-3 py-3 text-[12px] font-black uppercase tracking-[0.16em] disabled:opacity-40"
              style={{
                background: side === "buy" ? "rgba(63,217,160,0.16)" : "rgba(244,115,123,0.16)",
                color: side === "buy" ? C.up : C.down,
                border: `1px solid ${side === "buy" ? "rgba(63,217,160,0.36)" : "rgba(244,115,123,0.36)"}`,
              }}>
              {busy ? "Executing…" : `Execute ${side}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════ TRADE INTELLIGENCE ══════════════════════════ */

export function TradePanel({ trade, onChanged }: { trade: TradeStateView; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [stopInput, setStopInput] = useState("");

  const act = useCallback(async (body: Record<string, unknown>, tag: string) => {
    setBusy(tag); setMsg(null);
    try {
      const r = await fetch("/api/command-center/trade", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      setMsg(j.message ?? (j.ok ? "Done." : "That didn't work."));
      onChanged();
    } catch { setMsg("Could not reach the Command Center."); }
    finally { setBusy(null); }
  }, [onChanged]);

  const m = trade.metrics;
  const long = trade.side === "buy";
  const healthColor = useMemo(() => {
    const s = trade.health?.score ?? 0;
    return s >= 80 ? C.up : s >= 64 ? C.up : s >= 48 ? C.gold : s >= 30 ? C.amber : C.down;
  }, [trade.health]);

  if (!trade.active || !m) return null;

  const Btn = ({ id, label, onClick, color = C.mut, danger = false }: { id: string; label: string; onClick: () => void; color?: string; danger?: boolean }) => (
    <button onClick={onClick} disabled={!!busy}
      className="rounded-lg px-2.5 py-1.5 text-[11px] font-bold uppercase tracking-[0.08em] disabled:opacity-40"
      style={{
        background: danger ? "rgba(244,115,123,0.10)" : "rgba(255,255,255,0.04)",
        color: danger ? C.down : color,
        border: `1px solid ${danger ? "rgba(244,115,123,0.28)" : C.line}`,
      }}>
      {busy === id ? "…" : label}
    </button>
  );

  return (
    <section className="overflow-hidden rounded-2xl border" style={{ borderColor: "rgba(240,196,117,0.22)", background: C.panel }}>
      <div className="flex items-center justify-between gap-2 border-b px-3.5 py-2.5" style={{ borderColor: C.line }}>
        <p className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.18em]" style={{ color: C.gold }}>
          <Crosshair className="h-3.5 w-3.5" /> Trade active
        </p>
        <span className="text-[10px] uppercase tracking-[0.12em]" style={{ color: C.mut2 }}>
          {String(trade.style).toUpperCase()} · {held(m.heldMs)}
        </span>
      </div>

      {/* status */}
      <div className="px-3.5 py-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-[15px] font-black tracking-tight" style={{ color: long ? C.up : C.down }}>
            {long ? "BUY" : "SELL"} XAUUSD
          </span>
          <span className="text-[12px] tabular-nums" style={{ color: C.mut2 }}>
            {trade.qty} lots from {fmt(trade.entry)}
          </span>
        </div>

        <div className="mt-2 flex flex-wrap items-baseline gap-x-5 gap-y-1">
          <span className="text-2xl font-black tabular-nums" style={{ color: tone(m.pips) }}>
            {m.pips >= 0 ? "+" : ""}{Math.round(m.pips)} <span className="text-[12px] font-bold" style={{ color: C.mut2 }}>PIPS</span>
          </span>
          {m.money != null && (
            <span className="text-[15px] font-bold tabular-nums" style={{ color: tone(m.money) }}>
              {m.money >= 0 ? "+" : "−"}${Math.abs(m.money).toFixed(2)}
            </span>
          )}
          {m.r != null && (
            <span className="text-[15px] font-bold tabular-nums" style={{ color: tone(m.r) }}>{m.r >= 0 ? "+" : ""}{m.r}R</span>
          )}
        </div>

        <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[11.5px] tabular-nums sm:grid-cols-4">
          <span style={{ color: C.mut2 }}>Max +{Math.round(m.mfePips)}</span>
          <span style={{ color: C.mut2 }}>Worst {Math.round(m.maePips)}</span>
          <span style={{ color: C.mut2 }}>Stop {fmt(trade.stop)} ({Math.round(m.distanceToStopPips)}p)</span>
          <span style={{ color: C.mut2 }}>{trade.takeProfit != null ? `Target ${fmt(trade.takeProfit)}` : "No target set"}</span>
        </div>
        {m.mfePips > 0 && m.pips < m.mfePips && (
          <p className="mt-1 text-[11px]" style={{ color: C.mut2 }}>
            Given back {Math.round(m.mfePips - m.pips)} pips from the peak.
          </p>
        )}
        {trade.partials.length > 0 && (
          <p className="mt-1 text-[11px]" style={{ color: C.mut }}>
            Partials: {trade.partials.map((p) => `${Math.round(p.fraction * 100)}%`).join(", ")} — {Math.round(m.remainingFraction * 100)}% still running.
          </p>
        )}
      </div>

      {/* health + thesis */}
      <div className="grid gap-px sm:grid-cols-2" style={{ background: C.line }}>
        <div className="px-3.5 py-3" style={{ background: C.panel }}>
          <p className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.16em]" style={{ color: C.mut2 }}>Position health</p>
          <div className="flex items-baseline gap-2">
            <span className="text-xl font-black tabular-nums" style={{ color: healthColor }}>{trade.health?.score ?? "—"}</span>
            <span className="text-[12px] font-bold uppercase tracking-[0.1em]" style={{ color: healthColor }}>{trade.health?.verdict ?? ""}</span>
          </div>
          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full" style={{ background: "rgba(255,255,255,0.06)" }}>
            <div className="h-full rounded-full" style={{ width: `${trade.health?.score ?? 0}%`, background: healthColor, transition: "width .6s cubic-bezier(.22,.9,.24,1)" }} />
          </div>
          {trade.health?.drivers?.slice(0, 3).map((d, i) => (
            <p key={i} className="mt-1 text-[11px]" style={{ color: d.delta >= 0 ? C.mut : C.amber }}>
              {d.delta >= 0 ? "+" : ""}{d.delta} · {d.label}
            </p>
          ))}
        </div>

        <div className="px-3.5 py-3" style={{ background: C.panel }}>
          <p className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.16em]" style={{ color: C.mut2 }}>Trade thesis</p>
          <p className="text-[13px] font-bold" style={{ color: trade.thesisState === "Invalidated" || trade.thesisState === "Character changed" ? C.down : trade.thesisState === "Weakening" ? C.amber : C.up }}>
            {trade.thesisState ?? "—"}
          </p>
          {trade.character && <p className="mt-1 text-[12px] leading-relaxed" style={{ color: C.mut }}>{trade.character.explanation}</p>}
          {trade.thesis?.invalidationPrice && (
            <p className="mt-1.5 text-[11px]" style={{ color: C.down }}>Fails at {trade.thesis.invalidationPrice.toFixed(2)}</p>
          )}
        </div>
      </div>

      {/* what ATLAS would do */}
      {trade.protection && (
        <div className="border-t px-3.5 py-3" style={{ borderColor: C.line, background: trade.protection.action === "hold" ? "transparent" : "rgba(240,196,117,0.04)" }}>
          <p className="mb-1 inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.16em]" style={{ color: C.mut2 }}>
            <Shield className="h-3.5 w-3.5" /> ATLAS would {trade.protection.action.replace(/_/g, " ")}
          </p>
          <p className="text-[12.5px] leading-relaxed" style={{ color: C.mut }}>{trade.protection.say}</p>
        </div>
      )}

      {/* controls */}
      <div className="border-t px-3.5 py-3" style={{ borderColor: C.line }}>
        <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.16em]" style={{ color: C.mut2 }}>Trade control</p>
        <div className="flex flex-wrap gap-1.5">
          <Btn id="be" label="Move to BE" color={C.cold} onClick={() => void act({ action: "break_even", positionId: trade.positionId, offsetPips: 0 }, "be")} />
          <Btn id="p25" label="25%" onClick={() => void act({ action: "partial", positionId: trade.positionId, fraction: 0.25 }, "p25")} />
          <Btn id="p50" label="50%" onClick={() => void act({ action: "partial", positionId: trade.positionId, fraction: 0.5 }, "p50")} />
          <Btn id="p75" label="75%" onClick={() => void act({ action: "partial", positionId: trade.positionId, fraction: 0.75 }, "p75")} />
          {trade.protection && trade.protection.action !== "hold" && (
            <Btn id="prot" label="Protect" color={C.gold} onClick={() => void act({ action: "protect" }, "prot")} />
          )}
          <Btn id="close" label="Close trade" danger onClick={() => void act({ action: "close", positionId: trade.positionId }, "close")} />
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <input value={stopInput} onChange={(e) => setStopInput(e.target.value)} placeholder="Move stop to…" inputMode="decimal"
            className="w-36 rounded-lg px-2.5 py-1.5 text-[12px] tabular-nums outline-none"
            style={{ background: C.raised, border: `1px solid ${C.line}`, color: C.text }} />
          <Btn id="ms" label="Move stop" onClick={() => { if (stopInput) void act({ action: "move_stop", positionId: trade.positionId, price: Number(stopInput) }, "ms"); }} />
        </div>

        {msg && <p className="mt-2 text-[11.5px]" style={{ color: C.mut }}>{msg}</p>}

        <div className="mt-3 border-t pt-2.5" style={{ borderColor: C.line }}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[0.14em]" style={{ color: trade.aiManagement ? C.gold : C.mut2 }}>
                AI management {trade.aiManagement ? "on" : "off"}
              </p>
              <p className="text-[10.5px]" style={{ color: C.mut2 }}>
                {trade.aiManagement
                  ? "ATLAS may act on this position, within the permissions set on the account."
                  : "ATLAS is watching this position but will not touch it."}
              </p>
            </div>
            <Btn id="ai" label={trade.aiManagement ? "Turn off" : "Turn on"} color={C.gold}
              onClick={() => void act({ action: "ai_management", positionId: trade.positionId, on: !trade.aiManagement }, "ai")} />
          </div>
        </div>
      </div>
    </section>
  );
}

/** A position opened directly in TradeLocker — offered to ATLAS rather than silently adopted. */
export function UnmanagedNotice({ trade, onChanged }: { trade: TradeStateView; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  if (!trade.unmanaged?.length) return null;
  const p = trade.unmanaged[0];
  const adopt = async (style: StyleId) => {
    setBusy(true);
    try {
      await fetch("/api/command-center/trade", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "adopt", brokerPositionId: p.brokerPositionId, style }),
      });
      onChanged();
    } finally { setBusy(false); }
  };
  return (
    <section className="overflow-hidden rounded-2xl border" style={{ borderColor: "rgba(240,196,117,0.26)", background: "rgba(240,196,117,0.04)" }}>
      <div className="px-3.5 py-3">
        <p className="text-[10px] font-bold uppercase tracking-[0.16em]" style={{ color: C.gold }}>New XAUUSD position detected</p>
        <p className="mt-1 text-[12.5px]" style={{ color: C.mut }}>
          A {p.side === "buy" ? "BUY" : "SELL"} of {p.qty} lots{p.entry ? ` from ${p.entry.toFixed(2)}` : ""} was opened in TradeLocker. Manage it with ATLAS?
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {STYLES.map((s) => (
            <button key={s.id} disabled={busy} onClick={() => void adopt(s.id)}
              className="rounded-full px-3 py-1 text-[10px] font-bold uppercase tracking-[0.1em] disabled:opacity-40"
              style={{ background: "rgba(240,196,117,0.12)", color: C.gold, border: "1px solid rgba(240,196,117,0.30)" }}>
              {s.label}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

export default TradePanel;
