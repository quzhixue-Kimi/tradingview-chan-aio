/**
 * PineJS Indicator definition for MAR (Moving Average Rainbow / Multi-period MA)
 *
 * Moving averages:
 * - MA55, MA60, MA65, MA120, MA250 across all timeframes
 * - MA5, MA20 are only visible on Daily (1D) resolution
 */

export const MAR_STUDY_NAME = "MAR";

export function createMarIndicator(PineJS: any) {
  const maDefinitions = [
    { id: "ma5", title: "MA5", length: 5, color: "rgb(255, 152, 0)", linewidth: 2 },
    { id: "ma20", title: "MA20", length: 20, color: "rgb(158, 158, 158)", linewidth: 2 },
    { id: "ma55", title: "MA55", length: 55, color: "rgb(239, 49, 49)", linewidth: 1 },
    { id: "ma60", title: "MA60", length: 60, color: "rgb(255, 255, 255)", linewidth: 1 },
    { id: "ma65", title: "MA65", length: 65, color: "rgb(102, 187, 106)", linewidth: 1 },
    { id: "ma120", title: "MA120", length: 120, color: "rgb(180, 44, 194)", linewidth: 3 },
    { id: "ma250", title: "MA250", length: 250, color: "rgb(187, 17, 1)", linewidth: 4 },
  ];

  const styles = Object.fromEntries(
    maDefinitions.map((ma) => [
      ma.id,
      {
        title: ma.title,
        histogramBase: 0,
        joinPoints: false,
      },
    ]),
  );

  const defaultStyles = Object.fromEntries(
    maDefinitions.map((ma) => [
      ma.id,
      {
        linestyle: 0,
        linewidth: ma.linewidth,
        plottype: 0,
        trackPrice: false,
        transparency: 0,
        visible: true,
        color: ma.color,
      },
    ]),
  );

  return {
    name: MAR_STUDY_NAME,
    metainfo: {
      _metainfoVersion: 53,
      id: "mar@tv-basicstudies-1",
      description: MAR_STUDY_NAME,
      shortDescription: MAR_STUDY_NAME,
      isCustomIndicator: true,
      is_price_study: true,
      is_hidden_study: false,
      isTVScript: false,
      isTVScriptStub: false,
      format: {
        type: "inherit",
      },
      plots: maDefinitions.map((ma) => ({
        id: ma.id,
        type: "line",
      })),
      styles,
      defaults: {
        styles: defaultStyles,
        precision: 2,
        inputs: {},
      },
      inputs: [],
    },
    constructor: function (this: any) {
      this.main = function (context: any) {
        this._context = context;
        context.setMinimumAdditionalDepth?.(250);

        const close = PineJS.Std.close(context);
        const closeSeries = context.new_var(close);
        const period = String(PineJS.Std.period(context) || "").toUpperCase();
        const isDaily =
          period === "D" || period === "1D" || PineJS.Std.isdwm?.(context);

        return maDefinitions.map((ma) => {
          if ((ma.length === 5 || ma.length === 20) && !isDaily) {
            return NaN;
          }
          return PineJS.Std.sma(closeSeries, ma.length, context);
        });
      };
    },
  };
}
