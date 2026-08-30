"use client";

import { useEffect, useRef } from "react";

import {
  createTwelveDatafeed,
  isSupportedResolution,
  type SupportedResolution,
} from "@/lib/datafeed";
import { createLadderMaIndicator } from "@/lib/indicators/ladder-ma";
import { NY_TZ } from "@/lib/market-session";

declare global {
  interface Window {
    TradingView?: {
      widget: new (options: Record<string, unknown>) => {
        onChartReady: (callback: () => void) => void;

        activeChart: () => {
          createStudy: (
            name: string,
            forceOverlay?: boolean,
            lock?: boolean,
            inputs?: unknown[],
            callback?: (entityId: string) => void,
          ) => string;
        };

        remove: () => void;
      };
    };
  }
}

type TradingViewChartProps = {
  symbol: string;
  interval: SupportedResolution;
};

const SCRIPT_ID = "tradingview-charting-library";
const CHART_CONTAINER_ID = "tv_chart_container";

function loadChartingLibrary(): Promise<void> {
  if (window.TradingView) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const existingScript = document.getElementById(
      SCRIPT_ID,
    ) as HTMLScriptElement | null;

    if (existingScript) {
      existingScript.addEventListener("load", () => resolve(), {
        once: true,
      });

      existingScript.addEventListener(
        "error",
        () => {
          reject(new Error("Failed to load TradingView Charting Library."));
        },
        { once: true },
      );

      return;
    }

    const script = document.createElement("script");

    script.id = SCRIPT_ID;
    script.src = "/charting_library/charting_library.standalone.js";
    script.async = true;

    script.onload = () => resolve();

    script.onerror = () => {
      reject(
        new Error(
          "Failed to load /charting_library/charting_library.standalone.js",
        ),
      );
    };

    document.head.appendChild(script);
  });
}

export default function TradingViewChart({
  symbol,
  interval,
}: TradingViewChartProps) {
  const widgetRef = useRef<{
    remove: () => void;
  } | null>(null);

  useEffect(() => {
    let disposed = false;

    async function initializeChart() {
      if (!isSupportedResolution(interval)) {
        throw new Error(`Unsupported interval: ${interval}`);
      }

      await loadChartingLibrary();

      if (disposed || !window.TradingView) {
        return;
      }

      widgetRef.current?.remove();
      widgetRef.current = null;

      const widget = new window.TradingView.widget({
        container: CHART_CONTAINER_ID,
        library_path: "/charting_library/",

        datafeed: createTwelveDatafeed(),

        symbol: symbol.trim().toUpperCase() || "QQQ",
        interval,

        timezone: NY_TZ,
        locale: "en",

        autosize: true,
        fullscreen: false,
        theme: "dark",

        /**
         * 注册 JS Custom Study。
         * TradingView Charting Library 不运行 Pine Script；
         * 此处加载的是 src/lib/indicators/ladder-ma.ts 中的 JS/PineJS 指标。
         */
        custom_indicators_getter: (PineJS: unknown) => {
          return Promise.resolve([createLadderMaIndicator(PineJS as never)]);
        },

        enabled_features: [
          "header_widget",
          "header_resolutions",
          "left_toolbar",
          "items_favoriting",
        ],

        disabled_features: [
          "use_localstorage_for_settings",

          /**
           * RTH-only：不展示盘前 / 盘后。
           */
          "pre_post_market_sessions",

          /**
           * 不配 charts_storage_url / save_load_adapter，
           * 禁用以避免 undefined study_templates 请求。
           */
          "header_saveload",
          "study_templates",

          /**
           * 隐藏底部默认 timeframes：
           * 3m / 1m / 5d / 1d ...
           */
          "timeframes_toolbar",

          /**
           * 不默认显示 volume 副图。
           */
          "create_volume_indicator_by_default",
        ],

        overrides: {
          "mainSeriesProperties.candleStyle.upColor": "#26A69A",
          "mainSeriesProperties.candleStyle.downColor": "#EF5350",
          "mainSeriesProperties.candleStyle.borderUpColor": "#26A69A",
          "mainSeriesProperties.candleStyle.borderDownColor": "#EF5350",
          "mainSeriesProperties.candleStyle.wickUpColor": "#26A69A",
          "mainSeriesProperties.candleStyle.wickDownColor": "#EF5350",

          "paneProperties.background": "#0B0E11",
          "paneProperties.backgroundType": "solid",

          "paneProperties.vertGridProperties.color": "#1D242C",
          "paneProperties.horzGridProperties.color": "#1D242C",

          "scalesProperties.textColor": "#AAB2BF",
          "scalesProperties.lineColor": "#2B3139",

          "mainSeriesProperties.showPriceLine": true,
        },
      });

      widgetRef.current = widget;

      widget.onChartReady(() => {
        if (disposed) {
          return;
        }

        try {
          widget.activeChart().createStudy("Realtime Ladder + MA", true, false);

          console.info("[TradingView] Realtime Ladder + MA study added.");
        } catch (error) {
          console.error(
            "[TradingView] Failed to add Realtime Ladder + MA study:",
            error,
          );
        }
      });
    }

    void initializeChart().catch((error) => {
      console.error("[TradingView] Chart initialization failed:", error);
    });

    return () => {
      disposed = true;

      widgetRef.current?.remove();
      widgetRef.current = null;
    };
  }, [symbol, interval]);

  return (
    <div
      id={CHART_CONTAINER_ID}
      style={{
        width: "100%",
        height: "100%",
        minHeight: 0,
      }}
    />
  );
}
