"use client";

import { useCallback, useEffect, useState } from "react";

type Switches = { flow: boolean; genx: boolean };

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
    </main>
  );
}
