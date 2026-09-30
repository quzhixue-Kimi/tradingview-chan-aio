"use client";

import { useEffect, useRef } from "react";

import {
  createTwelveDatafeed,
  isSupportedResolution,
  type SupportedResolution,
} from "@/lib/datafeed";
import { createLadderMaIndicator } from "@/lib/indicators/ladder-ma";
import { createMarIndicator } from "@/lib/indicators/mar";
import {
  CHAN_THEORY_STUDY_NAME,
  createChanTheoryPlaceholder,
  createPivotSrPlaceholder,
  PIVOT_SR_STUDY_NAME,
} from "@/lib/indicators/chan-placeholder";
import { NY_TZ } from "@/lib/market-session";
import {
  fetchChanAnalyze,
  fetchPivotSr,
  isChanSupportedResolution,
} from "@/lib/chan-api";
import {
  clearShapes,
  drawChanTheory,
  drawPivotSrZones,
  type ChartApi,
  type ShapeId,
} from "@/lib/chan-shapes";

declare global {
  interface Window {
    TradingView?: {
      widget: new (options: Record<string, unknown>) => {
        onChartReady: (callback: () => void) => void;

        activeChart: () => ChartApi & {
          symbol: () => string;
          resolution: () => string;
          getAllStudies: () => Array<{
            id?: string | number;
            name?: string;
            description?: string;
          }>;
          onSymbolChanged: () => {
            subscribe: (obj: null, fn: () => void) => void;
          };
          onIntervalChanged: () => {
            subscribe: (obj: null, fn: () => void) => void;
          };
          createStudy: (
            name: string,
            forceOverlay?: boolean,
            lock?: boolean,
          ) => string | Promise<string>;
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

/** How often (ms) to poll getAllStudies() to detect indicator add/remove. */
const STUDY_POLL_MS = 800;

function loadChartingLibrary(): Promise<void> {
  if (window.TradingView) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const existingScript = document.getElementById(
      SCRIPT_ID,
    ) as HTMLScriptElement | null;

    if (existingScript) {
      existingScript.addEventListener("load", () => resolve(), { once: true });
      existingScript.addEventListener(
        "error",
        () => reject(new Error("Failed to load TradingView Charting Library.")),
        { once: true },
      );
      return;
    }

    const script = document.createElement("script");
    script.id = SCRIPT_ID;
    script.src = "/charting_library/charting_library.standalone.js";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () =>
      reject(
        new Error(
          "Failed to load /charting_library/charting_library.standalone.js",
        ),
      );

    document.head.appendChild(script);
  });
}

export default function TradingViewChart({
  symbol,
  interval,
}: TradingViewChartProps) {
  const widgetRef = useRef<{ remove: () => void } | null>(null);

  useEffect(() => {
    let disposed = false;
    let pollTimer: number | null = null;

    // Per-overlay state: shape IDs and whether the study is currently active.
    const chanShapeIds: ShapeId[] = [];
    let chanEnabled = false;

    const pivotShapeIds: ShapeId[] = [];
    let pivotEnabled = false;

    async function initializeChart() {
      if (!isSupportedResolution(interval)) {
        throw new Error(`Unsupported interval: ${interval}`);
      }

      await loadChartingLibrary();

      if (disposed || !window.TradingView) return;

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

        custom_indicators_getter: (PineJS: unknown) => {
          return Promise.resolve([
            createLadderMaIndicator(PineJS as never),
            createMarIndicator(PineJS as never),
            createChanTheoryPlaceholder(PineJS as never),
            createPivotSrPlaceholder(PineJS as never),
          ]);
        },

        enabled_features: [
          "header_widget",
          "header_resolutions",
          "left_toolbar",
          "items_favoriting",
        ],

        disabled_features: [
          "use_localstorage_for_settings",
          "pre_post_market_sessions",
          "header_saveload",
          "study_templates",
          "timeframes_toolbar",
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
        if (disposed) return;

        const chart = widget.activeChart();

        // Add the default Ladder + MA study automatically.
        try {
          chart.createStudy("Realtime Ladder + MA", true, false);
          console.info("[TradingView] Realtime Ladder + MA study added.");
        } catch (error) {
          console.error(
            "[TradingView] Failed to add Realtime Ladder + MA study:",
            error,
          );
        }

        // ----------------------------------------------------------------
        // Helper: check if a named study is currently on the chart.
        // ----------------------------------------------------------------
        function hasStudy(studyName: string): boolean {
          const studies = chart.getAllStudies?.() ?? [];
          return studies.some((s) =>
            String(s.name ?? s.description ?? "")
              .toLowerCase()
              .includes(studyName.toLowerCase()),
          );
        }

        // ----------------------------------------------------------------
        // Helper: get current ticker and resolution from the chart.
        // ----------------------------------------------------------------
        function currentTicker(): string {
          return chart.symbol().toUpperCase().split(":")[0].split(".")[0];
        }

        function currentResolution(): string {
          return chart.resolution();
        }

        // ----------------------------------------------------------------
        // Chan Theory overlay
        // ----------------------------------------------------------------
        async function refreshChanOverlay(forceRedraw = false): Promise<void> {
          const enabled = hasStudy(CHAN_THEORY_STUDY_NAME);

          if (!enabled) {
            if (chanEnabled) {
              clearShapes(chart, chanShapeIds);
              chanEnabled = false;
            }
            return;
          }

          // Study just became enabled, or forced redraw.
          if (!chanEnabled || forceRedraw) {
            clearShapes(chart, chanShapeIds);
            chanEnabled = true;

            const res = currentResolution();

            if (!isChanSupportedResolution(res)) {
              console.info(
                `[Chan Theory] resolution ${res} not supported by backend, skipping.`,
              );
              return;
            }

            try {
              const data = await fetchChanAnalyze(currentTicker(), res);
              if (disposed) return;

              const newIds = await drawChanTheory(
                chart,
                data.raw_kline_list,
                data.bi_list,
                data.zs_list,
                data.bsp_list,
              );

              chanShapeIds.push(...newIds);

              console.info("[Chan Theory] drawn", {
                bi: data.bi_list.length,
                zs: data.zs_list.length,
                bsp: data.bsp_list.length,
                shapes: newIds.length,
              });
            } catch (err) {
              console.error("[Chan Theory] fetch/draw failed", err);
            }
          }
        }

        // ----------------------------------------------------------------
        // Pivot S/R overlay
        // ----------------------------------------------------------------
        async function refreshPivotOverlay(forceRedraw = false): Promise<void> {
          const enabled = hasStudy(PIVOT_SR_STUDY_NAME);

          if (!enabled) {
            if (pivotEnabled) {
              clearShapes(chart, pivotShapeIds);
              pivotEnabled = false;
            }
            return;
          }

          if (!pivotEnabled || forceRedraw) {
            clearShapes(chart, pivotShapeIds);
            pivotEnabled = true;

            const res = currentResolution();

            if (!isChanSupportedResolution(res)) {
              console.info(
                `[Pivot S/R] resolution ${res} not supported by backend, skipping.`,
              );
              return;
            }

            try {
              const data = await fetchPivotSr(currentTicker(), res);
              if (disposed) return;

              const newIds = await drawPivotSrZones(
                chart,
                data.resistance_zones,
                data.support_zones,
              );

              pivotShapeIds.push(...newIds);

              console.info("[Pivot S/R] drawn", {
                resistance: data.resistance_zones.length,
                support: data.support_zones.length,
                shapes: newIds.length,
              });
            } catch (err) {
              console.error("[Pivot S/R] fetch/draw failed", err);
            }
          }
        }

        // ----------------------------------------------------------------
        // On symbol or interval change: clear all overlay shapes and reset
        // state so the next poll re-evaluates from scratch.
        // ----------------------------------------------------------------
        function onChartContextChanged(): void {
          clearShapes(chart, chanShapeIds);
          chanEnabled = false;

          clearShapes(chart, pivotShapeIds);
          pivotEnabled = false;
        }

        chart.onSymbolChanged().subscribe(null, onChartContextChanged);
        chart.onIntervalChanged().subscribe(null, onChartContextChanged);

        // ----------------------------------------------------------------
        // Polling loop: detect study add/remove every STUDY_POLL_MS ms.
        // On the very first tick pass forceRedraw=true so newly added
        // studies render immediately.
        // ----------------------------------------------------------------
        let firstPoll = true;

        pollTimer = window.setInterval(() => {
          if (disposed) return;

          void refreshChanOverlay(firstPoll);
          void refreshPivotOverlay(firstPoll);

          firstPoll = false;
        }, STUDY_POLL_MS);
      });
    }

    void initializeChart().catch((error) => {
      console.error("[TradingView] Chart initialization failed:", error);
    });

    return () => {
      disposed = true;

      if (pollTimer !== null) {
        window.clearInterval(pollTimer);
      }

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
