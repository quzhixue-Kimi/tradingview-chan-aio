import type { OHLCV } from '../../../core/model/ohlcv';
import type { BarRange, SymbolInfo } from '../../../core/ports/MarketDataFeed';
import type { DataProvider, ProviderInfo, SymbolDescriptor } from '../../../core/ports/DataProvider';
import type { Unsubscribe } from '../../../core/util/types';
import { RequestGate } from '../RequestGate';

const REST = 'https://api.twelvedata.com';
const REST_CONCURRENCY = 4;
const REST_MIN_INTERVAL_MS = 8000;
const REQUEST_MAX_RETRIES = 4;
const BACKOFF_BASE_MS = 600;
const BACKOFF_JITTER_MS = 400;

function retryAfterMs(res: Response, fallbackMs: number): number {
    const sec = Number(res.headers.get('retry-after'));
    return Number.isFinite(sec) && sec > 0 ? sec * 1000 : fallbackMs;
}

/**
 * Self-hosted tv-ws-server (TradingView-API bridge) endpoints.
 * All timeframes are served from here via WebSocket (history + live).
 *
 * NOTE: history is fetched over the WebSocket (subscribe → `history`),
 * not the REST endpoint — browsers block the REST call with CORS when the
 * chart is served from another origin, while WebSocket is exempt from CORS.
 */
const TV_WS_SOCKET = 'wss://tvws.kq2022.eu.org/tv/ws';
/** History wait budget. */
const TV_WS_HISTORY_TIMEOUT_MS = 30_000;

/**
 * Bar count per timeframe group.
 * Short-interval charts (≤30m) load 1000 bars; longer intervals load 800.
 */
const TV_WS_COUNT: Record<string, number> = {
    '1': 1000, '3': 1000, '5': 1000, '15': 1000, '30': 1000,
    '60': 800, '120': 800, '240': 800, D: 800,
};

/** Canonical timeframe → bar duration in ms (used for live bar bucketing). */
const TF_TO_MS: Record<string, number> = {
    '1': 60e3,
    '3': 180e3,
    '5': 300e3,
    '15': 900e3,
    '30': 1800e3,
    '60': 3600e3,
    '120': 7200e3,
    '240': 14400e3,
    D: 86400e3,
};

/** User-facing timeframe aliases → canonical keys (matches the other Vela layers). */
const TF_NORMALIZE: Record<string, string> = {
    '1m': '1', '3m': '3', '5m': '5', '15m': '15', '30m': '30',
    '1h': '60', '2h': '120', '4h': '240',
    '1d': 'D', '1D': 'D', '4H': '240',
    D: 'D',
};

const SUPPORTED_TIMEFRAMES = Object.keys(TF_TO_MS);

/**
 * Majors always indexed first so a failed/empty catalog still resolves the playground
 * symbols (AAPL, QQQ, …). An empty settled index would park every bare ticker forever.
 */
const FALLBACK_SYMBOLS: readonly SymbolDescriptor[] = [
    { ticker: 'AAPL', description: 'Apple Inc', type: 'stock', prefix: 'NASDAQ' },
    { ticker: 'MSFT', description: 'Microsoft Corporation', type: 'stock', prefix: 'NASDAQ' },
    { ticker: 'GOOGL', description: 'Alphabet Inc', type: 'stock', prefix: 'NASDAQ' },
    { ticker: 'AMZN', description: 'Amazon.com Inc', type: 'stock', prefix: 'NASDAQ' },
    { ticker: 'NVDA', description: 'NVIDIA Corporation', type: 'stock', prefix: 'NASDAQ' },
    { ticker: 'TSLA', description: 'Tesla Inc', type: 'stock', prefix: 'NASDAQ' },
    { ticker: 'META', description: 'Meta Platforms Inc', type: 'stock', prefix: 'NASDAQ' },
    { ticker: 'QQQ', description: 'Invesco QQQ Trust', type: 'etf', prefix: 'NASDAQ' },
    { ticker: 'SPY', description: 'SPDR S&P 500 ETF Trust', type: 'etf', prefix: 'AMEX' },
    { ticker: 'SOXL', description: 'Direxion Daily Semiconductor Bull 3X Shares', type: 'etf', prefix: 'AMEX' },
    { ticker: 'YINN', description: 'Direxion Daily FTSE China Bull 3X Shares', type: 'etf', prefix: 'AMEX' },
    { ticker: 'IWM', description: 'iShares Russell 2000 ETF', type: 'etf', prefix: 'NYSE' },
    { ticker: 'DIA', description: 'SPDR Dow Jones Industrial Average ETF', type: 'etf', prefix: 'NYSE' },
];

/** One row from `/stocks` or `/etfs`. */
interface CatalogRow {
    symbol?: string;
    name?: string;
    exchange?: string;
    type?: string;
}

interface CatalogResponse {
    status?: string;
    message?: string;
    data?: CatalogRow[];
}

/** One bar from the tv-ws-server `/tv/bars` REST endpoint or `bar` WS message. */
interface TvWsBar {
    time?: number;
    open?: number;
    high?: number;
    low?: number;
    close?: number;
    volume?: number | null;
}

/** Map one tv-ws-server bar to neutral OHLCV (`time` is already epoch ms). */
function tvWsBarToOHLCV(v: TvWsBar): OHLCV {
    return {
        time: Number(v.time),
        open: Number(v.open),
        high: Number(v.high),
        low: Number(v.low),
        close: Number(v.close),
        volume: v.volume != null ? Number(v.volume) : 0,
    };
}

/** Normalize a user timeframe to a canonical key. */
export function normalizeTf(tf: string): string {
    return TF_NORMALIZE[tf] ?? TF_NORMALIZE[tf.toLowerCase()] ?? tf;
}

/** Sort by open-time and drop duplicate open-times (incoming wins). */
export function dedupeSorted(bars: OHLCV[]): OHLCV[] {
    const byTime = new Map<number, OHLCV>();
    for (const b of bars) byTime.set(b.time, b);
    return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/** Map a catalog instrument class onto the picker's tab vocabulary. */
export function instrumentType(raw: string | undefined, fallback: 'stock' | 'etf'): string {
    const type = (raw ?? '').trim().toLowerCase();
    if (!type) return fallback;
    if (type === 'common stock' || type === 'preferred stock' || type === 'stock' || type === 'reit') return 'stock';
    if (type === 'etf' || type === 'exchange-traded note') return 'etf';
    return type;
}

/** Map one catalog row; skip entries without a ticker. */
function mapCatalogRow(row: CatalogRow, fallbackType: 'stock' | 'etf'): SymbolDescriptor | null {
    const ticker = row.symbol?.trim();
    if (!ticker) return null;
    const prefix = row.exchange?.trim().toUpperCase();
    return {
        ticker,
        description: row.name?.trim() || ticker,
        type: instrumentType(row.type, fallbackType),
        ...(prefix ? { prefix } : {}),
    };
}

function venueKey(symbol: SymbolDescriptor): string {
    return `${(symbol.prefix ?? '').toUpperCase()}:${symbol.ticker.toUpperCase()}`;
}

/** Keep the first occurrence so fallback entries retain priority. */
function mergeSymbols(...lists: readonly (readonly SymbolDescriptor[])[]): SymbolDescriptor[] {
    const seen = new Set<string>();
    const merged: SymbolDescriptor[] = [];
    for (const list of lists) {
        for (const symbol of list) {
            const key = venueKey(symbol);
            if (seen.has(key)) continue;
            seen.add(key);
            merged.push(symbol);
        }
    }
    return merged;
}

/**
 * Market-data provider backed by the self-hosted tv-ws-server
 * (TradingView-API bridge). Serves US stocks and ETFs via WebSocket
 * for all supported timeframes (history + live).
 *
 *   import { TwelveDataProvider } from 'vela/providers/twelvedata';
 *   chart.data.registerProvider('twelvedata', new TwelveDataProvider(tvWsToken));
 */
export class TwelveDataProvider implements DataProvider {
    /** Cached symbol enumeration (the two catalogs are large; fetch once). */
    private symbolsPromise: Promise<SymbolDescriptor[]> | null = null;
    private symbols: readonly SymbolDescriptor[] = FALLBACK_SYMBOLS;
    private readonly gate = new RequestGate(REST_CONCURRENCY, REST_MIN_INTERVAL_MS);

    constructor(
        private readonly apiKey: string,
        private readonly tvWsToken: string = '',
    ) {
        if (!tvWsToken) {
            console.warn(
                '[vela] TwelveDataProvider: tv-ws-server token is empty — bar requests will get 401. ' +
                'Set VITE_TD_WS_TOKEN in vela/.env.local BEFORE building (vite inlines it at build time).',
            );
        }
    }

    info(): ProviderInfo {
        return {
            name: 'twelvedata',
            displayName: 'Twelve Data',
            requiresApiKey: true,
            supportedTimeframes: SUPPORTED_TIMEFRAMES,
            capabilities: { enumerate: true, stream: true, symbolInfo: true },
        };
    }

    listSymbols(): Promise<SymbolDescriptor[]> {
        if (!this.symbolsPromise) {
            this.symbolsPromise = this.fetchCatalogs()
                .then((listed) => {
                    this.symbols = mergeSymbols(FALLBACK_SYMBOLS, listed);
                    return [...this.symbols];
                })
                .catch(() => [...this.symbols]);
        }
        return this.symbolsPromise;
    }

    getBars(ticker: string, timeframe: string, range: BarRange): Promise<OHLCV[]> {
        const tf = normalizeTf(timeframe);
        if (!TF_TO_MS[tf]) {
            console.warn(`[vela] tv-ws-server: timeframe "${timeframe}" is not supported.`);
            return Promise.resolve([]);
        }
        return this.getTvWsBars(ticker, tf, range);
    }

    async getSymbolInfo(ticker: string): Promise<SymbolInfo | undefined> {
        const listed = this.symbolsPromise ? await this.symbolsPromise.catch(() => FALLBACK_SYMBOLS) : undefined;
        const d = listed?.find((s) => s.ticker.toUpperCase() === ticker.trim().toUpperCase());
        const prefix = d?.prefix ?? 'TWELVEDATA';
        return {
            ticker,
            tickerid: `${prefix}:${ticker}`,
            prefix,
            description: d?.description ?? ticker,
            type: d?.type ?? 'stock',
            currency: 'USD',
            mintick: 0.01,
            pricescale: 100,
            timezone: 'America/New_York',
            session: '0930-1600',
        };
    }

    private tvSymbol(ticker: string): string {
        const value = ticker.trim();
        if (value.includes(':')) return value;
        const descriptor = this.symbols.find((item) => item.ticker.toUpperCase() === value.toUpperCase());
        return `${descriptor?.prefix ?? 'NASDAQ'}:${value.toUpperCase()}`;
    }

    subscribe(ticker: string, timeframe: string, onBar: (b: OHLCV) => void): Unsubscribe {
        const tf = normalizeTf(timeframe);
        if (!TF_TO_MS[tf]) return () => {};
        return this.subscribeTvWs(this.tvSymbol(ticker), tf, onBar);
    }

    // ── tv-ws-server (all timeframes) ────────────────────────────────────────

    /** History from the self-hosted tv-ws-server (subscribe → `history` over WebSocket). */
    private getTvWsBars(ticker: string, tf: string, range: BarRange): Promise<OHLCV[]> {
        const defaultCount = TV_WS_COUNT[tf] ?? 800;
        const count = Math.min(Math.max(range.limit && range.limit !== 500 ? range.limit : defaultCount, 1), 1000);
        const symbol = this.tvSymbol(ticker);
        if (typeof WebSocket === 'undefined') return Promise.resolve([]);
        return new Promise<OHLCV[]>((resolve) => {
            let done = false;
            let ws: WebSocket | null = null;
            const finish = (bars: OHLCV[]): void => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                if (ws) {
                    try {
                        ws.close();
                    } catch {
                        // already closing — nothing to do
                    }
                    ws = null;
                }
                resolve(bars);
            };
            const timer = setTimeout(() => {
                console.warn(`[vela] tv-ws-server: history timeout for ${symbol} ${tf}`);
                finish([]);
            }, TV_WS_HISTORY_TIMEOUT_MS);
            try {
                ws = new WebSocket(`${TV_WS_SOCKET}?token=${this.tvWsToken}`);
            } catch (e) {
                console.warn(`[vela] tv-ws-server: failed to connect for ${symbol} ${tf} — ${e instanceof Error ? e.message : String(e)}`);
                finish([]);
                return;
            }
            ws.onopen = () => {
                ws!.send(JSON.stringify({ action: 'subscribe', symbol, resolution: tf, count }));
            };
            ws.onmessage = (ev) => {
                let m: { type?: string; bars?: TvWsBar[]; code?: string; message?: string };
                try {
                    m = JSON.parse(String(ev.data)) as typeof m;
                } catch {
                    return;
                }
                if (m.type === 'history' && Array.isArray(m.bars)) {
                    finish(dedupeSorted(m.bars.map(tvWsBarToOHLCV).filter((b) => b.time > 0)));
                } else if (m.type === 'error') {
                    console.warn(`[vela] tv-ws-server: ${String(m.message ?? m.code ?? 'error')} (${symbol} ${tf})`);
                    finish([]);
                }
                // 'subscribed' / 'pong' / 'status' / 'bar' need no action here
            };
            ws.onerror = () => finish([]);
            ws.onclose = () => finish([]);
        });
    }

    /**
     * Live bars from the tv-ws-server WebSocket.
     *
     * Protocol:
     *   -> {"action":"subscribe","symbol":"NASDAQ:QQQ","resolution":"3","count":500}
     *   <- {"type":"history","bars":[...]}   // seeds the forming bar
     *   <- {"type":"bar","bar":{...}}        // latest bar; same time overwrites
     *   -> {"action":"ping"} / <- {"type":"pong"}
     */
    private subscribeTvWs(ticker: string, tf: string, onBar: (b: OHLCV) => void): Unsubscribe {
        if (typeof WebSocket === 'undefined') return () => {};
        const symbol = ticker;
        const count = TV_WS_COUNT[tf] ?? 800;
        let closed = false;
        let ws: WebSocket | null = null;
        let hb: ReturnType<typeof setInterval> | undefined;
        let cur: OHLCV | null = null;

        const open = (): void => {
            if (closed) return;
            ws = new WebSocket(`${TV_WS_SOCKET}?token=${this.tvWsToken}`);
            ws.onopen = () => {
                ws!.send(JSON.stringify({ action: 'subscribe', symbol, resolution: tf, count }));
                hb = setInterval(() => {
                    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ action: 'ping' }));
                }, 20_000);
            };
            ws.onmessage = (ev) => {
                let m: { type?: string; bars?: TvWsBar[]; bar?: TvWsBar; code?: string; message?: string };
                try {
                    m = JSON.parse(String(ev.data)) as typeof m;
                } catch {
                    return;
                }
                if (m.type === 'history' && Array.isArray(m.bars)) {
                    const bars = m.bars.map(tvWsBarToOHLCV).filter((b) => b.time > 0);
                    if (bars.length > 0) cur = bars[bars.length - 1]!;
                } else if (m.type === 'bar' && m.bar) {
                    const b = tvWsBarToOHLCV(m.bar);
                    if (!(b.time > 0)) return;
                    if (cur && b.time < cur.time) return; // stale — ignore
                    cur = b; // same time overwrites (forming bar), newer time starts a bar
                    onBar({ ...cur });
                } else if (m.type === 'error') {
                    console.warn(`[vela] tv-ws-server: ${String(m.message ?? m.code ?? 'error')}`);
                }
                // 'subscribed' / 'pong' / 'status' need no action
            };
            ws.onclose = () => {
                if (hb != null) clearInterval(hb);
                hb = undefined;
                if (!closed) setTimeout(open, 2000);
            };
        };
        open();
        return () => {
            closed = true;
            if (hb != null) clearInterval(hb);
            if (ws) {
                try {
                    ws.send(JSON.stringify({ action: 'unsubscribe', symbol, resolution: tf }));
                } catch {
                    // socket already closing — nothing to do
                }
                ws.close();
            }
        };
    }

    // ── Twelve Data symbol catalogs ──────────────────────────────────────

    private async fetchCatalogs(): Promise<SymbolDescriptor[]> {
        const [stocks, etfs] = await Promise.all([
            this.fetchCatalog('stocks', 'stock'),
            this.fetchCatalog('etfs', 'etf'),
        ]);
        return mergeSymbols(stocks, etfs);
    }

    private async fetchCatalog(path: 'stocks' | 'etfs', fallbackType: 'stock' | 'etf'): Promise<SymbolDescriptor[]> {
        const url = new URL(`${REST}/${path}`);
        url.searchParams.set('country', 'US');
        url.searchParams.set('apikey', this.apiKey);
        const response = await this.json(url);
        if (response.status === 'error' || !Array.isArray(response.data)) return [];
        return response.data.map((row) => mapCatalogRow(row, fallbackType)).filter((row): row is SymbolDescriptor => row !== null);
    }

    private async json(url: URL): Promise<CatalogResponse> {
        const response = await this.request(url);
        return await response.json() as CatalogResponse;
    }

    private async request(url: URL): Promise<Response> {
        for (let attempt = 0; ; attempt += 1) {
            const response = await this.gate.run(() => fetch(url));
            if (response.status === 429 && attempt < REQUEST_MAX_RETRIES) {
                const backoff = BACKOFF_BASE_MS * 2 ** attempt + Math.random() * BACKOFF_JITTER_MS;
                this.gate.pauseFor(Math.max(retryAfterMs(response, 0), backoff));
                continue;
            }
            if (!response.ok) throw new Error(`Twelve Data HTTP ${response.status} for ${String(url)}`);
            return response;
        }
    }

}
