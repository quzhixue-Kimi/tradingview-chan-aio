// The bare playground page: a SINGLE-CHART workspace (topbar + chart, `layout: false`)
// with the Binance provider (public API, no key, no server needed), the page's own demo
// scripting engine, and an inline indicator manifest — the OSS integration surface
// exercised end to end.
//
// Vela SHIPS NO SCRIPTING ENGINE. `demo-engine.ts` (next to this file) is a ~300-line
// engine written against the public `ScriptingEngine` port purely so this page can
// exercise the indicator path with zero dependencies — it is the runnable companion to
// docs/contributing/adding-an-engine.md, not a product. For Pine Script, install the
// addon and swap one line:
//
//     npm i @luxalgo/vela-pinets pinets
//     import { PineWorkerEngine } from '@luxalgo/vela-pinets';
//     engines: { pine: () => new PineWorkerEngine() }
//
// …which is exactly what the addon's own playground does (repos/Vela-pinets, port 5192).
import { VelaWorkspace } from '../src/workspace';
import { PineWorkerEngine } from '@luxalgo/vela-pinets';
import { TwelveDataProvider } from '../src/data/providers/twelvedata';
import { addSampleMarks } from './marks';
import { DemoEngine, DEMO_SCRIPTS } from './demo-engine';
import { playgroundStorage } from './persistence';

// The playground's CUSTOM persistence (shared with the workspace page): with `persist`
// on, the shell saves and restores EVERYTHING through this adapter — prefs, renderer
// config, and user drawings. The key is pinned so this page never collides with the
// multi-chart page's own document ('vela-workspace') in the same adapter namespace.
const storage = playgroundStorage();

const ws = new VelaWorkspace('#chart', {
    layout: false, // SINGLE-CHART mode: one cell, no layout picker, no sync switches
    symbol: 'QQQ', // bare = first declared provider (twelvedata); 'twelvedata:AAPL' pins a venue
    timeframe: '5',
    live: true,
    theme: 'dark',
    autofocus: true, // the chart IS the page — shortcuts work from the first keystroke
    persist: 'vela-widget', // → 'vela-play:vela-widget' in devtools (the page's historical key)
    storage,
    providers: { twelvedata: () => new TwelveDataProvider(import.meta.env.VITE_TD_KEY || "YOUR_API_KEY_HERE") },
    engines: { demo: () => new DemoEngine(), pine: () => new PineWorkerEngine() }, // swap for `pine: () => new PineWorkerEngine()` (see the header)
    defaultLanguage: 'pine', // scripts added without a `language` run on the Pine engine
    // No script manifest: the indicators dialog lists the built-in catalog only. Scripts
    // reach the chart through the Code panel below (or an `indicators` manifest — see the
    // commented option further down).

    // ── The rest of the CHART options, at their defaults — uncomment to play ─────────
    // bars: 1000,                     // history depth to load (paints progressively: newest window first)
    // settings: { hidden: ['advanced'] }, // hide settings-dialog entries by id — a tab ('advanced'), a
    //                                 //  group ('canvas.grid'), or a row; ids via chart.renderer.listSettingsIds()
    // data: myBars,                   // offline OHLCV[] — replaces the provider entirely (no fetches, no live)
    // visibleRange: '3M',             // initial window: '1D'|'1W'|'1M'|'3M'|'6M'|'1Y'|'5Y'|'YTD'|'ALL' or {from,to} in ms (default: frame the tail)
    // priceStyle: 'candles',          // 'candles'|'bars'|'line'|'area'|'baseline'|'heikinashi' or a registered chart-type id
    // volume: true,                   // the built-in volume columns (native indicator); false opts out
    // logScale: false,                // logarithmic price scale
    // currentPriceLine: true,         // dashed line + axis chip at the latest price
    // upColor: '#089981',             // bullish candles (default: the palette's bullish green)
    // downColor: '#f23645',           // bearish candles (default: the palette's bearish red)
    // glow: 0,                        // neon glow on line series, 0..~0.6 — WebGL2 backend only
    // animations: { zoom: true, pan: true, liveBar: false }, // eased zoom + inertial pan + forming-bar glide (true = 90 ms, or a duration in ms); false disables all
    // nativeBackend: 'auto',          // 'auto' = WebGL2 when available, else canvas2d; or force either
    // renderer: NativeRenderer,       // a custom IChartRenderer class (default: the native renderer)
    // drawings: true,                 // user drawings — default: toolbar VISIBLE; false removes the whole
    //                                 //  surface (the chart.drawings API stays); {tools/groups, toolbar} customizes
    // alertCap: 50,                   // alerts the topbar bell keeps (oldest drop beyond it)

    // ── The rest of the SHELL options, at their defaults ──────────────────────────────
    // indicators: [{ name: 'My script', script: DEMO_SCRIPTS.ema, language: 'demo' }], // a script
    //                                 //  manifest: rows the dialog lists next to the built-in catalog
    // indicators: async () => (await fetch('/my/manifest.json')).json(), // the manifest can also
    //                                 //  be an ASYNC LOADER (filesystem, authenticated API, …)
    // timeframes: ['1', '5', '15', '30', '60', '240', 'D', 'W', 'M'], // topbar timeframe presets
    // timezone: 'Etc/UTC',            // display timezone (IANA), switchable from the bottom bar
    // statusline: true,               // chrome: the status line
    // watermark: true,                // chrome: the symbol watermark behind the candles
    // bottombar: true,                // chrome: the range-presets + timezone bar
    // topbar: {                       // COMPOSE the topbar: each side lists its VISIBLE
    //     left: ['symbol', 'timeframes', 'style', 'layout', 'indicators', 'actions', 'undo-redo'],
    //     right: ['actions', 'alerts', 'panels', 'screenshot'],
    // },
    //                                 // These values ARE the defaults (an undeclared side keeps
    //                                 //  them; 'layout' simply never renders on this single-chart
    //                                 //  page). Entries render in LIST ORDER; omitting an id also
    //                                 //  removes its mobile entry and keyboard chord (mod+alt+S
    //                                 //  with 'screenshot', `/` with 'indicators'). 'actions' is
    //                                 //  the flow slot for contributed actions — naming an
    //                                 //  action's ID instead pins it at that spot. An explicit
    //                                 //  list is the side's complete (and frozen) contract.
});

void ws.chart.ready().then(() => console.log('[vela-dev] chart ready'));

// Sample timeline marks (chart.marks) — see marks.ts: a cluster, a fanning stack, a custom
// icon with details loaded on click… spread over the visible range once the chart painted.
void ws.chart.ready().then(() => addSampleMarks(ws.chart));

// The page shell follows the app theme — flip it from chart settings → Canvas → Theme
// (or `ws.setTheme('light')` in the console) and the body around the chart follows.
ws.chart.on('theme:changed', (t) => {
    document.body.style.background = t.background;
});

// Handy for poking around from the browser console.
(window as unknown as { ws: VelaWorkspace }).ws = ws;

// ── State surface demo (uncomment to try) ─────────────────────────────────────
// Single-chart mode speaks the SAME state triplet and document format as the grid —
// it is the single-cell case (layout '1', one `c1` cell). `persist` above writes
// exactly this document; the calls below are how a host composes custom flows
// (server snapshots, share links, templates) on top of it.
//
// // READ — one versioned document: market, prefs, renderer config, user drawings,
// // and the indicator ledger. JSON-safe: `JSON.stringify(snapshot)` is the payload.
// const snapshot = ws.getState();
// console.log('[state] document:', snapshot);
//
// // EVENT — fires debounced (~500ms) after ANY persistable change (draw a line,
// // switch the symbol, add an indicator…). Re-pull getState() for the fresh doc.
// // Returns an unsubscribe function.
// const offState = ws.on('state:changed', () => {
//     console.log('[state] changed →', ws.getState().charts[0]);
// });
//
// // WRITE — a same-shape document applies IN PLACE: the chart instance survives
// // (the market switches via setMarket), config/drawings/indicators are replaced.
// // Untrusted-safe: malformed fields are dropped by the shared codec, never thrown on.
// setTimeout(() => {
//     const doc = ws.getState();
//     doc.charts[0]!.symbol = 'SOLUSDT'; // retarget the chart…
//     doc.charts[0]!.drawings = { version: 1, drawings: [] }; // …and wipe its drawings
//     ws.applyState(doc);
//     offState();
// }, 5000);


// ── "Code" topbar entry — paste a script, Run it, injected on success (SDK showcase:
// contributed action + kit Dialog + chart.runIndicator; errors surface inline). ──
import { registerWidgetAction, registerIcon, type WidgetContext } from '../src/plugin';
import { Dialog } from '../src/ui';

registerIcon('code', '<svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="m5.5 4.5-4 3.5 4 3.5M10.5 4.5l4 3.5-4 3.5"/></svg>');

// Lazy UI singletons — DOM state only (the edited script survives reopen). The
// WidgetContext is NEVER stored: `run(ctx)` rebinds the Run button's handler on every
// invocation, so the ctx lives in that closure alone and always belongs to the
// invoking shell (the pattern that keeps working in a multi-chart grid).
let codeDialog: Dialog | null = null;
let codeArea: HTMLTextAreaElement | null = null;
let codeStatus: HTMLElement | null = null;
let codeRun: HTMLButtonElement | null = null;

registerWidgetAction({
    id: 'dev.code',
    target: 'topbar',
    label: 'Code',
    icon: 'code',
    run: (ctx) => {
        if (!codeDialog) {
            codeArea = document.createElement('textarea');
            codeArea.value = `//@version=6
indicator("RSI Strategy")

rsi = ta.rsi(close, 14)
sma = ta.sma(rsi, 10)

plot(rsi, "RSI")
plot(sma, "Signal")`;

            codeArea.spellcheck = false;
            codeArea.style.cssText =
                'width:520px;max-width:80vw;height:220px;resize:vertical;background:var(--vela-surface-overlay);color:var(--vela-fg);border:1px solid var(--vela-border-soft);border-radius:var(--vela-radius-md);padding:10px;font:12px/1.5 ui-monospace,Consolas,monospace;outline:none;';
            codeRun = document.createElement('button');
            codeRun.textContent = 'Run';
            codeRun.style.cssText =
                'all:unset;margin-top:8px;padding:6px 18px;border-radius:var(--vela-radius-sm);background:var(--vela-accent);color:#0b0e14;font-weight:600;cursor:pointer;';
            codeStatus = document.createElement('div');
            codeStatus.style.cssText = 'margin-top:8px;min-height:1.3em;font-size:var(--vela-font-size-md);white-space:pre-wrap;';
            codeDialog = new Dialog({
                title: 'Run an indicator',
                host: ctx.host, // first invoker's root hosts the singleton (fine for the one-chart demo)
                closeOnInteractOutside: true,
                content: (body) => body.append(codeArea!, codeRun!, codeStatus!),
            });
        }
        // Rebind per invocation — `ctx` stays in this closure, no module-level context.
        codeRun!.onclick = () => void runCode(ctx);
        codeStatus!.textContent = '';
        codeDialog.show();
        setTimeout(() => codeArea?.focus(), 0);
    },
});

async function runCode(ctx: WidgetContext): Promise<void> {
    if (!codeArea || !codeStatus) return;
    codeStatus.style.color = 'var(--vela-fg-muted)';
    codeStatus.textContent = 'Running…';
    const r = await ctx.chart.runIndicator(codeArea.value);
    if (r.ok) {
        codeStatus.style.color = 'var(--vela-accent)';
        codeStatus.textContent = `✓ ${r.handle!.title || 'Indicator'} added to the chart`;
    } else {
        codeStatus.style.color = 'var(--vela-danger)';
        codeStatus.textContent = `✗ ${r.error!.message}`;
    }
}

ws.refreshActions();

// ── EMA 20 demo — a Pine script on the page's OWN chart (the `pine` engine is
// already registered above, so no second chart and no extra registration).
void ws.chart.ready().then(() => {
    const handle = ws.chart.addIndicator(
        `
        //@version=6
indicator(title="BYTZ+NINE", shorttitle="NX+NINE", overlay=true, max_boxes_count=500)

// 1. 蓝色通道 (短期/快通道)
len_blue_high = input.int(24, title="蓝通道高价EMA长度", minval=1, group="通道设置")
len_blue_low = input.int(23, title="蓝通道低价EMA长度", minval=1, group="通道设置")
// 黄色通道 (长期/慢通道)
len_yellow_high = input.int(89, title="黄通道高价EMA长度", minval=1, group="通道设置")
len_yellow_low = input.int(90, title="黄通道低价EMA长度", minval=1, group="通道设置")

// ----------- 2. 指标计算 (使用 EMA of High/Low) -----------
A_blue = ta.ema(high, len_blue_high)
B_blue = ta.ema(low, len_blue_low)
A_yellow = ta.ema(high, len_yellow_high)
B_yellow = ta.ema(low, len_yellow_low)

// ----------- 3. 图表绘制与区域填充 -----------
// 3.1 绘制和填充蓝色通道
p_blue_up = plot(A_blue, color=color.new(color.blue, 0), title="蓝通道上沿")
p_blue_down = plot(B_blue, color=color.new(color.blue, 0), title="蓝通道下沿")
fill(p_blue_up, p_blue_down, color=(close > A_blue or close < B_blue) ? color.new(color.blue, 70) : color.new(color.blue, 100), title="蓝色通道填充")

// 3.2 绘制和填充黄色通道
p_yellow_up = plot(A_yellow, color=color.new(color.yellow, 0), title="黄通道上沿")
p_yellow_down = plot(B_yellow, color=color.new(color.yellow, 0), title="黄通道下沿")
fill(p_yellow_up, p_yellow_down, color=(close > A_yellow or close < B_yellow) ? color.new(color.yellow, 70) : color.new(color.yellow, 100), title="黄色通道填充")

show_td = input.bool(true, title="显示神奇九转", group="神奇九转设置")
var int td_up = 0 // 上升计数
var int td_dn = 0 // 下降计数
if close > close[4]
    td_up := td_up + 1
    td_dn := 0
else
    if close < close[4]
        td_dn := td_dn + 1
        td_up := 0
    else
        td_up := 0
        td_dn := 0

// 1. 处理上涨结构 (高位九转 - 1-8 紫色,9 绿色)
if show_td and td_up == 9
    for i = 0 to 8
        num = 9 - i
        textcolor_up = num == 9 ? color.green : color.new(#FF00FF, 0)
        label.new(bar_index - i, na,
             text=str.tostring(num),
             color=color(na),
             textcolor=textcolor_up,
             style=label.style_none,
             yloc=yloc.abovebar)
// 1.1 处理上涨结构的当前bar部分计数 (5-8,全部紫色)
if show_td and barstate.islast and td_up >= 5 and td_up < 9
    for i = 0 to td_up - 1
        num = td_up - i
        textcolor_up_partial = color.new(#FF00FF, 0)
        label.new(bar_index - i, na,
             text=str.tostring(num),
             color=color(na),
             textcolor=textcolor_up_partial,
             style=label.style_none,
             yloc=yloc.abovebar)
// 2. 处理下跌结构 (低位九转 - 1-8 绿色,9 紫色)
if show_td and td_dn == 9
    for i = 0 to 8
        num = 9 - i
        textcolor_dn = num == 9 ? color.new(#FF00FF, 0) : color.green
        label.new(bar_index - i, na,
             text=str.tostring(num),
             color=color(na),
             textcolor=textcolor_dn,
             style=label.style_none,
             yloc=yloc.belowbar)
// 2.1 处理下跌结构的当前bar部分计数 (5-8,全部绿色)
if show_td and barstate.islast and td_dn >= 5 and td_dn < 9
    for i = 0 to td_dn - 1
        num = td_dn - i
        textcolor_dn_partial = color.green
        label.new(bar_index - i, na,
             text=str.tostring(num),
             color=color(na),
             textcolor=textcolor_dn_partial,
             style=label.style_none,
             yloc=yloc.belowbar)
        `,
        { language: 'pine' },
    );
    handle.on('error', ({ error }) => console.error('[vela-dev] Indicators failed:', error.message));
});

// ── Execution-context listener demo — how host code intercepts Vela's engine context.
// 'context:changed' fires after the initial run and (throttled ~1/s) on live candles;
// pull a read-only snapshot and inspect it. Subscriptions survive symbol/timeframe
// changes — the shell switches markets IN PLACE (setMarket), same chart instance.
void ws.chart.ready().then(() => {
    const chart = ws.chart;
    chart.on('context:changed', ({ id }) => {
        void (async () => {
            const handle = chart.indicators().find((h) => h.id === id);
            const snap = await handle?.context(['plots', 'barIndex']);
            if (!handle || !snap) return;
            const keys = Object.keys(snap.plots);
            const points = Object.values(snap.plots).reduce((n, p) => n + p.length, 0);
            console.log(
                `[vela-ctx] ${handle.title || id} — ${keys.length} plot(s) [${keys.join(', ')}], ` +
                    `${points} points, last bar #${snap.barIndex} (${snap.phase})`,
            );
        })();
    });
});
