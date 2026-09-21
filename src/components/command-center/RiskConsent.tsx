"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ShieldAlert } from "lucide-react";

/**
 * THE RISK DISCLOSURE, SIGNED.
 *
 * This is the one screen in the product that is deliberately not slick. Everything else is built to
 * get out of the way; this is built to be read, and a few of its choices exist specifically to make
 * skipping it harder:
 *
 *   THE SIGN BUTTON DOES NOT ENABLE UNTIL THE TEXT HAS BEEN SCROLLED TO THE END. Not as a trick —
 *   scrolling is not reading — but because a disclosure that can be accepted without it ever having
 *   been on screen is a disclosure nobody involved can honestly say was presented.
 *
 *   THE TEXT COMES FROM THE SERVER, and the same string is hashed into the signature. A client with
 *   its own copy is a client whose copy can drift from the one the record says was agreed to.
 *
 *   BOTH THE BOX AND THE NAME ARE REQUIRED, and the server checks both again. The box says they read
 *   it; the typed name says it was them.
 *
 * None of this is what actually stops an unsigned member trading — the routes do that, and they would
 * do it with this component deleted. This is the part that makes the refusal fair.
 */

const C = {
  panel: "#0B1017", raised: "#0E131C", line: "rgba(255,255,255,0.08)",
  text: "#E8EFF7", mut: "rgba(232,239,247,0.60)", mut2: "rgba(232,239,247,0.34)",
  gold: "#F0C475", down: "#F4737B", up: "#3FD9A0",
};

export type ConsentView = {
  signed: boolean; version: string | null; acceptedAt: number | null;
  signedName: string | null; stale: boolean; currentVersion: string;
};

/**
 * THE TEXT, SET AS A DOCUMENT RATHER THAN AS A STRING.
 *
 * The disclosure is stored with hard line breaks so the hash is stable and the plain text stays
 * readable wherever it ends up — a log, an email, a court exhibit. Rendering it with `pre-wrap` then
 * breaks sentences in the middle of the viewport, which is how a serious document comes to look like
 * a config file. Paragraphs are rejoined and headings picked out instead, so it reads the way it would
 * on paper without the stored text changing at all.
 */
function renderDisclosure(raw: string) {
  const blocks = raw.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  return blocks.map((b, i) => {
    const lines = b.split("\n").map((l) => l.trim());
    const isNumbered = /^\d+\.\s+[A-Z]/.test(lines[0]);
    const heading = isNumbered ? lines[0] : null;
    const body = (isNumbered ? lines.slice(1) : lines).join(" ").replace(/\s{2,}/g, " ");
    const isTitle = i === 0;
    const isFinal = /^BY SIGNING/.test(lines[0]);

    if (isTitle) {
      return (
        <p key={i} className="mb-3 text-[13px] font-bold tracking-tight" style={{ color: C.text }}>{body}</p>
      );
    }
    if (isFinal) {
      return (
        <p key={i} className="mt-4 rounded-xl px-3 py-2.5 text-[12px] font-semibold leading-relaxed"
          style={{ color: C.text, background: "rgba(244,115,123,0.08)", border: "1px solid rgba(244,115,123,0.22)" }}>
          {body}
        </p>
      );
    }
    return (
      <div key={i} className="mb-3">
        {heading && (
          <p className="mb-1 text-[11.5px] font-bold uppercase tracking-[0.06em]" style={{ color: C.gold }}>{heading}</p>
        )}
        {body && <p className="text-[12.5px] leading-relaxed" style={{ color: C.mut }}>{body}</p>}
      </div>
    );
  });
}

export function RiskConsent({ open, onClose, onSigned }: {
  open: boolean;
  onClose: () => void;
  onSigned: (c: ConsentView) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const [consent, setConsent] = useState<ConsentView | null>(null);
  const [name, setName] = useState("");
  const [ticked, setTicked] = useState(false);
  const [readToEnd, setReadToEnd] = useState(false);
  const [stuck, setStuck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const box = useRef<HTMLDivElement | null>(null);
  const tail = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setErr(""); setBusy(false);
    fetch("/api/command-center/consent", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        setText(j.disclosure ?? null);
        setConsent(j.consent ?? null);
        // Re-signing an updated version starts clean: the previous signature was for other words.
        setTicked(false); setReadToEnd(false); setStuck(false);
      })
      .catch(() => setErr("Could not load the disclosure. Nothing has been agreed to."));
  }, [open]);

  /**
   * REACHING THE END, DETECTED FOUR WAYS.
   *
   * This used to hang on a single scroll handler, and when that handler never fired the box, the
   * checkbox, the name field and the sign button were all dead at once — a member staring at a form
   * that could not be filled in and had no way to say so. A gate that can silently fail closed on a
   * legal document is worse than no gate, so the end of the text is now detected by whichever of
   * these happens first, and none of them depends on the others working.
   */
  const onScroll = useCallback(() => {
    const el = box.current;
    if (!el) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 24) setReadToEnd(true);
  }, []);

  // A sentinel at the very end of the text. Fires on wheel, touch, keyboard or programmatic scroll,
  // and fires immediately when the text is short enough that there is no bottom to reach.
  useEffect(() => {
    const el = box.current, end = tail.current;
    if (!open || !text || !el || !end) return;
    const io = new IntersectionObserver(
      (es) => { if (es.some((e) => e.isIntersecting)) setReadToEnd(true); },
      { root: el, threshold: 0.01 },
    );
    io.observe(end);
    return () => io.disconnect();
  }, [open, text]);

  // If the pane cannot scroll at all — a layout the text outgrew, a browser that clips instead of
  // scrolling — there is no end to reach and the gate must not hold the member hostage.
  useEffect(() => {
    const el = box.current;
    if (!open || !text || !el) return;
    const check = () => {
      if (el.scrollHeight <= el.clientHeight + 24) { setReadToEnd(true); return; }
      setStuck(el.clientHeight < 80);
    };
    const raf = requestAnimationFrame(check);
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(check) : null;
    if (ro) { ro.observe(el); for (const c of Array.from(el.children)) ro.observe(c); }
    window.addEventListener("resize", check);
    return () => { cancelAnimationFrame(raf); ro?.disconnect(); window.removeEventListener("resize", check); };
  }, [open, text]);

  const submit = useCallback(async () => {
    setBusy(true); setErr("");
    try {
      const r = await fetch("/api/command-center/consent", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ signedName: name, acknowledged: ticked }),
      });
      const j = await r.json();
      setBusy(false);
      if (!j.ok) { setErr(j.reason ?? "That could not be recorded, so it has not been accepted."); return; }
      onSigned(j.consent);
      onClose();
    } catch {
      setBusy(false);
      setErr("That could not be recorded, so it has not been accepted.");
    }
  }, [name, ticked, onSigned, onClose]);

  if (!open) return null;
  const ready = readToEnd && ticked && name.trim().length >= 3 && !busy;

  return (
    <div className="fixed inset-0 z-[130] flex items-center justify-center p-3"
      style={{ background: "rgba(3,6,11,0.82)", backdropFilter: "blur(4px)" }}>
      <section className="flex max-h-[92vh] w-full max-w-[560px] flex-col overflow-hidden rounded-2xl border"
        style={{ borderColor: "rgba(244,115,123,0.30)", background: C.panel, color: C.text }}>

        <div className="flex items-center gap-2 border-b px-4 py-3" style={{ borderColor: C.line }}>
          <ShieldAlert className="h-4 w-4" style={{ color: C.down }} />
          <p className="text-[11px] font-bold uppercase tracking-[0.18em]" style={{ color: C.down }}>
            Risk disclosure — required before trading
          </p>
        </div>

        {consent?.stale && (
          <p className="border-b px-4 py-2.5 text-[12px]" style={{ borderColor: C.line, color: C.gold }}>
            This has been updated since you last signed it. Please read it again.
          </p>
        )}

        <div ref={box} onScroll={onScroll}
          className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
          style={{ background: C.raised }}>
          {text ? renderDisclosure(text) : <p className="text-[12.5px]" style={{ color: C.mut2 }}>Loading…</p>}
          <div ref={tail} aria-hidden style={{ height: 1 }} />
        </div>

        <div className="border-t px-4 py-3" style={{ borderColor: C.line }}>
          {!readToEnd && (
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <p className="text-[11.5px]" style={{ color: C.mut2 }}>
                Scroll to the end of the disclosure to continue.
              </p>
              <button
                type="button"
                onClick={() => {
                  const el = box.current;
                  if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
                  // If the pane will not scroll, the member must still be able to reach the end.
                  if (!el || el.scrollHeight <= el.clientHeight + 24 || stuck) setReadToEnd(true);
                }}
                className="rounded-lg px-2.5 py-1 text-[11px] font-semibold"
                style={{ background: "rgba(240,196,117,0.12)", color: C.gold, border: "1px solid rgba(240,196,117,0.28)" }}
              >
                Jump to the end
              </button>
            </div>
          )}

          <label className="flex cursor-pointer items-start gap-2.5 text-[12.5px] leading-snug" style={{ color: C.text }}>
            <input type="checkbox" checked={ticked} disabled={!readToEnd}
              onChange={(e) => setTicked(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-[#F0C475]" />
            <span>
              I have read and understood this disclosure. I accept that I can lose money, including all
              of the money in my account, and I am making my own trading decisions.
            </span>
          </label>

          <div className="mt-2.5">
            <p className="text-[10px] font-bold uppercase tracking-[0.16em]" style={{ color: C.mut2 }}>
              Type your full name to sign
            </p>
            <input value={name} onChange={(e) => setName(e.target.value)} disabled={!readToEnd}
              placeholder="Full name"
              className="mt-1 w-full rounded-xl px-3 py-2 text-[13px] outline-none disabled:opacity-40"
              style={{ background: C.raised, color: C.text, border: `1px solid ${C.line}` }} />
          </div>

          {err && <p className="mt-2 text-[12px]" style={{ color: C.down }}>{err}</p>}

          <div className="mt-3 flex gap-2">
            <button onClick={submit} disabled={!ready}
              className="flex-1 rounded-xl px-3 py-2.5 text-[11px] font-bold uppercase tracking-[0.14em] disabled:opacity-35"
              style={{ background: "rgba(63,217,160,0.16)", color: C.up, border: "1px solid rgba(63,217,160,0.34)" }}>
              {busy ? "Recording…" : "Sign and continue"}
            </button>
            <button onClick={onClose} disabled={busy}
              className="rounded-xl px-3.5 py-2.5 text-[11px] font-bold uppercase tracking-[0.14em]"
              style={{ background: "rgba(255,255,255,0.04)", color: C.mut, border: `1px solid ${C.line}` }}>
              Not now
            </button>
          </div>

          <p className="mt-2 text-[10.5px] leading-relaxed" style={{ color: C.mut2 }}>
            Declining is fine — you can read the market and talk to ATLAS without signing. You
            cannot connect a broker, place a trade or enable automation until you have.
          </p>
        </div>
      </section>
    </div>
  );
}

export default RiskConsent;
