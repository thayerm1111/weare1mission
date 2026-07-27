"use client";

/**
 * OM AI Chart Read + Markup.
 *
 * The TradingView embed's touch drawing is clunky on mobile and it lives in a
 * cross-origin iframe we can't reach into. So instead of fighting it, this panel
 * lets a member SNAPSHOT their chart, drop the image in here, and mark it up with
 * a fluid, finger-native drawing layer we fully control (dots, lines, freehand) —
 * the mark lands exactly where you touch. Then OM AI reads the marked-up chart,
 * says whether it agrees, reads the pair from live data, and calls the likely
 * direction.
 *
 * The drawing is a same-origin <canvas> overlaid on the image, driven by pointer
 * events with touch-action:none, so it's smooth on phones. On "Analyze", the
 * image + strokes are flattened to one picture and sent to /api/chart-read.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Sparkles, ImageIcon, X, Loader2, ArrowUp, ArrowDown, Minus,
  Check, ShieldAlert, Clipboard, TrendingUp, Eye, Target,
  Pencil, Slash, Circle, Undo2, Trash2, Download,
} from "lucide-react";
import { CREDIT_COST } from "@/lib/creditConfig";

type Read = {
  observed?: string; verdict?: "agree" | "partial" | "disagree"; agreement?: string;
  bias?: "LONG" | "SHORT" | "NEUTRAL"; confidence?: string; pairRead?: string;
  resistance?: number[]; support?: number[]; bullCase?: string; bearCase?: string;
  likely?: string; entryIdea?: string; invalidation?: string; watch?: string[]; caveat?: string;
};

type Tool = "pen" | "line" | "dot";
type Pt = { x: number; y: number };
type Stroke = { tool: Tool; color: string; width: number; points: Pt[] };

const COLORS = ["#e11d48", "#10b981", "#3b82f6", "#f59e0b", "#ffffff"];
const WIDTHS = [4, 8, 14];

const fmt = (n: unknown) => (typeof n === "number" && Number.isFinite(n)
  ? (Math.abs(n) >= 1000 ? n.toFixed(2) : Math.abs(n) >= 1 ? n.toFixed(3) : n.toFixed(5))
  : String(n ?? "—"));

// Downscale a pasted/uploaded image and re-encode as JPEG so the payload stays
// small (and within the vision API's limits). Returns the data URL + dimensions.
function downscale(file: Blob): Promise<{ url: string; w: number; h: number }> {
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
        resolve({ url: canvas.toDataURL("image/jpeg", 0.85), w: width, h: height });
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
  const [dims, setDims] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState(COLORS[0]);
  const [width, setWidth] = useState(WIDTHS[1]);

  const [symbol, setSymbol] = useState("XAU/USD");
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(false);
  const [read, setRead] = useState<Read | null>(null);
  const [resolvedSymbol, setResolvedSymbol] = useState("");
  const [error, setError] = useState("");
  const [needCredits, setNeedCredits] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const fileRef = useRef<HTMLInputElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef<Stroke | null>(null);

  // ---- image intake ----------------------------------------------------------
  async function ingest(file: Blob | undefined | null) {
    if (!file) return;
    setError("");
    try {
      const { url, w, h } = await downscale(file);
      setImage(url); setDims({ w, h }); setStrokes([]); setRead(null);
    } catch { setError("Couldn't read that image — try a PNG or JPG screenshot."); }
  }
  function onPaste(e: React.ClipboardEvent) {
    const item = Array.from(e.clipboardData.items).find((i) => i.type.startsWith("image/"));
    if (item) { e.preventDefault(); void ingest(item.getAsFile()); }
  }
  function onDrop(e: React.DragEvent) {
    e.preventDefault(); setDragOver(false);
    void ingest(e.dataTransfer.files?.[0]);
  }

  // ---- drawing ---------------------------------------------------------------
  const redraw = useCallback((extra?: Stroke | null) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const all = extra ? [...strokes, extra] : strokes;
    for (const s of all) {
      ctx.strokeStyle = s.color; ctx.fillStyle = s.color;
      ctx.lineWidth = s.width; ctx.lineCap = "round"; ctx.lineJoin = "round";
      if (s.tool === "dot") {
        const p = s.points[0]; if (!p) continue;
        ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(3, s.width * 1.4), 0, Math.PI * 2); ctx.fill();
      } else if (s.tool === "line") {
        const a = s.points[0], b = s.points[s.points.length - 1];
        if (!a || !b) continue;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      } else {
        if (s.points.length < 2) { const p = s.points[0]; if (p) { ctx.beginPath(); ctx.arc(p.x, p.y, s.width / 2, 0, Math.PI * 2); ctx.fill(); } continue; }
        ctx.beginPath(); ctx.moveTo(s.points[0].x, s.points[0].y);
        for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x, s.points[i].y);
        ctx.stroke();
      }
    }
  }, [strokes]);

  // Size the canvas to the image's pixel size once it's loaded, then paint.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !dims.w) return;
    canvas.width = dims.w; canvas.height = dims.h;
    redraw();
  }, [dims, redraw]);
  useEffect(() => { redraw(); }, [strokes, redraw]);

  function toCanvas(e: React.PointerEvent): Pt {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * canvas.height,
    };
  }
  function onPointerDown(e: React.PointerEvent) {
    if (!image) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    drawing.current = { tool, color, width, points: [toCanvas(e)] };
    redraw(drawing.current);
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!drawing.current) return;
    e.preventDefault();
    const p = toCanvas(e);
    if (drawing.current.tool === "line" || drawing.current.tool === "dot") {
      // line: keep first point as anchor, replace the moving end; dot: follow finger
      drawing.current.points = drawing.current.tool === "line"
        ? [drawing.current.points[0], p]
        : [p];
    } else {
      drawing.current.points.push(p);
    }
    redraw(drawing.current);
  }
  function onPointerUp() {
    if (!drawing.current) return;
    const s = drawing.current; drawing.current = null;
    setStrokes((prev) => [...prev, s]);
  }
  const undo = () => setStrokes((p) => p.slice(0, -1));
  const clearAll = () => setStrokes([]);

  // Flatten the image + strokes into one JPEG for the AI (and for download).
  function composite(): string | null {
    if (!image || !dims.w) return null;
    const out = document.createElement("canvas");
    out.width = dims.w; out.height = dims.h;
    const ctx = out.getContext("2d");
    const base = imgFromRef();
    if (!ctx || !base) return null;
    ctx.drawImage(base, 0, 0, dims.w, dims.h);
    if (canvasRef.current) ctx.drawImage(canvasRef.current, 0, 0);
    return out.toDataURL("image/jpeg", 0.9);
  }
  function imgFromRef(): HTMLImageElement | null {
    return (document.getElementById("cr-base-img") as HTMLImageElement) || null;
  }
  function downloadMarked() {
    const url = composite(); if (!url) return;
    const a = document.createElement("a");
    a.href = url; a.download = "om-chart-markup.jpg"; a.click();
  }

  // ---- analyze ---------------------------------------------------------------
  async function analyze() {
    if (!image || loading) return;
    const payload = composite() || image;
    setLoading(true); setError(""); setNeedCredits(false); setRead(null);
    try {
      const res = await fetch("/api/chart-read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ image: payload, notes, symbol }),
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

  const ToolBtn = ({ t, Icon, label }: { t: Tool; Icon: typeof Pencil; label: string }) => (
    <button
      onClick={() => setTool(t)}
      title={label}
      className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-colors ${
        tool === t ? "bg-primary text-cream" : "bg-ice text-charcoal/70 hover:text-charcoal"
      }`}
    ><Icon className="h-3.5 w-3.5" /> {label}</button>
  );

  return (
    <div className="rounded-2xl border border-[#E7E4DD] bg-offwhite/60 p-4 shadow-card sm:p-5">
      <div className="flex items-start gap-2.5">
        <span className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-xl bg-primary text-cream"><Sparkles className="h-4 w-4" /></span>
        <div>
          <h2 className="flex items-center gap-2 text-base font-extrabold tracking-tight text-navy">OM AI Chart Read &amp; Markup</h2>
          <p className="text-xs text-charcoal/55">Snapshot your chart, drop it in, and draw right on it — smooth on mobile. OM AI reads your markup, says if it agrees, and calls the likely direction.</p>
        </div>
      </div>

      {!image ? (
        <div
          tabIndex={0}
          onPaste={onPaste}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          onClick={() => fileRef.current?.click()}
          className={`mt-4 cursor-pointer rounded-xl border-2 border-dashed px-4 py-6 text-center outline-none transition-colors focus:border-primary/60 ${
            dragOver ? "border-primary/60 bg-primary/[0.04]" : "border-[#E7E4DD] hover:border-primary/40"
          }`}
        >
          <div className="flex flex-col items-center gap-1.5 text-charcoal/55">
            <span className="grid h-11 w-11 place-items-center rounded-full bg-ice text-primary"><ImageIcon className="h-5 w-5" /></span>
            <p className="mt-1 text-sm font-semibold text-navy">Drop, paste, or tap to add your chart snapshot</p>
            <p className="inline-flex items-center gap-1 text-[11px]"><Clipboard className="h-3 w-3" /> On mobile: screenshot the chart, then tap here and pick it. Then draw right on it below.</p>
          </div>
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => ingest(e.target.files?.[0])} />
        </div>
      ) : (
        <div className="mt-4 space-y-2">
          {/* Drawing toolbar */}
          <div className="flex flex-wrap items-center gap-2">
            <ToolBtn t="pen" Icon={Pencil} label="Draw" />
            <ToolBtn t="line" Icon={Slash} label="Line" />
            <ToolBtn t="dot" Icon={Circle} label="Dot" />
            <span className="mx-0.5 h-5 w-px bg-[#E7E4DD]" />
            {COLORS.map((c) => (
              <button key={c} onClick={() => setColor(c)} title="Colour"
                className={`h-6 w-6 rounded-full border transition-transform ${color === c ? "scale-110 border-navy" : "border-[#E7E4DD]"}`}
                style={{ backgroundColor: c }} />
            ))}
            <span className="mx-0.5 h-5 w-px bg-[#E7E4DD]" />
            {WIDTHS.map((w, i) => (
              <button key={w} onClick={() => setWidth(w)} title="Thickness"
                className={`grid h-6 w-6 place-items-center rounded-lg ${width === w ? "bg-primary" : "bg-ice"}`}>
                <span className="rounded-full bg-charcoal" style={{ width: 3 + i * 3, height: 3 + i * 3, backgroundColor: width === w ? "#fff" : undefined }} />
              </button>
            ))}
            <span className="mx-0.5 h-5 w-px bg-[#E7E4DD]" />
            <button onClick={undo} disabled={!strokes.length} title="Undo" className="inline-flex items-center gap-1 rounded-lg bg-ice px-2.5 py-1.5 text-xs font-semibold text-charcoal/70 hover:text-charcoal disabled:opacity-40"><Undo2 className="h-3.5 w-3.5" /> Undo</button>
            <button onClick={clearAll} disabled={!strokes.length} title="Clear" className="inline-flex items-center gap-1 rounded-lg bg-ice px-2.5 py-1.5 text-xs font-semibold text-charcoal/70 hover:text-red-600 disabled:opacity-40"><Trash2 className="h-3.5 w-3.5" /> Clear</button>
            <button onClick={() => { setImage(null); setStrokes([]); setRead(null); }} title="Replace image" className="ml-auto inline-flex items-center gap-1 rounded-lg bg-ice px-2.5 py-1.5 text-xs font-semibold text-charcoal/70 hover:text-charcoal"><X className="h-3.5 w-3.5" /> Replace</button>
          </div>

          {/* Image + drawing canvas overlay */}
          <div className="relative mx-auto w-full overflow-hidden rounded-xl border border-[#E7E4DD] bg-[#0b0b0b]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img id="cr-base-img" src={image} alt="Your chart" className="block max-h-[65vh] w-full select-none object-contain" draggable={false} />
            <canvas
              ref={canvasRef}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerLeave={onPointerUp}
              onPointerCancel={onPointerUp}
              className="absolute inset-0 h-full w-full"
              style={{ touchAction: "none" }}
            />
          </div>
          <p className="text-center text-[11px] text-charcoal/45">Draw right on the chart — the mark lands where you touch. <button onClick={downloadMarked} className="inline-flex items-center gap-1 font-semibold text-primary hover:underline"><Download className="h-3 w-3" /> Save image</button></p>
        </div>
      )}

      {/* Symbol + notes */}
      <div className="mt-3 grid gap-3 sm:grid-cols-[180px_1fr]">
        <div>
          <label className="text-[11px] font-semibold uppercase tracking-wide text-charcoal/45">Pair</label>
          <input value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="XAU/USD"
            className="mt-1 w-full rounded-xl border border-[#E7E4DD] bg-white/70 px-3 py-2 text-sm font-semibold text-navy placeholder:text-charcoal/35 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/15" />
        </div>
        <div>
          <label className="text-[11px] font-semibold uppercase tracking-wide text-charcoal/45">What are you seeing? <span className="normal-case text-charcoal/35">(optional)</span></label>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2}
            placeholder="e.g. I marked a bullish break of structure and I'm looking for longs off the 4H order block…"
            className="mt-1 w-full resize-none rounded-xl border border-[#E7E4DD] bg-white/70 px-3 py-2 text-sm text-charcoal placeholder:text-charcoal/35 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/15" />
        </div>
      </div>

      <button onClick={analyze} disabled={!image || loading}
        className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-6 py-3 text-sm font-bold uppercase tracking-wide text-cream transition-opacity hover:opacity-90 disabled:opacity-40 sm:w-auto">
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
          <div className="flex flex-wrap items-center gap-2">
            <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wide ${vStyle.chip}`}><Check className="h-3.5 w-3.5" /> {vStyle.label}</span>
            {bias && <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wide ${bStyle.chip}`}><bStyle.Icon className="h-3.5 w-3.5" /> {bias}</span>}
            {read.confidence && <span className="rounded-full bg-ice px-3 py-1 text-xs font-semibold text-charcoal/70">Confidence: {read.confidence}</span>}
            <span className="ml-auto text-[11px] font-semibold uppercase tracking-wide text-charcoal/40">{resolvedSymbol}</span>
          </div>

          {read.observed && <Block icon={<Eye className="h-4 w-4" />} label="What you drew">{read.observed}</Block>}
          {read.agreement && <Block icon={<Check className="h-4 w-4" />} label="OM AI's take on your read">{read.agreement}</Block>}
          {read.pairRead && <Block icon={<TrendingUp className="h-4 w-4" />} label={`Read on ${resolvedSymbol}`}>{read.pairRead}</Block>}

          {((read.resistance?.length ?? 0) > 0 || (read.support?.length ?? 0) > 0) && (
            <div className="grid gap-3 sm:grid-cols-2">
              <LevelBox label="Resistance" tint="text-red-600" values={read.resistance} />
              <LevelBox label="Support" tint="text-emerald-600" values={read.support} />
            </div>
          )}

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
