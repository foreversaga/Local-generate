"use client";

import { usePathname } from "next/navigation";
import { ReactNode } from "react";
import {
  primaryRouteForPath,
  routeTitle,
  WEB_UI_ROUTES,
} from "../../lib/webui-routes.mjs";
import styles from "./AppShell.module.css";

type AppShellProps = {
  children: ReactNode;
};

const NAV_ICONS: Record<string, string> = {
  create: "+",
  jobs: "▤",
  library: "▦",
  tools: "◇",
  settings: "⚙",
};

export function AppShell({ children }: AppShellProps) {
  const pathname = usePathname() || "/app/create";
  const activeRoute = primaryRouteForPath(pathname);
  const title = routeTitle(pathname);

  return (
    <div className={styles.shell}>
      <aside className={styles.desktopSidebar} aria-label="主要導覽">
        <a className={styles.brand} href="/app/create">
          <span className={styles.brandMark} aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <span className={styles.brandName}>H3 STUDIO</span>
        </a>

        <div className={styles.navLabel}>Workspace</div>
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
                <span className={styles.navIcon} aria-hidden="true">{NAV_ICONS[route.id]}</span>
                <span>{route.label}</span>
              </a>
            );
          })}
        </nav>

        <div className={styles.sidebarFooter}>
          Local-first workspace<br />
          Existing generation APIs remain unchanged during migration.
        </div>
      </aside>

      <div className={styles.main}>
        <header className={styles.topbar}>
          <div className={styles.breadcrumb}>
            <span className={styles.localLabel}>LOCAL /</span>
            <span className={styles.pageTitle}>{title}</span>
          </div>
          <div className={styles.localState}>
            <span className={styles.statusDot} aria-hidden="true" />
            <span>Local</span>
          </div>
        </header>

        <main className={styles.content}>{children}</main>
      </div>

      <nav className={styles.mobileNav} aria-label="主要導覽">
        {WEB_UI_ROUTES.map((route) => {
          const active = route.id === activeRoute;
          return (
            <a
              key={route.id}
              className={`${styles.mobileNavItem} ${active ? styles.mobileNavItemActive : ""}`}
              href={route.href}
              aria-current={active ? "page" : undefined}
            >
              <span className={styles.mobileNavIcon} aria-hidden="true">{NAV_ICONS[route.id]}</span>
              <span>{route.label}</span>
            </a>
          );
        })}
      </nav>
    </div>
  );
}
