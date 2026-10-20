'use strict';
/**
 * 用法:
 *   node test-client.js [symbol] [count] [url]
 *   node test-client.js QQQ 20 ws://127.0.0.1:4000/ws
 * 带 token: url 里加 ?token=xxx
 */
const WebSocket = require('ws');

const symbol = process.argv[2] || 'QQQ';
const count = Number(process.argv[3] || 20);
const url = process.argv[4] || 'ws://127.0.0.1:4000/ws';

const ws = new WebSocket(url);

ws.on('open', () => {
  console.log(new Date().toISOString(), 'connected', url);
  ws.send(JSON.stringify({ action: 'subscribe', symbol, resolution: '3', count }));
});

ws.on('message', (raw) => {
  const now = new Date().toISOString();
  const m = JSON.parse(raw.toString());

  if (m.type === 'history') {
    const first = m.bars[0];
    const last = m.bars[m.bars.length - 1];
    console.log(now, `HISTORY ${m.symbol} ${m.resolution}m bars=${m.count}`);
    if (first) console.log('   first:', first.timeNY, '| UTC', first.timeUtc);
    if (last) console.log('   last :', last.timeNY, '| UTC', last.timeUtc, 'close', last.close, 'vol', last.volume);
    return;
  }
  if (m.type === 'bar') {
    const b = m.bar;
    console.log(now, `BAR  NY ${b.timeNY}  O${b.open} H${b.high} L${b.low} C${b.close} V${b.volume}`);
    return;
  }
  console.log(now, m.type.toUpperCase(), JSON.stringify(m));
});

ws.on('close', (code, reason) => console.log(new Date().toISOString(), 'closed', code, reason.toString()));
ws.on('error', (e) => console.error('error', e.message));

setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ action: 'ping' })), 20000);
