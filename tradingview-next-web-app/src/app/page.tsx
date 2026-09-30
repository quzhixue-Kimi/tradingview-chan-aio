"use client";

import TradingViewChart from "@/components/TradingViewChart";
import type { SupportedResolution } from "@/lib/datafeed";

export default function Home() {
  const symbol = "QQQ";
  const interval: SupportedResolution = "3";

  return (
    <main
      style={{
        width: "100vw",
        height: "100vh",
        overflow: "hidden",
        background: "#0B0E11",
      }}
    >
      <TradingViewChart symbol={symbol} interval={interval} />
    </main>
  );
}
