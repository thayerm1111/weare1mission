"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Pause, Play } from "lucide-react";
import { useHomepageTranslation } from "@/components/public-homepage/homepage-i18n";
import { LoginForm } from "./LoginForm";
import { LOGIN_SPANISH } from "./login-copy";
import "./login.css";

/** Presentation only: membership checks remain in the shared LoginForm. */
export function LoginExperience({ redirect }: { redirect?: string | string[] }) {
  const { locale } = useHomepageTranslation();
  const t = useCallback((copy: string) => locale === "es" ? LOGIN_SPANISH[copy] ?? copy : copy, [locale]);
  const videoRef = useRef<HTMLVideoElement>(null);
  const userPausedRef = useRef(false);
  const syncVideoRef = useRef<(() => void) | null>(null);
  const [videoPaused, setVideoPaused] = useState(true);
  const [videoFailed, setVideoFailed] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    userPausedRef.current = reduced.matches;
    let inView = !("IntersectionObserver" in window);
    const sync = () => {
      if (document.hidden || !inView || userPausedRef.current) video.pause();
      else void video.play().catch(() => setVideoPaused(true));
    };
    syncVideoRef.current = sync;
    const onPreferenceChange = (event: MediaQueryListEvent) => {
      userPausedRef.current = event.matches;
      sync();
    };
    const observer = "IntersectionObserver" in window
      ? new IntersectionObserver(([entry]) => { inView = entry.isIntersecting; sync(); }, { threshold: 0.01 })
      : null;
    observer?.observe(video);
    reduced.addEventListener("change", onPreferenceChange);
    document.addEventListener("visibilitychange", sync);
    sync();
    return () => {
      observer?.disconnect();
      reduced.removeEventListener("change", onPreferenceChange);
      document.removeEventListener("visibilitychange", sync);
      syncVideoRef.current = null;
      video.pause();
    };
  }, []);

  function toggleVideo() {
    const video = videoRef.current;
    if (!video) return;
    userPausedRef.current = !video.paused;
    syncVideoRef.current?.();
  }

  return (
    <div className="om-login-page" data-no-i18n="" lang={locale}>
      <header className="om-login-header">
        <Link href="/" className="om-login-brand" aria-label={t("One Mission home")}>
          <svg viewBox="0 0 70 30" aria-hidden="true"><circle cx="13" cy="15" r="10.5" /><path d="m25 25 10-21 8 16 7-16 12 21" /></svg>
          <span>ONE MISSION</span>
        </Link>
        <Link href="/" className="om-login-back">{t("Back to One Mission")}<ArrowUpRight size={15} aria-hidden="true" /></Link>
      </header>

      <div className="om-login-layout">
        <section className="om-login-entry" aria-labelledby="login-title">
          <p className="om-login-eyebrow">{t("YOUR WORKSPACE AWAITS")}</p>
          <h1 id="login-title">{t("Welcome back.")}</h1>
          <p className="om-login-intro">{t("Sign in to your trading workspace.")}</p>
          <LoginForm redirect={redirect} variant="premium" translate={t} />
          <div className="om-login-signup">
            <p>{t("New to One Mission?")} <Link href="/signup">{t("Get access")}<ArrowUpRight size={14} aria-hidden="true" /></Link></p>
            <p className="om-login-approval">{t("New accounts are reviewed by the One Mission team.")}</p>
          </div>
        </section>

        <aside className="om-login-art" aria-label={t("One connected trading workspace")}>
          <div className="om-login-film" aria-hidden="true">
            <video ref={videoRef} id="login-ambient-video" muted loop playsInline preload="metadata" poster="/images/homepage/hero-poster.jpg"
              onPlay={() => setVideoPaused(false)} onPause={() => setVideoPaused(true)} onError={() => { setVideoPaused(true); setVideoFailed(true); }}>
              <source src="/images/homepage/one-mission-hero-mobile.mp4" type="video/mp4" media="(max-width: 900px)" />
              <source src="/images/homepage/one-mission-hero.mp4" type="video/mp4" />
            </video>
          </div>
          <div className="om-login-art-caption">
            <p className="om-login-eyebrow">{t("THE CONNECTED TRADING PLATFORM")}</p>
            <h2>{t("Your trading.")} <span>{t("Connected.")}</span></h2>
            <p className="om-login-tool-line">Atlas <span>·</span> GENX <span>·</span> OM AI Plays <span>·</span> Market Pulse <span>·</span> FLOW</p>
          </div>
          {!videoFailed && <button type="button" className="om-login-motion" onClick={toggleVideo} aria-label={t(videoPaused ? "Play background video" : "Pause background video")} aria-controls="login-ambient-video">
            {videoPaused ? <Play size={13} aria-hidden="true" /> : <Pause size={13} aria-hidden="true" />}
          </button>}
        </aside>
      </div>

      <footer className="om-login-footer">
        <p>© {new Date().getFullYear()} One Mission</p>
        <nav aria-label={t("Legal")}><Link href="/legal#privacy-policy">{t("Privacy")}</Link><Link href="/legal#terms-of-use">{t("Terms")}</Link></nav>
      </footer>
    </div>
  );
}
