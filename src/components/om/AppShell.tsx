"use client";

import "./om.css";
import "./os.css";
import "./os-products.css";
import "./flow-account.css";
import "./floor/os-floor.css";
import "./os-mobile.css";
import "./mobile-tools.css";
import "./mobile-premium.css";
import "./connected-experience.css";
import { Suspense, useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { CreditCard, Globe, House, LifeBuoy, LogOut, PlayCircle, ShieldCheck, SlidersHorizontal, Smartphone, Undo2, User, UserCircle, Waves, Wrench } from "lucide-react";
import { NotificationsBell } from "@/components/portal/NotificationsBell";
import { NAV, APP_TABS, TAB_ORDER, activeKey, activeTabKey, type AppTabKey } from "@/lib/floor/nav";
import type { InstallGuide } from "@/lib/floor/app";
import { DEFAULT_LOOK, LOOKS, LOOK_CLASS, LOOK_KEY, applyLook, lookOf, themeOf, type Look } from "@/lib/floor/look";
import { InstallSheet, OfflineNotice, runningAsApp, useInstall } from "./InstallApp";
import { ShellContext } from "./shell";
import { ProductIcon } from "./ProductIcon";
import { FlowAccountBar, FlowAccountProvider } from "./FlowAccount";
import { MobileViewport } from "./MobileViewport";
import { AtlasProvider, useAtlasPanel } from "./atlas/AtlasProvider";
import { openAtlas } from "@/lib/atlas/open";
import { openWelcomeTutorial, WelcomeTutorial } from "./WelcomeTutorial";

/** The shared OS frame. Trading tools retain their own engines, permissions and requests. */
export type ShellMember = { id?: string | null; name: string | null; email: string | null; admin: boolean };

function OmMark() {
  return (
    <svg viewBox="0 0 58 28" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="14" r="9.6" />
      <path d="M22.5 24 30.5 5.2c.5-1.2 2.2-1.2 2.7 0l5 12.3c.5 1.2 2.2 1.2 2.7 0l5-12.3c.5-1.2 2.2-1.2 2.7 0L56.8 24" />
    </svg>
  );
}

const TAB_ICON: Record<AppTabKey, typeof House> = { floor: House, atlas: Globe, tools: Wrench, flow: Waves };

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

function ProfileMenu({ member, configured, preview, asApp, onInstall, look, onLook }: {
  member: ShellMember; configured: boolean; preview: boolean;
  /** The look on screen, and the member's way to change it (lib/floor/look.ts). */
  look: Look; onLook: (l: Look) => void;
  /** Running as the installed app: the preview is what the app is, so there is no "leave" from inside it. */
  asApp: boolean | null;
  /** Offered while this is a browser tab that has not installed the app. */
  onInstall?: () => void;
}) {
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
      <button type="button" className="om-avatar" data-om-account-trigger="" aria-label="Your account" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <User width={19} height={19} aria-hidden="true" />
      </button>
      {open && (
        <div className="om-menu om-account-menu" role="menu">
          {(member.name || member.email) && (
            <div className="om-menu-head">
              {member.name && <p style={{ fontSize: 15 }}>{member.name}</p>}
              {member.email && <p className="om-dim" style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis" }}>{member.email}</p>}
            </div>
          )}
          {member.admin && <>
            <Link role="menuitem" href="/portal/admin" onClick={() => setOpen(false)}><ShieldCheck aria-hidden="true" />Member approvals</Link>
            <a role="menuitem" href="/admin/controls"><SlidersHorizontal aria-hidden="true" />Trading controls</a>
            <hr />
          </>}
          <Link role="menuitem" href="/portal/account" onClick={() => setOpen(false)}><UserCircle aria-hidden="true" />Account and settings</Link>
          <Link role="menuitem" href="/portal/credits" onClick={() => setOpen(false)}><CreditCard aria-hidden="true" />Credits and billing</Link>
          {configured && <div className="om-mobile-notifications"><span>Notifications</span><NotificationsBell trading /></div>}
          <Link role="menuitem" href="/portal/support" onClick={() => setOpen(false)}><LifeBuoy aria-hidden="true" />Support</Link>
          {configured && member.id && <button type="button" role="menuitem" aria-haspopup="dialog" onClick={() => { setOpen(false); openWelcomeTutorial(); }}><PlayCircle aria-hidden="true" />Replay tutorial</button>}
          {onInstall && <button type="button" role="menuitem" onClick={() => { setOpen(false); onInstall(); }}><Smartphone aria-hidden="true" />Install the app</button>}
          {/* THE LOOK (owner 11-21): Stone or Graphite, changed in place — the menu stays open so the change is seen. */}
          <div className="om-menu-look" role="group" aria-label="Look">
            <span>Look</span>
            <div className="om-menu-seg">
              {LOOKS.map((l) => (
                <button key={l.key} type="button" role="menuitemradio" aria-checked={look === l.key} onClick={() => onLook(l.key)}>
                  <i className="om-swatch" data-look={l.key} aria-hidden="true" />{l.label}
                </button>
              ))}
            </div>
          </div>
          {/* The site's own language switch (I18nProvider), asked for from here instead of a floating button. */}
          <button type="button" role="menuitem" data-no-i18n translate="no" onClick={() => { window.dispatchEvent(new Event("om-lang-toggle")); setOpen(false); }}><Globe aria-hidden="true" />{lang === "es" ? "English" : "Español"}</button>
          {member.admin && preview && asApp === false && <a role="menuitem" className="om-classic-portal" href="/api/floor/preview?on=0"><Undo2 aria-hidden="true" />Classic portal</a>}
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

function Bar({ member, configured, preview, look, onLook }: { member: ShellMember; configured: boolean; preview: boolean; look: Look; onLook: (l: Look) => void }) {
  const atlasPanel = useAtlasPanel();
  const path = usePathname() || "";
  const view = useSearchParams().get("view");
  const here = activeKey(path, view);
  const tabHere = activeTabKey(path, view);
  // THE APP BAR (owner 11-21: "make it more like an actual app"). As the installed app the bar is an app's: the
  // screen's large title scrolls away under it and its name settles in the bar's middle, with a hairline beneath.
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    let raf = 0;
    const read = () => { raf = 0; setScrolled(window.scrollY > 44); };
    const on = () => { if (!raf) raf = window.requestAnimationFrame(read); };
    read();
    window.addEventListener("scroll", on, { passive: true });
    return () => { window.removeEventListener("scroll", on); if (raf) window.cancelAnimationFrame(raf); };
  }, [path, view]);
  const screen = here ? NAV.find((n) => n.key === here)?.label ?? null : null;
  const returnToTop = (event: ReactMouseEvent<HTMLAnchorElement>, key: AppTabKey) => {
    // Tapping Tools from an engine must open the picker; only re-tap the actual hub to scroll up.
    if (tabHere !== key || (key === "tools" && path !== "/portal/tools") || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    window.scrollTo({ top: 0, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  };
  // THE ONE MISSION APP (lib/floor/app.ts): the browser's own install dialog where it has one, else its steps.
  const { asApp, offer, install: installApp } = useInstall();
  const [guide, setGuide] = useState<InstallGuide | null>(null);
  const closeGuide = useCallback(() => setGuide(null), []);
  const install = useCallback(() => { void installApp().then((g) => { if (g) setGuide(g); }); }, [installApp]);

  return (
    <>
      <div className="om-nav-wrap" data-scrolled={scrolled ? "" : undefined} data-screen={here ?? "account"}>
        <div className="om-frame">
          <nav className="om-nav" aria-label="Trading platform">
            <Link href="/portal/trading" className="om-brand" aria-label="One Mission — The Floor"><OmMark /><span>One Mission</span><small>OS</small></Link>
            <span className="om-mobile-screen" aria-hidden="true">{screen ?? "Account"}</span>
            <div className="om-os-breadcrumb"><Link href="/portal/trading" aria-current={here === "floor" ? "page" : undefined}>The Floor</Link>{here && here !== "floor" && <><span aria-hidden="true">/</span><span>{screen}</span></>}</div>
            <div className="om-nav-right">
              <button type="button" className="om-os-ask" onClick={() => openAtlas()} aria-haspopup="dialog" aria-expanded={atlasPanel.open} disabled={!configured}><ProductIcon kind="atlas" size="sm" /><span>Ask Atlas</span></button>
              {configured && <Credits />}
              {configured && <span className="om-bell"><NotificationsBell trading /></span>}
              <ProfileMenu member={member} configured={configured} preview={preview} asApp={asApp} onInstall={configured && offer ? install : undefined} look={look} onLook={onLook} />
            </div>
          </nav>
        </div>
      </div>

      {guide && <InstallSheet guide={guide} onClose={closeGuide} />}

      {/* Four stable places under the thumb. Tools opens the three distinct engines. */}
      <nav className="om-tabbar" aria-label="One Mission app navigation">
        {TAB_ORDER.map((k) => APP_TABS.find((n) => n.key === k)!).map((n) => {
          const Icon = TAB_ICON[n.key];
          const cur = tabHere === n.key ? "page" : undefined;
          if (n.key === "atlas") return <button key={n.key} type="button" className="om-tab" aria-label="Atlas" aria-haspopup="dialog" aria-expanded={atlasPanel.open} aria-current={atlasPanel.open ? "page" : cur} disabled={!configured} onClick={() => openAtlas()}><span className="om-tab-symbol"><Icon aria-hidden="true" /></span><span>{n.label}</span></button>;
          return n.hard
            ? <a key={n.key} href={n.href} className="om-tab" aria-label={n.label} aria-current={cur} onClick={(event) => returnToTop(event, n.key)}><span className="om-tab-symbol"><Icon aria-hidden="true" /></span><span>{n.label}</span></a>
            : <Link key={n.key} href={n.href} className="om-tab" aria-label={n.label} aria-current={cur} onClick={(event) => returnToTop(event, n.key)}><span className="om-tab-symbol"><Icon aria-hidden="true" /></span><span>{n.label}</span></Link>;
        })}
      </nav>
    </>
  );
}

const APPS = [
  { key: "atlas" as const, label: "Atlas", line: "Your AI trading assistant", href: "#atlas", hard: false },
  { key: "genx" as const, label: "GENX", line: "The gold engine", href: "/portal/genx", hard: false },
  { key: "plays" as const, label: "OM AI Plays", line: "Any market. Full setup.", href: "/portal/signals", hard: false },
  { key: "pulse" as const, label: "Pulse", line: "Find your next market", href: "/portal/trading?view=pulse", hard: false },
  { key: "flow" as const, label: "FLOW", line: "Your account connection", href: "/portal/trading?view=flow", hard: false },
];

function AppDock() {
  const path = usePathname() || "";
  const here = activeKey(path, useSearchParams().get("view"));
  return <nav className="om-os-dock" aria-label="One Mission apps">
    {APPS.map((app, index) => {
      const content = <><ProductIcon kind={app.key} /><span className="om-os-app-title">{app.label}<small>{app.line}</small></span><span className="om-os-app-number" aria-hidden="true">0{index + 1}</span></>;
      if (app.key === "atlas") return <button key={app.key} type="button" className="om-os-app" aria-haspopup="dialog" onClick={() => openAtlas()}>{content}</button>;
      return app.hard
        ? <a key={app.key} href={app.href} className="om-os-app" aria-current={here === app.key ? "page" : undefined}>{content}</a>
        : <Link key={app.key} href={app.href} className="om-os-app" aria-current={here === app.key ? "page" : undefined}>{content}</Link>;
    })}
  </nav>;
}

function AccountPlacement() {
  const path = usePathname() || "";
  const here = activeKey(path, useSearchParams().get("view"));
  return <div className="om-account-placement" data-mobile-visible={here === "floor" || here === "flow" ? "true" : undefined}><FlowAccountBar /></div>;
}

export function AppShell({ children, member, configured = true, preview = false, atlas = false }: {
  children: React.ReactNode; member: ShellMember;
  /** false on the labelled sample route, where there is no session to read credits or sign out of. */
  configured?: boolean;
  /** The existing Atlas Command Center lives within the same OS. */
  atlas?: boolean;
  /** An admin: offers the way to the classic portal (kept for support since the new design went to everyone). */
  preview?: boolean;
}) {
  // The public site's header and footer step aside while this shell is on screen, and the member's look is put on.
  // (The same classes are set before first paint by SHELL_SCRIPT; this covers arriving without a reload.)
  const [look, setLook] = useState<Look>(DEFAULT_LOOK);
  useEffect(() => {
    const d = document.documentElement;
    d.classList.add("om-shell");
    d.classList.toggle("om-standalone", runningAsApp());
    let saved: Look = DEFAULT_LOOK;
    try { saved = lookOf(localStorage.getItem(LOOK_KEY)); } catch { /* default look */ }
    applyLook(d, saved);
    setLook(saved);
    return () => {
      d.classList.remove("om-shell", "om-standalone", LOOK_CLASS);
      // The classic portal's own theme choice comes back as the member left it.
      let dark = false;
      try { dark = localStorage.getItem("om-theme") === "dark"; } catch { /* light */ }
      d.classList.toggle("om-dark", dark);
    };
  }, []);
  const chooseLook = useCallback((l: Look) => {
    applyLook(document.documentElement, l);
    setLook(l);
    try { localStorage.setItem(LOOK_KEY, l); } catch { /* this visit only */ }
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", themeOf(l));
  }, []);
  return (
    <div className={`om-app om-os${atlas ? " om-os-atlas" : ""}`}>
      <MobileViewport />
      <FlowAccountProvider configured={configured}>
      <AtlasProvider configured={configured} memberKey={member.email ?? member.name ?? "member"}>
      <Suspense fallback={null}><WelcomeTutorial key={member.id ?? "sample"} memberId={member.id} configured={configured} auto={!atlas} /></Suspense>
      <Suspense fallback={<div className="om-nav-wrap"><div className="om-frame"><div className="om-nav" /></div></div>}>
        <Bar member={member} configured={configured} preview={preview} look={look} onLook={chooseLook} />
      </Suspense>
      <main className="om-main"><div className="om-frame"><ShellContext.Provider value={true}>
        {configured && <Suspense fallback={null}><AccountPlacement /></Suspense>}
        <Suspense fallback={<div className="om-os-dock-skeleton" />}><AppDock /></Suspense>
        {children}
        <footer className="om-os-footer"><span>One Mission OS</span><span>Your tools. One connected workspace.</span><Link href="/portal/support">Support ↗</Link></footer>
      </ShellContext.Provider></div></main>
      <OfflineNotice />
      </AtlasProvider>
      </FlowAccountProvider>
    </div>
  );
}
