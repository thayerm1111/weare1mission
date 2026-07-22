"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Menu, LayoutDashboard } from "lucide-react";
import { mainNav, primaryCta } from "@/data/navigation";
import { createClient } from "@/lib/supabase/client";
import { Logo } from "./Logo";
import { Button } from "./Button";
import { MobileNavigation } from "./MobileNavigation";

export function Header() {
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Reflect the signed-in state so members don't see "Log In" everywhere.
  useEffect(() => {
    const supabase = createClient();
    if (!supabase) return;
    let active = true;
    supabase.auth.getSession().then(({ data }) => {
      if (active) setSignedIn(Boolean(data.session));
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setSignedIn(Boolean(session));
    });
    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  async function handleLogout() {
    const supabase = createClient();
    if (supabase) await supabase.auth.signOut();
    setSignedIn(false);
    router.push("/");
    router.refresh();
  }

  return (
    <>
      {/* Skip link for keyboard / screen-reader users */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[60] focus:rounded-lg focus:bg-white focus:px-4 focus:py-2 focus:text-navy focus:shadow-card"
      >
        Skip to content
      </a>

      <header
        className={`sticky top-0 z-40 w-full transition-all duration-300 ${
          scrolled
            ? "border-b border-[#E7E4DD] bg-white/85 backdrop-blur-md"
            : "bg-white/60 backdrop-blur-sm"
        }`}
      >
        <div className="mx-auto flex h-24 w-full max-w-[1760px] items-center justify-between px-4 sm:px-6 lg:h-28">
          <Logo wordmark={false} />

          <nav className="hidden lg:block" aria-label="Primary">
            <ul className="flex items-center gap-1">
              {mainNav.map((item) => {
                const active = pathname === item.href;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      className={`rounded-none px-3.5 py-2 text-[12px] font-medium uppercase tracking-[0.12em] transition-colors ${
                        active ? "text-primary" : "text-navy/70 hover:text-primary"
                      }`}
                    >
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>

          <div className="flex items-center gap-3">
            {signedIn ? (
              <>
                <button
                  onClick={handleLogout}
                  className="hidden text-[12px] font-medium uppercase tracking-[0.12em] text-primary hover:text-medium sm:inline-block"
                >
                  Log Out
                </button>
                <div className="hidden sm:block">
                  <Button href="/portal" size="sm">
                    <span className="inline-flex items-center gap-1.5">
                      <LayoutDashboard className="h-4 w-4" aria-hidden="true" /> My Portal
                    </span>
                  </Button>
                </div>
              </>
            ) : (
              <>
                <Link
                  href="/login"
                  className="hidden text-[12px] font-medium uppercase tracking-[0.12em] text-primary hover:text-medium sm:inline-block"
                >
                  Log In
                </Link>
                <div className="hidden sm:block">
                  <Button href={primaryCta.href} size="sm">
                    {primaryCta.label}
                  </Button>
                </div>
              </>
            )}
            <button
              onClick={() => setMenuOpen(true)}
              aria-label="Open menu"
              aria-expanded={menuOpen}
              aria-controls="mobile-menu"
              className="grid h-10 w-10 place-items-center rounded-full text-navy hover:bg-ice focus-ring lg:hidden"
            >
              <Menu className="h-5 w-5" aria-hidden="true" />
            </button>
          </div>
        </div>
      </header>

      <MobileNavigation
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        signedIn={signedIn}
        onLogout={handleLogout}
      />
    </>
  );
}
