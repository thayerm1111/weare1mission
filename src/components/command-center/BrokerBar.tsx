"use client";

import { useCallback, useEffect, useState } from "react";
import { Link2, ShieldCheck, X } from "lucide-react";

/**
 * CONNECT BROKER — a compact chip in the existing header, and a sheet behind it.
 *
 * Deliberately small. The Command Center is an intelligence product; the broker is an ability it has, not
 * the point of the screen. Everything here uses the palette and shapes already on the page so it reads as
 * something that was always there.
 */

const C = {
  panel: "#0A0E15", raised: "#0E131C", line: "rgba(255,255,255,0.07)",
  text: "#E8EFF7", mut: "rgba(232,239,247,0.56)", mut2: "rgba(232,239,247,0.34)",
  gold: "#F0C475", up: "#3FD9A0", down: "#F4737B", cold: "#6FA8DC", amber: "#E9B949",
};

export type BrokerAccount = {
  id: string; accountId: string; accNum: string; label: string; isLive: boolean;
  currency: string | null; balance: number | null; equity: number | null; openPl: number | null;
  selected: boolean; autoTrading: boolean; liveAuthorized: boolean;
  permissions: Record<string, boolean>; connectionStatus: string; env: string; server: string;
};

const money = (n: number | null | undefined, ccy?: string | null) =>
  n == null ? "—" : `${ccy === "USD" || !ccy ? "$" : ""}${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

export function BrokerBar({ onAccountChange }: { onAccountChange?: (a: BrokerAccount | null) => void }) {
  const [accounts, setAccounts] = useState<BrokerAccount[]>([]);
  const [ready, setReady] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [env, setEnv] = useState<"demo" | "live">("demo");
  const [server, setServer] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/command-center/broker", { cache: "no-store" });
      if (!r.ok) return;
      const j = await r.json();
      setAccounts(j.accounts ?? []);
      setReady(j.ready !== false);
      setNotice(j.notice ?? null);
      onAccountChange?.((j.accounts ?? []).find((a: BrokerAccount) => a.selected) ?? (j.accounts ?? [])[0] ?? null);
    } catch { /* keep what we had */ }
  }, [onAccountChange]);

  useEffect(() => { void load(); }, [load]);

  const post = useCallback(async (body: Record<string, unknown>) => {
    setBusy(true); setError(null);
    try {
      const r = await fetch("/api/command-center/broker", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok || j.ok === false) setError(j.reason ?? "That didn't work.");
      await load();
      return j;
    } catch { setError("Could not reach the Command Center."); return null; }
    finally { setBusy(false); }
  }, [load]);

  const selected = accounts.find((a) => a.selected) ?? accounts[0] ?? null;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.12em] transition"
        style={{
          background: selected ? (selected.isLive ? "rgba(244,115,123,0.10)" : "rgba(111,168,220,0.10)") : "rgba(240,196,117,0.10)",
          border: `1px solid ${selected ? (selected.isLive ? "rgba(244,115,123,0.30)" : "rgba(111,168,220,0.26)") : "rgba(240,196,117,0.30)"}`,
          color: selected ? (selected.isLive ? C.down : C.cold) : C.gold,
        }}
      >
        <Link2 className="h-3 w-3" />
        {selected ? (
          <>
            <span>{selected.isLive ? "LIVE" : "DEMO"}</span>
            <span style={{ color: C.mut }}>· {selected.accNum}</span>
            <span style={{ color: C.text }}>{money(selected.equity ?? selected.balance, selected.currency)}</span>
          </>
        ) : "Connect broker"}
      </button>

      {open && (
        <div className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto p-4 sm:p-8" style={{ background: "rgba(3,5,9,0.72)", backdropFilter: "blur(6px)" }}>
          <div className="w-full max-w-lg rounded-2xl border" style={{ borderColor: C.line, background: C.panel, color: C.text }}>
            <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: C.line }}>
              <p className="text-[11px] font-bold uppercase tracking-[0.18em]" style={{ color: C.mut2 }}>TradeLocker</p>
              <button onClick={() => setOpen(false)} aria-label="Close"><X className="h-4 w-4" style={{ color: C.mut2 }} /></button>
            </div>

            {!ready && <p className="px-4 py-3 text-[12px]" style={{ color: C.amber }}>{notice}</p>}

            {accounts.length > 0 && (
              <div className="border-b px-4 py-3" style={{ borderColor: C.line }}>
                <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.16em]" style={{ color: C.mut2 }}>Accounts</p>
                <div className="space-y-2">
                  {accounts.map((a) => (
                    <div key={a.id} className="rounded-xl border px-3 py-2.5" style={{ borderColor: a.selected ? "rgba(240,196,117,0.30)" : C.line, background: a.selected ? "rgba(240,196,117,0.05)" : C.raised }}>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-[13px] font-bold">
                            {a.label}
                            <span className="ml-2 rounded-full px-1.5 py-0.5 text-[9px] font-black tracking-[0.1em]"
                              style={{ background: a.isLive ? "rgba(244,115,123,0.14)" : "rgba(111,168,220,0.14)", color: a.isLive ? C.down : C.cold }}>
                              {a.isLive ? "LIVE" : "DEMO"}
                            </span>
                          </p>
                          <p className="text-[11px] tabular-nums" style={{ color: C.mut2 }}>
                            #{a.accNum} · bal {money(a.balance, a.currency)} · eq {money(a.equity, a.currency)}
                            {a.openPl != null ? ` · open ${a.openPl >= 0 ? "+" : ""}${a.openPl.toFixed(2)}` : ""}
                          </p>
                        </div>
                        {!a.selected && (
                          <button onClick={() => void post({ action: "select", accountRowId: a.id })} disabled={busy}
                            className="rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.1em]"
                            style={{ background: "rgba(255,255,255,0.05)", color: C.mut, border: `1px solid ${C.line}` }}>
                            Use
                          </button>
                        )}
                      </div>

                      {a.isLive && !a.liveAuthorized && (
                        <div className="mt-2.5 rounded-lg px-2.5 py-2" style={{ background: "rgba(244,115,123,0.07)", border: "1px solid rgba(244,115,123,0.22)" }}>
                          <p className="text-[11.5px] leading-relaxed" style={{ color: C.mut }}>
                            This is a real-money account. No order can be sent on it until you authorise live trading.
                          </p>
                          <button onClick={() => void post({ action: "authorize_live", accountRowId: a.id, confirm: true })} disabled={busy}
                            className="mt-2 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[10px] font-bold uppercase tracking-[0.1em]"
                            style={{ background: "rgba(244,115,123,0.14)", color: C.down, border: "1px solid rgba(244,115,123,0.32)" }}>
                            <ShieldCheck className="h-3 w-3" /> Authorise live trading
                          </button>
                        </div>
                      )}

                      {a.selected && (
                        <div className="mt-2.5 border-t pt-2.5" style={{ borderColor: C.line }}>
                          <p className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.16em]" style={{ color: C.mut2 }}>What THE BRAIN may do here</p>
                          <div className="flex flex-wrap gap-1.5">
                            {([
                              ["ai_break_even", "Break even"],
                              ["ai_protect_stop", "Protect stop"],
                              ["ai_partial", "Partials"],
                              ["ai_close", "Close"],
                            ] as const).map(([k, label]) => {
                              const on = !!a.permissions?.[k];
                              return (
                                <button key={k} disabled={busy}
                                  onClick={() => void post({ action: "permissions", accountRowId: a.id, [k]: !on })}
                                  className="rounded-full px-2.5 py-1 text-[10px] font-semibold"
                                  style={{
                                    background: on ? "rgba(63,217,160,0.12)" : "rgba(255,255,255,0.04)",
                                    color: on ? C.up : C.mut2,
                                    border: `1px solid ${on ? "rgba(63,217,160,0.30)" : C.line}`,
                                  }}>
                                  {label}
                                </button>
                              );
                            })}
                          </div>
                          <p className="mt-2 text-[10.5px] leading-relaxed" style={{ color: C.mut2 }}>
                            Automatic trading is {a.autoTrading ? "ON" : "off"}. Turning it on lets THE BRAIN open trades by itself
                            {a.isLive ? ", and on a live account it needs live trading authorised first" : ""}.
                          </p>
                          <button disabled={busy} onClick={() => void post({ action: "auto_trading", accountRowId: a.id, on: !a.autoTrading })}
                            className="mt-1.5 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.1em]"
                            style={{
                              background: a.autoTrading ? "rgba(233,185,73,0.12)" : "rgba(255,255,255,0.04)",
                              color: a.autoTrading ? C.amber : C.mut2, border: `1px solid ${a.autoTrading ? "rgba(233,185,73,0.30)" : C.line}`,
                            }}>
                            {a.autoTrading ? "Turn auto trading off" : "Turn auto trading on"}
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="px-4 py-3">
              <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.16em]" style={{ color: C.mut2 }}>
                {accounts.length ? "Connect another account" : "Connect your account"}
              </p>
              <div className="flex gap-1.5">
                {(["demo", "live"] as const).map((e) => (
                  <button key={e} onClick={() => setEnv(e)}
                    className="rounded-full px-3 py-1 text-[10px] font-bold uppercase tracking-[0.1em]"
                    style={{
                      background: env === e ? (e === "live" ? "rgba(244,115,123,0.14)" : "rgba(111,168,220,0.14)") : "rgba(255,255,255,0.04)",
                      color: env === e ? (e === "live" ? C.down : C.cold) : C.mut2,
                      border: `1px solid ${env === e ? (e === "live" ? "rgba(244,115,123,0.32)" : "rgba(111,168,220,0.28)") : C.line}`,
                    }}>
                    {e}
                  </button>
                ))}
              </div>
              <div className="mt-2 grid gap-2">
                {([["Server", server, setServer, "text"], ["Email", email, setEmail, "email"], ["Password", password, setPassword, "password"]] as const).map(([label, v, set, type]) => (
                  <label key={label} className="block">
                    <span className="text-[10px] uppercase tracking-[0.14em]" style={{ color: C.mut2 }}>{label}</span>
                    <input type={type} value={v} onChange={(e) => set(e.target.value)} autoComplete="off"
                      className="mt-1 w-full rounded-lg px-3 py-2 text-[13px] outline-none"
                      style={{ background: C.raised, border: `1px solid ${C.line}`, color: C.text }} />
                  </label>
                ))}
              </div>
              <p className="mt-2 text-[10.5px] leading-relaxed" style={{ color: C.mut2 }}>
                Your password is used once to sign in and is never stored. Only the broker&rsquo;s refresh token is kept, encrypted.
              </p>
              {error && <p className="mt-2 text-[11.5px]" style={{ color: C.down }}>{error}</p>}
              <button
                disabled={busy || !ready || !server || !email || !password}
                onClick={async () => {
                  const j = await post({ action: "connect", env, server, email, password });
                  if (j?.ok) { setPassword(""); setEmail(""); }
                }}
                className="mt-2.5 w-full rounded-xl px-3 py-2.5 text-[11px] font-bold uppercase tracking-[0.14em] transition disabled:opacity-40"
                style={{ background: "rgba(240,196,117,0.14)", color: C.gold, border: "1px solid rgba(240,196,117,0.32)" }}>
                {busy ? "Connecting…" : "Connect"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default BrokerBar;
