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
    timeframe: '3',
    live: true,
    theme: 'dark',
    autofocus: true, // the chart IS the page — shortcuts work from the first keystroke
    persist: 'vela-widget', // → 'vela-play:vela-widget' in devtools (the page's historical key)
    storage,
    providers: { twelvedata: () => new TwelveDataProvider(import.meta.env.VITE_TD_KEY || "YOUR_API_KEY_HERE", import.meta.env.VITE_TD_WS_TOKEN || "") },
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
    timeframes: ['1', '3', '5', '15', '30', '60', '240', 'D', 'W', 'M'], // topbar timeframe presets ('3' = 3m via tv-ws-server)
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

/**
 * 自定义 Pine 指标清单（服务端动态配置，免编译）：
 *   /var/www/vela/indicators/manifest.json
 *   { "indicators": ["bytz-nine.pine", "smo.pine"] }
 * 也支持对象写法做临时禁用：{ "file": "smo.pine", "enabled": false }
 *
 * 加新指标：把 .pine 文件丢进服务器的 indicators/ 目录，
 * 在 manifest.json 里加一行文件名，刷新页面即生效，无需重新 build。
 * overlay 与否由各脚本自己的 indicator() 声明决定（bytz-nine 主图叠加，
 * smo 独立副图），core 会自动路由到正确的 pane，互不干扰。
 *
 * 注意：deploy 打包时排除了 indicators/ 且不再清空该目录，
 * 服务端的 manifest.json 与 .pine 文件由手工管理，部署不会覆盖。
 * 本地 vela/playground/public/indicators/ 只用于本机 playground 调试。
 */
const INDICATORS_MANIFEST_URL = `${import.meta.env.BASE_URL}indicators/manifest.json`;
/** manifest.json 缺失或损坏时的兜底清单 */
const FALLBACK_INDICATORS = ['bytz-nine.pine', 'smo.pine'];

type ManifestEntry = string | { file: string; enabled?: boolean };

/** 读服务端清单；返回 null 表示清单不可用（调用方用兜底清单） */
async function loadManifest(): Promise<string[] | null> {
  try {
    const response = await fetch(INDICATORS_MANIFEST_URL, { cache: 'no-store' });
    if (!response.ok) return null;
    const manifest = (await response.json()) as { indicators?: ManifestEntry[] };
    if (!Array.isArray(manifest?.indicators)) {
      console.warn('[vela-dev] manifest.json 格式错误，缺少 indicators 数组');
      return null;
    }
    return manifest.indicators
      .map((e) => (typeof e === 'string' ? { file: e, enabled: true } : e))
      .filter((e) => e.enabled !== false && typeof e.file === 'string' && e.file.length > 0)
      .map((e) => (e as { file: string }).file);
  } catch (error) {
    console.warn('[vela-dev] 指标清单加载失败:', error);
    return null;
  }
}

async function loadPineIndicator(file: string): Promise<void> {
  const response = await fetch(`${import.meta.env.BASE_URL}indicators/${file}`, {
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(`加载 Pine Script 失败：${file} HTTP ${response.status}`);
  }

  const script = await response.text();

  // 有些脚本文件头带版权注释（如 AlgoAlpha 的 MPL 声明），只要求前 10 行内出现版本声明
  const head = script.split('\n').slice(0, 10).join('\n');
  if (!head.includes('//@version=')) {
    throw new Error(`返回内容不是 Pine Script：${file}，请检查静态文件路径`);
  }

  const handle = ws.chart.addIndicator(script, {
    language: 'pine',
  });

  handle.on('error', ({ error }) => {
    console.error('[vela-dev] Indicators failed:', file, error.message);
  });
}

void ws.chart.ready().then(async () => {
  const files = (await loadManifest()) ?? [...FALLBACK_INDICATORS];
  for (const file of files) {
    try {
      await loadPineIndicator(file);
    } catch (error) {
      // 单个指标失败不影响其他指标继续加载
      console.error('[vela-dev] 加载指标失败:', file, error);
    }
  }
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
