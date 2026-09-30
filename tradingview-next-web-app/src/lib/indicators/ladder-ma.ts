type PineSeries = unknown;

type PineContext = {
  new_var: (value: number) => PineSeries;
};

type PineJSLike = {
  Std: {
    high: (context: PineContext) => number;
    low: (context: PineContext) => number;
    close: (context: PineContext) => number;

    ema: (source: PineSeries, length: number, context: PineContext) => number;

    sma: (source: PineSeries, length: number, context: PineContext) => number;
  };
};

type InputCallback = (index: number) => number;

type StudyInstance = {
  init?: (context: PineContext, inputCallback: InputCallback) => void;

  main: (context: PineContext, inputCallback: InputCallback) => number[];
};

// 名称和 ID 保持不变，TradingViewChart.tsx 里的 createStudy("Realtime Ladder + MA") 无需修改。
const STUDY_NAME = "Realtime Ladder + MA";
const STUDY_ID = "Realtime Ladder + MA@tv-basicstudies-1";

const BLUE = "#2962FF";
const YELLOW = "#F5C400";

const BLUE_FILL = "rgba(41, 98, 255, 0.24)";
const YELLOW_FILL = "rgba(245, 196, 0, 0.20)";

export function createLadderMaIndicator(PineJS: PineJSLike) {
  return {
    name: STUDY_NAME,

    metainfo: {
      _metainfoVersion: 53,

      id: STUDY_ID,
      scriptIdPart: "",

      name: STUDY_NAME,
      description: STUDY_NAME,
      shortDescription: "Ladder + MA",

      is_hidden_study: false,
      is_price_study: true,
      isCustomIndicator: true,

      format: {
        type: "price",
        precision: 2,
      },

      defaults: {
        styles: {
          blueUpper: {
            linestyle: 0,
            linewidth: 2,
            plottype: 0,
            trackPrice: false,
            transparency: 0,
            visible: true,
            color: BLUE,
          },

          blueLower: {
            linestyle: 0,
            linewidth: 2,
            plottype: 0,
            trackPrice: false,
            transparency: 0,
            visible: true,
            color: BLUE,
          },

          yellowUpper: {
            linestyle: 0,
            linewidth: 2,
            plottype: 0,
            trackPrice: false,
            transparency: 0,
            visible: true,
            color: YELLOW,
          },

          yellowLower: {
            linestyle: 0,
            linewidth: 2,
            plottype: 0,
            trackPrice: false,
            transparency: 0,
            visible: true,
            color: YELLOW,
          },
        },

        /**
         * filledAreasStyle 的 key 必须和 filledAreas 中的 id 相同。
         *
         * transparency:
         * 0 = 完全不透明
         * 100 = 完全透明
         */
        filledAreasStyle: {
          blueChannelFill: {
            color: BLUE_FILL,
            transparency: 72,
            visible: true,
          },

          yellowChannelFill: {
            color: YELLOW_FILL,
            transparency: 76,
            visible: true,
          },
        },

        inputs: {
          blueHighLength: 24,
          blueLowLength: 23,

          yellowHighLength: 89,
          yellowLowLength: 90,
        },
      },

      plots: [
        { id: "blueUpper", type: "line" },
        { id: "blueLower", type: "line" },
        { id: "yellowUpper", type: "line" },
        { id: "yellowLower", type: "line" },
      ],

      /**
       * type: "plot_plot"
       * 表示把两个 plot 之间的面积填充。
       */
      filledAreas: [
        {
          id: "blueChannelFill",
          objAId: "blueUpper",
          objBId: "blueLower",
          type: "plot_plot",
          title: "Blue EMA Channel Fill",
        },
        {
          id: "yellowChannelFill",
          objAId: "yellowUpper",
          objBId: "yellowLower",
          type: "plot_plot",
          title: "Yellow EMA Channel Fill",
        },
      ],

      styles: {
        blueUpper: { title: "Blue EMA High 24" },
        blueLower: { title: "Blue EMA Low 23" },
        yellowUpper: { title: "Yellow EMA High 89" },
        yellowLower: { title: "Yellow EMA Low 90" },
      },

      inputs: [
        {
          id: "blueHighLength",
          name: "Blue EMA High Length",
          type: "integer",
          defval: 24,
          min: 1,
        },
        {
          id: "blueLowLength",
          name: "Blue EMA Low Length",
          type: "integer",
          defval: 23,
          min: 1,
        },
        {
          id: "yellowHighLength",
          name: "Yellow EMA High Length",
          type: "integer",
          defval: 89,
          min: 1,
        },
        {
          id: "yellowLowLength",
          name: "Yellow EMA Low Length",
          type: "integer",
          defval: 90,
          min: 1,
        },
      ],
    },

    constructor: function (this: StudyInstance): void {
      this.init = function (
        _context: PineContext,
        _inputCallback: InputCallback,
      ): void {
        // 没有额外状态。
      };

      this.main = function (
        context: PineContext,
        inputCallback: InputCallback,
      ): number[] {
        const highSeries = context.new_var(PineJS.Std.high(context));

        const lowSeries = context.new_var(PineJS.Std.low(context));

        const blueUpper = PineJS.Std.ema(highSeries, inputCallback(0), context);

        const blueLower = PineJS.Std.ema(lowSeries, inputCallback(1), context);

        const yellowUpper = PineJS.Std.ema(
          highSeries,
          inputCallback(2),
          context,
        );

        const yellowLower = PineJS.Std.ema(
          lowSeries,
          inputCallback(3),
          context,
        );

        return [blueUpper, blueLower, yellowUpper, yellowLower];
      };
    },
  };
}
