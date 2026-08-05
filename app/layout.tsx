import type { Metadata, Viewport } from "next";
import "./globals.css";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL
  ? process.env.NEXT_PUBLIC_SITE_URL
  : process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : "http://localhost:3100";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  applicationName: "验证码助手",
  title: "验证码助手｜美国号码自动收码",
  description: "获取美国验证号码，自动查询短信验证码，支持超时换号与订单追踪。",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/app-icon.svg", type: "image/svg+xml" },
      { url: "/app-icon-512.png", type: "image/png", sizes: "512x512" },
    ],
    apple: [{ url: "/apple-touch-icon.png", type: "image/png", sizes: "180x180" }],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "验证码助手",
  },
  formatDetection: { telephone: false },
  robots: { index: false, follow: false },
  openGraph: {
    title: "验证码助手",
    description: "美国号码 · 自动收码",
    images: [{ url: "/og.png", width: 1733, height: 909, alt: "验证码助手" }],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "验证码助手",
    description: "美国号码 · 自动收码",
    images: ["/og.png"],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#070b16",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
