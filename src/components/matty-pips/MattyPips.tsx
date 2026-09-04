"use client";

import { useEffect, useState } from "react";
import type { Candle, DecisionObject, EngineError, LevelSource, Mode, RankedLevel } from "@/lib/matty-pips/types";

/**
 * MATTY PIPS — premium gold trading terminal (presentation only; the
 * deterministic engine, APIs and automation are untouched).
 *
 * Hierarchy: command bar → CURRENT READ → market story chart (≈2/3) beside
 * the trade decision + bull/bear (≈1/3) → trade plan → Matty's thought →
 * advanced intelligence (closed) → level map. Plain trader language first;
 * engine terminology lives only inside Advanced.
 */

type AnalyzeResponse = DecisionObject & { analysisId?: string | null };
type SavedItem = { id: string; symbol: string; mode: string; status: string; verdict: string; score: number; price: number; created_at: string };
type MpAccount = {
  connection_id: string; account_id: string; acc_num: string; name: string | null; currency: string | null;
  enabled: boolean; mode: string; risk_pct: number; be_enabled: boolean; partials_enabled: boolean;
};

// GOLD ONLY (owner 09-04): Matty Pips is the gold desk — no other pairs, and
// aggressive is the only mode. The saved-reads list still opens older reads.
const MARKETS: { canonical: string; label: string }[] = [
  { canonical: "XAUUSD", label: "Gold" },
];

const C = {
  bg: "#F7FAFC", card: "#FFFFFF", ice: "#EDF4FB", iceDeep: "#DCEAF7",
  blue: "#5B9BD5", blueDeep: "#2F6FA8", ink: "#1E2B38", sub: "#6B7C8C",
  line: "#E9EFF5", green: "#169B6B", greenSoft: "#EAF7F1", red: "#D65A5A", redSoft: "#FBF0F0",
  amber: "#C99019", amberSoft: "#FBF4E3",
  shadow: "0 1px 10px rgba(30,60,90,0.05)",
};

const fmt = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? "—" : n >= 100 ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : String(+n.toFixed(5));
const lower = (s: string) => s.replace(/_/g, " ").toLowerCase();

/* ── trader-language helpers ─────────────────────────────────────────────── */
const SRC_LABEL: [LevelSource, string][] = [
  ["WEEK_HIGH", "this week's high"], ["WEEK_LOW", "this week's low"],
  ["PREV_DAY_HIGH", "yesterday's high"], ["PREV_DAY_LOW", "yesterday's low"],
  ["STRUCT_HIGH", "the recent high"], ["STRUCT_LOW", "the recent low"],
  ["DAY_HIGH", "today's high"], ["DAY_LOW", "today's low"],
  ["ZONE_D", "major level"], ["ZONE_H4", "key level"], ["ZONE_H1", "level"],
];
function levelWhy(l: RankedLevel): string {
  for (const [src, name] of SRC_LABEL) if (l.sources.includes(src)) return name;
  return "level";
}
function marketName(d: DecisionObject): string {
  return d.symbol === "XAUUSD" ? "Gold" : d.displayName.split(" ")[0];
}
function nodeLevel(d: DecisionObject): RankedLevel | null {
  if (!d.activeNode) return null;
  return d.levels.find((l) => l.low >= d.activeNode!.low - 1e-9 && l.high <= d.activeNode!.high + 1e-9) ?? null;
}
function levelRole(d: DecisionObject): string | null {
  const n = d.activeNode; if (!n) return null;
  const flipped = nodeLevel(d)?.brokeAndRetested || d.levels.some((l) => n.isComplex && l.brokeAndRetested && l.low >= n.low && l.high <= n.high);
  if (!flipped) return null;
  return n.kind === "support" ? "old resistance → new support" : "old support → new resistance";
}

/** CURRENT READ — one plain headline + phase word. */
function currentRead(d: DecisionObject): { headline: string; phase: string } {
  const name = marketName(d);
  const sup = d.activeNode?.kind !== "resistance";
  const lvl = sup ? "support" : "resistance";
  switch (d.reaction.state) {
    case "APPROACHING": return { headline: `${name} is approaching ${lvl}.`, phase: "Approach" };
    case "TESTING": return { headline: `${name} is testing ${lvl}.`, phase: levelRole(d) ? "Pullback" : "Testing" };
    case "RESPECTING": return { headline: `${lvl[0].toUpperCase() + lvl.slice(1)} is holding.`, phase: "Holding" };
    case "REJECTING": return { headline: d.reaction.confirmedByClose ? `${lvl[0].toUpperCase() + lvl.slice(1)} just rejected.` : `${name} is rejecting ${lvl}.`, phase: "Rejection" };
    case "FAILED_BREAK": return { headline: `Fake break at ${lvl}.`, phase: "Fake break" };
    case "ACCEPTED_BREAK": return { headline: `${name} broke the ${lvl}.`, phase: "Breakout" };
    case "BREAK_RETEST": return { headline: `${name} is retesting the break.`, phase: "Retest" };
    case "MOMENTUM_CONTINUATION": return { headline: `${name} is running after the break.`, phase: "Momentum" };
    case "EXPANSION_BREAKOUT": return { headline: `Explosive move through the ${lvl}.`, phase: "Expansion" };
    default: return { headline: `${name} is between levels.`, phase: "No level in play" };
  }
}

/** MATTY'S READ — 1–2 short trader sentences. */
function mattysRead(d: DecisionObject): string {
  const name = marketName(d);
  const sup = d.activeNode?.kind !== "resistance";
  const lvl = sup ? "support" : "resistance";
  const role = levelRole(d);
  const late = !d.trade && d.reaction.confirmedByClose && (d.entryQuality === "LATE" || d.entryQuality === "CHASE");
  if (late) return "Good setup, but the move already left the level. I don't chase — waiting for a pullback or fresh structure.";
  if (d.trade) return d.trade.direction === "buy"
    ? `${lvl[0].toUpperCase() + lvl.slice(1)} held and the 15M confirmed it. This is the buy — plan below.`
    : `${lvl[0].toUpperCase() + lvl.slice(1)} rejected and the 15M confirmed it. This is the sell — plan below.`;
  switch (d.reaction.state) {
    case "TESTING": return role
      ? `${name} is pulling back into ${role}. I'm waiting for the 15M to confirm whether buyers defend it.`
      : `${name} is sitting on ${lvl}. The 15M candle decides this — not us.`;
    case "RESPECTING": return `The ${lvl} keeps holding but there's no confirmed rejection candle yet. Let it finish the story.`;
    case "REJECTING": return d.reaction.confirmedByClose
      ? `The ${lvl} rejected and the candle confirmed. The trade is forming right here.`
      : `${name} ${sup ? "dipped below support and reclaimed it" : "spiked into resistance and stalled"}. A ${sup ? "bullish" : "bearish"} 15M close makes this real.`;
    case "FAILED_BREAK": return `${name} poked through the level and got pushed straight back — a liquidity grab, not a breakout. The move back through it is the trade.`;
    case "ACCEPTED_BREAK": return `The level broke on a closed candle. The cleanest entry is the retest — let price come back and hold it.`;
    case "BREAK_RETEST": return `Break, pullback, and the old level is holding. One confirming close and the continuation is on.`;
    case "MOMENTUM_CONTINUATION": return `${name} broke out and never came back for the retest. No chasing — waiting for a pullback or a fresh entry.`;
    case "EXPANSION_BREAKOUT": return `A violent candle blew through the level. Not chasing the top, not blind-fading — the first pullback tells us continuation or exhaustion.`;
    case "APPROACHING": return `Price is traveling toward the level. The reaction there decides everything — the approach decides nothing.`;
    default: return `Between levels is where accounts leak. I wait for ${name} to reach a level that matters.`;
  }
}

function statusMeta(d: DecisionObject): { label: string; color: string } {
  if (d.status === "TAKE_NOW" && d.trade) return { label: `TAKE NOW — ${d.trade.direction.toUpperCase()}`, color: d.trade.direction === "buy" ? C.green : C.red };
  if (d.status === "ARMED") return { label: "ARMED", color: C.amber };
  if (d.status === "APPROACHING") return { label: "APPROACHING", color: C.blueDeep };
  return { label: "WAIT", color: C.sub };
}

/* ══ MATTY'S CALL — always-on decision, OM-AI-Plays-style presentation ══════
   Dark chart with the TP/SL lines drawn on it + a copyable ENTRY/STOP/R:R/TP
   card grid, per the owner's reference. Data comes from decision.call. */
const DK = { bg: "#0B0E14", line: "rgba(150,190,240,0.12)", cell: "rgba(255,255,255,0.03)", ink: "#EDF2FA", sub: "#8FA0BC", faint: "#5E708E", green: "#34D399", red: "#F87171", blue: "#8FC6FF" };

function CallChart({ d, call }: { d: DecisionObject; call: NonNullable<DecisionObject["call"]> }) {
  const cs = d.chart.m15.slice(-44);
  if (cs.length < 8) return null;
  const W = 980, H = 340, padT = 14, padB = 14, padR = 150, padL = 10;
  let hi = -Infinity, lo = Infinity;
  cs.forEach((k) => { if (k.h > hi) hi = k.h; if (k.l < lo) lo = k.l; });
  // Always include entry/stop/TP1 in the scale; pull TP2/TP3 in only when close
  // enough that the candles stay readable — otherwise clamp them to the edge.
  const range0 = hi - lo;
  [call.entry, call.stopLoss, call.tp1].forEach((v) => { if (v > hi) hi = v; if (v < lo) lo = v; });
  [call.tp2, call.tp3].forEach((v) => { if (v != null && Math.abs(v - call.entry) <= range0 * 1.9) { if (v > hi) hi = v; if (v < lo) lo = v; } });
  hi += (hi - lo) * 0.05; lo -= (hi - lo) * 0.05;
  const span = Math.max(hi - lo, 1e-6);
  const y = (v: number) => Math.min(H - padB, Math.max(padT, padT + ((hi - v) / span) * (H - padT - padB)));
  const iw = (W - padL - padR) / cs.length, bw = Math.max(3, iw * 0.55);
  const clamped = (v: number) => v > hi || v < lo;
  const lvls: { label: string; v: number; c: string; bold?: boolean }[] = [
    call.tp3 != null ? { label: `TP3 ${fmt(call.tp3)}`, v: call.tp3, c: DK.green } : null,
    call.tp2 != null ? { label: `TP2 ${fmt(call.tp2)}`, v: call.tp2, c: DK.green } : null,
    { label: `TP1 ${fmt(call.tp1)}`, v: call.tp1, c: DK.green },
    { label: `Entry ${fmt(call.entry)}`, v: call.entry, c: "#FFFFFF", bold: true },
    { label: `SL ${fmt(call.stopLoss)}`, v: call.stopLoss, c: DK.red },
  ].filter(Boolean) as { label: string; v: number; c: string; bold?: boolean }[];
  const dirCol = call.direction === "buy" ? DK.green : DK.red;
  // Expected path: sketched forward from the last candle into the right margin.
  const path = (call.expectedPath ?? []).filter((p) => p.price <= hi && p.price >= lo);
  const pathX0 = padL + (cs.length - 0.5) * iw;
  const pathX1 = W - padR - 4;
  const pathPts = path.length >= 2 ? path.map((p, i) => ({ x: pathX0 + ((pathX1 - pathX0) * i) / (path.length - 1), yy: y(p.price), label: p.label })) : [];
  return (
    <div style={{ background: "#05080D", border: `1px solid ${DK.line}`, borderRadius: 14, padding: "10px 6px 6px" }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", display: "block" }} aria-label="Matty's call levels on the 15M chart">
        {call.entryPlan && Math.abs(y(call.entryPlan.zoneLow) - y(call.entryPlan.zoneHigh)) > 1 && (
          <rect x={padL} y={y(call.entryPlan.zoneHigh)} width={W - padL - padR + 8}
            height={Math.max(2, y(call.entryPlan.zoneLow) - y(call.entryPlan.zoneHigh))}
            fill={dirCol} opacity={0.1} rx={2} />
        )}
        {cs.map((k, i) => {
          const x = padL + i * iw + iw / 2, up = k.c >= k.o;
          const col = up ? DK.green : DK.red;
          const bt = y(Math.max(k.o, k.c)), bb = y(Math.min(k.o, k.c));
          return (
            <g key={i}>
              <line x1={x} x2={x} y1={y(k.h)} y2={y(k.l)} stroke={col} strokeWidth={1.1} opacity={0.85} />
              <rect x={x - bw / 2} y={bt} width={bw} height={Math.max(1.6, bb - bt)} rx={1.2} fill={col} />
            </g>
          );
        })}
        {(() => {
          // Push overlapping right-edge labels apart (Entry and SL can sit $3 apart)
          // while the dashed lines stay at their true prices.
          const rows = lvls.map((L) => ({ ...L, ly: y(L.v) })).sort((a, b) => a.ly - b.ly);
          for (let i = 1; i < rows.length; i++) if (rows[i].ly - rows[i - 1].ly < 17) rows[i].ly = rows[i - 1].ly + 17;
          for (let i = rows.length - 1; i >= 0; i--) if (rows[i].ly > H - 6) rows[i].ly = H - 6;
          return rows.map((L) => (
            <g key={L.label}>
              <line x1={padL} x2={W - padR + 8} y1={y(L.v)} y2={y(L.v)} stroke={L.c} strokeWidth={L.bold ? 1.4 : 1.1} strokeDasharray="6 5" opacity={L.bold ? 0.95 : 0.8} />
              <text x={W - padR + 14} y={L.ly + 4} fontSize={15} fontWeight={700} fill={L.c}>
                {clamped(L.v) ? `${L.label} ↑` : L.label}
              </text>
            </g>
          ));
        })()}
        {pathPts.length >= 2 && (
          <g>
            <polyline points={pathPts.map((p) => `${p.x},${p.yy}`).join(" ")}
              fill="none" stroke={dirCol} strokeWidth={2} strokeDasharray="2 6"
              strokeLinecap="round" opacity={0.85} />
            {pathPts.map((p, i) => (
              <circle key={i} cx={p.x} cy={p.yy} r={i === pathPts.length - 1 ? 4 : 2.6} fill={dirCol} opacity={0.9} />
            ))}
          </g>
        )}
      </svg>
    </div>
  );
}

function CopyCell({ label, value, pips, color, big }: { label: string; value: string; pips: string | null; color: string; big?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => { try { navigator.clipboard.writeText(value.replace(/,/g, "")); setCopied(true); setTimeout(() => setCopied(false), 1200); } catch { /* */ } }}
      style={{ background: DK.cell, border: `1px solid ${DK.line}`, borderRadius: 14, padding: "16px 10px", textAlign: "center", cursor: "pointer", position: "relative" }}
    >
      <span style={{ position: "absolute", top: 9, right: 11, fontSize: 11, color: copied ? DK.green : DK.faint }}>{copied ? "✓" : "⧉"}</span>
      <div style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 10, fontWeight: 700, letterSpacing: "0.18em", textTransform: "uppercase", color: DK.faint }}>{label}</div>
      <div style={{ marginTop: 6, fontSize: big ? 24 : 21, fontWeight: 800, letterSpacing: "-0.01em", color, fontVariantNumeric: "tabular-nums" }}>{value}</div>
      {pips != null && <div style={{ marginTop: 4, fontSize: 12, color: DK.faint }}>({pips})</div>}
    </button>
  );
}

function ExecutePanel({ call, livePrice }: { call: NonNullable<DecisionObject["call"]>; livePrice: number }) {
  const [accts, setAccts] = useState<MpAccount[]>([]);
  const [acct, setAcct] = useState<string>("");
  const [risk, setRisk] = useState<number>(1);
  const [step, setStep] = useState<"idle" | "confirm" | "placing" | "done" | "error">("idle");
  const [note, setNote] = useState<string>("");

  useEffect(() => {
    fetch("/api/matty-pips/accounts").then((r) => r.json()).then((j) => {
      if (j?.ok && Array.isArray(j.accounts)) {
        setAccts(j.accounts as MpAccount[]);
        if (j.accounts[0]) { setAcct(String((j.accounts[0] as MpAccount).account_id)); const rp = (j.accounts[0] as MpAccount).risk_pct; if (rp) setRisk(rp); }
      }
    }).catch(() => {});
  }, []);

  async function place() {
    setStep("placing"); setNote("");
    // A market execution fills at the CURRENT price. When the plan is a
    // LIMIT/STOP entry elsewhere, re-anchor the stop and TP1 at the live
    // print so the dollar risk stays exactly what the card promised.
    const marketNow = call.executionState && call.executionState !== "TAKE_NOW" && Number.isFinite(livePrice);
    const up = call.direction === "buy";
    const entry = marketNow ? livePrice : call.entry;
    const stop = marketNow ? +(up ? livePrice - call.stopDollars : livePrice + call.stopDollars).toFixed(2) : call.stopLoss;
    const tp = marketNow ? +(up ? livePrice + call.tp1Dollars : livePrice - call.tp1Dollars).toFixed(2) : call.tp1;
    try {
      const r = await fetch("/api/flow/execute", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: "play", symbol: "XAUUSD", side: call.direction,
          entry, stop, tp,
          riskPct: risk, accountId: acct || "all",
        }),
      });
      const j = await r.json();
      if (j?.ok) { setStep("done"); setNote("Order placed at market with your stop and TP1 attached."); }
      else { setStep("error"); setNote(j?.detail || j?.error || "Couldn't place the trade — check your connection in FLOW."); }
    } catch { setStep("error"); setNote("Network hiccup — nothing was placed. Try again."); }
  }

  const selStyle: React.CSSProperties = { padding: "9px 10px", borderRadius: 10, border: `1px solid ${DK.line}`, fontSize: 12.5, fontWeight: 700, color: DK.ink, background: "#10151E" };
  if (!accts.length) {
    return (
      <div style={{ marginTop: 14, borderTop: `1px solid ${DK.line}`, paddingTop: 12, fontSize: 12.5, color: DK.sub }}>
        Connect your TradeLocker account in <b style={{ color: DK.ink }}>FLOW</b> to execute this call with one tap — or flip <b style={{ color: DK.ink }}>Auto trade</b> on and the AI takes its confirmed setups for you.
      </div>
    );
  }
  const notNow = call.executionState && call.executionState !== "TAKE_NOW";
  return (
    <div style={{ marginTop: 14, borderTop: `1px solid ${DK.line}`, paddingTop: 13 }}>
      {notNow && call.entryPlan && (
        <div style={{ marginBottom: 10, fontSize: 12, color: "#FBBF24", lineHeight: 1.5 }}>
          ⚠ The plan is <b>{call.executionState === "WAIT_FOR_PRICE" ? `a LIMIT at ${fmt(call.entryPlan.price)}` : `a stop entry on the break of ${fmt(call.entryPlan.price)}`}</b> — executing here fills at market instead, with the same ${call.stopDollars.toFixed(2)} stop and ${call.tp1Dollars.toFixed(2)} TP1 re-anchored to your fill. Better price = wait for the zone.
        </div>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <select value={acct} onChange={(e) => setAcct(e.target.value)} style={{ ...selStyle, maxWidth: 300 }}>
          {accts.map((a) => <option key={`${a.connection_id}:${a.account_id}`} value={String(a.account_id)}>{a.name || `Account ${a.acc_num}`}</option>)}
        </select>
        <select value={risk} onChange={(e) => setRisk(+e.target.value)} style={selStyle}>
          {[0.25, 0.5, 1, 1.5, 2, 3].map((v) => <option key={v} value={v}>{v}% risk</option>)}
        </select>
        {step === "confirm" ? (
          <>
            <button onClick={place} style={{ padding: "10px 16px", borderRadius: 10, border: "none", cursor: "pointer", fontSize: 12.5, fontWeight: 800, background: call.direction === "buy" ? DK.green : DK.red, color: "#04121C" }}>
              Confirm — place {call.direction.toUpperCase()} now
            </button>
            <button onClick={() => setStep("idle")} style={{ padding: "10px 12px", borderRadius: 10, border: `1px solid ${DK.line}`, cursor: "pointer", fontSize: 12.5, fontWeight: 700, background: "transparent", color: DK.sub }}>Cancel</button>
          </>
        ) : (
          <button onClick={() => (step === "placing" ? null : setStep("confirm"))} disabled={step === "placing"}
            style={{ padding: "10px 16px", borderRadius: 10, border: "none", cursor: "pointer", fontSize: 12.5, fontWeight: 800, background: DK.ink, color: "#0B0E14", opacity: step === "placing" ? 0.6 : 1 }}>
            {step === "placing" ? "Placing…" : step === "done" ? "✓ Placed — again?" : `⚡ Execute ${call.direction.toUpperCase()} on my account`}
          </button>
        )}
      </div>
      {note && <div style={{ marginTop: 8, fontSize: 12, color: step === "error" ? DK.red : DK.green, lineHeight: 1.5 }}>{note}</div>}
      <div style={{ marginTop: 8, fontSize: 11, color: DK.faint }}>
        Places at market on YOUR account, sized to {risk}% of live equity, stop and TP1 attached. Or turn on <b style={{ color: DK.sub }}>Auto trade</b> and the AI takes its confirmed setups hands-free.
      </div>
    </div>
  );
}

function MiniBar({ label, value, color, max = 100 }: { label: string; value: number; color: string; max?: number }) {
  return (
    <div style={{ flex: "1 1 130px", minWidth: 120 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 9.5, fontWeight: 800, letterSpacing: "0.14em", textTransform: "uppercase", color: DK.faint }}>{label}</span>
        <span style={{ fontSize: 11.5, fontWeight: 800, color, fontVariantNumeric: "tabular-nums" }}>{value}</span>
      </div>
      <div style={{ height: 6, borderRadius: 999, background: "rgba(255,255,255,0.08)", overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${Math.max(2, Math.min(100, (value / max) * 100))}%`, borderRadius: 999, background: color, transition: "width .5s" }} />
      </div>
    </div>
  );
}

function Chip({ children, color }: { children: React.ReactNode; color?: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "4px 10px", borderRadius: 999, border: `1px solid ${DK.line}`, background: DK.cell, fontFamily: "ui-monospace, Menlo, monospace", fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: color ?? DK.sub, whiteSpace: "nowrap" }}>
      {children}
    </span>
  );
}

const EXEC_META: Record<string, { label: string; color: string; bg: string }> = {
  TAKE_NOW: { label: "TAKE IT NOW", color: "#04121C", bg: DK.green },
  WAIT_FOR_PRICE: { label: "WAIT FOR PRICE", color: "#1A1204", bg: "#FBBF24" },
  BREAKOUT_ENTRY: { label: "BREAKOUT ENTRY", color: "#04121C", bg: DK.blue },
};

function MattysCall({ d }: { d: DecisionObject }) {
  const call = d.call!;
  const buy = call.direction === "buy";
  const col = buy ? DK.green : DK.red;
  const conf = call.conviction ?? call.confidence;
  const confCol = conf >= 70 ? DK.green : conf >= 55 ? "#FBBF24" : DK.sub;
  const pips = (v: number | null) => (v == null ? null : `${Math.round(Math.abs(v - call.entry) / 0.1).toLocaleString()}`);
  const exec = call.executionState ? EXEC_META[call.executionState] : null;
  const hasV2 = call.buyScore != null && call.sellScore != null;
  return (
    <div style={{ background: DK.bg, borderRadius: 20, border: `1px solid ${DK.line}`, boxShadow: "0 16px 40px rgba(0,0,0,0.35)", padding: "22px 24px", marginBottom: 14, color: DK.ink }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "10px 16px", marginBottom: 10 }}>
        <div style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 10.5, fontWeight: 700, letterSpacing: "0.2em", textTransform: "uppercase", color: DK.faint }}>Matty&rsquo;s call · right now</div>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 11.5, fontWeight: 800, color: confCol }}>{conf}% conviction</span>
          <span style={{ width: 92, height: 7, borderRadius: 999, background: "rgba(255,255,255,0.08)", overflow: "hidden", display: "inline-block" }}>
            <span style={{ display: "block", height: "100%", width: `${conf}%`, borderRadius: 999, background: confCol, transition: "width .5s" }} />
          </span>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", marginBottom: 10 }}>
        <span style={{ fontSize: 30, fontWeight: 850, letterSpacing: "-0.01em", color: col }}>{buy ? "BUY GOLD" : "SELL GOLD"}</span>
        {exec && (
          <span style={{ padding: "6px 14px", borderRadius: 999, fontSize: 12, fontWeight: 900, letterSpacing: "0.08em", background: exec.bg, color: exec.color }}>
            {exec.label}{call.executionState !== "TAKE_NOW" && call.entryPlan ? ` · ${fmt(call.entryPlan.price)}` : ""}
          </span>
        )}
        <span style={{ fontSize: 12.5, fontWeight: 700, color: DK.sub }}>Risk : Reward 1 : {call.rr1}</span>
      </div>
      {(call.setupFamily || call.regime || call.session || call.volatility || call.expectedMove) && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
          {call.setupFamily && <Chip color={col}>{call.setupFamily.replace(/_/g, " ")}</Chip>}
          {call.expectedMove && <Chip color={DK.ink}>next move ${call.expectedMove.min}–${call.expectedMove.max}</Chip>}
          {call.regime && <Chip>4H {call.regime}</Chip>}
          {call.session && <Chip>{call.session}</Chip>}
          {call.volatility && <Chip color={call.volatility === "EXTREME" ? DK.red : call.volatility === "ELEVATED" ? "#FBBF24" : DK.sub}>vol {call.volatility}</Chip>}
        </div>
      )}
      <div style={{ margin: "0 0 14px", fontSize: 13.5, lineHeight: 1.6, color: DK.sub, borderLeft: `3px solid ${col}55`, paddingLeft: 12 }}>
        {call.entryPlan?.note ? call.entryPlan.note : <>Gun to the head, this is the side I take — {call.reasons[0]}. Stop ${call.stopDollars.toFixed(2)} away, first target ${call.tp1Dollars.toFixed(2)} out.</>}
      </div>
      {hasV2 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "10px 18px", marginBottom: 14, padding: "12px 14px", borderRadius: 14, border: `1px solid ${DK.line}`, background: DK.cell }}>
          <MiniBar label="Buy case" value={call.buyScore!} color={DK.green} />
          <MiniBar label="Sell case" value={call.sellScore!} color={DK.red} />
          {call.entryQualityScore != null && <MiniBar label="Entry quality" value={call.entryQualityScore} color={call.entryQualityScore >= 60 ? DK.green : call.entryQualityScore >= 40 ? "#FBBF24" : DK.red} />}
        </div>
      )}

      <CallChart d={d} call={call} />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginTop: 12 }}>
        <CopyCell label="Entry" value={fmt(call.entry)} pips={null} color={DK.ink} big />
        <CopyCell label="⛨ Stop" value={fmt(call.stopLoss)} pips={pips(call.stopLoss)} color={DK.red} />
        <CopyCell label="Risk : Reward" value={`1 : ${call.rr1}`} pips={null} color={DK.blue} />
        <CopyCell label="◎ TP1" value={fmt(call.tp1)} pips={pips(call.tp1)} color={DK.green} />
        {call.tp2 != null && <CopyCell label="◎ TP2" value={fmt(call.tp2)} pips={pips(call.tp2)} color={DK.green} />}
        {call.tp3 != null && <CopyCell label="◎ TP3" value={fmt(call.tp3)} pips={pips(call.tp3)} color={DK.green} />}
      </div>
      <div style={{ marginTop: 9, fontSize: 11, color: DK.faint, textAlign: "center" }}>
        {buy ? "Long" : "Short"} · figures in parentheses are pips from entry · tap a level to copy
      </div>

      <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", marginTop: 14 }}>
        <div>
          <div style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 10, fontWeight: 800, letterSpacing: "0.14em", textTransform: "uppercase", color: DK.green, marginBottom: 5 }}>Behind the call</div>
          {call.reasons.slice(0, 4).map((r) => <div key={r} style={{ fontSize: 12.5, color: DK.sub, lineHeight: 1.6 }}>✓ {r}</div>)}
        </div>
        {call.against.length > 0 && (
          <div>
            <div style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 10, fontWeight: 800, letterSpacing: "0.14em", textTransform: "uppercase", color: DK.red, marginBottom: 5 }}>Against it</div>
            {call.against.slice(0, 3).map((r) => <div key={r} style={{ fontSize: 12.5, color: DK.faint, lineHeight: 1.6 }}>✗ {r}</div>)}
          </div>
        )}
      </div>
      {Array.isArray(call.timeframes) && call.timeframes.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 8, marginTop: 14 }}>
          {call.timeframes.map((tf) => (
            <div key={tf.tf} title={tf.note} style={{ background: DK.cell, border: `1px solid ${DK.line}`, borderRadius: 12, padding: "10px 10px", textAlign: "center" }}>
              <div style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 9.5, fontWeight: 800, letterSpacing: "0.16em", color: DK.faint }}>{tf.tf}</div>
              <div style={{ marginTop: 4, fontSize: 12, fontWeight: 800, color: /UP|BUY/.test(tf.state) ? DK.green : /DOWN|SELL/.test(tf.state) ? DK.red : DK.sub }}>
                {tf.state}
              </div>
            </div>
          ))}
        </div>
      )}
      {Array.isArray(call.riskFactors) && call.riskFactors.length > 0 && (
        <div style={{ marginTop: 12, fontSize: 12, color: DK.faint, lineHeight: 1.6 }}>
          {call.riskFactors.slice(0, 3).map((r) => <div key={r}>⚠ {r}</div>)}
        </div>
      )}
      <ExecutePanel call={call} livePrice={d.price} />
    </div>
  );
}

/* ══ PAGE ═════════════════════════════════════════════════════════════════ */
export default function MattyPips() {
  const [symbol, setSymbol] = useState("XAUUSD");
  const [mode, setMode] = useState<Mode>("aggressive");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<AnalyzeResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [savedItems, setSavedItems] = useState<SavedItem[]>([]);
  const [viewingSaved, setViewingSaved] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [showAuto, setShowAuto] = useState(false);

  async function loadSaved() {
    try {
      const r = await fetch("/api/matty-pips/saved");
      const j = await r.json();
      if (j.ok) setSavedItems(j.items as SavedItem[]);
    } catch { /* best-effort */ }
  }
  useEffect(() => { loadSaved(); }, []);

  async function findTrade(symOverride?: string, modeOverride?: Mode) {
    if (busy) return;
    setBusy(true); setErr(null); setViewingSaved(null); setSaveState("idle");
    try {
      const r = await fetch("/api/matty-pips/analyze", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ symbol: symOverride ?? symbol, mode: modeOverride ?? mode }),
      });
      const j = (await r.json()) as AnalyzeResponse | EngineError;
      if (j.ok) setRes(j);
      else setErr(j.detail || j.error || "Read failed — try again.");
    } catch { setErr("Network hiccup — try again."); }
    finally { setBusy(false); }
  }

  async function saveRead() {
    if (!res?.analysisId || saveState !== "idle") return;
    setSaveState("saving");
    try {
      const r = await fetch("/api/matty-pips/saved", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: res.analysisId }),
      });
      const j = await r.json();
      if (j.ok) { setSaveState("saved"); loadSaved(); } else setSaveState("idle");
    } catch { setSaveState("idle"); }
  }

  async function openSaved(id: string) {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/matty-pips/saved?id=${encodeURIComponent(id)}`);
      const j = await r.json();
      if (j.ok && j.item?.decision?.ok) {
        const d = j.item.decision as AnalyzeResponse;
        d.analysisId = j.item.id;
        setRes(d); setSymbol(d.symbol); setMode(d.mode);
        setViewingSaved(j.item.created_at as string); setSaveState("saved");
      } else setErr("Couldn't open that saved read.");
    } catch { setErr("Couldn't open that saved read."); }
    finally { setBusy(false); }
  }

  const read = res ? currentRead(res) : null;
  const st = res ? statusMeta(res) : null;
  const role = res ? levelRole(res) : null;
  const sups = res ? res.levels.filter((l) => l.kind === "support").sort((a, b) => b.high - a.high) : [];
  const ress = res ? res.levels.filter((l) => l.kind === "resistance").sort((a, b) => a.low - b.low) : [];
  const sup = res?.activeNode?.kind !== "resistance";
  const late = !!res && !res.trade && res.reaction.confirmedByClose && (res.entryQuality === "LATE" || res.entryQuality === "CHASE");

  const barBtn: React.CSSProperties = { padding: "7px 13px", borderRadius: 9, fontSize: 12, fontWeight: 700, cursor: "pointer", border: `1px solid ${C.line}`, background: "#fff", color: C.ink };

  return (
    <div style={{ background: C.bg, color: C.ink, fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif", borderRadius: 16, minHeight: 500 }}>
      <style>{`
        .mpx-wrap { max-width: 1060px; margin: 0 auto; padding: 0 14px 60px; }
        .mpx-grid { display: grid; grid-template-columns: 1fr; gap: 14px; }
        .mpx-chartcol { order: 2; min-width: 0; }
        .mpx-sidecol { order: 1; min-width: 0; display: flex; flex-direction: column; gap: 14px; }
        @media (min-width: 980px) {
          .mpx-grid { grid-template-columns: 1.85fr 1fr; align-items: start; }
          .mpx-chartcol { order: 1; }
          .mpx-sidecol { order: 2; }
        }
        .mpx-bar { position: sticky; top: 0; z-index: 30; backdrop-filter: blur(10px); background: rgba(247,250,252,0.88); border-bottom: 1px solid #E9EFF5; }
        details.mpx-acc > summary { list-style: none; }
        details.mpx-acc > summary::-webkit-details-marker { display: none; }
      `}</style>

      {/* 1 · COMMAND BAR */}
      <div className="mpx-bar">
        <div className="mpx-wrap" style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", flexWrap: "wrap" }}>
          <div style={{ marginRight: "auto" }}>
            <div style={{ fontSize: 16, fontWeight: 800, lineHeight: 1.1 }}>Matty <span style={{ color: C.blueDeep }}>Pips</span></div>
            <div style={{ fontSize: 10, fontWeight: 600, color: C.sub, letterSpacing: "0.08em", textTransform: "uppercase" }}>Gold intelligence</div>
          </div>
          {res && (
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: C.sub }}>{res.displayName.replace(/ \(.+\)/, "")}</span>
              <span style={{ fontSize: 17, fontWeight: 800, color: C.blueDeep }}>{fmt(res.price)}</span>
              {st && <span style={{ fontSize: 10, fontWeight: 800, color: "#fff", background: st.color, borderRadius: 999, padding: "3px 9px" }}>{st.label}</span>}
            </div>
          )}
          <div style={{ display: "flex", gap: 7, marginLeft: "auto" }}>
            <button onClick={() => findTrade(res?.symbol, res?.mode)} disabled={busy}
              style={{ ...barBtn, background: C.blueDeep, border: "none", color: "#fff" }}>
              {busy ? "Reading…" : res ? "⟳ Update read" : "Find me a trade"}
            </button>
            {res && (
              <button onClick={saveRead} disabled={!res.analysisId || saveState !== "idle"} style={barBtn}>
                {saveState === "saved" ? "✓ Saved" : "Save read"}
              </button>
            )}
            <button onClick={() => setShowAuto((x) => !x)} style={{ ...barBtn, background: showAuto ? C.ink : "#fff", color: showAuto ? "#fff" : C.ink }}>Auto trade</button>
          </div>
        </div>
      </div>

      <div className="mpx-wrap" style={{ paddingTop: 16 }}>
        {showAuto && <MattyAuto />}
        {err && <div style={{ background: C.card, borderRadius: 16, boxShadow: C.shadow, border: "1px solid #F1CACA", color: C.red, fontSize: 14, padding: "14px 18px", marginBottom: 14 }}>{err}</div>}

        {res && read && st && (
          <>
            {viewingSaved && (
              <div style={{ fontSize: 11.5, color: C.sub, margin: "2px 2px 10px" }}>
                Saved read from {new Date(viewingSaved).toLocaleString()} — hit Update for a fresh look.
              </div>
            )}

            {/* 2 · CURRENT READ */}
            <div style={{ background: C.card, borderRadius: 20, boxShadow: C.shadow, padding: "28px 28px 24px", marginBottom: 14 }}>
              <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", color: C.sub, marginBottom: 8 }}>Current read</div>
              <div style={{ fontSize: 31, fontWeight: 850, letterSpacing: "-0.01em", lineHeight: 1.12, marginBottom: 18 }}>{read.headline}</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "14px 28px", marginBottom: 16 }}>
                {[
                  { l: "Level in play", v: res.activeNode ? `${fmt(res.activeNode.low)} – ${fmt(res.activeNode.high)}` : "—" },
                  { l: "Market phase", v: read.phase },
                  { l: "Status", v: st.label, c: st.color },
                  { l: "Timeframe", v: "15M trigger" },
                ].map((x) => (
                  <div key={x.l}>
                    <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: C.sub }}>{x.l}</div>
                    <div style={{ fontSize: 15.5, fontWeight: 800, color: x.c ?? C.ink }}>{x.v}</div>
                  </div>
                ))}
              </div>
              <div style={{ fontSize: 14.5, lineHeight: 1.6, color: C.ink, borderLeft: `3px solid ${C.iceDeep}`, paddingLeft: 14 }}>
                &ldquo;{mattysRead(res)}&rdquo;
              </div>
              {role && <div style={{ marginTop: 10, fontSize: 12, fontWeight: 700, color: C.blueDeep }}>Level history: {role}</div>}
            </div>

            {/* 2.5 · MATTY'S CALL — the always-on decision with confidence + execute */}
            {res.call && <MattysCall d={res} />}

            {/* 3+4+5 · WORKSTATION: chart ⅔ · decision + cases ⅓ */}
            <div className="mpx-grid" style={{ marginBottom: 14 }}>
              <div className="mpx-chartcol"><StoryChart d={res} /></div>
              <div className="mpx-sidecol">
                {/* trade decision */}
                <div style={{ background: C.card, borderRadius: 20, boxShadow: C.shadow, padding: "20px 20px" }}>
                  <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", color: C.sub, marginBottom: 12 }}>Trade decision</div>
                  {/* thin progression rail */}
                  <div style={{ display: "flex", alignItems: "center", gap: 0, marginBottom: 14 }}>
                    {(["WAIT", "APPROACHING", "ARMED", "TAKE_NOW"] as const).map((s, i) => {
                      const active = res.status === s;
                      const passed = ["WAIT", "APPROACHING", "ARMED", "TAKE_NOW"].indexOf(res.status) > i;
                      return (
                        <div key={s} style={{ display: "flex", alignItems: "center", flex: i < 3 ? 1 : "none" }}>
                          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                            <span style={{ width: active ? 12 : 8, height: active ? 12 : 8, borderRadius: 999, background: active ? st.color : passed ? C.iceDeep : "#E3EBF2", transition: "all .3s" }} />
                            <span style={{ fontSize: 8.5, fontWeight: 800, letterSpacing: "0.05em", color: active ? st.color : C.sub, whiteSpace: "nowrap" }}>{s.replace("_", " ")}</span>
                          </div>
                          {i < 3 && <span style={{ flex: 1, height: 2, background: passed ? C.iceDeep : "#EDF2F7", margin: "0 4px 14px" }} />}
                        </div>
                      );
                    })}
                  </div>
                  <div style={{ fontSize: 20, fontWeight: 850, color: st.color, marginBottom: 6 }}>{late ? "MOVE IN PROGRESS" : st.label}</div>
                  <div style={{ fontSize: 13, lineHeight: 1.55, color: C.ink }}>
                    {late ? "The setup was valid but the entry window closed. Don't chase — wait for the pullback." : res.trade ? res.reaction.detail : res.noTradeReason}
                  </div>
                </div>

                {/* bull / bear cases */}
                <div style={{ display: "grid", gap: 10 }}>
                  <div style={{ background: C.card, borderRadius: 16, boxShadow: C.shadow, padding: "16px 18px", borderLeft: `3px solid ${C.green}` }}>
                    <div style={{ fontSize: 12, fontWeight: 800, color: C.green, marginBottom: 6 }}>BULL CASE</div>
                    <div style={{ fontSize: 12.5, lineHeight: 1.7, color: C.ink }}>
                      {sup ? <>Support holds<br />15M rejection closes<br />Buyers push away</> : <>Break above holds<br />Retest becomes support<br />Continuation close</>}
                    </div>
                    <div style={{ marginTop: 8, fontSize: 12.5, fontWeight: 800 }}>→ <span style={{ color: C.green }}>BUY</span> toward {ress[0] ? fmt(ress[0].low) : "the recent high"}</div>
                  </div>
                  <div style={{ background: C.card, borderRadius: 16, boxShadow: C.shadow, padding: "16px 18px", borderLeft: `3px solid ${C.red}` }}>
                    <div style={{ fontSize: 12, fontWeight: 800, color: C.red, marginBottom: 6 }}>BEAR CASE</div>
                    <div style={{ fontSize: 12.5, lineHeight: 1.7, color: C.ink }}>
                      {sup ? <>15M closes below<br />Reclaim fails<br />Zone flips to resistance</> : <>Resistance holds<br />15M rejection closes<br />Sellers push away</>}
                    </div>
                    <div style={{ marginTop: 8, fontSize: 12.5, fontWeight: 800 }}>→ <span style={{ color: C.red }}>SELL</span> toward {sup ? (sups[1] ? fmt(sups[1].high) : "the next support") : (sups[0] ? fmt(sups[0].high) : "the next support")}</div>
                  </div>
                </div>
              </div>
            </div>

            {/* 6 · TRADE PLAN */}
            <div style={{ background: C.card, borderRadius: 20, boxShadow: C.shadow, padding: "22px 24px", marginBottom: 14 }}>
              <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", color: C.sub, marginBottom: 12 }}>Trade plan</div>
              {res.trade ? (
                <>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap", marginBottom: 14 }}>
                    <span style={{ fontSize: 22, fontWeight: 850, color: res.trade.direction === "buy" ? C.green : C.red }}>
                      TAKE NOW — {res.trade.direction.toUpperCase()}
                    </span>
                    <span style={{ fontSize: 12.5, fontWeight: 700, color: C.sub }}>Risk / reward 1 : {res.trade.riskReward}</span>
                    {res.entryQuality && <span style={{ fontSize: 12.5, fontWeight: 700, color: C.sub }}>Entry {lower(res.entryQuality)}</span>}
                  </div>
                  {/* horizontal price ladder */}
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {([
                      res.trade.runnerTarget != null ? { l: "Runner", v: res.trade.runnerTarget, c: "#1B8B8B", w: 100 } : null,
                      res.trade.tp2 != null ? { l: "TP2", v: res.trade.tp2, c: C.green, w: 88 } : null,
                      { l: "TP1 · take profit", v: res.trade.tp1, c: C.green, w: 76 },
                      { l: "Entry", v: res.trade.entry, c: C.blueDeep, w: 56 },
                      { l: "Stop · get out if wrong", v: res.trade.stopLoss, c: C.red, w: 40 },
                    ].filter(Boolean) as { l: string; v: number; c: string; w: number }[])
                      .sort((a, b) => (res.trade!.direction === "buy" ? b.v - a.v : a.v - b.v))
                      .map((row) => (
                        <div key={row.l} style={{ display: "flex", alignItems: "center", gap: 12 }}>
                          <span style={{ width: 150, fontSize: 12, fontWeight: 700, color: row.c }}>{row.l}</span>
                          <span style={{ flex: 1, height: 8, borderRadius: 999, background: `${row.c}18`, position: "relative", overflow: "hidden" }}>
                            <span style={{ position: "absolute", inset: 0, width: `${row.w}%`, borderRadius: 999, background: `${row.c}55` }} />
                          </span>
                          <span style={{ width: 84, textAlign: "right", fontSize: 15, fontWeight: 800, color: C.ink }}>{fmt(row.v)}</span>
                        </div>
                      ))}
                  </div>
                  <div style={{ marginTop: 12, fontSize: 12, color: C.sub }}>
                    Managed: +{res.trade.management.breakevenAtPips}p → breakeven · partial → stop locks +{res.trade.management.lockProfitPips}p in profit.
                  </div>
                </>
              ) : (
                <div style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 20, fontWeight: 850, color: late ? C.amber : C.sub }}>{late ? "ENTRY WINDOW CLOSED" : "NO TRADE YET"}</span>
                  <span style={{ fontSize: 13.5, color: C.ink }}>{late ? "Don't chase — the next clean spot is coming." : "Let the level decide."}</span>
                </div>
              )}
            </div>

            {/* 7 · ADVANCED INTELLIGENCE */}
            <div style={{ background: C.card, borderRadius: 20, boxShadow: C.shadow, padding: "8px 20px", marginBottom: 14 }}>
              <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", color: C.sub, padding: "12px 4px 4px" }}>Advanced intelligence</div>
              <Acc title="Market structure">
                <p style={{ margin: "4px 0" }}>{res.structureContext.detail}</p>
                <p style={{ margin: "4px 0", color: C.sub }}>Approach: {res.approach.detail}</p>
              </Acc>
              <Acc title="Liquidity">
                <p style={{ margin: "4px 0" }}>{res.liquidity.detail}</p>
              </Acc>
              <Acc title="Breakout / fakeout">
                <p style={{ margin: "4px 0" }}>Reaction engine: {lower(res.reaction.state)} — {res.reaction.detail}</p>
                {res.breakoutQuality && <p style={{ margin: "4px 0", color: C.sub }}>Break grade: {lower(res.breakoutQuality.replace("BREAKOUT_", ""))}.</p>}
                {res.liquidity.fakeoutProbability && <p style={{ margin: "4px 0", color: C.amber }}>Fakeout probability: {lower(res.liquidity.fakeoutProbability.replace("FAKEOUT_", ""))}.</p>}
                {res.expansionDetail && <p style={{ margin: "4px 0", color: C.sub }}>{res.expansionDetail}</p>}
              </Acc>
              {res.symbol === "XAUUSD" && <Acc title="DXY"><p style={{ margin: "4px 0" }}>{res.dxy.detail}</p></Acc>}
              {res.news.screened && <Acc title="News context"><p style={{ margin: "4px 0" }}>{res.news.note}</p></Acc>}
              <Acc title="Entry quality">
                <p style={{ margin: "4px 0" }}>{res.entryQuality ? `Entry timing grades ${lower(res.entryQuality)}.` : "No entry to grade yet."} {res.badLocation ?? ""}</p>
              </Acc>
              <Acc title="Setup score" last>
                <p style={{ margin: "4px 0" }}>
                  <b>{res.score.total}/100</b> · quality <b>{res.tradeQuality === "A_PLUS" ? "A+" : lower(res.tradeQuality)}</b>
                </p>
                <p style={{ margin: "4px 0", color: C.sub }}>
                  level {res.score.levelLocation}/20 · reaction {res.score.reaction}/20 · structure {res.score.structure}/15 · liquidity {res.score.liquidity}/10 · 15M {res.score.confirmation}/15 · risk {res.score.riskTarget}/10 · momentum {res.score.momentum}/5 · DXY {res.score.dxy}/3 · news {res.score.news}/2
                </p>
                <p style={{ margin: "6px 0 2px", color: C.sub }}>{res.engineVersion} · {res.mode} mode · educational, not financial advice</p>
              </Acc>
            </div>

            {/* 8 · LEVEL MAP */}
            <LevelMap sups={sups} ress={ress} price={res.price} name={marketName(res)} />
          </>
        )}

        {savedItems.length > 0 && (
          <div style={{ background: C.card, borderRadius: 20, boxShadow: C.shadow, padding: "18px 20px", marginBottom: 14 }}>
            <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", color: C.sub, marginBottom: 10 }}>Saved reads</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {savedItems.map((it) => (
                <button key={it.id} onClick={() => openSaved(it.id)}
                  style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "#F8FAFC", border: "none", borderRadius: 10, padding: "10px 14px", cursor: "pointer", textAlign: "left" }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: it.verdict === "TRADE" ? C.green : C.ink }}>
                    {MARKETS.find((m) => m.canonical === it.symbol)?.label ?? it.symbol} · {it.verdict === "TRADE" ? "Trade" : "Watching"}
                  </span>
                  <span style={{ fontSize: 11, color: C.sub }}>{new Date(it.created_at).toLocaleString()}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {!res && !err && (
          <div style={{ textAlign: "center", color: C.sub, fontSize: 13.5, padding: "44px 20px", lineHeight: 1.7 }}>
            <div style={{ fontSize: 17, fontWeight: 800, color: C.ink, marginBottom: 6 }}>Where is Gold, what level matters, and is there a trade?</div>
            Tap <b>Find me a trade</b>. Matty Pips reads the market and answers in plain language.
          </div>
        )}
      </div>
    </div>
  );
}

/* ══ MARKET STORY CHART — the visual centerpiece ══════════════════════════ */
function StoryChart({ d }: { d: DecisionObject }) {
  const [tf, setTf] = useState<"m15" | "h1">("m15");
  const all: Candle[] = d.chart?.[tf] ?? [];
  const candles = tf === "m15" ? all.slice(-34) : all.slice(-52);
  if (candles.length < 10) return null;

  const node = d.activeNode;
  const isFloor = node?.kind !== "resistance";
  const name = marketName(d);
  const role = levelRole(d);

  // dynamic story chain
  const steps: string[] = [];
  const ext = d.structureContext.externalTrend;
  steps.push(ext === "UPTREND" ? "Bullish move" : ext === "DOWNTREND" ? "Bearish move" : "Range");
  if (role) steps.push(isFloor ? "Resistance broke" : "Support broke");
  if (d.liquidity.sweep) steps.push("Liquidity sweep");
  const phase = currentRead(d).phase;
  if (steps[steps.length - 1] !== phase) steps.push(phase);

  const W = 760, H = 356, L = 14, R = 14, T = 40, B = 14;
  const plotW = W - L - R, plotH = H - T - B;
  let lo = Math.min(...candles.map((c) => c.l));
  let hi = Math.max(...candles.map((c) => c.h));
  const span0 = Math.max(hi - lo, 1e-9);
  const want: number[] = [];
  if (node) want.push(node.low, node.high);
  if (d.trade) want.push(d.trade.stopLoss, d.trade.tp1, d.trade.entry);
  for (const w of want) {
    if (w < lo) lo = Math.max(w, lo - span0 * 0.65);
    if (w > hi) hi = Math.min(w, hi + span0 * 0.65);
  }
  const pad = (hi - lo) * 0.09; lo -= pad; hi += pad;
  const y = (p: number) => T + ((hi - p) / (hi - lo)) * plotH;
  const x = (i: number) => L + ((i + 0.5) / candles.length) * plotW;
  const cw = Math.max(5, (plotW / candles.length) * 0.66);
  const inY = (p: number) => p >= lo && p <= hi;
  const clampY = (p: number) => Math.max(T + 8, Math.min(T + plotH - 8, y(p)));
  const last = candles[candles.length - 1];
  const lastX = x(candles.length - 1);
  const fmtP = (n: number) => (n >= 100 ? n.toLocaleString(undefined, { maximumFractionDigits: 1 }) : String(+n.toFixed(4)));

  // one quiet neighbor each way
  const nextUp = d.levels.filter((z) => z.kind === "resistance" && (z.low + z.high) / 2 > (node?.high ?? last.c) && inY((z.low + z.high) / 2)).sort((a, b) => a.low - b.low)[0];
  const nextDn = d.levels.filter((z) => z.kind === "support" && (z.low + z.high) / 2 < (node?.low ?? last.c) && inY((z.low + z.high) / 2)).sort((a, b) => b.high - a.high)[0];

  // chronological event markers (≤2 numbered + decision zone label)
  const buf = span0 * 0.006;
  const events: { i: number; p: number; label: string }[] = [];
  if (node && role) {
    const edge = isFloor ? node.high : node.low;
    const idx = candles.findIndex((c) => (isFloor ? c.c > edge + buf : c.c < edge - buf));
    if (idx > 1 && idx < candles.length - 3) {
      events.push({ i: idx, p: isFloor ? candles[idx].h : candles[idx].l, label: "Breakout" });
      events.push({ i: Math.floor((idx + candles.length - 1) / 2), p: candles[Math.floor((idx + candles.length - 1) / 2)][isFloor ? "h" : "l"], label: "Pullback" });
    }
  }
  const sweep = d.liquidity.sweep;
  const trade = d.trade;

  return (
    <div style={{ background: "#FFFFFF", borderRadius: 20, boxShadow: "0 1px 10px rgba(30,60,90,0.05)", padding: "18px 14px 12px" }}>
      {/* story header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, padding: "0 8px", marginBottom: 10, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", color: "#6B7C8C", marginBottom: 6 }}>The market story</div>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 700 }}>
            {steps.slice(0, 4).map((s, i) => (
              <span key={i} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ background: i === steps.length - 1 ? "#DCEAF7" : "#F2F7FC", borderRadius: 7, padding: "3px 9px", color: i === steps.length - 1 ? "#2F6FA8" : "#6B7C8C" }}>{s}</span>
                {i < Math.min(steps.length, 4) - 1 && <span style={{ color: "#5B9BD5" }}>→</span>}
              </span>
            ))}
          </div>
        </div>
        <div style={{ display: "flex", gap: 5 }}>
          {(["h1", "m15"] as const).map((t) => (
            <button key={t} onClick={() => setTf(t)}
              style={{ padding: "4px 11px", borderRadius: 999, fontSize: 10.5, fontWeight: 700, cursor: "pointer", border: "none", background: tf === t ? "#2F6FA8" : "#EDF4FB", color: tf === t ? "#fff" : "#6B7C8C" }}>
              {t === "m15" ? "15M · entry" : "1H · map"}
            </button>
          ))}
        </div>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }}>
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1={L} x2={L + plotW} y1={T + plotH * f} y2={T + plotH * f} stroke="#F1F5F9" strokeWidth={1} />
        ))}

        {trade && (
          <g>
            <rect x={L} y={Math.min(y(trade.entry), y(trade.stopLoss))} width={plotW} height={Math.abs(y(trade.entry) - y(trade.stopLoss))} fill="#D65A5A" opacity={0.05} />
            <rect x={L} y={Math.min(y(trade.entry), y(trade.tp1))} width={plotW} height={Math.abs(y(trade.entry) - y(trade.tp1))} fill="#169B6B" opacity={0.06} />
          </g>
        )}

        {/* DECISION ZONE — the one emphasized level */}
        {node && (
          <g>
            <rect x={L} y={y(Math.min(node.high, hi))} width={plotW}
              height={Math.max(6, y(Math.max(node.low, lo)) - y(Math.min(node.high, hi)))}
              rx={5} fill={isFloor ? "#169B6B" : "#D65A5A"} opacity={0.15} />
            <text x={L + 10} y={y(Math.min(node.high, hi)) - 7} fontSize="12" fontWeight="800" fill={isFloor ? "#169B6B" : "#D65A5A"}>
              DECISION ZONE · {fmtP(node.low)}–{fmtP(node.high)}{role ? ` · ${role}` : ""}
            </text>
          </g>
        )}

        {/* quiet neighbors */}
        {nextUp && (
          <g>
            <line x1={L} x2={L + plotW} y1={y((nextUp.low + nextUp.high) / 2)} y2={y((nextUp.low + nextUp.high) / 2)} stroke="#D65A5A" strokeWidth={1} strokeDasharray="5 5" opacity={0.3} />
            <text x={L + plotW - 6} y={y((nextUp.low + nextUp.high) / 2) - 5} fontSize="9.5" fontWeight="700" fill="#D65A5A" opacity={0.65} textAnchor="end">Next resistance {fmtP((nextUp.low + nextUp.high) / 2)}</text>
          </g>
        )}
        {nextDn && (
          <g>
            <line x1={L} x2={L + plotW} y1={y((nextDn.low + nextDn.high) / 2)} y2={y((nextDn.low + nextDn.high) / 2)} stroke="#169B6B" strokeWidth={1} strokeDasharray="5 5" opacity={0.3} />
            <text x={L + plotW - 6} y={y((nextDn.low + nextDn.high) / 2) + 12} fontSize="9.5" fontWeight="700" fill="#169B6B" opacity={0.65} textAnchor="end">Next support {fmtP((nextDn.low + nextDn.high) / 2)}</text>
          </g>
        )}

        {/* candles */}
        {candles.map((c, i) => {
          const up = c.c >= c.o;
          const col = up ? "#169B6B" : "#D65A5A";
          const bt = y(Math.max(c.o, c.c)), bb = y(Math.min(c.o, c.c));
          return (
            <g key={i}>
              <line x1={x(i)} x2={x(i)} y1={y(c.h)} y2={y(c.l)} stroke={col} strokeWidth={1.2} opacity={0.85} />
              <rect x={x(i) - cw / 2} y={bt} width={cw} height={Math.max(2, bb - bt)} fill={col} rx={1.5} />
            </g>
          );
        })}

        {/* numbered story events */}
        {events.map((e, i) => (
          <g key={i}>
            <circle cx={x(e.i)} cy={clampY(e.p) - 15} r={9} fill="#fff" stroke="#2F6FA8" strokeWidth={1.4} />
            <text x={x(e.i)} y={clampY(e.p) - 11} fontSize="10" fontWeight="800" fill="#2F6FA8" textAnchor="middle">{i + 1}</text>
            <text x={x(e.i)} y={clampY(e.p) - 28} fontSize="9.5" fontWeight="700" fill="#6B7C8C" textAnchor="middle">{e.label}</text>
          </g>
        ))}

        {sweep && inY(sweep.extreme) && (
          <text x={L + plotW * 0.5} y={clampY(sweep.extreme) + (sweep.side === "buy-side" ? -8 : 16)} fontSize="10.5" fontWeight="800" fill="#C99019" textAnchor="middle">
            Fake break — price pushed back ✕
          </text>
        )}

        {/* trade lines */}
        {trade && ([
          [trade.entry, `Entry ${fmtP(trade.entry)}`, "#2F6FA8", ""],
          [trade.stopLoss, `Stop ${fmtP(trade.stopLoss)}`, "#D65A5A", "6 4"],
          [trade.tp1, `TP1 ${fmtP(trade.tp1)}`, "#169B6B", "6 4"],
        ] as [number, string, string, string][]).map(([p, lbl, col, dash], i) => (
          <g key={`t${i}`}>
            <line x1={L} x2={L + plotW} y1={y(p)} y2={y(p)} stroke={col} strokeWidth={1.5} strokeDasharray={dash || undefined} />
            <rect x={L + 6} y={y(p) - 10} width={lbl.length * 6.2 + 14} height={19} rx={9.5} fill="#fff" stroke={col} strokeWidth={1} />
            <text x={L + 13} y={y(p) + 3.5} fontSize="10" fontWeight="800" fill={col}>{lbl}</text>
          </g>
        ))}

        {/* live price flag */}
        <g>
          <circle cx={lastX} cy={y(last.c)} r={5} fill="#2F6FA8" stroke="#fff" strokeWidth={2} />
          <rect x={Math.min(lastX - 50, L + plotW - 104)} y={y(last.c) - 34} width={100} height={20} rx={10} fill="#1E2B38" />
          <text x={Math.min(lastX, L + plotW - 54)} y={y(last.c) - 20} fontSize="10.5" fontWeight="800" fill="#fff" textAnchor="middle">
            {name} · {fmtP(last.c)}
          </text>
        </g>
      </svg>

      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "7px 8px 2px", fontSize: 11, color: "#6B7C8C", flexWrap: "wrap" }}>
        <span>{tf === "m15" ? "15M — the entry: are we taking the trade?" : "1H — the map: why this level matters"}</span>
        <span>{node ? `Shaded band = the level that decides the next trade` : "Dashed lines = the next levels worth watching"}</span>
      </div>
    </div>
  );
}

/* ══ LEVEL MAP — four rows, trader language, expandable ═══════════════════ */
function LevelMap({ sups, ress, price, name }: { sups: RankedLevel[]; ress: RankedLevel[]; price: number; name: string }) {
  const [all, setAll] = useState(false);
  const rows = [
    ress[1] ? { l: "Next resistance", z: ress[1], c: C.red } : null,
    ress[0] ? { l: "Current resistance", z: ress[0], c: C.red } : null,
    sups[0] ? { l: "Current support", z: sups[0], c: C.green } : null,
    sups[1] ? { l: "Next support", z: sups[1], c: C.green } : null,
  ].filter(Boolean) as { l: string; z: RankedLevel; c: string }[];
  const full = [...ress].reverse().concat(sups);
  return (
    <div style={{ background: C.card, borderRadius: 20, boxShadow: C.shadow, padding: "20px 22px", marginBottom: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", color: C.sub }}>Level map</div>
        <button onClick={() => setAll((x) => !x)} style={{ fontSize: 11.5, fontWeight: 700, color: C.blueDeep, background: "none", border: "none", cursor: "pointer" }}>
          {all ? "Show key levels" : "View all levels"}
        </button>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {!all && rows.slice(0, 2).map((r) => <LevelRow key={r.l} {...r} />)}
        {!all && (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 14px", borderRadius: 10, background: C.ice }}>
            <span style={{ fontSize: 12.5, fontWeight: 800, color: C.blueDeep }}>{name} now</span>
            <span style={{ fontSize: 14, fontWeight: 800, color: C.blueDeep }}>{fmt(price)}</span>
          </div>
        )}
        {!all && rows.slice(2).map((r) => <LevelRow key={r.l} {...r} />)}
        {all && full.map((z, i) => (
          <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 14px", borderRadius: 10, background: "#F8FAFC" }}>
            <span style={{ fontSize: 12.5, fontWeight: 700, color: z.kind === "resistance" ? C.red : C.green }}>
              {z.kind === "resistance" ? "Resistance" : "Support"} · {levelWhy(z)}{z.brokeAndRetested ? " · flipped" : ""}
            </span>
            <span style={{ fontSize: 13, fontWeight: 700 }}>{fmt(z.low)} – {fmt(z.high)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
function LevelRow({ l, z, c }: { l: string; z: RankedLevel; c: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 14px", borderRadius: 10, background: "#F8FAFC" }}>
      <span style={{ fontSize: 12.5, fontWeight: 700, color: c }}>{l} <span style={{ color: C.sub, fontWeight: 500 }}>· {levelWhy(z)}</span></span>
      <span style={{ fontSize: 14, fontWeight: 800 }}>{fmt(z.low)} – {fmt(z.high)}</span>
    </div>
  );
}

/* ── AUTO TRADE PANEL ────────────────────────────────────────────────────── */
function MattyAuto() {
  const [accounts, setAccounts] = useState<MpAccount[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  async function load() {
    try {
      const r = await fetch("/api/matty-pips/accounts");
      const j = await r.json();
      if (j.ok) setAccounts(j.accounts as MpAccount[]);
      else setMsg(j.error || "Couldn't load accounts.");
    } catch { setMsg("Couldn't load accounts."); }
  }
  useEffect(() => { load(); }, []);

  async function update(a: MpAccount, patch: Record<string, unknown>) {
    setPending(a.account_id); setMsg(null);
    try {
      const r = await fetch("/api/matty-pips/accounts", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountId: a.account_id, connectionId: a.connection_id, accNum: a.acc_num, ...patch }),
      });
      const j = await r.json();
      if (j.ok) setAccounts(j.accounts as MpAccount[]);
      else setMsg(j.error || "Save failed.");
    } catch { setMsg("Save failed."); }
    finally { setPending(null); }
  }

  const Toggle = ({ on, onClick, disabled }: { on: boolean; onClick: () => void; disabled?: boolean }) => (
    <button onClick={onClick} disabled={disabled} aria-pressed={on}
      style={{ width: 44, height: 24, borderRadius: 999, border: "none", cursor: "pointer", background: on ? C.green : "#CBD8E2", position: "relative", opacity: disabled ? 0.6 : 1, flexShrink: 0 }}>
      <span style={{ position: "absolute", top: 3, left: on ? 23 : 3, width: 18, height: 18, borderRadius: 999, background: "#fff", transition: "left .15s" }} />
    </button>
  );

  return (
    <div style={{ background: C.card, borderRadius: 20, boxShadow: C.shadow, padding: "20px 22px", marginBottom: 14 }}>
      <div style={{ fontSize: 14.5, fontWeight: 800, marginBottom: 4 }}>Matty Pips Auto</div>
      <div style={{ fontSize: 12.5, color: C.sub, lineHeight: 1.55, marginBottom: 12 }}>
        Turn it on per account and Matty Pips takes its own <b>TAKE NOW</b> calls on that account —
        sized to your risk %, with its own breakeven and partials. Uses the account you connected on
        FLOW. Turn it off anytime. Trading involves risk.
      </div>
      {msg && <div style={{ fontSize: 13, color: C.red, marginBottom: 10 }}>{msg}</div>}
      {!accounts && !msg && <div style={{ fontSize: 13, color: C.sub }}>Loading your accounts…</div>}
      {accounts && accounts.length === 0 && (
        <div style={{ fontSize: 13, color: C.sub }}>No connected accounts yet — connect your TradeLocker account on the FLOW tab first.</div>
      )}
      {accounts && accounts.map((a) => (
        <div key={a.account_id} style={{ borderTop: `1px solid ${C.line}`, padding: "13px 0" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: a.enabled ? 11 : 0 }}>
            <div>
              <div style={{ fontSize: 13.5, fontWeight: 700 }}>{a.name || "Account"} · #{a.acc_num}</div>
              <div style={{ fontSize: 11.5, color: C.sub }}>{a.enabled ? `Auto ON · ${a.risk_pct}% risk · aggressive` : "Auto off"}</div>
            </div>
            <Toggle on={a.enabled} disabled={pending === a.account_id} onClick={() => update(a, { enabled: !a.enabled, mode: "aggressive" })} />
          </div>
          {a.enabled && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 13, alignItems: "center", fontSize: 12.5 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600, color: C.sub }}>
                Risk
                <select value={String(a.risk_pct)} disabled={pending === a.account_id}
                  onChange={(e) => update(a, { riskPct: Number(e.target.value) })}
                  style={{ padding: "5px 8px", borderRadius: 8, border: `1px solid ${C.line}`, fontWeight: 700, color: C.ink }}>
                  {["0.25", "0.5", "1", "1.5", "2"].map((v) => <option key={v} value={v}>{v}%</option>)}
                </select>
              </label>
              {/* Aggressive is the only mode (owner 09-04) — older accounts are
                  migrated the next time any setting is saved. */}
              <span style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600, color: C.sub }}>
                Mode <b style={{ color: C.ink, fontWeight: 700 }}>Aggressive</b>
              </span>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 600, color: C.sub }}>
                Breakeven
                <Toggle on={a.be_enabled} disabled={pending === a.account_id} onClick={() => update(a, { beEnabled: !a.be_enabled })} />
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 600, color: C.sub }}>
                Partials
                <Toggle on={a.partials_enabled} disabled={pending === a.account_id} onClick={() => update(a, { partialsEnabled: !a.partials_enabled })} />
              </label>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/* ── collapsible advanced section ────────────────────────────────────────── */
function Acc({ title, children, last }: { title: string; children: React.ReactNode; last?: boolean }) {
  return (
    <details className="mpx-acc" style={{ borderBottom: last ? "none" : `1px solid ${C.line}` }}>
      <summary style={{ cursor: "pointer", padding: "12px 4px", fontSize: 13.5, fontWeight: 700, color: C.ink, display: "flex", justifyContent: "space-between" }}>
        {title}<span style={{ color: C.sub }}>›</span>
      </summary>
      <div style={{ padding: "0 4px 14px", fontSize: 13, lineHeight: 1.55 }}>{children}</div>
    </details>
  );
}
