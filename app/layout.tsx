import type { Metadata } from "next";
import "./globals.css";
import { I18nProvider } from "./i18n/I18nProvider";

export const metadata: Metadata = {
  title: "H3 Studio — 本地影片工作台",
  description: "本機影片生成工具，使用 Ollama 整理提示詞與 MiniMax H3 生成影片。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-Hant" suppressHydrationWarning>
      <body><I18nProvider>{children}</I18nProvider></body>
    </html>
  );
}
