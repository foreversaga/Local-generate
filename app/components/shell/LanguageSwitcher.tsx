"use client";

import { useI18n } from "../../i18n/I18nProvider";
import type { Locale } from "../../i18n/dictionaries";
import styles from "./LanguageSwitcher.module.css";

export function LanguageSwitcher() {
  const { locale, setLocale, t } = useI18n();
  return (
    <label className={styles.root}>
      <span className={styles.srLabel}>{t("language.label")}</span>
      <select aria-label={t("language.label")} value={locale} onChange={(event) => setLocale(event.target.value as Locale)}>
        <option value="zh-TW">繁中</option>
        <option value="en">EN</option>
      </select>
    </label>
  );
}
