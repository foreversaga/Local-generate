"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { DEFAULT_LOCALE, dictionaries, isLocale, LOCALE_STORAGE_KEY, type Locale, type TranslationKey } from "./dictionaries";

type Variables = Record<string, string | number>;
type I18nValue = { locale: Locale; setLocale: (locale: Locale) => void; t: (key: TranslationKey, variables?: Variables) => string };

const I18nContext = createContext<I18nValue | null>(null);

function interpolate(template: string, variables?: Variables) {
  if (!variables) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) => variables[key] === undefined ? match : String(variables[key]));
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
      if (isLocale(stored)) setLocaleState(stored);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale === "en" ? "en" : "zh-Hant";
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    window.localStorage.setItem(LOCALE_STORAGE_KEY, next);
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
