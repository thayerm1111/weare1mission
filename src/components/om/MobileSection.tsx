"use client";

import { useId, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";

/** Presentation only: desktop content stays in place, mobile details open on demand. */
export function MobileSection({ title, meta, children, className = "", expanded, onExpanded }: {
  title: string;
  meta?: ReactNode;
  children: ReactNode;
  className?: string;
  expanded?: boolean;
  onExpanded?: (open: boolean) => void;
}) {
  const id = useId();
  const [localOpen, setLocalOpen] = useState(false);
  const open = expanded ?? localOpen;
  return (
    <div className={`om-mobile-section ${className}`} data-open={open || undefined}>
      <button type="button" className="om-mobile-section-toggle" aria-expanded={open} aria-controls={id}
        onClick={() => { setLocalOpen(!open); onExpanded?.(!open); }}>
        <span>{title}</span>
        {meta != null && <small>{meta}</small>}
        <ChevronRight width={18} height={18} aria-hidden="true" />
      </button>
      <div id={id} className="om-mobile-section-body">{children}</div>
    </div>
  );
}
