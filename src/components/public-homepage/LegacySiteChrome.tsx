"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/** The public homepage owns its chrome. Every other route keeps the existing shell unchanged. */
export function LegacySiteChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return pathname === "/" ? null : children;
}
