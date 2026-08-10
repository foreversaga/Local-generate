import { ReactNode } from "react";
import styles from "./RoutePage.module.css";

type RoutePageProps = {
  eyebrow: string;
  title: string;
  description: string;
  children?: ReactNode;
};

type RouteCardProps = {
  code: string;
  title: string;
  description: string;
  href: string;
  actionLabel?: string;
};

type MigrationPanelProps = {
  title: string;
  children: ReactNode;
  legacyHref?: string;
  legacyLabel?: string;
};

export function RoutePage({ eyebrow, title, description, children }: RoutePageProps) {
  return (
    <section className={styles.page}>
      <header className={styles.intro}>
        <p className={styles.eyebrow}>{eyebrow}</p>
        <h1 className={styles.title}>{title}</h1>
        <p className={styles.description}>{description}</p>
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
  actionLabel = "Open",
}: RouteCardProps) {
  return (
    <a className={styles.card} href={href}>
      <div>
        <span className={styles.cardCode}>{code}</span>
        <h2 className={styles.cardTitle}>{title}</h2>
        <p className={styles.cardDescription}>{description}</p>
      </div>
      <span className={styles.cardAction}>
        <span>{actionLabel}</span>
        <span aria-hidden="true">↗</span>
      </span>
    </a>
  );
}

export function RouteGrid({ children }: { children: ReactNode }) {
  return <div className={styles.grid}>{children}</div>;
}

export function MigrationPanel({
  title,
  children,
  legacyHref = "/app",
  legacyLabel = "開啟既有工作台",
}: MigrationPanelProps) {
  return (
    <section className={styles.panel}>
      <div className={styles.panelHeader}>
        <h2 className={styles.panelTitle}>{title}</h2>
        <span className={styles.badge}>Migration</span>
      </div>
      <div className={styles.note}>{children}</div>
      <div className={styles.actions}>
        <a className={styles.secondaryLink} href={legacyHref}>{legacyLabel}</a>
      </div>
    </section>
  );
}
