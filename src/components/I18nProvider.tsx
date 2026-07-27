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
 * Numbers, tickers and brand names are preserved by the translation prompt, and
 * switching back to English restores the original text exactly.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Globe, Loader2 } from "lucide-react";

const LANG_KEY = "om-lang";
const CACHE_KEY = "om-i18n-es";
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "CODE", "PRE", "TEXTAREA", "SVG", "CANVAS"]);
const ATTRS = ["placeholder", "title", "aria-label", "alt"];
const hasLetters = (s: string) => /[A-Za-z]/.test(s);

export function I18nProvider() {
  const [lang, setLang] = useState<"en" | "es">("en");
  const [busy, setBusy] = useState(false);

  const cache = useRef<Map<string, string>>(new Map());
  const originals = useRef<Map<Text, string>>(new Map());
  const attrOriginals = useRef<Map<Element, Record<string, string>>>(new Map());
  const observer = useRef<MutationObserver | null>(null);
  const applying = useRef(false);
  const pending = useRef<Set<string>>(new Set());
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── helpers ──────────────────────────────────────────────────────────────
  const isSkippable = (node: Node | null): boolean => {
    let n: Node | null = node;
    while (n && n !== document.body.parentNode) {
      if (n.nodeType === 1) {
        const el = n as HTMLElement;
        if (SKIP_TAGS.has(el.tagName)) return true;
        if (el.hasAttribute?.("data-no-i18n") || el.getAttribute?.("translate") === "no" || el.classList?.contains("notranslate")) return true;
      }
      n = n.parentNode;
    }
    return false;
  };

  const textNodesIn = (root: Node): Text[] => {
    const out: Text[] = [];
    if (root.nodeType === Node.TEXT_NODE) {
      const t = root as Text;
      if (t.nodeValue && t.nodeValue.trim() && hasLetters(t.nodeValue) && !isSkippable(t.parentNode)) out.push(t);
      return out;
    }
    if (root.nodeType !== Node.ELEMENT_NODE) return out;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const v = node.nodeValue || "";
        if (!v.trim() || !hasLetters(v)) return NodeFilter.FILTER_REJECT;
        if (isSkippable(node.parentNode)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n: Node | null;
    while ((n = walker.nextNode())) out.push(n as Text);
    return out;
  };

  const attrTargetsIn = (root: Node): { el: Element; attr: string; val: string }[] => {
    const out: { el: Element; attr: string; val: string }[] = [];
    const els = root.nodeType === Node.ELEMENT_NODE ? [root as Element, ...Array.from((root as Element).querySelectorAll("*"))] : [];
    for (const el of els) {
      if (isSkippable(el)) continue;
      for (const attr of ATTRS) {
        const val = el.getAttribute(attr);
        if (val && val.trim() && hasLetters(val)) out.push({ el, attr, val });
      }
    }
    return out;
  };

  const persistCache = () => {
    try {
      const obj: Record<string, string> = {};
      cache.current.forEach((v, k) => { obj[k] = v; });
      localStorage.setItem(CACHE_KEY, JSON.stringify(obj));
    } catch { /* quota — fine, still works in-memory */ }
  };

  // Apply whatever is already cached to every text node / attribute on the page.
  const applyCache = useCallback(() => {
    applying.current = true;
    for (const node of textNodesIn(document.body)) {
      const raw = node.nodeValue || "";
      const key = raw.trim();
      const hit = cache.current.get(key);
      if (hit && hit !== key) {
        if (!originals.current.has(node)) originals.current.set(node, raw);
        const lead = raw.match(/^\s*/)?.[0] ?? "";
        const trail = raw.match(/\s*$/)?.[0] ?? "";
        node.nodeValue = lead + hit + trail;
      }
    }
    for (const { el, attr, val } of attrTargetsIn(document.body)) {
      const key = val.trim();
      const hit = cache.current.get(key);
      if (hit && hit !== key) {
        const store = attrOriginals.current.get(el) || {};
        if (!(attr in store)) { store[attr] = val; attrOriginals.current.set(el, store); }
        el.setAttribute(attr, hit);
      }
    }
    applying.current = false;
  }, []);

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
    persistCache();
  };

  // Gather everything on the page, translate what isn't cached yet, then apply.
  const translateAll = useCallback(async () => {
    const strings = new Set<string>();
    for (const node of textNodesIn(document.body)) strings.add((node.nodeValue || "").trim());
    for (const { val } of attrTargetsIn(document.body)) strings.add(val.trim());
    const missing = [...strings].filter((s) => s.length > 1 && !cache.current.has(s)).slice(0, 400);
    applyCache(); // show any cached hits immediately
    if (missing.length) {
      setBusy(true);
      await fetchTranslations(missing);
      applyCache();
      setBusy(false);
    }
  }, [applyCache]);

  // Debounced translation of strings that appear after the first pass.
  const queue = useCallback((strings: string[]) => {
    let added = false;
    for (const s of strings) { if (s.length > 1 && !cache.current.has(s)) { pending.current.add(s); added = true; } }
    // apply already-cached immediately for snappy re-renders
    applyCache();
    if (!added) return;
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(async () => {
      const batch = [...pending.current].slice(0, 400);
      pending.current.clear();
      if (!batch.length) return;
      setBusy(true);
      await fetchTranslations(batch);
      applyCache();
      setBusy(false);
    }, 350);
  }, [applyCache]);

  const startObserver = useCallback(() => {
    if (observer.current) return;
    observer.current = new MutationObserver((muts) => {
      if (applying.current) return;
      const strings: string[] = [];
      for (const m of muts) {
        if (m.type === "characterData" && m.target.nodeType === Node.TEXT_NODE) {
          const t = m.target as Text;
          if (t.nodeValue && t.nodeValue.trim() && hasLetters(t.nodeValue) && !isSkippable(t.parentNode)) strings.push(t.nodeValue.trim());
        }
        m.addedNodes.forEach((n) => {
          for (const node of textNodesIn(n)) strings.push((node.nodeValue || "").trim());
          for (const { val } of attrTargetsIn(n)) strings.push(val.trim());
        });
      }
      if (strings.length) queue(strings);
    });
    observer.current.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }, [queue]);

  const restoreEnglish = useCallback(() => {
    applying.current = true;
    observer.current?.disconnect();
    observer.current = null;
    originals.current.forEach((val, node) => { try { node.nodeValue = val; } catch { /* detached */ } });
    originals.current.clear();
    attrOriginals.current.forEach((attrs, el) => {
      for (const [attr, val] of Object.entries(attrs)) { try { el.setAttribute(attr, val); } catch { /* detached */ } }
    });
    attrOriginals.current.clear();
    applying.current = false;
  }, []);

  // ── init: load saved cache + language ─────────────────────────────────────
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
      void translateAll();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = useCallback(() => {
    const next = lang === "es" ? "en" : "es";
    setLang(next);
    try { localStorage.setItem(LANG_KEY, next); } catch { /* ignore */ }
    document.documentElement.lang = next;
    if (next === "es") { startObserver(); void translateAll(); }
    else { restoreEnglish(); }
  }, [lang, startObserver, translateAll, restoreEnglish]);

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
