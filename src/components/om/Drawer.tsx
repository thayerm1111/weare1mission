"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";

/**
 * A PANEL OVER THE PAGE, FROM THE RIGHT EDGE — for settings that belong to what is on screen and should
 * not take the member somewhere else (owner 11-20 brief §9: "Manage execution opens organized settings for
 * that account").
 *
 * Closed, it is off the edge, invisible and inert: nothing in it can be reached by keyboard or a reader.
 * Open, focus moves into it and Tab stays inside; Escape, the veil and the close button all close it, and
 * focus goes back to whatever opened it. On a phone it is the whole width of the screen.
 */
export function Drawer({ id, open, onClose, title, sub, children }: {
  id: string;
  open: boolean;
  onClose: () => void;
  title: string;
  sub?: React.ReactNode;
  children: React.ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (!open) return;
    const back = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const p = panel.current;
    const t = setTimeout(() => p?.focus(), 20);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); close.current(); return; }
      if (e.key !== "Tab" || !p) return;
      const all = [...p.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
        .filter((el) => el.getClientRects().length > 0);
      if (!all.length) { e.preventDefault(); return; }
      const first = all[0], last = all[all.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === p)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => { clearTimeout(t); document.removeEventListener("keydown", onKey); back?.focus?.(); };
  }, [open]);

  const shut = (open ? {} : { inert: "" }) as Record<string, string>;
  return (
    <div className="om-drawer" data-open={open ? "true" : "false"} {...shut}>
      <div className="om-drawer-veil" aria-hidden="true" onClick={() => close.current()} />
      <div ref={panel} className="om-drawer-panel" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1}>
        <div className="om-drawer-head">
          <div style={{ minWidth: 0 }}>
            <h2 id={`${id}-title`}>{title}</h2>
            {sub ? <p className="om-label">{sub}</p> : null}
          </div>
          <button type="button" className="om-icon-btn" aria-label="Close" onClick={() => close.current()}><X aria-hidden="true" /></button>
        </div>
        <div className="om-drawer-body">{children}</div>
      </div>
    </div>
  );
}
