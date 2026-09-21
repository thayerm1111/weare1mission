"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { BrainOrb } from "./BrainOrb";
import { H } from "./theme";

/**
 * ENTERING THE COMMAND CENTER (owner 09-21).
 *
 * "Like you're entering a real command center and ATLAS greets you, then gives you a quick update on
 * recent gold moves." Part of what the 5-credit window buys; shown once per window.
 *
 *   0.0s  boot       the room powers up: grid, scan line, secure-link lines typing in
 *   1.2s  core       the ATLAS core materialises; systems check off one by one from REAL state
 *   4.4s  online     ATLAS ONLINE, and it greets the member by name
 *   6.2s  brief      the gold update, typed out while the core "speaks"
 *   end   enter      a beat to read it, then the desk
 *
 * Every figure in the brief comes from the same live read the desk shows — price, the day's change
 * and range, the last hour's move, pressure, the nearest levels, ATLAS's thesis. Nothing is invented
 * and nothing is a forecast. Skip is always available.
 */
type Live = {
  live?: boolean; marketOpen?: boolean; price?: number | null; session?: string;
  timeframes?: Record<string, unknown>;
  changes?: { horizon: string; priceMove: number }[];
  thesis?: { label?: string; confidence?: number } | null;
  brain?: { headline?: string } | null;
  setup?: { state?: string; side?: string | null; style?: string | null; metCount?: number; totalCount?: number } | null;
  intel?: {
    day?: { high: number; low: number; open: number; change: number; range: number; changePct: number } | null;
    pressure?: { buyers: number; sellers: number } | null;
    keyLevels?: { price: number; label: string }[];
    liquidity?: { above: unknown[]; below: unknown[] } | null;
    structure?: { sequence?: string } | null;
    news?: { name: string; inMin?: number } | null;
  } | null;
};

const money = (v: number) => v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function greetingWord(): string {
  const h = new Date().getHours();
  return h < 5 ? "Good evening" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

/** The spoken-style gold update, from real numbers only. */
export function composeBrief(d: Live | null): string[] {
  if (!d || typeof d.price !== "number") return ["I can't see a live read yet — the desk will fill in as the feed arrives."];
  const L: string[] = [];
  const day = d.intel?.day;
  const closed = d.marketOpen === false;
  if (day) {
    const dir = day.change >= 0 ? "up" : "down";
    L.push(`${closed ? "Gold is closed at" : "Gold is at"} ${money(d.price)} — ${dir} $${Math.abs(day.change).toFixed(2)} on the day (${day.changePct >= 0 ? "+" : ""}${day.changePct.toFixed(2)}%), inside a $${day.range.toFixed(2)} range.`);
  } else {
    L.push(`${closed ? "Gold is closed at" : "Gold is at"} ${money(d.price)}.`);
  }
  const ch = d.changes ?? [];
  const recent = ch.find((c) => c.horizon === "1h") ?? ch.find((c) => c.horizon === "15m") ?? ch[0];
  if (recent && !closed) {
    const span = recent.horizon === "1h" ? "the last hour" : recent.horizon === "15m" ? "the last fifteen minutes" : `the last ${recent.horizon}`;
    L.push(Math.abs(recent.priceMove) < 1
      ? `It has barely moved over ${span}.`
      : `Over ${span} it has ${recent.priceMove > 0 ? "gained" : "given up"} $${Math.abs(recent.priceMove).toFixed(2)}.`);
  }
  const p = d.intel?.pressure;
  if (p) {
    const side = p.sellers > 55 ? "sellers are in control" : p.buyers > 55 ? "buyers are in control" : "neither side has control";
    L.push(`Pressure reads buyers ${p.buyers}, sellers ${p.sellers} — ${side}.`);
  }
  const lv = d.intel?.keyLevels ?? [];
  const above = lv.filter((l) => l.price > d.price!).sort((a, b) => a.price - b.price)[0];
  const below = lv.filter((l) => l.price < d.price!).sort((a, b) => b.price - a.price)[0];
  if (above || below) {
    L.push([
      above ? `Resistance ${money(above.price)} (${above.label})` : null,
      below ? `support ${money(below.price)} (${below.label})` : null,
    ].filter(Boolean).join("; ").replace(/^s/, "S") + ".");
  }
  const th = d.thesis;
  if (th?.label) L.push(`My read: ${th.label.toLowerCase()}${typeof th.confidence === "number" ? `, ${th.confidence}% conviction` : ""}.${d.brain?.headline ? ` ${d.brain.headline}` : ""}`);
  const su = d.setup;
  if (su && (su.state === "developing" || su.state === "armed" || su.state === "ready") && su.side) {
    L.push(`I'm tracking a ${su.side.toUpperCase()} ${su.style ? su.style + " " : ""}setup${su.totalCount ? ` — ${su.metCount}/${su.totalCount} conditions met` : ""}.`);
  }
  if (d.intel?.news?.name) L.push(`On the calendar: ${d.intel.news.name}.`);
  return L;
}

/* ── the spoken welcome ─────────────────────────────────────────────────────── */

/** One AudioContext, created inside the tap that opened the Command Center — browsers only let audio
 *  start from a user gesture, and the entrance plays after an await. */
let sharedCtx: AudioContext | null = null;
export function primeAudio(): void {
  try {
    const W = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
    const Ctx = W.AudioContext ?? W.webkitAudioContext; if (!Ctx) return;
    if (!sharedCtx || sharedCtx.state === "closed") sharedCtx = new Ctx();
    void sharedCtx.resume();
  } catch { /* no audio: the words are still on screen */ }
}

type Greet = { eligible: boolean; name: string | null; voice?: boolean;
  accounts: { liveCount: number; liveTotal: number; demoCount: number; demoTotal: number; asOf: string | null } | null };

const usd = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;
export function accountLine(g: Greet | null): string | null {
  const a = g?.accounts; if (!a) return null;
  const parts: string[] = [];
  if (a.liveCount) parts.push(`your ${a.liveCount === 1 ? "live account holds" : `${a.liveCount} live accounts hold`} ${usd(a.liveTotal)}`);
  if (a.demoCount) parts.push(`${a.demoCount === 1 ? "your demo holds" : `${a.demoCount} demo accounts hold`} ${usd(a.demoTotal)}`);
  if (!parts.length) return null;
  const s = parts.join(", and ");
  return s.charAt(0).toUpperCase() + s.slice(1) + ".";
}

/** Plays the welcome through the voice agent: its first message IS the welcome. Returns a stopper. */
function speakWelcome(url: string, text: string, on: { level: (v: number) => void; started: () => void; ended: () => void }): () => void {
  const ctx = sharedCtx;
  let closed = false, playHead = 0, lastAudioAt = 0, sawResponse = false;
  const ws = new WebSocket(url);
  const finish = () => { if (closed) return; closed = true; try { ws.close(); } catch { /* noop */ } on.ended(); };
  ws.onopen = () => ws.send(JSON.stringify({ type: "conversation_initiation_client_data", conversation_config_override: { agent: { first_message: text } } }));
  ws.onmessage = (ev) => {
    let m: Record<string, unknown>; try { m = JSON.parse(String(ev.data)); } catch { return; }
    if (m.type === "ping") { ws.send(JSON.stringify({ type: "pong", event_id: (m.ping_event as { event_id?: number })?.event_id })); return; }
    if (m.type === "agent_response") { sawResponse = true; return; }
    if (m.type !== "audio" || !ctx) return;
    const b64 = (m.audio_event as { audio_base_64?: string })?.audio_base_64; if (!b64) return;
    const bin = atob(b64); const n = bin.length >> 1; const pcm = new Float32Array(n);
    let peak = 0;
    for (let i = 0; i < n; i++) { let v = bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8); if (v >= 32768) v -= 65536; pcm[i] = v / 32768; if (i % 8 === 0) peak = Math.max(peak, Math.abs(pcm[i])); }
    const buf = ctx.createBuffer(1, n, 16000); buf.copyToChannel(pcm, 0);
    const src = ctx.createBufferSource(); src.buffer = buf; src.connect(ctx.destination);
    const at = Math.max(ctx.currentTime + 0.05, playHead); src.start(at); playHead = at + buf.duration;
    if (!lastAudioAt) on.started();
    lastAudioAt = performance.now();
    window.setTimeout(() => on.level(Math.min(1, peak * 2.2)), Math.max(0, (at - ctx.currentTime) * 1000));
  };
  ws.onerror = finish; ws.onclose = () => { if (!closed) { closed = true; on.ended(); } };
  // Hang up once the welcome has been said and the last chunk has played out.
  const iv = window.setInterval(() => {
    if (closed) { window.clearInterval(iv); return; }
    const drained = !ctx || ctx.currentTime > playHead + 0.3;
    if (lastAudioAt && sawResponse && drained && performance.now() - lastAudioAt > 1200) { window.clearInterval(iv); finish(); }
  }, 250);
  const cap = window.setTimeout(finish, 75_000);
  return () => { window.clearInterval(iv); window.clearTimeout(cap); finish(); };
}

export function EntrySequence({ onDone, speak = false }: { onDone: () => void; speak?: boolean }) {
  const [t, setT] = useState(0);
  const [d, setD] = useState<Live | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const start = useRef(0);
  const [w, setW] = useState(1200);
  // when the live read arrived (ms into the sequence); the update waits for it, up to four seconds
  const [dAt, setDAt] = useState<number | null>(null);
  const [greet, setGreet] = useState<Greet | null>(null);
  // spoken welcome: idle → connecting → speaking → done (or 'blocked' when the browser needs a tap)
  const [voice, setVoice] = useState<"idle" | "connecting" | "speaking" | "done" | "blocked" | "off">(speak ? "idle" : "off");
  const [vLevel, setVLevel] = useState(0);
  const [spokeAt, setSpokeAt] = useState<number | null>(null);
  const stopVoice = useRef<(() => void) | null>(null);

  useEffect(() => {
    setW(window.innerWidth);
    start.current = performance.now();
    let raf = 0;
    const tick = () => { setT(performance.now() - start.current); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    fetch("/api/command-center/live", { cache: "no-store" }).then((r) => r.json()).then((j) => { setD(j); setDAt(performance.now() - start.current); }).catch(() => setDAt(0));
    fetch("/api/command-center/greet", { cache: "no-store" }).then((r) => r.json()).then((j: Greet) => { setGreet(j); setName(j?.name ?? null); }).catch(() => setGreet(null));
    return () => cancelAnimationFrame(raf);
  }, []);

  const phone = w < 640;
  const brief = useMemo(() => composeBrief(d), [d]);
  const acctLine = accountLine(greet);
  const briefText = [acctLine, ...brief].filter(Boolean).join(" ");
  const T_CORE = 1200, T_ONLINE = 4400;
  const spoken = voice === "speaking" || voice === "done";
  // Spoken: the words appear at speaking pace, starting with the voice. Silent: a quick type-out.
  const CPS = spoken ? 15 : 52;
  const T_BRIEF = spoken && spokeAt != null ? spokeAt : dAt != null ? Math.max(6200, dAt + 200) : 10200;
  const waitingOnVoice = voice === "idle" || voice === "connecting";
  const typedRaw = t > T_BRIEF && !waitingOnVoice ? Math.min(briefText.length, Math.floor(((t - T_BRIEF) / 1000) * CPS)) : 0;
  const typed = voice === "done" ? briefText.length : typedRaw;
  const briefDone = !waitingOnVoice && t > T_BRIEF && typed >= briefText.length && voice !== "speaking" && voice !== "blocked";
  const doneAt = useRef<number | null>(null);
  if (briefDone && doneAt.current == null) doneAt.current = t;

  const leave = () => { if (leaving) return; stopVoice.current?.(); setLeaving(true); window.setTimeout(onDone, 700); };

  const welcomeSpoken = `${greetingWord()}${name ? `, ${name}` : ""}. ATLAS online. ${briefText}`;
  const startVoice = () => {
    if (!sharedCtx || sharedCtx.state !== "running") { setVoice("blocked"); return; }
    setVoice("connecting");
    fetch("/api/command-center/greet", { method: "POST" }).then((r) => r.json()).then((j) => {
      if (!j?.url) { setVoice("off"); return; }
      stopVoice.current = speakWelcome(j.url, welcomeSpoken, {
        level: (v) => setVLevel(v),
        started: () => { setVoice("speaking"); setSpokeAt(performance.now() - start.current); },
        ended: () => { setVLevel(0); setVoice((v) => (v === "speaking" ? "done" : "off")); },
      });
    }).catch(() => setVoice("off"));
  };
  // Ready when the live read and the member's details are in, and the room has come up.
  useEffect(() => {
    if (voice !== "idle" || t < 3600 || dAt == null || greet === null) return;
    if (!greet.eligible || greet.voice === false) { setVoice("off"); return; }
    startVoice();
  });
  useEffect(() => () => { stopVoice.current?.(); }, []);
  useEffect(() => { if (doneAt.current != null && t - doneAt.current > 2600) leave(); });
  const toned = useRef(false);
  useEffect(() => { if (t > T_ONLINE && !toned.current) { toned.current = true; tone([392, 587, 784]); } }, [t]);

  // the systems that check off — each from the live read
  const tfCount = Object.keys(d?.timeframes ?? {}).length;
  const lvCount = (d?.intel?.liquidity?.above.length ?? 0) + (d?.intel?.liquidity?.below.length ?? 0);
  const checks: [string, string][] = [
    ["MARKET FEED", d ? (d.live ? `LIVE · ${typeof d.price === "number" ? money(d.price) : "—"}` : d.marketOpen === false ? "MARKET CLOSED" : "DELAYED") : "CONNECTING"],
    ["TIMEFRAMES", tfCount ? `${tfCount} SYNCHRONISED` : "SYNCING"],
    ["LIQUIDITY MAP", lvCount ? `${lvCount} LEVELS MAPPED` : "MAPPING"],
    ["STRUCTURE", (d?.intel?.structure?.sequence ?? "READING").toUpperCase()],
    ["NEWS WATCH", d?.intel?.news?.name ? d.intel.news.name.toUpperCase().slice(0, 22) : "CALENDAR CLEAR"],
    ["RISK ENGINE", "ONLINE"],
  ];
  const shown = Math.max(0, Math.min(checks.length, Math.floor((t - T_CORE - 500) / 420)));

  const bootLines = ["OM // COMMAND CENTER XAUUSD", "SECURE LINK ESTABLISHED", `OPERATOR: ${(name ?? "MEMBER").toUpperCase()}`, "WAKING ATLAS…"];
  const bootShown = Math.min(bootLines.length, Math.floor(t / 300) + 1);
  const coreIn = Math.max(0, Math.min(1, (t - T_CORE) / 900));
  const online = t > T_ONLINE;
  const speaking = voice === "speaking" || (voice === "off" && t > T_BRIEF && !briefDone);
  const level = voice === "speaking" ? vLevel : speaking ? 0.35 + 0.35 * Math.abs(Math.sin(t / 90)) * Math.abs(Math.sin(t / 233)) : online ? 0.12 : 0;
  const glitch = online && t < T_ONLINE + 500;

  return (
    <div className="fixed inset-0 z-[200] overflow-hidden" role="dialog" aria-label="Entering the Command Center"
      style={{ background: H.bg0, color: H.text, opacity: leaving ? 0 : 1, transition: "opacity .7s ease", fontFamily: "Inter, system-ui, sans-serif" }}>
      <style>{ENTRY_CSS}</style>
      {/* the room: perspective grid floor, vignette, scan line */}
      <div className="es-grid" style={{ opacity: Math.min(1, t / 900) }} />
      <div className="es-vignette" />
      <div className="es-scan" />
      {/* corner brackets */}
      {["tl", "tr", "bl", "br"].map((c) => <span key={c} className={`es-corner es-${c}`} style={{ opacity: Math.min(1, t / 600) }} />)}

      {/* boot text */}
      <div className="absolute left-7 top-7 font-mono text-[10px] leading-[1.7] sm:left-10 sm:top-10 sm:text-[11px]" style={{ color: H.cyan2 }}>
        {bootLines.slice(0, bootShown).map((l, i) => <div key={i} className="es-type">{">"} {l}</div>)}
      </div>
      <button onClick={leave} className="absolute right-7 top-7 z-20 rounded-md px-3 py-1.5 text-[11px] tracking-[0.18em] sm:right-10 sm:top-10"
        style={{ color: H.mut, border: `1px solid ${H.line}`, background: "rgba(3,7,11,0.6)" }}>SKIP ›</button>

      <div className="relative z-10 flex h-full flex-col items-center justify-center px-4">
        {/* core */}
        <div style={{ transform: `scale(${0.4 + coreIn * 0.6})`, opacity: coreIn, filter: glitch ? "brightness(1.8) contrast(1.2)" : "none", transition: "filter .1s" }}>
          <BrainOrb state={speaking ? "speaking" : online ? "watching" : "analyzing"} intensity={60} alive pulseKey={online ? "on" : "off"}
            size={phone ? 200 : 280} voice={{ mode: speaking ? "speaking" : online ? "listening" : "connecting", level }} />
        </div>

        {/* systems check */}
        {t > T_CORE + 300 && (
          <ul className={`mt-3 grid gap-x-8 gap-y-1 font-mono text-[10px] sm:text-[11px] ${phone ? "grid-cols-1" : "grid-cols-2"}`} style={{ minWidth: phone ? 260 : 520 }}>
            {checks.map(([k, v], i) => (
              <li key={k} className="flex items-center justify-between gap-4" style={{ opacity: i < shown ? 1 : 0.18, transition: "opacity .3s" }}>
                <span style={{ color: H.mut }}>{k}</span>
                <span style={{ color: i < shown ? H.cyan2 : H.mut2 }}>{i < shown ? `✓ ${v}` : "…"}</span>
              </li>
            ))}
          </ul>
        )}

        {/* ATLAS ONLINE + greeting */}
        <div className="mt-5 text-center" style={{ minHeight: 70 }}>
          {online && (
            <>
              <p className={`text-[26px] font-semibold tracking-[0.42em] sm:text-[34px] ${glitch ? "es-glitch" : "es-rise"}`} style={{ color: H.gold3, textShadow: "0 0 24px rgba(255,216,117,.45)" }}>
                ATLAS ONLINE
              </p>
              <p className="es-rise mt-1 text-[14px] sm:text-[16px]" style={{ color: H.text }}>
                {greetingWord()}{name ? `, ${name}` : ""}. Here&rsquo;s where gold stands.
              </p>
            </>
          )}
        </div>

        {voice === "blocked" && (
          <button onClick={() => { primeAudio(); setVoice("idle"); }} className="es-rise mb-1 rounded-full px-4 py-2 text-[12px] font-semibold tracking-[0.16em]"
            style={{ color: H.gold3, border: "1px solid rgba(231,196,103,.55)", background: "rgba(213,169,61,.12)" }}>🔊 TAP TO HEAR ATLAS</button>
        )}
        {voice === "connecting" && <p className="mb-1 font-mono text-[10px] tracking-[0.2em]" style={{ color: H.cyan2 }}>OPENING VOICE CHANNEL…</p>}
        {/* the brief */}
        <div className="mt-3 w-full max-w-[640px] rounded-xl px-4 py-3 text-left text-[13.5px] leading-relaxed sm:text-[15px]"
          style={{ minHeight: phone ? 150 : 120, border: t > T_BRIEF ? `1px solid ${H.lineHi}` : "1px solid transparent", background: t > T_BRIEF ? "rgba(7,16,26,0.78)" : "transparent", transition: "all .4s" }}>
          {t > T_BRIEF && (
            <>
              <p className="mb-1 font-mono text-[9.5px] tracking-[0.2em]" style={{ color: H.gold2 }}>ATLAS · GOLD UPDATE</p>
              <p style={{ color: "#DDE6EE" }}>{briefText.slice(0, typed)}{!briefDone && <span className="es-caret">▍</span>}</p>
            </>
          )}
        </div>

        {(briefDone || (voice === "blocked" && typed >= briefText.length && t > T_BRIEF)) && (
          <button onClick={leave} className="es-rise mt-4 rounded-lg px-6 py-2.5 text-[13px] font-semibold tracking-[0.2em]"
            style={{ background: H.gold2, color: "#10131A", boxShadow: "0 0 24px rgba(231,196,103,.35)" }}>ENTER THE DESK</button>
        )}
      </div>
    </div>
  );
}

/** A soft tone from the Web Audio API. Silent if the browser won't play without a tap. */
function tone(freqs: number[]) {
  try {
    const W = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
    const Ctx = W.AudioContext ?? W.webkitAudioContext; if (!Ctx) return;
    const ctx = new Ctx(); if (ctx.state === "suspended") { void ctx.close(); return; }
    const t0 = ctx.currentTime;
    freqs.forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = "sine"; o.frequency.value = f;
      g.gain.setValueAtTime(0, t0 + i * 0.12); g.gain.linearRampToValueAtTime(0.05, t0 + i * 0.12 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.12 + 0.5);
      o.connect(g); g.connect(ctx.destination); o.start(t0 + i * 0.12); o.stop(t0 + i * 0.12 + 0.55);
    });
    window.setTimeout(() => { void ctx.close().catch(() => {}); }, 1400);
  } catch { /* the words still say it */ }
}

const ENTRY_CSS = `
.es-grid{position:absolute;left:-50%;right:-50%;bottom:-10%;height:62%;transform:perspective(420px) rotateX(62deg);transform-origin:50% 100%;
  background-image:linear-gradient(rgba(39,215,242,.22) 1px,transparent 1px),linear-gradient(90deg,rgba(39,215,242,.22) 1px,transparent 1px);
  background-size:48px 48px;animation:es-grid 2.4s linear infinite;mask-image:linear-gradient(to top,#000 20%,transparent 95%);-webkit-mask-image:linear-gradient(to top,#000 20%,transparent 95%)}
@keyframes es-grid{from{background-position:0 0}to{background-position:0 48px}}
.es-vignette{position:absolute;inset:0;background:radial-gradient(60% 55% at 50% 45%,rgba(0,199,232,.08),transparent 70%),radial-gradient(120% 90% at 50% 50%,transparent 55%,rgba(0,0,0,.85))}
.es-scan{position:absolute;left:0;right:0;height:120px;top:-120px;background:linear-gradient(to bottom,transparent,rgba(39,215,242,.10),transparent);animation:es-scan 2.8s ease-in-out infinite}
@keyframes es-scan{0%{top:-120px}100%{top:100%}}
.es-corner{position:absolute;width:34px;height:34px;border-color:rgba(39,215,242,.55);transition:opacity .6s}
.es-tl{left:12px;top:12px;border-left:2px solid;border-top:2px solid}.es-tr{right:12px;top:12px;border-right:2px solid;border-top:2px solid}
.es-bl{left:12px;bottom:12px;border-left:2px solid;border-bottom:2px solid}.es-br{right:12px;bottom:12px;border-right:2px solid;border-bottom:2px solid}
.es-type{animation:es-in .25s ease-out both}
@keyframes es-in{from{opacity:0;transform:translateX(-6px)}to{opacity:1;transform:none}}
.es-rise{animation:es-rise .6s cubic-bezier(.2,.9,.2,1) both}
@keyframes es-rise{from{opacity:0;transform:translateY(8px);letter-spacing:.6em}to{opacity:1;transform:none}}
.es-glitch{animation:es-glitch .5s steps(2) both}
@keyframes es-glitch{0%{opacity:0;clip-path:inset(40% 0 40% 0);transform:translateX(-6px)}30%{opacity:1;clip-path:inset(10% 0 60% 0);transform:translateX(5px)}60%{clip-path:inset(60% 0 5% 0);transform:translateX(-3px)}100%{clip-path:inset(0);transform:none}}
.es-caret{animation:es-blink .8s steps(1) infinite;color:#FFD875}
@keyframes es-blink{50%{opacity:0}}
@media (prefers-reduced-motion: reduce){.es-grid,.es-scan{animation:none}}
`;
