"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import EntryMap from "./EntryMap";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const STATES = ["OBSERVING", "SETUP FORMING", "TRIGGER VALIDATED", "RISK CHECK", "ORDER SUBMITTED", "POSITION PROTECTED", "POSITION MANAGED", "TRADE CLOSED", "PAUSED"];
const fmt = (n: number | null | undefined, d = 2) => (n == null || !Number.isFinite(Number(n)) ? "—" : Number(n).toFixed(d));
const ago = (iso: string | number | null | undefined) => { if (!iso) return "—"; const s = Math.max(0, (Date.now() - (typeof iso === "number" ? iso : Date.parse(iso))) / 1000); return s < 60 ? `${s.toFixed(0)}s` : s < 3600 ? `${(s / 60).toFixed(0)}m` : `${(s / 3600).toFixed(1)}h`; };
const uuid = () => (typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

async function api(path: string, body?: unknown) {
  const r = await fetch(`/api/auric/${path}`, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : { cache: "no-store" });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ...j } as Json;
}

const Card = ({ title, children, aside, className = "" }: { title?: string; children: React.ReactNode; aside?: React.ReactNode; className?: string }) => (
  <section className={`rounded-2xl bg-white/80 border border-[#E6E1D6] shadow-[0_1px_2px_rgba(15,26,43,0.04)] p-4 ${className}`}>
    {title && <div className="flex items-center justify-between mb-3"><h2 className="text-[11px] tracking-[0.22em] uppercase text-[#7A7468]">{title}</h2>{aside}</div>}
    {children}
  </section>
);
const Chip = ({ ok, label, warn }: { ok: boolean | null; label: string; warn?: boolean }) => (
  <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium border ${ok ? "bg-[#EAF4EE] text-[#2E7D5B] border-[#CFE6D8]" : warn ? "bg-[#FBF3E0] text-[#8A6508] border-[#F0DFAE]" : "bg-[#FBEBEA] text-[#B4443C] border-[#F1CFCB]"}`}><span className={`w-1.5 h-1.5 rounded-full ${ok ? "bg-[#2E7D5B]" : warn ? "bg-[#B8860B]" : "bg-[#B4443C]"}`} />{label}</span>
);
const Btn = ({ children, onClick, kind = "ghost", disabled }: { children: React.ReactNode; onClick?: () => void; kind?: "gold" | "ghost" | "danger"; disabled?: boolean }) => (
  <button onClick={onClick} disabled={disabled} className={`rounded-xl px-3.5 py-2 text-sm font-medium transition disabled:opacity-40 ${kind === "gold" ? "bg-[#0F1A2B] text-[#F7F5F0] hover:bg-[#1A2A45]" : kind === "danger" ? "border border-[#F1CFCB] text-[#B4443C] bg-white hover:bg-[#FBEBEA]" : "border border-[#E6E1D6] bg-white text-[#0F1A2B] hover:bg-[#F1EEE6]"}`}>{children}</button>
);

export default function AuricDashboard() {
  const [data, setData] = useState<Json | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [replay, setReplay] = useState<Json | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    const j = await api(`status${accountId ? `?accountId=${accountId}` : ""}`);
    if (j.status === 401) { window.location.href = "/login?redirect=/portal/auric"; return; }
    if (!j.ok) { setErr(j.error ?? "error"); return; }
    setErr(null); setData(j); if (!accountId && j.account) setAccountId(j.account.id);
  }, [accountId]);
  useEffect(() => { load(); timer.current = setInterval(load, 3000); return () => { if (timer.current) clearInterval(timer.current); }; }, [load]);

  const snap: Json | null = data?.snapshot?.payload ?? null;
  const acct: Json | null = data?.account ?? null;
  const session: Json | null = data?.session && data.session.status === "active" && Date.parse(data.session.expires_at) > Date.now() ? data.session : null;
  const openPos = useMemo(() => (data?.positions ?? []).find((p: Json) => p.status === "open" || p.status === "closing"), [data]);
  const stateIdx = STATES.indexOf(String(snap?.state ?? "OBSERVING").replace(/_/g, " "));

  if (err) return <Shell><Card><p className="text-sm text-[#B4443C]">AURIC is unavailable: {err}</p></Card></Shell>;
  if (!data) return <Shell><Card><p className="text-sm text-[#7A7468]">Loading…</p></Card></Shell>;
  if (!data.accounts?.length) return <Shell><Onboarding onDone={load} /></Shell>;

  return (
    <Shell right={<div className="flex flex-wrap gap-2 items-center">
      <select value={accountId ?? ""} onChange={(e) => setAccountId(e.target.value)} className="rounded-xl border border-[#E6E1D6] bg-white px-3 py-2 text-sm">
        {data.accounts.map((a: Json) => <option key={a.id} value={a.id}>{a.name ?? a.broker_account_id} · {a.acc_num} · {data.connections.find((c: Json) => c.id === a.connection_id)?.env ?? "?"}</option>)}
      </select>
      <Chip ok={data.product.worker.alive} label={`worker ${data.product.worker.alive ? "live" : "down"}`} />
      <Chip ok={snap?.health?.broker === "ok"} warn={snap?.health?.broker === "unknown"} label={`broker ${snap?.health?.broker ?? "—"}`} />
      <Chip ok={snap?.health?.data === "ok"} warn={snap?.health?.data === "unknown"} label={`data ${snap?.health?.data ?? "—"}`} />
      <Chip ok={!!session} warn={!session} label={session ? `session ${ago(session.expires_at) === "0s" ? "expiring" : "active · " + remaining(session.expires_at)}` : "no session"} />
    </div>}>
      {/* Top row: regime + quote + risk */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Regime" value={(snap?.regime?.regime ?? "—").replace(/_/g, " ")} sub={snap?.regime?.pending ? `pending ${snap.regime.pending.replace(/_/g, " ")}` : snap?.regime?.since ? `since ${new Date(snap.regime.since).toISOString().slice(11, 16)} UTC` : ""} />
        <Stat label="Broker quote" value={snap?.quote ? `${fmt(snap.quote.bid)} / ${fmt(snap.quote.ask)}` : "—"} sub={snap?.quote ? `spread ${fmt(snap.quote.spread)} · age ${(snap.quote.ageMs / 1000).toFixed(1)}s · source: broker` : "no broker quote"} />
        <Stat label="Risk per trade" value={snap?.account?.riskDollars != null ? `$${fmt(snap.account.riskDollars)}` : "—"} sub={`${((acct?.risk_fraction ?? 0.005) * 100).toFixed(2)}% of $${fmt(snap?.account?.equity ?? acct?.equity)} ${acct?.currency ?? ""}`} />
        <Stat label="Process" value={String(snap?.state ?? "—").replace(/_/g, " ")} sub={snap?.gate ? (snap.gate.ok ? "entry gates open" : snap.gate.reason) : ""} />
      </div>

      <div className="grid lg:grid-cols-[1fr_360px] gap-4 mt-4">
        <div className="space-y-4">
          <Card title="Live entry map" aside={<span className="text-[11px] text-[#7A7468]">M1 · broker history · last bar {snap?.health?.lastBarT ? ago(snap.health.lastBarT) + " ago" : "—"}</span>}>
            <EntryMap bars={snap?.bars ?? []} title="XAUUSD entry map" ov={{
              range: snap?.features?.range ?? null, compression: snap?.compression ?? null, pivotsHigh: snap?.features?.pivotsHigh ?? [], pivotsLow: snap?.features?.pivotsLow ?? [],
              candidate: snap?.candidate ?? null, position: openPos ? { side: openPos.side, entry: +openPos.entry, stop: +openPos.stop, target: +openPos.target } : null, quote: snap?.quote ?? null,
            }} />
            <div className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-1 mt-3 text-[12px]">
              <KV k="ATR M5" v={fmt(snap?.features?.atrM5)} /><KV k="ATR pct" v={snap?.features?.atrPercentile != null ? `${(snap.features.atrPercentile * 100).toFixed(0)}%` : "—"} />
              <KV k="Efficiency (20×M5)" v={snap?.features?.efficiencyDefined === false ? "undefined" : fmt(snap?.features?.efficiency)} /><KV k="EMA slope (ATR)" v={fmt(snap?.features?.emaSlopeAtr)} />
              <KV k="M5 structure" v={snap?.features?.structure ?? "—"} /><KV k="M15 structure" v={snap?.features?.m15Structure ?? "—"} /><KV k="H1 bias" v={snap?.features?.h1Bias ?? "—"} /><KV k="Overlap" v={fmt(snap?.features?.overlapMean)} />
            </div>
            {snap?.regime?.reasons?.length ? <p className="mt-2 text-[12px] text-[#4A4640]">{snap.regime.reasons.join(" · ")}</p> : null}
          </Card>

          {snap?.candidate && <Card title={`Candidate · ${snap.candidate.family.replace(/_/g, " ")} ${snap.candidate.side}`}>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[12px]">
              <KV k="Trigger" v={snap.candidate.trigger} /><KV k="Stop" v={fmt(snap.candidate.plannedStop)} /><KV k="Target" v={`${fmt(snap.candidate.plannedTarget)} (+$${fmt(snap.candidate.targetUsd)})`} /><KV k="Net R:R" v={fmt(snap.candidate.rewardRiskNet)} />
            </div>
            <ul className="mt-2 text-[12px] text-[#4A4640] list-disc pl-4">{snap.candidate.reasons.map((r: string, i: number) => <li key={i}>{r}</li>)}</ul>
          </Card>}

          <Card title="Why not (rejection funnel)" aside={<span className="text-[11px] text-[#7A7468]">strategy {snap?.strategyVersion ?? "—"}</span>}>
            {snap?.rejections?.length ? <ul className="text-[12px] space-y-1">{dedupe(snap.rejections).map((r: Json, i: number) => <li key={i} className="flex gap-2"><span className="font-mono text-[10px] text-[#7A7468] w-[190px] shrink-0">{r.family ? r.family.replace(/_/g, " ") + " · " : ""}{r.code}</span><span className="text-[#4A4640]">{r.detail}</span></li>)}</ul> : <p className="text-[12px] text-[#7A7468]">No evaluation yet.</p>}
          </Card>

          <Card title="Positions & trade history">
            <PositionsTable rows={data.positions} onReplay={async (id: string) => { const j = await api(`events?accountId=${accountId}&replay=${id}`); if (j.ok) setReplay(j); }} />
          </Card>
        </div>

        <div className="space-y-4">
          <Card title="Decision timeline">
            <ol className="flex flex-wrap gap-1 mb-3">{STATES.map((s, i) => <li key={s} className={`text-[10px] tracking-wide rounded-md px-1.5 py-0.5 border ${i === stateIdx ? "bg-[#0F1A2B] text-[#F7F5F0] border-[#0F1A2B]" : "text-[#7A7468] border-[#E6E1D6]"}`}>{s}</li>)}</ol>
            <ul className="space-y-2 max-h-[520px] overflow-auto pr-1">{(data.events ?? []).map((e: Json) => <li key={e.id} className="text-[12px]"><div className="flex justify-between text-[10px] text-[#7A7468] font-mono"><span>{e.kind}{e.state ? ` · ${e.state}` : ""}</span><span>{new Date(e.at).toISOString().slice(11, 19)}Z</span></div><div className="text-[#0F1A2B]">{e.message}</div></li>)}</ul>
          </Card>

          <SessionPanel data={data} acct={acct} session={session} snap={snap} reload={load} />
          <Card title="Account & risk limits">
            <div className="text-[12px] space-y-1">
              <KV k="Equity" v={`$${fmt(snap?.account?.equity ?? acct?.equity)} ${acct?.currency ?? ""}`} /><KV k="Available funds" v={`$${fmt(snap?.account?.availableFunds)}`} />
              <KV k="Instrument" v={snap?.spec ? `${snap.spec.name} · tick ${snap.spec.tickSize} · step ${snap.spec.lotStep} · min ${snap.spec.minLot} · contract ${snap.spec.contractSize ?? "n/a"}` : acct?.spec_missing?.length ? `missing ${acct.spec_missing.join(", ")}` : "discovering…"} />
              <KV k="Daily / weekly / DD limits" v="2% / 5% / 8% of equity (realized AURIC P&L)" />
              <KV k="Today realized" v={snap?.risk ? `$${fmt(snap.risk.dayRealized)}` : "—"} /><KV k="Week realized" v={snap?.risk ? `$${fmt(snap.risk.weekRealized)}` : "—"} />
              <KV k="Consecutive losses" v={snap?.risk ? `${snap.risk.consecutiveLosses}${snap.risk.cooldownUntil && snap.risk.cooldownUntil > Date.now() ? ` · cooldown ${remaining(new Date(snap.risk.cooldownUntil).toISOString())}` : ""}` : "—"} />
              {snap?.risk?.latched && <p className="text-[#B4443C]">Latched: {snap.risk.latched.code} — {snap.risk.latched.detail}{snap.risk.latched.needsReview ? " (administrator review required)" : ""}</p>}
              <KV k="Ownership" v={snap?.ownership ? snap.ownership.reason : "checked before each entry"} />
              <KV k="Market" v={snap?.market?.label ?? "—"} />
              <KV k="Reference feed" v={snap?.reference?.price ? `${fmt(snap.reference.price)} (${snap.reference.source}, ${(snap.reference.ageMs / 1000).toFixed(0)}s)` : snap?.reference?.configured === false ? "not configured — divergence check off" : "—"} />
            </div>
          </Card>
          <Card title="Measured latency (ms)">
            <table className="w-full text-[11px] font-mono"><thead><tr className="text-[#7A7468]"><th className="text-left font-normal">stage</th><th>p50</th><th>p95</th><th>p99</th><th>n</th></tr></thead><tbody>
              {Object.entries(snap?.latency ?? {}).map(([k, v]: [string, any]) => <tr key={k}><td>{k}</td>{v.unavailable ? <td colSpan={4} className="text-center text-[#7A7468]">unavailable</td> : <><td className="text-center">{v.p50}</td><td className="text-center">{v.p95}</td><td className="text-center">{v.p99}</td><td className="text-center">{v.n}</td></>}</tr>)}
            </tbody></table>
            <p className="text-[10px] text-[#7A7468] mt-2">Provider quote timestamps are not supplied by TradeLocker /quotes; quote age is measured from local receipt. Fill time is the poll interval at which the position first appeared.</p>
          </Card>
          {data.isAdmin && <AdminPanel data={data} acct={acct} reload={load} />}
        </div>
      </div>
      {replay && <ReplayModal r={replay} onClose={() => setReplay(null)} />}
    </Shell>
  );
}

function remaining(iso: string) { const ms = Date.parse(iso) - Date.now(); if (ms <= 0) return "0m"; const h = Math.floor(ms / 3600_000), m = Math.floor((ms % 3600_000) / 60_000); return h ? `${h}h ${m}m` : `${m}m`; }
function dedupe(rs: Json[]) { const seen = new Set<string>(); return rs.filter((r) => { const k = `${r.family ?? ""}:${r.code}`; if (seen.has(k)) return false; seen.add(k); return true; }); }
const KV = ({ k, v }: { k: string; v: React.ReactNode }) => <div className="flex justify-between gap-3"><span className="text-[#7A7468]">{k}</span><span className="text-right text-[#0F1A2B] break-words">{v}</span></div>;
const Stat = ({ label, value, sub }: { label: string; value: string; sub?: string }) => (<div className="rounded-2xl bg-white/80 border border-[#E6E1D6] p-3"><div className="text-[10px] tracking-[0.22em] uppercase text-[#7A7468]">{label}</div><div className="text-lg font-semibold text-[#0F1A2B] mt-0.5 truncate">{value}</div>{sub && <div className="text-[11px] text-[#4A4640] mt-0.5 line-clamp-2">{sub}</div>}</div>);

function Shell({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  // Rendered inside The Floor (portal layout keeps its top bar and side nav). AURIC keeps its own light,
  // off-white surface regardless of the portal theme, so it reads as a distinct product without leaving the page.
  return (
    <main className="auric-surface rounded-2xl border border-[#E6E1D6] bg-[#F7F5F0] text-[#0F1A2B] px-4 py-5 md:px-6 md:py-6 font-sans" style={{ colorScheme: "light" }}>
      <header className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div><div className="text-[22px] font-semibold tracking-[0.18em] text-[#0F1A2B]">AURIC<span className="text-[#B8860B]">.</span></div><div className="text-[11px] text-[#7A7468] tracking-wide">XAUUSD automation · One Mission · seeks $5–$10 gold-price movements, one position at a time</div></div>
        {right}
      </header>
      {children}
      <footer className="mt-8 text-[10px] text-[#7A7468] leading-relaxed">Prices shown are labelled by source; the broker quote is the only executable price. Credits buy monitoring and automation for a time-limited session, not trades or profit. AURIC has no established track record of profitability; CFD trading carries a high risk of loss and stops are execution instructions, not guarantees. Brokerage P&amp;L is shown net of broker costs and separately from credit costs.</footer>
    </main>
  );
}

function PositionsTable({ rows, onReplay }: { rows: Json[]; onReplay: (id: string) => void }) {
  if (!rows?.length) return <p className="text-[12px] text-[#7A7468]">No AURIC positions on this account yet.</p>;
  const closed = rows.filter((r) => r.status === "closed" && r.realized_pnl != null);
  const net = closed.reduce((s, r) => s + Number(r.realized_pnl), 0);
  return (<div>
    <div className="text-[12px] mb-2 text-[#4A4640]">Brokerage net P&amp;L (closed AURIC trades): <b className={net >= 0 ? "text-[#2E7D5B]" : "text-[#B4443C]"}>{net >= 0 ? "+" : ""}${net.toFixed(2)}</b> · shown separately from credit costs</div>
    <div className="overflow-auto"><table className="w-full text-[11px] font-mono"><thead><tr className="text-[#7A7468] text-left"><th>opened</th><th>side</th><th>qty</th><th>entry</th><th>stop</th><th>target</th><th>family</th><th>status</th><th>P&amp;L</th><th></th></tr></thead><tbody>
      {rows.map((r) => <tr key={r.id} className="border-t border-[#F1EEE6]"><td>{new Date(r.opened_at).toISOString().slice(5, 16).replace("T", " ")}</td><td>{r.side}</td><td>{r.qty}</td><td>{fmt(r.entry)}</td><td>{fmt(r.stop)}</td><td>{fmt(r.target)}</td><td>{String(r.setup_family).replace(/_/g, " ")}</td><td>{r.status}{r.protected ? "" : " · unprotected"}{r.close_reason ? ` · ${r.close_reason}` : ""}</td><td className={Number(r.realized_pnl) >= 0 ? "text-[#2E7D5B]" : "text-[#B4443C]"}>{r.realized_pnl != null ? `${Number(r.realized_pnl) >= 0 ? "+" : ""}${fmt(r.realized_pnl)}` : "—"}</td><td><button className="underline" onClick={() => onReplay(r.id)}>replay</button></td></tr>)}
    </tbody></table></div>
  </div>);
}

function ReplayModal({ r, onClose }: { r: Json; onClose: () => void }) {
  return (<div className="fixed inset-0 bg-[#0F1A2B]/40 grid place-items-center p-4 z-50" onClick={onClose}><div className="bg-[#F7F5F0] rounded-2xl max-w-2xl w-full max-h-[85vh] overflow-auto p-5" onClick={(e) => e.stopPropagation()}>
    <div className="flex justify-between items-center mb-2"><h3 className="text-sm font-semibold">Trade replay — {r.position.side} {r.position.qty} @ {fmt(r.position.entry)}</h3><Btn onClick={onClose}>close</Btn></div>
    <p className="text-[11px] text-[#7A7468] mb-3">{r.note}</p>
    {r.intent?.candidate && <div className="text-[12px] mb-3 rounded-xl bg-white p-3 border border-[#E6E1D6]"><b>Known at decision time:</b> {r.intent.candidate.family} · regime {r.intent.candidate.regime} · trigger: {r.intent.candidate.trigger} · stop {fmt(r.intent.candidate.plannedStop)} · target {fmt(r.intent.candidate.plannedTarget)} · net R:R {fmt(r.intent.candidate.rewardRiskNet)} · sizing: {r.intent.sizing?.explanation ?? "—"} · ack {r.intent.ack_latency_ms ?? "—"} ms · fill {fmt(r.intent.fill_price)}</div>}
    <ul className="space-y-2">{r.events.map((e: Json) => <li key={e.id} className="text-[12px]"><span className="font-mono text-[10px] text-[#7A7468]">{new Date(e.at).toISOString().slice(11, 19)}Z · {e.kind}{e.state ? ` · ${e.state}` : ""}</span><div>{e.message}</div></li>)}</ul>
  </div></div>);
}

function SessionPanel({ data, acct, session, snap, reload }: { data: Json; acct: Json | null; session: Json | null; snap: Json | null; reload: () => Promise<void> }) {
  const [quote, setQuote] = useState<Json | null>(null); const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<string | null>(null);
  const [consentOpen, setConsentOpen] = useState(false); const [consent, setConsent] = useState<Json | null>(null); const [name, setName] = useState(""); const [rf, setRf] = useState(String(((acct?.risk_fraction ?? 0.005) * 100).toFixed(2))); const [allowShared, setAllowShared] = useState(false); const [autoRenew, setAutoRenew] = useState(false);
  const keyRef = useRef<string>(uuid());
  const act = async (action: string, extra: Json = {}) => { setBusy(true); const j = await api("control", { accountId: acct?.id, action, ...extra }); setBusy(false); setMsg(j.ok ? null : `${j.error}${j.detail ? `: ${j.detail}` : ""}`); await reload(); };
  const getQuote = async () => { setBusy(true); const j = await api(`activate?accountId=${acct?.id}`); setBusy(false); setQuote(j); keyRef.current = uuid(); };
  const activate = async () => { setBusy(true); const j = await api("activate", { accountId: acct?.id, key: keyRef.current, confirm: true, autoRenew }); setBusy(false); if (!j.ok) setMsg(`${j.error}${j.detail?.detail ? `: ${j.detail.detail}` : ""}`); else { setMsg(null); setQuote(null); } await reload(); };
  const openConsent = async () => { const j = await api("consent"); setConsent(j); setConsentOpen(true); };
  const sign = async () => { setBusy(true); const j = await api("consent", { accountId: acct?.id, acknowledged: true, signedName: name, riskFraction: Number(rf) / 100, allowShared }); setBusy(false); if (!j.ok) setMsg(j.error); else { setConsentOpen(false); setMsg(null); } await reload(); };
  const wallet = data.wallet; const balance = wallet ? (wallet.daily_left ?? 0) + (wallet.purchased ?? 0) : null;
  return (<Card title="Credit session" aside={<span className="text-[11px] text-[#7A7468]">balance {balance ?? "—"} credits</span>}>
    {msg && <p className="text-[12px] text-[#B4443C] mb-2">{msg}</p>}
    {!acct?.consent_at ? <div className="text-[12px] space-y-2"><p>This account has not consented to AURIC. Consent is per account and separate from any FLOW or GENX setting.</p><Btn kind="gold" onClick={openConsent}>Review & consent</Btn></div>
    : session ? <div className="text-[12px] space-y-2">
        <KV k="Expires" v={`${new Date(session.expires_at).toISOString().replace("T", " ").slice(0, 16)} UTC (${remaining(session.expires_at)})`} /><KV k="Charged" v={`${session.credits_charged} credits`} /><KV k="Auto-renew" v={session.auto_renew ? `ON at ${session.auto_renew_price} credits` : "off"} /><KV k="Entries" v={session.paused_entries ? `paused — ${session.pause_reason}` : "enabled"} />
        <div className="flex flex-wrap gap-2 pt-1">
          {session.paused_entries ? <Btn onClick={() => act("resume_entries")} disabled={busy}>Resume entries</Btn> : <Btn onClick={() => act("pause_entries")} disabled={busy}>Pause new entries</Btn>}
          <Btn kind="danger" onClick={() => { if (confirm("Close every AURIC-owned position on this account? Other trades on the account are never touched.")) act("close_auric"); }} disabled={busy}>Close AURIC positions</Btn>
          {session.auto_renew ? <Btn onClick={() => act("auto_renew_off")} disabled={busy}>Disable auto-renew</Btn> : data.product.priceConfigured && <Btn onClick={() => { if (confirm(`Enable auto-renew at ${data.product.price} credits per ${data.product.sessionHours}-hour session? It stops automatically if the price changes or credits run out.`)) act("auto_renew_on", { price: data.product.price }); }} disabled={busy}>Enable auto-renew</Btn>}
        </div>
        <p className="text-[10px] text-[#7A7468]">Pausing stops new entries only. Closing sends close orders for AURIC positions only; closure is confirmed once the broker reports it.</p>
      </div>
    : <div className="text-[12px] space-y-2">
        <p>{data.product.priceConfigured ? `One ${data.product.sessionHours}-hour session on this account costs ${data.product.price} credits. Viewing this page never charges.` : "The administrator has not set a session price yet — activation is unavailable."}</p>
        {snap?.session?.pauseReason && <p className="text-[#7A7468]">Last session: {snap.session.pauseReason}</p>}
        {!quote ? <Btn kind="gold" onClick={getQuote} disabled={busy || !data.product.priceConfigured}>Review activation</Btn>
        : <div className="rounded-xl bg-white border border-[#E6E1D6] p-3 space-y-2">
            <p className="font-medium">{quote.scope}</p>
            <ul className="space-y-0.5">{(quote.checks ?? []).map((ch: Json) => <li key={ch.name} className="flex gap-2"><Chip ok={ch.ok} warn={ch.name === "live" || ch.name === "instrument"} label={ch.name} /><span className="text-[#4A4640]">{ch.detail}</span></li>)}</ul>
            <label className="flex items-center gap-2"><input type="checkbox" checked={autoRenew} onChange={(e) => setAutoRenew(e.target.checked)} /> Auto-renew at {quote.price} credits per session (optional, can be disabled any time)</label>
            <div className="flex gap-2"><Btn kind="gold" onClick={activate} disabled={busy || (quote.blocking?.length ?? 1) > 0}>Confirm — charge {quote.price} credits</Btn><Btn onClick={() => setQuote(null)}>Cancel</Btn></div>
            <p className="text-[10px] text-[#7A7468]">Charging and entitlement are one atomic step; a retry or second tab cannot charge twice. A session may produce no qualifying trades.</p>
          </div>}
        <div className="pt-1"><Btn onClick={() => { const v = prompt("Risk per trade, % of equity (0.25–1.0)", rf); if (v) act("set_risk", { riskFraction: Number(v) / 100 }); }} disabled={busy}>Risk: {((acct?.risk_fraction ?? 0.005) * 100).toFixed(2)}%</Btn></div>
      </div>}
    {consentOpen && consent && <div className="fixed inset-0 bg-[#0F1A2B]/40 grid place-items-center p-4 z-50"><div className="bg-[#F7F5F0] rounded-2xl max-w-xl w-full max-h-[85vh] overflow-auto p-5 space-y-3 text-[12px]">
      <h3 className="text-sm font-semibold">AURIC consent — {consent.version}</h3><p className="whitespace-pre-wrap text-[#4A4640]">{consent.text}</p>
      <label className="block">Risk per trade (% of equity, 0.25–1.0) <input className="ml-2 border rounded px-2 py-1 w-20" value={rf} onChange={(e) => setRf(e.target.value)} /></label>
      <label className="flex gap-2 items-start"><input type="checkbox" checked={allowShared} onChange={(e) => setAllowShared(e.target.checked)} /><span>I understand this broker account may also be traded by another One Mission product and I explicitly allow AURIC on a shared account (not recommended; netting accounts can merge positions). Leave unchecked for a dedicated account.</span></label>
      <label className="block">Type your full name to sign <input className="ml-2 border rounded px-2 py-1" value={name} onChange={(e) => setName(e.target.value)} /></label>
      <div className="flex gap-2"><Btn kind="gold" onClick={sign} disabled={busy || !name.trim()}>I consent</Btn><Btn onClick={() => setConsentOpen(false)}>Cancel</Btn></div>
    </div></div>}
  </Card>);
}

function AdminPanel({ data, acct, reload }: { data: Json; acct: Json | null; reload: () => Promise<void> }) {
  const [busy, setBusy] = useState(false); const [price, setPrice] = useState(String(data.product.price ?? ""));
  const run = async (body: Json) => { setBusy(true); await api("admin", body); setBusy(false); await reload(); };
  return (<Card title="Administrator">
    <div className="text-[12px] space-y-2">
      <div className="flex gap-2 items-center"><span className="text-[#7A7468] w-32">Daily price</span><input className="border rounded px-2 py-1 w-24" value={price} onChange={(e) => setPrice(e.target.value)} /><Btn onClick={() => run({ action: "set_price", credits: price === "" ? null : Number(price) })} disabled={busy}>Save</Btn></div>
      <div className="flex gap-2 items-center"><span className="text-[#7A7468] w-32">Engine</span><Btn onClick={() => run({ action: "engine", enabled: !data.product.engineEnabled })} disabled={busy}>{data.product.engineEnabled ? "ON → switch off" : "OFF → switch on"}</Btn></div>
      <div className="flex gap-2 items-center"><span className="text-[#7A7468] w-32">Live orders (global)</span><Btn onClick={() => run({ action: "live_orders", enabled: !data.product.liveOrdersEnabled })} disabled={busy}>{data.product.liveOrdersEnabled ? "ON → switch off" : "OFF → switch on"}</Btn></div>
      {acct && <div className="flex gap-2 items-center"><span className="text-[#7A7468] w-32">This account live</span><Btn onClick={() => run({ action: "authorize_live", accountId: acct.id, enabled: !acct.live_authorized_at })} disabled={busy}>{acct.live_authorized_at ? "authorized → withdraw" : "authorize live orders"}</Btn></div>}
      {acct && <div className="flex gap-2 items-center"><span className="text-[#7A7468] w-32">Drawdown latch</span><Btn onClick={() => run({ action: "review_drawdown", accountId: acct.id })} disabled={busy}>clear after review</Btn></div>}
    </div>
  </Card>);
}

function Onboarding({ onDone }: { onDone: () => Promise<void> }) {
  const [flow, setFlow] = useState<Json[]>([]); const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<string | null>(null);
  const [env, setEnv] = useState("demo"); const [server, setServer] = useState(""); const [email, setEmail] = useState(""); const [password, setPassword] = useState("");
  useEffect(() => { api("connect").then((j) => setFlow(j.flowConnections ?? [])); }, []);
  const go = async (body: Json) => { setBusy(true); const j = await api("connect", body); setBusy(false); if (!j.ok) setMsg(`${j.error}${j.detail ? `: ${j.detail}` : ""}`); else await onDone(); };
  return (<div className="grid md:grid-cols-2 gap-4">
    <Card title="Link a broker account to AURIC">
      <p className="text-[12px] text-[#4A4640] mb-3">AURIC keeps its own broker login and its own tokens. Linking never trades: each account needs separate consent and an activated session first. A dedicated account or sub-account is recommended so equity and positions are not shared with other tools.</p>
      {msg && <p className="text-[12px] text-[#B4443C] mb-2">{msg}</p>}
      <div className="space-y-2 text-[12px]">
        <select className="border rounded px-2 py-1 w-full" value={env} onChange={(e) => setEnv(e.target.value)}><option value="demo">Demo (demo.tradelocker.com)</option><option value="live">Live (live.tradelocker.com)</option></select>
        <input className="border rounded px-2 py-1 w-full" placeholder="Server (as shown on the TradeLocker login)" value={server} onChange={(e) => setServer(e.target.value)} />
        <input className="border rounded px-2 py-1 w-full" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input className="border rounded px-2 py-1 w-full" placeholder="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <Btn kind="gold" onClick={() => go({ mode: "credentials", env, server, email, password })} disabled={busy}>Connect</Btn>
      </div>
    </Card>
    {flow.length > 0 && <Card title="Or import an existing FLOW connection">
      <p className="text-[12px] text-[#4A4640] mb-3">Copies the login you already stored for FLOW into AURIC's own vault (AURIC then signs in separately). FLOW itself is not changed. If FLOW or GENX trades this account, AURIC will treat it as shared and refuse activation unless you explicitly allow it.</p>
      <ul className="space-y-2 text-[12px]">{flow.map((f) => <li key={f.id} className="flex justify-between items-center gap-2"><span>{f.email} · {f.server} · {f.env}</span><Btn onClick={() => go({ mode: "import", flowConnectionId: f.id })} disabled={busy || !f.importable}>Import</Btn></li>)}</ul>
    </Card>}
  </div>);
}
