import type { OHLCV } from '../../../core/model/ohlcv';
import type { BarRange, SymbolInfo } from '../../../core/ports/MarketDataFeed';
import type { DataProvider, ProviderInfo, SymbolDescriptor } from '../../../core/ports/DataProvider';
import type { Unsubscribe } from '../../../core/util/types';
import { RequestGate } from '../RequestGate';

const REST = 'https://api.twelvedata.com';
const WS = 'wss://ws.twelvedata.com/v1/quotes/price';

/** Public REST shaping: a small concurrency cap + min-spacing keeps the sustained rate under ~8/min. */
const REST_CONCURRENCY = 4;
const REST_MIN_INTERVAL_MS = 8000;

/** How many times a single request retries after a 429 before giving up. */
const REQUEST_MAX_RETRIES = 4;
/** Exponential-backoff base + jitter for a 429 retry when no Retry-After is given (ms). */
const BACKOFF_BASE_MS = 600;
const BACKOFF_JITTER_MS = 400;

/** A `Retry-After` header (seconds) as ms, falling back to `fallbackMs` when absent/invalid. */
function retryAfterMs(res: Response, fallbackMs: number): number {
    const sec = Number(res.headers.get('retry-after'));
    return Number.isFinite(sec) && sec > 0 ? sec * 1000 : fallbackMs;
}

/** Canonical timeframe → Twelve Data interval + bar duration. */
const TF_TO_INTERVAL: Record<string, { iv: string; ms: number }> = {
    '1': { iv: '1min', ms: 60e3 },
    '5': { iv: '5min', ms: 300e3 },
    '15': { iv: '15min', ms: 900e3 },
    '30': { iv: '30min', ms: 1800e3 },
    '45': { iv: '45min', ms: 2700e3 },
    '60': { iv: '1h', ms: 3600e3 },
    '120': { iv: '2h', ms: 7200e3 },
    '240': { iv: '4h', ms: 14400e3 },
    '480': { iv: '8h', ms: 28800e3 },
    D: { iv: '1day', ms: 86400e3 },
    W: { iv: '1week', ms: 604800e3 },
    M: { iv: '1month', ms: 2_592_000_000 },
};

/** User-facing timeframe aliases → canonical keys (matches the other Vela layers). */
const TF_NORMALIZE: Record<string, string> = {
    '1m': '1', '5m': '5', '15m': '15', '30m': '30', '45m': '45',
    '1h': '60', '2h': '120', '4h': '240', '8h': '480',
    '1d': 'D', '1w': 'W', '1mo': 'M', '1D': 'D', '1W': 'W', '4H': '240',
    D: 'D', W: 'W', M: 'M',
};

const SUPPORTED_TIMEFRAMES = Object.keys(TF_TO_INTERVAL);

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
    { ticker: 'SPY', description: 'SPDR S&P 500 ETF Trust', type: 'etf', prefix: 'NYSE' },
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

interface TimeSeriesRow {
    datetime?: string;
    open?: string | number;
    high?: string | number;
    low?: string | number;
    close?: string | number;
    volume?: string | number | null;
}

/** Normalize a user timeframe to a canonical key. */
export function normalizeTf(tf: string): string {
    return TF_NORMALIZE[tf] ?? TF_NORMALIZE[tf.toLowerCase()] ?? tf;
}

/**
 * Parse a Twelve Data `datetime` as UTC epoch ms. Callers must request `timezone=UTC`
 * so the string is not exchange-local (appending `Z` to a New York stamp would shift
 * every intraday bar by 4–5 hours).
 */
export function parseBarTime(datetime: string): number {
    const iso = datetime.includes('T') ? datetime : datetime.replace(' ', 'T');
    const stamped = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso) ? iso : `${iso}Z`;
    const t = Date.parse(stamped);
    return Number.isFinite(t) ? t : 0;
}

/** Map one time-series row to neutral OHLCV. */
export function rowToOHLCV(v: TimeSeriesRow): OHLCV {
    return {
        time: parseBarTime(String(v.datetime ?? '')),
        open: Number(v.open),
        high: Number(v.high),
        low: Number(v.low),
        close: Number(v.close),
        volume: v.volume != null ? Number(v.volume) : 0,
    };
}

/** Sort by open-time and drop duplicate open-times (incoming wins). */
export function dedupeSorted(bars: OHLCV[]): OHLCV[] {
    const byTime = new Map<number, OHLCV>();
    for (const b of bars) byTime.set(b.time, b);
    return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/** Map a catalog instrument class onto the picker's tab vocabulary. */
export function instrumentType(raw: string | undefined, fallback: 'stock' | 'etf'): string {
    const t = (raw ?? '').trim().toLowerCase();
    if (!t) return fallback;
    if (t === 'common stock' || t === 'preferred stock' || t === 'stock') return 'stock';
    if (t === 'etf' || t === 'exchange-traded note') return 'etf';
    if (t === 'reit') return 'stock';
    return t;
}

/** Map one catalog row; skip incomplete entries. */
export function mapCatalogRow(row: CatalogRow, fallbackType: 'stock' | 'etf'): SymbolDescriptor | null {
    const ticker = row.symbol?.trim();
    if (!ticker) return null;
    const prefix = row.exchange?.trim() ? row.exchange.trim().toUpperCase() : undefined;
    return {
        ticker,
        description: row.name?.trim() || ticker,
        type: instrumentType(row.type, fallbackType),
        ...(prefix ? { prefix } : {}),
    };
}

function venueKey(s: SymbolDescriptor): string {
    return `${(s.prefix ?? '').toUpperCase()}:${s.ticker.toUpperCase()}`;
}

/** First occurrence wins (fallback majors stay ahead of the full catalog). */
export function mergeSymbols(...lists: readonly (readonly SymbolDescriptor[])[]): SymbolDescriptor[] {
    const seen = new Set<string>();
    const out: SymbolDescriptor[] = [];
    for (const list of lists) {
        for (const s of list) {
            const key = venueKey(s);
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(s);
        }
    }
    return out;
}

/**
 * Twelve Data market-data provider. Serves US stocks and ETFs (listing prefix =
 * the exchange: `NASDAQ:AAPL`, `NASDAQ:QQQ`). Requires an API key.
 *
 *   import { TwelveDataProvider } from 'vela/providers/twelvedata';
 *   chart.data.registerProvider('twelvedata', new TwelveDataProvider(apiKey));
 */
export class TwelveDataProvider implements DataProvider {
    /** Cached symbol enumeration (the two catalogs are large; fetch once). */
    private symbolsPromise: Promise<SymbolDescriptor[]> | null = null;
    /** Shared request gate: caps concurrency, spaces request starts, honors 429 backoff. */
    private readonly gate = new RequestGate(REST_CONCURRENCY, REST_MIN_INTERVAL_MS);

    constructor(private readonly apiKey: string) {}

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
                .then((listed) => mergeSymbols(FALLBACK_SYMBOLS, listed))
                .catch(() => [...FALLBACK_SYMBOLS]);
        }
        return this.symbolsPromise;
    }

    async getBars(ticker: string, timeframe: string, range: BarRange): Promise<OHLCV[]> {
        const tf = TF_TO_INTERVAL[normalizeTf(timeframe)];
        if (!tf) {
            console.warn(`[vela] Twelve Data: timeframe "${timeframe}" is not supported.`);
            return [];
        }
        const u = new URL(`${REST}/time_series`);
        u.searchParams.set('symbol', ticker);
        u.searchParams.set('interval', tf.iv);
        u.searchParams.set('outputsize', String(Math.min(Math.max(range.limit ?? 500, 1), 1000)));
        // UTC so {@link parseBarTime} can stamp `Z` without shifting exchange-local clocks.
        u.searchParams.set('timezone', 'UTC');
        u.searchParams.set('order', 'asc');
        u.searchParams.set('apikey', this.apiKey);
        if (range.from != null) u.searchParams.set('start_date', fmt(range.from));
        if (range.to != null) u.searchParams.set('end_date', fmt(range.to));
        try {
            const j = await this.json(u);
            if (j.status === 'error' || !Array.isArray(j.values)) {
                if (j.status === 'error') {
                    console.warn(`[vela] Twelve Data: ${String(j.message ?? 'time_series error')} (${ticker} ${timeframe})`);
                }
                return [];
            }
            return dedupeSorted((j.values as TimeSeriesRow[]).map(rowToOHLCV).filter((b) => b.time > 0));
        } catch (e) {
            console.warn(`[vela] Twelve Data: failed to fetch ${ticker} ${timeframe} — ${e instanceof Error ? e.message : String(e)}`);
            return [];
        }
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

    subscribe(ticker: string, timeframe: string, onBar: (b: OHLCV) => void): Unsubscribe {
        const tf = TF_TO_INTERVAL[normalizeTf(timeframe)];
        if (!tf) return () => {};
        if (typeof WebSocket === 'undefined') return () => {};
        let closed = false;
        let ws: WebSocket | null = null;
        let hb: ReturnType<typeof setInterval> | undefined;
        let cur: OHLCV | null = null;
        // Ascending history — the forming candle is the LAST bar, not the first.
        void this.getBars(ticker, timeframe, { limit: 1 }).then((b) => {
            cur = b[b.length - 1] ?? null;
        });

        const open = (): void => {
            if (closed) return;
            ws = new WebSocket(`${WS}?apikey=${this.apiKey}`);
            ws.onopen = () => {
                ws!.send(JSON.stringify({ action: 'subscribe', params: { symbols: ticker } }));
                hb = setInterval(() => {
                    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ action: 'heartbeat' }));
                }, 10_000);
            };
            ws.onmessage = (ev) => {
                let m: { event?: string; timestamp?: number; price?: string | number };
                try {
                    m = JSON.parse(String(ev.data)) as typeof m;
                } catch {
                    return;
                }
                if (m.event !== 'price' || m.timestamp == null || m.price == null) return;
                const t = m.timestamp * 1000;
                const p = Number(m.price);
                if (!Number.isFinite(t) || !Number.isFinite(p)) return;
                const bucket = Math.floor(t / tf.ms) * tf.ms;
                if (!cur || bucket > cur.time) cur = { time: bucket, open: p, high: p, low: p, close: p, volume: 0 };
                else {
                    cur.high = Math.max(cur.high, p);
                    cur.low = Math.min(cur.low, p);
                    cur.close = p;
                }
                onBar({ ...cur });
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
            ws?.close();
        };
    }

    // ── internals ────────────────────────────────────────────────────────

    /** US stocks + US ETFs. Country-scoped so the index is searchable without a global dump. */
    private async fetchCatalogs(): Promise<SymbolDescriptor[]> {
        const [stocks, etfs] = await Promise.all([
            this.fetchCatalog('stocks', 'stock'),
            this.fetchCatalog('etfs', 'etf'),
        ]);
        return mergeSymbols(stocks, etfs);
    }

    private async fetchCatalog(path: 'stocks' | 'etfs', fallbackType: 'stock' | 'etf'): Promise<SymbolDescriptor[]> {
        const u = new URL(`${REST}/${path}`);
        u.searchParams.set('country', 'US');
        u.searchParams.set('apikey', this.apiKey);
        const j = await this.json(u);
        if (j.status === 'error' || !Array.isArray(j.data)) return [];
        const out: SymbolDescriptor[] = [];
        for (const row of j.data as CatalogRow[]) {
            const d = mapCatalogRow(row, fallbackType);
            if (d) out.push(d);
        }
        return out;
    }

    private async json(url: string | URL): Promise<Record<string, unknown>> {
        const res = await this.request(url);
        return (await res.json()) as Record<string, unknown>;
    }

    /**
     * Issue one GET through the shared {@link gate} (concurrency + spacing), retrying after a 429
     * (honoring `Retry-After`, else exponential backoff + jitter). Returns the `Response` so callers
     * can read pagination headers (`cb-after`) before consuming the body.
     */
    private async request(url: string | URL): Promise<Response> {
        for (let attempt = 0; ; attempt += 1) {
            const res = await this.gate.run(() => fetch(url));
            if (res.status === 429 && attempt < REQUEST_MAX_RETRIES) {
                const backoff = BACKOFF_BASE_MS * 2 ** attempt + Math.random() * BACKOFF_JITTER_MS;
                this.gate.pauseFor(Math.max(retryAfterMs(res, 0), backoff));
                continue;
            }
            if (!res.ok) throw new Error(`Twelve Data HTTP ${res.status} for ${String(url)}`);
            return res;
        }
    }
}

const fmt = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
