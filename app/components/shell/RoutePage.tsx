"use client";

import { ReactNode } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import type { TranslationKey } from "../../i18n/dictionaries";
import styles from "./RoutePage.module.css";

type RoutePageProps = {
  eyebrow?: TranslationKey;
  eyebrowText?: string;
  title?: TranslationKey;
  titleText?: string;
  description?: TranslationKey;
  descriptionText?: string;
  titleVariables?: Record<string, string | number>;
  compact?: boolean;
  children?: ReactNode;
};

type RouteCardProps = {
  code: string;
  title?: TranslationKey;
  titleText?: string;
  description?: TranslationKey;
  descriptionText?: string;
  href: string;
  actionLabel?: TranslationKey;
  actionText?: string;
};

function resolveCopy(
  t: (key: TranslationKey, variables?: Record<string, string | number>) => string,
  key: TranslationKey | undefined,
  text: string | undefined,
  variables?: Record<string, string | number>,
) {
  if (text?.trim()) return text;
  return key ? t(key, variables) : "";
}

export function RoutePage({
  eyebrow,
  eyebrowText,
  title,
  titleText,
  description,
  descriptionText,
  titleVariables,
  compact = false,
  children,
}: RoutePageProps) {
  const { t } = useI18n();
  const resolvedEyebrow = resolveCopy(t, eyebrow, eyebrowText);
  const resolvedTitle = resolveCopy(t, title, titleText, titleVariables);
  const resolvedDescription = resolveCopy(t, description, descriptionText);

  return (
    <section className={`${styles.page} ${compact ? styles.pageCompact : ""}`}>
      <header className={`${styles.intro} ${compact ? styles.introCompact : ""}`}>
        {!compact && resolvedEyebrow && <p className={styles.eyebrow}>{resolvedEyebrow}</p>}
        {resolvedTitle && <h1 className={styles.title}>{resolvedTitle}</h1>}
        {!compact && resolvedDescription && <p className={styles.description}>{resolvedDescription}</p>}
      </header>
      {children}
    </section>
  );
}

export function RouteCard({
  code,
  title,
  titleText,
  description,
  descriptionText,
  href,
  actionLabel = "action.openTool",
  actionText,
}: RouteCardProps) {
  const { t } = useI18n();
  const resolvedTitle = resolveCopy(t, title, titleText);
  const resolvedDescription = resolveCopy(t, description, descriptionText);
  const resolvedAction = actionText?.trim() || t(actionLabel);

  return (
    <a className={styles.card} href={href}>
      <div>
        <span className={styles.cardCode}>{code}</span>
        <h2 className={styles.cardTitle}>{resolvedTitle}</h2>
        <p className={styles.cardDescription}>{resolvedDescription}</p>
      </div>
      <span className={styles.cardAction}>
        <span>{resolvedAction}</span>
        <span aria-hidden="true">↗</span>
      </span>
    </a>
  );
}

export function RouteGrid({ children }: { children: ReactNode }) {
  return <div className={styles.grid}>{children}</div>;
}
