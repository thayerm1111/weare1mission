"use client";

import { useEffect, useState } from "react";
import type { Candle, DecisionObject, EngineError, Mode } from "@/lib/matty-pips/types";

/**
 * MATTY PIPS — decision-first UI. Premium, minimal, plain language.
 * Hierarchy: what's happening → the level → the read → BUY/SELL/WAIT →
 * what confirms it → advanced details tucked into accordions.
 */

type AnalyzeResponse = DecisionObject & { analysisId?: string | null };
type SavedItem = { id: string; symbol: string; mode: string; status: string; verdict: string; score: number; price: number; created_at: string };

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

/* ── Plain-language read builder ─────────────────────────────────────────── */
function plainRead(d: DecisionObject): { read: string; explain: string; condition: string } {
  const name = d.symbol === "XAUUSD" ? "Gold" : d.displayName.split(" ")[0];
  const kind = d.activeNode?.kind ?? null;
  const lvl = kind === "resistance" ? "resistance" : "support";
  const st = d.reaction.state;
  const dailyWord = d.daily.marketState === "UPTREND" ? "in a daily uptrend" : d.daily.marketState === "DOWNTREND" ? "in a daily downtrend" : "ranging on the daily";
  const h4 = d.structures.find((t) => t.timeframe === "H4");
  const condition = `${d.daily.marketState === "LEFT_TO_RIGHT" ? "Ranging" : d.daily.marketState === "UPTREND" ? "Uptrend" : "Downtrend"} on the daily · ${h4 ? (h4.marketState === "LEFT_TO_RIGHT" ? "ranging" : lower(h4.marketState)) : "—"} on the 4H`;

  let read = `${name} is drifting between levels`;
  let explain = `No meaningful level is in play right now. ${name} is ${dailyWord} — the tool is watching the map and will call it when price reaches a level that matters.`;
  if (kind) {
    switch (st) {
      case "APPROACHING":
        read = `${name} is approaching ${lvl}`;
        explain = `${name} is traveling toward the ${lvl} zone. Nothing to do yet — the reaction at the level is what creates the trade.`;
        break;
      case "TESTING":
        read = `${name} is testing ${lvl}`;
        explain = `${name} is sitting on ${lvl}. Wait for the 15M to show whether the level holds or breaks — the level picks the direction, not us.`;
        break;
      case "RESPECTING":
        read = `${lvl[0].toUpperCase() + lvl.slice(1)} is holding`;
        explain = `${name} keeps touching the ${lvl} and it keeps holding — but there's no confirmed rejection candle yet. Let the 15M finish the story.`;
        break;
      case "REJECTING":
        read = d.reaction.confirmedByClose
          ? `${lvl[0].toUpperCase() + lvl.slice(1)} just rejected`
          : `${lvl[0].toUpperCase() + lvl.slice(1)} is rejecting`;
        explain = d.reaction.confirmedByClose
          ? `The ${lvl} was tested and it held — the 15M confirmed the rejection. ${kind === "support" ? "Buyers" : "Sellers"} defended the level.`
          : `The ${lvl} looks like it's holding, but the confirming 15M close hasn't printed yet. Almost — not yet.`;
        break;
      case "FAILED_BREAK":
        read = `Fake break at ${lvl}`;
        explain = `Price poked through the ${lvl} and got slapped back inside — that's a liquidity grab, not a breakout. ${d.reaction.confirmedByClose ? "The 15M confirmed it." : "Waiting on the confirming close."}`;
        break;
      case "ACCEPTED_BREAK":
        read = `${name} broke the ${lvl}`;
        explain = `A 15M candle closed through the ${lvl} — the break is real so far. The cleanest trade is usually the retest: let price come back and hold the level.`;
        break;
      case "BREAK_RETEST":
        read = `Break and retest at ${lvl}`;
        explain = `The ${lvl} broke, price came back to test it, and the level is holding as new ${kind === "resistance" ? "support" : "resistance"}. ${d.reaction.confirmedByClose ? "Confirmed." : "One confirming close away."}`;
        break;
      case "MOMENTUM_CONTINUATION":
        read = `${name} is running after the break`;
        explain = `The level broke and price never came back for a clean retest. The tool decides between waiting for the pullback and a valid continuation entry — never blind chasing.`;
        break;
      case "EXPANSION_BREAKOUT":
        read = `Explosive move through the ${lvl}`;
        explain = `A violent candle blew through the level. No chasing the top and no blind fading — the first pullback tells us continuation or exhaustion.`;
        break;
      default:
        read = `${name} is near ${lvl}`;
        explain = d.reaction.detail;
    }
  }
  return { read, explain, condition };
}

function statusColor(s: string): string {
  if (s === "TAKE_NOW") return C.green;
  if (s === "ARMED") return C.amber;
  if (s === "APPROACHING") return C.blue;
  return C.sub;
}

/* ── Page ────────────────────────────────────────────────────────────────── */
export default function MattyPips() {
  const [symbol, setSymbol] = useState("XAUUSD");
  const [mode, setMode] = useState<Mode>("conservative");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<AnalyzeResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [savedItems, setSavedItems] = useState<SavedItem[]>([]);
  const [viewingSaved, setViewingSaved] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");

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

  /* derived display data */
  const pr = res ? plainRead(res) : null;
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

        {/* 1 · HEADER */}
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
          <button disabled style={{ padding: "20px 10px", borderRadius: 16, border: `1px dashed ${C.iceDeep}`, cursor: "not-allowed", background: "transparent", color: C.sub, fontSize: 16, fontWeight: 700 }}>
            Auto trade<div style={{ fontSize: 10, fontWeight: 500, marginTop: 3 }}>coming soon</div>
          </button>
        </div>

        {err && <div style={{ ...card, border: "1px solid #F1CACA", color: C.red, fontSize: 14 }}>{err}</div>}

        {res && pr && (
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

            {/* 2 · MAIN READ CARD (hero) */}
            <div style={{ ...card, padding: "28px 28px 24px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 18 }}>
                <div style={{ fontSize: 18, fontWeight: 700 }}>{res.displayName}</div>
                <div style={{ fontSize: 26, fontWeight: 800, color: C.blueDeep }}>{fmt(res.price)}</div>
              </div>
              <div style={{ fontSize: 26, fontWeight: 800, lineHeight: 1.25, marginBottom: 14 }}>{pr.read}</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 18, marginBottom: 16 }}>
                <div><div style={label}>Level in play</div><div style={{ fontSize: 15, fontWeight: 700 }}>{res.activeNode ? `${fmt(res.activeNode.low)} – ${fmt(res.activeNode.high)}` : "—"}</div></div>
                <div><div style={label}>Timeframe</div><div style={{ fontSize: 15, fontWeight: 700 }}>15M trigger</div></div>
                <div><div style={label}>Condition</div><div style={{ fontSize: 15, fontWeight: 700 }}>{pr.condition}</div></div>
              </div>
              <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
                {(["WAIT", "APPROACHING", "ARMED", "TAKE_NOW"] as const).map((s) => (
                  <div key={s} style={{
                    padding: "6px 13px", borderRadius: 999, fontSize: 11.5, fontWeight: 700,
                    background: res.status === s ? statusColor(s) : C.ice, color: res.status === s ? "#fff" : C.sub,
                  }}>{s === "TAKE_NOW" ? "Take now" : s[0] + s.slice(1).toLowerCase()}</div>
                ))}
              </div>
              <div style={{ fontSize: 15, lineHeight: 1.55, color: C.ink }}>{pr.explain}</div>
            </div>

            {/* the picture */}
            <Chart d={res} />

            {/* 3 · THE PLAY */}
            {res.activeNode && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
                <div style={{ ...card, marginBottom: 0, borderTop: `3px solid ${C.green}` }}>
                  <div style={{ fontSize: 14, fontWeight: 800, color: C.green, marginBottom: 10 }}>Bull case</div>
                  <div style={{ fontSize: 13.5, lineHeight: 1.7, color: C.ink }}>
                    {nodeIsSupport ? <>Support holds<br />15M rejects the zone<br />Candle closes bullish</> : <>Resistance breaks<br />15M closes above<br />Retest holds as support</>}
                  </div>
                  <div style={{ marginTop: 10, fontSize: 13, fontWeight: 700 }}>Action: <span style={{ color: C.green }}>BUY</span> → {bullTarget}</div>
                </div>
                <div style={{ ...card, marginBottom: 0, borderTop: `3px solid ${C.red}` }}>
                  <div style={{ fontSize: 14, fontWeight: 800, color: C.red, marginBottom: 10 }}>Bear case</div>
                  <div style={{ fontSize: 13.5, lineHeight: 1.7, color: C.ink }}>
                    {nodeIsSupport ? <>Support breaks<br />15M closes below<br />Retest fails</> : <>Resistance holds<br />15M rejects the zone<br />Candle closes bearish</>}
                  </div>
                  <div style={{ marginTop: 10, fontSize: 13, fontWeight: 700 }}>Action: <span style={{ color: C.red }}>SELL</span> → {bearTarget}</div>
                </div>
              </div>
            )}

            {/* 4 · WHAT TO DO NOW */}
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
                  <div style={{ fontSize: 14.5, color: C.ink, marginBottom: 18 }}>{res.reaction.detail}</div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, textAlign: "left" }}>
                    <div><div style={label}>Entry</div><div style={{ fontSize: 16, fontWeight: 800 }}>{fmt(res.trade.entry)}</div></div>
                    <div><div style={label}>Stop</div><div style={{ fontSize: 16, fontWeight: 800, color: C.red }}>{fmt(res.trade.stopLoss)}</div></div>
                    <div><div style={label}>Target</div><div style={{ fontSize: 16, fontWeight: 800, color: C.green }}>{fmt(res.trade.tp1)}</div></div>
                  </div>
                  <div style={{ marginTop: 14, fontSize: 12.5, color: C.sub }}>
                    {res.trade.riskReward}:1 to the first target · runner toward {fmt(res.trade.runnerTarget)} · +{res.trade.management.breakevenAtPips} pips → breakeven, partial, then lock +{res.trade.management.lockProfitPips}
                  </div>
                </>
              ) : (
                <>
                  <div style={{ fontSize: 28, fontWeight: 800, color: moveInProgress ? C.amber : C.sub, marginBottom: 8 }}>
                    {moveInProgress ? "Move in progress — don't chase" : "Wait"}
                  </div>
                  <div style={{ fontSize: 14.5, color: C.ink, maxWidth: 520, margin: "0 auto", lineHeight: 1.55 }}>{res.noTradeReason}</div>
                </>
              )}
            </div>

            {/* 5 · WHY */}
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

            {/* nearby levels — simple by default */}
            <div style={card}>
              <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 12 }}>Nearby levels</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                {[
                  ress[1] ? { t: "Next resistance", v: `${fmt(ress[1].low)} – ${fmt(ress[1].high)}`, c: C.red } : null,
                  ress[0] ? { t: "Resistance", v: `${fmt(ress[0].low)} – ${fmt(ress[0].high)}`, c: C.red } : null,
                  { t: `${res.displayName.split(" ")[0]} now`, v: fmt(res.price), c: C.blueDeep },
                  sups[0] ? { t: "Support", v: `${fmt(sups[0].low)} – ${fmt(sups[0].high)}`, c: C.green } : null,
                  sups[1] ? { t: "Next support", v: `${fmt(sups[1].low)} – ${fmt(sups[1].high)}`, c: C.green } : null,
                ].filter(Boolean).map((row, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "9px 14px", borderRadius: 10, background: row!.c === C.blueDeep ? C.ice : "#FAFCFE", fontSize: 14 }}>
                    <span style={{ color: row!.c, fontWeight: 700 }}>{row!.t}</span>
                    <span style={{ fontWeight: 600 }}>{row!.v}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* 6 · ADVANCED (collapsed by default) */}
            <div style={{ ...card, padding: "12px 18px" }}>
              <Acc title="Market structure">
                <p style={{ margin: "4px 0" }}>{res.structureContext.detail}</p>
                <p style={{ margin: "4px 0", color: C.sub }}>Approach: {res.approach.detail}</p>
                <p style={{ margin: "4px 0", color: C.sub }}>Reaction engine: {res.reaction.state.replace(/_/g, " ").toLowerCase()} — {res.reaction.detail}</p>
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
                      {z.kind === "resistance" ? "R" : "S"} {fmt(z.low)}–{fmt(z.high)}{z.complexId ? " ◈" : ""}
                    </span>
                    <span style={{ color: C.sub }}>rank {z.rank} · {z.sources.map(lower).join(", ")}</span>
                  </div>
                ))}
              </Acc>
              <Acc title="Score breakdown">
                <p style={{ margin: "4px 0" }}>
                  Total <b>{res.score.total}/100</b> · quality <b>{res.tradeQuality === "A_PLUS" ? "A+" : lower(res.tradeQuality)}</b>{res.entryQuality ? <> · entry <b>{lower(res.entryQuality)}</b></> : null}
                </p>
                <p style={{ margin: "4px 0", color: C.sub }}>
                  level {res.score.levelLocation}/20 · reaction {res.score.reaction}/20 · structure {res.score.structure}/15 · liquidity {res.score.liquidity}/10 · 15M {res.score.confirmation}/15 · risk {res.score.riskTarget}/10 · momentum {res.score.momentum}/5 · DXY {res.score.dxy}/3 · news {res.score.news}/2
                </p>
              </Acc>
              <Acc title="Engine notes" last>
                {res.whyThisTrade.map((w, i) => <p key={i} style={{ margin: "4px 0", color: C.sub }}>{w}</p>)}
                <p style={{ margin: "6px 0 2px", color: C.sub }}>{res.engineVersion} · {res.mode} · educational, not financial advice</p>
              </Acc>
            </div>
          </>
        )}

        {/* saved reads */}
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

/* collapsible advanced section */
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

/* ── THE PICTURE — candles + levels + trade lines + scenario arrows ──────── */
function Chart({ d }: { d: DecisionObject }) {
  const [tf, setTf] = useState<"m15" | "h1">("m15");
  const candles: Candle[] = d.chart?.[tf] ?? [];
  if (candles.length < 10) return null;

  const W = 760, H = 380, L = 10, R = 100, T = 14, B = 20;
  const plotW = W - L - R, plotH = H - T - B;
  let lo = Math.min(...candles.map((c) => c.l));
  let hi = Math.max(...candles.map((c) => c.h));
  const span0 = Math.max(hi - lo, 1e-9);
  const want: number[] = [];
  if (d.activeNode) want.push(d.activeNode.low, d.activeNode.high);
  if (d.trade) want.push(d.trade.stopLoss, d.trade.tp1, d.trade.entry);
  for (const w of want) {
    if (w < lo) lo = Math.max(w, lo - span0 * 0.8);
    if (w > hi) hi = Math.min(w, hi + span0 * 0.8);
  }
  const pad = (hi - lo) * 0.06; lo -= pad; hi += pad;
  const y = (p: number) => T + ((hi - p) / (hi - lo)) * plotH;
  const x = (i: number) => L + ((i + 0.5) / candles.length) * plotW;
  const cw = Math.max(2, (plotW / candles.length) * 0.62);
  const inY = (p: number) => p >= lo && p <= hi;
  const last = candles[candles.length - 1];
  const lastX = x(candles.length - 1);
  const fmtP = (n: number) => (n >= 100 ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : String(+n.toFixed(5)));

  const node = d.activeNode;
  const nodeMid = node ? (node.low + node.high) / 2 : null;
  const atNode = node && last.c >= node.low && last.c <= node.high;
  const resNode = node?.kind === "resistance";
  const arrowLen = Math.min(56, plotH * 0.2);
  const scen = node && !d.trade ? {
    rejFromY: y(resNode ? node.low : node.high),
    rejToY: y(resNode ? node.low : node.high) + (resNode ? arrowLen : -arrowLen),
    brkFromY: y(resNode ? node.high : node.low),
    brkToY: y(resNode ? node.high : node.low) + (resNode ? -arrowLen : arrowLen),
  } : null;

  const lines: { p: number; label: string; color: string; dash?: string }[] = [];
  if (d.trade) {
    lines.push({ p: d.trade.entry, label: `Entry ${fmtP(d.trade.entry)}`, color: C.blueDeep });
    lines.push({ p: d.trade.stopLoss, label: `Stop ${fmtP(d.trade.stopLoss)}`, color: C.red, dash: "6 4" });
    lines.push({ p: d.trade.tp1, label: `TP1 ${fmtP(d.trade.tp1)}`, color: C.green, dash: "6 4" });
    if (d.trade.tp2 != null && inY(d.trade.tp2)) lines.push({ p: d.trade.tp2, label: `TP2 ${fmtP(d.trade.tp2)}`, color: C.green, dash: "3 4" });
    if (d.trade.runnerTarget != null && inY(d.trade.runnerTarget)) lines.push({ p: d.trade.runnerTarget, label: `Run ${fmtP(d.trade.runnerTarget)}`, color: "#1B8B8B", dash: "2 5" });
  }

  return (
    <div style={{ background: C.card, borderRadius: 20, boxShadow: C.shadow, padding: "18px 12px 10px", marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0 10px", marginBottom: 8 }}>
        <div style={{ fontSize: 15, fontWeight: 800 }}>The picture</div>
        <div style={{ display: "flex", gap: 6 }}>
          {(["m15", "h1"] as const).map((t) => (
            <button key={t} onClick={() => setTf(t)}
              style={{ padding: "4px 12px", borderRadius: 999, fontSize: 11, fontWeight: 700, cursor: "pointer", border: "none", background: tf === t ? C.blueDeep : C.ice, color: tf === t ? "#fff" : C.sub }}>
              {t === "m15" ? "15M" : "1H"}
            </button>
          ))}
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }}>
        <defs>
          <marker id="mp-ar-red" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill={C.red} /></marker>
          <marker id="mp-ar-green" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill={C.green} /></marker>
          <marker id="mp-ar-blue" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill={C.blueDeep} /></marker>
          <marker id="mp-ar-gray" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill={C.sub} /></marker>
        </defs>
        {d.levels.filter((z) => z.high > lo && z.low < hi).map((z, i) => {
          const isNode = node && Math.abs(z.low - node.low) < 1e-9 && Math.abs(z.high - node.high) < 1e-9;
          const col = z.kind === "resistance" ? C.red : C.green;
          return (
            <g key={i}>
              <rect x={L} y={y(Math.min(z.high, hi))} width={plotW} height={Math.max(2, y(Math.max(z.low, lo)) - y(Math.min(z.high, hi)))} fill={col} opacity={isNode ? 0.18 : 0.07} />
              {isNode && <rect x={L} y={y(Math.min(z.high, hi))} width={plotW} height={Math.max(2, y(Math.max(z.low, lo)) - y(Math.min(z.high, hi)))} fill="none" stroke={col} strokeOpacity={0.45} strokeDasharray="4 3" />}
            </g>
          );
        })}
        {node && nodeMid != null && inY(nodeMid) && (
          <text x={L + 6} y={y(node.high) - 4} fontSize="11" fontWeight="700" fill={resNode ? C.red : C.green}>
            {(resNode ? "Resistance " : "Support ") + fmtP(node.low) + "–" + fmtP(node.high)}
          </text>
        )}
        {candles.map((c, i) => {
          const up = c.c >= c.o;
          const col = up ? C.green : C.red;
          const bt = y(Math.max(c.o, c.c)), bb = y(Math.min(c.o, c.c));
          return (
            <g key={i}>
              <line x1={x(i)} x2={x(i)} y1={y(c.h)} y2={y(c.l)} stroke={col} strokeWidth={1} />
              <rect x={x(i) - cw / 2} y={bt} width={cw} height={Math.max(1, bb - bt)} fill={col} rx={0.5} />
            </g>
          );
        })}
        {lines.map((ln, i) => (
          <g key={i}>
            <line x1={L} x2={L + plotW} y1={y(ln.p)} y2={y(ln.p)} stroke={ln.color} strokeWidth={1.4} strokeDasharray={ln.dash} />
            <text x={L + plotW + 4} y={y(ln.p) + 4} fontSize="10.5" fontWeight="700" fill={ln.color}>{ln.label}</text>
          </g>
        ))}
        <circle cx={lastX} cy={y(last.c)} r={3.5} fill={C.blueDeep} stroke="#fff" strokeWidth={1.5} />
        {!d.trade && <text x={L + plotW + 4} y={y(last.c) + 4} fontSize="10.5" fontWeight="700" fill={C.blueDeep}>{fmtP(last.c)}</text>}
        {d.trade ? (
          <line x1={Math.min(lastX + 16, L + plotW - 4)} x2={Math.min(lastX + 16, L + plotW - 4)} y1={y(d.trade.entry)} y2={y(d.trade.tp1) + (d.trade.direction === "buy" ? 8 : -8)}
            stroke={d.trade.direction === "buy" ? C.green : C.red} strokeWidth={2.5}
            markerEnd={d.trade.direction === "buy" ? "url(#mp-ar-green)" : "url(#mp-ar-red)"} />
        ) : node && scen ? (
          <g>
            {!atNode && nodeMid != null && (
              <line x1={lastX - 2} y1={y(last.c)} x2={Math.min(lastX + 26, L + plotW - 4)} y2={y(Math.max(lo, Math.min(hi, nodeMid)))}
                stroke={C.sub} strokeWidth={1.6} strokeDasharray="4 4" markerEnd="url(#mp-ar-gray)" />
            )}
            <line x1={L + plotW * 0.90} x2={L + plotW * 0.90} y1={scen.rejFromY} y2={scen.rejToY}
              stroke={resNode ? C.red : C.green} strokeWidth={2.4} markerEnd={resNode ? "url(#mp-ar-red)" : "url(#mp-ar-green)"} />
            <text x={L + plotW * 0.90 - 4} y={scen.rejToY + (resNode ? 14 : -8)} fontSize="10.5" fontWeight="700" fill={resNode ? C.red : C.green} textAnchor="end">
              {resNode ? "Sell if it rejects" : "Buy if it rejects"}
            </text>
            <line x1={L + plotW * 0.97} x2={L + plotW * 0.97} y1={scen.brkFromY} y2={scen.brkToY}
              stroke={resNode ? C.blueDeep : C.red} strokeWidth={2.4} markerEnd={resNode ? "url(#mp-ar-blue)" : "url(#mp-ar-red)"} />
            <text x={L + plotW * 0.97 - 4} y={scen.brkToY + (resNode ? -8 : 14)} fontSize="10.5" fontWeight="700" fill={resNode ? C.blueDeep : C.red} textAnchor="end">
              {resNode ? "Buy if breaks + holds" : "Sell if breaks + holds"}
            </text>
          </g>
        ) : null}
      </svg>
      <div style={{ padding: "6px 10px 0", fontSize: 10.5, color: C.sub }}>
        Green bands = support · red = resistance · highlighted = the level in play{d.trade ? " · dashed = stop & targets" : " · arrows = the two ways this plays"}
      </div>
    </div>
  );
}
