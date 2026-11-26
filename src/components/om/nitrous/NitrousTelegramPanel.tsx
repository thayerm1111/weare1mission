"use client";

import { useState, type FormEvent } from "react";
import { ArrowUpRight, CheckCircle2, ChevronDown, Loader2, Send, Settings2 } from "lucide-react";
import type { NitrousTelegramPublicState } from "@/lib/nitrous-telegram-store";
import "./nitrous-telegram.css";

type ChannelState = Partial<NitrousTelegramPublicState>;
type AdminSettings = ChannelState & {
  channelId?: string; channelUrl?: string | null; enabled?: boolean; tokenConfigured?: boolean;
  botUsername?: string | null; lastError?: string | null;
};

function channelUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "t.me" && !url.username && !url.password && !url.port ? url.href : null;
  } catch { return null; }
}

export function NitrousTelegramPanel({ admin = false, telegram }: { admin?: boolean; telegram?: ChannelState }) {
  const [expanded, setExpanded] = useState(false);
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [chatId, setChatId] = useState("");
  const [joinUrl, setJoinUrl] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const state = settings ?? telegram;
  const link = state?.status === "ready" && state.configured ? channelUrl(state.url) : null;
  const receipt = (settings && settings.lastVerifiedAt !== telegram?.lastVerifiedAt ? settings.latestAlert : telegram?.latestAlert) ?? state?.latestAlert;
  const post = state?.status === "ready" && state.configured ? channelUrl(receipt?.url) : null;
  const label = state?.status === "ready" ? "Channel verified" : state?.status === "paused" ? "Alerts paused" : state?.status === "error" ? "Channel needs attention" : "Channel setup pending";

  async function openSettings() {
    setExpanded((value) => !value);
    if (expanded || settings || busy) return;
    setBusy(true); setError(null);
    try {
      const response = await fetch("/api/admin/nitrous-telegram", { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.detail || "Channel settings could not be loaded.");
      setSettings(body); setChatId(body.channelId || ""); setJoinUrl(body.channelUrl || "");
      setEnabled(body.configured ? body.enabled === true : true);
    } catch (err) { setError(err instanceof Error ? err.message : "Channel settings could not be loaded."); }
    finally { setBusy(false); }
  }

  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(null); setNotice(null);
    try {
      const response = await fetch("/api/admin/nitrous-telegram", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "save", channelId: chatId, channelUrl: joinUrl || null, enabled }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.detail || "The channel could not be verified.");
      setSettings(body); setChatId(body.channelId); setJoinUrl(body.channelUrl || "");
      setNotice(enabled ? "Channel verified. New setup alerts are enabled." : "Channel verified. Alerts remain paused.");
    } catch (err) { setError(err instanceof Error ? err.message : "The channel could not be saved."); }
    finally { setBusy(false); }
  }

  async function sendTest() {
    setBusy(true); setError(null); setNotice(null);
    try {
      const response = await fetch("/api/admin/nitrous-telegram", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "test" }),
      });
      const body = await response.json();
      if (!response.ok || typeof body.id !== "string") throw new Error(body.detail || "The test could not be queued.");
      setNotice("Test queued. Checking Telegram delivery…");
      for (let i = 0; i < 12; i++) {
        await new Promise<void>((resolve) => setTimeout(resolve, 2500));
        const check = await fetch(`/api/admin/nitrous-telegram?testId=${encodeURIComponent(body.id)}`, { cache: "no-store" });
        if (!check.ok) continue;
        const result = await check.json();
        if (result.state === "sent") { setNotice("Test delivered to your Telegram channel."); return; }
        if (result.state === "refused" || result.state === "unknown") {
          setNotice(null); throw new Error(result.state === "unknown" ? "Delivery is uncertain. Check Telegram before sending again." : "Telegram refused the test. Verify the channel and bot permissions.");
        }
      }
      setNotice("Test still pending. Check Telegram before sending another test.");
    } catch (err) { setError(err instanceof Error ? err.message : "Unable to send test."); }
    finally { setBusy(false); }
  }

  async function pause() {
    setBusy(true); setError(null); setNotice(null);
    try {
      const response = await fetch("/api/admin/nitrous-telegram", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "pause" }),
      });
      if (!response.ok) throw new Error("Alerts could not be paused. Try again.");
      setSettings((previous) => ({ ...previous, status: "paused", enabled: false, url: null }));
      setEnabled(false); setNotice("Telegram alerts paused.");
    } catch (err) { setError(err instanceof Error ? err.message : "Alerts could not be paused."); }
    finally { setBusy(false); }
  }

  return <section className="nitrous-telegram" aria-label="Nitrous Telegram channel">
    <div className="nitrous-telegram-heading">
      <span className="nitrous-telegram-icon"><Send size={20} aria-hidden="true" /></span>
      <div><h2>Nitrous Telegram</h2><p>{state?.status === "ready" && state.title ? state.title : label}</p></div>
      {state?.status === "ready" && <CheckCircle2 size={17} aria-label="Verified channel" />}
    </div>
    <p className="nitrous-telegram-description">Alerts appear when a gold setup opens or changes.</p>
    {post && receipt && <a className="nitrous-telegram-receipt" href={post} target="_blank" rel="noopener noreferrer">
      <span>Open latest alert<time dateTime={receipt.sentAt}>{new Date(receipt.sentAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time></span>
      <ArrowUpRight size={17} aria-hidden="true"/>
    </a>}
    {link
      ? <a className="nitrous-telegram-join" href={link} target="_blank" rel="noopener noreferrer">Join Telegram</a>
      : <p className="nitrous-telegram-pending">{state?.status === "paused" ? "Alerts are paused." : state?.status === "ready" ? "Ask the channel admin for an invite." : "The channel link will appear here when setup is complete."}</p>}
    {admin && <>
      <button className="nitrous-telegram-settings-toggle" type="button" onClick={() => void openSettings()} aria-expanded={expanded} aria-controls="nitrous-telegram-settings">
        <Settings2 size={15} aria-hidden="true" /><span>Channel settings</span><ChevronDown size={15} aria-hidden="true" />
      </button>
      {expanded && <div id="nitrous-telegram-settings" className="nitrous-telegram-settings">
        <p>Create <strong>One Mission · Nitrous</strong> in Telegram. Add {settings?.botUsername ? <strong>@{settings.botUsername}</strong> : "the platform bot"} as an administrator with <strong>Post Messages</strong> enabled.</p>
        {settings?.tokenConfigured === false && <p className="nitrous-telegram-error" role="alert">A Telegram bot must be configured on the server before the channel can be connected.</p>}
        <form onSubmit={(event) => void save(event)}>
          <label>Channel username or ID<input value={chatId} onChange={(event) => setChatId(event.target.value)} placeholder="@your_channel" required maxLength={40} autoComplete="off" spellCheck={false} /></label>
          <label>Private invite link <span>(optional)</span><input type="url" value={joinUrl} onChange={(event) => setJoinUrl(event.target.value)} placeholder="https://t.me/+…" maxLength={180} autoComplete="off" spellCheck={false} /></label>
          <label className="nitrous-telegram-checkbox"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /><span>Publish new setup alerts to this channel</span></label>
          <div className="nitrous-telegram-actions">
            <button type="submit" disabled={busy || !chatId.trim() || settings?.tokenConfigured === false}>{busy ? <Loader2 size={15} className="nitrous-telegram-spin" aria-hidden="true" /> : <CheckCircle2 size={15} aria-hidden="true" />}Verify and save</button>
            {settings?.enabled && <button type="button" disabled={busy || settings.status !== "ready"} onClick={() => void sendTest()}><Send size={15} aria-hidden="true" />Send test message</button>}
            {settings?.enabled && <button type="button" disabled={busy} onClick={() => void pause()}>Pause alerts</button>}
          </div>
        </form>
        <p className="nitrous-telegram-note">Verification checks channel access without posting. Send test message sends a labeled connection test. Customer balances and account details stay private.</p>
      </div>}
    </>}
    {error && <p className="nitrous-telegram-error" role="alert">{error}</p>}
    {notice && <p className="nitrous-telegram-notice" role="status">{notice}</p>}
  </section>;
}
