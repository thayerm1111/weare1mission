"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { C, ago, post, type StatusPayload } from "./theme";
import { AccountPanel, HealthPanel, JournalPanel, PairsPanel, PositionsPanel, RecentTradesPanel, ResultsPanel } from "./Panels";
import { SettingsPanel, StartReview } from "./SettingsPanel";
import { Btn } from "./ui";
import { ConnectPanel } from "./ConnectPanel";
import { CompensationPanel } from "./CompensationPanel";

/**
 * ONE MISSION FX SCALPER — the owner's dashboard. Reads the database every two seconds (the worker is
 * the only thing that talks to the broker) and sends the owner's controls. Owner only (the API checks).
 */

const STATUS: Record<string, { label: string; fg: string; bg: string }> = {
  not_connected: { label: "NOT CONNECTED", fg: C.muted, bg: "#F1F4F9" },
  connecting: { label: "CONNECTING", fg: C.blue, bg: C.blueSoft },
  stopped: { label: "STOPPED", fg: C.muted, bg: "#F1F4F9" },
  scanning: { label: "SCANNING", fg: C.blue, bg: C.blueSoft },
  active: { label: "ACTIVE", fg: C.green, bg: C.greenSoft },
  paused: { label: "PAUSED", fg: C.amber, bg: C.amberSoft },
  error: { label: "ERROR", fg: C.red, bg: C.redSoft },
  offline: { label: "WORKER OFFLINE", fg: C.red, bg: C.redSoft },
};

export default function FxScalperDashboard() {
  const [data, setData] = useState<StatusPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [review, setReview] = useState(false);
  const [confirm, setConfirm] = useState<null | "close_bot" | "emergency" | "close_account_all" | "stop">(null);
  const [typed, setTyped] = useState("");
  const [tab, setTab] = useState<"live" | "settings" | "account" | "payouts" | "journal">("live");
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/fx-scalper/status", { cache: "no-store" });
      const j = await r.json();
      if (!alive.current) return;
      if (!r.ok) { setError(String(j.error ?? r.status)); return; }
      setData(j as StatusPayload);
      setError(null);
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void load();
    const iv = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 2000);
    return () => { alive.current = false; clearInterval(iv); };
  }, [load]);

  const act = async (action: string, extra: Record<string, unknown> = {}) => {
    if (!data) return;
    setBusy(action);
    const r = await post("/api/fx-scalper/control", { action, expectVersion: ["close_bot", "emergency", "close_account_all"].includes(action) ? undefined : data.control.version, ...extra });
    setBusy(null);
    setNotice({ ok: r.ok, text: r.ok ? "Done." : String(r.data.error ?? "Refused") });
    await load();
    return r.ok;
  };

  if (error && !data) return <Shell><p className="text-sm" style={{ color: C.red }}>{error === "forbidden" ? "The FX Scalper is for the account owner only." : `Could not load: ${error}`}</p></Shell>;
  if (!data) return <Shell><p className="text-sm" style={{ color: C.muted }}>Loading…</p></Shell>;

  const snap = data.worker?.snapshot ?? {};
  const workerAge = data.worker?.ageMs ?? null;
  const offline = workerAge == null || workerAge > 15_000;
  const st = offline ? STATUS.offline : STATUS[snap.bot?.status ?? "not_connected"] ?? STATUS.not_connected;
  const c = data.control;
  const live = c.mode === "live";
  const connected = Boolean(c.connection_id && c.account_id);
  const ccy = snap.account?.currency ?? c.account_currency ?? "";
  // While every bot position is being closed, START and Resume wait (the server refuses them too).
  const closingAll = c.close_all_reason ? String(c.close_all_reason).replace(/_/g, " ") : null;

  return (
    <Shell>
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight" style={{ color: C.ink }}>One Mission FX Scalper</h1>
            <span className="rounded-md px-2 py-0.5 text-[11px] font-bold tracking-wider" style={{ color: "#fff", background: C.blueDeep }}>LIVE ENVIRONMENT</span>
            <span className="rounded-md px-2 py-0.5 text-[11px] font-bold tracking-wider" style={{ color: st.fg, background: st.bg }}>{st.label}</span>
          </div>
          <p className="mt-1 text-sm" style={{ color: C.muted }}>
            {connected ? <>Account <b style={{ color: C.ink }}>{c.account_label}</b> · accNum {c.acc_num}{ccy ? ` · ${ccy}` : ""}</> : "No account connected."}
            {" · "}worker {offline ? <b style={{ color: C.red }}>offline ({ago(workerAge)})</b> : `heartbeat ${ago(workerAge)}`}
          </p>
          <p className="mt-1 text-sm" style={{ color: offline ? C.red : C.ink }}>
            {offline ? "The worker service is not running: no signals are read and no orders can be sent. Open positions keep their broker-side stop and target." : snap.bot?.headline}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {!live && <Btn kind="primary" disabled={!connected || !!busy || !!closingAll} onClick={() => setReview(true)}>START LIVE</Btn>}
          {live && !c.entries_paused && <Btn disabled={!!busy} onClick={() => void act("pause")}>Pause new entries</Btn>}
          {live && c.entries_paused && <Btn kind="primary" disabled={!!busy || !!closingAll} onClick={() => void act("resume")}>Resume</Btn>}
          {live && <Btn disabled={!!busy} onClick={() => setConfirm("stop")}>Stop</Btn>}
          <Btn disabled={!!busy || !connected} onClick={() => setConfirm("close_bot")}>Close all bot positions</Btn>
          <Btn kind="danger" disabled={!!busy || !connected} onClick={() => setConfirm("emergency")}>Emergency stop</Btn>
        </div>
      </div>

      {closingAll && (
        <div className="mt-3 rounded-lg border px-3 py-2 text-sm" style={{ borderColor: "#F4C7C3", background: C.redSoft, color: C.red }}>
          Closing every bot position ({closingAll}). New entries, START and Resume wait until none is left.
        </div>
      )}

      {notice && (
        <div className="mt-3 flex items-start justify-between rounded-lg border px-3 py-2 text-sm" style={{ borderColor: notice.ok ? C.blueLine : "#F4C7C3", background: notice.ok ? C.blueSoft : C.redSoft, color: notice.ok ? C.ink : C.red }}>
          <span>{notice.text}</span>
          <button className="ml-3 text-xs underline" onClick={() => setNotice(null)}>dismiss</button>
        </div>
      )}

      {(snap.bot?.blockers?.length ?? 0) > 0 && !offline && (
        <div className="mt-4 rounded-xl border px-4 py-3" style={{ borderColor: live ? "#F1D9A6" : C.line, background: live ? C.amberSoft : "#FAFBFD" }}>
          <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: live ? C.amber : C.muted }}>{live ? "Why no new entries right now" : "Before entries can happen"}</p>
          <ul className="mt-1 list-disc pl-5 text-sm" style={{ color: C.ink }}>
            {snap.bot!.blockers.slice(0, 8).map((b, i) => <li key={i}>{b}</li>)}
          </ul>
        </div>
      )}

      {/* Tabs */}
      <div className="mt-5 flex flex-wrap gap-1 border-b" style={{ borderColor: C.line }}>
        {([["live", "Live"], ["settings", "Settings & limits"], ["account", "Account"], ["payouts", "Results & payouts"], ["journal", "Journal & health"]] as const).map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} className="-mb-px border-b-2 px-3 py-2 text-sm font-medium"
            style={{ borderColor: tab === k ? C.blue : "transparent", color: tab === k ? C.blue : C.muted }}>{label}</button>
        ))}
      </div>

      <div className="mt-4 space-y-4">
        {tab === "live" && (
          <>
            <AccountPanel data={data} />
            <PositionsPanel data={data} />
            <PairsPanel data={data} />
          </>
        )}
        {tab === "settings" && <SettingsPanel data={data} reload={load} />}
        {tab === "account" && (
          <>
            <ConnectPanel data={data} reload={load} />
            <DangerZone disabled={!connected || !!busy} onClick={() => { setTyped(""); setConfirm("close_account_all"); }} />
          </>
        )}
        {tab === "payouts" && (
          <>
            <ResultsPanel data={data} />
            <CompensationPanel data={data} reload={load} />
            <RecentTradesPanel data={data} />
          </>
        )}
        {tab === "journal" && (
          <>
            <HealthPanel data={data} />
            <JournalPanel data={data} />
          </>
        )}
      </div>

      {review && (
        <Modal onClose={() => setReview(false)}>
          <StartReview data={data} busy={busy === "start"} onCancel={() => setReview(false)} onStart={async () => {
            const ok = await act("start", { settingsVersion: data.settings.version });
            if (ok) setReview(false);
          }} />
        </Modal>
      )}

      {confirm && (
        <Modal onClose={() => setConfirm(null)}>
          <h2 className="text-lg font-semibold" style={{ color: C.ink }}>
            {confirm === "close_bot" ? "Close all bot positions?" : confirm === "emergency" ? "Emergency stop?" : confirm === "stop" ? "Stop the bot?" : "Close EVERY position on this account?"}
          </h2>
          <p className="mt-2 text-sm" style={{ color: C.muted }}>
            {confirm === "close_bot" && "Every position the bot opened is closed at market and new entries are paused. Positions you or other tools opened are not touched."}
            {confirm === "emergency" && "The bot stops, every bot position is closed at market and the bot's working orders are cancelled. It stays stopped until you press START LIVE again."}
            {confirm === "stop" && "No new entries. Open bot positions are still managed — their stop, target and 120-second exit — until they close."}
            {confirm === "close_account_all" && "This closes ALL positions on the account at market — including ones you opened yourself and ones from FLOW, GEN FX, Rapid or any other tool. Type CLOSE ALL to confirm."}
          </p>
          {confirm === "close_account_all" && (
            <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="CLOSE ALL" className="mt-3 w-full rounded-lg border px-3 py-2 text-sm" style={{ borderColor: C.line }} />
          )}
          <div className="mt-4 flex justify-end gap-2">
            <Btn onClick={() => setConfirm(null)}>Cancel</Btn>
            <Btn kind="danger" disabled={!!busy || (confirm === "close_account_all" && typed !== "CLOSE ALL")} onClick={async () => {
              const ok = await act(confirm, confirm === "close_account_all" ? { confirm: typed } : {});
              if (ok) setConfirm(null);
            }}>{confirm === "stop" ? "Stop" : confirm === "close_bot" ? "Close bot positions" : confirm === "emergency" ? "Emergency stop" : "Close everything"}</Btn>
          </div>
        </Modal>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="rounded-2xl border px-4 py-5 sm:px-6" style={{ background: C.card, borderColor: C.line }}>{children}</div>;
}


function Modal({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/30 px-3 py-10" onClick={onClose}>
      <div className="w-full max-w-2xl rounded-2xl border bg-white p-5 shadow-xl" style={{ borderColor: C.line }} onClick={(e) => e.stopPropagation()}>{children}</div>
    </div>
  );
}

function DangerZone({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  return (
    <section className="rounded-xl border px-4 py-4" style={{ borderColor: "#F4C7C3", background: "#FFFBFA" }}>
      <h3 className="text-sm font-semibold" style={{ color: C.red }}>Account-wide close (not just the bot)</h3>
      <p className="mt-1 text-sm" style={{ color: C.muted }}>Closes every position on this broker account, including yours and other tools&apos;. Separate from the bot&apos;s own close.</p>
      <div className="mt-3"><Btn kind="danger" disabled={disabled} onClick={onClick}>Close EVERY position on the account…</Btn></div>
    </section>
  );
}
