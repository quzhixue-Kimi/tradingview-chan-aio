import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Realtime TradingView Chart",
  description:
    "RTH-only US equity chart powered by Twelve Data and TradingView Charting Library",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
