"use client";

import { ReactNode } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import type { TranslationKey } from "../../i18n/dictionaries";
import styles from "./RoutePage.module.css";

type RoutePageProps = {
  eyebrow: TranslationKey;
  title: TranslationKey;
  description: TranslationKey;
  titleVariables?: Record<string, string | number>;
  children?: ReactNode;
};

type RouteCardProps = {
  code: string;
  title: TranslationKey;
  description: TranslationKey;
  href: string;
  actionLabel?: TranslationKey;
};

export function RoutePage({ eyebrow, title, description, titleVariables, children }: RoutePageProps) {
  const { t } = useI18n();
  return (
    <section className={styles.page}>
      <header className={styles.intro}>
        <p className={styles.eyebrow}>{t(eyebrow)}</p>
        <h1 className={styles.title}>{t(title, titleVariables)}</h1>
        <p className={styles.description}>{t(description)}</p>
      </header>
      {children}
    </section>
  );
}

export function RouteCard({
  code,
  title,
  description,
  href,
  actionLabel = "action.openTool",
}: RouteCardProps) {
  const { t } = useI18n();
  return (
    <a className={styles.card} href={href}>
      <div>
        <span className={styles.cardCode}>{code}</span>
        <h2 className={styles.cardTitle}>{t(title)}</h2>
        <p className={styles.cardDescription}>{t(description)}</p>
      </div>
      <span className={styles.cardAction}>
        <span>{t(actionLabel)}</span>
        <span aria-hidden="true">↗</span>
      </span>
    </a>
  );
}

export function RouteGrid({ children }: { children: ReactNode }) {
  return <div className={styles.grid}>{children}</div>;
}
