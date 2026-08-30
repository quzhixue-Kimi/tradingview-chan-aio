/**
 * Placeholder PineJS indicators for TD9 BSP List overlay.
 */

export const TD9_BSP_STUDY_NAME = "TD9 Labels BSP List";

type PineJSLike = {
  Std: {
    close: (context: unknown) => number;
  };
};

export function createTd9BspPlaceholder(PineJS: PineJSLike) {
  return {
    name: TD9_BSP_STUDY_NAME,
    metainfo: {
      _metainfoVersion: 53,
      id: "td9_bsp@tv-basicstudies-1",
      description: TD9_BSP_STUDY_NAME,
      shortDescription: TD9_BSP_STUDY_NAME,
      isCustomIndicator: true,
      is_price_study: true,
      is_hidden_study: false,
      isTVScript: false,
      isTVScriptStub: false,
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
          title: TD9_BSP_STUDY_NAME,
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
    constructor: function (this: any) {
      this.main = function (context: any) {
        return [PineJS.Std.close(context)];
      };
    },
  };
}
