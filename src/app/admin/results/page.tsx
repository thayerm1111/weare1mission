"use client";

import { useCallback, useEffect, useState } from "react";

type Rec = { trades: number; wins: number; losses: number; scratches: number; winRate: number | null; netPips: number; netUsd: number; grossLostPips: number; grossLostUsd: number };
type Sym = { symbol: string; wins: number; losses: number; winRate: number | null; netPips: number; netUsd: number };
type Learn = { totalLosses: number; gaveBackAfterGreen: number; wrongFromStart: number; wideStop: number; bySide: { buy: number; sell: number }; worstSession: { session: string; count: number } | null; tweaks: string[] };
type Trade = { at: string; symbol: string; side: string; outcome: string; pips: number; usd: number; stopPips: number | null };
type Data = { ok: true; generatedAt: string; record: Rec; perSymbol: Sym[]; lossLearnings: Learn; recent: Trade[] };

const C = { bg: "#0B0F14", panel: "#111820", line: "rgba(255,255,255,0.08)", text: "#F1F5F9", mut: "rgba(241,245,249,0.55)", green: "#34D399", red: "#F87171", amber: "#FBBF24", cyan: "#22D3EE" };
const money = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString()}`;
const signed = (n: number) => `${n >= 0 ? "+" : ""}${n.toLocaleString()}`;

export default function AdminResultsPage() {
  const [d, setD] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/admin/my-results", { cache: "no-store" });
      if (r.status === 404 || r.status === 403 || r.status === 401) { setDenied(true); return; }
      const j = (await r.json()) as Data;
      if ((j as { ok?: boolean }).ok) setD(j);
    } catch { /* leave empty */ } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (denied) return <main style={{ padding: 40, fontFamily: "system-ui", background: C.bg, color: C.text, minHeight: "100vh" }}><p>Not found.</p></main>;

  const card: React.CSSProperties = { background: C.panel, border: `1px solid ${C.line}`, borderRadius: 14, padding: 16 };
  const rec = d?.record;

  return (
    <main style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: "system-ui, -apple-system, sans-serif", padding: "20px 16px 60px" }}>
      <div style={{ maxWidth: 860, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, marginBottom: 4 }}>
          <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0 }}>My Results <span style={{ color: C.mut, fontWeight: 600, fontSize: 13 }}>· private back-office</span></h1>
          <button onClick={() => void load()} style={{ background: "transparent", color: C.cyan, border: `1px solid ${C.line}`, borderRadius: 8, padding: "6px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Refresh</button>
        </div>
        <p style={{ color: C.mut, fontSize: 12.5, marginTop: 0, marginBottom: 18 }}>Your real live-account fills — every genuine stop is a loss here (no break-even display rule). The public board is unchanged. Read-only.</p>

        {loading && !d && <p style={{ color: C.mut }}>Loading…</p>}

        {rec && (
          <>
            {/* headline record */}
            <div style={{ ...card, marginBottom: 14 }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 14 }}>
                <Stat label="WIN RATE" value={rec.winRate == null ? "—" : `${rec.winRate}%`} sub={`${rec.wins}W / ${rec.losses}L`} color={C.text} />
                <Stat label="NET" value={`${signed(rec.netPips)}p`} sub={money(rec.netUsd) + " est"} color={rec.netPips >= 0 ? C.green : C.red} />
                <Stat label="LOSSES" value={String(rec.losses)} sub={`${signed(-rec.grossLostPips)}p · ${money(-rec.grossLostUsd)}`} color={C.red} />
                <Stat label="SCRATCHES" value={String(rec.scratches)} sub="break-even" color={C.mut} />
              </div>
            </div>

            {/* per symbol */}
            {d.perSymbol.length > 0 && (
              <div style={{ ...card, marginBottom: 14 }}>
                <H>By instrument</H>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead><tr style={{ color: C.mut, textAlign: "left", fontSize: 11 }}><th style={th}>PAIR</th><th style={th}>W/L</th><th style={th}>WIN%</th><th style={{ ...th, textAlign: "right" }}>NET PIPS</th><th style={{ ...th, textAlign: "right" }}>NET $</th></tr></thead>
                  <tbody>
                    {d.perSymbol.map((s) => (
                      <tr key={s.symbol} style={{ borderTop: `1px solid ${C.line}` }}>
                        <td style={{ ...td, fontWeight: 700 }}>{s.symbol}</td>
                        <td style={td}>{s.wins}/{s.losses}</td>
                        <td style={td}>{s.winRate == null ? "—" : `${s.winRate}%`}</td>
                        <td style={{ ...td, textAlign: "right", color: s.netPips >= 0 ? C.green : C.red }}>{signed(s.netPips)}</td>
                        <td style={{ ...td, textAlign: "right", color: s.netUsd >= 0 ? C.green : C.red }}>{money(s.netUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* loss learnings */}
            <div style={{ ...card, marginBottom: 14 }}>
              <H>What the losses are telling us</H>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
                <Chip label="gave back after +15p" v={d.lossLearnings.gaveBackAfterGreen} tone={C.amber} />
                <Chip label="wrong from start" v={d.lossLearnings.wrongFromStart} tone={C.red} />
                <Chip label="wide stop >150p" v={d.lossLearnings.wideStop} tone={C.amber} />
                <Chip label="sell losses" v={d.lossLearnings.bySide.sell} tone={C.mut} />
                <Chip label="buy losses" v={d.lossLearnings.bySide.buy} tone={C.mut} />
                {d.lossLearnings.worstSession && <Chip label={`${d.lossLearnings.worstSession.session} session`} v={d.lossLearnings.worstSession.count} tone={C.mut} />}
              </div>
              <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 8 }}>
                {d.lossLearnings.tweaks.map((t, i) => <li key={i} style={{ fontSize: 13, lineHeight: 1.5, color: C.text }}>{t}</li>)}
              </ul>
            </div>

            {/* recent real trades */}
            <div style={card}>
              <H>Recent real trades</H>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead><tr style={{ color: C.mut, textAlign: "left", fontSize: 11 }}><th style={th}>WHEN</th><th style={th}>PAIR</th><th style={th}>SIDE</th><th style={th}>OUTCOME</th><th style={{ ...th, textAlign: "right" }}>PIPS</th><th style={{ ...th, textAlign: "right" }}>$ EST</th></tr></thead>
                <tbody>
                  {d.recent.map((t, i) => {
                    const loss = t.outcome === "stop";
                    return (
                      <tr key={i} style={{ borderTop: `1px solid ${C.line}` }}>
                        <td style={{ ...td, color: C.mut, whiteSpace: "nowrap" }}>{new Date(t.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</td>
                        <td style={{ ...td, fontWeight: 700 }}>{t.symbol}</td>
                        <td style={{ ...td, textTransform: "uppercase", color: t.side === "sell" ? C.red : C.green }}>{t.side}</td>
                        <td style={{ ...td, color: loss ? C.red : t.outcome === "breakeven" ? C.mut : C.green }}>{t.outcome}</td>
                        <td style={{ ...td, textAlign: "right", color: t.pips >= 0 ? C.green : C.red }}>{signed(t.pips)}</td>
                        <td style={{ ...td, textAlign: "right", color: t.usd >= 0 ? C.green : C.red }}>{money(t.usd)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {d.recent.length === 0 && <p style={{ color: C.mut, fontSize: 13 }}>No closed trades yet on your accounts.</p>}
            </div>
          </>
        )}
      </div>
    </main>
  );
}

const th: React.CSSProperties = { padding: "6px 6px", fontWeight: 600 };
const td: React.CSSProperties = { padding: "8px 6px" };
function H({ children }: { children: React.ReactNode }) { return <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: 0.4, textTransform: "uppercase", color: "rgba(241,245,249,0.7)", marginBottom: 10 }}>{children}</div>; }
function Stat({ label, value, sub, color }: { label: string; value: string; sub: string; color: string }) {
  return (
    <div>
      <div style={{ fontSize: 10.5, letterSpacing: 0.5, color: "rgba(241,245,249,0.5)", fontWeight: 700 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 800, color, lineHeight: 1.1, marginTop: 2 }}>{value}</div>
      <div style={{ fontSize: 11.5, color: "rgba(241,245,249,0.5)", marginTop: 2 }}>{sub}</div>
    </div>
  );
}
function Chip({ label, v, tone }: { label: string; v: number; tone: string }) {
  return <span style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 999, padding: "4px 10px", fontSize: 12 }}><b style={{ color: tone }}>{v}</b><span style={{ color: "rgba(241,245,249,0.6)" }}>{label}</span></span>;
}
