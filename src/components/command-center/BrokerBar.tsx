"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronLeft, Link2, ShieldCheck, X } from "lucide-react";

/**
 * CONNECT TRADELOCKER — a compact chip in the existing header, and a guided flow behind it.
 *
 * The first version put environment, server, email and password on one form and showed accounts as
 * `GENFX#95e9f433-abed-4001-bf51-…`. That is a database row wearing a UI, and it failed people twice: a
 * member could sign into the wrong environment without noticing, and once connected they could not tell
 * one account from another without reading a UUID.
 *
 * So: one decision per step, and a broker's own vocabulary throughout. A member sees GENFX · LIVE ·
 * #123456 and a balance. The identifiers still exist — they are what the system actually trades on — but
 * they live under ACCOUNT DETAILS, where somebody debugging can find them and nobody else has to.
 *
 * FOUR CONCEPTS, KEPT SEPARATE, because collapsing any two of them is how people lose money:
 *   BROKER → SERVER → AUTH SESSION → ACCOUNT.  A server is not an account.
 *   CONNECTED is not AUTHORISED TO TRADE.       Reading a balance is not permission to send an order.
 */

const C = {
  panel: "#0A0E15", raised: "#0E131C", line: "rgba(255,255,255,0.07)",
  text: "#E8EFF7", mut: "rgba(232,239,247,0.56)", mut2: "rgba(232,239,247,0.34)",
  gold: "#F0C475", up: "#3FD9A0", down: "#F4737B", cold: "#6FA8DC", amber: "#E9B949",
};

export type BrokerAccount = {
  id: string; accountId: string; accNum: string; label: string; isLive: boolean;
  currency: string | null; balance: number | null; equity: number | null; openPl: number | null;
  marginAvailable: number | null; stateAt: string | null;
  selected: boolean; autoTrading: boolean; liveAuthorized: boolean;
  permissions: Record<string, boolean>; connectionStatus: string; env: string; server: string;
};

/**
 * Money, or an honest word.
 *
 * "—" was the old placeholder and it was wrong: it reads as zero to some people and as broken to others.
 * A number the broker has not given us yet is UNAVAILABLE, said plainly.
 */
const money = (n: number | null | undefined, ccy?: string | null) =>
  n == null ? null : `${ccy === "USD" || !ccy ? "$" : `${ccy} `}${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

type KnownServer = { server: string; email: string; env: string };
type Step = "environment" | "credentials" | "connecting" | "accounts";

export function BrokerBar({ onAccountChange }: { onAccountChange?: (a: BrokerAccount | null) => void }) {
  const [accounts, setAccounts] = useState<BrokerAccount[]>([]);
  const [known, setKnown] = useState<KnownServer[]>([]);
  const [ready, setReady] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  // THE BRAIN can open this panel when a member asks where their broker or permissions are set,
  // so the answer ends with the thing on screen rather than with directions to it.
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener("cc:open-broker", onOpen);
    return () => window.removeEventListener("cc:open-broker", onOpen);
  }, []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<Step>("environment");
  const [details, setDetails] = useState<string | null>(null);

  const [env, setEnv] = useState<"demo" | "live" | null>(null);
  const [server, setServer] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/command-center/broker", { cache: "no-store" });
      if (!r.ok) return;
      const j = await r.json();
      setAccounts(j.accounts ?? []);
      setKnown(j.known ?? []);
      setReady(j.ready !== false);
      setNotice(j.notice ?? null);
      onAccountChange?.((j.accounts ?? []).find((a: BrokerAccount) => a.selected) ?? (j.accounts ?? [])[0] ?? null);
    } catch { /* keep what we had rather than blanking the chip */ }
  }, [onAccountChange]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (open) setStep(accounts.length ? "accounts" : "environment"); }, [open, accounts.length]);

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

  const active = useMemo(() => accounts.find((a) => a.selected) ?? accounts[0] ?? null, [accounts]);
  const others = useMemo(() => accounts.filter((a) => a.id !== active?.id), [accounts, active]);

  const doConnect = useCallback(async () => {
    setStep("connecting");
    const j = await post({ action: "connect", env, server, email, password });
    setPassword("");
    if (j?.ok) { setStep("accounts"); setEmail(""); }
    else setStep("credentials");
  }, [post, env, server, email, password]);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.12em] transition"
        style={{
          background: active ? (active.isLive ? "rgba(244,115,123,0.10)" : "rgba(111,168,220,0.10)") : "rgba(240,196,117,0.10)",
          border: `1px solid ${active ? (active.isLive ? "rgba(244,115,123,0.30)" : "rgba(111,168,220,0.26)") : "rgba(240,196,117,0.30)"}`,
          color: active ? (active.isLive ? C.down : C.cold) : C.gold,
        }}
      >
        <Link2 className="h-3 w-3" />
        {active ? (
          <>
            <span>{active.server || (active.isLive ? "LIVE" : "DEMO")}</span>
            <span style={{ color: C.mut }}>· #{active.accNum}</span>
            <span style={{ color: C.text }}>{money(active.equity ?? active.balance, active.currency) ?? "—"}</span>
          </>
        ) : "Connect broker"}
      </button>

      {open && (
        <div className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto p-4 sm:p-8" style={{ background: "rgba(3,5,9,0.72)", backdropFilter: "blur(6px)" }}>
          <div className="w-full max-w-lg rounded-2xl border" style={{ borderColor: C.line, background: C.panel, color: C.text }}>
            <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: C.line }}>
              <div className="flex items-center gap-2">
                {step === "credentials" && (
                  <button onClick={() => setStep("environment")} aria-label="Back"><ChevronLeft className="h-4 w-4" style={{ color: C.mut2 }} /></button>
                )}
                <p className="text-[11px] font-bold uppercase tracking-[0.18em]" style={{ color: C.mut2 }}>
                  TradeLocker{step === "accounts" ? "" : step === "environment" ? " · step 1 of 3" : step === "credentials" ? " · step 2 of 3" : ""}
                </p>
              </div>
              <button onClick={() => setOpen(false)} aria-label="Close"><X className="h-4 w-4" style={{ color: C.mut2 }} /></button>
            </div>

            {!ready && <p className="px-4 py-3 text-[12px]" style={{ color: C.amber }}>{notice}</p>}

            {/* ── the account THE BRAIN is managing ── */}
            {step === "accounts" && active && (
              <div className="border-b px-4 py-3.5" style={{ borderColor: C.line }}>
                <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.16em]" style={{ color: C.gold }}>Active trading account</p>
                <AccountCard a={active} active busy={busy} post={post} details={details} setDetails={setDetails} />
              </div>
            )}

            {step === "accounts" && others.length > 0 && (
              <div className="border-b px-4 py-3" style={{ borderColor: C.line }}>
                <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.16em]" style={{ color: C.mut2 }}>Other accounts</p>
                <div className="space-y-2">
                  {others.map((a) => <AccountCard key={a.id} a={a} busy={busy} post={post} details={details} setDetails={setDetails} />)}
                </div>
              </div>
            )}

            {/* ── STEP 1: which world are we signing into? ── */}
            {step === "environment" && (
              <div className="px-4 py-4">
                <p className="text-[10px] font-bold uppercase tracking-[0.16em]" style={{ color: C.mut2 }}>Account environment</p>
                <p className="mt-1 text-[11.5px] leading-relaxed" style={{ color: C.mut2 }}>
                  TradeLocker runs live and demo as completely separate systems, with separate sign-ins. Picking the
                  wrong one is the most common reason a connection fails.
                </p>
                <div className="mt-3 grid gap-2">
                  {([
                    ["live", "LIVE", "Real money. Real orders.", C.down, "rgba(244,115,123,"],
                    ["demo", "DEMO", "Practice account. Nothing at risk.", C.cold, "rgba(111,168,220,"],
                  ] as const).map(([id, label, hint, colour, rgb]) => (
                    <button key={id} onClick={() => { setEnv(id); setStep("credentials"); setError(null); }}
                      className="rounded-xl px-3.5 py-3 text-left"
                      style={{ background: `${rgb}0.07)`, border: `1px solid ${rgb}0.26)` }}>
                      <p className="text-[13px] font-black tracking-[0.06em]" style={{ color: colour }}>{label}</p>
                      <p className="text-[11.5px]" style={{ color: C.mut2 }}>{hint}</p>
                    </button>
                  ))}
                </div>
                {accounts.length > 0 && (
                  <button onClick={() => setStep("accounts")}
                    className="mt-3 text-[10.5px] font-bold uppercase tracking-[0.12em] underline decoration-dotted underline-offset-4"
                    style={{ color: C.mut2 }}>
                    Back to my accounts
                  </button>
                )}
              </div>
            )}

            {/* ── STEP 2: the broker's own details ── */}
            {step === "credentials" && (
              <div className="px-4 py-4">
                <div className="mb-3 inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.12em]"
                  style={{
                    background: env === "live" ? "rgba(244,115,123,0.12)" : "rgba(111,168,220,0.12)",
                    color: env === "live" ? C.down : C.cold,
                    border: `1px solid ${env === "live" ? "rgba(244,115,123,0.30)" : "rgba(111,168,220,0.26)"}`,
                  }}>
                  {env === "live" ? "LIVE ACCOUNT" : "DEMO ACCOUNT"}
                </div>

                {known.filter((k) => k.env === env).length > 0 && (
                  <div className="mb-3">
                    <p className="mb-1.5 text-[10.5px] leading-relaxed" style={{ color: C.mut2 }}>
                      Servers you have already used. Tap one to fill in the exact spelling — you still enter the password.
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {known.filter((k) => k.env === env).map((k, i) => (
                        <button key={i} onClick={() => { setServer(k.server); setEmail(k.email); setError(null); }}
                          className="rounded-full px-2.5 py-1 text-[10.5px] font-semibold"
                          style={{
                            background: server === k.server ? "rgba(111,168,220,0.18)" : "rgba(111,168,220,0.08)",
                            color: C.cold, border: "1px solid rgba(111,168,220,0.26)",
                          }}>
                          {k.server}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div className="grid gap-2">
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
                  The server is your broker or prop firm&#39;s own name for it and the spelling has to match theirs
                  exactly. Your password signs you in once and is never stored — only the broker&#39;s refresh token is
                  kept, encrypted.
                </p>
                {error && <p className="mt-2 text-[11.5px]" style={{ color: C.down }}>{error}</p>}
                <button disabled={busy || !ready || !server || !email || !password} onClick={() => void doConnect()}
                  className="mt-3 w-full rounded-xl px-3 py-2.5 text-[11px] font-bold uppercase tracking-[0.14em] transition disabled:opacity-40"
                  style={{ background: "rgba(240,196,117,0.14)", color: C.gold, border: "1px solid rgba(240,196,117,0.32)" }}>
                  Connect
                </button>
              </div>
            )}

            {/* ── STEP 3 ── */}
            {step === "connecting" && (
              <div className="px-4 py-8 text-center">
                <p className="text-[12px] uppercase tracking-[0.16em]" style={{ color: C.gold }}>Connecting…</p>
                <p className="mt-1.5 text-[11.5px]" style={{ color: C.mut2 }}>
                  Signing in to {server || "the server"} and reading the accounts it lists.
                </p>
              </div>
            )}

            {step === "accounts" && (
              <div className="px-4 py-3">
                <button onClick={() => { setStep("environment"); setEnv(null); setServer(""); setError(null); }}
                  className="text-[10.5px] font-bold uppercase tracking-[0.12em] underline decoration-dotted underline-offset-4"
                  style={{ color: C.mut2 }}>
                  Connect another account
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

/* ── one account, in a broker's own words ─────────────────────────────────── */

function AccountCard({ a, active = false, busy, post, details, setDetails }: {
  a: BrokerAccount;
  active?: boolean;
  busy: boolean;
  post: (b: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
  details: string | null;
  setDetails: (v: string | null) => void;
}) {
  const open = details === a.id;
  const Cell = ({ label, value }: { label: string; value: string | null }) => (
    <div>
      <p className="text-[10px] uppercase tracking-[0.12em]" style={{ color: C.mut2 }}>{label}</p>
      <p className="text-[12.5px] font-bold tabular-nums" style={{ color: value ? C.text : C.mut2 }}>
        {value ?? "Unavailable"}
      </p>
    </div>
  );

  return (
    <div className="rounded-xl border px-3 py-2.5"
      style={{ borderColor: active ? "rgba(240,196,117,0.30)" : C.line, background: active ? "rgba(240,196,117,0.04)" : C.raised }}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 text-[14px] font-black tracking-tight">
            {a.server || a.label}
            <span className="rounded-full px-1.5 py-0.5 text-[9px] font-black tracking-[0.1em]"
              style={{ background: a.isLive ? "rgba(244,115,123,0.14)" : "rgba(111,168,220,0.14)", color: a.isLive ? C.down : C.cold }}>
              {a.isLive ? "LIVE" : "DEMO"}
            </span>
          </p>
          <p className="text-[11.5px] tabular-nums" style={{ color: C.mut2 }}>Account #{a.accNum}</p>
        </div>
        {!a.selected && (
          <button onClick={() => void post({ action: "select", accountRowId: a.id })} disabled={busy}
            className="rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.1em]"
            style={{ background: "rgba(255,255,255,0.05)", color: C.mut, border: `1px solid ${C.line}` }}>
            Use this account
          </button>
        )}
      </div>

      <div className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        <Cell label="Balance" value={money(a.balance, a.currency)} />
        <Cell label="Equity" value={money(a.equity, a.currency)} />
        <Cell label="Available margin" value={money(a.marginAvailable, a.currency)} />
        <Cell label="Open P&L" value={a.openPl == null ? null : `${a.openPl >= 0 ? "+" : "−"}${money(Math.abs(a.openPl), a.currency)?.replace(/^[^0-9]*/, "") ?? ""}`} />
      </div>

      {/* CONNECTED is not AUTHORISED. Two different things, shown as two different things. */}
      <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10.5px] uppercase tracking-[0.1em]">
        <span style={{ color: a.connectionStatus === "active" ? C.up : C.amber }}>
          TradeLocker {a.connectionStatus === "active" ? "connected" : a.connectionStatus}
        </span>
        <span style={{ color: a.isLive && !a.liveAuthorized ? C.amber : a.autoTrading ? C.gold : C.mut2 }}>
          BRAIN execution {a.isLive && !a.liveAuthorized ? "not authorised" : a.autoTrading ? "on" : "off"}
        </span>
      </div>

      {a.isLive && !a.liveAuthorized && (
        <div className="mt-2.5 rounded-lg px-2.5 py-2" style={{ background: "rgba(244,115,123,0.07)", border: "1px solid rgba(244,115,123,0.22)" }}>
          <p className="text-[11.5px] leading-relaxed" style={{ color: C.mut }}>
            This is a real-money account. THE BRAIN can read it, and can send nothing on it, until you authorise live trading.
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
                <button key={k} disabled={busy} onClick={() => void post({ action: "permissions", accountRowId: a.id, [k]: !on })}
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
          <button disabled={busy} onClick={() => void post({ action: "auto_trading", accountRowId: a.id, on: !a.autoTrading })}
            className="mt-2 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.1em]"
            style={{
              background: a.autoTrading ? "rgba(233,185,73,0.12)" : "rgba(255,255,255,0.04)",
              color: a.autoTrading ? C.amber : C.mut2,
              border: `1px solid ${a.autoTrading ? "rgba(233,185,73,0.30)" : C.line}`,
            }}>
            {a.autoTrading ? "Turn auto entry off" : "Allow THE BRAIN to enter by itself"}
          </button>
        </div>
      )}

      {/* The identifiers the system actually trades on — findable, not in anybody's face. */}
      <button onClick={() => setDetails(open ? null : a.id)}
        className="mt-2 inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-[0.12em]"
        style={{ color: C.mut2 }}>
        Account details <ChevronDown className="h-3 w-3" style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform .2s" }} />
      </button>
      {open && (
        <div className="mt-1.5 space-y-0.5 text-[10.5px] tabular-nums" style={{ color: C.mut2 }}>
          <p>Server {a.server || "unknown"} · {a.env.toUpperCase()}</p>
          <p className="break-all">Account id {a.accountId}</p>
          <p>accNum {a.accNum} · currency {a.currency ?? "unknown"}</p>
          <p>{a.stateAt ? `Broker last reported ${new Date(a.stateAt).toLocaleTimeString()}` : "The broker has not reported balances yet."}</p>
        </div>
      )}
    </div>
  );
}

export default BrokerBar;
