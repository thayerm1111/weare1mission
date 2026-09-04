"use client";

import { useEffect, useState } from "react";
import type { Candle, DecisionObject, EngineError, Mode } from "@/lib/matty-pips/types";

type AnalyzeResponse = DecisionObject & { analysisId?: string | null };
type SavedItem = { id: string; symbol: string; mode: string; status: string; verdict: string; score: number; price: number; created_at: string };

/**
 * MATTY PIPS — client UI. Premium-minimal, ice-blue on off-white.
 * Level-first · location-first · reaction-first. Phase: FIND ME A TRADE only;
 * AUTO TRADE ships later and cannot trade from this page.
 */

const MARKETS: { canonical: string; label: string }[] = [
  { canonical: "XAUUSD", label: "GOLD" },
  { canonical: "EURUSD", label: "EUR/USD" },
  { canonical: "GBPUSD", label: "GBP/USD" },
  { canonical: "USDJPY", label: "USD/JPY" },
  { canonical: "NAS100", label: "NAS100" },
  { canonical: "US30", label: "US30" },
  { canonical: "USOIL", label: "OIL" },
];

const C = {
  bg: "#F6F9FC", card: "#FFFFFF", ice: "#EAF3FB", iceDeep: "#D7E9F8",
  blue: "#5B9BD5", blueDeep: "#2F6FA8", ink: "#1C2B3A", sub: "#5C7186",
  line: "#E3ECF4", green: "#1E9E6A", red: "#D25757", amber: "#C99019",
};

const pretty = (s: string) => s.replace(/_/g, " ");

function statusColor(s: string): string {
  if (s === "TAKE_NOW") return C.green;
  if (s === "ARMED") return C.amber;
  if (s === "APPROACHING") return C.blue;
  return C.sub;
}
function qualityColor(q: string): string {
  if (q === "A_PLUS" || q === "HIGH_QUALITY") return C.green;
  if (q === "VALID") return C.blue;
  if (q === "LOW_QUALITY") return C.amber;
  return C.sub;
}
function fmt(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n >= 100 ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : String(+n.toFixed(5));
}

export default function MattyPips() {
  const [symbol, setSymbol] = useState("XAUUSD");
  const [mode, setMode] = useState<Mode>("conservative");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<AnalyzeResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [savedItems, setSavedItems] = useState<SavedItem[]>([]);
  const [viewingSaved, setViewingSaved] = useState<string | null>(null); // created_at of the saved read being viewed
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");

  async function loadSaved() {
    try {
      const r = await fetch("/api/matty-pips/saved");
      const j = await r.json();
      if (j.ok) setSavedItems(j.items as SavedItem[]);
    } catch { /* list is best-effort */ }
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
      else { setErr(j.detail || j.error || "Read failed — try again."); }
    } catch {
      setErr("Network hiccup — try again.");
    } finally {
      setBusy(false);
    }
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
        setRes(d);
        setSymbol(d.symbol); setMode(d.mode);
        setViewingSaved(j.item.created_at as string);
        setSaveState("saved");
      } else setErr("Couldn't open that saved read.");
    } catch { setErr("Couldn't open that saved read."); }
    finally { setBusy(false); }
  }

  const st = res?.structures ?? [];

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.ink, fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif", padding: "28px 16px 80px" }}>
      <div style={{ maxWidth: 780, margin: "0 auto" }}>

        {/* BRAND */}
        <div style={{ textAlign: "center", marginBottom: 26 }}>
          <div style={{ fontSize: 34, fontWeight: 800, letterSpacing: "0.06em" }}>MATTY <span style={{ color: C.blueDeep }}>PIPS</span></div>
          <div style={{ marginTop: 6, fontSize: 12, letterSpacing: "0.22em", color: C.sub, fontWeight: 600 }}>
            READ THE MARKET. FIND THE LEVEL. WAIT FOR THE TRADE.
          </div>
        </div>

        {/* MARKET + MODE */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center", marginBottom: 10 }}>
          {MARKETS.map((m) => (
            <button key={m.canonical} onClick={() => setSymbol(m.canonical)}
              style={{
                padding: "8px 14px", borderRadius: 999, fontSize: 13, fontWeight: 700, cursor: "pointer",
                border: `1px solid ${symbol === m.canonical ? C.blueDeep : C.line}`,
                background: symbol === m.canonical ? C.iceDeep : C.card,
                color: symbol === m.canonical ? C.blueDeep : C.sub,
              }}>{m.label}</button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "center", marginBottom: 22 }}>
          {(["conservative", "aggressive"] as Mode[]).map((m) => (
            <button key={m} onClick={() => setMode(m)}
              style={{
                padding: "6px 12px", borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: "pointer", textTransform: "uppercase", letterSpacing: "0.08em",
                border: `1px solid ${mode === m ? C.blueDeep : C.line}`,
                background: mode === m ? C.ice : C.card, color: mode === m ? C.blueDeep : C.sub,
              }}>{m}</button>
          ))}
        </div>

        {/* TWO LARGE ACTIONS */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 26 }}>
          <button onClick={() => findTrade()} disabled={busy}
            style={{
              padding: "22px 10px", borderRadius: 16, border: "none", cursor: busy ? "wait" : "pointer",
              background: `linear-gradient(135deg, ${C.blueDeep}, ${C.blue})`, color: "#fff",
              fontSize: 17, fontWeight: 800, letterSpacing: "0.04em", boxShadow: "0 6px 20px rgba(47,111,168,0.25)",
              opacity: busy ? 0.75 : 1,
            }}>
            {busy ? "READING THE MARKET…" : "FIND ME A TRADE"}
          </button>
          <button disabled title="Ships in a later phase"
            style={{
              padding: "22px 10px", borderRadius: 16, border: `1px dashed ${C.iceDeep}`, cursor: "not-allowed",
              background: C.card, color: C.sub, fontSize: 17, fontWeight: 800, letterSpacing: "0.04em",
            }}>
            AUTO TRADE<div style={{ fontSize: 10, fontWeight: 600, marginTop: 4, letterSpacing: "0.12em" }}>COMING SOON</div>
          </button>
        </div>

        {err && (
          <div style={{ background: "#FDF2F2", border: "1px solid #F1CACA", color: C.red, borderRadius: 12, padding: "12px 16px", fontSize: 14, marginBottom: 18 }}>{err}</div>
        )}

        {res && (
          <>
            {/* UPDATE / SAVE BAR */}
            <div style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
              <div style={{ fontSize: 12, color: C.sub }}>
                {viewingSaved
                  ? <>📌 Saved read from <b>{new Date(viewingSaved).toLocaleString()}</b> — hit UPDATE for a fresh look at the same setup.</>
                  : <>Read from {new Date(res.asOf).toLocaleTimeString()}.</>}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => findTrade(res.symbol, res.mode)} disabled={busy}
                  style={{ padding: "8px 16px", borderRadius: 10, border: "none", cursor: busy ? "wait" : "pointer", background: C.blueDeep, color: "#fff", fontSize: 13, fontWeight: 800, letterSpacing: "0.04em" }}>
                  {busy ? "UPDATING…" : "⟳ UPDATE"}
                </button>
                <button onClick={saveRead} disabled={!res.analysisId || saveState !== "idle"}
                  style={{ padding: "8px 16px", borderRadius: 10, cursor: saveState === "idle" && res.analysisId ? "pointer" : "default", border: `1px solid ${C.blueDeep}`, background: saveState === "saved" ? C.iceDeep : C.card, color: C.blueDeep, fontSize: 13, fontWeight: 800 }}>
                  {saveState === "saved" ? "✓ SAVED" : saveState === "saving" ? "SAVING…" : "📌 SAVE THIS READ"}
                </button>
              </div>
            </div>

            {/* THE PICTURE — chart of what we're looking for */}
            <Chart d={res} />

            {/* MAIN MARKET DISPLAY */}
            <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 16, padding: 20, marginBottom: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
                <div>
                  <div style={{ fontSize: 12, letterSpacing: "0.14em", color: C.sub, fontWeight: 700 }}>MARKET</div>
                  <div style={{ fontSize: 22, fontWeight: 800 }}>{res.displayName}</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 12, letterSpacing: "0.14em", color: C.sub, fontWeight: 700 }}>LIVE</div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: C.blueDeep }}>{fmt(res.price)}</div>
                </div>
              </div>

              {/* Structure context strip */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginBottom: 12 }}>
                {st.map((t) => (
                  <div key={t.timeframe} style={{ background: C.ice, borderRadius: 10, padding: "10px 12px" }}>
                    <div style={{ fontSize: 11, color: C.sub, fontWeight: 700 }}>{t.timeframe === "D" ? "DAILY" : t.timeframe}</div>
                    <div style={{ fontSize: 13, fontWeight: 800, color: t.marketState === "UPTREND" ? C.green : t.marketState === "DOWNTREND" ? C.red : C.sub }}>
                      {pretty(t.marketState)}
                    </div>
                    <div style={{ fontSize: 11, color: C.sub }}>context · strength {t.trendStrength}</div>
                  </div>
                ))}
              </div>
              <div style={{ fontSize: 12, color: C.sub, marginBottom: 12 }}>
                <b style={{ color: C.ink }}>Structure:</b> {res.structureContext.detail} <b style={{ color: C.ink }}>Approach:</b> {res.approach.detail}
              </div>

              {/* ACTIVE NODE + scenarios */}
              {res.activeNode ? (
                <div style={{ background: res.activeNode.kind === "resistance" ? "#FBF1F1" : "#EFF8F3", borderRadius: 12, padding: "12px 14px", marginBottom: 12 }}>
                  <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: "0.1em", color: res.activeNode.kind === "resistance" ? C.red : C.green }}>
                    {res.activeNode.isComplex ? `${pretty(res.activeNode.kind).toUpperCase()} COMPLEX` : `${pretty(res.activeNode.kind).toUpperCase()} ZONE`} · {fmt(res.activeNode.low)}–{fmt(res.activeNode.high)} · RANK {res.activeNode.rank}
                  </div>
                  <div style={{ fontSize: 11, color: C.sub, marginTop: 2 }}>why it matters: {res.activeNode.sources.map(pretty).join(" + ")}</div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 10 }}>
                    {res.scenarios.map((sc, i) => (
                      <div key={i} style={{ background: C.card, borderRadius: 8, padding: "8px 10px", border: `1px solid ${C.line}` }}>
                        <div style={{ fontSize: 12, fontWeight: 800, color: sc.direction === "buy" ? C.green : C.red }}>{sc.label}</div>
                        <div style={{ fontSize: 11, color: C.sub }}>{sc.needs}</div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div style={{ background: C.ice, borderRadius: 12, padding: "12px 14px", marginBottom: 12, fontSize: 13, color: C.sub }}>
                  Between meaningful levels (range position {res.rangePosition}%). {res.monitoring.watching}
                </div>
              )}

              {/* REACTION */}
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                <div style={{ padding: "6px 12px", borderRadius: 999, background: C.blueDeep, color: "#fff", fontSize: 12, fontWeight: 800, letterSpacing: "0.08em" }}>
                  REACTION · {pretty(res.reaction.state)}
                </div>
                {res.liquidity.fakeoutProbability && (
                  <div style={{ padding: "6px 12px", borderRadius: 999, background: C.amber, color: "#fff", fontSize: 12, fontWeight: 800 }}>
                    {pretty(res.liquidity.fakeoutProbability)}
                  </div>
                )}
                {res.breakoutQuality && (
                  <div style={{ padding: "6px 12px", borderRadius: 999, background: C.blue, color: "#fff", fontSize: 12, fontWeight: 800 }}>
                    {pretty(res.breakoutQuality)}
                  </div>
                )}
              </div>
              <div style={{ fontSize: 13, color: C.ink, marginBottom: 10 }}>{res.reaction.detail}</div>
              <div style={{ fontSize: 12, color: C.sub }}>{res.liquidity.detail}</div>
              {res.news.screened && (
                <div style={{ fontSize: 12, color: res.news.action === "NORMAL_SETUP" ? C.sub : C.amber, marginTop: 8 }}>
                  <b>News:</b> {res.news.note}
                </div>
              )}
              {res.symbol === "XAUUSD" && (
                <div style={{ fontSize: 12, color: C.sub, marginTop: 4 }}><b>DXY:</b> {res.dxy.detail}</div>
              )}
            </div>

            {/* STATE MACHINE */}
            <div style={{ display: "flex", gap: 6, justifyContent: "center", marginBottom: 14 }}>
              {(["WAIT", "APPROACHING", "ARMED", "TAKE_NOW"] as const).map((s) => (
                <div key={s} style={{
                  padding: "6px 12px", borderRadius: 999, fontSize: 11, fontWeight: 800, letterSpacing: "0.08em",
                  background: res.status === s ? statusColor(s) : C.card,
                  color: res.status === s ? "#fff" : C.sub,
                  border: `1px solid ${res.status === s ? statusColor(s) : C.line}`,
                }}>{s.replace("_", " ")}</div>
              ))}
            </div>

            {/* TRADE / NO-TRADE */}
            {res.trade ? (
              <div style={{ background: C.card, border: `2px solid ${res.trade.direction === "buy" ? C.green : C.red}`, borderRadius: 16, padding: 20, marginBottom: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <div style={{ fontSize: 20, fontWeight: 800, color: res.trade.direction === "buy" ? C.green : C.red }}>
                    {res.trade.direction.toUpperCase()} · {pretty(res.trade.setupType)}
                  </div>
                  <div style={{ background: C.ice, borderRadius: 10, padding: "6px 12px", fontWeight: 800, color: C.blueDeep }}>SCORE {res.score.total}</div>
                </div>
                <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                  <span style={{ padding: "4px 10px", borderRadius: 999, background: qualityColor(res.tradeQuality), color: "#fff", fontSize: 11, fontWeight: 800 }}>
                    {res.tradeQuality === "A_PLUS" ? "A+ SETUP" : pretty(res.tradeQuality)}
                  </span>
                  {res.entryQuality && <span style={{ padding: "4px 10px", borderRadius: 999, background: C.iceDeep, color: C.blueDeep, fontSize: 11, fontWeight: 800 }}>ENTRY {res.entryQuality}</span>}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8, fontSize: 14 }}>
                  <Info label="ENTRY ZONE" value={`${fmt(res.trade.entryZone.low)}–${fmt(res.trade.entryZone.high)}`} />
                  <Info label="ENTRY (LIVE)" value={fmt(res.trade.entry)} />
                  <Info label="STOP (STRUCTURAL)" value={`${fmt(res.trade.stopLoss)} (${res.trade.stopPips}p)`} />
                  <Info label="R:R TO TP1" value={`${res.trade.riskReward}:1`} />
                  <Info label="TP1 (~1R)" value={`${fmt(res.trade.tp1)} (${res.trade.tp1Pips}p)`} />
                  <Info label="TP2 (~2R)" value={fmt(res.trade.tp2)} />
                  <Info label="RUNNER" value={fmt(res.trade.runnerTarget)} />
                  <Info label="MANAGE" value={`BE +${res.trade.management.breakevenAtPips}p → partial → lock +${res.trade.management.lockProfitPips}p`} />
                </div>
              </div>
            ) : (
              <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 16, padding: 20, marginBottom: 14, textAlign: "center" }}>
                <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: "0.06em", color: C.sub, marginBottom: 8 }}>
                  {res.badLocation ? "SETUP VALID · TRADE QUALITY POOR" : "NO TRADE RIGHT NOW"}
                </div>
                <div style={{ fontSize: 14, color: C.ink, marginBottom: 10 }}>{res.noTradeReason}</div>
                <div style={{ background: C.ice, borderRadius: 10, padding: "10px 14px", fontSize: 13, color: C.blueDeep, fontWeight: 600 }}>
                  {res.monitoring.watching}
                </div>
              </div>
            )}

            {/* WHY */}
            <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 16, padding: 20, marginBottom: 14 }}>
              <div style={{ fontSize: 12, letterSpacing: "0.14em", color: C.sub, fontWeight: 800, marginBottom: 10 }}>
                {res.trade ? "WHY THIS TRADE" : "WHY WE WAIT"}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {res.whyThisTrade.map((w, i) => (
                  <div key={i} style={{ display: "flex", gap: 10, fontSize: 14, lineHeight: 1.45 }}>
                    <span style={{ color: res.trade ? C.green : C.blue, fontWeight: 800 }}>{res.trade ? "✓" : "•"}</span>
                    <span>{w}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* COACH */}
            {res.coach.length > 0 && (
              <div style={{ background: "#FFFDF4", border: "1px solid #EFE2B8", borderRadius: 16, padding: 20, marginBottom: 14 }}>
                <div style={{ fontSize: 12, letterSpacing: "0.14em", color: C.amber, fontWeight: 800, marginBottom: 10 }}>MATTY PIPS COACH</div>
                {res.coach.map((c, i) => (
                  <div key={i} style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 6 }}>💡 {c}</div>
                ))}
              </div>
            )}

            {/* LEVEL MAP */}
            <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 16, padding: 20 }}>
              <div style={{ fontSize: 12, letterSpacing: "0.14em", color: C.sub, fontWeight: 800, marginBottom: 8 }}>LEVEL MAP (RANKED)</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {[...res.levels].reverse().map((z, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: z.kind === "resistance" ? "#FBF1F1" : "#EFF8F3", borderRadius: 8, padding: "7px 12px", fontSize: 13 }}>
                    <span style={{ fontWeight: 700, color: z.kind === "resistance" ? C.red : C.green }}>
                      {z.kind === "resistance" ? "RES" : "SUP"} {fmt(z.low)}–{fmt(z.high)}{z.complexId ? " ◈" : ""}
                    </span>
                    <span style={{ color: C.sub, fontSize: 11 }}>rank {z.rank} · {z.sources.map(pretty).join(", ")}</span>
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 12, fontSize: 11, color: C.sub }}>
                ◈ = part of a complex · Deterministic read {res.engineVersion} · {new Date(res.asOf).toLocaleTimeString()} · {res.mode} mode · Educational, not financial advice.
              </div>
            </div>
          </>
        )}

        {/* SAVED READS */}
        {savedItems.length > 0 && (
          <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 16, padding: 20, marginTop: 14 }}>
            <div style={{ fontSize: 12, letterSpacing: "0.14em", color: C.sub, fontWeight: 800, marginBottom: 10 }}>📌 SAVED READS</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {savedItems.map((it) => (
                <button key={it.id} onClick={() => openSaved(it.id)}
                  style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "#F6F9FC", border: `1px solid ${C.line}`, borderRadius: 10, padding: "10px 14px", cursor: "pointer", textAlign: "left" }}>
                  <span style={{ fontSize: 13, fontWeight: 800, color: it.verdict === "TRADE" ? C.green : C.ink }}>
                    {it.symbol} · {it.verdict === "TRADE" ? "TRADE" : "WATCHING"} · {pretty(it.status)}
                  </span>
                  <span style={{ fontSize: 11, color: C.sub }}>
                    score {it.score} · {it.mode} · {new Date(it.created_at).toLocaleString()}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {!res && !err && (
          <div style={{ textAlign: "center", color: C.sub, fontSize: 14, marginTop: 30, lineHeight: 1.6 }}>
            Pick a market and tap <b>FIND ME A TRADE</b>.<br />
            Matty Pips maps the levels that matter, watches how price arrives, reads the reaction on closed
            15-minute candles — rejection, sweep, break, retest — and only calls a trade when it&rsquo;s a
            GOOD trade, not just a possible one. &ldquo;No trade&rdquo; is a win too.
          </div>
        )}
      </div>
    </div>
  );
}

/** THE PICTURE — SVG chart: candles + level bands + trade lines + arrows for
 *  what price needs to do. Pure render of the DecisionObject (and its saved
 *  chart snapshot), so a saved read repaints exactly what was seen. */
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

  // Scenario arrows (dual — price picks the direction).
  const arrowLen = Math.min(56, plotH * 0.2);
  const scen = node && !d.trade ? {
    // rejection scenario: away from the level; break scenario: through it.
    rejFromY: y(resNode ? node.low : node.high),
    rejToY: y(resNode ? node.low : node.high) + (resNode ? arrowLen : -arrowLen),
    brkFromY: y(resNode ? node.high : node.low),
    brkToY: y(resNode ? node.high : node.low) + (resNode ? -arrowLen : arrowLen),
  } : null;

  const lines: { p: number; label: string; color: string; dash?: string }[] = [];
  if (d.trade) {
    lines.push({ p: d.trade.entry, label: `ENTRY ${fmtP(d.trade.entry)}`, color: C.blueDeep });
    lines.push({ p: d.trade.stopLoss, label: `STOP ${fmtP(d.trade.stopLoss)}`, color: C.red, dash: "6 4" });
    lines.push({ p: d.trade.tp1, label: `TP1 ${fmtP(d.trade.tp1)}`, color: C.green, dash: "6 4" });
    if (d.trade.tp2 != null && inY(d.trade.tp2)) lines.push({ p: d.trade.tp2, label: `TP2 ${fmtP(d.trade.tp2)}`, color: C.green, dash: "3 4" });
    if (d.trade.runnerTarget != null && inY(d.trade.runnerTarget)) lines.push({ p: d.trade.runnerTarget, label: `RUN ${fmtP(d.trade.runnerTarget)}`, color: "#1B8B8B", dash: "2 5" });
  }
  const offChart: string[] = [];
  if (d.trade?.tp2 != null && !inY(d.trade.tp2)) offChart.push(`TP2 ${fmtP(d.trade.tp2)} ${d.trade.tp2 > hi ? "↑" : "↓"}`);
  if (d.trade?.runnerTarget != null && !inY(d.trade.runnerTarget)) offChart.push(`Runner ${fmtP(d.trade.runnerTarget)} ${d.trade.runnerTarget > hi ? "↑" : "↓"}`);

  return (
    <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 16, padding: "16px 12px 10px", marginBottom: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0 8px", marginBottom: 8 }}>
        <div style={{ fontSize: 12, letterSpacing: "0.14em", color: C.sub, fontWeight: 800 }}>THE PICTURE — WHAT WE&rsquo;RE LOOKING FOR</div>
        <div style={{ display: "flex", gap: 6 }}>
          {(["m15", "h1"] as const).map((t) => (
            <button key={t} onClick={() => setTf(t)}
              style={{ padding: "4px 10px", borderRadius: 999, fontSize: 11, fontWeight: 800, cursor: "pointer", border: `1px solid ${tf === t ? C.blueDeep : C.line}`, background: tf === t ? C.iceDeep : C.card, color: tf === t ? C.blueDeep : C.sub }}>
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

        {/* Level bands */}
        {d.levels.filter((z) => z.high > lo && z.low < hi).map((z, i) => {
          const isNode = node && Math.abs(z.low - node.low) < 1e-9 && Math.abs(z.high - node.high) < 1e-9;
          const col = z.kind === "resistance" ? C.red : C.green;
          return (
            <g key={i}>
              <rect x={L} y={y(Math.min(z.high, hi))} width={plotW} height={Math.max(2, y(Math.max(z.low, lo)) - y(Math.min(z.high, hi)))}
                fill={col} opacity={isNode ? 0.20 : 0.08} />
              {isNode && <rect x={L} y={y(Math.min(z.high, hi))} width={plotW} height={Math.max(2, y(Math.max(z.low, lo)) - y(Math.min(z.high, hi)))} fill="none" stroke={col} strokeOpacity={0.5} strokeDasharray="4 3" />}
            </g>
          );
        })}

        {/* Node label */}
        {node && nodeMid != null && inY(nodeMid) && (
          <text x={L + 6} y={y(node.high) - 4} fontSize="11" fontWeight="800" fill={resNode ? C.red : C.green}>
            {(node.isComplex ? (resNode ? "RESISTANCE COMPLEX " : "SUPPORT COMPLEX ") : (resNode ? "RESISTANCE " : "SUPPORT ")) + fmtP(node.low) + "–" + fmtP(node.high)}
          </text>
        )}

        {/* Candles */}
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

        {/* Trade lines */}
        {lines.map((ln, i) => (
          <g key={i}>
            <line x1={L} x2={L + plotW} y1={y(ln.p)} y2={y(ln.p)} stroke={ln.color} strokeWidth={1.4} strokeDasharray={ln.dash} />
            <text x={L + plotW + 4} y={y(ln.p) + 4} fontSize="10.5" fontWeight="800" fill={ln.color}>{ln.label}</text>
          </g>
        ))}

        {/* Live price marker */}
        <circle cx={lastX} cy={y(last.c)} r={3.5} fill={C.blueDeep} stroke="#fff" strokeWidth={1.5} />
        {!d.trade && <text x={L + plotW + 4} y={y(last.c) + 4} fontSize="10.5" fontWeight="800" fill={C.blueDeep}>{fmtP(last.c)}</text>}

        {/* WHAT NEEDS TO HAPPEN */}
        {d.trade ? (
          <g>
            <line x1={Math.min(lastX + 16, L + plotW - 4)} x2={Math.min(lastX + 16, L + plotW - 4)} y1={y(d.trade.entry)} y2={y(d.trade.tp1) + (d.trade.direction === "buy" ? 8 : -8)}
              stroke={d.trade.direction === "buy" ? C.green : C.red} strokeWidth={2.5}
              markerEnd={d.trade.direction === "buy" ? "url(#mp-ar-green)" : "url(#mp-ar-red)"} />
          </g>
        ) : node && scen ? (
          <g>
            {!atNode && nodeMid != null && (
              <line x1={lastX - 2} y1={y(last.c)} x2={Math.min(lastX + 26, L + plotW - 4)} y2={y(Math.max(lo, Math.min(hi, nodeMid)))}
                stroke={C.sub} strokeWidth={1.6} strokeDasharray="4 4" markerEnd="url(#mp-ar-gray)" />
            )}
            {/* rejection scenario arrow */}
            <line x1={L + plotW * 0.90} x2={L + plotW * 0.90} y1={scen.rejFromY} y2={scen.rejToY}
              stroke={resNode ? C.red : C.green} strokeWidth={2.4} markerEnd={resNode ? "url(#mp-ar-red)" : "url(#mp-ar-green)"} />
            <text x={L + plotW * 0.90 - 4} y={scen.rejToY + (resNode ? 14 : -8)} fontSize="10.5" fontWeight="800" fill={resNode ? C.red : C.green} textAnchor="end">
              {resNode ? "SELL if it rejects" : "BUY if it rejects"}
            </text>
            {/* break scenario arrow */}
            <line x1={L + plotW * 0.97} x2={L + plotW * 0.97} y1={scen.brkFromY} y2={scen.brkToY}
              stroke={resNode ? C.blueDeep : C.red} strokeWidth={2.4} markerEnd={resNode ? "url(#mp-ar-blue)" : "url(#mp-ar-red)"} />
            <text x={L + plotW * 0.97 - 4} y={scen.brkToY + (resNode ? -8 : 14)} fontSize="10.5" fontWeight="800" fill={resNode ? C.blueDeep : C.red} textAnchor="end">
              {resNode ? "BUY if breaks + holds" : "SELL if breaks + holds"}
            </text>
          </g>
        ) : null}
      </svg>
      <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 8px 0", fontSize: 10.5, color: C.sub }}>
        <span>green bands = support · red = resistance · highlighted band = the level in play{d.trade ? " · dashed = stop/targets" : " · arrows = the two ways this can play"}</span>
        {offChart.length > 0 && <span>{offChart.join(" · ")} (off-chart)</span>}
      </div>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: "#F6F9FC", borderRadius: 10, padding: "8px 12px" }}>
      <div style={{ fontSize: 10, letterSpacing: "0.12em", color: "#5C7186", fontWeight: 800 }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 700, color: "#1C2B3A" }}>{value}</div>
    </div>
  );
}
