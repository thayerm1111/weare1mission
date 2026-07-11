"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { X } from "lucide-react";
import { mainNav, primaryCta } from "@/data/navigation";
import { Logo } from "./Logo";
import { Button } from "./Button";

interface Props {
  open: boolean;
  onClose: () => void;
}

export function MobileNavigation({ open, onClose }: Props) {
  const pathname = usePathname();

  // Lock scroll + close on Escape while the menu is open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  return (
    <div
      className={`fixed inset-0 z-50 lg:hidden ${open ? "" : "pointer-events-none"}`}
      aria-hidden={!open}
    >
      {/* Backdrop */}
      <div
        className={`absolute inset-0 bg-navy/40 backdrop-blur-sm transition-opacity duration-300 ${
          open ? "opacity-100" : "opacity-0"
        }`}
        onClick={onClose}
      />
      {/* Panel */}
      <div
        id="mobile-menu"
        role="dialog"
        aria-modal="true"
        aria-label="Menu"
        className={`absolute right-0 top-0 flex h-full w-[86%] max-w-sm flex-col bg-white shadow-2xl transition-transform duration-300 ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="flex items-center justify-between border-b border-ice px-5 py-4">
          <Logo />
          <button
            onClick={onClose}
            aria-label="Close menu"
            className="grid h-10 w-10 place-items-center rounded-full text-navy hover:bg-ice focus-ring"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
        <nav className="flex-1 overflow-y-auto px-4 py-4" aria-label="Mobile">
          <ul className="space-y-1">
            {mainNav.map((item) => {
              const active = pathname === item.href;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onClose}
                    aria-current={active ? "page" : undefined}
                    className={`block rounded-xl px-4 py-3 text-base font-semibold transition-colors ${
                      active ? "bg-ice text-primary" : "text-navy hover:bg-offwhite"
                    }`}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="space-y-2 border-t border-[#E4DCCB] p-4">
          <Button href={primaryCta.href} size="lg" className="w-full">
            {primaryCta.label}
          </Button>
          <Link
            href="/login"
            onClick={onClose}
            className="block rounded-full border border-[#E4DCCB] px-4 py-3 text-center text-sm font-semibold text-primary hover:bg-offwhite"
          >
            Member Log In
          </Link>
        </div>
      </div>
    </div>
  );
}
