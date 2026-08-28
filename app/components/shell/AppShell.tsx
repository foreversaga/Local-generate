"use client";

import { usePathname } from "next/navigation";
import { type ReactNode } from "react";
import {
  primaryRouteForPath,
  routeTitle,
  WEB_UI_ROUTES,
} from "../../lib/webui-routes.mjs";
import { RecentJobsDrawer } from "../jobs/RecentJobsDrawer";
import { ServiceStatusLink } from "./ServiceStatusLink";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { useI18n } from "../../i18n/I18nProvider";
import styles from "./AppShell.module.css";

type AppShellProps = {
  children: ReactNode;
};

const NAV_ICONS: Record<string, ReactNode> = {
  create: <><path d="M12 5v14"/><path d="M5 12h14"/></>,
  jobs: <><path d="M6 4h12v16H6z"/><path d="M9 8h6M9 12h6M9 16h4"/></>,
  library: <><rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/></>,
  tools: <><path d="m14 6 4-4 4 4-4 4"/><path d="m18 6-8.5 8.5"/><path d="M6.5 12.5 2 17l5 5 4.5-4.5"/></>,
  settings: <><circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.4 1A7 7 0 0 0 15 6l-.3-2.6h-4L10.5 6A7 7 0 0 0 9 7.1l-2.4-1-2 3.4 2 1.5a7 7 0 0 0 0 2l-2 1.5 2 3.4 2.4-1A7 7 0 0 0 10.5 18l.3 2.6h4L15 18a7 7 0 0 0 1.5-1.1l2.4 1 2-3.4-2-1.5c.1-.3.1-.7.1-1Z"/></>,
};

function NavIcon({ id }: { id: string }) {
  return <svg className={styles.navSvg} viewBox="0 0 24 24" aria-hidden="true">{NAV_ICONS[id]}</svg>;
}

export function AppShell({ children }: AppShellProps) {
  const { locale, t } = useI18n();
  const pathname = usePathname() || "/app/create";
  const activeRoute = primaryRouteForPath(pathname);
  const title = routeTitle(pathname, locale);

  return (
    <div className={styles.shell}>
      <a className={styles.skipLink} href="#main-content">
        {locale === "zh-TW" ? "跳到主要內容" : "Skip to main content"}
      </a>

      <aside className={styles.desktopSidebar} aria-label={t("shell.primaryNav")}>
        <a className={styles.brand} href="/app/create">
          <span className={styles.brandMark} aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <span className={styles.brandName}>H3 STUDIO</span>
        </a>

        <div className={styles.navLabel}>{t("shell.workspace")}</div>
        <nav className={styles.nav}>
          {WEB_UI_ROUTES.map((route) => {
            const active = route.id === activeRoute;
            return (
              <a
                key={route.id}
                className={`${styles.navItem} ${active ? styles.navItemActive : ""}`}
                href={route.href}
                aria-current={active ? "page" : undefined}
              >
                <span className={styles.navIcon}><NavIcon id={route.id} /></span>
                <span>{t(`nav.${route.id}` as "nav.create")}</span>
              </a>
            );
          })}
        </nav>

        <div className={styles.sidebarFooter}>
          {t("shell.footer").split("\n").map((line) => <span key={line}>{line}<br /></span>)}
        </div>
      </aside>

      <div className={styles.main}>
        <header className={styles.topbar}>
          <div className={styles.breadcrumb}>
            <span className={styles.localLabel}>LOCAL /</span>
            <span className={styles.pageTitle}>{title}</span>
          </div>
          <div className={styles.topActions}>
            <LanguageSwitcher />
            <RecentJobsDrawer />
            <ServiceStatusLink />
          </div>
        </header>

        <main id="main-content" className={styles.content} tabIndex={-1}>{children}</main>
      </div>

      <nav className={styles.mobileNav} aria-label={t("shell.primaryNav")}>
        {WEB_UI_ROUTES.map((route) => {
          const active = route.id === activeRoute;
          return (
            <a
              key={route.id}
              className={`${styles.mobileNavItem} ${active ? styles.mobileNavItemActive : ""}`}
              href={route.href}
              aria-current={active ? "page" : undefined}
            >
              <span className={styles.mobileNavIcon}><NavIcon id={route.id} /></span>
              <span>{t(`nav.${route.id}` as "nav.create")}</span>
            </a>
          );
        })}
      </nav>
    </div>
  );
}
