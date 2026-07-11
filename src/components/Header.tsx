"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Menu } from "lucide-react";
import { mainNav, primaryCta } from "@/data/navigation";
import { Logo } from "./Logo";
import { Button } from "./Button";
import { MobileNavigation } from "./MobileNavigation";

export function Header() {
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

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
            ? "border-b border-[#E4DCCB] bg-cream/85 backdrop-blur-md"
            : "bg-cream/60 backdrop-blur-sm"
        }`}
      >
        <div className="container-1m flex h-16 items-center justify-between lg:h-20">
          <Logo />

          <nav className="hidden lg:block" aria-label="Primary">
            <ul className="flex items-center gap-1">
              {mainNav.map((item) => {
                const active = pathname === item.href;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      className={`rounded-full px-3.5 py-2 text-sm font-semibold transition-colors ${
                        active ? "text-primary" : "text-navy/80 hover:text-primary hover:bg-ice"
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
            <Link
              href="/login"
              className="hidden text-sm font-semibold text-primary hover:text-medium sm:inline-block"
            >
              Log In
            </Link>
            <div className="hidden sm:block">
              <Button href={primaryCta.href} size="sm">
                {primaryCta.label}
              </Button>
            </div>
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

      <MobileNavigation open={menuOpen} onClose={() => setMenuOpen(false)} />
    </>
  );
}
