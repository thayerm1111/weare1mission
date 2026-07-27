"use client";

/**
 * OM AI Chart Read — the member snapshots their marked-up OM Chart, drops it
 * here (paste / drag / upload), optionally says what they're seeing, and OM AI
 * reads their markup, says whether it agrees, reads the pair from live data,
 * and gives a directional view with levels + invalidation.
 *
 * The TradingView embed is cross-origin so we can't read its drawings directly;
 * an image snapshot is how the member's markup reaches the AI. Images are
 * downscaled in the browser before upload so the payload stays small.
 */
import { useRef, useState } from "react";
import {
  Sparkles, Upload, ImageIcon, X, Loader2, ArrowUp, ArrowDown, Minus,
  Check, ShieldAlert, Clipboard, TrendingUp, Eye, Target,
} from "lucide-react";
import { CREDIT_COST } from "@/lib/creditConfig";

type Read = {
  observed?: string; verdict?: "agree" | "partial" | "disagree"; agreement?: string;
  bias?: "LONG" | "SHORT" | "NEUTRAL"; confidence?: string; pairRead?: string;
  resistance?: number[]; support?: number[]; bullCase?: string; bearCase?: string;
  likely?: string; entryIdea?: string; invalidation?: string; watch?: string[]; caveat?: string;
};

const fmt = (n: unknown) => (typeof n === "number" && Number.isFinite(n)
  ? (Math.abs(n) >= 1000 ? n.toFixed(2) : Math.abs(n) >= 1 ? n.toFixed(3) : n.toFixed(5))
  : String(n ?? "—"));

// Downscale an uploaded/pasted image to a sane size and re-encode as JPEG so the
// request body stays small (and within the vision API's limits).
function downscale(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const img = new Image();
      img.onload = () => {
        const MAX = 1568;
        let { width, height } = img;
        if (Math.max(width, height) > MAX) {
          const s = MAX / Math.max(width, height);
          width = Math.round(width * s); height = Math.round(height * s);
        }
        const canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) { reject(new Error("no-canvas")); return; }
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      };
      img.onerror = () => reject(new Error("bad-image"));
      img.src = String(fr.result);
    };
    fr.onerror = () => reject(new Error("read-failed"));
    fr.readAsDataURL(file);
  });
}

export function ChartRead() {
  const [image, setImage] = useState<string | null>(null);
  const [symbol, setSymbol] = useState("XAU/USD");
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(false);
  const [read, setRead] = useState<Read | null>(null);
  const [resolvedSymbol, setResolvedSymbol] = useState("");
  const [error, setError] = useState("");
  const [needCredits, setNeedCredits] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  async function ingest(file: Blob | undefined | null) {
    if (!file) return;
    setError("");
    try { setImage(await downscale(file)); }
    catch { setError("Couldn't read that image — try a PNG or JPG screenshot."); }
  }

  function onPaste(e: React.ClipboardEvent) {
    const item = Array.from(e.clipboardData.items).find((i) => i.type.startsWith("image/"));
    if (item) { e.preventDefault(); void ingest(item.getAsFile()); }
  }
  function onDrop(e: React.DragEvent) {
    e.preventDefault(); setDragOver(false);
    void ingest(e.dataTransfer.files?.[0]);
  }

  async function analyze() {
    if (!image || loading) return;
    setLoading(true); setError(""); setNeedCredits(false); setRead(null);
    try {
      const res = await fetch("/api/chart-read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ image, notes, symbol }),
      });
      const d = await res.json().catch(() => ({}));
      if (d.notConfigured === "ai") { setError("OM AI isn't switched on yet — the Anthropic key is missing."); return; }
      if (res.status === 402 || d.error === "insufficient_credits") { setNeedCredits(true); setError("You're out of credits. They reset tomorrow — or grab more to keep reading charts."); return; }
      if (d.error === "bad_image") { setError("That image didn't come through — try snapshotting the chart again."); return; }
      if (d.error === "image_too_large") { setError("That image is too large — try a tighter crop of the chart."); return; }
      if (d.error || !d.read) { setError(d.detail ? `Couldn't analyze: ${d.detail}` : "Couldn't analyze that chart right now. Try again shortly."); return; }
      setRead(d.read as Read); setResolvedSymbol(d.symbol || symbol);
      try { window.dispatchEvent(new Event("credits-updated")); } catch { /* ignore */ }
    } catch { setError("Something interrupted the connection. Try again."); }
    finally { setLoading(false); }
  }

  const verdict = read?.verdict;
  const vStyle = verdict === "agree"
    ? { chip: "bg-emerald-500/15 text-emerald-600", label: "OM AI agrees" }
    : verdict === "disagree"
    ? { chip: "bg-red-500/15 text-red-600", label: "OM AI disagrees" }
    : { chip: "bg-amber-500/15 text-amber-600", label: "OM AI partly agrees" };

  const bias = read?.bias;
  const bStyle = bias === "LONG"
    ? { chip: "bg-emerald-500/15 text-emerald-600", Icon: ArrowUp }
    : bias === "SHORT"
    ? { chip: "bg-red-500/15 text-red-600", Icon: ArrowDown }
    : { chip: "bg-charcoal/10 text-charcoal/70", Icon: Minus };

  return (
    <div className="rounded-2xl border border-[#E7E4DD] bg-offwhite/60 p-4 shadow-card sm:p-5">
      <div className="flex items-start gap-2.5">
        <span className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-xl bg-primary text-cream"><Sparkles className="h-4 w-4" /></span>
        <div>
          <h2 className="flex items-center gap-2 text-base font-extrabold tracking-tight text-navy">OM AI Chart Read</h2>
          <p className="text-xs text-charcoal/55">Mark up your chart above, snapshot it, and drop it here — OM AI reads your markup, says if it agrees, and calls the likely direction.</p>
        </div>
      </div>

      {/* Image drop / paste / upload zone */}
      <div
        tabIndex={0}
        onPaste={onPaste}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => !image && fileRef.current?.click()}
        className={`mt-4 rounded-xl border-2 border-dashed px-4 py-5 text-center outline-none transition-colors focus:border-primary/60 ${
          dragOver ? "border-primary/60 bg-primary/[0.04]" : "border-[#E7E4DD] hover:border-primary/40"
        } ${image ? "cursor-default" : "cursor-pointer"}`}
      >
        {image ? (
          <div className="relative">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={image} alt="Your marked-up chart" className="mx-auto max-h-64 w-auto rounded-lg border border-[#E7E4DD]" />
            <button
              onClick={(e) => { e.stopPropagation(); setImage(null); setRead(null); }}
              className="absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-full bg-navy/80 text-cream hover:bg-navy"
              title="Remove image"
            ><X className="h-3.5 w-3.5" /></button>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-1.5 py-2 text-charcoal/55">
            <span className="grid h-11 w-11 place-items-center rounded-full bg-ice text-primary"><ImageIcon className="h-5 w-5" /></span>
            <p className="mt-1 text-sm font-semibold text-navy">Drop, paste, or click to upload your chart snapshot</p>
            <p className="inline-flex items-center gap-1 text-[11px]"><Clipboard className="h-3 w-3" /> Tip: in the chart toolbar, use the camera icon → copy image, then paste here (⌘/Ctrl-V)</p>
          </div>
        )}
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => ingest(e.target.files?.[0])} />
      </div>

      {/* Symbol + notes */}
      <div className="mt-3 grid gap-3 sm:grid-cols-[180px_1fr]">
        <div>
          <label className="text-[11px] font-semibold uppercase tracking-wide text-charcoal/45">Pair</label>
          <input
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            placeholder="XAU/USD"
            className="mt-1 w-full rounded-xl border border-[#E7E4DD] bg-white/70 px-3 py-2 text-sm font-semibold text-navy placeholder:text-charcoal/35 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/15"
          />
        </div>
        <div>
          <label className="text-[11px] font-semibold uppercase tracking-wide text-charcoal/45">What are you seeing? <span className="normal-case text-charcoal/35">(optional)</span></label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            placeholder="e.g. I marked a bullish break of structure and I'm looking for longs off the 4H order block…"
            className="mt-1 w-full resize-none rounded-xl border border-[#E7E4DD] bg-white/70 px-3 py-2 text-sm text-charcoal placeholder:text-charcoal/35 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/15"
          />
        </div>
      </div>

      <button
        onClick={analyze}
        disabled={!image || loading}
        className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-6 py-3 text-sm font-bold uppercase tracking-wide text-cream transition-opacity hover:opacity-90 disabled:opacity-40 sm:w-auto"
      >
        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
        {loading ? "Reading your chart…" : "Analyze my markup"}
        <span className="rounded-full bg-black/15 px-1.5 py-0.5 text-[10px] font-bold">{CREDIT_COST.chartread} credits</span>
      </button>

      {error && (
        <div className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/[0.06] px-4 py-3 text-sm text-amber-700">
          <p className="inline-flex items-center gap-2"><ShieldAlert className="h-4 w-4" /> {error}</p>
          {needCredits && <a href="/portal/credits" className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-cream hover:opacity-90">Get credits</a>}
        </div>
      )}

      {read && (
        <div className="mt-4 space-y-3">
          {/* Verdict + bias */}
          <div className="flex flex-wrap items-center gap-2">
            <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wide ${vStyle.chip}`}><Check className="h-3.5 w-3.5" /> {vStyle.label}</span>
            {bias && <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wide ${bStyle.chip}`}><bStyle.Icon className="h-3.5 w-3.5" /> {bias}</span>}
            {read.confidence && <span className="rounded-full bg-ice px-3 py-1 text-xs font-semibold text-charcoal/70">Confidence: {read.confidence}</span>}
            <span className="ml-auto text-[11px] font-semibold uppercase tracking-wide text-charcoal/40">{resolvedSymbol}</span>
          </div>

          {read.observed && (
            <Block icon={<Eye className="h-4 w-4" />} label="What you drew">{read.observed}</Block>
          )}
          {read.agreement && (
            <Block icon={<Check className="h-4 w-4" />} label="OM AI's take on your read">{read.agreement}</Block>
          )}
          {read.pairRead && (
            <Block icon={<TrendingUp className="h-4 w-4" />} label={`Read on ${resolvedSymbol}`}>{read.pairRead}</Block>
          )}

          {/* Levels */}
          {((read.resistance?.length ?? 0) > 0 || (read.support?.length ?? 0) > 0) && (
            <div className="grid gap-3 sm:grid-cols-2">
              <LevelBox label="Resistance" tint="text-red-600" values={read.resistance} />
              <LevelBox label="Support" tint="text-emerald-600" values={read.support} />
            </div>
          )}

          {/* Scenarios */}
          {(read.bullCase || read.bearCase) && (
            <div className="grid gap-3 sm:grid-cols-2">
              {read.bullCase && (
                <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/[0.05] p-3">
                  <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-emerald-600"><ArrowUp className="h-3.5 w-3.5" /> Bull case</p>
                  <p className="mt-1 text-sm text-charcoal/80">{read.bullCase}</p>
                </div>
              )}
              {read.bearCase && (
                <div className="rounded-xl border border-red-500/25 bg-red-500/[0.05] p-3">
                  <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-red-600"><ArrowDown className="h-3.5 w-3.5" /> Bear case</p>
                  <p className="mt-1 text-sm text-charcoal/80">{read.bearCase}</p>
                </div>
              )}
            </div>
          )}

          {read.likely && (
            <div className="rounded-xl border border-primary/30 bg-primary/[0.05] p-4">
              <p className="text-[11px] font-bold uppercase tracking-wide text-primary">Which way it may go</p>
              <p className="mt-1 text-sm font-medium text-navy">{read.likely}</p>
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            {read.entryIdea && <Block icon={<Target className="h-4 w-4" />} label="Entry idea">{read.entryIdea}</Block>}
            {read.invalidation && <Block icon={<ShieldAlert className="h-4 w-4" />} label="Invalidation">{read.invalidation}</Block>}
          </div>

          {(read.watch?.length ?? 0) > 0 && (
            <div className="rounded-xl border border-[#E7E4DD] bg-white/50 p-3">
              <p className="text-[11px] font-bold uppercase tracking-wide text-charcoal/45">What to watch</p>
              <ul className="mt-1.5 space-y-1">
                {read.watch!.map((w, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-charcoal/80"><span className="mt-1.5 h-1 w-1 flex-shrink-0 rounded-full bg-primary" /> {w}</li>
                ))}
              </ul>
            </div>
          )}

          {read.caveat && <p className="text-[11px] leading-relaxed text-charcoal/45">{read.caveat} · Educational analysis, not financial advice.</p>}
        </div>
      )}
    </div>
  );
}

function Block({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-[#E7E4DD] bg-white/50 p-3">
      <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-charcoal/45">{icon} {label}</p>
      <p className="mt-1 text-sm leading-relaxed text-charcoal/80">{children}</p>
    </div>
  );
}

function LevelBox({ label, tint, values }: { label: string; tint: string; values?: number[] }) {
  if (!values || values.length === 0) return null;
  return (
    <div className="rounded-xl border border-[#E7E4DD] bg-white/50 p-3">
      <p className="text-[11px] font-bold uppercase tracking-wide text-charcoal/45">{label}</p>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {values.map((v, i) => (
          <span key={i} className={`rounded-lg bg-ice px-2.5 py-1 font-serif text-sm font-bold tabular-nums ${tint}`}>{fmt(v)}</span>
        ))}
      </div>
    </div>
  );
}
