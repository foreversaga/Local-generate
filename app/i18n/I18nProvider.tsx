"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { dictionaries, isLocale, LOCALE_COOKIE_KEY, LOCALE_STORAGE_KEY, type Locale, type TranslationKey } from "./dictionaries";

type Variables = Record<string, string | number>;
type I18nValue = { locale: Locale; setLocale: (locale: Locale) => void; t: (key: TranslationKey, variables?: Variables) => string };

const I18nContext = createContext<I18nValue | null>(null);

function interpolate(template: string, variables?: Variables) {
  if (!variables) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) => variables[key] === undefined ? match : String(variables[key]));
}

function persistLocale(locale: Locale) {
  window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  document.cookie = `${LOCALE_COOKIE_KEY}=${encodeURIComponent(locale)}; Path=/app; Max-Age=31536000; SameSite=Lax`;
}

export function I18nProvider({ children, initialLocale }: { children: ReactNode; initialLocale: Locale }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  useEffect(() => {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (isLocale(stored) && stored !== initialLocale) {
      const frame = window.requestAnimationFrame(() => {
        setLocaleState(stored);
        persistLocale(stored);
      });
      return () => window.cancelAnimationFrame(frame);
    }
    persistLocale(initialLocale);
  }, [initialLocale]);

  useEffect(() => {
    document.documentElement.lang = locale === "en" ? "en" : "zh-Hant";
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    persistLocale(next);
  }, []);

  const value = useMemo<I18nValue>(() => ({
    locale,
    setLocale,
    t: (key, variables) => interpolate(dictionaries[locale][key], variables),
  }), [locale, setLocale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used inside I18nProvider");
  return value;
}
