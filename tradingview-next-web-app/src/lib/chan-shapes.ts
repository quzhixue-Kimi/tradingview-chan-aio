/**
 * Shape drawing helpers for Chan Theory overlays.
 *
 * This module is responsible for translating backend data (bi_list, zs_list,
 * bsp_list, pivot zones) into TradingView chart shapes via the
 * createShape / createMultipointShape API.
 *
 * All logic is ported from tradingview-next-app-v31 / TradingViewChart.tsx.
 */

import type { BiItem, BspItem, CvdPoint, PivotZone, ZsItem } from "./chan-api";

// ---------------------------------------------------------------------------
// Chart API surface (minimal typing to avoid importing TV library types)
// ---------------------------------------------------------------------------

export type TvPoint = { time: number; price: number };

export type ChartApi = {
  createShape(
    point: TvPoint,
    options?: Record<string, unknown>,
  ): Promise<ShapeId> | ShapeId;
  createMultipointShape?(
    points: TvPoint[],
    options?: Record<string, unknown>,
  ): Promise<ShapeId> | ShapeId;
  createStudy?(
    name: string,
    forceOverlay?: boolean,
    lock?: boolean,
    inputs?: unknown[],
    callback?: (entityId: string) => void,
  ): string | Promise<string>;
  removeEntity?(id: ShapeId): void;
  removeShape?(id: ShapeId): void;
};

export type ShapeId = string | number;

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

/**
 * Parse backend time strings to Unix seconds (for TV shape API).
 *
 * Supported formats:
 *   YYYY-MM-DD
 *   YYYY-MM-DD HH:mm:ss
 *   YYYY-MM-DD HH:mm
 *   YYYY-MM-DD HHmm
 */
function parseTimeToUnixSec(timeStr: string): number | null {
  if (!timeStr) return null;

  try {
    const normalized = timeStr.trim().replace(/\//g, "-").replace(/\s+/g, " ");
    const [datePart, timePart] = normalized.split(" ");

    const [y, m, d] = datePart.split("-").map(Number);

    if (!y || !m || !d) return null;

    let hour = 0;
    let minute = 0;
    let second = 0;

    if (timePart) {
      if (timePart.includes(":")) {
        const parts = timePart.split(":");
        hour = Number(parts[0] ?? 0);
        minute = Number(parts[1] ?? 0);
        second = Number(parts[2] ?? 0);
      } else if (/^\d{4}$/.test(timePart)) {
        hour = Number(timePart.slice(0, 2));
        minute = Number(timePart.slice(2, 4));
      } else if (/^\d{6}$/.test(timePart)) {
        hour = Number(timePart.slice(0, 2));
        minute = Number(timePart.slice(2, 4));
        second = Number(timePart.slice(4, 6));
      }
    }

    // Backend times for US stocks are in US/Eastern, convert to UTC.
    // Approximate: ET is UTC-5 (EST) or UTC-4 (EDT).
    // For simplicity match v31's approach: add 4h or 5h offset based on DST.
    const isDst = isUsDst(y, m - 1, d);
    const utcOffsetHours = isDst ? 4 : 5;

    const ms = Date.UTC(y, m - 1, d, hour + utcOffsetHours, minute, second);

    if (!Number.isFinite(ms) || ms <= 0) return null;

    return Math.floor(ms / 1000);
  } catch {
    return null;
  }
}

function isUsDst(year: number, month: number, day: number): boolean {
  const marchFirst = new Date(Date.UTC(year, 2, 1));
  const marchFirstDay = marchFirst.getUTCDay();
  const secondSundayMarch =
    marchFirstDay === 0 ? 8 : 8 + (7 - marchFirstDay);

  const novemberFirst = new Date(Date.UTC(year, 10, 1));
  const novemberFirstDay = novemberFirst.getUTCDay();
  const firstSundayNovember =
    novemberFirstDay === 0 ? 1 : 8 - novemberFirstDay;

  const dstStart = Date.UTC(year, 2, secondSundayMarch, 7, 0, 0);
  const dstEnd = Date.UTC(year, 10, firstSundayNovember, 6, 0, 0);
  const probe = Date.UTC(year, month, day, 17, 0, 0);

  return probe >= dstStart && probe < dstEnd;
}

/**
 * Build a klu_idx → unix-seconds map from raw_kline_list.
 */
export function buildIdxToTimeMap(
  rawKlines: Array<{ idx: number; time: string }>,
): Map<number, number> {
  const map = new Map<number, number>();

  for (const item of rawKlines) {
    const sec = parseTimeToUnixSec(item.time);
    if (sec !== null) {
      map.set(item.idx, sec);
    }
  }

  return map;
}

function getTimeByKluIdx(
  idxToTime: Map<number, number>,
  kluIdx: number | null | undefined,
  fallbackTime?: string | null,
): number | null {
  if (kluIdx != null && idxToTime.has(kluIdx)) {
    return idxToTime.get(kluIdx)!;
  }

  return fallbackTime ? parseTimeToUnixSec(fallbackTime) : null;
}

// ---------------------------------------------------------------------------
// Geometry helpers (ported from v31)
// ---------------------------------------------------------------------------

function splitPolylineSegments(points: TvPoint[]): TvPoint[][] {
  if (points.length < 2) return [];

  const timeDiffs: number[] = [];
  const priceDiffs: number[] = [];

  for (let i = 1; i < points.length; i++) {
    timeDiffs.push(points[i].time - points[i - 1].time);
    priceDiffs.push(Math.abs(points[i].price - points[i - 1].price));
  }

  const sortedTimeDiffs = [...timeDiffs].sort((a, b) => a - b);
  const sortedPriceDiffs = [...priceDiffs].sort((a, b) => a - b);

  const medianTime =
    sortedTimeDiffs[Math.floor(sortedTimeDiffs.length / 2)] ?? 24 * 3600;
  const medianPrice =
    sortedPriceDiffs[Math.floor(sortedPriceDiffs.length / 2)] ?? 0;

  const maxTimeGap = Math.max(medianTime * 3, 3 * 24 * 3600);
  const maxPriceJump = Math.max(medianPrice * 6, 8);

  const segments: TvPoint[][] = [];
  let current: TvPoint[] = [points[0]];

  for (let i = 1; i < points.length; i++) {
    const dt = points[i].time - points[i - 1].time;
    const dp = Math.abs(points[i].price - points[i - 1].price);

    if (dt > maxTimeGap || dp > maxPriceJump) {
      if (current.length >= 2) segments.push(current);
      current = [points[i]];
    } else {
      current.push(points[i]);
    }
  }

  if (current.length >= 2) segments.push(current);

  return segments.filter((s) => s.length >= 2);
}

// ---------------------------------------------------------------------------
// Shape helpers
// ---------------------------------------------------------------------------

async function resolveShapeId(
  result: Promise<ShapeId> | ShapeId,
): Promise<ShapeId | null> {
  try {
    const id = await result;
    return id ?? null;
  } catch {
    return null;
  }
}

function saveId(ids: ShapeId[], id: ShapeId | null): void {
  if (id !== null && id !== undefined) {
    ids.push(id);
  }
}

export function clearShapes(chart: ChartApi, ids: ShapeId[]): void {
  for (const id of ids) {
    try {
      if (typeof chart.removeEntity === "function") {
        chart.removeEntity(id);
      } else if (typeof chart.removeShape === "function") {
        chart.removeShape(id);
      }
    } catch {
      // shape may already be gone
    }
  }

  ids.length = 0;
}

// ---------------------------------------------------------------------------
// Chan Theory shapes: bi + zs + bsp
// ---------------------------------------------------------------------------

function getBiColor(dir: string | null | undefined): string {
  if (!dir) return "#ef5350";
  return dir.toUpperCase().includes("UP") ? "#26a69a" : "#ef5350";
}

/**
 * Draw bi_list (笔), zs_list (中枢), bsp_list (买卖点) onto the chart.
 * Returns the list of created shape IDs (for later cleanup).
 */
export async function drawChanTheory(
  chart: ChartApi,
  rawKlines: Array<{ idx: number; time: string }>,
  biList: BiItem[],
  zsList: ZsItem[],
  bspList: BspItem[],
): Promise<ShapeId[]> {
  const ids: ShapeId[] = [];
  const idxToTime = buildIdxToTimeMap(rawKlines);
  const hasMultiPoint = typeof chart.createMultipointShape === "function";

  // --- 笔 (bi) ---
  for (const bi of biList) {
    const beginTs = getTimeByKluIdx(idxToTime, bi.begin_klu_idx, bi.begin_time);
    const endTs = getTimeByKluIdx(idxToTime, bi.end_klu_idx, bi.end_time);

    if (
      beginTs == null ||
      endTs == null ||
      bi.begin_price == null ||
      bi.end_price == null
    ) {
      continue;
    }

    if (!hasMultiPoint) continue;

    const id = await resolveShapeId(
      chart.createMultipointShape!(
        [
          { time: beginTs, price: bi.begin_price },
          { time: endTs, price: bi.end_price },
        ],
        {
          shape: "trend_line",
          lock: true,
          disableSelection: true,
          disableSave: true,
          disableUndo: true,
          overrides: {
            linecolor: getBiColor(bi.dir),
            linewidth: 2,
          },
        },
      ),
    );

    saveId(ids, id);
  }

  // --- 中枢 (zs) ---
  for (const zs of zsList) {
    const beginTs = parseTimeToUnixSec(zs.begin_time ?? "");
    const endTs = parseTimeToUnixSec(zs.end_time ?? "");

    if (
      beginTs == null ||
      endTs == null ||
      zs.low == null ||
      zs.high == null
    ) {
      continue;
    }

    if (!hasMultiPoint) continue;

    const id = await resolveShapeId(
      chart.createMultipointShape!(
        [
          { time: beginTs, price: zs.high },
          { time: endTs, price: zs.low },
        ],
        {
          shape: "rectangle",
          lock: true,
          disableSelection: true,
          disableSave: true,
          disableUndo: true,
          overrides: {
            linecolor: "#3b82f6",
            fillBackground: true,
            backgroundColor: "rgba(59, 130, 246, 0.10)",
            transparency: 85,
            linewidth: 1,
          },
        },
      ),
    );

    saveId(ids, id);
  }

  // --- 买卖点 (bsp) ---
  for (const bsp of bspList) {
    const ts = getTimeByKluIdx(idxToTime, bsp.klu_idx, bsp.time);

    if (ts == null || bsp.price == null) continue;

    const id = await resolveShapeId(
      chart.createShape(
        { time: ts, price: bsp.price },
        {
          shape: bsp.is_buy ? "arrow_up" : "arrow_down",
          text: Array.isArray(bsp.types) ? bsp.types.join("/") : "",
          lock: true,
          disableSelection: true,
          disableSave: true,
          disableUndo: true,
          overrides: {
            color: bsp.is_buy ? "#22c55e" : "#ef4444",
            textColor: bsp.is_buy ? "#22c55e" : "#ef4444",
            fontsize: 12,
          },
        },
      ),
    );

    saveId(ids, id);
  }

  return ids;
}

// ---------------------------------------------------------------------------
// Pivot S/R Zone shapes
// ---------------------------------------------------------------------------

const PIVOT_RES_COLOR = "#2196f3";
const PIVOT_SUP_COLOR = "#ffc13b";

async function drawPivotZoneSet(
  chart: ChartApi,
  zones: PivotZone[],
  boxColor: string,
): Promise<ShapeId[]> {
  const ids: ShapeId[] = [];
  const hasMultiPoint = typeof chart.createMultipointShape === "function";

  for (const zone of zones) {
    const leftTs = parseTimeToUnixSec(zone.left_time);
    const rightTs = parseTimeToUnixSec(zone.right_time);

    if (leftTs == null || rightTs == null) continue;
    if (zone.top == null || zone.bottom == null) continue;

    const backgroundColor =
      boxColor === PIVOT_RES_COLOR
        ? "rgba(33,150,243,0.12)"
        : "rgba(255,193,59,0.12)";

    // Zone rectangle
    if (hasMultiPoint) {
      const id = await resolveShapeId(
        chart.createMultipointShape!(
          [
            { time: leftTs, price: zone.top },
            { time: rightTs, price: zone.bottom },
          ],
          {
            shape: "rectangle",
            lock: true,
            disableSelection: true,
            disableSave: true,
            disableUndo: true,
            overrides: {
              linecolor: boxColor,
              fillBackground: true,
              backgroundColor,
              transparency: 80,
              linewidth: 1,
              linestyle: zone.is_broken ? 2 : 0,
            },
          },
        ),
      );
      saveId(ids, id);
    }

    // CVD dotted polyline
    const cvdPoints: TvPoint[] = ((zone.cvd_points as CvdPoint[]) ?? [])
      .map((pt) => {
        const ts = parseTimeToUnixSec(pt.time);
        if (ts == null || pt.value == null || !Number.isFinite(pt.value)) {
          return null;
        }
        return { time: ts, price: pt.value };
      })
      .filter((pt): pt is TvPoint => pt !== null);

    if (cvdPoints.length >= 2 && hasMultiPoint) {
      for (const seg of splitPolylineSegments(cvdPoints)) {
        for (let i = 1; i < seg.length; i++) {
          const id = await resolveShapeId(
            chart.createMultipointShape!([seg[i - 1]!, seg[i]!], {
              shape: "trend_line",
              lock: true,
              disableSelection: true,
              disableSave: true,
              disableUndo: true,
              overrides: {
                linecolor: "#ffffff",
                linewidth: 1,
                linestyle: 2,
              },
            }),
          );
          saveId(ids, id);
        }
      }
    }

    // Vol label
    if (zone.vol_text) {
      const id = await resolveShapeId(
        chart.createShape(
          { time: leftTs, price: zone.top },
          {
            shape: "text",
            text: zone.vol_text,
            lock: true,
            disableSelection: true,
            disableSave: true,
            disableUndo: true,
            overrides: {
              color: boxColor,
              textColor: boxColor,
              fontsize: 11,
              bold: false,
              vertAlign: "top",
            },
          },
        ),
      );
      saveId(ids, id);
    }

    // CVD label
    if (zone.cvd_label) {
      const id = await resolveShapeId(
        chart.createShape(
          { time: rightTs, price: zone.top },
          {
            shape: "text",
            text: zone.cvd_label,
            lock: true,
            disableSelection: true,
            disableSave: true,
            disableUndo: true,
            overrides: {
              color: boxColor,
              textColor: boxColor,
              fontsize: 11,
              bold: false,
              vertAlign: "top",
            },
          },
        ),
      );
      saveId(ids, id);
    }
  }

  return ids;
}

/**
 * Draw resistance + support zones onto the chart.
 * Returns the list of created shape IDs (for later cleanup).
 */
export async function drawPivotSrZones(
  chart: ChartApi,
  resistanceZones: PivotZone[],
  supportZones: PivotZone[],
): Promise<ShapeId[]> {
  const [resIds, supIds] = await Promise.all([
    drawPivotZoneSet(chart, resistanceZones, PIVOT_RES_COLOR),
    drawPivotZoneSet(chart, supportZones, PIVOT_SUP_COLOR),
  ]);

  return [...resIds, ...supIds];
}
