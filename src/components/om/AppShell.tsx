"use client";

import "./om.css";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Activity, CreditCard, Globe, LayoutGrid, LifeBuoy, Link2, LogOut, ShieldCheck, Sparkles, Undo2, User, UserCircle, Wrench, Zap } from "lucide-react";
import { NotificationsBell } from "@/components/portal/NotificationsBell";
import { NAV, TAB_ORDER, TOOLS_SHEET, activeKey, type NavKey } from "@/lib/floor/nav";
import { ShellContext } from "./shell";

/**
 * ONE SHELL FOR THE TRADING PLATFORM (owner 11-20).
 *
 * A floating bar across the top — OM / One Mission, the six destinations, credits and the profile — and,
 * on a phone, the same destinations under the thumb (Floor, Plays, Atlas, FLOW, Tools). There is no
 * sidebar and no community destination: what is left beside the six is the short list a customer needs
 * to run their account (profile, credits and billing, notifications, support, sign out).
 *
 * The destinations and which one is lit are decided in src/lib/floor/nav.ts, so the bar and the phone
 * tabs can never disagree. Atlas opens the Command Center as a full page load: that screen brings its own
 * full-bleed frame and first-open introduction, and both are left exactly as they are.
 *
 * It hides the public site's header and footer for as long as it is mounted, and puts them back when it
 * goes — the same html-class approach the Command Center uses, without a reload.
 */
export type ShellMember = { name: string | null; email: string | null; admin: boolean };

function OmMark() {
  return (
    <svg viewBox="0 0 58 28" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="14" r="9.6" />
      <path d="M22.5 24 30.5 5.2c.5-1.2 2.2-1.2 2.7 0l5 12.3c.5 1.2 2.2 1.2 2.7 0l5-12.3c.5-1.2 2.2-1.2 2.7 0L56.8 24" />
    </svg>
  );
}

const TAB_ICON: Record<NavKey | "tools", typeof Zap> = { floor: LayoutGrid, plays: Zap, atlas: Sparkles, flow: Link2, genx: Activity, pulse: Activity, tools: Wrench };

function Credits() {
  const [total, setTotal] = useState<number | null>(null);
  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/credits", { cache: "no-store" });
      if (!r.ok) return;
      const d = await r.json();
      if (d?.balance) setTotal((d.balance.dailyLeft || 0) + (d.balance.purchased || 0));
    } catch { /* the pill keeps its dash; nothing is guessed */ }
  }, []);
  useEffect(() => {
    void load();
    const h = () => void load();
    window.addEventListener("credits-updated", h);
    return () => window.removeEventListener("credits-updated", h);
  }, [load]);
  return (
    <Link href="/portal/credits" className="om-credits om-num" title="Your credits">
      <b>{total == null ? "—" : total.toLocaleString("en-US")}</b><span className="om-credits-word">credits</span>
    </Link>
  );
}

function ProfileMenu({ member, configured, preview }: { member: ShellMember; configured: boolean; preview: boolean }) {
  const [open, setOpen] = useState(false);
  const [lang, setLang] = useState<"en" | "es">("en");
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    try { setLang(localStorage.getItem("om-lang") === "es" ? "es" : "en"); } catch { /* English */ }
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);
  return (
    <div ref={box} style={{ position: "relative" }}>
      <button type="button" className="om-avatar" aria-label="Your account" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <User width={19} height={19} aria-hidden="true" />
      </button>
      {open && (
        <div className="om-menu" role="menu">
          {(member.name || member.email) && (
            <div className="om-menu-head">
              {member.name && <p style={{ fontSize: 15 }}>{member.name}</p>}
              {member.email && <p className="om-dim" style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis" }}>{member.email}</p>}
            </div>
          )}
          <Link role="menuitem" href="/portal/account" onClick={() => setOpen(false)}><UserCircle aria-hidden="true" />Account and settings</Link>
          <Link role="menuitem" href="/portal/credits" onClick={() => setOpen(false)}><CreditCard aria-hidden="true" />Credits and billing</Link>
          <Link role="menuitem" href="/portal/support" onClick={() => setOpen(false)}><LifeBuoy aria-hidden="true" />Support</Link>
          {/* The site's own language switch (I18nProvider), asked for from here instead of a floating button. */}
          <button type="button" role="menuitem" data-no-i18n translate="no" onClick={() => { window.dispatchEvent(new Event("om-lang-toggle")); setOpen(false); }}><Globe aria-hidden="true" />{lang === "es" ? "English" : "Español"}</button>
          {member.admin && <><hr /><a role="menuitem" href="/admin/controls"><ShieldCheck aria-hidden="true" />Admin workspace</a></>}
          {preview && <a role="menuitem" href="/api/floor/preview?on=0"><Undo2 aria-hidden="true" />Leave the preview</a>}
          {configured && (
            <>
              <hr />
              <form action="/auth/signout" method="post"><button type="submit" role="menuitem"><LogOut aria-hidden="true" />Sign out</button></form>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Bar({ member, configured, preview }: { member: ShellMember; configured: boolean; preview: boolean }) {
  const path = usePathname() || "";
  const view = useSearchParams().get("view");
  const here = activeKey(path, view);
  const [sheet, setSheet] = useState(false);
  useEffect(() => { setSheet(false); }, [path, view]);

  return (
    <>
      <div className="om-nav-wrap">
        <div className="om-frame">
          <nav className="om-nav" aria-label="Trading platform">
            <Link href="/portal/trading" className="om-brand" aria-label="One Mission — The Floor"><OmMark /><span>One Mission</span></Link>
            <div className="om-links">
              {NAV.map((n) => n.hard
                ? <a key={n.key} href={n.href} className="om-link" aria-current={here === n.key ? "page" : undefined}>{n.label}</a>
                : <Link key={n.key} href={n.href} className="om-link" aria-current={here === n.key ? "page" : undefined}>{n.label}</Link>)}
            </div>
            <div className="om-nav-right">
              {configured && <Credits />}
              {configured && <span className="om-bell"><NotificationsBell trading /></span>}
              <ProfileMenu member={member} configured={configured} preview={preview} />
            </div>
          </nav>
        </div>
      </div>

      {/* phone: the same destinations, under the thumb */}
      {sheet && (
        <div className="om-sheet" role="menu" aria-label="Tools">
          {TOOLS_SHEET.map((t) => <Link key={t.key} role="menuitem" href={t.href}>{t.label}<span>{t.line}</span></Link>)}
        </div>
      )}
      <nav className="om-tabbar" aria-label="Trading platform">
        {TAB_ORDER.map((k) => NAV.find((n) => n.key === k)!).map((n) => {
          const Icon = TAB_ICON[n.key];
          const cur = here === n.key ? "page" : undefined;
          return n.hard
            ? <a key={n.key} href={n.href} className="om-tab" aria-current={cur}><Icon aria-hidden="true" />{n.tab}</a>
            : <Link key={n.key} href={n.href} className="om-tab" aria-current={cur}><Icon aria-hidden="true" />{n.tab}</Link>;
        })}
        <button type="button" className="om-tab" aria-haspopup="menu" aria-expanded={sheet} aria-current={here === "genx" || here === "pulse" ? "page" : undefined} onClick={() => setSheet((s) => !s)}>
          <Wrench aria-hidden="true" />Tools
        </button>
      </nav>
    </>
  );
}

export function AppShell({ children, member, configured = true, preview = false }: {
  children: React.ReactNode; member: ShellMember;
  /** false on the labelled sample route, where there is no session to read credits or sign out of. */
  configured?: boolean;
  /** The admin preview: offers the way back to the classic portal. */
  preview?: boolean;
}) {
  // The public site's header and footer step aside while this shell is on screen.
  // (The same classes are set before first paint by SHELL_SCRIPT; this covers arriving without a reload.)
  useEffect(() => {
    const d = document.documentElement;
    d.classList.add("om-shell", "om-dark");
    return () => {
      d.classList.remove("om-shell");
      // The classic portal's own theme choice comes back as the member left it.
      try { if (localStorage.getItem("om-theme") !== "dark") d.classList.remove("om-dark"); } catch { /* leave it dark */ }
    };
  }, []);
  return (
    <div className="om-app">
      <Suspense fallback={<div className="om-nav-wrap"><div className="om-frame"><div className="om-nav" /></div></div>}>
        <Bar member={member} configured={configured} preview={preview} />
      </Suspense>
      <main className="om-main"><div className="om-frame"><ShellContext.Provider value={true}>{children}</ShellContext.Provider></div></main>
    </div>
  );
}
