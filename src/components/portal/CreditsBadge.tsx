"use client";

/**
 * Compact credits pill → links to the Credits page. Refreshes whenever a
 * metered action fires a `credits-updated` window event, so the balance stays
 * live as members spend. Light-palette; drop it into any light portal surface.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Zap } from "lucide-react";

export function CreditsBadge({ className = "" }: { className?: string }) {
  const [total, setTotal] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/credits", { cache: "no-store" });
      const d = await r.json();
      if (d.balance) setTotal((d.balance.dailyLeft || 0) + (d.balance.purchased || 0));
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    void load();
    const h = () => void load();
    window.addEventListener("credits-updated", h);
    return () => window.removeEventListener("credits-updated", h);
  }, [load]);

  return (
    <Link href="/portal/credits" title="Your credits — tap to buy more"
      className={`inline-flex items-center gap-1.5 rounded-full border border-[#E7E4DD] bg-white px-2.5 py-1.5 text-xs font-semibold text-navy transition-colors hover:bg-offwhite focus-ring ${className}`}>
      <Zap className="h-3.5 w-3.5 flex-shrink-0 text-primary" />
      {total == null ? "—" : total.toLocaleString()}
      <span className="hidden sm:inline">credits</span>
    </Link>
  );
}
