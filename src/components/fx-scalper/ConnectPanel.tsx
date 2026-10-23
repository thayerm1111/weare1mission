"use client";

import { useState } from "react";
import { C, money, post, type StatusPayload } from "./theme";
import { Btn, Card } from "./ui";

/**
 * Connect the live TradeLocker login and choose the account. The password goes from this form to the
 * site's server over HTTPS and from there only to TradeLocker; it is never shown again or sent anywhere
 * else. Changing the account needs the bot stopped.
 */
export function ConnectPanel({ data, reload }: { data: StatusPayload; reload: () => Promise<void> }) {
  const [server, setServer] = useState("GENFX");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [stay, setStay] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [renew, setRenew] = useState(false);
  const c = data.control;
  const current = data.connections.find((x) => x.id === c.connection_id) ?? null;
  const stopped = c.mode === "stopped";

  const connect = async () => {
    setBusy(true);
    setMsg(null);
    const r = await post("/api/fx-scalper/connect", { server, email, password, stayConnected: stay, ...(renew && c.connection_id ? { reconnectConnectionId: c.connection_id } : {}) });
    setBusy(false);
    setPassword("");
    if (!r.ok) { setMsg({ ok: false, text: String(r.data.error ?? "Could not connect") }); return; }
    setMsg({ ok: true, text: r.data.renewed ? "Session renewed. The worker picks it up within seconds and carries on." : "Connected. Choose the account below." });
    setRenew(false);
    await reload();
  };

  const choose = async (connectionId: string, accountId: string, accNum: string) => {
    setBusy(true);
    const r = await post("/api/fx-scalper/account", { connectionId, accountId, accNum, expectVersion: c.version });
    setBusy(false);
    setMsg({ ok: r.ok, text: r.ok ? "Account selected. The worker discovers its instruments within a few seconds; the bot stays stopped." : String(r.data.error ?? "Refused") });
    await reload();
  };

  const disconnect = async () => {
    setBusy(true);
    const r = await post("/api/fx-scalper/account", { disconnect: true });
    setBusy(false);
    setMsg({ ok: r.ok, text: r.ok ? "Disconnected; the stored credentials were erased." : String(r.data.error ?? "Refused") });
    await reload();
  };

  return (
    <div className="space-y-4">
      <Card title="Live account">
        {c.connection_id ? (
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
            <p style={{ color: C.ink }}>Trading <b>{c.account_label}</b> (accNum {c.acc_num}, {c.account_currency ?? "currency unknown"}) on TradeLocker <b>LIVE</b>.</p>
            <Btn disabled={busy || !stopped} onClick={() => void disconnect()}>Disconnect</Btn>
          </div>
        ) : <p className="text-sm" style={{ color: C.muted }}>No account selected yet.</p>}
        {current && current.status !== "connected" && (
          <div className="mt-3 rounded-lg border px-3 py-2 text-sm" style={{ borderColor: "#F4C7C3", background: C.redSoft, color: C.red }}>
            The broker session for this account needs renewing{current.lastError ? ` (${current.lastError})` : ""}. Open bot positions keep their broker-side stop and target, but the worker cannot act until it is renewed.
            <div className="mt-2"><Btn kind="primary" onClick={() => { setRenew(true); setServer(current.server); }}>Renew the session</Btn></div>
          </div>
        )}
        {!stopped && <p className="mt-2 text-xs" style={{ color: C.muted }}>Stop the bot to change or disconnect the account. Renewing the session works at any time.</p>}
      </Card>

      <Card title={renew ? "Renew the session (same login)" : "Connect TradeLocker (LIVE)"}>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block text-sm"><span>Server</span>
            <input value={server} onChange={(e) => setServer(e.target.value)} className="mt-1 w-full rounded-lg border px-3 py-1.5" style={{ borderColor: C.line }} />
            <span className="mt-0.5 block text-xs" style={{ color: C.muted }}>The server name you use on TradeLocker&apos;s login page.</span>
          </label>
          <label className="block text-sm"><span>Email</span>
            <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} className="mt-1 w-full rounded-lg border px-3 py-1.5" style={{ borderColor: C.line }} />
          </label>
          <label className="block text-sm"><span>Password</span>
            <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className="mt-1 w-full rounded-lg border px-3 py-1.5" style={{ borderColor: C.line }} />
          </label>
        </div>
        <label className="mt-3 flex items-start gap-2 text-sm">
          <input type="checkbox" checked={stay} onChange={(e) => setStay(e.target.checked)} className="mt-0.5" />
          <span>Stay connected — keep the email and password encrypted on the server so the worker can sign in again by itself if the broker ends the session. Without it, an ended session pauses entries until you reconnect here.</span>
        </label>
        <div className="mt-3 flex items-center gap-3">
          <Btn kind="primary" disabled={busy || !server || !email || !password} onClick={() => void connect()}>{busy ? "Connecting…" : renew ? "Renew" : "Connect"}</Btn>
          {renew && <Btn onClick={() => setRenew(false)}>Cancel</Btn>}
          <span className="text-xs" style={{ color: C.muted }}>Connecting never starts trading.</span>
        </div>
        {msg && <p className="mt-2 text-sm" style={{ color: msg.ok ? C.green : C.red }}>{msg.text}</p>}
      </Card>

      {data.connections.map((cn) => (
        <Card key={cn.id} title={`${cn.server} · ${cn.emailMasked}`} right={<span className="text-xs" style={{ color: cn.status === "connected" ? C.green : C.red }}>{cn.status.replace(/_/g, " ")}{cn.staysConnected ? " · stays connected" : ""}</span>}>
          {cn.lastError && <p className="mb-2 text-xs" style={{ color: C.red }}>{cn.lastError}</p>}
          <table className="w-full text-sm">
            <tbody>
              {cn.accounts.map((a) => {
                const selected = c.connection_id === cn.id && c.account_id === a.accountId && c.acc_num === a.accNum;
                return (
                  <tr key={`${a.accountId}:${a.accNum}`} className="border-t" style={{ borderColor: C.line }}>
                    <td className="py-2 pr-3 font-semibold">{a.name ?? `Account ${a.accNum}`}</td>
                    <td className="pr-3 text-xs" style={{ color: C.muted }}>accNum {a.accNum} · id {a.accountId}</td>
                    <td className="pr-3 tabular-nums">{money(a.balance, a.currency ?? "")}</td>
                    <td className="pr-3 text-xs">{a.status ?? ""}</td>
                    <td className="text-right">{selected ? <span className="text-xs font-semibold" style={{ color: C.blue }}>selected</span> : <Btn disabled={busy || !stopped} onClick={() => void choose(cn.id, a.accountId, a.accNum)}>Use this account</Btn>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      ))}
    </div>
  );
}
