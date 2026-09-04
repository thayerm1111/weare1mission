"use client";

import { useEffect, useState } from "react";
import type { Candle, DecisionObject, EngineError, LevelSource, Mode, RankedLevel } from "@/lib/matty-pips/types";

/**
 * MATTY PIPS — decision-first UI. Premium, minimal, plain language.
 * The CHART IS THE EXPLANATION: past → now → next, told visually.
 * AUTO panel: members opt their own accounts in (risk %, BE, partials).
 */

type AnalyzeResponse = DecisionObject & { analysisId?: string | null };
type SavedItem = { id: string; symbol: string; mode: string; status: string; verdict: string; score: number; price: number; created_at: string };
type MpAccount = {
  connection_id: string; account_id: string; acc_num: string; name: string | null; currency: string | null;
  enabled: boolean; mode: string; risk_pct: number; be_enabled: boolean; partials_enabled: boolean;
};

const MARKETS: { canonical: string; label: string }[] = [
  { canonical: "XAUUSD", label: "Gold" },
  { canonical: "EURUSD", label: "EUR/USD" },
  { canonical: "GBPUSD", label: "GBP/USD" },
  { canonical: "USDJPY", label: "USD/JPY" },
  { canonical: "NAS100", label: "NAS100" },
  { canonical: "US30", label: "US30" },
  { canonical: "USOIL", label: "Oil" },
];

const C = {
  bg: "#F7FAFC", card: "#FFFFFF", ice: "#EDF4FB", iceDeep: "#DCEAF7",
  blue: "#5B9BD5", blueDeep: "#2F6FA8", ink: "#22313F", sub: "#68798A",
  line: "#E8EFF5", green: "#199868", red: "#D25757", amber: "#C99019",
  shadow: "0 2px 14px rgba(47,111,168,0.07)",
};

const fmt = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? "—" : n >= 100 ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : String(+n.toFixed(5));
const lower = (s: string) => s.replace(/_/g, " ").toLowerCase();

/* ── trader-language level labels ────────────────────────────────────────── */
const SRC_LABEL: [LevelSource, string][] = [
  ["WEEK_HIGH", "Weekly high"], ["WEEK_LOW", "Weekly low"],
  ["PREV_DAY_HIGH", "Prev-day high"], ["PREV_DAY_LOW", "Prev-day low"],
  ["STRUCT_HIGH", "Recent high"], ["STRUCT_LOW", "Recent low"],
  ["DAY_HIGH", "Today's high"], ["DAY_LOW", "Today's low"],
  ["ZONE_D", "Major level"], ["ZONE_H4", "Key level"], ["ZONE_H1", "Level"],
];
function levelLabel(l: RankedLevel): string {
  for (const [src, name] of SRC_LABEL) if (l.sources.includes(src)) return name;
  return l.kind === "support" ? "Support" : "Resistance";
}

/* ── the MARKET STORY (past → now → next), derived from engine output ───── */
function nodeLevel(d: DecisionObject): RankedLevel | null {
  if (!d.activeNode) return null;
  return d.levels.find((l) => l.low >= d.activeNode!.low - 1e-9 && l.high <= d.activeNode!.high + 1e-9) ?? null;
}
function levelRole(d: DecisionObject): string | null {
  const n = d.activeNode; if (!n) return null;
  const flipped = nodeLevel(d)?.brokeAndRetested || d.levels.some((l) => l.complexId != null && n.isComplex && l.brokeAndRetested && l.low >= n.low && l.high <= n.high);
  if (!flipped) return null;
  return n.kind === "support" ? "Old resistance → potential support" : "Old support → potential resistance";
}
function deriveStory(d: DecisionObject): { steps: string[]; read: string } {
  const steps: string[] = [];
  const n = d.activeNode;
  const flip = levelRole(d);
  const ext = d.structureContext.externalTrend;
  steps.push(ext === "UPTREND" ? "Bullish move" : ext === "DOWNTREND" ? "Bearish move" : "Ranging market");
  if (flip) steps.push(n?.kind === "support" ? "Resistance broke" : "Support broke");
  if (d.liquidity.sweep) steps.push(d.liquidity.sweep.side === "buy-side" ? "Swept the highs" : "Swept the lows");
  switch (d.reaction.state) {
    case "APPROACHING": steps.push(n ? `Approaching ${flip ? "the old level" : n.kind}` : "Between levels"); break;
    case "TESTING": steps.push(flip ? `Testing old ${n?.kind === "support" ? "resistance as support" : "support as resistance"}` : `Testing ${n?.kind}`); break;
    case "RESPECTING": steps.push(`${n?.kind === "support" ? "Support" : "Resistance"} holding`); break;
    case "REJECTING": steps.push(`${n?.kind === "support" ? "Support" : "Resistance"} rejecting`); break;
    case "FAILED_BREAK": steps.push("Fake break"); break;
    case "ACCEPTED_BREAK": steps.push("Break confirmed"); break;
    case "BREAK_RETEST": steps.push("Retesting the break"); break;
    case "MOMENTUM_CONTINUATION": steps.push("Running without a retest"); break;
    case "EXPANSION_BREAKOUT": steps.push("Explosive break"); break;
    default: steps.push("Watching the map");
  }

  // Matty's live thought — plain trader language.
  const name = d.symbol === "XAUUSD" ? "Gold" : d.displayName.split(" ")[0];
  const kind = n?.kind === "resistance" ? "resistance" : "support";
  const late = !d.trade && d.reaction.confirmedByClose && (d.entryQuality === "LATE" || d.entryQuality === "CHASE");
  let read = `${name} is between levels — nothing to force out here.`;
  if (late) read = "Good setup, but the move has already left the level. Wait for a pullback instead of chasing.";
  else if (d.trade) read = d.trade.direction === "buy"
    ? `${kind === "support" ? "Support" : "The level"} rejected and buyers confirmed on the 15M — this is the buy window.`
    : `${kind === "resistance" ? "Resistance" : "The level"} rejected and sellers confirmed on the 15M — this is the sell window.`;
  else if (n) {
    switch (d.reaction.state) {
      case "TESTING": read = flip
        ? `${name} is pulling back into ${kind === "support" ? "old resistance" : "old support"}. If ${kind === "support" ? "buyers defend" : "sellers defend"} this area on the 15M, I'm looking for the ${kind === "support" ? "continuation buy" : "continuation sell"}.`
        : `${name} is testing ${kind}. I'm waiting to see what the 15M does at this area.`; break;
      case "RESPECTING": read = `${name} keeps respecting this ${kind} — I need the confirming 15M candle before it's a trade.`; break;
      case "REJECTING": read = d.reaction.confirmedByClose
        ? `The ${kind} rejected and the candle confirmed — the trade is forming right here.`
        : `${name} ${kind === "support" ? "swept below support but reclaimed the zone" : "spiked into resistance and stalled"}. A ${kind === "support" ? "bullish" : "bearish"} 15M close would ${kind === "support" ? "strengthen the buy" : "strengthen the sell"}.`; break;
      case "FAILED_BREAK": read = `${name} poked through the level and closed back inside — that's a liquidity grab, not a breakout. The ${kind === "resistance" ? "sell" : "buy"} back through gets interesting.`; break;
      case "ACCEPTED_BREAK": read = `The level broke on a closed candle. Cleanest trade is the retest — let price come back and hold it.`; break;
      case "BREAK_RETEST": read = `Break, pullback, and the old level is holding. One confirming close and the continuation is on.`; break;
      case "MOMENTUM_CONTINUATION": read = `${name} broke out and never came back. I don't chase — waiting for the pullback or a fresh structure entry.`; break;
      case "EXPANSION_BREAKOUT": read = `Violent move through the level. No chasing the top, no blind fading — the first pullback tells us continuation or exhaustion.`; break;
      case "APPROACHING": read = `${name} is traveling toward the level. The reaction there decides everything — not the approach.`; break;
    }
  }
  return { steps: steps.slice(0, 4), read };
}

function statusColor(s: string): string {
  if (s === "TAKE_NOW") return C.green;
  if (s === "ARMED") return C.amber;
  if (s === "APPROACHING") return C.blue;
  return C.sub;
}

/* ══ PAGE ═════════════════════════════════════════════════════════════════ */
export default function MattyPips() {
  const [symbol, setSymbol] = useState("XAUUSD");
  const [mode, setMode] = useState<Mode>("conservative");
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

  const sups = res ? res.levels.filter((l) => l.kind === "support").sort((a, b) => b.high - a.high) : [];
  const ress = res ? res.levels.filter((l) => l.kind === "resistance").sort((a, b) => a.low - b.low) : [];
  const nodeIsSupport = res?.activeNode?.kind === "support";
  const bullTarget = ress[0] ? `${fmt(ress[0].low)}` : "the recent high";
  const bearTarget = nodeIsSupport ? (sups[1] ? `${fmt(sups[1].high)}` : "the next support") : (sups[0] ? `${fmt(sups[0].high)}` : "the next support");
  const moveInProgress = !!res && !res.trade && res.reaction.confirmedByClose && (res.entryQuality === "LATE" || res.entryQuality === "CHASE");

  const card: React.CSSProperties = { background: C.card, borderRadius: 20, boxShadow: C.shadow, padding: "24px 26px", marginBottom: 16 };
  const label: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: C.sub, marginBottom: 4 };

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.ink, fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif", padding: "36px 16px 90px" }}>
      <div style={{ maxWidth: 720, margin: "0 auto" }}>

        {/* header */}
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <div style={{ fontSize: 36, fontWeight: 800, letterSpacing: "0.04em" }}>Matty <span style={{ color: C.blueDeep }}>Pips</span></div>
          <div style={{ marginTop: 6, fontSize: 13, color: C.sub, fontWeight: 500 }}>Read the market. Wait for the level. Trade the reaction.</div>
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center", marginBottom: 10 }}>
          {MARKETS.map((m) => (
            <button key={m.canonical} onClick={() => setSymbol(m.canonical)}
              style={{
                padding: "8px 16px", borderRadius: 999, fontSize: 13, fontWeight: 600, cursor: "pointer", border: "none",
                background: symbol === m.canonical ? C.blueDeep : C.card, color: symbol === m.canonical ? "#fff" : C.sub,
                boxShadow: symbol === m.canonical ? "none" : C.shadow,
              }}>{m.label}</button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 6, justifyContent: "center", marginBottom: 20 }}>
          {(["conservative", "aggressive"] as Mode[]).map((m) => (
            <button key={m} onClick={() => setMode(m)}
              style={{ padding: "5px 12px", borderRadius: 999, fontSize: 11, fontWeight: 600, cursor: "pointer", border: `1px solid ${mode === m ? C.blueDeep : C.line}`, background: mode === m ? C.ice : "transparent", color: mode === m ? C.blueDeep : C.sub }}>
              {m === "conservative" ? "Conservative" : "Aggressive"}
            </button>
          ))}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 24 }}>
          <button onClick={() => findTrade()} disabled={busy}
            style={{ padding: "20px 10px", borderRadius: 16, border: "none", cursor: busy ? "wait" : "pointer", background: `linear-gradient(135deg, ${C.blueDeep}, ${C.blue})`, color: "#fff", fontSize: 16, fontWeight: 700, boxShadow: "0 8px 24px rgba(47,111,168,0.28)", opacity: busy ? 0.75 : 1 }}>
            {busy ? "Reading the market…" : "Find me a trade"}
          </button>
          <button onClick={() => setShowAuto((v) => !v)}
            style={{ padding: "20px 10px", borderRadius: 16, border: showAuto ? "none" : `1.5px solid ${C.iceDeep}`, cursor: "pointer", background: showAuto ? C.ink : C.card, color: showAuto ? "#fff" : C.blueDeep, fontSize: 16, fontWeight: 700 }}>
            Auto trade<div style={{ fontSize: 10, fontWeight: 500, marginTop: 3, opacity: 0.8 }}>{showAuto ? "close panel" : "connect accounts"}</div>
          </button>
        </div>

        {showAuto && <MattyAuto />}

        {err && <div style={{ ...card, border: "1px solid #F1CACA", color: C.red, fontSize: 14 }}>{err}</div>}

        {res && (
          <>
            {/* update / save */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <div style={{ fontSize: 12, color: C.sub }}>
                {viewingSaved ? <>Saved read · {new Date(viewingSaved).toLocaleString()}</> : <>Live read · {new Date(res.asOf).toLocaleTimeString()}</>}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => findTrade(res.symbol, res.mode)} disabled={busy}
                  style={{ padding: "8px 16px", borderRadius: 10, border: "none", cursor: "pointer", background: C.blueDeep, color: "#fff", fontSize: 13, fontWeight: 700 }}>
                  {busy ? "Updating…" : "⟳ Update"}
                </button>
                <button onClick={saveRead} disabled={!res.analysisId || saveState !== "idle"}
                  style={{ padding: "8px 16px", borderRadius: 10, cursor: "pointer", border: `1px solid ${C.iceDeep}`, background: saveState === "saved" ? C.ice : C.card, color: C.blueDeep, fontSize: 13, fontWeight: 700 }}>
                  {saveState === "saved" ? "✓ Saved" : saveState === "saving" ? "Saving…" : "Save"}
                </button>
              </div>
            </div>

            {/* THE MARKET STORY — chart is the explanation */}
            <StoryChart d={res} />

            {/* the play */}
            {res.activeNode && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
                <div style={{ ...card, marginBottom: 0, borderTop: `3px solid ${C.green}` }}>
                  <div style={{ fontSize: 14, fontWeight: 800, color: C.green, marginBottom: 10 }}>Bull case</div>
                  <div style={{ fontSize: 13.5, lineHeight: 1.7 }}>
                    {nodeIsSupport ? <>Support holds<br />15M rejects the zone<br />Candle closes bullish</> : <>Resistance breaks<br />15M closes above<br />Retest holds as support</>}
                  </div>
                  <div style={{ marginTop: 10, fontSize: 13, fontWeight: 700 }}>Action: <span style={{ color: C.green }}>BUY</span> → {bullTarget}</div>
                </div>
                <div style={{ ...card, marginBottom: 0, borderTop: `3px solid ${C.red}` }}>
                  <div style={{ fontSize: 14, fontWeight: 800, color: C.red, marginBottom: 10 }}>Bear case</div>
                  <div style={{ fontSize: 13.5, lineHeight: 1.7 }}>
                    {nodeIsSupport ? <>Support breaks<br />15M closes below<br />Retest fails</> : <>Resistance holds<br />15M rejects the zone<br />Candle closes bearish</>}
                  </div>
                  <div style={{ marginTop: 10, fontSize: 13, fontWeight: 700 }}>Action: <span style={{ color: C.red }}>SELL</span> → {bearTarget}</div>
                </div>
              </div>
            )}

            {/* what to do now */}
            <div style={{
              ...card, textAlign: "center", padding: "30px 26px",
              background: res.trade ? (res.trade.direction === "buy" ? "#F0FAF5" : "#FDF4F4") : C.card,
              border: res.trade ? `1.5px solid ${res.trade.direction === "buy" ? C.green : C.red}` : "none",
            }}>
              {res.trade ? (
                <>
                  <div style={{ fontSize: 28, fontWeight: 800, color: res.trade.direction === "buy" ? C.green : C.red, marginBottom: 8 }}>
                    Take now — {res.trade.direction === "buy" ? "BUY" : "SELL"}
                  </div>
                  <div style={{ fontSize: 14.5, marginBottom: 18 }}>{res.reaction.detail}</div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, textAlign: "left" }}>
                    <div><div style={label}>Entry</div><div style={{ fontSize: 16, fontWeight: 800 }}>{fmt(res.trade.entry)}</div></div>
                    <div><div style={label}>Stop</div><div style={{ fontSize: 16, fontWeight: 800, color: C.red }}>{fmt(res.trade.stopLoss)}</div></div>
                    <div><div style={label}>Target</div><div style={{ fontSize: 16, fontWeight: 800, color: C.green }}>{fmt(res.trade.tp1)}</div></div>
                  </div>
                  <div style={{ marginTop: 14, fontSize: 12.5, color: C.sub }}>
                    {res.trade.riskReward}:1 to the first target · runner toward {fmt(res.trade.runnerTarget)} · +{res.trade.management.breakevenAtPips}p → breakeven, partial, then lock +{res.trade.management.lockProfitPips}p
                  </div>
                </>
              ) : (
                <>
                  <div style={{ fontSize: 28, fontWeight: 800, color: moveInProgress ? C.amber : C.sub, marginBottom: 8 }}>
                    {moveInProgress ? "Move in progress — don't chase" : "Wait"}
                  </div>
                  <div style={{ fontSize: 14.5, maxWidth: 520, margin: "0 auto", lineHeight: 1.55 }}>{res.noTradeReason}</div>
                </>
              )}
            </div>

            {/* why */}
            <div style={card}>
              <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 12 }}>{res.trade ? "Why this trade" : "Why we wait"}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                {res.whyThisTrade.slice(0, 4).map((w, i) => (
                  <div key={i} style={{ display: "flex", gap: 10, fontSize: 14, lineHeight: 1.5 }}>
                    <span style={{ color: res.trade ? C.green : C.blue, fontWeight: 800 }}>{res.trade ? "✓" : "•"}</span>
                    <span>{w}</span>
                  </div>
                ))}
              </div>
              {res.coach.length > 0 && (
                <div style={{ marginTop: 14, background: "#FFFDF4", borderRadius: 12, padding: "12px 16px", fontSize: 13.5, lineHeight: 1.55 }}>
                  💡 {res.coach[0]}
                </div>
              )}
            </div>

            {/* nearby levels */}
            <div style={card}>
              <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 12 }}>Nearby levels</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                {[
                  ress[1] ? { t: `Next resistance · ${levelLabel(ress[1])}`, v: `${fmt(ress[1].low)} – ${fmt(ress[1].high)}`, c: C.red } : null,
                  ress[0] ? { t: `Resistance · ${levelLabel(ress[0])}`, v: `${fmt(ress[0].low)} – ${fmt(ress[0].high)}`, c: C.red } : null,
                  { t: `${res.displayName.split(" ")[0]} now`, v: fmt(res.price), c: C.blueDeep },
                  sups[0] ? { t: `Support · ${levelLabel(sups[0])}`, v: `${fmt(sups[0].low)} – ${fmt(sups[0].high)}`, c: C.green } : null,
                  sups[1] ? { t: `Next support · ${levelLabel(sups[1])}`, v: `${fmt(sups[1].low)} – ${fmt(sups[1].high)}`, c: C.green } : null,
                ].filter(Boolean).map((row, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "9px 14px", borderRadius: 10, background: row!.c === C.blueDeep ? C.ice : "#FAFCFE", fontSize: 14 }}>
                    <span style={{ color: row!.c, fontWeight: 700 }}>{row!.t}</span>
                    <span style={{ fontWeight: 600 }}>{row!.v}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* advanced */}
            <div style={{ ...card, padding: "12px 18px" }}>
              <Acc title="Market structure">
                <p style={{ margin: "4px 0" }}>{res.structureContext.detail}</p>
                <p style={{ margin: "4px 0", color: C.sub }}>Approach: {res.approach.detail}</p>
                <p style={{ margin: "4px 0", color: C.sub }}>Reaction engine: {lower(res.reaction.state)} — {res.reaction.detail}</p>
              </Acc>
              <Acc title="Liquidity">
                <p style={{ margin: "4px 0" }}>{res.liquidity.detail}</p>
                {res.liquidity.fakeoutProbability && <p style={{ margin: "4px 0", color: C.amber }}>Fakeout probability: {res.liquidity.fakeoutProbability.replace("FAKEOUT_", "").toLowerCase()}</p>}
              </Acc>
              {res.symbol === "XAUUSD" && <Acc title="DXY context"><p style={{ margin: "4px 0" }}>{res.dxy.detail}</p></Acc>}
              {res.news.screened && <Acc title="News"><p style={{ margin: "4px 0" }}>{res.news.note}</p></Acc>}
              <Acc title="Full level map">
                {[...res.levels].reverse().map((z, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", fontSize: 13, borderBottom: `1px solid ${C.line}` }}>
                    <span style={{ color: z.kind === "resistance" ? C.red : C.green, fontWeight: 600 }}>
                      {levelLabel(z)} {fmt(z.low)}–{fmt(z.high)}{z.brokeAndRetested ? " · flipped" : ""}
                    </span>
                    <span style={{ color: C.sub }}>rank {z.rank}</span>
                  </div>
                ))}
              </Acc>
              <Acc title="Score breakdown" last>
                <p style={{ margin: "4px 0" }}>
                  Total <b>{res.score.total}/100</b> · quality <b>{res.tradeQuality === "A_PLUS" ? "A+" : lower(res.tradeQuality)}</b>{res.entryQuality ? <> · entry <b>{lower(res.entryQuality)}</b></> : null}
                </p>
                <p style={{ margin: "4px 0", color: C.sub }}>
                  level {res.score.levelLocation}/20 · reaction {res.score.reaction}/20 · structure {res.score.structure}/15 · liquidity {res.score.liquidity}/10 · 15M {res.score.confirmation}/15 · risk {res.score.riskTarget}/10 · momentum {res.score.momentum}/5 · DXY {res.score.dxy}/3 · news {res.score.news}/2
                </p>
                <p style={{ margin: "6px 0 2px", color: C.sub }}>{res.engineVersion} · {res.mode} · educational, not financial advice</p>
              </Acc>
            </div>
          </>
        )}

        {savedItems.length > 0 && (
          <div style={card}>
            <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 12 }}>Saved reads</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              {savedItems.map((it) => (
                <button key={it.id} onClick={() => openSaved(it.id)}
                  style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "#FAFCFE", border: "none", borderRadius: 10, padding: "11px 14px", cursor: "pointer", textAlign: "left" }}>
                  <span style={{ fontSize: 13.5, fontWeight: 700, color: it.verdict === "TRADE" ? C.green : C.ink }}>
                    {MARKETS.find((m) => m.canonical === it.symbol)?.label ?? it.symbol} · {it.verdict === "TRADE" ? "Trade" : "Watching"}
                  </span>
                  <span style={{ fontSize: 11.5, color: C.sub }}>{new Date(it.created_at).toLocaleString()}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {!res && !err && (
          <div style={{ textAlign: "center", color: C.sub, fontSize: 14, marginTop: 26, lineHeight: 1.65 }}>
            Pick a market and tap <b>Find me a trade</b>.<br />
            Matty Pips maps the levels that matter, watches the reaction on closed 15-minute candles,
            and tells you the one thing that counts: buy, sell, or wait.
          </div>
        )}
      </div>
    </div>
  );
}

/* ── AUTO TRADE PANEL — member opts their own accounts in ────────────────── */
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
    <div style={{ background: C.card, borderRadius: 20, boxShadow: C.shadow, padding: "24px 26px", marginBottom: 24 }}>
      <div style={{ fontSize: 16, fontWeight: 800, marginBottom: 4 }}>Matty Pips Auto</div>
      <div style={{ fontSize: 13, color: C.sub, lineHeight: 1.55, marginBottom: 16 }}>
        Turn it on per account and Matty Pips takes the trades it calls <b>Take now</b> — sized to your
        risk %, with its own breakeven and partial management. Uses the TradeLocker account you already
        connected for Flow (nothing about Flow changes). Trading involves risk; you can turn this off anytime.
      </div>
      {msg && <div style={{ fontSize: 13, color: C.red, marginBottom: 10 }}>{msg}</div>}
      {!accounts && !msg && <div style={{ fontSize: 13, color: C.sub }}>Loading your accounts…</div>}
      {accounts && accounts.length === 0 && (
        <div style={{ fontSize: 13.5, color: C.sub }}>
          No connected trading accounts found. Connect your TradeLocker account on The Floor (Flow) first —
          Matty Pips can then trade it.
        </div>
      )}
      {accounts && accounts.map((a) => (
        <div key={a.account_id} style={{ borderTop: `1px solid ${C.line}`, padding: "16px 0" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: a.enabled ? 12 : 0 }}>
            <div>
              <div style={{ fontSize: 14.5, fontWeight: 700 }}>{a.name || "Account"} · #{a.acc_num}</div>
              <div style={{ fontSize: 12, color: C.sub }}>{a.enabled ? `Auto ON · ${a.risk_pct}% risk · ${a.mode}` : "Auto off"}</div>
            </div>
            <Toggle on={a.enabled} disabled={pending === a.account_id} onClick={() => update(a, { enabled: !a.enabled })} />
          </div>
          {a.enabled && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 14, alignItems: "center", fontSize: 13 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600, color: C.sub }}>
                Risk
                <select value={String(a.risk_pct)} disabled={pending === a.account_id}
                  onChange={(e) => update(a, { riskPct: Number(e.target.value) })}
                  style={{ padding: "6px 8px", borderRadius: 8, border: `1px solid ${C.line}`, fontWeight: 700, color: C.ink }}>
                  {["0.25", "0.5", "1", "1.5", "2"].map((v) => <option key={v} value={v}>{v}%</option>)}
                </select>
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600, color: C.sub }}>
                Mode
                <select value={a.mode} disabled={pending === a.account_id}
                  onChange={(e) => update(a, { mode: e.target.value })}
                  style={{ padding: "6px 8px", borderRadius: 8, border: `1px solid ${C.line}`, fontWeight: 700, color: C.ink }}>
                  <option value="conservative">Conservative</option>
                  <option value="aggressive">Aggressive</option>
                </select>
              </label>
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
    <details style={{ borderBottom: last ? "none" : `1px solid ${C.line}` }}>
      <summary style={{ cursor: "pointer", padding: "12px 4px", fontSize: 14, fontWeight: 700, color: C.ink, listStyle: "none", display: "flex", justifyContent: "space-between" }}>
        {title}<span style={{ color: C.sub }}>›</span>
      </summary>
      <div style={{ padding: "0 4px 14px", fontSize: 13.5, lineHeight: 1.55 }}>{children}</div>
    </details>
  );
}

/* ══ THE MARKET STORY CHART — the chart IS the explanation ════════════════ */
function StoryChart({ d }: { d: DecisionObject }) {
  const [tf, setTf] = useState<"m15" | "h1">("m15");
  const all: Candle[] = d.chart?.[tf] ?? [];
  // 1H = the map (structural story); 15M = the entry (tight, tactical zoom).
  const candles = tf === "m15" ? all.slice(-36) : all.slice(-52);
  const story = deriveStory(d);
  const role = levelRole(d);
  if (candles.length < 10) return null;

  const W = 760, H = 400, L = 12, R = 118, T = 40, B = 22;
  const plotW = W - L - R, plotH = H - T - B;
  let lo = Math.min(...candles.map((c) => c.l));
  let hi = Math.max(...candles.map((c) => c.h));
  const span0 = Math.max(hi - lo, 1e-9);
  const want: number[] = [];
  if (d.activeNode) want.push(d.activeNode.low, d.activeNode.high);
  if (d.trade) want.push(d.trade.stopLoss, d.trade.tp1, d.trade.entry);
  for (const w of want) {
    if (w < lo) lo = Math.max(w, lo - span0 * 0.7);
    if (w > hi) hi = Math.min(w, hi + span0 * 0.7);
  }
  const pad = (hi - lo) * 0.07; lo -= pad; hi += pad;
  const y = (p: number) => T + ((hi - p) / (hi - lo)) * plotH;
  const x = (i: number) => L + ((i + 0.5) / candles.length) * plotW;
  const cw = Math.max(3, (plotW / candles.length) * 0.62);
  const inY = (p: number) => p >= lo && p <= hi;
  const clampY = (p: number) => Math.max(T + 6, Math.min(T + plotH - 6, y(p)));
  const last = candles[candles.length - 1];
  const lastX = x(candles.length - 1);
  const fmtP = (n: number) => (n >= 100 ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : String(+n.toFixed(5)));

  const node = d.activeNode;
  const resNode = node?.kind === "resistance";

  // Secondary levels: the map (1H) shows majors; the entry (15M) shows at most one each side.
  const others = d.levels.filter((z) => z.high > lo && z.low < hi && !(node && Math.abs(z.low - node.low) < 1e-9 && Math.abs(z.high - node.high) < 1e-9));
  const secondary = tf === "h1" ? others.filter((z) => z.rank >= 40) : [
    ...others.filter((z) => z.kind === "resistance").slice(0, 1),
    ...others.filter((z) => z.kind === "support").slice(-1),
  ];

  // Chronological event markers (max 3): break of the node, sweep, now.
  const buf = 0.25 * (span0 / 40 + 1e-9);
  const events: { i: number; p: number; label: string; num: string }[] = [];
  if (node && role) {
    const edge = node.kind === "support" ? node.high : node.low; // the edge that broke to flip it
    const idx = candles.findIndex((c) => (node.kind === "support" ? c.c > edge + buf : c.c < edge - buf));
    if (idx > 1) events.push({ i: idx, p: node.kind === "support" ? candles[idx].h : candles[idx].l, label: "Breakout", num: "②" });
  }
  if (d.liquidity.sweep) {
    const sw = d.liquidity.sweep;
    const idx = candles.findIndex((c) => Math.abs((sw.side === "buy-side" ? c.h : c.l) - sw.extreme) < 1e-6);
    if (idx >= 0) events.push({ i: idx, p: sw.extreme, label: "Liquidity swept", num: "③" });
  }

  const trade = d.trade;
  const lines: { p: number; label: string; color: string; dash?: string }[] = [];
  if (trade) {
    lines.push({ p: trade.entry, label: `Entry ${fmtP(trade.entry)}`, color: C.blueDeep });
    lines.push({ p: trade.stopLoss, label: `Stop ${fmtP(trade.stopLoss)}`, color: C.red, dash: "6 4" });
    lines.push({ p: trade.tp1, label: `Target ${fmtP(trade.tp1)}`, color: C.green, dash: "6 4" });
    if (trade.runnerTarget != null && inY(trade.runnerTarget)) lines.push({ p: trade.runnerTarget, label: `Runner ${fmtP(trade.runnerTarget)}`, color: "#1B8B8B", dash: "2 5" });
  }

  // Liquidity pool markers (only when relevant + in frame, and not already a sweep).
  const pools: { p: number; label: string }[] = [];
  if (!d.liquidity.sweep) {
    const above = d.liquidity.buySidePools.filter(inY).slice(-1);
    const below = d.liquidity.sellSidePools.filter(inY).slice(0, 1);
    if (above.length) pools.push({ p: above[0], label: "Buy-side liquidity" });
    if (below.length) pools.push({ p: below[0], label: "Sell-side liquidity" });
  }

  const arrowLen = Math.min(50, plotH * 0.18);
  const scenX = Math.min(lastX + plotW * 0.05, L + plotW - 8);

  return (
    <div style={{ background: C.card, borderRadius: 20, boxShadow: C.shadow, padding: "20px 14px 12px", marginBottom: 16 }}>
      {/* story header */}
      <div style={{ padding: "0 10px", marginBottom: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <div style={{ fontSize: 15, fontWeight: 800 }}>The market story</div>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span style={{ padding: "5px 12px", borderRadius: 999, fontSize: 11, fontWeight: 800, background: statusColor(d.status), color: "#fff" }}>
              {d.status === "TAKE_NOW" ? (trade ? `TAKE NOW — ${trade.direction.toUpperCase()}` : "TAKE NOW") : d.status.replace("_", " ")}
            </span>
            {(["m15", "h1"] as const).map((t) => (
              <button key={t} onClick={() => setTf(t)}
                style={{ padding: "4px 12px", borderRadius: 999, fontSize: 11, fontWeight: 700, cursor: "pointer", border: "none", background: tf === t ? C.blueDeep : C.ice, color: tf === t ? "#fff" : C.sub }}>
                {t === "m15" ? "15M · entry" : "1H · map"}
              </button>
            ))}
          </div>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 700, color: C.ink, marginBottom: 6 }}>
          {story.steps.map((s, i) => (
            <span key={i} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ background: i === story.steps.length - 1 ? C.iceDeep : "#F2F7FC", borderRadius: 8, padding: "4px 10px", color: i === story.steps.length - 1 ? C.blueDeep : C.sub }}>{s}</span>
              {i < story.steps.length - 1 && <span style={{ color: C.blue }}>→</span>}
            </span>
          ))}
        </div>
        {node && (
          <div style={{ fontSize: 12.5, color: C.sub, marginBottom: 4 }}>
            <b style={{ color: C.ink }}>Level in play:</b> {fmtP(node.low)} – {fmtP(node.high)}{role ? <span style={{ color: C.blueDeep, fontWeight: 700 }}> · {role}</span> : null}
          </div>
        )}
        <div style={{ fontSize: 13.5, fontStyle: "italic", color: C.ink, lineHeight: 1.5 }}>
          <span style={{ fontWeight: 800, fontStyle: "normal", color: C.blueDeep }}>Matty&rsquo;s read · </span>
          &ldquo;{story.read}&rdquo;
        </div>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }}>
        <defs>
          <marker id="ms-g" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill={C.green} /></marker>
          <marker id="ms-r" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill={C.red} /></marker>
        </defs>

        {/* risk / profit shading in trade mode */}
        {trade && (
          <g>
            <rect x={L} y={Math.min(y(trade.entry), y(trade.stopLoss))} width={plotW} height={Math.abs(y(trade.entry) - y(trade.stopLoss))} fill={C.red} opacity={0.05} />
            <rect x={L} y={Math.min(y(trade.entry), y(trade.tp1))} width={plotW} height={Math.abs(y(trade.entry) - y(trade.tp1))} fill={C.green} opacity={0.06} />
          </g>
        )}

        {/* secondary levels — quiet */}
        {secondary.map((z, i) => (
          <g key={`s${i}`}>
            <rect x={L} y={y(Math.min(z.high, hi))} width={plotW} height={Math.max(2, y(Math.max(z.low, lo)) - y(Math.min(z.high, hi)))}
              fill={z.kind === "resistance" ? C.red : C.green} opacity={0.05} />
            <text x={L + 6} y={clampY((z.low + z.high) / 2) + 3.5} fontSize="10" fontWeight="600" fill={z.kind === "resistance" ? "#CE8F8F" : "#7FB9A1"}>
              {levelLabel(z)}
            </text>
          </g>
        ))}

        {/* THE decision zone — the one level that matters */}
        {node && (
          <g>
            <rect x={L} y={y(Math.min(node.high, hi))} width={plotW} height={Math.max(3, y(Math.max(node.low, lo)) - y(Math.min(node.high, hi)))}
              fill={resNode ? C.red : C.green} opacity={0.16} />
            <rect x={L} y={y(Math.min(node.high, hi))} width={plotW} height={Math.max(3, y(Math.max(node.low, lo)) - y(Math.min(node.high, hi)))}
              fill="none" stroke={resNode ? C.red : C.green} strokeOpacity={0.5} strokeDasharray="5 4" rx={3} />
            <text x={L + 6} y={y(node.high) - 6} fontSize="11" fontWeight="800" fill={resNode ? C.red : C.green}>
              DECISION ZONE{role ? ` · ${role.toLowerCase()}` : ""}
            </text>
          </g>
        )}

        {/* liquidity pools */}
        {pools.map((p, i) => (
          <g key={`p${i}`}>
            <line x1={L} x2={L + plotW} y1={y(p.p)} y2={y(p.p)} stroke={C.amber} strokeWidth={1} strokeDasharray="2 5" opacity={0.55} />
            <text x={L + plotW - 4} y={y(p.p) - 4} fontSize="9.5" fontWeight="700" fill={C.amber} textAnchor="end">{p.label}</text>
          </g>
        ))}

        {/* candles */}
        {candles.map((c, i) => {
          const up = c.c >= c.o;
          const col = up ? C.green : C.red;
          const bt = y(Math.max(c.o, c.c)), bb = y(Math.min(c.o, c.c));
          return (
            <g key={i}>
              <line x1={x(i)} x2={x(i)} y1={y(c.h)} y2={y(c.l)} stroke={col} strokeWidth={1} />
              <rect x={x(i) - cw / 2} y={bt} width={cw} height={Math.max(1.2, bb - bt)} fill={col} rx={0.5} />
            </g>
          );
        })}

        {/* chronological event badges */}
        {events.map((e, i) => (
          <g key={`e${i}`}>
            <circle cx={x(e.i)} cy={clampY(e.p) - 14} r={9} fill="#fff" stroke={C.blueDeep} strokeWidth={1.4} />
            <text x={x(e.i)} y={clampY(e.p) - 10} fontSize="10" fontWeight="800" fill={C.blueDeep} textAnchor="middle">{i + 1}</text>
            <text x={x(e.i)} y={clampY(e.p) - 26} fontSize="9.5" fontWeight="700" fill={C.sub} textAnchor="middle">{e.label}</text>
          </g>
        ))}

        {/* sweep annotation */}
        {d.liquidity.sweep && inY(d.liquidity.sweep.extreme) && (
          <text x={L + plotW - 4} y={clampY(d.liquidity.sweep.extreme) + (d.liquidity.sweep.side === "buy-side" ? -6 : 12)} fontSize="10" fontWeight="800" fill={C.amber} textAnchor="end">
            Liquidity swept ✕
          </text>
        )}

        {/* trade lines */}
        {lines.map((ln, i) => (
          <g key={`l${i}`}>
            <line x1={L} x2={L + plotW} y1={y(ln.p)} y2={y(ln.p)} stroke={ln.color} strokeWidth={1.4} strokeDasharray={ln.dash} />
            <text x={L + plotW + 4} y={y(ln.p) + 4} fontSize="10.5" fontWeight="700" fill={ln.color}>{ln.label}</text>
          </g>
        ))}

        {/* live price */}
        <circle cx={lastX} cy={y(last.c)} r={4} fill={C.blueDeep} stroke="#fff" strokeWidth={1.6} />
        {!trade && <text x={L + plotW + 4} y={y(last.c) + 4} fontSize="10.5" fontWeight="700" fill={C.blueDeep}>{fmtP(last.c)}</text>}

        {/* NEXT: conditional paths anchored at the decision zone */}
        {trade ? (
          <g>
            <line x1={scenX} x2={scenX} y1={y(trade.entry)} y2={y(trade.tp1) + (trade.direction === "buy" ? 8 : -8)}
              stroke={trade.direction === "buy" ? C.green : C.red} strokeWidth={2.6}
              markerEnd={trade.direction === "buy" ? "url(#ms-g)" : "url(#ms-r)"} />
          </g>
        ) : node ? (
          <g>
            {/* buy path from the zone */}
            <line x1={scenX} x2={scenX} y1={clampY(node.high)} y2={clampY(node.high) - arrowLen} stroke={C.green} strokeWidth={2.4} markerEnd="url(#ms-g)" opacity={0.9} />
            <text x={scenX + 6} y={clampY(node.high) - arrowLen + 2} fontSize="10" fontWeight="800" fill={C.green}>
              {resNode ? "BUY" : "BUY"}
            </text>
            <text x={scenX + 6} y={clampY(node.high) - arrowLen + 13} fontSize="8.5" fontWeight="600" fill={C.sub}>
              {resNode ? "break + hold above" : "reject + confirm"}
            </text>
            {/* sell path from the zone */}
            <line x1={scenX} x2={scenX} y1={clampY(node.low)} y2={clampY(node.low) + arrowLen} stroke={C.red} strokeWidth={2.4} markerEnd="url(#ms-r)" opacity={0.9} />
            <text x={scenX + 6} y={clampY(node.low) + arrowLen} fontSize="10" fontWeight="800" fill={C.red}>SELL</text>
            <text x={scenX + 6} y={clampY(node.low) + arrowLen + 11} fontSize="8.5" fontWeight="600" fill={C.sub}>
              {resNode ? "reject + confirm" : "break + failed reclaim"}
            </text>
          </g>
        ) : null}
      </svg>
      <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 10px 0", fontSize: 10.5, color: C.sub }}>
        <span>{tf === "m15" ? "15M — the entry: is the trade there?" : "1H — the map: why this area matters"}</span>
        <span>{trade ? "Shaded = risk vs reward" : "Arrows = the two conditional paths — price picks one"}</span>
      </div>
    </div>
  );
}
