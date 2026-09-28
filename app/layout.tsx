import type { Metadata } from "next";
import type { ReactNode } from "react";
import { THEME_BOOT_SCRIPT } from "@/lib/client/theme";
import "./globals.css";

export const metadata: Metadata = {
  title: "imagegen · TikZ",
  description: "Prompt → TikZ → LaTeX → dvisvgm → SVG",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
