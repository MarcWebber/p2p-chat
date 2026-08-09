import type { Metadata } from "next";
import "./globals.css";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL
  ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "https://twoonly-chat.vercel.app");

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: "TwoOnly · 双人加密聊天",
  description: "只允许两个人加入，支持文字、图片和语音的加密聊天。",
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
