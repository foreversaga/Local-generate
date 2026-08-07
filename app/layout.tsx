import type { Metadata } from "next";
import "./globals.css";

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
    <html lang="zh-Hant">
      <body>{children}</body>
    </html>
  );
}
