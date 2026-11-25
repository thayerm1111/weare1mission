"use client";

import Link from "next/link";
import { Activity, Link2 } from "lucide-react";
import { ProductIcon } from "../ProductIcon";
import { useNitrousStatus } from "./useNitrousStatus";
import { accountIsActive, modeName, money, shownPnl, shownPnlLabel, STATUS_VISIBLE_FRESH_MS } from "./presentation";
import "./nitrous.css";

/** The home screen only glows while this member's actual execution state is fresh and active. */
export function NitrousAccountSummary() {
  const { data, loading, error, receivedAt, now } = useNitrousStatus();
  const account = data?.accounts.find(a => accountIsActive(data, a, receivedAt, now, error)) ?? data?.accounts[0] ?? null;
  const active = accountIsActive(data, account, receivedAt, now, error);
  const stale = !!error || !receivedAt || now - receivedAt > STATUS_VISIBLE_FRESH_MS;
  if (!account) return <Link href="/portal/nitrous" className="nitrous-summary nitrous-summary-compact" data-nitrous-active="false">
    <ProductIcon kind="nitrous" size="sm" /><span><strong>Nitrous</strong><small>{loading ? "Checking your accounts…" : error ? "Open account status" : "Slow Drip or Nitrous · connect TradeLocker"}</small></span><Link2 size={17} aria-hidden="true" />
  </Link>;
  const currency = account.currency ?? "USD";
  return <section className="nitrous-summary" data-nitrous-active={active} aria-label="Nitrous account">
    <div className="nitrous-summary-identity"><ProductIcon kind="nitrous" size="md" /><div><strong>{modeName(account.mode)}</strong>
      <span className="nitrous-status" data-active={active}><i />{active ? "AUTO ACTIVE" : stale ? "STATUS UNAVAILABLE" : account.automationEnabled ? "AUTO WAITING" : "CONNECTED"}</span></div></div>
    <div className="nitrous-summary-numbers"><div><small>{stale ? "Last balance" : "Balance"} · {account.environment}</small><strong>{money(account.balance, currency)}</strong></div>
      <div><small>Recorded wins</small><strong>{account.stats.wins}<span> / {account.stats.closed - account.stats.unresolved} graded</span></strong></div>
      <div><small>{shownPnlLabel(account)}</small><strong data-result={shownPnl(account) == null ? "unknown" : Number(shownPnl(account)) >= 0 ? "positive" : "negative"}>{money(shownPnl(account), currency)}</strong></div></div>
    <Link href="/portal/nitrous" className="nitrous-text-link"><Activity size={15} aria-hidden="true" />Manage account</Link>
  </section>;
}
