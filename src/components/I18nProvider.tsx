"use client";

/**
 * On-the-fly Spanish localizer for the whole site.
 *
 * Wrapping every string in every component isn't practical here, so instead this
 * translates the *rendered* page: when the member switches to Español it walks
 * the visible text (and input placeholders / titles / aria-labels), sends the
 * English strings to /api/translate (Claude), and swaps them in — then a
 * MutationObserver keeps translating anything that renders later, including the
 * AI-generated signals, briefs and deep dives. Every translation is cached in
 * localStorage, so after the first pass switching languages is instant and free.
 *
 * Correctness notes:
 *  - We record every node/attr we translate in `originals`, and NEVER re-process
 *    an already-translated node — so writing a Spanish string can't feed itself
 *    back through the translator (no loops, no wasted API calls).
 *  - DOM writes happen with the observer paused (disconnect + takeRecords) so our
 *    own mutations are never observed.
 *  - Only newly-appeared nodes are processed on each mutation batch — never a
 *    full-document rescan — so heavy/animated pages stay responsive.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Globe, Loader2 } from "lucide-react";

const LANG_KEY = "om-lang";
const CACHE_KEY = "om-i18n-es";
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "CODE", "PRE", "TEXTAREA", "SVG", "CANVAS"]);
const ATTRS = ["placeholder", "title", "aria-label", "alt"];
const OBS_CONFIG: MutationObserverInit = { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS };
const hasLetters = (s: string) => /[A-Za-z]/.test(s);

type AttrTarget = { el: Element; attr: string; val: string };

export function I18nProvider() {
  const [lang, setLang] = useState<"en" | "es">("en");
  const [busy, setBusy] = useState(false);

  const cache = useRef<Map<string, string>>(new Map());
  const originals = useRef<Map<Text, string>>(new Map());        // translated text nodes → English
  const attrOriginals = useRef<Map<string, string>>(new Map());  // "elUid:attr" → English (dedupe)
  const attrDone = useRef<WeakSet<Element>>(new WeakSet());
  const observer = useRef<MutationObserver | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queuedText = useRef<Set<Text>>(new Set());
  const queuedAttr = useRef<AttrTarget[]>([]);

  const isSkippable = (node: Node | null): boolean => {
    let n: Node | null = node;
    while (n && n !== document.documentElement) {
      if (n.nodeType === 1) {
        const el = n as HTMLElement;
        if (SKIP_TAGS.has(el.tagName)) return true;
        if (el.hasAttribute?.("data-no-i18n") || el.getAttribute?.("translate") === "no" || el.classList?.contains("notranslate")) return true;
      }
      n = n.parentNode;
    }
    return false;
  };

  const collectText = (root: Node): Text[] => {
    const out: Text[] = [];
    const push = (t: Text) => {
      if (originals.current.has(t)) return; // already translated → never touch again
      const v = t.nodeValue || "";
      if (v.trim() && hasLetters(v) && v.trim().length > 1 && !isSkippable(t.parentNode)) out.push(t);
    };
    if (root.nodeType === Node.TEXT_NODE) { push(root as Text); return out; }
    if (root.nodeType !== Node.ELEMENT_NODE) return out;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n: Node | null;
    while ((n = walker.nextNode())) push(n as Text);
    return out;
  };

  const collectAttrs = (root: Node): AttrTarget[] => {
    const out: AttrTarget[] = [];
    if (root.nodeType !== Node.ELEMENT_NODE) return out;
    const els = [root as Element, ...Array.from((root as Element).querySelectorAll("*"))];
    for (const el of els) {
      if (attrDone.current.has(el) || isSkippable(el)) continue;
      for (const attr of ATTRS) {
        const val = el.getAttribute(attr);
        if (val && val.trim() && hasLetters(val) && val.trim().length > 1) out.push({ el, attr, val });
      }
    }
    return out;
  };

  const persist = () => {
    try {
      const obj: Record<string, string> = {};
      cache.current.forEach((v, k) => { obj[k] = v; });
      localStorage.setItem(CACHE_KEY, JSON.stringify(obj));
    } catch { /* quota — still works in memory */ }
  };

  // Write translations with the observer paused so our own edits aren't observed.
  const writeNodes = (textNodes: Text[], attrTargets: AttrTarget[]) => {
    observer.current?.disconnect();
    for (const node of textNodes) {
      const raw = node.nodeValue || "";
      const key = raw.trim();
      const hit = cache.current.get(key);
      if (hit && hit !== key && !originals.current.has(node)) {
        originals.current.set(node, raw);
        const lead = raw.match(/^\s*/)?.[0] ?? "";
        const trail = raw.match(/\s*$/)?.[0] ?? "";
        node.nodeValue = lead + hit + trail;
      }
    }
    for (const { el, attr, val } of attrTargets) {
      const key = val.trim();
      const hit = cache.current.get(key);
      if (hit && hit !== key) {
        const uid = `${attr}:${val}`;
        if (!attrOriginals.current.has(uid)) attrOriginals.current.set(uid, val);
        el.setAttribute(attr, hit);
        attrDone.current.add(el);
      }
    }
    if (observer.current) { observer.current.takeRecords(); observer.current.observe(document.body, OBS_CONFIG); }
  };

  const fetchTranslations = async (list: string[]) => {
    for (let i = 0; i < list.length; i += 60) {
      const chunk = list.slice(i, i + 60);
      try {
        const res = await fetch("/api/translate", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ texts: chunk, target: "es" }),
        });
        const d = await res.json().catch(() => ({}));
        const out: string[] = Array.isArray(d.translations) ? d.translations : chunk;
        chunk.forEach((src, k) => cache.current.set(src, typeof out[k] === "string" ? out[k] : src));
      } catch {
        chunk.forEach((src) => cache.current.set(src, src));
      }
    }
    persist();
  };

  // Translate a specific set of nodes (never the whole document twice).
  const process = useCallback(async (textNodes: Text[], attrTargets: AttrTarget[]) => {
    if (!textNodes.length && !attrTargets.length) return;
    writeNodes(textNodes, attrTargets); // apply anything already cached first
    const need = new Set<string>();
    for (const t of textNodes) { if (!originals.current.has(t)) { const k = (t.nodeValue || "").trim(); if (k.length > 1 && !cache.current.has(k)) need.add(k); } }
    for (const a of attrTargets) { const k = a.val.trim(); if (k.length > 1 && !cache.current.has(k)) need.add(k); }
    const missing = [...need].slice(0, 400);
    if (missing.length) {
      setBusy(true);
      await fetchTranslations(missing);
      writeNodes(textNodes, attrTargets);
      setBusy(false);
    }
  }, []);

  const flushQueue = useCallback(() => {
    const nodes = [...queuedText.current];
    const attrs = queuedAttr.current;
    queuedText.current = new Set();
    queuedAttr.current = [];
    void process(nodes, attrs);
  }, [process]);

  const startObserver = useCallback(() => {
    if (observer.current) return;
    observer.current = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === "characterData") {
          const t = m.target as Text;
          if (t.nodeType === Node.TEXT_NODE && !originals.current.has(t)) collectText(t).forEach((n) => queuedText.current.add(n));
        } else if (m.type === "attributes") {
          if (m.target.nodeType === Node.ELEMENT_NODE) collectAttrs(m.target as Element).forEach((a) => queuedAttr.current.push(a));
        } else {
          m.addedNodes.forEach((n) => {
            collectText(n).forEach((x) => queuedText.current.add(x));
            queuedAttr.current.push(...collectAttrs(n));
          });
        }
      }
      if (!queuedText.current.size && !queuedAttr.current.length) return;
      if (debounce.current) clearTimeout(debounce.current);
      debounce.current = setTimeout(flushQueue, 300);
    });
    observer.current.observe(document.body, OBS_CONFIG);
  }, [flushQueue]);

  const restoreEnglish = useCallback(() => {
    observer.current?.disconnect();
    observer.current = null;
    originals.current.forEach((val, node) => { try { node.nodeValue = val; } catch { /* detached */ } });
    originals.current.clear();
    // attributes: originals were stored by value key; walk the DOM and restore any we changed
    attrOriginals.current.forEach((orig, uid) => {
      const attr = uid.slice(0, uid.indexOf(":"));
      const es = cache.current.get(orig.trim());
      if (!es) return;
      document.querySelectorAll(`[${attr}]`).forEach((el) => { if (el.getAttribute(attr) === es) el.setAttribute(attr, orig); });
    });
    attrOriginals.current.clear();
    attrDone.current = new WeakSet();
  }, []);

  // init: load cache + saved language
  useEffect(() => {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (raw) { const o = JSON.parse(raw) as Record<string, string>; Object.entries(o).forEach(([k, v]) => cache.current.set(k, v)); }
    } catch { /* ignore */ }
    let saved: "en" | "es" = "en";
    try { if (localStorage.getItem(LANG_KEY) === "es") saved = "es"; } catch { /* ignore */ }
    setLang(saved);
    if (saved === "es") {
      document.documentElement.lang = "es";
      startObserver();
      void process(collectText(document.body), collectAttrs(document.body));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = useCallback(() => {
    const next = lang === "es" ? "en" : "es";
    setLang(next);
    try { localStorage.setItem(LANG_KEY, next); } catch { /* ignore */ }
    document.documentElement.lang = next;
    if (next === "es") { startObserver(); void process(collectText(document.body), collectAttrs(document.body)); }
    else { restoreEnglish(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang, startObserver, process, restoreEnglish]);

  return (
    <div data-no-i18n translate="no" className="notranslate fixed bottom-4 left-4 z-[90]">
      <button
        onClick={toggle}
        aria-label={lang === "es" ? "Cambiar a inglés" : "Switch to Spanish"}
        title={lang === "es" ? "English" : "Español"}
        className="inline-flex items-center gap-2 rounded-full border border-black/10 bg-white/95 px-3 py-2 text-xs font-semibold text-neutral-700 shadow-lg backdrop-blur transition-colors hover:bg-white"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Globe className="h-4 w-4" />}
        <span className={lang === "es" ? "text-neutral-400" : "text-neutral-900"}>EN</span>
        <span className="text-neutral-300">/</span>
        <span className={lang === "es" ? "text-neutral-900" : "text-neutral-400"}>ES</span>
      </button>
    </div>
  );
}
