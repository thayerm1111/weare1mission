"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, Check, ChevronDown, Droplets, Link2, Loader2, Pause, Play, RefreshCw, ShieldCheck, X, Zap } from "lucide-react";
import { ProductIcon } from "../ProductIcon";
import { useExperienceMode } from "../experience";
import { NitrousMarketDesk, NitrousLiveTrades } from "./NitrousMarketDesk";
import type { NitrousAccount, NitrousAnalyze, NitrousMode, NitrousPosition } from "@/lib/nitrous/types";
import { NITROUS_CONSENT_VERSION, NITROUS_FAST_CONSENT_VERSION, NITROUS_PROFILES, NITROUS_SWEEP_CONSENT_VERSION } from "@/lib/nitrous/policy";
import { useNitrousStatus } from "./useNitrousStatus";
import { accountIsActive, elapsed, modeName, money, price, shownPnl, shownPnlLabel, validAnalyze } from "./presentation";
import { NitrousConnect } from "./NitrousConnect";
import { NitrousAddonPanel } from "./NitrousAddonPanel";
import { NitrousTelegramPanel } from "./NitrousTelegramPanel";
import { accountStrategyConsent, accountStrategyName, NitrousStrategyOptions } from "./NitrousStrategyOptions";
import "./nitrous.css";

function ArmDialog({ account, mode, riskPct, consentVersion, busy, error, onCancel, onConfirm }: {
  account: NitrousAccount; mode: NitrousMode; riskPct: number; consentVersion: string; busy: boolean; error: string;
  onCancel: () => void; onConfirm: (version: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null); const [accepted, setAccepted] = useState(false);
  const [selectedConsent, setSelectedConsent] = useState(consentVersion);
  useEffect(() => { dialog.current?.showModal(); }, []);
  const risk = account.equity == null ? null : account.equity * riskPct / 100;
  return <dialog ref={dialog} className="nitrous-dialog" aria-labelledby="nitrous-arm-title" onCancel={e => { e.preventDefault(); if (!busy) onCancel(); }}>
    <div className="nitrous-dialog-head"><span className="nitrous-icon-disc"><Zap size={21} /></span><button type="button" className="nitrous-icon-button" onClick={onCancel} disabled={busy} aria-label="Cancel auto trading"><X size={20} /></button></div>
    <h2 id="nitrous-arm-title">{account.automationEnabled ? "Review entry strategies" : `Turn on ${modeName(mode)}?`}</h2>
    <p className="nitrous-muted">Qualifying gold setups will be submitted automatically to this {account.environment === "live" ? "real" : "demo"} TradeLocker account.</p>
    <dl className="nitrous-confirm-facts"><div><dt>Account</dt><dd>{account.name || "TradeLocker"} {account.masked}</dd></div><div><dt>Risk per trade</dt><dd>{riskPct}% · approximately {money(risk, account.currency ?? "USD")}</dd></div><div><dt>Daily loss allowance</dt><dd>{NITROUS_PROFILES.find(p => p.mode === mode)?.dailyLossPct}% of starting-day equity</dd></div></dl>
    {mode === "nitrous" && <NitrousStrategyOptions value={selectedConsent} disabled={busy} onChange={version => { setSelectedConsent(version); setAccepted(false); }} />}
    <p className="nitrous-risk-note">{mode === "nitrous" ? "Nitrous uses high risk and can lose the full trading allocation. " : "Trading can lose money. "}Stops can fill beyond the intended price. Daily limits pause new entries; they do not guarantee a maximum loss.</p>
    <label className="nitrous-check"><input type="checkbox" checked={accepted} onChange={e => setAccepted(e.target.checked)} disabled={busy} /><span>I authorize automatic trades on this account using the selected entry strategies and risk.</span></label>
    {error && <p role="alert" className="nitrous-error">{error}</p>}
    <button type="button" className="nitrous-button nitrous-button-primary" disabled={!accepted || busy} onClick={() => onConfirm(selectedConsent)}>{busy ? <Loader2 className="nitrous-spin" size={17} /> : <Play size={17} />}{busy ? "Checking readiness…" : account.automationEnabled ? "Authorize selected strategies" : `Turn on ${modeName(mode)}`}</button>
  </dialog>;
}

function CloseDialog({ position, account, busy, error, onCancel, onConfirm }: {
  position: NitrousPosition; account: NitrousAccount; busy: boolean; error: string; onCancel: () => void; onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="nitrous-dialog" aria-labelledby="nitrous-close-title" onCancel={e => { e.preventDefault(); if (!busy) onCancel(); }}>
    <div className="nitrous-dialog-head"><span className="nitrous-icon-disc"><Pause size={21} /></span><button type="button" className="nitrous-icon-button" onClick={onCancel} disabled={busy} aria-label="Cancel position close"><X size={20} /></button></div>
    <h2 id="nitrous-close-title">Close this gold position?</h2>
    <p className="nitrous-muted">Request a market close for the {position.side} position of {position.quantity} lots on {account.name || "TradeLocker"} {account.masked} ({account.environment}). The fill price may differ from the displayed quote.</p>
    <p className="nitrous-risk-note" style={{ margin: "17px 0" }}>The position remains open until TradeLocker confirms the close. This does not pause future auto entries.</p>
    {error && <p className="nitrous-error" role="alert">{error}</p>}
    <button type="button" className="nitrous-button nitrous-button-primary" disabled={busy} onClick={onConfirm}>{busy ? <Loader2 className="nitrous-spin" size={17} /> : <X size={17} />}{busy ? "Requesting close…" : "Request market close"}</button>
  </dialog>;
}

export function NitrousWorkspace({ isAdmin = false }: { isAdmin?: boolean }) {
  const { isSimple } = useExperienceMode();
  const [accountId, setAccountId] = useState("");
  const status = useNitrousStatus(10_000, accountId);
  const [analysis, setAnalysis] = useState<NitrousAnalyze | null>(null);
  const [analysisError, setAnalysisError] = useState(""); const [analysisLoading, setAnalysisLoading] = useState(true);
  const [analysisReceivedAt, setAnalysisReceivedAt] = useState(0);
  const pendingAnalysis = useRef<AbortController | null>(null);
  const [mode, setMode] = useState<NitrousMode>("slow_drip");
  const [riskPct, setRiskPct] = useState(0.5); const [busy, setBusy] = useState(""); const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState(""); const [connecting, setConnecting] = useState(false); const [arming, setArming] = useState(false);
  const [armConsent, setArmConsent] = useState(NITROUS_CONSENT_VERSION);
  const [closing, setClosing] = useState<NitrousPosition | null>(null);
  const entitled = status.data?.addon?.entitled === true && !status.error;
  const accounts = status.data?.accounts ?? [];
  const account = accounts.find(a => a.accountId === accountId) ?? accounts[0] ?? null;
  const profiles = status.data?.profiles.length ? status.data.profiles : NITROUS_PROFILES;
  const profile = profiles.find(p => p.mode === mode) ?? NITROUS_PROFILES[0];
  const lastAccount = useRef("");
  useEffect(() => {
    if (account && (lastAccount.current !== account.accountId || account.automationEnabled)) {
      if (lastAccount.current !== account.accountId) setActionError("");
      lastAccount.current = account.accountId; setMode(account.mode); setRiskPct(account.riskPct);
    }
  }, [account]);
  const chooseMode = (next: NitrousMode) => { if (!entitled || account?.automationEnabled || busy) return; setMode(next); setRiskPct(profiles.find(p => p.mode === next)?.defaultRisk ?? (next === "slow_drip" ? 0.5 : 3)); setNotice(""); };
  const active = accountIsActive(status.data, account, status.receivedAt, status.now, status.error);
  const changed = !!account && (account.mode !== mode || account.riskPct !== riskPct);
  const currency = account?.currency ?? "USD";
  const plannedRisk = account?.equity == null ? null : account.equity * riskPct / 100;
  const readFresh = !analysisError && analysis?.available === true && !analysis.stale && analysis.health.state === "ok"
    && status.now > 0 && analysisReceivedAt > 0 && typeof analysis.ageMs === "number"
    && analysis.ageMs + Math.max(0,status.now-analysisReceivedAt) <= 45_000
    && Date.parse(analysis.generatedAt ?? "")-Date.parse(analysis.asOf ?? "")+analysis.ageMs+Math.max(0,status.now-analysisReceivedAt) <= 120_000;
  const marketClock = analysis?.generatedAt && typeof analysis.ageMs === "number" && analysisReceivedAt > 0
    ? Date.parse(analysis.generatedAt) + analysis.ageMs + Math.max(0, status.now - analysisReceivedAt) : status.now;
  const accountClock = !status.error && status.data && status.receivedAt && status.now >= status.receivedAt && status.now-status.receivedAt<=45_000
    ? Date.parse(status.data.serverTime) + status.now-status.receivedAt : 0;

  const refreshAnalysis = useCallback(async () => {
    if (!entitled) return;
    pendingAnalysis.current?.abort(); const controller = new AbortController(); pendingAnalysis.current = controller;
    setAnalysisLoading(true);
    try {
      const res = await fetch("/api/nitrous/analyze", { cache: "no-store", signal: controller.signal });
      const body = await res.json().catch(() => null);
      if (!res.ok || !validAnalyze(body)) throw new Error(body?.detail ?? body?.reason ?? "Gold setups are temporarily unavailable.");
      if (!controller.signal.aborted) { setAnalysis(body); setAnalysisError(""); setAnalysisReceivedAt(Date.now()); }
    } catch (e) { if (!controller.signal.aborted) setAnalysisError(e instanceof Error ? e.message : "Unable to refresh gold setups."); }
    finally { if (!controller.signal.aborted) setAnalysisLoading(false); }
  }, [entitled]);
  useEffect(() => {
    if (!entitled) { pendingAnalysis.current?.abort(); setAnalysis(null); setAnalysisError(""); setAnalysisLoading(false); setArming(false); setConnecting(false); return; }
    void refreshAnalysis();
    const poll = setInterval(() => { if (document.visibilityState === "visible") void refreshAnalysis(); }, 15_000);
    const visible = () => { if (document.visibilityState === "visible") void refreshAnalysis(); };
    document.addEventListener("visibilitychange", visible);
    return () => { clearInterval(poll); pendingAnalysis.current?.abort(); document.removeEventListener("visibilitychange", visible); };
  }, [entitled, refreshAnalysis]);

  async function settings(body: Record<string, unknown>, action: string) {
    if (!account || busy) return;
    setBusy(action); setActionError(""); setNotice("");
    try {
      const res = await fetch("/api/nitrous/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accountId: account.accountId, ...body }) });
      const out = await res.json().catch(() => null);
      if (!res.ok || !out?.ok) throw new Error(out?.blockers?.join(" ") || out?.detail || out?.error || "Unable to update this account.");
      setArming(false);
      setNotice(action === "pause" ? "New entries are paused. Existing position protection remains in place." : action === "arm" ? "Auto trading authorized. Checking the execution service…" : "Account settings saved.");
      await status.refresh();
    } catch (e) { setActionError(e instanceof Error ? e.message : "Unable to update this account."); }
    finally { setBusy(""); }
  }

  async function refreshAccount() {
    if (!account || busy) return;
    setBusy("refresh"); setActionError("");
    try {
      const res = await fetch("/api/nitrous/connect", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "refresh", accountId: account.accountId }) });
      const out = await res.json().catch(() => null);
      if (!res.ok || !out?.ok) throw new Error(out?.detail ?? out?.error ?? "Unable to refresh TradeLocker.");
      await status.refresh();
    } catch (e) { setActionError(e instanceof Error ? e.message : "Unable to refresh TradeLocker."); }
    finally { setBusy(""); }
  }

  async function closePosition() {
    if (!account || !closing || busy) return;
    setBusy("close"); setActionError("");
    try {
      const res = await fetch("/api/nitrous/position", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accountId: account.accountId, positionId: closing.id, action: "close", confirmed: true }) });
      const out = await res.json().catch(() => null);
      if (!res.ok || !out?.ok) throw new Error(out?.detail ?? out?.error ?? "Unable to request a position close.");
      setClosing(null); setNotice("Close requested. Waiting for TradeLocker confirmation."); await status.refresh();
    } catch (e) { setActionError(e instanceof Error ? e.message : "Unable to request a position close."); }
    finally { setBusy(""); }
  }

  const canArm = entitled && !!account && !status.error && !!status.data?.available && status.data.worker.healthy
    && status.data.control.mode === "live" && !status.data.control.entriesPaused && account.blockers.length === 0
    && status.now > 0 && status.now - status.receivedAt <= 45_000;
  const reviewStrategies = (version?: string) => {
    if (!account || !canArm || busy) return;
    setArmConsent(version ?? accountStrategyConsent(account, mode)); setActionError(""); setArming(true);
  };
  return <div className="nitrous" data-mode={mode}>
    <header className="nitrous-header"><div className="nitrous-brand"><ProductIcon kind="nitrous" size="lg" /><div><p className="nitrous-eyebrow">ONE MISSION · GOLD AUTOMATION</p><h1>Nitrous</h1><p>Read the setup. Choose your pace.</p></div></div>
      <span className="nitrous-powered"><span />Powered by TradeLocker</span></header>
    {(entitled || account) && <div className="nitrous-mode-switch" role="group" aria-label="Trading mode">
      <button type="button" aria-pressed={mode === "slow_drip"} onClick={() => chooseMode("slow_drip")} disabled={!entitled || !!account?.automationEnabled || !!busy}><span className="nitrous-mode-icon"><Droplets size={23} /></span><span><strong>Slow Drip</strong><small>Measured risk. Selective entries.</small></span><span className="nitrous-mode-risk">0.5–1%<small>per trade</small></span></button>
      <button type="button" aria-pressed={mode === "nitrous"} onClick={() => chooseMode("nitrous")} disabled={!entitled || !!account?.automationEnabled || !!busy}><span className="nitrous-mode-icon"><Zap size={23} /></span><span><strong>Nitrous</strong><small>Faster setup scanner. Higher risk.</small></span><span className="nitrous-mode-risk">3–5%<small>per trade</small></span></button>
    </div>}
    <div className="nitrous-layout" data-addon-only={!entitled && !account && !isAdmin}><div className="nitrous-main-column">{entitled ? <NitrousMarketDesk data={analysis} loading={analysisLoading} error={analysisError} fresh={readFresh} now={marketClock} accountNow={accountClock} account={account} onRefresh={() => void refreshAnalysis()} simple={isSimple} mode={mode} busy={!!busy} onClose={position => { setActionError(""); setClosing(position); }} />
      : <NitrousAddonPanel addon={status.data?.addon ?? null} loading={status.loading} unavailable={!!status.error || status.data?.addon?.verificationUnavailable === true} onUpdated={status.refresh} />}
      {!entitled && account && <p className="nitrous-health-note">Your account and open positions remain available here. New setups and auto entries require Nitrous access.</p>}
      {!entitled && account && <NitrousLiveTrades account={account} accountNow={accountClock} referencePrice={readFresh ? analysis?.price ?? null : null} referenceAt={analysis?.asOf ?? null} now={status.now} simple={isSimple} busy={!!busy} onClose={position => { setActionError(""); setClosing(position); }} />}</div>
      <aside className="nitrous-side-column" aria-label="Trading account controls">{(entitled || account) && <section className="nitrous-account nitrous-panel" data-nitrous-active={active} aria-labelledby="nitrous-account-title">
        <div className="nitrous-section-head"><div><span className="nitrous-eyebrow">YOUR TRADELOCKER ACCOUNT</span><h2 id="nitrous-account-title">{active ? "Auto trading is active" : account ? "Account control" : "Connect. Set. Trade."}</h2></div><span className="nitrous-account-signal"><Activity size={20} /></span></div>
        {status.error && <p className="nitrous-error" role="alert">{status.error}</p>}
        {!account ? <div className="nitrous-connect-empty"><span className="nitrous-connect-orbit"><Link2 size={32} /></span><h3>Your account, in view.</h3><p>Connect a real or demo TradeLocker account to see your balance, manage risk, and turn on auto trading.</p>
          <button type="button" className="nitrous-button nitrous-button-primary" onClick={() => setConnecting(true)} disabled={!entitled || status.loading}><Link2 size={17} />{status.loading ? "Checking accounts…" : "Connect TradeLocker"}</button><small>Connecting an account does not turn on trading.</small></div>
          : <>
            <div className="nitrous-account-select"><label htmlFor="nitrous-account-choice" className="nitrous-sr-only">Choose linked account</label><select id="nitrous-account-choice" value={account.accountId} onChange={e => { setAccountId(e.target.value); setNotice(""); }} disabled={!!busy || arming || !!closing}>{accounts.map(a => <option key={a.accountId} value={a.accountId}>{a.name || "TradeLocker"} {a.masked} · {a.environment}</option>)}</select><ChevronDown size={16} aria-hidden="true" /></div>
            <div className="nitrous-account-state"><span className="nitrous-status" data-active={active}><i />{active ? "AUTO ACTIVE" : account.automationEnabled ? "AUTO WAITING" : "AUTO PAUSED"}</span><span className="nitrous-account-env">{account.environment === "live" ? "REAL ACCOUNT" : "DEMO ACCOUNT"}</span></div>
            <div className="nitrous-balance"><span>Account balance</span><strong>{money(account.balance, currency)}</strong><small>Equity {money(account.equity, currency)} · {elapsed(account.equityAt, status.now)}</small></div>
            <div className="nitrous-account-stats"><div><small>Wins</small><strong>{account.stats.wins}</strong></div><div><small>Losses</small><strong>{account.stats.losses}</strong></div><div><small>{shownPnlLabel(account)}</small><strong data-result={shownPnl(account) == null ? "unknown" : Number(shownPnl(account)) >= 0 ? "positive" : "negative"}>{money(shownPnl(account), currency)}</strong></div></div>
            <p className="nitrous-stat-note">Nitrous account history · {account.stats.closed - account.stats.unresolved} graded closes{account.stats.unresolved > 0 ? ` · ${account.stats.unresolved} awaiting result` : ""}{!account.stats.pnlVerified && account.stats.closed > 0 ? " · Costs not fully reconciled" : ""}</p>
            <div className="nitrous-risk-controls"><div><label>Risk per trade</label><span>{modeName(mode)}</span></div><div className="nitrous-risk-presets" role="group" aria-label="Risk per trade">{profile.riskPresets.map(pct => <button type="button" key={pct} aria-pressed={riskPct === pct} onClick={() => { setRiskPct(pct); setNotice(""); }} disabled={!entitled || !!account.automationEnabled || !!busy}>{pct}%</button>)}</div>
              <p><strong>{money(plannedRisk, currency)}</strong> planned budget per trade</p><small>{account.automationEnabled ? "Pause auto trading to change mode or risk." : "Actual size rounds down to your broker’s lot step. Setups that cannot fit your budget are skipped."}</small></div>
            {entitled && !isSimple && <div className="nitrous-management"><label><input type="checkbox" checked={account.managementEnabled} disabled={account.automationEnabled || !!busy} onChange={event => void settings({ managementEnabled: event.target.checked }, "management")} /><span>Automatic trade management<small>Applies to new trades. Existing trades keep their saved management plan.</small></span></label></div>}
            {entitled && changed && !account.automationEnabled && <button className="nitrous-button nitrous-button-secondary" type="button" onClick={() => void settings({ mode, riskPct }, "save")} disabled={!!busy}>{busy === "save" ? <Loader2 className="nitrous-spin" size={17} /> : <Check size={17} />}Save {modeName(mode)} profile</button>}
            <p className="nitrous-health-note"><strong>Account entry rules:</strong> {accountStrategyName(account)}.{account.automationEnabled ? " Qualifying entries still require broker and risk checks." : " Auto trading is paused."}</p>
            {entitled && account.automationEnabled && account.mode === "nitrous" && !account.fastStrategyEnabled && <button type="button" className="nitrous-button nitrous-button-primary" disabled={!canArm || !!busy} onClick={() => reviewStrategies(NITROUS_FAST_CONSENT_VERSION)}><Zap size={17} />Enable faster Nitrous</button>}
            {entitled && mode === "nitrous" && !account.sweepStrategyEnabled && <><p className="nitrous-health-note">Sweep &amp; reclaim is available as an additional strategy. It can enter near a completed reclaim close without waiting for another retest. Review and authorize it for this account to enable it.</p><button type="button" className="nitrous-button nitrous-button-secondary" disabled={!canArm || !!busy} onClick={() => reviewStrategies(NITROUS_SWEEP_CONSENT_VERSION)}><Zap size={17} />Review sweep &amp; reclaim</button></>}
            {account.automationEnabled ? <button type="button" className="nitrous-button nitrous-button-secondary" disabled={!!busy} onClick={() => void settings({ automationEnabled: false }, "pause")}>{busy === "pause" ? <Loader2 className="nitrous-spin" size={17} /> : <Pause size={17} />}Pause auto trading</button>
              : <button type="button" className="nitrous-button nitrous-button-primary" disabled={!canArm || !!busy} onClick={() => reviewStrategies()}><Play size={17} />Turn on auto trading</button>}
            {account.blockers.length > 0 && <div className="nitrous-blockers"><strong>Before new entries can start</strong><ul>{account.blockers.map((blocker, i) => <li key={i}>{blocker}</li>)}</ul></div>}
            {!status.data?.worker.healthy && !account.blockers.some(b => /execution service|worker/i.test(b)) && <p className="nitrous-health-note">Waiting for the execution service to report ready.</p>}
            <div className="nitrous-account-footer"><button type="button" onClick={() => void refreshAccount()} disabled={!!busy}>{busy === "refresh" ? <Loader2 size={14} className="nitrous-spin" /> : <RefreshCw size={14} />}Refresh account</button>{entitled && <button type="button" onClick={() => setConnecting(true)} disabled={!!busy}>Add account</button>}</div>
          </>}
        {notice && <p className="nitrous-notice" role="status">{notice}</p>}
        {actionError && !arming && !closing && <p className="nitrous-error" role="alert">{actionError}</p>}
      </section>}
      {entitled && <NitrousAddonPanel addon={status.data?.addon ?? null} loading={status.loading} unavailable={!!status.error || status.data?.addon?.verificationUnavailable === true} onUpdated={status.refresh} />}
      {(entitled || isAdmin) && <NitrousTelegramPanel admin={isAdmin} telegram={status.data?.telegram} />}
      <div className="nitrous-pace-note"><ShieldCheck size={17} aria-hidden="true" /><p>{mode === "nitrous" ? "Nitrous uses high risk. A run of losses can consume your trading allocation quickly." : "Slow Drip sizes every trade to your account. Small risk can mean fewer eligible setups."}</p></div>
      </aside></div>
    <footer className="nitrous-footer"><span>Visible setups are conditional until their triggers qualify. Trading can lose money.</span>{!isSimple && analysis?.strategyVersion && <span>{analysis.strategyVersion}</span>}</footer>
    {connecting && entitled && <NitrousConnect onClose={() => setConnecting(false)} onConnected={id => { setConnecting(false); if (id) setAccountId(id); void status.refresh(); setNotice("Account connected. Choose your mode and turn on auto trading when ready."); }} />}
    {arming && entitled && account && <ArmDialog key={`${account.accountId}:${mode}:${riskPct}`} account={account} mode={mode} riskPct={riskPct} consentVersion={armConsent} busy={busy === "arm"} error={actionError} onCancel={() => { setArming(false); setActionError(""); }} onConfirm={version => void settings({ mode, riskPct, automationEnabled: true, acknowledgedRisk: true, consentVersion: version }, "arm")} />}
    {closing && account && <CloseDialog position={closing} account={account} busy={busy === "close"} error={actionError} onCancel={() => { setClosing(null); setActionError(""); }} onConfirm={() => void closePosition()} />}
  </div>;
}

