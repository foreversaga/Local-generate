import type { Metadata } from "next";
import { cookies } from "next/headers";
import "./globals.css";
import { I18nProvider } from "./i18n/I18nProvider";
import { DEFAULT_LOCALE, isLocale, LOCALE_COOKIE_KEY } from "./i18n/dictionaries";

export const metadata: Metadata = {
  title: "H3 Studio — 本地影片工作台",
  description: "本機影片生成工具，使用 Ollama 整理提示詞與 MiniMax H3 生成影片。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const cookieStore = await cookies();
  const storedLocale = cookieStore.get(LOCALE_COOKIE_KEY)?.value;
  const initialLocale = isLocale(storedLocale) ? storedLocale : DEFAULT_LOCALE;

  return (
    <html lang={initialLocale === "en" ? "en" : "zh-Hant"}>
      <body><I18nProvider initialLocale={initialLocale}>{children}</I18nProvider></body>
    </html>
  );
}
