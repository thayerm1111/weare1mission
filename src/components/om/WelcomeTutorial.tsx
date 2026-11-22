"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { ArrowRight, BookOpen, Check, Pause, Play, RotateCcw, X } from "lucide-react";
import { WELCOME_TUTORIAL } from "@/lib/onboarding/welcome";
import { reserveWelcome, useEntryPrompts } from "@/lib/onboarding/entry";
import { useAtlasPanel } from "./atlas/AtlasProvider";
import "./welcome-tutorial.css";

const OPEN_EVENT = "om:welcome:open";
const READ_TIMEOUT_MS = 8_000;
const API = "/api/portal/announcement";
const sessionKey = (memberId: string) => `om:welcome:${WELCOME_TUTORIAL.key}:${encodeURIComponent(memberId)}`;
const sessionSeen = (memberId: string) => { try { return sessionStorage.getItem(sessionKey(memberId)) === "1"; } catch { return false; } };
const rememberVisit = (memberId: string) => { try { sessionStorage.setItem(sessionKey(memberId), "1"); } catch { /* A blocked store does not block the app. */ } };
const clock = (seconds: number) => `${Math.floor(Math.max(0, seconds) / 60)}:${String(Math.floor(Math.max(0, seconds) % 60)).padStart(2, "0")}`;

/** Replay the same welcome in place. Opening it does not use a trading or voice service. */
export function openWelcomeTutorial() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(OPEN_EVENT));
}

/** One welcome per authenticated member, with replay independent of the first-visit read. */
export function WelcomeTutorial({ memberId, configured = true, auto = true }: {
  memberId?: string | null; configured?: boolean; auto?: boolean;
}) {
  const id = memberId ?? "", enabled = configured && !!id;
  const path = usePathname(), search = useSearchParams().toString();
  const route = `${path ?? ""}?${search}`;
  const entry = useEntryPrompts(id);
  const atlas = useAtlasPanel();
  const current = useRef({ id, enabled }); current.current = { id, enabled };
  const mounted = useRef(false), generation = useRef(0);
  const release = useRef<(() => void) | null>(null);
  const cancelRead = useRef<(() => void) | null>(null);
  const persist = useRef<{ id: string; controller: AbortController } | null>(null);
  const acknowledged = useRef(new Set<string>());
  const [request, setRequest] = useState<{ id: string; replay: boolean; serial: number } | null>(null);
  const [visible, setVisible] = useState(true);
  const serial = useRef(0), lastRoute = useRef(route);
  const isCurrent = (owner: string) => mounted.current && current.current.enabled && current.current.id === owner;
  const free = useCallback(() => { release.current?.(); release.current = null; }, []);
  const reserve = useCallback((owner: string) => { if (!release.current) release.current = reserveWelcome(owner); }, []);
  const stopRead = useCallback(() => { generation.current += 1; cancelRead.current?.(); cancelRead.current = null; }, []);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; stopRead(); persist.current?.controller.abort(); free(); };
  }, [free, stopRead]);

  useEffect(() => {
    stopRead(); free(); persist.current?.controller.abort(); persist.current = null; setRequest(null);
    if (!enabled || !auto || sessionSeen(id)) return;
    reserve(id);
    const mine = generation.current, controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error("Welcome status timed out")); }, READ_TIMEOUT_MS);
      cancelRead.current = () => { if (timer != null) clearTimeout(timer); controller.abort(); reject(new Error("Welcome status cancelled")); };
    });
    void (async () => {
      try {
        const response = await Promise.race([fetch(`${API}?key=${encodeURIComponent(WELCOME_TUTORIAL.key)}`, {
          cache: "no-store", headers: { "x-portal-member": id }, signal: controller.signal,
        }), deadline]);
        const answer = await Promise.race([response.json(), deadline]);
        if (!isCurrent(id) || mine !== generation.current) return;
        if (!response.ok || answer?.ok !== true || answer.memberId !== id || typeof answer.seen !== "boolean") throw new Error("Welcome status unavailable");
        if (answer.seen || sessionSeen(id)) { free(); return; }
        setRequest({ id, replay: false, serial: ++serial.current });
      } catch {
        // A failed read never claims the tutorial was seen. Replay remains available in the account menu.
        if (isCurrent(id) && mine === generation.current) free();
      } finally {
        if (timer != null) clearTimeout(timer);
        if (mine === generation.current) cancelRead.current = null;
      }
    })();
    return () => { stopRead(); free(); };
  }, [id, enabled, auto, free, reserve, stopRead]);

  useEffect(() => {
    if (!enabled) return;
    const replay = () => {
      if (!isCurrent(id)) return;
      stopRead(); reserve(id);
      setRequest({ id, replay: true, serial: ++serial.current });
    };
    window.addEventListener(OPEN_EVENT, replay);
    return () => window.removeEventListener(OPEN_EVENT, replay);
  }, [id, enabled, reserve, stopRead]);

  useEffect(() => {
    const read = () => setVisible(document.visibilityState !== "hidden");
    read(); document.addEventListener("visibilitychange", read);
    return () => document.removeEventListener("visibilitychange", read);
  }, []);
  useEffect(() => {
    if (lastRoute.current === route) return;
    lastRoute.current = route;
    stopRead(); setRequest(null); free();
  }, [route, free, stopRead]);

  function markSeen(owner: string) {
    if (!isCurrent(owner) || acknowledged.current.has(owner)) return;
    acknowledged.current.add(owner); rememberVisit(owner);
    const controller = new AbortController();
    persist.current = { id: owner, controller };
    // Session storage is a fallback for this visit only. The server is the cross-device source of truth.
    void fetch(API, {
      method: "POST", headers: { "content-type": "application/json", "x-portal-member": owner },
      body: JSON.stringify({ key: WELCOME_TUTORIAL.key, expectedMemberId: owner }), signal: controller.signal,
    }).catch(() => {}).finally(() => { if (persist.current?.controller === controller) persist.current = null; });
  }
  function dismiss(owner: string) {
    if (!isCurrent(owner)) return;
    markSeen(owner); stopRead(); setRequest(null); free();
  }
  const active = enabled && request?.id === id ? request : null;
  if (!active) return null;
  return <WelcomeTutorialPlayer key={`${active.id}:${active.serial}`} open={entry.canShowWelcome && !atlas.open && visible}
    replay={active.replay} onClose={() => dismiss(active.id)} onComplete={() => markSeen(active.id)} />;
}

/** A static, narrated tutorial. Its only media source is the versioned video asset. */
export function WelcomeTutorialPlayer({ open, replay = false, onClose, onComplete }: {
  open: boolean; replay?: boolean; onClose: () => void; onComplete: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null), video = useRef<HTMLVideoElement>(null);
  const playButton = useRef<HTMLButtonElement>(null), origin = useRef<HTMLElement | null>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const seekTo = useRef<number | null>(null);
  const [playing, setPlaying] = useState(false), [started, setStarted] = useState(false), [ended, setEnded] = useState(false);
  const [failed, setFailed] = useState(false), [playError, setPlayError] = useState(false);
  const [transcript, setTranscript] = useState(false), [reduced, setReduced] = useState(false), [time, setTime] = useState(0);
  const chapter = WELCOME_TUTORIAL.chapters.find((item) => time >= item.start && time < item.end) ?? WELCOME_TUTORIAL.chapters[WELCOME_TUTORIAL.chapters.length - 1];

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const read = () => { setReduced(media.matches); if (media.matches) { setTranscript(true); video.current?.pause(); } };
    read(); media.addEventListener?.("change", read);
    return () => media.removeEventListener?.("change", read);
  }, []);

  useEffect(() => {
    const element = dialog.current, player = video.current;
    if (!element || !open) { player?.pause(); return; }
    const active = document.activeElement;
    origin.current = active instanceof HTMLElement && active !== document.body && active.isConnected ? active : document.querySelector<HTMLElement>("[data-om-account-trigger]");
    if (!element.open) element.showModal();
    document.documentElement.classList.add("om-welcome-open");
    playButton.current?.focus({ preventScroll: true });
    return () => {
      player?.pause();
      if (element.open) element.close();
      document.documentElement.classList.remove("om-welcome-open");
      const next = Array.from(document.querySelectorAll<HTMLElement>('dialog[open], [role="dialog"][aria-modal="true"]'))
        .some((item) => item !== element && item.getClientRects().length > 0 && !item.closest("[hidden], [inert]"));
      if (!next) {
        const back = origin.current?.isConnected ? origin.current : document.querySelector<HTMLElement>("[data-om-account-trigger]");
        back?.focus({ preventScroll: true });
      }
    };
  }, [open]);
  useEffect(() => {
    const player = video.current;
    const pause = () => { if (document.visibilityState === "hidden") player?.pause(); };
    const leave = () => player?.pause();
    document.addEventListener("visibilitychange", pause);
    window.addEventListener("pagehide", leave);
    return () => { player?.pause(); document.removeEventListener("visibilitychange", pause); window.removeEventListener("pagehide", leave); };
  }, []);

  function play() {
    const player = video.current;
    if (!open || !player || failed) return;
    if (!player.paused) { player.pause(); return; }
    setPlayError(false);
    if (ended) { player.currentTime = 0; setTime(0); setEnded(false); }
    void player.play().catch(() => setPlayError(true));
  }
  function seek(seconds: number) {
    if (!open || !Number.isFinite(seconds) || seconds < 0 || seconds > WELCOME_TUTORIAL.durationSeconds) return;
    setTime(seconds); setEnded(false);
    const player = video.current;
    if (!player || failed) { setTranscript(true); return; }
    try { player.currentTime = seconds; seekTo.current = null; } catch { seekTo.current = seconds; }
  }
  function close() { video.current?.pause(); closeRef.current(); }

  return <dialog ref={dialog} className="om-welcome" aria-modal="true" aria-labelledby="om-welcome-title" aria-describedby="om-welcome-description"
    onCancel={(event) => { event.preventDefault(); close(); }}>
    <header className="om-welcome-head">
      <div><p className="om-welcome-eyebrow">{replay ? "Your app guide" : "Welcome to One Mission"}</p><h2 id="om-welcome-title">{WELCOME_TUTORIAL.title}</h2></div>
      <button type="button" className="om-welcome-close" aria-label="Close tutorial" onClick={close}><X aria-hidden="true" /></button>
    </header>
    <div className="om-welcome-body">
      <div className="om-welcome-media">
        <div className="om-welcome-screen">
          <video ref={video} src={WELCOME_TUTORIAL.videoSrc} poster={WELCOME_TUTORIAL.posterSrc} controls playsInline preload="metadata"
            aria-label="One Mission welcome tutorial" onPlay={() => { setPlaying(true); setStarted(true); }} onPause={() => setPlaying(false)}
            onTimeUpdate={(event) => { if (Number.isFinite(event.currentTarget.currentTime)) setTime(event.currentTarget.currentTime); }}
            onLoadedMetadata={() => { if (video.current && seekTo.current != null) { video.current.currentTime = seekTo.current; seekTo.current = null; } }}
            onEnded={() => { setPlaying(false); setEnded(true); onComplete(); }}
            onError={() => { setFailed(true); setPlaying(false); setTranscript(true); }}>
            <track kind="captions" src={WELCOME_TUTORIAL.captionsSrc} srcLang="en" label="English" default />
            Your browser cannot play this video. The full transcript is below.
          </video>
        </div>
        <button ref={playButton} type="button" className="om-welcome-play" onClick={play} disabled={failed}>
          {ended ? <RotateCcw aria-hidden="true" /> : playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}<span>{playing ? "Pause video" : ended ? "Watch again" : started ? "Resume video" : "Play welcome video"}</span><small>{clock(WELCOME_TUTORIAL.durationSeconds)}</small>
        </button>
        {failed ? <p className="om-welcome-media-note" role="status">The video could not load. You can read every step in the transcript.</p>
          : playError ? <p className="om-welcome-media-note" role="status">Use the video’s Play control, or read the transcript below.</p>
            : <p className="om-welcome-media-note">{reduced ? "Reduced motion is on. Read the transcript, or play when you’re ready." : "Sound starts when you press Play. Captions are included."}</p>}
      </div>
      <div className="om-welcome-guide">
        <p id="om-welcome-description">Meet Atlas, find a signal, review the setup, and connect your account in FLOW. Take it at your own pace.</p>
        <nav className="om-welcome-chapters" aria-label="Tutorial chapters">
          <p>In this tour</p>
          {WELCOME_TUTORIAL.chapters.map((item, index) => <button type="button" key={item.id} aria-current={chapter?.id === item.id ? "step" : undefined} onClick={() => seek(item.start)}>
            <span className="om-welcome-step" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span><span>{item.title}</span><small>{clock(item.start)}</small>
          </button>)}
        </nav>
        <button type="button" className="om-welcome-transcript-toggle" aria-expanded={transcript} aria-controls="om-welcome-transcript" onClick={() => setTranscript((shown) => !shown)}><BookOpen aria-hidden="true" />{transcript ? "Hide transcript" : "Read transcript"}</button>
        <section id="om-welcome-transcript" className="om-welcome-transcript" hidden={!transcript} aria-label="Welcome tutorial transcript">
          {WELCOME_TUTORIAL.chapters.map((item) => <section key={item.id}><h3>{item.title}</h3><p>{item.narration}</p></section>)}
        </section>
        {ended && <p className="om-welcome-finished" role="status"><Check aria-hidden="true" />You’re ready to explore. Replay this tour anytime from your account menu.</p>}
      </div>
    </div>
    <footer className="om-welcome-foot"><button type="button" className="om-welcome-skip" onClick={close}>{replay ? "Close guide" : "Skip tour"}</button><button type="button" className="om-welcome-explore" onClick={close}>Start exploring<ArrowRight aria-hidden="true" /></button></footer>
  </dialog>;
}
