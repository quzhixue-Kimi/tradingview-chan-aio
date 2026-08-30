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

const STUDY_NAME = "Realtime Ladder + MA";
const STUDY_ID = "Realtime Ladder + MA@tv-basicstudies-1";

const BLUE = "#2962FF";
const YELLOW = "#F5C400";
const RED = "#FF3B4E";
const WHITE = "#FFFFFF";
const GREEN = "#40C057";
const PURPLE = "#A23CCB";

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

          ma55: {
            linestyle: 0,
            linewidth: 2,
            plottype: 0,
            trackPrice: false,
            transparency: 0,
            visible: true,
            color: RED,
          },

          ma60: {
            linestyle: 0,
            linewidth: 2,
            plottype: 0,
            trackPrice: false,
            transparency: 0,
            visible: true,
            color: WHITE,
          },

          ma65: {
            linestyle: 0,
            linewidth: 2,
            plottype: 0,
            trackPrice: false,
            transparency: 0,
            visible: true,
            color: GREEN,
          },

          ma120: {
            linestyle: 0,
            linewidth: 4,
            plottype: 0,
            trackPrice: false,
            transparency: 0,
            visible: true,
            color: PURPLE,
          },

          ma250: {
            linestyle: 0,
            linewidth: 6,
            plottype: 0,
            trackPrice: false,
            transparency: 0,
            visible: true,
            color: RED,
          },
        },

        /**
         * filledAreasStyle 的 key 必须和 filledAreas 中的 id 相同。
         *
         * transparency:
         * 0   = 完全不透明
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

          ma55Length: 55,
          ma60Length: 60,
          ma65Length: 65,
          ma120Length: 120,
          ma250Length: 250,
        },
      },

      plots: [
        {
          id: "blueUpper",
          type: "line",
        },
        {
          id: "blueLower",
          type: "line",
        },
        {
          id: "yellowUpper",
          type: "line",
        },
        {
          id: "yellowLower",
          type: "line",
        },
        {
          id: "ma55",
          type: "line",
        },
        {
          id: "ma60",
          type: "line",
        },
        {
          id: "ma65",
          type: "line",
        },
        {
          id: "ma120",
          type: "line",
        },
        {
          id: "ma250",
          type: "line",
        },
      ],

      /**
       * 这两个定义就是新增的核心。
       *
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
        blueUpper: {
          title: "Blue EMA High 24",
        },
        blueLower: {
          title: "Blue EMA Low 23",
        },
        yellowUpper: {
          title: "Yellow EMA High 89",
        },
        yellowLower: {
          title: "Yellow EMA Low 90",
        },
        ma55: {
          title: "MA55",
        },
        ma60: {
          title: "MA60",
        },
        ma65: {
          title: "MA65",
        },
        ma120: {
          title: "MA120",
        },
        ma250: {
          title: "MA250",
        },
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
        {
          id: "ma55Length",
          name: "MA55 Length",
          type: "integer",
          defval: 55,
          min: 1,
        },
        {
          id: "ma60Length",
          name: "MA60 Length",
          type: "integer",
          defval: 60,
          min: 1,
        },
        {
          id: "ma65Length",
          name: "MA65 Length",
          type: "integer",
          defval: 65,
          min: 1,
        },
        {
          id: "ma120Length",
          name: "MA120 Length",
          type: "integer",
          defval: 120,
          min: 1,
        },
        {
          id: "ma250Length",
          name: "MA250 Length",
          type: "integer",
          defval: 250,
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

        const closeSeries = context.new_var(PineJS.Std.close(context));

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

        const ma55 = PineJS.Std.sma(closeSeries, inputCallback(4), context);

        const ma60 = PineJS.Std.sma(closeSeries, inputCallback(5), context);

        const ma65 = PineJS.Std.sma(closeSeries, inputCallback(6), context);

        const ma120 = PineJS.Std.sma(closeSeries, inputCallback(7), context);

        const ma250 = PineJS.Std.sma(closeSeries, inputCallback(8), context);

        return [
          blueUpper,
          blueLower,
          yellowUpper,
          yellowLower,
          ma55,
          ma60,
          ma65,
          ma120,
          ma250,
        ];
      };
    },
  };
}
