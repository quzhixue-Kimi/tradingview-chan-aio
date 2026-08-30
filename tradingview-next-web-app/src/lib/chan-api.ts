/**
 * Chan Theory backend API client.
 *
 * Only 15M / 30M / 1H resolutions have data on the offline backend.
 * Callers should always check `isChanSupportedResolution()` before calling
 * any fetch function.
 */

export type KLineItem = {
  idx: number;
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
};

export type BiItem = {
  idx: number;
  dir: string | null;
  is_sure: boolean;
  seg_idx: number | null;
  begin_klu_idx: number | null;
  end_klu_idx: number | null;
  begin_time: string | null;
  end_time: string | null;
  begin_price: number | null;
  end_price: number | null;
};

export type ZsItem = {
  idx: number;
  begin_bi_idx: number | null;
  end_bi_idx: number | null;
  bi_in_idx: number | null;
  bi_out_idx: number | null;
  begin_time: string | null;
  end_time: string | null;
  low: number | null;
  high: number | null;
  peak_low: number | null;
  peak_high: number | null;
  bi_idx_list: number[];
};

export type BspItem = {
  idx: number;
  bi_idx: number | null;
  klu_idx: number | null;
  time: string | null;
  price: number | null;
  is_buy: boolean;
  types: string[];
  is_sure: boolean | null;
};

export type CvdPoint = {
  time: string;
  value: number | null;
  raw_cvd: number | null;
};

export type PivotZone = {
  left_time: string;
  right_time: string;
  top: number;
  bottom: number;
  vol_text: string;
  cvd_points: CvdPoint[];
  cvd_label: string;
  is_broken: boolean;
};

export type ChanAnalyzeResult = {
  raw_kline_list: KLineItem[];
  bi_list: BiItem[];
  zs_list: ZsItem[];
  bsp_list: BspItem[];
};

export type PivotSrResult = {
  resistance_zones: PivotZone[];
  support_zones: PivotZone[];
};

/**
 * Resolutions supported by the offline chan backend.
 */
export const CHAN_SUPPORTED_RESOLUTIONS = ["15", "30", "60"] as const;

export type ChanSupportedResolution =
  (typeof CHAN_SUPPORTED_RESOLUTIONS)[number];

export function isChanSupportedResolution(
  resolution: string,
): resolution is ChanSupportedResolution {
  return CHAN_SUPPORTED_RESOLUTIONS.includes(
    resolution as ChanSupportedResolution,
  );
}

const RESOLUTION_TO_LEVEL: Record<ChanSupportedResolution, string> = {
  "15": "15M",
  "30": "30M",
  "60": "1H",
};

function toLevel(resolution: ChanSupportedResolution): string {
  return RESOLUTION_TO_LEVEL[resolution];
}

/**
 * Format symbol for the chan backend.
 * The backend expects "QQQ:US" style, matching the v31 convention.
 */
function toBackendCode(ticker: string): string {
  const clean = ticker.trim().toUpperCase().split(":")[0].split(".")[0];
  return `${clean}:US`;
}

function getChanApiUrl(): string {
  return process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
}

type ChanApiResponse<T> = {
  code: number;
  message: string;
  data: T;
};

async function postChan<T>(
  path: string,
  body: Record<string, string>,
): Promise<T> {
  const url = `${getChanApiUrl()}${path}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Chan API HTTP ${response.status} at ${path}`);
  }

  const payload = (await response.json()) as ChanApiResponse<T>;

  if (payload.code !== 0) {
    throw new Error(`Chan API error: ${payload.message}`);
  }

  return payload.data;
}

export async function fetchChanAnalyze(
  ticker: string,
  resolution: ChanSupportedResolution,
): Promise<ChanAnalyzeResult> {
  const code = toBackendCode(ticker);
  const level = toLevel(resolution);

  const data = await postChan<{
    raw_kline_list?: KLineItem[];
    bi_list?: BiItem[];
    zs_list?: ZsItem[];
    bsp_list?: BspItem[];
  }>("/api/chan/analyze", { code, level });

  return {
    raw_kline_list: data.raw_kline_list ?? [],
    bi_list: data.bi_list ?? [],
    zs_list: data.zs_list ?? [],
    bsp_list: data.bsp_list ?? [],
  };
}

export async function fetchPivotSr(
  ticker: string,
  resolution: ChanSupportedResolution,
): Promise<PivotSrResult> {
  const code = toBackendCode(ticker);
  const level = toLevel(resolution);

  const data = await postChan<{
    resistance_zones?: PivotZone[];
    support_zones?: PivotZone[];
  }>("/api/chan/pivot_sr", { code, level });

  return {
    resistance_zones: data.resistance_zones ?? [],
    support_zones: data.support_zones ?? [],
  };
}
