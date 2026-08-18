import type { Metadata } from "next";

import { SERVER_RUNTIME_CONFIG } from "@/src/config/serverRuntime";

import "./globals.generated.css";

export const metadata: Metadata = {
  metadataBase: new URL(SERVER_RUNTIME_CONFIG.siteUrl),
  title: "TwoOnly · 双人加密聊天",
  description: "只允许两个人加入，支持文字、图片、语音和 Beta 文件传输的加密聊天。",
  openGraph: {
    title: "TwoOnly · 双人加密聊天",
    description: "只允许两个人加入的加密聊天。",
    images: [{ url: "/og.jpg", width: 1200, height: 630, alt: "TwoOnly 双人密聊" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "TwoOnly · 双人加密聊天",
    description: "只允许两个人加入的加密聊天。",
    images: ["/og.jpg"],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
