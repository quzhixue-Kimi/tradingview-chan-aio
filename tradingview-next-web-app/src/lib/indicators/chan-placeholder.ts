/**
 * Placeholder PineJS indicators for Chan Theory overlays.
 *
 * These indicators are intentionally invisible (transparency: 100).
 * Their sole purpose is to act as toggles: when the user adds them from
 * the indicator list, TradingViewChart detects their presence via
 * getAllStudies() and triggers the corresponding shape drawing. When the
 * user removes them, the shapes are cleared.
 *
 * This pattern mirrors the one used in tradingview-next-app-v31.
 */

export const CHAN_THEORY_STUDY_NAME = "Chan Theory";
export const PIVOT_SR_STUDY_NAME = "Pivot S/R Zones";

type PineJSLike = {
  Std: {
    close: (context: unknown) => number;
  };
};

function buildPlaceholderIndicator(
  PineJS: PineJSLike,
  opts: {
    name: string;
    id: string;
    description: string;
  },
) {
  return {
    name: opts.name,

    metainfo: {
      _metainfoVersion: 53,

      id: opts.id,
      scriptIdPart: "",

      name: opts.name,
      description: opts.description,
      shortDescription: opts.name,

      is_hidden_study: false,
      is_price_study: true,
      isCustomIndicator: true,

      format: {
        type: "inherit",
      },

      plots: [
        {
          id: "plot_0",
          type: "line",
        },
      ],

      styles: {
        plot_0: {
          title: opts.name,
          histogramBase: 0,
        },
      },

      defaults: {
        styles: {
          plot_0: {
            linestyle: 0,
            linewidth: 1,
            plottype: 2,
            trackPrice: false,
            // Fully transparent: the plot carries no visual output.
            transparency: 100,
            visible: false,
            color: "#000000",
          },
        },
        precision: 2,
        inputs: {},
      },

      inputs: [],
    },

    constructor: function (this: { main: (context: unknown) => number[] }) {
      this.main = function (context: unknown): number[] {
        return [PineJS.Std.close(context)];
      };
    },
  };
}

export function createChanTheoryPlaceholder(PineJS: PineJSLike) {
  return buildPlaceholderIndicator(PineJS, {
    name: CHAN_THEORY_STUDY_NAME,
    id: "chan_theory@tv-basicstudies-1",
    description: CHAN_THEORY_STUDY_NAME,
  });
}

export function createPivotSrPlaceholder(PineJS: PineJSLike) {
  return buildPlaceholderIndicator(PineJS, {
    name: PIVOT_SR_STUDY_NAME,
    id: "pivot_sr_zones@tv-basicstudies-1",
    description: PIVOT_SR_STUDY_NAME,
  });
}
