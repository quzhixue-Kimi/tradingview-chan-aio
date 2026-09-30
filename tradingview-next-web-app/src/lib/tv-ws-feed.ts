import type { OhlcvBar } from "./market-session";

/**
 * 近似实时 K 线数据源：连接自建的 tv-ws-server（TradingView-API 的 WebSocket 桥）。
 *
 * 目前只用于 3 分钟周期；datafeed.ts 在 resolution === "3" 时调用本文件。
 *
 * 协议（服务端 tv-ws-server）：
 *   -> {"action":"subscribe","symbol":"NASDAQ:QQQ","resolution":"3","count":500}
 *   <- {"type":"subscribed", ...}
 *   <- {"type":"history","symbol","resolution","bars":[...升序...]}
 *   <- {"type":"bar","symbol","resolution","bar":{...}}   // 最新一根，time 相同则覆盖
 *   <- {"type":"status","status":"reconnecting","symbol"}
 *   <- {"type":"error","code","message","symbol"?}
 *   -> {"action":"ping"} / <- {"type":"pong"}
 *   -> {"action":"unsubscribe","symbol","resolution"}
 *
 * 注意：process.env.NEXT_PUBLIC_* 必须按字面写，才会在 `bun run build` 时被内联。
 */

const TV_WS_URL = process.env.NEXT_PUBLIC_TV_WS_URL ?? "";
const TV_WS_TOKEN = process.env.NEXT_PUBLIC_TV_WS_TOKEN ?? "";

const DEFAULT_EXCHANGE = "NASDAQ";

const MAX_HISTORY_COUNT = 1000;
const DEFAULT_HISTORY_COUNT = 500;

const HISTORY_TIMEOUT_MS = 30_000;
const PING_INTERVAL_MS = 20_000;
const STALE_AFTER_MS = 75_000;

/**
 * getBars 之后紧接着会 subscribeBars；给一个宽限期，
 * 避免中间短暂没有订阅者时就 unsubscribe / 关闭连接。
 */
const CLEANUP_GRACE_MS = 5_000;

const RECONNECT_INITIAL_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;

type WireBar = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  timeUtc?: string;
  timeNY?: string;
};

type TvServerMessage = {
  type?: string;
  symbol?: string;
  resolution?: string;
  status?: string;
  code?: string;
  message?: string;
  bars?: WireBar[];
  bar?: WireBar;
};

type PendingHistory = {
  resolve: (bars: OhlcvBar[]) => void;
  reject: (error: Error) => void;
  timer: number;
};

type RealtimeSub = {
  uid: string;
  key: string;
  onBar: (bar: OhlcvBar) => void;
  onReset?: () => void;
};

type KeyMeta = {
  symbol: string;
  resolution: string;
  count: number;
};

const LOG = "[TV WS]";

let ws: WebSocket | null = null;
let reconnectTimer: number | null = null;
let heartbeatTimer: number | null = null;
let cleanupTimer: number | null = null;
let reconnectDelayMs = RECONNECT_INITIAL_DELAY_MS;
let hasConnectedBefore = false;
let lastMessageAt = 0;
let authFailed = false;
let configErrorLogged = false;

/** key = "NASDAQ:QQQ|3" */
const pending = new Map<string, PendingHistory[]>();
const realtimeSubs = new Map<string, RealtimeSub>();
const keyMeta = new Map<string, KeyMeta>();
/** 当前这条 socket 上已经向服务端 subscribe 过的 key */
const serverKeys = new Set<string>();
/** 每个 key 已经交给图表的最后一根 K 线时间，防止时间倒退 */
const lastBarTime = new Map<string, number>();
/** 服务端 TradingView 侧重连过，下次 history 到达时要通知图表重拉 */
const needsReset = new Set<string>();

// ---------------------------------------------------------------- helpers

function toFullSymbol(ticker: string): string {
  const upper = ticker.trim().toUpperCase();

  return upper.includes(":") ? upper : `${DEFAULT_EXCHANGE}:${upper}`;
}

function makeKey(symbol: string, resolution: string): string {
  return `${symbol}|${resolution}`;
}

function toNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : fallback;
}

function toBar(wire: WireBar): OhlcvBar {
  return {
    time: toNumber(wire.time, NaN),
    open: toNumber(wire.open),
    high: toNumber(wire.high),
    low: toNumber(wire.low),
    close: toNumber(wire.close),
    volume: toNumber(wire.volume),
  };
}

function getWsUrl(): string {
  const url = new URL(TV_WS_URL);

  if (TV_WS_TOKEN) {
    url.searchParams.set("token", TV_WS_TOKEN);
  }

  return url.toString();
}

function neededKeys(): Set<string> {
  const keys = new Set<string>();

  for (const [key, list] of pending) {
    if (list.length > 0) {
      keys.add(key);
    }
  }

  for (const sub of realtimeSubs.values()) {
    keys.add(sub.key);
  }

  return keys;
}

function isOpen(): boolean {
  return ws !== null && ws.readyState === WebSocket.OPEN;
}

function sendJson(payload: Record<string, unknown>): boolean {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return false;
  }

  ws.send(JSON.stringify(payload));

  return true;
}

function rejectPending(
  predicate: (key: string) => boolean,
  error: Error,
): void {
  for (const [key, list] of pending) {
    if (!predicate(key)) {
      continue;
    }

    for (const item of list) {
      window.clearTimeout(item.timer);
      item.reject(error);
    }

    pending.delete(key);
  }
}

function notifyReset(keys?: string[]): void {
  for (const sub of realtimeSubs.values()) {
    if (keys && !keys.includes(sub.key)) {
      continue;
    }

    lastBarTime.delete(sub.key);

    try {
      sub.onReset?.();
    } catch (error) {
      console.warn(`${LOG} onResetCacheNeededCallback failed`, error);
    }
  }
}

// ---------------------------------------------------------------- server subscription

function subscribeOnServer(key: string, force = false): void {
  const meta = keyMeta.get(key);

  if (!meta) {
    return;
  }

  if (!force && serverKeys.has(key)) {
    return;
  }

  const sent = sendJson({
    action: "subscribe",
    symbol: meta.symbol,
    resolution: meta.resolution,
    count: meta.count,
  });

  if (sent) {
    serverKeys.add(key);
    console.info(`${LOG} subscribe`, meta);
  }
}

// ---------------------------------------------------------------- message handling

function handleHistory(message: TvServerMessage): void {
  if (!message.symbol || !message.resolution || !message.bars) {
    return;
  }

  const key = makeKey(message.symbol, message.resolution);

  const bars = message.bars
    .map(toBar)
    .filter((bar) => Number.isFinite(bar.time))
    .sort((left, right) => left.time - right.time);

  const lastBar = bars.at(-1);

  if (lastBar) {
    lastBarTime.set(key, lastBar.time);
  }

  const waiting = pending.get(key);

  console.info(`${LOG} history`, {
    key,
    bars: bars.length,
    waiting: waiting?.length ?? 0,
    lastBarUtc: lastBar ? new Date(lastBar.time).toISOString() : null,
  });

  if (waiting && waiting.length > 0) {
    pending.delete(key);
    needsReset.delete(key);

    for (const item of waiting) {
      window.clearTimeout(item.timer);
      item.resolve(bars);
    }

    scheduleCleanup();

    return;
  }

  /**
   * 没有 getBars 在等：这是订阅时服务端附带发来的 history，
   * 或者服务端与 TradingView 重连后的重新同步。
   * 只有后者需要让图表重拉。
   */
  if (needsReset.has(key)) {
    needsReset.delete(key);
    notifyReset([key]);
  }
}

function handleBar(message: TvServerMessage): void {
  if (!message.symbol || !message.resolution || !message.bar) {
    return;
  }

  const key = makeKey(message.symbol, message.resolution);
  const bar = toBar(message.bar);

  if (!Number.isFinite(bar.time)) {
    return;
  }

  const last = lastBarTime.get(key);

  if (last !== undefined && bar.time < last) {
    console.warn(`${LOG} stale bar ignored`, {
      key,
      barUtc: new Date(bar.time).toISOString(),
      lastUtc: new Date(last).toISOString(),
    });

    return;
  }

  lastBarTime.set(key, bar.time);

  for (const sub of realtimeSubs.values()) {
    if (sub.key !== key) {
      continue;
    }

    try {
      sub.onBar(bar);
    } catch (error) {
      console.error(`${LOG} onRealtimeCallback failed`, error);
    }
  }
}

function handleMessage(message: TvServerMessage): void {
  switch (message.type) {
    case "history":
      handleHistory(message);
      return;

    case "bar":
      handleBar(message);
      return;

    case "status": {
      console.info(`${LOG} status`, message);

      if (message.status === "reconnecting" && message.symbol) {
        const prefix = `${message.symbol}|`;

        for (const key of neededKeys()) {
          if (key.startsWith(prefix)) {
            needsReset.add(key);
          }
        }
      }

      return;
    }

    case "error": {
      console.error(`${LOG} server error`, message);

      // load_timeout 时服务端会自己重试，让 getBars 的本地超时来兜底
      if (message.code === "load_timeout") {
        return;
      }

      const prefix = message.symbol ? `${message.symbol}|` : null;

      rejectPending(
        (key) => (prefix ? key.startsWith(prefix) : true),
        new Error(message.message ?? `TV WS error: ${message.code ?? ""}`),
      );

      return;
    }

    default:
      // subscribed / unsubscribed / pong 无需处理
      return;
  }
}

// ---------------------------------------------------------------- socket lifecycle

function stopHeartbeat(): void {
  if (heartbeatTimer !== null) {
    window.clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function startHeartbeat(): void {
  stopHeartbeat();

  heartbeatTimer = window.setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }

    if (Date.now() - lastMessageAt > STALE_AFTER_MS) {
      console.warn(`${LOG} no message for a while, closing stale socket`);
      ws.close(4000, "stale");

      return;
    }

    sendJson({ action: "ping" });
  }, PING_INTERVAL_MS);
}

function clearReconnectTimer(): void {
  if (reconnectTimer !== null) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect(): void {
  if (authFailed || reconnectTimer !== null || neededKeys().size === 0) {
    return;
  }

  const delay = reconnectDelayMs;

  console.warn(`${LOG} reconnect scheduled in ${delay}ms`);

  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    ensureSocket();
  }, delay);

  reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_MAX_DELAY_MS);
}

function createSocket(): WebSocket {
  const socket = new WebSocket(getWsUrl());

  socket.addEventListener("open", () => {
    if (ws !== socket) {
      socket.close();

      return;
    }

    console.info(`${LOG} connected`);

    const reconnected = hasConnectedBefore;

    hasConnectedBefore = true;
    reconnectDelayMs = RECONNECT_INITIAL_DELAY_MS;
    lastMessageAt = Date.now();

    startHeartbeat();

    serverKeys.clear();

    for (const key of neededKeys()) {
      subscribeOnServer(key, true);
    }

    if (reconnected) {
      // 断线期间可能错过 K 线：让图表清缓存并重新 getBars
      notifyReset();
    }
  });

  socket.addEventListener("message", (event: MessageEvent<string>) => {
    lastMessageAt = Date.now();

    let message: TvServerMessage;

    try {
      message = JSON.parse(event.data) as TvServerMessage;
    } catch {
      return;
    }

    handleMessage(message);
  });

  socket.addEventListener("error", () => {
    // 浏览器不给错误细节，统一由 close 处理
    console.warn(`${LOG} socket error`);
  });

  socket.addEventListener("close", (event) => {
    stopHeartbeat();

    if (ws === socket) {
      ws = null;
    }

    serverKeys.clear();

    console.warn(`${LOG} closed`, {
      code: event.code,
      reason: event.reason,
      wasClean: event.wasClean,
    });

    if (event.code === 4401) {
      authFailed = true;

      rejectPending(
        () => true,
        new Error("TV WS unauthorized: check NEXT_PUBLIC_TV_WS_TOKEN"),
      );

      console.error(
        `${LOG} unauthorized (4401). Reconnect disabled until page reload.`,
      );

      return;
    }

    scheduleReconnect();
  });

  return socket;
}

function ensureSocket(): void {
  if (authFailed) {
    return;
  }

  if (!TV_WS_URL) {
    if (!configErrorLogged) {
      configErrorLogged = true;
      console.error(
        `${LOG} Missing NEXT_PUBLIC_TV_WS_URL. ` +
          "Export it before `bun run build` (or set it in .env.local for dev).",
      );
    }

    return;
  }

  if (
    ws &&
    (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  if (neededKeys().size === 0) {
    return;
  }

  // 有用户操作时不必等退避计时，直接尝试连接
  clearReconnectTimer();

  try {
    ws = createSocket();
  } catch (error) {
    console.error(`${LOG} failed to create socket`, error);
    ws = null;
    scheduleReconnect();
  }
}

/**
 * 退订不再需要的 key；没有任何需求时关闭 socket。
 * 每次调用会重置计时器，所以 getBars -> subscribeBars 之间不会误关。
 */
function scheduleCleanup(): void {
  if (cleanupTimer !== null) {
    window.clearTimeout(cleanupTimer);
  }

  cleanupTimer = window.setTimeout(() => {
    cleanupTimer = null;

    const needed = neededKeys();

    for (const key of [...serverKeys]) {
      if (needed.has(key)) {
        continue;
      }

      const meta = keyMeta.get(key);

      if (meta) {
        sendJson({
          action: "unsubscribe",
          symbol: meta.symbol,
          resolution: meta.resolution,
        });

        console.info(`${LOG} unsubscribe`, meta);
      }

      serverKeys.delete(key);
    }

    for (const key of [...keyMeta.keys()]) {
      if (!needed.has(key)) {
        keyMeta.delete(key);
        lastBarTime.delete(key);
        needsReset.delete(key);
      }
    }

    if (needed.size === 0) {
      clearReconnectTimer();
      stopHeartbeat();

      const socket = ws;

      ws = null;
      hasConnectedBefore = false;
      reconnectDelayMs = RECONNECT_INITIAL_DELAY_MS;

      if (
        socket &&
        (socket.readyState === WebSocket.OPEN ||
          socket.readyState === WebSocket.CONNECTING)
      ) {
        console.info(`${LOG} closing idle socket`);
        socket.close(1000, "idle");
      }
    }
  }, CLEANUP_GRACE_MS);
}

// ---------------------------------------------------------------- public API

/**
 * 获取历史 K 线（毫秒时间戳、升序、仅服务端已过滤的美股 RTH）。
 * 对应 Charting Library 的 getBars 首次请求。
 */
export function fetchTvHistory(
  ticker: string,
  resolution: string,
  countBack: number,
): Promise<OhlcvBar[]> {
  if (authFailed) {
    return Promise.reject(
      new Error("TV WS unauthorized: check NEXT_PUBLIC_TV_WS_TOKEN"),
    );
  }

  if (!TV_WS_URL) {
    return Promise.reject(new Error("Missing NEXT_PUBLIC_TV_WS_URL"));
  }

  const symbol = toFullSymbol(ticker);
  const key = makeKey(symbol, resolution);

  const requested = Math.min(
    Math.max(Math.floor(countBack) || DEFAULT_HISTORY_COUNT, 1),
    MAX_HISTORY_COUNT,
  );

  const previous = keyMeta.get(key);

  keyMeta.set(key, {
    symbol,
    resolution,
    count: Math.max(previous?.count ?? 0, requested),
  });

  return new Promise<OhlcvBar[]>((resolve, reject) => {
    const item: PendingHistory = {
      resolve,
      reject,
      timer: window.setTimeout(() => {
        const list = pending.get(key) ?? [];
        const remaining = list.filter((entry) => entry !== item);

        if (remaining.length > 0) {
          pending.set(key, remaining);
        } else {
          pending.delete(key);
        }

        scheduleCleanup();
        reject(new Error(`TV WS history timeout for ${key}`));
      }, HISTORY_TIMEOUT_MS),
    };

    const list = pending.get(key) ?? [];

    list.push(item);
    pending.set(key, list);

    ensureSocket();

    // 强制重发 subscribe，让服务端再发一次 history
    if (isOpen()) {
      subscribeOnServer(key, true);
    }
  });
}

/**
 * 订阅最新 K 线更新。onBar 会收到“正在形成的那一根”，time 相同则覆盖。
 */
export function subscribeTvBars(
  subscriberUID: string,
  ticker: string,
  resolution: string,
  onBar: (bar: OhlcvBar) => void,
  onReset?: () => void,
): void {
  unsubscribeTvBars(subscriberUID);

  const symbol = toFullSymbol(ticker);
  const key = makeKey(symbol, resolution);

  if (!keyMeta.has(key)) {
    keyMeta.set(key, { symbol, resolution, count: 1 });
  }

  realtimeSubs.set(subscriberUID, {
    uid: subscriberUID,
    key,
    onBar,
    onReset,
  });

  console.info(`${LOG} subscribeBars`, { key, subscriberUID });

  ensureSocket();

  if (isOpen()) {
    subscribeOnServer(key);
  }
}

export function unsubscribeTvBars(subscriberUID: string): void {
  if (!realtimeSubs.delete(subscriberUID)) {
    return;
  }

  console.info(`${LOG} unsubscribeBars`, { subscriberUID });

  scheduleCleanup();
}
