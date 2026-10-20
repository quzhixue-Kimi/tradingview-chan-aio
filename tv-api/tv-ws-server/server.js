'use strict';
/**
 * TradingView K-line WebSocket bridge (US stocks, RTH only)
 *
 * 前端 -> (nginx wss) -> ws://127.0.0.1:PORT/ws -> 本服务 -> TradingView-API -> TradingView
 *
 * 启动: 在任意目录执行  node /root/tools/tv-api/tv-ws-server/server.js
 * .env 和 logs/ 都相对于本文件所在目录，不依赖启动时的工作目录。
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const http = require('http');
const fs = require('fs');
const WebSocketLib = require('ws');
const { DateTime } = require('luxon');

// ws 7.x 用 WebSocket.Server，8.x 用 WebSocketServer，这里两种都兼容
const WebSocketServer = WebSocketLib.WebSocketServer || WebSocketLib.Server;

// ---------------------------------------------------------------- config
const cfg = {
  port: Number(process.env.PORT || 4000),
  // 默认只监听本机，由 nginx 对外提供服务
  host: process.env.HOST || '127.0.0.1',
  authToken: process.env.AUTH_TOKEN || '',
  defaultExchange: (process.env.DEFAULT_EXCHANGE || 'NASDAQ').toUpperCase(),
  historyBars: Math.min(Number(process.env.HISTORY_BARS || 1000), 5000),
  maxStreams: Number(process.env.MAX_STREAMS || 20),
  idleCloseMs: Number(process.env.IDLE_CLOSE_MS || 30000),
  flushMs: Number(process.env.FLUSH_MS || 250),
  loadTimeoutMs: Number(process.env.LOAD_TIMEOUT_MS || 20000),
  logLevel: (process.env.LOG_LEVEL || 'info').toLowerCase(),
  logFile: process.env.LOG_FILE || '',
  tvSession: process.env.TV_SESSION || '',
  tvSignature: process.env.TV_SIGNATURE || '',
};

// 目前只开放 3 分钟；以后要加周期，只需在这里加一项
const SUPPORTED_RESOLUTIONS = new Set(['1', '3', '5', '15', '30',
  '60', '120', '240','D','W','M']);

// ---------------------------------------------------------------- logger
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
let logStream = null;
if (cfg.logFile) {
  const logPath = path.resolve(__dirname, cfg.logFile);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  logStream = fs.createWriteStream(logPath, { flags: 'a' });
}

function errStr(e) {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch (_) {
    return String(e);
  }
}

function log(level, msg, meta) {
  if ((LEVELS[level] || 20) < (LEVELS[cfg.logLevel] || 20)) return;
  const line =
    `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}` +
    (meta ? ` ${JSON.stringify(meta)}` : '');
  (level === 'error' ? console.error : console.log)(line);
  if (logStream) logStream.write(`${line}\n`);
}

// ---------------------------------------------------------------- TradingView lib
function loadTradingView() {
  const candidates = [
    process.env.TV_LIB_PATH,
    path.resolve(__dirname, '..'), // 放在 TradingView-API 仓库的子目录里时
    '@mathieuc/tradingview', // npm 安装时
  ].filter(Boolean);

  for (const c of candidates) {
    try {
      const lib = require(c);
      if (lib && typeof lib.Client === 'function') {
        log('info', 'TradingView library loaded', { from: c });
        return lib;
      }
    } catch (e) {
      log('debug', 'TradingView library candidate failed', { c, err: errStr(e) });
    }
  }
  throw new Error(
    'Cannot load TradingView-API. Put this folder inside the cloned repo, ' +
      'or set TV_LIB_PATH, or run: npm i @mathieuc/tradingview',
  );
}
const TradingView = loadTradingView();

// ---------------------------------------------------------------- time / bars
const NY_TZ = 'America/New_York';
const RTH_OPEN_MIN = 9 * 60 + 30;
const RTH_CLOSE_MIN = 16 * 60;

/** bar 起始时间(ms, UTC) 是否落在美东 周一至周五 09:30-16:00 */
function isUsRth(ms) {
  const ny = DateTime.fromMillis(ms, { zone: NY_TZ });
  if (!ny.isValid || ny.weekday > 5) return false;
  const m = ny.hour * 60 + ny.minute;
  return m >= RTH_OPEN_MIN && m < RTH_CLOSE_MIN;
}

/** TradingView period -> 统一输出格式（time 为毫秒 UTC，K 线起始时间） */
function toBar(p) {
  const time = p.time * 1000;
  return {
    time,
    timeUtc: new Date(time).toISOString(),
    timeNY: DateTime.fromMillis(time, { zone: NY_TZ }).toFormat('yyyy-LL-dd HH:mm:ss ZZZZ'),
    open: p.open,
    high: p.max,
    low: p.min,
    close: p.close,
    volume: p.volume,
  };
}

function barSig(b) {
  return `${b.open}|${b.high}|${b.low}|${b.close}|${b.volume}`;
}

function parseSymbol(input) {
  const s = String(input || '').trim().toUpperCase();
  if (!/^[A-Z0-9._-]+(:[A-Z0-9._-]+)?$/.test(s)) return null;
  const full = s.includes(':') ? s : `${cfg.defaultExchange}:${s}`;
  return { full, ticker: full.split(':')[1] };
}

/** 经过 nginx 时取真实客户端 IP */
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket.remoteAddress;
}

// ---------------------------------------------------------------- helpers
const stats = { msgSent: 0, barsSent: 0, historySent: 0, reconnects: 0 };

function send(ws, obj) {
  if (ws.readyState !== 1) return;
  ws.send(JSON.stringify(obj));
  stats.msgSent += 1;
}

// ---------------------------------------------------------------- Stream
/** 一个 (交易所:代码, 周期) 对应一条 TradingView 连接，多个前端共享 */
class Stream {
  constructor(full, resolution, onEmpty) {
    this.full = full;
    this.resolution = resolution;
    this.key = `${full}|${resolution}`;
    this.onEmpty = onEmpty;
    this.subs = new Map(); // ws -> count
    this.client = null;
    this.chart = null;
    this.ready = false;
    this.closed = false;
    this.dirty = false;
    this.sent = new Map(); // barTime -> signature
    this.retryDelay = 1000;
    this.retryTimer = null;
    this.idleTimer = null;
    this.loadTimer = null;
    this.lastUpdateAt = 0;
    this.flushTimer = setInterval(() => this.flush(), cfg.flushMs);
    this.connect();
  }

  connect() {
    if (this.closed) return;
    log('info', 'stream connecting', { key: this.key });
    this.ready = false;
    this.sent.clear();

    let client;
    try {
      client = new TradingView.Client(
        cfg.tvSession ? { token: cfg.tvSession, signature: cfg.tvSignature } : {},
      );
    } catch (e) {
      log('error', 'create TradingView client failed', { key: this.key, err: errStr(e) });
      this.scheduleRetry();
      return;
    }
    const chart = new client.Session.Chart();
    this.client = client;
    this.chart = chart;

    client.onConnected(() => {
      if (this.client !== client) return;
      log('info', 'TradingView websocket connected', { key: this.key });
    });
    client.onDisconnected(() => {
      if (this.client !== client) return;
      log('warn', 'TradingView websocket disconnected', { key: this.key });
      this.scheduleRetry();
    });
    client.onError((...a) => {
      if (this.client !== client) return;
      log('error', 'TradingView client error', { key: this.key, err: a.map(errStr).join(' ') });
    });

    chart.onError((...a) => {
      if (this.chart !== chart) return;
      const message = a.map(errStr).join(' ');
      log('error', 'TradingView chart error', { key: this.key, err: message });
      this.broadcast({ type: 'error', code: 'chart_error', symbol: this.full, message });
    });
    chart.onSymbolLoaded(() => {
      if (this.chart !== chart) return;
      log('info', 'symbol loaded', {
        key: this.key,
        description: chart.infos && chart.infos.description,
        exchange: chart.infos && chart.infos.exchange,
        currency: chart.infos && chart.infos.currency_id,
      });
    });
    chart.onUpdate(() => {
      if (this.chart !== chart) return;
      this.onChartUpdate();
    });

    chart.setMarket(this.full, { timeframe: this.resolution, range: cfg.historyBars });

    clearTimeout(this.loadTimer);
    this.loadTimer = setTimeout(() => {
      if (this.ready || this.closed) return;
      log('warn', 'load timeout, restarting stream', { key: this.key });
      this.broadcast({
        type: 'error',
        code: 'load_timeout',
        symbol: this.full,
        message: 'No data from TradingView, retrying',
      });
      this.scheduleRetry();
    }, cfg.loadTimeoutMs);
  }

  teardown() {
    const { client, chart } = this;
    this.client = null;
    this.chart = null;
    this.ready = false;
    clearTimeout(this.loadTimer);
    try {
      if (chart) chart.delete();
    } catch (e) {
      log('debug', 'chart.delete failed', { err: errStr(e) });
    }
    try {
      if (client) client.end();
    } catch (e) {
      log('debug', 'client.end failed', { err: errStr(e) });
    }
  }

  scheduleRetry() {
    if (this.closed || this.retryTimer) return;
    this.teardown();
    const delay = this.retryDelay;
    this.retryDelay = Math.min(this.retryDelay * 2, 30000);
    stats.reconnects += 1;
    log('warn', 'stream reconnect scheduled', { key: this.key, delayMs: delay });
    this.broadcast({ type: 'status', status: 'reconnecting', symbol: this.full });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  /**
   * 返回最近 count 根 RTH K 线（升序）。
   * 先过滤+截取，再做时间格式化，避免对全部历史做昂贵的转换。
   */
  currentBars(count) {
    if (!this.chart) return [];
    let periods = this.chart.periods
      .filter((p) => isUsRth(p.time * 1000))
      .sort((a, b) => b.time - a.time); // 最新在前
    if (count && periods.length > count) periods = periods.slice(0, count);
    return periods.map(toBar).sort((a, b) => a.time - b.time);
  }

  onChartUpdate() {
    this.lastUpdateAt = Date.now();
    if (!this.chart || this.chart.periods.length === 0) return;

    if (!this.ready) {
      this.ready = true;
      this.retryDelay = 1000;
      clearTimeout(this.loadTimer);

      // 只需记住最近几十根的签名，flush 只检查最新 3 根
      const recent = this.currentBars(50);
      this.sent.clear();
      recent.forEach((b) => this.sent.set(b.time, barSig(b)));
      log('info', 'history ready', {
        key: this.key,
        totalPeriods: this.chart.periods.length,
        latest: recent.length ? recent[recent.length - 1].timeNY : null,
      });
      for (const [ws, count] of this.subs) this.sendHistory(ws, count);
      return;
    }
    this.dirty = true;
  }

  sendHistory(ws, count) {
    if (ws.readyState !== 1) return; // 忽略 /bars 使用的占位订阅
    const list = this.currentBars(count);
    send(ws, {
      type: 'history',
      symbol: this.full,
      resolution: this.resolution,
      count: list.length,
      bars: list,
      serverTime: Date.now(),
    });
    stats.historySent += 1;
    log('info', 'history sent', {
      key: this.key,
      bars: list.length,
      first: list[0] && list[0].timeNY,
      last: list.length ? list[list.length - 1].timeNY : null,
    });
  }

  /** 每 FLUSH_MS 最多推一次；只看最新 3 根，因为更早的不会再变 */
  flush() {
    if (!this.ready || !this.dirty || !this.chart || this.subs.size === 0) return;
    this.dirty = false;
    const tail = this.chart.periods.slice(0, 3).map(toBar).reverse();
    for (const b of tail) {
      if (!isUsRth(b.time)) {
        log('debug', 'bar ignored: outside RTH', { key: this.key, timeNY: b.timeNY });
        continue;
      }
      const sig = barSig(b);
      if (this.sent.get(b.time) === sig) continue;
      this.sent.set(b.time, sig);
      stats.barsSent += 1;
      log('debug', 'bar update', {
        key: this.key,
        receivedAt: new Date().toISOString(),
        barUtc: b.timeUtc,
        barNY: b.timeNY,
        close: b.close,
        volume: b.volume,
      });
      this.broadcast({
        type: 'bar',
        symbol: this.full,
        resolution: this.resolution,
        bar: b,
        serverTime: Date.now(),
      });
    }
  }

  broadcast(obj) {
    for (const ws of this.subs.keys()) send(ws, obj);
  }

  subscribe(ws, count) {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.subs.set(ws, count);
    if (this.ready) this.sendHistory(ws, count);
  }

  unsubscribe(ws) {
    this.subs.delete(ws);
    if (this.subs.size === 0 && !this.idleTimer) {
      this.idleTimer = setTimeout(() => {
        if (this.subs.size === 0) {
          log('info', 'stream idle, closing', { key: this.key });
          this.onEmpty(this);
        }
      }, cfg.idleCloseMs);
    }
  }

  destroy() {
    this.closed = true;
    clearInterval(this.flushTimer);
    clearTimeout(this.retryTimer);
    clearTimeout(this.idleTimer);
    this.teardown();
    this.subs.clear();
  }
}

// ---------------------------------------------------------------- StreamManager
const streams = new Map();

function getStream(full, resolution) {
  const key = `${full}|${resolution}`;
  let s = streams.get(key);
  if (s) return s;
  if (streams.size >= cfg.maxStreams) return null;
  s = new Stream(full, resolution, (st) => {
    st.destroy();
    streams.delete(st.key);
  });
  streams.set(key, s);
  return s;
}

function waitReady(stream, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (stream.ready) {
        clearInterval(timer);
        resolve(true);
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(timer);
        resolve(false);
      }
    }, 100);
  });
}

// ---------------------------------------------------------------- HTTP
function authOk(req, url) {
  if (!cfg.authToken) return true;
  return url.searchParams.get('token') === cfg.authToken || req.headers['x-auth-token'] === cfg.authToken;
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/health') {
      return json(res, 200, {
        status: 'ok',
        uptimeSec: Math.round(process.uptime()),
        clients: wss.clients.size,
        stats,
        streams: [...streams.values()].map((s) => ({
          key: s.key,
          ready: s.ready,
          subscribers: s.subs.size,
          lastUpdateAgoSec: s.lastUpdateAt ? Math.round((Date.now() - s.lastUpdateAt) / 1000) : null,
        })),
      });
    }

    // 调试用：curl "http://127.0.0.1:4000/bars?symbol=QQQ&resolution=3&count=20"
    if (url.pathname === '/bars') {
      if (!authOk(req, url)) return json(res, 401, { error: 'unauthorized' });
      const sym = parseSymbol(url.searchParams.get('symbol'));
      const resolution = url.searchParams.get('resolution') || '3';
      const count = Math.min(Number(url.searchParams.get('count') || 100), cfg.historyBars);
      if (!sym) return json(res, 400, { error: 'invalid symbol' });
      if (!SUPPORTED_RESOLUTIONS.has(resolution)) return json(res, 400, { error: 'unsupported resolution' });
      const stream = getStream(sym.full, resolution);
      if (!stream) return json(res, 503, { error: 'too many streams' });
      const placeholder = {}; // 占位订阅，防止流在等待期间被空闲关闭
      stream.subs.set(placeholder, count);
      clearTimeout(stream.idleTimer);
      stream.idleTimer = null;
      const ok = await waitReady(stream, cfg.loadTimeoutMs);
      const bars = ok ? stream.currentBars(count) : [];
      stream.unsubscribe(placeholder);
      if (!ok) return json(res, 504, { error: 'timeout waiting for TradingView' });
      log('info', 'http /bars', { symbol: sym.full, count: bars.length });
      return json(res, 200, { symbol: sym.full, resolution, count: bars.length, bars });
    }

    return json(res, 404, { error: 'not found' });
  } catch (e) {
    log('error', 'http handler failed', { err: errStr(e) });
    return json(res, 500, { error: 'internal error' });
  }
});

// ---------------------------------------------------------------- WebSocket
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const ip = clientIp(req);

  if (!authOk(req, url)) {
    log('warn', 'ws rejected: bad token', { ip });
    ws.close(4401, 'unauthorized');
    return;
  }

  ws.isAlive = true;
  ws.mySubs = new Set(); // stream keys
  log('info', 'ws client connected', { ip, clients: wss.clients.size });

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (_) {
      return send(ws, { type: 'error', code: 'bad_json', message: 'Invalid JSON' });
    }

    if (msg.action === 'ping') return send(ws, { type: 'pong', serverTime: Date.now() });

    if (msg.action === 'subscribe' || msg.action === 'unsubscribe') {
      const sym = parseSymbol(msg.symbol);
      const resolution = String(msg.resolution || '3');
      if (!sym) return send(ws, { type: 'error', code: 'bad_symbol', message: `Invalid symbol: ${msg.symbol}` });
      if (!SUPPORTED_RESOLUTIONS.has(resolution)) {
        return send(ws, {
          type: 'error',
          code: 'bad_resolution',
          message: `Unsupported resolution ${resolution}. Supported: ${[...SUPPORTED_RESOLUTIONS].join(',')}`,
        });
      }
      const key = `${sym.full}|${resolution}`;

      if (msg.action === 'unsubscribe') {
        const s = streams.get(key);
        if (s) s.unsubscribe(ws);
        ws.mySubs.delete(key);
        log('info', 'unsubscribe', { ip, key });
        return send(ws, { type: 'unsubscribed', symbol: sym.full, resolution });
      }

      const count = Math.min(Math.max(Number(msg.count) || 500, 1), cfg.historyBars);
      const stream = getStream(sym.full, resolution);
      if (!stream) {
        return send(ws, { type: 'error', code: 'too_many_streams', message: 'Server stream limit reached' });
      }
      ws.mySubs.add(key);
      log('info', 'subscribe', { ip, key, count });
      send(ws, { type: 'subscribed', symbol: sym.full, resolution, count });
      stream.subscribe(ws, count);
      return undefined;
    }

    return send(ws, { type: 'error', code: 'bad_action', message: `Unknown action: ${msg.action}` });
  });

  ws.on('close', () => {
    for (const key of ws.mySubs) {
      const s = streams.get(key);
      if (s) s.unsubscribe(ws);
    }
    log('info', 'ws client closed', { ip, clients: wss.clients.size });
  });

  ws.on('error', (e) => log('warn', 'ws client error', { ip, err: errStr(e) }));
});

// 客户端心跳：30 秒 ping，没回应就断开
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      log('warn', 'ws client heartbeat timeout, terminating');
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

// 每分钟一条状态日志
setInterval(() => {
  log('info', 'stats', {
    clients: wss.clients.size,
    streams: [...streams.values()].map((s) => ({
      key: s.key,
      ready: s.ready,
      subs: s.subs.size,
      lastUpdateAgoSec: s.lastUpdateAt ? Math.round((Date.now() - s.lastUpdateAt) / 1000) : null,
    })),
    ...stats,
  });
}, 60000);

// ---------------------------------------------------------------- lifecycle
server.listen(cfg.port, cfg.host, () => {
  log('info', 'server listening', {
    url: `ws://${cfg.host}:${cfg.port}/ws`,
    defaultExchange: cfg.defaultExchange,
    historyBars: cfg.historyBars,
    auth: cfg.authToken ? 'enabled' : 'disabled',
    tvLogin: cfg.tvSession ? 'cookie' : 'anonymous',
    node: process.version,
    envFile: path.join(__dirname, '.env'),
  });
});

function shutdown(sig) {
  log('info', `received ${sig}, shutting down`);
  for (const s of streams.values()) s.destroy();
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (e) => log('error', 'unhandledRejection', { err: errStr(e) }));
process.on('uncaughtException', (e) => log('error', 'uncaughtException', { err: errStr(e) }));
