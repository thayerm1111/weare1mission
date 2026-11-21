"use client";

import { useCallback, useSyncExternalStore } from "react";
import { SPANISH_COPY } from "./homepage-spanish";

export type HomepageLocale = "en" | "es";
export type HomepageTranslator = (copy: string, values?: Record<string, string | number>) => string;

/** The existing language widget owns persistence and html.lang; this route only observes it. */
export function getHomepageLocale(): HomepageLocale {
  return typeof document !== "undefined" && document.documentElement.lang.toLowerCase().startsWith("es") ? "es" : "en";
}

const subscribers = new Set<() => void>();
let languageObserver: MutationObserver | null = null;

function subscribeToHomepageLocale(notify: () => void) {
  subscribers.add(notify);
  if (!languageObserver) {
    languageObserver = new MutationObserver(() => subscribers.forEach((subscriber) => subscriber()));
    languageObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
  }
  return () => {
    subscribers.delete(notify);
    if (!subscribers.size) { languageObserver?.disconnect(); languageObserver = null; }
  };
}

const getServerLocale = (): HomepageLocale => "en";

export function translateHomepageCopy(locale: HomepageLocale, copy: string, values?: Record<string, string | number>): string {
  const key = copy.replace(/\s+/g, " ").trim();
  const translated = locale === "es" ? SPANISH_COPY[key] ?? key : key;
  const interpolated = translated.replace(/\{(\w+)\}/g, (token, name: string) => String(values?.[name] ?? token));
  return (/^\s/.test(copy) ? " " : "") + interpolated + (/\s$/.test(copy) ? " " : "");
}

export function useHomepageTranslation() {
  const locale = useSyncExternalStore(subscribeToHomepageLocale, getHomepageLocale, getServerLocale);
  const t: HomepageTranslator = useCallback((copy, values) => translateHomepageCopy(locale, copy, values), [locale]);
  return { locale, t };
}
