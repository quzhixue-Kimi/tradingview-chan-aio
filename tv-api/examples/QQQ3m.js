const TradingView = require('../main');

const client = new TradingView.Client(); // 行情不登录也能取,但可能是延迟数据

const chart = new client.Session.Chart();
chart.setMarket('NASDAQ:QQQ', {
  timeframe: '3',
  range: 50, // 最近 50 根
});

chart.onError((...err) => console.error('Chart error:', ...err));

chart.onSymbolLoaded(() => {
  console.log(`Loaded: ${chart.infos.description} (${chart.infos.exchange})`);
});

chart.onUpdate(() => {
  const p = chart.periods[0];
  if (!p) return;
  console.log(new Date().toISOString(), new Date(p.time * 1000).toISOString(), p.close, p.volume);
});

setTimeout(() => {
  console.log('Total candles:', chart.periods.length);
  client.end();
}, 15000);
