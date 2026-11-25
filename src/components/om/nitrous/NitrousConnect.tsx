"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Check, Link2, Loader2, LockKeyhole, X } from "lucide-react";
import type { NitrousBrokerAccount } from "@/lib/nitrous/types";
import { money } from "./presentation";

export function NitrousConnect({ onClose, onConnected }: { onClose: () => void; onConnected: (id?: string) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [environment, setEnvironment] = useState<"live" | "demo">("live");
  const [server, setServer] = useState(""); const [email, setEmail] = useState(""); const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const [connectionId, setConnectionId] = useState("");
  const [accounts, setAccounts] = useState<NitrousBrokerAccount[]>([]);
  const [selected, setSelected] = useState("");
  useEffect(() => { dialog.current?.showModal(); }, []);

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const res = await fetch("/api/nitrous/connect", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "connect", environment, server: server.trim(), email: email.trim(), password, savePassword: false }) });
      const out = await res.json().catch(() => null);
      if (!res.ok || !out?.ok || typeof out.connectionId !== "string" || !Array.isArray(out.accounts)) throw new Error(out?.detail ?? out?.error ?? "TradeLocker could not connect. Check your credentials and broker server.");
      setConnectionId(out.connectionId); setAccounts(out.accounts); setSelected("");
      if (!out.accounts.length) setError("TradeLocker did not return an account for these credentials.");
    } catch (err) { setError(err instanceof Error ? err.message : "TradeLocker could not connect."); }
    finally { setPassword(""); setBusy(false); }
  }
  async function select(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const account = accounts.find(a => a.accountId === selected); if (!account) return;
    setBusy(true); setError("");
    try {
      const res = await fetch("/api/nitrous/connect", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "select", connectionId, brokerAccountId: account.accountId,
          accNum: account.accNum, name: account.name, currency: account.currency }) });
      const out = await res.json().catch(() => null);
      if (!res.ok || !out?.ok) throw new Error(out?.detail ?? out?.error ?? "Unable to link this account.");
      onConnected(typeof out.accountId === "string" ? out.accountId : undefined);
    } catch (err) { setError(err instanceof Error ? err.message : "Unable to link this account."); }
    finally { setBusy(false); }
  }
  return <dialog ref={dialog} className="nitrous-dialog" aria-labelledby="nitrous-connect-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <div className="nitrous-dialog-head"><span className="nitrous-icon-disc"><Link2 size={21} aria-hidden="true" /></span><button type="button" className="nitrous-icon-button" onClick={onClose} disabled={busy} aria-label="Close TradeLocker connection"><X size={20} /></button></div>
    <h2 id="nitrous-connect-title">{connectionId ? "Choose your account" : "Connect TradeLocker"}</h2>
    <p className="nitrous-muted">{connectionId ? "You can use an account connected to other One Mission tools. Nitrous manages only its own trades." : "Use your TradeLocker broker server and sign-in details. Accounts linked to other One Mission tools are supported."}</p>
    {error && <p className="nitrous-error" role="alert">{error}</p>}
    {!connectionId ? <form onSubmit={connect} className="nitrous-form">
      <div className="nitrous-environment" role="group" aria-label="TradeLocker environment">
        <button type="button" aria-pressed={environment === "live"} disabled={busy} onClick={() => setEnvironment("live")}>Real account</button>
        <button type="button" aria-pressed={environment === "demo"} disabled={busy} onClick={() => setEnvironment("demo")}>Demo account</button>
      </div>
      <label>Broker server<input required autoComplete="off" value={server} onChange={e => setServer(e.target.value)} disabled={busy} placeholder="Server shown in TradeLocker" /></label>
      <label>Email<input required type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} disabled={busy} placeholder="you@example.com" /></label>
      <label>Password<input required type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} disabled={busy} /></label>
      <p className="nitrous-inline-note"><LockKeyhole size={15} aria-hidden="true" />Your password is used for sign-in and is not saved.</p>
      <button className="nitrous-button nitrous-button-primary" type="submit" disabled={busy}>{busy ? <Loader2 className="nitrous-spin" size={17} /> : <Link2 size={17} />}{busy ? "Connecting…" : "Connect TradeLocker"}</button>
    </form> : <form onSubmit={select} className="nitrous-form">
      <fieldset className="nitrous-account-options"><legend>{environment === "live" ? "Real accounts" : "Demo accounts"}</legend>
        {accounts.map(a => <label key={a.accountId} data-selected={selected === a.accountId}>
          <input type="radio" name="nitrous-broker-account" value={a.accountId} checked={selected === a.accountId} onChange={() => setSelected(a.accountId)} disabled={busy} />
          <span><strong>{a.name || "TradeLocker account"}</strong><small>••••{a.accountId.slice(-4)} · {a.currency ?? "Currency pending"}</small></span><b>{money(a.balance, a.currency ?? "USD")}</b>
        </label>)}
      </fieldset>
      <p className="nitrous-inline-note">Linking an account leaves auto trading off. You choose when to activate Nitrous.</p>
      <button className="nitrous-button nitrous-button-primary" disabled={busy || !selected} type="submit">{busy ? <Loader2 className="nitrous-spin" size={17} /> : <Check size={17} />}{busy ? "Verifying account…" : "Link selected account"}</button>
      <button type="button" className="nitrous-button nitrous-button-quiet" disabled={busy} onClick={() => { setConnectionId(""); setAccounts([]); setError(""); }}>Use a different connection</button>
    </form>}
  </dialog>;
}
