"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/** These public routes own their chrome. Other routes keep the existing shell. */
export function LegacySiteChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return pathname === "/" || pathname === "/login" ? null : children;
}
