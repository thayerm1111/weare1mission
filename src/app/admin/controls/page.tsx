"use client";

import { useCallback, useEffect, useState } from "react";

type Switches = { flow: boolean; genx: boolean };
type Level = { id: string; price: number; label: string | null; active: boolean; triggered_at: string | null; created_at: string };

export default function AdminControlsPage() {
  const [sw, setSw] = useState<Switches | null>(null);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/admin/switches", { cache: "no-store" });
      if (r.status === 404) { setDenied(true); return; }
      const d = (await r.json()) as { flow?: boolean; genx?: boolean };
      setSw({ flow: d.flow !== false, genx: d.genx !== false });
    } catch {
      setMsg("Couldn't load the switches — try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function toggle(which: "flow" | "genx", next: boolean) {
    if (busy) return;
    setBusy(which);
    setMsg("");
    try {
      const r = await fetch("/api/admin/switches", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [which]: next }),
      });
      const d = (await r.json()) as { ok?: boolean; flow?: boolean; genx?: boolean };
      if (d.ok) {
        setSw({ flow: d.flow !== false, genx: d.genx !== false });
        setMsg(`${which.toUpperCase()} is now ${next ? "ON" : "OFF"}${next ? "" : " — new trades paused for everyone."}`);
      } else {
        setMsg("Couldn't update — try again.");
      }
    } catch {
      setMsg("Couldn't update — try again.");
    } finally {
      setBusy(null);
    }
  }

  if (denied) {
    return <main style={{ padding: 40, fontFamily: "system-ui" }}><p>Not found.</p></main>;
  }

  const Row = ({ label, desc, on, which }: { label: string; desc: string; on: boolean; which: "flow" | "genx" }) => (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, padding: "20px 22px", border: "1px solid #e6ebf1", borderRadius: 16, background: "#fff" }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 800, fontSize: 16, display: "flex", alignItems: "center", gap: 8 }}>
          {label}
          <span style={{ fontSize: 12, fontWeight: 700, color: on ? "#059669" : "#dc2626", background: on ? "rgba(5,150,105,.10)" : "rgba(220,38,38,.10)", padding: "2px 8px", borderRadius: 999 }}>
            {on ? "ON" : "OFF — PAUSED"}
          </span>
        </div>
        <div style={{ marginTop: 4, fontSize: 13, color: "#64748b" }}>{desc}</div>
      </div>
      <button
        onClick={() => void toggle(which, !on)}
        disabled={busy === which}
        aria-pressed={on}
        style={{
          position: "relative", height: 34, width: 64, flexShrink: 0, borderRadius: 999, border: "none",
          cursor: busy === which ? "default" : "pointer", opacity: busy === which ? 0.6 : 1,
          background: on ? "#10b981" : "#cbd5e1", transition: "background .15s",
        }}
      >
        <span style={{ position: "absolute", top: 4, left: on ? 34 : 4, height: 26, width: 26, borderRadius: 999, background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,.2)", transition: "left .15s" }} />
      </button>
    </div>
  );

  return (
    <main style={{ maxWidth: 640, margin: "0 auto", padding: "40px 20px", fontFamily: "system-ui" }}>
      <h1 style={{ fontSize: 24, fontWeight: 800, margin: 0 }}>Trading controls</h1>
      <p style={{ color: "#64748b", fontSize: 14, marginTop: 6 }}>
        Global on/off for the automation. Turning an engine OFF pauses <b>new</b> trades for everyone — open
        trades keep being managed (break-even, partials, trailing). Use it while fixing things, then turn it back on.
      </p>

      {loading ? (
        <p style={{ marginTop: 24, color: "#64748b" }}>Loading…</p>
      ) : sw ? (
        <div style={{ display: "grid", gap: 12, marginTop: 24 }}>
          <Row which="flow" label="FLOW" on={sw.flow} desc="Auto-executes forex + index setups for every armed member." />
          <Row which="genx" label="GENX (gold)" on={sw.genx} desc="Places the GENX gold ENTER-NOW calls across members + follower accounts." />
          {msg && <p style={{ fontSize: 13, color: "#334155", marginTop: 4 }}>{msg}</p>}
        </div>
      ) : (
        <p style={{ marginTop: 24, color: "#dc2626" }}>{msg || "Couldn't load."}</p>
      )}

      {!denied && <MyLevels />}
    </main>
  );
}

/**
 * MY LEVELS — the owner's drawn support/resistance lines. GENX watches each active level:
 * price above it = support (bounce → BUY), below it = resistance (rejection → SELL). A play
 * only fires after a 5-minute candle CLOSES rejecting the level, with the stop beyond it and
 * the next level (or 1.6R) as target. Each level cools down 4h after firing.
 */
function MyLevels() {
  const [levels, setLevels] = useState<Level[] | null>(null);
  const [price, setPrice] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/genx/levels", { cache: "no-store" });
      const d = (await r.json()) as { ok?: boolean; levels?: Level[] };
      if (d.ok) setLevels(d.levels ?? []);
    } catch { /* leave as-is */ }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function add() {
    const p = Number(price);
    if (!Number.isFinite(p) || p <= 0) { setNote("Enter the level's price first."); return; }
    setBusy("add"); setNote("");
    try {
      const r = await fetch("/api/genx/levels", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ price: p, label }) });
      const d = (await r.json()) as { ok?: boolean; error?: string };
      if (d.ok) { setPrice(""); setLabel(""); setNote(`Level ${p} is live — GENX is watching it.`); await load(); }
      else setNote(d.error || "Couldn't add the level.");
    } finally { setBusy(null); }
  }
  async function toggle(l: Level) {
    setBusy(l.id);
    try { await fetch("/api/genx/levels", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: l.id, active: !l.active }) }); await load(); }
    finally { setBusy(null); }
  }
  async function remove(l: Level) {
    if (!window.confirm(`Remove the ${l.price} level?`)) return;
    setBusy(l.id);
    try { await fetch("/api/genx/levels", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: l.id }) }); await load(); }
    finally { setBusy(null); }
  }
  const cooling = (l: Level) => l.triggered_at && Date.now() - Date.parse(l.triggered_at) < 4 * 3600_000;

  return (
    <section style={{ marginTop: 40 }}>
      <h2 style={{ fontSize: 19, fontWeight: 800, margin: 0 }}>My Levels (gold)</h2>
      <p style={{ color: "#64748b", fontSize: 13, marginTop: 6, lineHeight: 1.5 }}>
        Your support/resistance lines, traded your way: when price reaches a level and a <b>5-minute candle closes
        rejecting it</b>, GENX takes the bounce — stop beyond the level, target at your next level (or 1.6R).
        A level above price acts as resistance (sells), below price as support (buys) — it flips automatically if it breaks.
        Each level rests 4 hours after firing.
      </p>

      <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
        <input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" placeholder="Price — e.g. 4382.5"
          style={{ flex: "1 1 140px", padding: "10px 12px", border: "1px solid #e6ebf1", borderRadius: 12, fontSize: 14 }} />
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (optional) — e.g. daily support"
          style={{ flex: "2 1 200px", padding: "10px 12px", border: "1px solid #e6ebf1", borderRadius: 12, fontSize: 14 }} />
        <button onClick={() => void add()} disabled={busy === "add"}
          style={{ padding: "10px 18px", borderRadius: 12, border: "none", background: "#0f172a", color: "#fff", fontWeight: 700, fontSize: 14, cursor: "pointer", opacity: busy === "add" ? 0.6 : 1 }}>
          Add level
        </button>
      </div>
      {note && <p style={{ fontSize: 13, color: "#334155", marginTop: 8 }}>{note}</p>}

      <div style={{ display: "grid", gap: 8, marginTop: 14 }}>
        {levels == null ? (
          <p style={{ color: "#64748b", fontSize: 13 }}>Loading levels…</p>
        ) : levels.length === 0 ? (
          <p style={{ color: "#64748b", fontSize: 13 }}>No levels yet — add the lines from your chart and GENX will trade them.</p>
        ) : levels.map((l) => (
          <div key={l.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "12px 16px", border: "1px solid #e6ebf1", borderRadius: 14, background: "#fff", opacity: l.active ? 1 : 0.55 }}>
            <div style={{ minWidth: 0 }}>
              <span style={{ fontWeight: 800, fontSize: 15 }}>{l.price}</span>
              {l.label && <span style={{ marginLeft: 8, fontSize: 13, color: "#64748b" }}>{l.label}</span>}
              {cooling(l) && <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 700, color: "#b45309", background: "rgba(180,83,9,.10)", padding: "2px 8px", borderRadius: 999 }}>fired — cooling down</span>}
              {!l.active && <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 700, color: "#64748b" }}>paused</span>}
            </div>
            <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
              <button onClick={() => void toggle(l)} disabled={busy === l.id}
                style={{ padding: "6px 12px", borderRadius: 999, border: "1px solid #e6ebf1", background: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
                {l.active ? "Pause" : "Resume"}
              </button>
              <button onClick={() => void remove(l)} disabled={busy === l.id}
                style={{ padding: "6px 12px", borderRadius: 999, border: "1px solid #fecaca", background: "#fff", color: "#dc2626", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
                Remove
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
