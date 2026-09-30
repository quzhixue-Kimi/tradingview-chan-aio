import { DateTime } from "luxon";

import {
  filterUsRthBars,
  isUsRthBar,
  NY_TZ,
  RTH_SESSION,
  type OhlcvBar,
} from "./market-session";
import { fetchTvHistory, subscribeTvBars, unsubscribeTvBars } from "./tv-ws-feed";

// [3m] 新增 "3"：3 分钟走 tv-ws-server（TradingView-API），其余周期仍走 Twelve Data。
export const SUPPORTED_RESOLUTIONS = ["1", "3", "5", "15", "30", "60"] as const;

export type SupportedResolution = (typeof SUPPORTED_RESOLUTIONS)[number];

// [3m] 由 tv-ws-server 提供数据的周期
export const TV_FEED_RESOLUTIONS = ["3"] as const;

export type TvFeedResolution = (typeof TV_FEED_RESOLUTIONS)[number];

// [3m] 由 Twelve Data 提供数据的周期
export type TwelveResolution = Exclude<SupportedResolution, TvFeedResolution>;

export const TWELVE_INTERVAL_BY_RESOLUTION: Record<
  TwelveResolution,
  "1min" | "5min" | "15min" | "30min" | "1h"
> = {
  "1": "1min",
  "5": "5min",
  "15": "15min",
  "30": "30min",
  "60": "1h",
};

export const RESOLUTION_LABELS: Record<SupportedResolution, string> = {
  "1": "1m",
  "3": "3m",
  "5": "5m",
  "15": "15m",
  "30": "30m",
  "60": "1H",
};

export function isSupportedResolution(
  resolution: string,
): resolution is SupportedResolution {
  return SUPPORTED_RESOLUTIONS.includes(resolution as SupportedResolution);
}

// [3m]
export function isTvFeedResolution(
  resolution: SupportedResolution,
): resolution is TvFeedResolution {
  return TV_FEED_RESOLUTIONS.includes(resolution as TvFeedResolution);
}

type TwelveDataRow = {
  datetime: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume?: string;
};

type TwelveDataResponse = {
  status?: "ok" | "error";
  code?: number;
  message?: string;
  values?: TwelveDataRow[];
  meta?: {
    symbol?: string;
    exchange?: string;
    exchange_timezone?: string;
    type?: string;
  };
};

type TwelveWebSocketMessage = {
  event?: string;
  status?: string;
  success?: string[];
  fails?: Record<string, string>;

  symbol?: string;
  timestamp?: number | string;
  price?: number | string;
  day_volume?: number | string;

  code?: number;
  message?: string;
};

type TradingViewBar = OhlcvBar;

type DatafeedConfiguration = {
  supported_resolutions: readonly string[];
  supports_group_request: boolean;
  supports_marks: boolean;
  supports_search: boolean;
  supports_timescale_marks: boolean;
  supports_time: boolean;
};

type SymbolInfo = {
  ticker: string;
  name: string;
  full_name: string;
  description: string;
  type: string;

  session: string;
  timezone: string;

  exchange: string;
  listed_exchange: string;

  minmov: number;
  pricescale: number;
  volume_precision: number;

  has_intraday: boolean;
  intraday_multipliers: readonly string[];

  has_daily: boolean;
  supported_resolutions: readonly string[];

  data_status: "streaming";
};

type PeriodParams = {
  from: number;
  to: number;
  countBack: number;
  firstDataRequest: boolean;
};

type HistoryMetadata = {
  noData: boolean;
};

type HistoryCallback = (bars: TradingViewBar[], meta: HistoryMetadata) => void;

type ErrorCallback = (reason: string) => void;

type RealtimeCallback = (bar: TradingViewBar) => void;

type ResetCacheCallback = () => void;

type SearchSymbolResult = {
  symbol: string;
  full_name: string;
  description: string;
  exchange: string;
  ticker: string;
  type: string;
};

type RealtimeSubscription = {
  id: string;
  symbol: string;
  resolution: TwelveResolution;
  callback: RealtimeCallback;
  onResetCacheNeededCallback?: ResetCacheCallback;
  lastBar: TradingViewBar | null;
  isDirty: boolean;
};

const TWELVE_TIME_SERIES_URL = "https://api.twelvedata.com/time_series";

const TWELVE_WS_BASE_URL = "wss://ws.twelvedata.com/v1/quotes/price";

const DEFAULT_SYMBOL = "QQQ";
const DEFAULT_EXCHANGE = "NASDAQ";

/**
 * Twelve Data 的 outputsize 最大值为 5000。
 *
 * RTH filter 会丢弃盘前/盘后。
 * 当前 1000 个原始 bar 对 5m/15m/30m/1h 通常足够；
 * 未来若 1m 的 MA250 历史不够，可增至 2000 或 3000。
 */
const DEFAULT_HISTORY_BARS = 1000;
const MAX_HISTORY_BARS = 5000;

/**
 * 收到 tick 后不在每一个 tick 都强制 Charting Library redraw。
 * 这里最多每 250ms 推一次最后 bar，降低开盘期 CPU 压力。
 */
const REALTIME_FLUSH_INTERVAL_MS = 250;

/**
 * Twelve Data 官方建议的 heartbeat 间隔可为 10 秒。
 * 仅在 WebSocket 已连接时发送。
 */
const WS_HEARTBEAT_INTERVAL_MS = 10_000;

/**
 * 断开后指数退避重连，最大 30 秒。
 */
const WS_RECONNECT_INITIAL_DELAY_MS = 1_000;
const WS_RECONNECT_MAX_DELAY_MS = 30_000;

const barCache = new Map<string, TradingViewBar[]>();

/**
 * streamKey:
 *   QQQ:5
 *   TSLA:1
 *
 * 同一个 symbol + resolution 可共享一条 Twelve Data symbol subscription，
 * 但为每个 Charting Library subscriber 保存独立 lastBar 和 callback。
 *
 * [3m] 仅 Twelve Data 周期使用；3 分钟由 tv-ws-feed.ts 自行管理订阅。
 */
const streamSubscriptions = new Map<string, RealtimeSubscription[]>();

const subscriberToStreamKey = new Map<string, string>();

let ws: WebSocket | null = null;
let wsReconnectTimer: number | null = null;
let wsHeartbeatTimer: number | null = null;
let wsReconnectDelayMs = WS_RECONNECT_INITIAL_DELAY_MS;
let hasConnectedBefore = false;

function getApiKey(): string {
  const apiKey = process.env.NEXT_PUBLIC_TWELVE_DATA_API_KEY;

  if (!apiKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_TWELVE_DATA_API_KEY. " +
        "Create .env.local and restart the Next.js dev server.",
    );
  }

  return apiKey;
}

function normalizeSymbol(symbol: string): string {
  const normalized = symbol.trim().toUpperCase();

  if (!normalized) {
    return DEFAULT_SYMBOL;
  }

  if (normalized.includes(":")) {
    return normalized.split(":").at(-1) ?? normalized;
  }

  return normalized;
}

function getCacheKey(symbol: string, resolution: SupportedResolution): string {
  return `${symbol}:${resolution}`;
}

function getStreamKey(symbol: string, resolution: SupportedResolution): string {
  return `${symbol}:${resolution}`;
}

/**
 * 此函数假定 Twelve Data 请求带 timezone=UTC 后，
 * 返回的 datetime 字符串确实是 UTC。
 *
 * 你之前已经使用 curl 验证过该行为；
 * 若以后切换供应商或 timezone 参数策略，需要同步调整。
 */
function parseTwelveDatetime(datetime: string): number {
  const parsed = DateTime.fromFormat(datetime, "yyyy-MM-dd HH:mm:ss", {
    zone: "utc",
  });

  if (!parsed.isValid) {
    throw new Error(`Invalid Twelve Data datetime: ${datetime}`);
  }

  return parsed.toMillis();
}

function toNumber(value: string | number | undefined, fallback = 0): number {
  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : fallback;
}

function toTradingViewBar(row: TwelveDataRow): TradingViewBar {
  return {
    time: parseTwelveDatetime(row.datetime),
    open: toNumber(row.open),
    high: toNumber(row.high),
    low: toNumber(row.low),
    close: toNumber(row.close),
    volume: toNumber(row.volume),
  };
}

function getRequestedOutputSize(countBack: number): number {
  return Math.min(
    Math.max(countBack || 0, DEFAULT_HISTORY_BARS),
    MAX_HISTORY_BARS,
  );
}

async function fetchTwelveBars(
  symbol: string,
  resolution: TwelveResolution,
  countBack: number,
): Promise<TradingViewBar[]> {
  const apiKey = getApiKey();
  const interval = TWELVE_INTERVAL_BY_RESOLUTION[resolution];
  const outputsize = getRequestedOutputSize(countBack);

  const url = new URL(TWELVE_TIME_SERIES_URL);

  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", interval);
  url.searchParams.set("outputsize", String(outputsize));
  url.searchParams.set("timezone", "UTC");
  url.searchParams.set("apikey", apiKey);

  const response = await fetch(url.toString());

  const creditsLeft = response.headers.get("api-credits-left");
  const creditsRequest = response.headers.get("api-credits-request");

  if (creditsLeft || creditsRequest) {
    console.info("[Twelve Data REST credits]", {
      symbol,
      interval,
      outputsize,
      creditsLeft,
      creditsRequest,
    });
  }

  const payload = (await response.json()) as TwelveDataResponse;

  if (!response.ok || payload.status === "error") {
    throw new Error(
      payload.message ??
        `Twelve Data request failed with HTTP ${response.status}`,
    );
  }

  const allBars = (payload.values ?? [])
    .map(toTradingViewBar)
    .filter((bar) => Number.isFinite(bar.time))
    .sort((left, right) => left.time - right.time);

  return filterUsRthBars(allBars);
}

function makeSymbolInfo(symbolName: string): SymbolInfo {
  const ticker = normalizeSymbol(symbolName);

  return {
    ticker,
    name: ticker,
    full_name: `${DEFAULT_EXCHANGE}:${ticker}`,
    description: ticker,
    type: "stock",

    timezone: NY_TZ,
    session: RTH_SESSION,

    exchange: DEFAULT_EXCHANGE,
    listed_exchange: DEFAULT_EXCHANGE,

    minmov: 1,
    pricescale: 100,
    volume_precision: 0,

    has_intraday: true,
    intraday_multipliers: SUPPORTED_RESOLUTIONS,

    has_daily: false,
    supported_resolutions: SUPPORTED_RESOLUTIONS,

    data_status: "streaming",
  };
}

function getResolutionDurationMs(resolution: SupportedResolution): number {
  return Number(resolution) * 60 * 1_000;
}

/**
 * 对美国 RTH bar 使用“自 09:30 ET 开始”的周期边界：
 *
 * 5m:
 * 09:30, 09:35, 09:40 ...
 *
 * 1h:
 * 09:30, 10:30, 11:30 ...
 *
 * 不使用 Unix epoch 简单取模，否则 1h 会落在 09:00/10:00，
 * 与美股 RTH 图表的 09:30 session 边界不一致。
 */
function getRthBarStartMs(
  tickTimeMs: number,
  resolution: SupportedResolution,
): number {
  const ny = DateTime.fromMillis(tickTimeMs, {
    zone: "utc",
  }).setZone(NY_TZ);

  const nySessionOpen = ny.startOf("day").plus({
    hours: 9,
    minutes: 30,
  });

  const durationMs = getResolutionDurationMs(resolution);
  const elapsedMs = Math.max(0, tickTimeMs - nySessionOpen.toUTC().toMillis());

  const bucketOffsetMs = Math.floor(elapsedMs / durationMs) * durationMs;

  return nySessionOpen
    .plus({ milliseconds: bucketOffsetMs })
    .toUTC()
    .toMillis();
}

function isSameBarBucket(
  bar: TradingViewBar,
  tickTimeMs: number,
  resolution: SupportedResolution,
): boolean {
  return bar.time === getRthBarStartMs(tickTimeMs, resolution);
}

function createBarFromTick(
  tickTimeMs: number,
  price: number,
  previousBar: TradingViewBar | null,
  resolution: SupportedResolution,
): TradingViewBar {
  const barStartMs = getRthBarStartMs(tickTimeMs, resolution);

  return {
    time: barStartMs,
    open: price,
    high: price,
    low: price,
    close: price,

    /**
     * Twelve price stream 提供的 day_volume 是日累计量，
     * 不等于 candle volume。
     *
     * 目前 UI 已关闭 Volume Study，
     * 此值不影响黄蓝梯子与所有 MA。
     * 等未来重新显示成交量时，建议在每根 bar 收盘后
     * 用 REST 重新拉最后 1-2 根完整 OHLCV 做纠正。
     */
    volume: previousBar?.volume ?? 0,
  };
}

function updateBarWithTick(
  lastBar: TradingViewBar | null,
  tickTimeMs: number,
  price: number,
  resolution: SupportedResolution,
): TradingViewBar {
  if (!lastBar || !isSameBarBucket(lastBar, tickTimeMs, resolution)) {
    return createBarFromTick(tickTimeMs, price, lastBar, resolution);
  }

  return {
    ...lastBar,
    high: Math.max(lastBar.high, price),
    low: Math.min(lastBar.low, price),
    close: price,
  };
}

function hasActiveStreams(): boolean {
  return streamSubscriptions.size > 0;
}

function getActiveSymbols(): string[] {
  const symbols = new Set<string>();

  for (const subscriptions of streamSubscriptions.values()) {
    for (const subscription of subscriptions) {
      symbols.add(subscription.symbol);
    }
  }

  return [...symbols];
}

function getWsUrl(): string {
  const apiKey = getApiKey();
  const url = new URL(TWELVE_WS_BASE_URL);

  url.searchParams.set("apikey", apiKey);

  return url.toString();
}

function sendWsEvent(event: Record<string, unknown>): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return;
  }

  ws.send(JSON.stringify(event));
}

function sendSubscribe(symbols: string[]): void {
  if (symbols.length === 0) {
    return;
  }

  console.info("[Twelve Data WS] subscribe", symbols);

  sendWsEvent({
    action: "subscribe",
    params: {
      symbols: symbols.join(","),
    },
  });
}

function sendUnsubscribe(symbols: string[]): void {
  if (symbols.length === 0) {
    return;
  }

  console.info("[Twelve Data WS] unsubscribe", symbols);

  sendWsEvent({
    action: "unsubscribe",
    params: {
      symbols: symbols.join(","),
    },
  });
}

function clearHeartbeat(): void {
  if (wsHeartbeatTimer !== null) {
    window.clearInterval(wsHeartbeatTimer);
    wsHeartbeatTimer = null;
  }
}

function startHeartbeat(): void {
  clearHeartbeat();

  wsHeartbeatTimer = window.setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }

    /**
     * Twelve Data 文档将 heartbeat 列为可用 event；
     * 每 10 秒发送一次，避免长连接空闲断开。
     */
    sendWsEvent({
      action: "heartbeat",
    });
  }, WS_HEARTBEAT_INTERVAL_MS);
}

function clearReconnectTimer(): void {
  if (wsReconnectTimer !== null) {
    window.clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }
}

function stopSocketIfIdle(): void {
  if (hasActiveStreams()) {
    return;
  }

  clearReconnectTimer();
  clearHeartbeat();

  wsReconnectDelayMs = WS_RECONNECT_INITIAL_DELAY_MS;

  if (
    ws &&
    (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
  ) {
    console.info("[Twelve Data WS] closing idle socket: no subscribers");

    ws.close(1000, "No active chart subscriptions");
  }

  ws = null;
}

function scheduleReconnect(): void {
  if (!hasActiveStreams() || wsReconnectTimer !== null) {
    return;
  }

  const delay = wsReconnectDelayMs;

  console.warn(`[Twelve Data WS] reconnect scheduled in ${delay}ms`);

  wsReconnectTimer = window.setTimeout(() => {
    wsReconnectTimer = null;
    ensureSocket();
  }, delay);

  wsReconnectDelayMs = Math.min(
    wsReconnectDelayMs * 2,
    WS_RECONNECT_MAX_DELAY_MS,
  );
}

function notifyResetCacheAfterReconnect(): void {
  for (const subscriptions of streamSubscriptions.values()) {
    for (const subscription of subscriptions) {
      try {
        subscription.onResetCacheNeededCallback?.();
      } catch (error) {
        console.warn("[TradingView] onResetCacheNeededCallback failed", error);
      }
    }
  }
}

function routePriceTick(message: TwelveWebSocketMessage): void {
  if (message.event !== "price") {
    return;
  }

  const symbol = normalizeSymbol(message.symbol ?? "");
  const timestampSeconds = toNumber(message.timestamp, NaN);
  const price = toNumber(message.price, NaN);

  if (
    !symbol ||
    !Number.isFinite(timestampSeconds) ||
    !Number.isFinite(price)
  ) {
    console.warn("[Twelve Data WS] invalid price tick ignored", {
      receivedAt: new Date().toISOString(),
      event: message.event,
      symbol: message.symbol,
      timestamp: message.timestamp,
      price: message.price,
      dayVolume: message.day_volume,
      rawMessage: message,
    });
    return;
  }

  const tickTimeMs = timestampSeconds * 1_000;
  const tickNewYork = DateTime.fromMillis(tickTimeMs, { zone: "utc" }).setZone(
    NY_TZ,
  );
  const isRth = isUsRthBar(tickTimeMs);

  console.info("[Twelve Data WS] price received", {
    receivedAt: new Date().toISOString(),
    browserTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    symbol,
    price,
    rawTimestampSeconds: timestampSeconds,
    tickTimeMs,
    tickUtc: new Date(tickTimeMs).toISOString(),
    tickNewYork: tickNewYork.isValid
      ? tickNewYork.toFormat("yyyy-LL-dd HH:mm:ss ZZZZ")
      : "INVALID",
    isRth,
    dayVolume: message.day_volume,
  });

  /**
   * 你的业务规则：
   * 只有 America/New_York 的周一至周五 09:30–16:00
   * 才让 tick 改变图表。
   *
   * 盘前、盘后、夜盘、周末全部忽略。
   */
  if (!isRth) {
    console.info("[Twelve Data WS] tick ignored: outside RTH", {
      symbol,
      price,
      tickUtc: new Date(tickTimeMs).toISOString(),
      tickNewYork: tickNewYork.isValid
        ? tickNewYork.toFormat("yyyy-LL-dd HH:mm:ss ZZZZ")
        : "INVALID",
    });
    return;
  }

  let matchedStreamCount = 0;

  for (const [streamKey, subscriptions] of streamSubscriptions) {
    const firstSubscription = subscriptions[0];

    if (!firstSubscription || firstSubscription.symbol !== symbol) {
      continue;
    }

    matchedStreamCount += 1;

    for (const subscription of subscriptions) {
      subscription.lastBar = updateBarWithTick(
        subscription.lastBar,
        tickTimeMs,
        price,
        subscription.resolution,
      );

      subscription.isDirty = true;

      /**
       * 把实时 bar 回写缓存。
       * 后续切图、重绘或接 REST 补 bar 时可用于衔接。
       */
      const cacheKey = getCacheKey(
        subscription.symbol,
        subscription.resolution,
      );

      const cachedBars = barCache.get(cacheKey) ?? [];
      const realtimeBar = subscription.lastBar;

      if (!realtimeBar) {
        continue;
      }

      const cachedLastBar = cachedBars.at(-1);

      if (!cachedLastBar) {
        barCache.set(cacheKey, [realtimeBar]);
        continue;
      }

      if (cachedLastBar.time === realtimeBar.time) {
        cachedBars[cachedBars.length - 1] = realtimeBar;
      } else if (cachedLastBar.time < realtimeBar.time) {
        cachedBars.push(realtimeBar);
      }

      barCache.set(cacheKey, cachedBars);
    }

    /**
     * 只可能有一个 symbol 对应当前 streamKey，
     * 命中后无需继续扫描。
     */
    void streamKey;
  }

  if (matchedStreamCount === 0) {
    console.warn("[Twelve Data WS] RTH tick has no matching active stream", {
      symbol,
      price,
      tickUtc: new Date(tickTimeMs).toISOString(),
      tickNewYork: tickNewYork.toFormat("yyyy-LL-dd HH:mm:ss ZZZZ"),
      activeSymbols: getActiveSymbols(),
    });
  }
}

function flushRealtimeBars(): void {
  for (const subscriptions of streamSubscriptions.values()) {
    for (const subscription of subscriptions) {
      if (!subscription.isDirty || !subscription.lastBar) {
        continue;
      }

      try {
        console.info("[TradingView] realtime bar flushed", {
          flushedAt: new Date().toISOString(),
          symbol: subscription.symbol,
          resolution: subscription.resolution,
          barTimeMs: subscription.lastBar.time,
          barTimeUtc: new Date(subscription.lastBar.time).toISOString(),
          barTimeNewYork: DateTime.fromMillis(subscription.lastBar.time, {
            zone: "utc",
          })
            .setZone(NY_TZ)
            .toFormat("yyyy-LL-dd HH:mm:ss ZZZZ"),
          open: subscription.lastBar.open,
          high: subscription.lastBar.high,
          low: subscription.lastBar.low,
          close: subscription.lastBar.close,
          volume: subscription.lastBar.volume,
        });

        subscription.callback(subscription.lastBar);
        subscription.isDirty = false;
      } catch (error) {
        console.error("[TradingView] onRealtimeCallback failed", error);
      }
    }
  }
}

/**
 * 不要在每个 Twelve tick 上直接 redraw 图表。
 * 开盘时 QQQ/TSLA tick 频率很高，250ms 批量刷新更平稳。
 */
const realtimeFlushTimer =
  typeof window === "undefined"
    ? null
    : window.setInterval(flushRealtimeBars, REALTIME_FLUSH_INTERVAL_MS);

void realtimeFlushTimer;

function onWebSocketMessage(event: MessageEvent<string>): void {
  let message: TwelveWebSocketMessage;

  try {
    message = JSON.parse(event.data) as TwelveWebSocketMessage;
  } catch {
    return;
  }

  if (message.event === "subscribe-status") {
    console.info("[Twelve Data WS] subscribe status", message);

    if (
      message.status &&
      message.status !== "ok" &&
      message.status !== "success"
    ) {
      console.warn("[Twelve Data WS] subscribe failed", message);
    }

    return;
  }

  if (message.event === "price") {
    routePriceTick(message);
    return;
  }

  if (message.event === "error") {
    console.error("[Twelve Data WS] provider error", message);
    return;
  }

  if (message.code || message.message) {
    console.warn("[Twelve Data WS] message", message);
  }
}

function createSocket(): WebSocket {
  clearReconnectTimer();

  const socket = new WebSocket(getWsUrl());

  socket.addEventListener("open", () => {
    if (ws !== socket) {
      return;
    }

    console.info("[Twelve Data WS] connected");

    const reconnected = hasConnectedBefore;
    hasConnectedBefore = true;
    wsReconnectDelayMs = WS_RECONNECT_INITIAL_DELAY_MS;

    startHeartbeat();

    const symbols = getActiveSymbols();
    sendSubscribe(symbols);

    if (reconnected) {
      /**
       * 连接断开期间可能错过 bars。
       * 通知 Charting Library 清 cache 并重新 getBars。
       */
      notifyResetCacheAfterReconnect();
    }
  });

  socket.addEventListener("message", onWebSocketMessage);

  socket.addEventListener("error", () => {
    /**
     * 浏览器 WebSocket error 往往没有细节；
     * 由 close handler 统一触发重连。
     */
    console.warn("[Twelve Data WS] socket error");
  });

  socket.addEventListener("close", (event) => {
    clearHeartbeat();

    if (ws === socket) {
      ws = null;
    }

    console.warn("[Twelve Data WS] closed", {
      code: event.code,
      reason: event.reason,
      wasClean: event.wasClean,
    });

    if (hasActiveStreams()) {
      scheduleReconnect();
    }
  });

  return socket;
}

function ensureSocket(): void {
  if (
    ws &&
    (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  if (!hasActiveStreams()) {
    return;
  }

  try {
    ws = createSocket();
  } catch (error) {
    console.error("[Twelve Data WS] failed to create socket", error);

    scheduleReconnect();
  }
}

function subscribeToRealtimeStream(
  symbol: string,
  resolution: TwelveResolution,
  callback: RealtimeCallback,
  subscriberUID: string,
  onResetCacheNeededCallback?: ResetCacheCallback,
): void {
  const streamKey = getStreamKey(symbol, resolution);

  const existingStreamKey = subscriberToStreamKey.get(subscriberUID);

  if (existingStreamKey) {
    unsubscribeFromRealtimeStream(subscriberUID);
  }

  const cacheKey = getCacheKey(symbol, resolution);
  const cachedLastBar = barCache.get(cacheKey)?.at(-1) ?? null;

  const subscription: RealtimeSubscription = {
    id: subscriberUID,
    symbol,
    resolution,
    callback,
    onResetCacheNeededCallback,
    lastBar: cachedLastBar,
    isDirty: false,
  };

  const existingSubscriptions = streamSubscriptions.get(streamKey);

  if (existingSubscriptions) {
    existingSubscriptions.push(subscription);
    subscriberToStreamKey.set(subscriberUID, streamKey);
    return;
  }

  streamSubscriptions.set(streamKey, [subscription]);
  subscriberToStreamKey.set(subscriberUID, streamKey);

  ensureSocket();

  /**
   * 若 socket 已经是 OPEN，立刻只订阅新 symbol。
   * 若仍 CONNECTING，open handler 会订阅全部 active symbols。
   */
  if (ws?.readyState === WebSocket.OPEN) {
    sendSubscribe([symbol]);
  }
}

function unsubscribeFromRealtimeStream(subscriberUID: string): void {
  const streamKey = subscriberToStreamKey.get(subscriberUID);

  if (!streamKey) {
    return;
  }

  const subscriptions = streamSubscriptions.get(streamKey);

  subscriberToStreamKey.delete(subscriberUID);

  if (!subscriptions) {
    return;
  }

  const remaining = subscriptions.filter(
    (subscription) => subscription.id !== subscriberUID,
  );

  if (remaining.length > 0) {
    streamSubscriptions.set(streamKey, remaining);
    return;
  }

  const symbol = subscriptions[0]?.symbol;

  streamSubscriptions.delete(streamKey);

  /**
   * 同一 symbol 可能仍在别的 resolution 下被订阅。
   * 仅当没有任何 active subscription 再使用此 symbol 时，才 unsubscribe。
   */
  const symbolStillUsed = [...streamSubscriptions.values()].some((items) =>
    items.some((item) => item.symbol === symbol),
  );

  if (symbol && !symbolStillUsed && ws?.readyState === WebSocket.OPEN) {
    sendUnsubscribe([symbol]);
  }

  stopSocketIfIdle();
}

export function createTwelveDatafeed() {
  return {
    onReady(callback: (config: DatafeedConfiguration) => void): void {
      window.setTimeout(() => {
        callback({
          supported_resolutions: SUPPORTED_RESOLUTIONS,
          supports_group_request: false,
          supports_marks: false,
          supports_search: true,
          supports_timescale_marks: false,
          supports_time: true,
        });
      }, 0);
    },

    searchSymbols(
      userInput: string,
      _exchange: string,
      _symbolType: string,
      onResultReadyCallback: (symbols: SearchSymbolResult[]) => void,
    ): void {
      const ticker = normalizeSymbol(userInput);

      if (!ticker) {
        onResultReadyCallback([]);
        return;
      }

      onResultReadyCallback([
        {
          symbol: ticker,
          full_name: `${DEFAULT_EXCHANGE}:${ticker}`,
          description: ticker,
          exchange: DEFAULT_EXCHANGE,
          ticker,
          type: "stock",
        },
      ]);
    },

    resolveSymbol(
      symbolName: string,
      onSymbolResolvedCallback: (symbolInfo: SymbolInfo) => void,
      onResolveErrorCallback: (reason: string) => void,
    ): void {
        window.setTimeout(() => {
        try {
          onSymbolResolvedCallback(makeSymbolInfo(symbolName));
        } catch (error) {
          onResolveErrorCallback(
            error instanceof Error ? error.message : String(error),
          );
        }
      }, 0);
    },

    async getBars(
      symbolInfo: SymbolInfo,
      resolution: string,
      periodParams: PeriodParams,
      onHistoryCallback: HistoryCallback,
      onErrorCallback: ErrorCallback,
    ): Promise<void> {
      try {
        if (!isSupportedResolution(resolution)) {
          onErrorCallback(
            `Unsupported resolution: ${resolution}. ` +
              `Supported: ${SUPPORTED_RESOLUTIONS.join(", ")}`,
          );
          return;
        }

        const symbol = normalizeSymbol(symbolInfo.ticker);

        // [3m] 3 分钟：走 tv-ws-server（TradingView-API）
        if (isTvFeedResolution(resolution)) {
          /**
           * 服务端目前只提供最近 N 根，不支持向左翻页。
           * 图表滚动到最左侧会发起非首次请求，直接告知没有更多历史。
           */
          if (!periodParams.firstDataRequest) {
            onHistoryCallback([], { noData: true });
            return;
          }

          const tvBars = filterUsRthBars(
            await fetchTvHistory(
              symbol,
              resolution,
              Math.max(periodParams.countBack, DEFAULT_HISTORY_BARS),
            ),
          );

          console.info("[TV WS bars]", {
            symbol,
            resolution,
            countBack: periodParams.countBack,
            rthBarsReturned: tvBars.length,
            firstDataRequest: periodParams.firstDataRequest,
          });

          onHistoryCallback(tvBars, {
            noData: tvBars.length === 0,
          });
          return;
        }

        // 以下为 Twelve Data 周期（1/5/15/30/60），逻辑不变
        const cacheKey = getCacheKey(symbol, resolution);

        const bars = await fetchTwelveBars(
          symbol,
          resolution,
          periodParams.countBack,
        );

        barCache.set(cacheKey, bars);

        console.info("[Twelve Data REST bars]", {
          symbol,
          resolution,
          rawRequested: getRequestedOutputSize(periodParams.countBack),
          rthBarsReturned: bars.length,
          firstDataRequest: periodParams.firstDataRequest,
        });

        onHistoryCallback(bars, {
          noData: bars.length === 0,
        });
      } catch (error) {
        onErrorCallback(error instanceof Error ? error.message : String(error));
      }
    },

    /**
     * Charting Library 在需要当前 symbol/resolution 实时 bar 时调用。
     *
     * Twelve 周期：lastBar 来自 getBars() 写入的 barCache，
     * WebSocket tick 通过 onRealtimeCallback 推入当前 chart。
     *
     * [3m] 3 分钟：直接转发 tv-ws-server 推送的最新 K 线。
     */
    subscribeBars(
      symbolInfo: SymbolInfo,
      resolution: string,
      onRealtimeCallback: RealtimeCallback,
      subscriberUID: string,
      onResetCacheNeededCallback?: ResetCacheCallback,
    ): void {
      if (!isSupportedResolution(resolution)) {
        console.warn(
          "[TradingView] unsupported realtime resolution",
          resolution,
        );
        return;
      }

      const symbol = normalizeSymbol(symbolInfo.ticker);

      console.info("[TradingView] subscribeBars", {
        symbol,
        resolution,
        subscriberUID,
      });

      // [3m]
      if (isTvFeedResolution(resolution)) {
        subscribeTvBars(
          subscriberUID,
          symbol,
          resolution,
          (bar) => {
            // 双重保险：服务端已过滤，这里再保证只有 RTH 的 bar 进入图表
            if (isUsRthBar(bar.time)) {
              onRealtimeCallback(bar);
            }
          },
          onResetCacheNeededCallback,
        );
        return;
      }

      subscribeToRealtimeStream(
        symbol,
        resolution,
        onRealtimeCallback,
        subscriberUID,
        onResetCacheNeededCallback,
      );
    },

    unsubscribeBars(subscriberUID: string): void {
      console.info("[TradingView] unsubscribeBars", {
        subscriberUID,
      });

      // 两条通道各自忽略不属于自己的 subscriberUID
      unsubscribeTvBars(subscriberUID);
      unsubscribeFromRealtimeStream(subscriberUID);
    },
  };
}
