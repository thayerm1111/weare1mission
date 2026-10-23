"use client";

import { useState } from "react";
import { C, money, post, type StatusPayload } from "./theme";
import { Btn, Card } from "./ui";

/** Record what the broker actually reported or paid (statement import or manual) — never estimated as fact. */
export function CompensationPanel({ data, reload }: { data: StatusPayload; reload: () => Promise<void> }) {
  const [kind, setKind] = useState("paid");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState("");
  const [lots, setLots] = useState("");
  const [reference, setReference] = useState("");
  const [inAccount, setInAccount] = useState(false);
  const [csv, setCsv] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const ccy = data.control.account_currency ?? "USD";

  const add = async (payload: Record<string, unknown>) => {
    setBusy(true);
    const r = await post("/api/fx-scalper/payouts", payload);
    setBusy(false);
    const errs = Array.isArray(r.data.errors) ? `: ${(r.data.errors as string[]).join("; ")}` : "";
    setMsg({ ok: r.ok, text: r.ok ? `Recorded ${r.data.count} entr${Number(r.data.count) === 1 ? "y" : "ies"}.` : `${String(r.data.error ?? "Refused")}${errs}` });
    if (r.ok) { setAmount(""); setReference(""); setLots(""); setCsv(""); }
    await reload();
  };

  return (
    <Card title="Compensation ledger (Genesis statements)">
      <div className="grid gap-3 sm:grid-cols-6">
        <label className="block text-sm"><span>Kind</span>
          <select value={kind} onChange={(e) => setKind(e.target.value)} className="mt-1 w-full rounded-lg border px-2 py-1.5" style={{ borderColor: C.line }}>
            <option value="confirmed">confirmed by broker</option><option value="paid">paid</option><option value="reversal">reversal</option>
          </select>
        </label>
        <label className="block text-sm"><span>Amount ({ccy})</span><input value={amount} onChange={(e) => setAmount(e.target.value)} className="mt-1 w-full rounded-lg border px-2 py-1.5" style={{ borderColor: C.line }} /></label>
        <label className="block text-sm"><span>Date</span><input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="mt-1 w-full rounded-lg border px-2 py-1.5" style={{ borderColor: C.line }} /></label>
        <label className="block text-sm"><span>Lots (optional)</span><input value={lots} onChange={(e) => setLots(e.target.value)} className="mt-1 w-full rounded-lg border px-2 py-1.5" style={{ borderColor: C.line }} /></label>
        <label className="block text-sm"><span>Reference</span><input value={reference} onChange={(e) => setReference(e.target.value)} className="mt-1 w-full rounded-lg border px-2 py-1.5" style={{ borderColor: C.line }} /></label>
        <label className="flex items-end gap-2 pb-2 text-sm"><input type="checkbox" checked={inAccount} onChange={(e) => setInAccount(e.target.checked)} /> paid into this account</label>
      </div>
      <div className="mt-3"><Btn kind="primary" disabled={busy || !amount} onClick={() => void add({ kind, amount: Number(amount), currency: ccy, periodStart: date || null, lots: lots || null, reference, paidIntoAccount: inAccount })}>Record entry</Btn></div>
      <details className="mt-4">
        <summary className="cursor-pointer text-sm" style={{ color: C.blue }}>Import from a statement (CSV)</summary>
        <p className="mt-2 text-xs" style={{ color: C.muted }}>One line per entry: <code>date,kind,amount,currency,lots,reference,paid_into_account</code> — e.g. <code>2026-10-31,paid,125.40,USD,62.7,Statement Oct,false</code></p>
        <textarea value={csv} onChange={(e) => setCsv(e.target.value)} rows={5} className="mt-2 w-full rounded-lg border px-3 py-2 font-mono text-xs" style={{ borderColor: C.line }} />
        <div className="mt-2"><Btn disabled={busy || !csv.trim()} onClick={() => void add({ csv })}>Import</Btn></div>
      </details>
      {msg && <p className="mt-2 text-sm" style={{ color: msg.ok ? C.green : C.red }}>{msg.text}</p>}
      {data.compensation.rows.length > 0 && (
        <table className="mt-4 w-full text-sm">
          <tbody>
            {data.compensation.rows.map((r) => (
              <tr key={String(r.id)} className="border-t" style={{ borderColor: C.line }}>
                <td className="py-1.5 pr-3 text-xs" style={{ color: C.muted }}>{String(r.period_start ?? String(r.created_at).slice(0, 10))}</td>
                <td className="pr-3">{String(r.kind)}</td>
                <td className="pr-3 tabular-nums" style={{ color: r.kind === "reversal" ? C.red : C.ink }}>{money(Number(r.amount), String(r.currency ?? ""))}</td>
                <td className="pr-3 text-xs">{r.lots != null ? `${r.lots} lots` : ""}</td>
                <td className="pr-3 text-xs" style={{ color: C.muted }}>{String(r.reference ?? "")}{r.paid_into_account ? " · in account (excluded from risk capital)" : ""} · {String(r.source).replace("_", " ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
