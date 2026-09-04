"use client";

import { useState } from "react";
import type { DecisionObject, EngineError, Mode } from "@/lib/matty-pips/types";

/**
 * MATTY PIPS — client UI. Premium-minimal, ice-blue on off-white.
 * Phase 1: FIND ME A TRADE only. AUTO TRADE ships in a later phase and is
 * shown as coming soon (it can never trade from this page).
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

function statusColor(s: string): string {
  if (s === "TAKE_NOW") return C.green;
  if (s === "ARMED") return C.amber;
  if (s === "APPROACHING") return C.blue;
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
  const [res, setRes] = useState<DecisionObject | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function findTrade() {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      const r = await fetch("/api/matty-pips/analyze", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ symbol, mode }),
      });
      const j = (await r.json()) as DecisionObject | EngineError;
      if (j.ok) setRes(j);
      else { setRes(null); setErr(j.detail || j.error || "Read failed — try again."); }
    } catch {
      setErr("Network hiccup — try again.");
    } finally {
      setBusy(false);
    }
  }

  const st = res?.structures ?? [];

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.ink, fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif", padding: "28px 16px 80px" }}>
      <div style={{ maxWidth: 760, margin: "0 auto" }}>

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
          <button onClick={findTrade} disabled={busy}
            style={{
              padding: "22px 10px", borderRadius: 16, border: "none", cursor: busy ? "wait" : "pointer",
              background: `linear-gradient(135deg, ${C.blueDeep}, ${C.blue})`, color: "#fff",
              fontSize: 17, fontWeight: 800, letterSpacing: "0.04em", boxShadow: "0 6px 20px rgba(47,111,168,0.25)",
              opacity: busy ? 0.75 : 1,
            }}>
            {busy ? "READING THE MARKET…" : "FIND ME A TRADE"}
          </button>
          <button disabled title="Ships in the next phase"
            style={{
              padding: "22px 10px", borderRadius: 16, border: `1px dashed ${C.iceDeep}`, cursor: "not-allowed",
              background: C.card, color: C.sub, fontSize: 17, fontWeight: 800, letterSpacing: "0.04em",
            }}>
            AUTO TRADE<div style={{ fontSize: 10, fontWeight: 600, marginTop: 4, letterSpacing: "0.12em" }}>COMING SOON</div>
          </button>
        </div>

        {err && (
          <div style={{ background: "#FDF2F2", border: `1px solid #F1CACA`, color: C.red, borderRadius: 12, padding: "12px 16px", fontSize: 14, marginBottom: 18 }}>
            {err}
          </div>
        )}

        {res && (
          <>
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

              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginBottom: 14 }}>
                {st.map((t) => (
                  <div key={t.timeframe} style={{ background: C.ice, borderRadius: 10, padding: "10px 12px" }}>
                    <div style={{ fontSize: 11, color: C.sub, fontWeight: 700 }}>{t.timeframe === "D" ? "DAILY" : t.timeframe}</div>
                    <div style={{ fontSize: 13, fontWeight: 800, color: t.marketState === "UPTREND" ? C.green : t.marketState === "DOWNTREND" ? C.red : C.sub }}>
                      {t.marketState.replace(/_/g, " ")}
                    </div>
                    <div style={{ fontSize: 11, color: C.sub }}>strength {t.trendStrength}</div>
                  </div>
                ))}
              </div>

              {/* Range position bar */}
              <div style={{ marginBottom: 6, fontSize: 11, color: C.sub, fontWeight: 700, letterSpacing: "0.1em" }}>
                LOCATION — {res.location.replace(/_/g, " ")} · RANGE {res.rangePosition}%
              </div>
              <div style={{ position: "relative", height: 8, background: C.ice, borderRadius: 999, marginBottom: 16 }}>
                <div style={{ position: "absolute", left: `calc(${res.rangePosition}% - 6px)`, top: -3, width: 14, height: 14, borderRadius: 999, background: C.blueDeep, border: "2px solid #fff", boxShadow: "0 1px 4px rgba(0,0,0,0.2)" }} />
              </div>

              {/* Zones */}
              <div style={{ fontSize: 11, color: C.sub, fontWeight: 700, letterSpacing: "0.1em", marginBottom: 6 }}>KEY ZONES</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {[...res.zones].reverse().map((z, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: z.zoneType === "resistance" ? "#FBF1F1" : "#EFF8F3", borderRadius: 8, padding: "7px 12px", fontSize: 13 }}>
                    <span style={{ fontWeight: 700, color: z.zoneType === "resistance" ? C.red : C.green }}>
                      {z.zoneType === "resistance" ? "RES" : "SUP"} {fmt(z.zoneLow)}–{fmt(z.zoneHigh)}
                    </span>
                    <span style={{ color: C.sub, fontSize: 11 }}>
                      {z.timeframes.join("+")} · {z.touchCount} touches · str {z.strengthScore}{z.brokeAndRetested ? " · flip" : ""}
                    </span>
                  </div>
                ))}
                {!res.zones.length && <div style={{ color: C.sub, fontSize: 13 }}>No strong zones in range.</div>}
              </div>
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

            {/* TRADE / NO-TRADE CARD */}
            {res.trade ? (
              <div style={{ background: C.card, border: `2px solid ${res.trade.direction === "buy" ? C.green : C.red}`, borderRadius: 16, padding: 20, marginBottom: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                  <div style={{ fontSize: 20, fontWeight: 800, color: res.trade.direction === "buy" ? C.green : C.red }}>
                    {res.trade.direction.toUpperCase()} · {res.trade.setupType.replace(/_/g, " ")}
                  </div>
                  <div style={{ background: C.ice, borderRadius: 10, padding: "6px 12px", fontWeight: 800, color: C.blueDeep }}>
                    SCORE {res.score.total}
                  </div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8, fontSize: 14 }}>
                  <Info label="ENTRY ZONE" value={`${fmt(res.trade.entryZone.low)}–${fmt(res.trade.entryZone.high)}`} />
                  <Info label="ENTRY (LIVE)" value={fmt(res.trade.entry)} />
                  <Info label="STOP" value={`${fmt(res.trade.stopLoss)} (${res.trade.stopPips}p)`} />
                  <Info label="R:R TO TP1" value={`${res.trade.riskReward}:1`} />
                  <Info label="TP1" value={`${fmt(res.trade.tp1)} (${res.trade.tp1Pips}p)`} />
                  <Info label="TP2" value={fmt(res.trade.tp2)} />
                  <Info label="RUNNER" value={fmt(res.trade.runnerTarget)} />
                  <Info label="DEAD ON CLOSE PAST" value={fmt(res.trade.invalidationLevel)} />
                </div>
              </div>
            ) : (
              <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 16, padding: 20, marginBottom: 14, textAlign: "center" }}>
                <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: "0.06em", color: C.sub, marginBottom: 8 }}>NO TRADE RIGHT NOW</div>
                <div style={{ fontSize: 14, color: C.ink, marginBottom: 10 }}>{res.noTradeReason}</div>
                <div style={{ background: C.ice, borderRadius: 10, padding: "10px 14px", fontSize: 13, color: C.blueDeep, fontWeight: 600 }}>
                  {res.monitoring.watching}
                </div>
              </div>
            )}

            {/* WHY THIS TRADE */}
            <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 16, padding: 20 }}>
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
              <div style={{ marginTop: 14, fontSize: 11, color: C.sub }}>
                Deterministic read {res.engineVersion} · {new Date(res.asOf).toLocaleTimeString()} · {res.mode} mode · Educational, not financial advice.
              </div>
            </div>
          </>
        )}

        {!res && !err && (
          <div style={{ textAlign: "center", color: C.sub, fontSize: 14, marginTop: 30, lineHeight: 1.6 }}>
            Pick a market and tap <b>FIND ME A TRADE</b>.<br />
            Matty Pips reads Daily → 4H → 1H structure, maps the real zones, and only calls a trade when
            price is at a level with 15-minute confirmation. &ldquo;No trade&rdquo; is a win too — it means don&rsquo;t donate.
          </div>
        )}
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
