"use client";

/**
 * Shared copy-to-clipboard helpers for the trading tools.
 *
 * - <CopyBtn value="27756.3" />  → a tiny icon button that copies a single
 *   price (comma-free, ready to paste straight into a broker).
 * - <CopyAllBtn text={...} />    → a pill button that copies the whole trade
 *   block (direction + entry + stop + take-profits).
 * - buildTradeText(...)          → assembles the Copy-All / Telegram block in
 *   the exact format the desk asked for.
 *
 * These live in the dark "engine" panels (Strategy Scanner, Market Command,
 * OM AI Plays, MFXGHOST), so the default styling is tuned for a dark surface.
 */

import { useState } from "react";
import { Copy, Check } from "lucide-react";

/** Strip thousands separators so a copied price pastes cleanly into a broker. */
export function cleanNum(display: string): string {
  return (display || "").replace(/,/g, "").trim();
}

function writeClipboard(text: string) {
  try {
    navigator.clipboard?.writeText(text);
  } catch {
    /* clipboard unavailable — no-op */
  }
}

/** Inline icon button that copies a single value and flashes a check. */
export function CopyBtn({
  value,
  label,
  className = "",
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const v = cleanNum(value);
  if (!v || v === "—") return null;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        writeClipboard(v);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      aria-label={`Copy ${label || "value"} ${v}`}
      title={`Copy ${v}`}
      className={
        "inline-grid h-5 w-5 flex-shrink-0 place-items-center rounded-md text-white/35 transition-colors hover:bg-white/10 hover:text-white/80 " +
        className
      }
    >
      {copied ? (
        <Check className="h-3 w-3 text-emerald-400" aria-hidden="true" />
      ) : (
        <Copy className="h-3 w-3" aria-hidden="true" />
      )}
    </button>
  );
}

/** Pill button that copies the full trade block. */
export function CopyAllBtn({
  text,
  className = "",
}: {
  text: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  if (!text) return null;
  return (
    <button
      type="button"
      onClick={() => {
        writeClipboard(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      }}
      className={
        "inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/[0.04] px-3.5 py-1.5 text-[12px] font-semibold text-white/80 transition-colors hover:bg-white/10 disabled:opacity-40 " +
        className
      }
    >
      {copied ? (
        <>
          <Check className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" /> Copied
        </>
      ) : (
        <>
          <Copy className="h-3.5 w-3.5" aria-hidden="true" /> Copy all
        </>
      )}
    </button>
  );
}

/**
 * Build the copy-all / telegram trade block, e.g.
 *   BUY
 *   Entry: 27756.30
 *   Stop Loss: 27700
 *   Take Profit: 27800
 *   Take Profit: 27850
 *   Take Profit: 27900
 *
 * `fmt` is each tool's own number formatter so copied prices match the screen;
 * thousands separators are stripped for broker paste.
 */
export function buildTradeText(opts: {
  direction?: string | null;
  entry?: number | null;
  stopLoss?: number | null;
  takeProfits?: (number | null | undefined)[];
  fmt: (n: number | null | undefined) => string;
  header?: string;
}): string {
  const { direction, entry, stopLoss, takeProfits = [], fmt, header } = opts;
  const d = (direction || "").toLowerCase();
  const side = /long|buy/.test(d) ? "BUY" : /short|sell/.test(d) ? "SELL" : (direction || "").toUpperCase();
  const num = (n: number | null | undefined) => cleanNum(fmt(n));
  const lines: string[] = [];
  if (header) lines.push(header);
  if (side) lines.push(side);
  if (entry != null && Number.isFinite(entry)) lines.push(`Entry: ${num(entry)}`);
  if (stopLoss != null && Number.isFinite(stopLoss)) lines.push(`Stop Loss: ${num(stopLoss)}`);
  for (const t of takeProfits) {
    if (t != null && Number.isFinite(t)) lines.push(`Take Profit: ${num(t)}`);
  }
  return lines.join("\n");
}
