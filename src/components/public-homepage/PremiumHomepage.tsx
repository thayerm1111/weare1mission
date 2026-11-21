"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from "react";
import { OverviewChapter, ProductPreview, PRODUCTS, PRODUCT_KEYS, type ProductKey } from "./HomepagePreviews";
import "./public-homepage.css";

/** All previews are local illustrations. This component never reads accounts or invokes trading services. */
export function PremiumHomepage() {
  const [product, setProduct] = useState<ProductKey>("floor");
  const [tourIndex, setTourIndex] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [videoPaused, setVideoPaused] = useState(true);
  const rootRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const menuToggleRef = useRef<HTMLButtonElement>(null);
  const userPausedRef = useRef(false);
  const overviewOpenRef = useRef(false);
  const syncVideoRef = useRef<(() => void) | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const previousOverflowRef = useRef<string | null>(null);
  const selected = PRODUCTS[product];

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (rootRef.current?.querySelector("#mobile-menu")?.contains(document.activeElement)) menuToggleRef.current?.focus();
      setMenuOpen(false);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("scroll", onScroll); window.removeEventListener("keydown", onKey); };
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (reduced.matches || !("IntersectionObserver" in window)) {
      root.querySelectorAll(".reveal").forEach((element) => element.classList.add("visible"));
      return;
    }
    root.classList.add("js-motion");
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) if (entry.isIntersecting) { entry.target.classList.add("visible"); observer.unobserve(entry.target); }
    }, { threshold: 0.08 });
    root.querySelectorAll(".reveal").forEach((element) => observer.observe(element));
    return () => { observer.disconnect(); root.classList.remove("js-motion"); };
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    userPausedRef.current = reduced.matches;
    let inView = true;
    const sync = () => {
      if (document.hidden || !inView || overviewOpenRef.current || userPausedRef.current) video.pause();
      else void video.play().catch(() => setVideoPaused(true));
    };
    syncVideoRef.current = sync;
    const onPreferenceChange = (event: MediaQueryListEvent) => { userPausedRef.current = event.matches; sync(); };
    const observer = "IntersectionObserver" in window
      ? new IntersectionObserver(([entry]) => { inView = entry.isIntersecting; sync(); }, { threshold: 0.01 })
      : null;
    observer?.observe(video);
    reduced.addEventListener("change", onPreferenceChange);
    document.addEventListener("visibilitychange", sync);
    sync();
    return () => { observer?.disconnect(); reduced.removeEventListener("change", onPreferenceChange); document.removeEventListener("visibilitychange", sync); syncVideoRef.current = null; video.pause(); };
  }, []);

  useEffect(() => () => {
    if (previousOverflowRef.current !== null) document.body.style.overflow = previousOverflowRef.current;
  }, []);

  const selectTool = useCallback((key: ProductKey, scroll = false) => {
    setProduct(key);
    if (scroll) document.getElementById("platform")?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  }, []);

  function handleToolClick(event: MouseEvent<HTMLDivElement>) {
    const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-tool-link]") : null;
    const key = target?.dataset.toolLink as ProductKey | undefined;
    if (key && PRODUCT_KEYS.includes(key)) { selectTool(key, true); return; }
    // Keep smooth section navigation local to this route instead of changing html/body styles.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href^="#"]') : null;
    const hash = anchor?.getAttribute("href");
    if (!hash) return;
    const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
    if (hash === "#") { event.preventDefault(); window.scrollTo({ top: 0, behavior }); return; }
    const section = rootRef.current?.querySelector(hash);
    if (section) { event.preventDefault(); section.scrollIntoView({ behavior, block: "start" }); window.history.pushState(null, "", hash); }
  }

  function handleTabKey(event: KeyboardEvent<HTMLDivElement>) {
    const index = PRODUCT_KEYS.indexOf(product);
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % PRODUCT_KEYS.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + PRODUCT_KEYS.length) % PRODUCT_KEYS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = PRODUCT_KEYS.length - 1;
    else return;
    event.preventDefault();
    setProduct(PRODUCT_KEYS[next]);
    const tab = document.getElementById(`tab-${PRODUCT_KEYS[next]}`);
    tab?.focus({ preventScroll: true });
    tab?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function toggleVideo() {
    const video = videoRef.current;
    if (!video) return;
    userPausedRef.current = !video.paused;
    syncVideoRef.current?.();
  }

  function openOverview() {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    previousOverflowRef.current = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    setTourIndex(0);
    overviewOpenRef.current = true;
    videoRef.current?.pause();
    dialog.showModal();
  }

  function finishOverview() {
    if (previousOverflowRef.current !== null) { document.body.style.overflow = previousOverflowRef.current; previousOverflowRef.current = null; }
    overviewOpenRef.current = false;
    syncVideoRef.current?.();
    previousFocusRef.current?.focus({ preventScroll: true });
  }

  function closeOverview() { dialogRef.current?.close(); }

  return (
    <div ref={rootRef} className="om-public-homepage" data-public-homepage="" onClick={handleToolClick}>
<svg className="svg-defs" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><defs>
    <symbol id="i-grid" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1.6"/><rect x="14" y="3" width="7" height="7" rx="1.6"/><rect x="3" y="14" width="7" height="7" rx="1.6"/><rect x="14" y="14" width="7" height="7" rx="1.6"/></symbol>
    <symbol id="i-spark" viewBox="0 0 24 24"><path d="m12 3 2.6 6.4L21 12l-6.4 2.6L12 21l-2.6-6.4L3 12l6.4-2.6L12 3Z"/></symbol>
    <symbol id="i-gold" viewBox="0 0 24 24"><path d="m7 5-4 5 9 10 9-10-4-5H7Z M3 10h18 M7 5l5 15 5-15 M7 5l5 5 5-5"/></symbol>
    <symbol id="i-pulse" viewBox="0 0 24 24"><path d="M2 12h5l3-8 4 16 3-8h5"/></symbol>
    <symbol id="i-flow" viewBox="0 0 24 24"><path d="M10 7H8a5 5 0 0 0 0 10h2m4-10h2a5 5 0 0 1 0 10h-2M8 12h8"/></symbol>
    <symbol id="i-atlas" viewBox="0 0 24 24"><ellipse cx="12" cy="12" rx="10" ry="6" transform="rotate(-28 12 12)"/><ellipse cx="12" cy="12" rx="6" ry="10" transform="rotate(-28 12 12)"/></symbol>
    <symbol id="i-check" viewBox="0 0 24 24"><path d="m5 12 4 4L19 6"/></symbol>
    <symbol id="i-play" viewBox="0 0 24 24"><path d="m9 5 11 7-11 7V5Z"/></symbol>
    <symbol id="i-pause" viewBox="0 0 24 24"><path d="M9 5v14M15 5v14"/></symbol>
    <symbol id="i-plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></symbol>
    <symbol id="i-minus" viewBox="0 0 24 24"><path d="M5 12h14"/></symbol>
    <symbol id="i-close" viewBox="0 0 24 24"><path d="m6 6 12 12M6 18 18 6"/></symbol>
    <symbol id="i-shield" viewBox="0 0 24 24"><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/></symbol>
  </defs></svg>
  <header className={`site-header${scrolled ? " scrolled" : ""}`}>
    <a className="brand" href="#" aria-label="One Mission home"><svg viewBox="0 0 70 30" aria-hidden="true"><circle cx="13" cy="15" r="10.5"/><path d="m25 25 10-21 8 16 7-16 12 21"/></svg><span>ONE MISSION</span></a>
    <nav className="desktop-nav" aria-label="Primary"><a href="#platform">Platform</a><a href="#atlas">Atlas</a><a href="#flow">Execution</a><a href="#questions">Questions</a></nav>
    <div className="header-actions"><a className="login-link" href="/login?redirect=/portal/trading">Log in</a><a className="button button-small button-light" href="/signup">Get access</a><button ref={menuToggleRef} className="menu-toggle icon-button" onClick={() => setMenuOpen((open) => !open)} aria-labelledby="homepage-menu-label" aria-expanded={menuOpen} aria-controls="mobile-menu"><span></span><span></span><span id="homepage-menu-label" className="sr-only" key={menuOpen ? "open" : "closed"}>{menuOpen ? "Close menu" : "Open menu"}</span></button></div>
  </header>
  <nav id="mobile-menu" className="mobile-menu" aria-label="Mobile navigation" hidden={!menuOpen} onClick={() => setMenuOpen(false)}><a href="#platform">Platform</a><a href="#atlas">Atlas</a><a href="#flow">Execution</a><a href="#questions">Questions</a><a href="/login?redirect=/portal/trading">Member login</a></nav>
  <div className="homepage-main">
    <section className="hero" aria-labelledby="hero-title">
      <div className="hero-film" aria-hidden="true"><video ref={videoRef} onPlay={() => setVideoPaused(false)} onPause={() => setVideoPaused(true)} onError={() => setVideoPaused(true)} id="hero-video" muted loop playsInline preload="metadata" poster="/images/homepage/hero-poster.jpg"><source src="/images/homepage/one-mission-hero-mobile.mp4" type="video/mp4" media="(max-width: 767px)" /><source src="/images/homepage/one-mission-hero.mp4" type="video/mp4" /></video></div>
      <div className="hero-shade"></div>
      <div className="hero-content wrap">
        <p className="eyebrow hero-eyebrow">THE CONNECTED TRADING PLATFORM</p>
        <h1 id="hero-title">Your trading.<br /><span>Connected.</span></h1>
        <p className="hero-description">AI market intelligence. Structured trade setups.<br className="desktop-break" /> Connected execution. One place to bring it all together.</p>
        <div className="hero-actions"><a className="button button-light" href="#platform">Explore the platform</a><button className="text-button" id="watch-film" onClick={openOverview}><svg className="icon"><use href="#i-play"/></svg>Take a quick tour</button></div>
      </div>
      <div className="hero-caption"><span>INTELLIGENCE IN MOTION</span><button id="motion-toggle" className="film-control" onClick={toggleVideo} aria-labelledby="homepage-motion-label homepage-motion-context" aria-controls="hero-video"><svg className="icon"><use href={videoPaused ? "#i-play" : "#i-pause"}/></svg><span id="homepage-motion-label" key={videoPaused ? "play" : "pause"}>{videoPaused ? "Play" : "Pause"}</span><span id="homepage-motion-context" className="sr-only">background video</span></button></div>
      <div className="hero-bottom wrap"><span>Built around the way you trade.</span><span className="hero-bottom-right">DISCOVER ONE MISSION <span className="scroll-line"></span></span></div>
    </section>
    <div className="tool-rail wrap" aria-label="Explore trading tools">
      <button data-tool-link="floor"><svg className="icon"><use href="#i-grid"/></svg>The Floor</button><button data-tool-link="atlas"><svg className="icon"><use href="#i-atlas"/></svg>Atlas</button><button data-tool-link="genx"><svg className="icon"><use href="#i-gold"/></svg>GENX</button><button data-tool-link="plays"><svg className="icon"><use href="#i-spark"/></svg>OM AI Plays</button><button data-tool-link="pulse"><svg className="icon"><use href="#i-pulse"/></svg>Market Pulse</button><button data-tool-link="flow"><svg className="icon"><use href="#i-flow"/></svg>FLOW</button>
    </div>
    <section id="platform" className="platform section wrap" aria-labelledby="platform-title">
      <div className="section-heading reveal"><div><p className="eyebrow">ONE WORKSPACE. A COMPLETE PICTURE.</p><h2 id="platform-title">The tools to see more.<br /><span>The clarity to move.</span></h2></div><p>Start on The Floor. Explore the market, understand a setup, and follow your connected accounts without losing the bigger picture.</p></div>
      <div className="product-selector reveal" role="tablist" aria-label="Product preview" onKeyDown={handleTabKey}><button role="tab" aria-selected={product === "floor"} aria-controls="product-panel" id="tab-floor" data-product="floor" tabIndex={product === "floor" ? 0 : -1} onClick={() => setProduct("floor")}>The Floor</button><button role="tab" aria-selected={product === "atlas"} aria-controls="product-panel" id="tab-atlas" data-product="atlas" tabIndex={product === "atlas" ? 0 : -1} onClick={() => setProduct("atlas")}>Atlas</button><button role="tab" aria-selected={product === "genx"} aria-controls="product-panel" id="tab-genx" data-product="genx" tabIndex={product === "genx" ? 0 : -1} onClick={() => setProduct("genx")}>GENX</button><button role="tab" aria-selected={product === "plays"} aria-controls="product-panel" id="tab-plays" data-product="plays" tabIndex={product === "plays" ? 0 : -1} onClick={() => setProduct("plays")}>OM AI Plays</button><button role="tab" aria-selected={product === "pulse"} aria-controls="product-panel" id="tab-pulse" data-product="pulse" tabIndex={product === "pulse" ? 0 : -1} onClick={() => setProduct("pulse")}>Market Pulse</button><button role="tab" aria-selected={product === "flow"} aria-controls="product-panel" id="tab-flow" data-product="flow" tabIndex={product === "flow" ? 0 : -1} onClick={() => setProduct("flow")}>FLOW</button></div>
      <div id="product-panel" className="product-stage reveal" role="tabpanel" aria-labelledby={`tab-${product}`} tabIndex={0}>
        <div className="stage-toolbar"><div className="window-mark" key={product}><svg className="icon"><use id="stage-icon" href={`#i-${selected.icon}`}/></svg><span id="stage-name">{selected.name}</span></div><span className="demo-label">PRODUCT PREVIEW · ILLUSTRATIVE DATA</span><span className="stage-wordmark">ONE MISSION</span></div>
        <div className="stage-body" id="stage-body"><ProductPreview product={product} onSelectProduct={setProduct} /></div>
      </div>
      <div className="stage-caption"><div key={product}><h3 id="product-headline">{selected.headline}</h3><p id="product-description">{selected.description}</p></div><a id="product-link" className="button button-outline" href={selected.href}><span key={product}>{selected.cta}</span></a></div>
    </section>
    <section id="atlas" className="atlas-section section" aria-labelledby="atlas-title">
      <div className="atlas-layout wrap">
        <div className="atlas-copy reveal"><span className="product-kicker"><svg className="icon"><use href="#i-atlas"/></svg>ATLAS</span><h2 id="atlas-title">Gold has a story.<br /><span>Make sense of it.</span></h2><p>Meet your AI gold copilot. Ask in plain language. Understand the levels, the changing conditions, and the scenarios behind the chart.</p><div className="feature-lines"><div><strong>A clearer read.</strong><span>What changed. What matters next. What could change the view.</span></div><div><strong>See the explanation.</strong><span>Explore the levels and candles behind the analysis.</span></div><div><strong>Go deeper.</strong><span>Open the Command Center. Use text or the supported voice experience.</span></div></div><button className="button button-outline" data-tool-link="atlas">Explore Atlas</button></div>
        <div className="atlas-story reveal"><div className="story-header"><span className="atlas-emblem"><svg className="icon"><use href="#i-atlas"/></svg></span><div><span className="story-name">Atlas</span><span className="muted">Gold intelligence</span></div><span className="story-tag">SAMPLE READ</span></div><p className="story-question">“Tell me what’s happening with gold.”</p><div className="story-answer"><p className="story-lead">The pullback is testing support.<br /><span>The next close matters.</span></p><div className="story-chart" aria-label="Illustrative chart of a pullback toward support"><svg viewBox="0 0 520 148" preserveAspectRatio="none"><defs><linearGradient id="story-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#b5a8db" stopOpacity=".15"/><stop offset="100%" stopColor="#b5a8db" stopOpacity="0"/></linearGradient></defs><path d="M0 108 24 98 46 103 69 83 90 89 114 62 137 70 162 45 183 53 208 31 232 39 255 21 280 35 307 58 330 51 357 76 382 68 406 90 432 82 457 101 480 91 505 96 520 85V148H0Z" fill="url(#story-fill)"/><path d="M0 108 24 98 46 103 69 83 90 89 114 62 137 70 162 45 183 53 208 31 232 39 255 21 280 35 307 58 330 51 357 76 382 68 406 90 432 82 457 101 480 91 505 96 520 85" fill="none" stroke="#c6bddb" strokeWidth="2"/><path d="M0 111H520" stroke="#8cbca9" strokeDasharray="4 5" opacity=".5"/></svg><span>Support zone</span></div><div className="story-points"><div><span>Watching next</span><p>A confirmed response at support.</p></div><div><span>Changes the view</span><p>A close below the support zone.</p></div></div><p className="sample-note">An example of how Atlas explains a setup. Not a current market call.</p></div><div className="story-input"><span>Ask a follow-up…</span><span className="return-key">↵</span></div></div>
      </div>
    </section>
    <section className="intelligence-section section wrap" aria-labelledby="intelligence-title">
      <div className="section-heading reveal"><div><p className="eyebrow">A DIFFERENT PERSPECTIVE. WHEN YOU NEED IT.</p><h2 id="intelligence-title">Find your focus.</h2></div><p>Specialist tools for different moments in your trading process. A shared workspace that brings them together.</p></div>
      <div className="intelligence-grid">
        <article className="tool-card reveal"><div className="tool-card-head"><svg className="icon"><use href="#i-gold"/></svg><span>GENX</span></div><div className="gold-visual" aria-hidden="true"><span className="gold-bar one"></span><span className="gold-bar two"></span><span className="gold-bar three"></span><span className="metal-caption">XAU / USD</span></div><h3>A dedicated view<br />of gold.</h3><p>Follow the gold engine’s read, its entry conditions and its recorded results. Know what GENX is watching and why.</p><button className="card-link" data-tool-link="genx">Explore GENX <svg className="icon"><use href="#i-plus"/></svg></button></article>
        <article className="tool-card reveal"><div className="tool-card-head"><svg className="icon"><use href="#i-spark"/></svg><span>OM AI PLAYS</span></div><div className="plays-visual" aria-hidden="true"><div className="mini-play back"><span>EUR / USD</span><span>Intraday</span></div><div className="mini-play front"><span className="mini-play-label">YOUR NEXT ANALYSIS</span><strong>XAU / USD</strong><span>Market · Style · Generate</span><div className="mini-play-line"></div></div></div><h3>Your market.<br />Your next analysis.</h3><p>Choose a supported market and trading style. Generate a structured setup with conditions, a stop, targets and the thinking behind it.</p><button className="card-link" data-tool-link="plays">Explore AI Plays <svg className="icon"><use href="#i-plus"/></svg></button></article>
        <article className="tool-card reveal"><div className="tool-card-head"><svg className="icon"><use href="#i-pulse"/></svg><span>MARKET PULSE</span></div><div className="pulse-visual" aria-hidden="true"><div><span>XAU / USD</span><i style={{ "--w": "86%" } as CSSProperties}></i><span>Gold</span></div><div><span>EUR / USD</span><i style={{ "--w": "64%" } as CSSProperties}></i><span>Forex</span></div><div><span>USD / JPY</span><i style={{ "--w": "43%" } as CSSProperties}></i><span>Forex</span></div><small>ILLUSTRATIVE SCAN</small></div><h3>Know where<br />to look next.</h3><p>Scan supported markets and explore ranked candidates. See when a read was produced, then take a closer look with the right tool.</p><button className="card-link" data-tool-link="pulse">Explore Market Pulse <svg className="icon"><use href="#i-plus"/></svg></button></article>
      </div>
    </section>
    <section id="flow" className="flow-section section" aria-labelledby="flow-title"><div className="wrap flow-layout"><div className="flow-copy reveal"><span className="product-kicker"><svg className="icon"><use href="#i-flow"/></svg>FLOW</span><h2 id="flow-title">From insight<br />to execution.</h2><p>Connect your supported accounts. Choose your eligible signal sources. Define how trades are sized and managed, and follow what happens in one place.</p><div className="flow-benefits"><span><svg className="icon"><use href="#i-check"/></svg>Connected account balance and equity</span><span><svg className="icon"><use href="#i-check"/></svg>Account-specific execution settings</span><span><svg className="icon"><use href="#i-check"/></svg>Open positions and realized results</span></div><button className="button button-dark" data-tool-link="flow">Explore FLOW</button><p className="flow-footnote">Connecting an account and enabling trading are separate steps. Automation follows your account permissions and settings.</p></div><div className="flow-visual reveal"><div className="connection-heading"><svg className="icon"><use href="#i-flow"/></svg><span>Your execution, connected.</span></div><div className="source-chips"><span>GENX</span><span>OM AI Plays</span><span>Atlas</span></div><div className="connection-lines" aria-hidden="true"><i></i><i></i><i></i></div><div className="flow-hub"><svg className="icon"><use href="#i-flow"/></svg><strong>FLOW</strong><span>Account connection & execution</span></div><div className="connection-stem" aria-hidden="true"></div><div className="account-example"><div><span className="account-icon"><svg className="icon"><use href="#i-shield"/></svg></span><span><strong>Your trading account</strong><small>Supported broker connection</small></span></div><div className="private-values"><span>Balance<strong>••••••</strong></span><span>Equity<strong>••••••</strong></span><span>Execution<strong>Your settings</strong></span></div></div><p className="diagram-note">Illustrative workflow. Source and account eligibility apply.</p></div></div></section>
    <section className="results-section section wrap" aria-labelledby="results-title"><div className="results-intro reveal"><p className="eyebrow">SEE THE RECORD. UNDERSTAND THE CONTEXT.</p><h2 id="results-title">A clear view<br />of what happened.</h2><p>Keep the engine’s performance and your account’s results in view. Each tells a different part of the story.</p></div><div className="results-panels"><article className="result-feature reveal"><span className="product-kicker"><svg className="icon"><use href="#i-gold"/></svg>GENX RESULTS</span><h3>The engine’s record.</h3><p>Review recorded trades, net pips and win rate across the selected period. See the history behind the headline.</p><div className="result-labels"><span>Net result</span><span>Closed trades</span><span>Trade history</span></div></article><article className="result-feature reveal"><span className="product-kicker"><svg className="icon"><use href="#i-flow"/></svg>MY FLOW</span><h3>Your account’s activity.</h3><p>Follow realized P&L, open P&L, positions and execution history for your selected connected account.</p><div className="result-labels"><span>Realized P&L</span><span>Open positions</span><span>Account history</span></div></article><p className="results-note">Engine results and personal account results are shown separately. Past performance does not guarantee future results.</p></div></section>
    <section className="journey-section section wrap" aria-labelledby="journey-title"><div className="section-heading reveal"><div><p className="eyebrow">A CLEAR PATH THROUGH YOUR SESSION</p><h2 id="journey-title">Find. Understand.<br />Connect. Follow.</h2></div><a className="button button-outline" href="/portal/trading">Enter The Floor</a></div><div className="journey-grid"><article className="reveal"><svg className="icon"><use href="#i-pulse"/></svg><h3>Find your market.</h3><p>Start with gold or scan supported markets with Market Pulse.</p></article><article className="reveal"><svg className="icon"><use href="#i-atlas"/></svg><h3>Understand the setup.</h3><p>Explore the analysis, conditions and levels with the tool that fits your session.</p></article><article className="reveal"><svg className="icon"><use href="#i-flow"/></svg><h3>Connect your account.</h3><p>Review your execution preferences and the sources your account can take.</p></article><article className="reveal"><svg className="icon"><use href="#i-grid"/></svg><h3>Keep the full picture.</h3><p>Follow your positions and results back on The Floor.</p></article></div></section>
    <section id="questions" className="faq-section section wrap" aria-labelledby="faq-title"><div className="faq-heading reveal"><p className="eyebrow">A FEW THINGS TO KNOW</p><h2 id="faq-title">Before your<br />first session.</h2></div><div className="faq-list reveal"><details><summary>What is One Mission?<svg className="icon"><use href="#i-plus"/></svg></summary><p>One Mission is a trading platform that brings market analysis, AI-generated setups and connected execution into one workspace. Its tools include The Floor, Atlas, GENX, OM AI Plays, Market Pulse and FLOW.</p></details><details><summary>Where should I start?<svg className="icon"><use href="#i-plus"/></svg></summary><p>Start on The Floor for an overview. Use Atlas or GENX to explore gold, Market Pulse to discover supported markets, and OM AI Plays to request a setup for a market and trading style you choose.</p></details><details><summary>Does connecting my account turn on auto trading?<svg className="icon"><use href="#i-plus"/></svg></summary><p>No. Account connection and trading permissions are separate. FLOW lets you review the execution settings for each supported account. Automated execution depends on the sources you enable, account eligibility and the platform’s execution checks.</p></details><details><summary>Which accounts can I connect?<svg className="icon"><use href="#i-plus"/></svg></summary><p>TradeLocker connection is available in the platform. Supported brokers, instruments and account eligibility can vary. Check the available connection options inside FLOW for your account.</p></details><details><summary>How do access and credits work?<svg className="icon"><use href="#i-plus"/></svg></summary><p>Access depends on your membership and the tool you use. Applicable credit costs and included access are shown inside the platform before you request a chargeable action. Follow the Get access link for the current signup options.</p></details><details><summary>Can AI guarantee a trading result?<svg className="icon"><use href="#i-plus"/></svg></summary><p>No. AI analysis and automation do not remove trading risk. A setup may remain unconfirmed or be invalidated. Trading can result in the loss of capital, and previous results do not guarantee future outcomes.</p></details></div></section>
    <section className="final-cta section wrap reveal"><p className="eyebrow">ONE MISSION</p><h2>Your next session.<br /><span>A whole new perspective.</span></h2><p>Your market tools. Your AI copilot. Your connected accounts.</p><div><a className="button button-light" href="/signup">Get access</a><a className="text-button" href="/login?redirect=/portal/trading">Member login</a></div></section>
  </div>
  <footer className="footer wrap"><div className="footer-top"><a className="brand" href="#" aria-label="One Mission home"><svg viewBox="0 0 70 30" aria-hidden="true"><circle cx="13" cy="15" r="10.5"/><path d="m25 25 10-21 8 16 7-16 12 21"/></svg><span>ONE MISSION</span></a><p>Trading intelligence. Connected.</p><nav aria-label="Footer"><a href="/contact">Contact</a><a href="/legal#privacy-policy">Privacy</a><a href="/legal#terms-of-use">Terms</a><a href="/legal#trading-risk-disclosure">Risk disclosure</a></nav></div><p className="legal-copy">For educational purposes only. Trading involves risk, including the possible loss of capital. Past performance does not guarantee future results. Nothing on this site is individualized financial advice. Product previews use illustrative data and do not place trades. See the <a href="/legal">full disclosures</a>.</p><div className="footer-bottom"><span>© 2026 One Mission. All rights reserved.</span><span>WEARE1MISSION.COM</span></div></footer>
  <dialog ref={dialogRef} onClose={finishOverview} onClick={(event) => { if (event.target === event.currentTarget) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeOverview(); } }} id="overview-dialog" className="overview-dialog" aria-labelledby="overview-title"><button className="close-dialog icon-button" aria-label="Close overview" onClick={closeOverview}><svg className="icon"><use href="#i-close"/></svg></button><div className="tour-header"><p className="eyebrow">MEET YOUR TRADING WORKSPACE</p><h2 id="overview-title">One Mission.<br />Every tool, connected.</h2><p>A guided product overview. Illustrative interfaces; no live analysis or orders.</p></div><div className="tour-stage" id="tour-stage"><OverviewChapter key={PRODUCT_KEYS[tourIndex]} product={PRODUCT_KEYS[tourIndex]} /></div><div className="tour-controls"><button id="tour-prev" className="button button-outline" disabled={tourIndex === 0} onClick={() => setTourIndex((index) => Math.max(0, index - 1))}>Previous</button><div id="tour-dots" aria-label="Overview chapters">{PRODUCT_KEYS.map((key, index) => <button type="button" key={key} className={index === tourIndex ? "active" : ""} aria-label={`View ${PRODUCTS[key].name}`} aria-current={index === tourIndex ? "step" : undefined} onClick={() => setTourIndex(index)} />)}</div><button id="tour-next" className="button button-light" onClick={() => { if (tourIndex === PRODUCT_KEYS.length - 1) { closeOverview(); selectTool("floor", true); } else setTourIndex((index) => index + 1); }}><span key={tourIndex === PRODUCT_KEYS.length - 1 ? "explore" : "next"}>{tourIndex === PRODUCT_KEYS.length - 1 ? "Explore the platform" : "Next"}</span></button></div></dialog>
    </div>
  );
}
